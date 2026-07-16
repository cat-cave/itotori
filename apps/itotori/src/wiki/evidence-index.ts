// The evidence index — the resolvable, same-snapshot evidence a claim may cite.
//
// A factual claim is only PROVABLE if each of its citations resolves against the
// immutable snapshot: the cited evidence must exist, its content hash must match
// what the read tools would return, and its subject / route scope / play order
// must be the snapshot's. This module projects every citeable fact through the
// SAME projection the read tools use (so a hash an agent copied from a tool
// result resolves here byte-for-byte) and records, per fact id, the exact
// subject, route scope, and play order a citation is checked against. Nothing is
// inferred: a fact absent from this index is an unresolvable citation, a
// validation FAILURE, never a silently accepted claim.

import type { EntityRef, RouteScope } from "../contracts/index.js";
import type { ReadModel } from "../read-tools/model.js";
import {
  projectCharacterOccurrenceFact,
  projectRouteNodeFact,
  projectUnitFact,
  sealGlossaryValue,
} from "../read-tools/projection.js";

/** One resolvable piece of evidence, addressed by its stable fact id. */
export interface EvidenceRecord {
  factId: string;
  /** Content hash of the projected fact value — must equal a citation's hash. */
  hash: string;
  /** The snapshot this evidence belongs to (the citation's `snapshotId`). */
  snapshotId: string;
  /** The subject the fact is about — a citation's `subject` must equal this. */
  subject: EntityRef;
  /** The route scope the evidence lives under (for out-of-route checks). */
  routeScope: RouteScope;
  /** The play-order position the evidence first becomes visible at. */
  fromPlayOrder: number;
}

export type EvidenceIndex = ReadonlyMap<string, EvidenceRecord>;

type CiteableValue =
  | { kind: "unit"; unitId: string }
  | { kind: "route-node"; sceneId: string }
  | { kind: "character-occurrence"; characterId: string }
  | { kind: "glossary-entry"; termId: string };

/** The subject an evidence value is about. Structural, so a citation cannot
 * claim a unit's evidence proves a statement about some other character. */
function subjectOf(value: CiteableValue): EntityRef {
  switch (value.kind) {
    case "unit":
      return { kind: "unit", id: value.unitId };
    case "route-node":
      return { kind: "scene", id: value.sceneId };
    case "character-occurrence":
      return { kind: "character", id: value.characterId };
    case "glossary-entry":
      return { kind: "glossary-term", id: value.termId };
  }
}

/** Build the resolvable evidence index for a snapshot's read model. Units,
 * scenes, characters (with a bound profile), and glossary entries are the
 * citeable facts; each is projected exactly as its read tool would emit it, so
 * hashes match. Facts are indexed regardless of the reveal horizon — a beyond-
 * horizon citation must FAIL as beyond-play-order, not vanish as unresolvable. */
export function buildEvidenceIndex(model: ReadModel): EvidenceIndex {
  const index = new Map<string, EvidenceRecord>();
  const record = (
    factId: string,
    hash: string,
    subject: EntityRef,
    routeScope: RouteScope,
    fromPlayOrder: number,
  ): void => {
    index.set(factId, {
      factId,
      hash,
      snapshotId: model.snapshotId,
      subject,
      routeScope,
      fromPlayOrder,
    });
  };

  for (const unit of model.factSnapshot.orderedUnits) {
    const bundleUnit = model.bundleUnits.get(unit.bridgeUnitId)!;
    const fact = projectUnitFact(unit, bundleUnit, model.snapshotId);
    record(
      fact.factId,
      fact.hash,
      subjectOf({ kind: "unit", unitId: fact.value.unitId }),
      fact.value.routeScopes[0]!,
      fact.visibility.fromPlayOrder,
    );
  }

  for (const scene of model.factSnapshot.scenes) {
    const fact = projectRouteNodeFact(scene, model.factSnapshot.routeTopology, model.snapshotId);
    record(
      fact.factId,
      fact.hash,
      subjectOf({ kind: "route-node", sceneId: fact.value.sceneId }),
      fact.visibility.routeScope,
      fact.visibility.fromPlayOrder,
    );
  }

  for (const [characterId, profile] of model.characterProfiles) {
    const character = model.factSnapshot.characters.find(
      (candidate) => candidate.characterId === characterId,
    );
    if (!character) continue;
    const fact = projectCharacterOccurrenceFact(character, profile, model.snapshotId);
    record(
      fact.factId,
      fact.hash,
      subjectOf({ kind: "character-occurrence", characterId: fact.value.characterId }),
      fact.visibility.routeScope,
      fact.visibility.fromPlayOrder,
    );
  }

  if (model.localization) {
    for (const entry of model.localization.glossaryEntries) {
      record(
        `glossary:${entry.termId}`,
        sealGlossaryValue(entry),
        subjectOf({ kind: "glossary-entry", termId: entry.termId }),
        entry.scope,
        0,
      );
    }
  }

  return index;
}
