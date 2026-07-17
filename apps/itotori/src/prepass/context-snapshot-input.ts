// Assemble the context-snapshot trust-root input from the deterministic fact
// materialization and the run-scoped revision references.

import { llmSha256, type LlmContextSnapshotInput, type LlmRevisionRef } from "@itotori/db";

import { contextSnapshotFactsFrom } from "./context-facts.js";
import type { FactSnapshot } from "./types.js";

export interface BuildContextSnapshotInput {
  readonly factSnapshot: FactSnapshot;
  readonly sourceLanguage: string;
  readonly decodeRef: LlmRevisionRef;
  readonly glossaryRef: LlmRevisionRef;
  readonly styleRef: LlmRevisionRef;
}

/**
 * Build the complete, content-addressed context snapshot input for one
 * whole-game run. The fact snapshot is the authority for the committed source
 * units, fact materialization, and the final reveal/play position.
 */
export function buildContextSnapshotInput(
  input: BuildContextSnapshotInput,
): LlmContextSnapshotInput {
  const { facts, factMaterialization } = contextSnapshotFactsFrom(input.factSnapshot);
  const finalPlayOrderIndex = input.factSnapshot.orderedUnits.reduce(
    (highest, unit) => Math.max(highest, unit.playReveal.playOrderIndex),
    -1,
  );
  if (finalPlayOrderIndex < 0) {
    throw new Error("context snapshot requires at least one materialized source unit");
  }

  return {
    sourceLanguage: input.sourceLanguage,
    decode: input.decodeRef,
    sourceUnits: input.factSnapshot.orderedUnits.map((unit) => ({
      unitId: unit.factId,
      sourceHash: unit.sourceHash,
    })),
    facts,
    // FLAG: sentinel ref — real provenance is a follow-up.
    structure: sentinelRef("structure"),
    // FLAG: sentinel ref — real provenance is a follow-up.
    routeGraph: sentinelRef("route-graph"),
    glossary: input.glossaryRef,
    style: input.styleRef,
    revealHorizon: { kind: "through-play-order", playOrderIndex: finalPlayOrderIndex },
    // FLAG: sentinel ref — real provenance is a follow-up.
    humanCorrections: sentinelRef("human-corrections"),
    externalSources: null,
    contextScope: "whole-game",
    factMaterialization,
  };
}

function sentinelRef(kind: "structure" | "route-graph" | "human-corrections"): LlmRevisionRef {
  return {
    revisionId: `sentinel:${kind}`,
    contentHash: llmSha256(`itotori.context-snapshot.sentinel.${kind}.v1`),
  };
}
