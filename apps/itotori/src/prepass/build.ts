// deterministic pre-pass: build the immutable fact snapshot.
//
// A pure, synchronous function of (decode structure, Bridge v0.2 bundle) — no
// LLM, no agents, no network, no clock. The narrative<->localization join is the
// validation gate (it fails loud on any hash/byte-range/dangling/duplicate/
// incomplete drift); everything downstream only CITES facts the join already
// proved consistent. The result is content-addressed: `snapshotId` is the
// SHA-256 of the canonical materialized body, so two builds over identical
// bytes are byte-identical and any changed decode/bridge input yields a new id.

import { canonicalLlmJson, llmSha256, type LlmJsonValue } from "@itotori/db";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";

import { joinNarrativeToLocalization } from "../structure/localization-join.js";
import type { NarrativeStructure } from "../structure/types.js";

import { indexNarrativePositions } from "./positions.js";
import { materializeCharacterOccurrences, materializeSceneCards } from "./scenes.js";
import {
  materializeChoiceLabels,
  materializeGlossaryConflicts,
  materializeTerminology,
} from "./terminology.js";
import { materializeRouteTopology } from "./topology.js";
import { materializeOrderedUnits } from "./units.js";
import { FACT_SNAPSHOT_SCHEMA_VERSION, type FactSnapshot } from "./types.js";

/** Everything in a fact snapshot except its own content hash / id. */
type FactSnapshotBody = Omit<FactSnapshot, "contentHash" | "snapshotId">;

/**
 * Deterministically materialize the immutable fact snapshot from a decode +
 * bridge. Throws (never returns partial) whenever the join rejects the inputs
 * as inconsistent. Dispatches ZERO model calls: this is pure computation.
 */
export function buildFactSnapshot(
  structure: NarrativeStructure,
  bundle: BridgeBundleV02,
): FactSnapshot {
  // 1) Validation gate — proves narrative<->unit is 1:1, complete, and that
  //    every binding agrees on source hash + byte range (throws otherwise).
  const join = joinNarrativeToLocalization(structure, bundle);

  // 2) Stable play/reveal ordering + route membership from the decode.
  const positions = indexNarrativePositions(structure);

  // 3) Cite/compute each fact family (each returns a stably ordered array).
  const routeTopology = materializeRouteTopology(structure, positions);
  const orderedUnits = materializeOrderedUnits(join.bindings, positions);
  const scenes = materializeSceneCards(structure, orderedUnits, routeTopology.reachableSceneIds);
  const characters = materializeCharacterOccurrences(structure);
  const terminology = materializeTerminology(bundle);
  const choiceLabels = materializeChoiceLabels(bundle);
  const glossaryConflicts = materializeGlossaryConflicts(bundle);

  const body: FactSnapshotBody = {
    schemaVersion: FACT_SNAPSHOT_SCHEMA_VERSION,
    source: {
      bridgeId: bundle.bridgeId,
      sourceBundleHash: bundle.sourceBundleHash,
      entryScene: structure.entryScene,
      structureSchemaVersion: structure.schemaVersion,
    },
    orderedUnits,
    scenes,
    routeTopology,
    characters,
    terminology,
    choiceLabels,
    glossaryConflicts,
  };

  // 4) Content-address the whole body (canonical JSON => stable bytes).
  const contentHash = llmSha256(body as unknown as LlmJsonValue);
  return { ...body, contentHash, snapshotId: contentHash };
}

/**
 * The canonical serialized bytes of a fact snapshot — the exact string whose
 * SHA-256 is `snapshotId`. Exposed so a byte-identity proof can compare bytes,
 * not just ids.
 */
export function serializeFactSnapshot(snapshot: FactSnapshot): string {
  return canonicalLlmJson(snapshot as unknown as LlmJsonValue);
}
