// Assemble + validate one source `character-route-arc` WikiObject.
//
// The model proposes state-shift prose and the two units that bound each shift;
// this module turns them into a strict, route-scoped object. The guarantees are
// enforced HERE, not trusted from the model:
//
//   1. The (character, route) pair is a REAL decoded intersection; a fabricated
//      pair is rejected before any arc is authored.
//   2. Every shift is bounded by units drawn from the character's decoded route-
//      occurrence window; a unit outside it is rejected.
//   3. Each shift's from/to PLAY-ORDER RANGE is stamped from the cited units'
//      decoded play order — never the model's asserted re-timing — and a reversed
//      range is rejected.
//   4. Citations are INDEX-DERIVED: hash, subject, and play order are copied from
//      the snapshot evidence index, so the model cannot forge a passing citation.

import {
  WikiObjectSchema,
  type Citation,
  type Claim,
  type WikiObject,
} from "../../contracts/index.js";
import type { ReadModel } from "../../read-tools/index.js";
import type { CharacterOccurrenceFact, OrderedUnitFact } from "../../prepass/index.js";
import { buildEvidenceIndex, type EvidenceIndex } from "../../wiki/evidence-index.js";
import { validateWikiObjectClaims } from "../../wiki/claim-validation.js";

import { presenceClaimId, routeArcObjectId, shiftClaimId } from "./ids.js";
import { pairInIntersection, routeOccurrenceWindow } from "./intersection.js";
import {
  A9RoleError,
  A9_CHARACTER_ROUTE_ARC_KIND,
  A9_ROLE_ID,
  type A9ArcDraft,
  type A9Context,
  type A9ShiftDraft,
  type CharacterRouteEvidence,
} from "./types.js";

const UNRESOLVABLE_HASH = `sha256:${"0".repeat(64)}` as `sha256:${string}`;

/** Build one citation for an evidence id. Every dimension a citation is checked
 * on — hash, subject, play order — is copied from the snapshot evidence index
 * when the id resolves; when it does NOT, the citation is left deliberately
 * unresolvable so the claim gate rejects it. */
function citationFor(
  index: EvidenceIndex,
  snapshotId: string,
  evidenceId: string,
  role: Citation["role"],
): Citation {
  const record = index.get(evidenceId);
  if (!record) {
    return {
      evidenceId,
      evidenceHash: UNRESOLVABLE_HASH,
      snapshotId: snapshotId as `sha256:${string}`,
      subject: { kind: "unit", id: evidenceId },
      role,
      playOrderIndex: 0,
    };
  }
  return {
    evidenceId: record.factId,
    evidenceHash: record.hash as `sha256:${string}`,
    snapshotId: record.snapshotId as `sha256:${string}`,
    subject: record.subject,
    role,
    playOrderIndex: record.fromPlayOrder,
  };
}

/** The module-authored route-presence claim: cites the character-occurrence fact,
 * scoped to this arc's route. Index-derived and independent of the model. */
function presenceClaim(
  index: EvidenceIndex,
  snapshotId: string,
  evidence: CharacterRouteEvidence,
): Claim {
  return {
    claimId: presenceClaimId(evidence.characterId, evidence.routeId),
    statement: `${evidence.decodedLabel} は ${evidence.routeId} ルートに登場する。`,
    scope: evidence.scope,
    kind: "arc",
    confidence: "high",
    citations: [citationFor(index, snapshotId, evidence.occurrenceFactId, "supports")],
  };
}

/** One shift, resolved: the model's prose plus the decode-stamped play-order
 * range and the bounding unit evidence ids (from, then to). */
interface ResolvedShift {
  readonly fromPlayOrder: number;
  readonly toPlayOrder: number;
  readonly stateBefore: string;
  readonly stateAfter: string;
  readonly evidenceIds: readonly string[];
}

/** Resolve one shift draft against the decoded occurrence window: both bounding
 * units must be in the window; the play-order range is stamped from their decoded
 * play order (the model's asserted re-timing is ignored); a reversed range and a
 * degenerate before/after are rejected. */
function resolveShift(
  characterId: string,
  routeId: string,
  draft: A9ShiftDraft,
  window: ReadonlyMap<string, OrderedUnitFact>,
): ResolvedShift {
  const where = `${characterId}@${routeId}`;
  if (draft.stateBefore.trim().length === 0 || draft.stateAfter.trim().length === 0) {
    throw new A9RoleError("degenerate-shift", `shift ${where} carries an empty before/after state`);
  }
  const fromUnit = window.get(draft.fromEvidenceId);
  if (!fromUnit) {
    throw new A9RoleError(
      "unknown-shift-evidence",
      `shift ${where} from-unit ${draft.fromEvidenceId} is not in the decoded route-occurrence window`,
    );
  }
  const toUnit = window.get(draft.toEvidenceId);
  if (!toUnit) {
    throw new A9RoleError(
      "unknown-shift-evidence",
      `shift ${where} to-unit ${draft.toEvidenceId} is not in the decoded route-occurrence window`,
    );
  }
  const fromPlayOrder = fromUnit.playReveal.playOrderIndex;
  const toPlayOrder = toUnit.playReveal.playOrderIndex;
  if (toPlayOrder < fromPlayOrder) {
    throw new A9RoleError(
      "reversed-shift",
      `shift ${where} ends at play order ${toPlayOrder} before it begins at ${fromPlayOrder}`,
    );
  }
  return {
    fromPlayOrder,
    toPlayOrder,
    stateBefore: draft.stateBefore,
    stateAfter: draft.stateAfter,
    evidenceIds: [fromUnit.factId, toUnit.factId],
  };
}

function shiftClaim(
  index: EvidenceIndex,
  snapshotId: string,
  evidence: CharacterRouteEvidence,
  shift: ResolvedShift,
  ordinal: number,
): Claim {
  return {
    claimId: shiftClaimId(evidence.characterId, evidence.routeId, ordinal),
    statement: `${shift.stateBefore} → ${shift.stateAfter}`,
    scope: evidence.scope,
    kind: "arc",
    confidence: "medium",
    citations: [
      citationFor(index, snapshotId, shift.evidenceIds[0]!, "supports"),
      citationFor(index, snapshotId, shift.evidenceIds[1]!, "reveal"),
    ],
  };
}

function provenance(model: ReadModel, context: A9Context) {
  return {
    snapshotKind: "context" as const,
    contextSnapshotId: model.snapshotId,
    contextScope: context.contextScope,
    runMode: context.runMode,
    authorRoleId: A9_ROLE_ID,
  };
}

function seal(candidate: unknown, model: ReadModel): WikiObject {
  const object = WikiObjectSchema.parse(candidate);
  validateWikiObjectClaims(object, model);
  return object;
}

/**
 * Assemble the source-language `character-route-arc` for one intersection pair.
 * The pair is proven a real decoded intersection; every shift is bounded by units
 * from the character's decoded route-occurrence window; every play-order range is
 * stamped from the decode; every claim cites index-resolved evidence or the
 * object fails to validate.
 */
export function assembleCharacterRouteArc(
  model: ReadModel,
  context: A9Context,
  character: CharacterOccurrenceFact,
  evidence: CharacterRouteEvidence,
  draft: A9ArcDraft,
): WikiObject {
  if (!pairInIntersection(model, character, evidence.routeId)) {
    throw new A9RoleError(
      "pair-not-in-intersection",
      `(${evidence.characterId}, ${evidence.routeId}) is not a decoded character-by-route intersection`,
    );
  }
  const windowUnits = routeOccurrenceWindow(model, evidence.sceneIds, evidence.routeId);
  if (windowUnits.length === 0) {
    throw new A9RoleError(
      "empty-shift-window",
      `(${evidence.characterId}, ${evidence.routeId}) has no route-visible occurrence unit to cite`,
    );
  }
  const window = new Map(windowUnits.map((unit) => [unit.factId, unit]));
  const resolved = draft.shifts.map((shift) =>
    resolveShift(evidence.characterId, evidence.routeId, shift, window),
  );

  const index = buildEvidenceIndex(model);
  const claims: Claim[] = [
    presenceClaim(index, model.snapshotId, evidence),
    ...resolved.map((shift, ordinal) =>
      shiftClaim(index, model.snapshotId, evidence, shift, ordinal),
    ),
  ];
  return seal(
    {
      schemaVersion: "itotori.wiki-object.v1",
      objectId: routeArcObjectId(evidence.characterId, evidence.routeId),
      version: 1,
      lang: model.sourceLanguage,
      subject: { kind: "character", id: evidence.characterId },
      scope: evidence.scope,
      claims,
      media: [],
      dependencies: [],
      provisional: false,
      kind: A9_CHARACTER_ROUTE_ARC_KIND,
      body: {
        characterId: evidence.characterId,
        routeId: evidence.routeId,
        shifts: resolved.map((shift) => ({
          fromPlayOrder: shift.fromPlayOrder,
          toPlayOrder: shift.toPlayOrder,
          stateBefore: shift.stateBefore,
          stateAfter: shift.stateAfter,
          evidenceIds: [...shift.evidenceIds],
        })),
      },
      provenance: provenance(model, context),
    },
    model,
  );
}
