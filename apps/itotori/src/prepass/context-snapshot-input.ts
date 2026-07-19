// Assemble the context-snapshot trust-root input from the deterministic fact
// materialization and the run-scoped revision references.

import {
  llmSha256,
  type LlmContextSnapshotInput,
  type LlmJsonValue,
  type LlmRevisionRef,
} from "@itotori/db";

import { contextSnapshotFactsFrom } from "./context-facts.js";
import type { FactSnapshot } from "./types.js";

export interface BuildContextSnapshotInput {
  readonly factSnapshot: FactSnapshot;
  readonly sourceLanguage: string;
  /** Immutable revision of the decoded structure that was materialized. */
  readonly decodeRef: LlmRevisionRef;
  readonly glossaryRef: LlmRevisionRef;
  readonly styleRef: LlmRevisionRef;
  /**
   * Optional immutable human-correction state. Omitting it is an explicit,
   * content-addressed empty correction set rather than a placeholder ref.
   */
  readonly humanCorrectionsRef?: LlmRevisionRef;
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
    // The decode revision is the immutable source structure that was joined
    // into this fact snapshot; topology is independently content-addressed.
    structure: input.decodeRef,
    routeGraph: routeGraphRef(input.factSnapshot),
    glossary: input.glossaryRef,
    style: input.styleRef,
    revealHorizon: { kind: "through-play-order", playOrderIndex: finalPlayOrderIndex },
    humanCorrections: input.humanCorrectionsRef ?? noHumanCorrectionsRef(),
    externalSources: null,
    contextScope: "whole-game",
    factMaterialization,
  };
}

/** Content-address the exact materialized topology, independently of other facts. */
function routeGraphRef(snapshot: FactSnapshot): LlmRevisionRef {
  const contentHash = llmSha256(snapshot.routeTopology as unknown as LlmJsonValue);
  return { revisionId: contentHash.slice("sha256:".length), contentHash };
}

/** The actual immutable state when this build has received no human corrections. */
function noHumanCorrectionsRef(): LlmRevisionRef {
  const contentHash = llmSha256({
    schemaVersion: "itotori.human-corrections.v1",
    corrections: [],
  });
  return { revisionId: contentHash.slice("sha256:".length), contentHash };
}
