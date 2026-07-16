// Independent per-unit CAS finalize.
//
// Each unit finalizes INDEPENDENTLY into the content-addressed store: the store
// advances only that unit's `final` head, so one unit's finalize neither blocks
// nor couples another's. A finalize is gated through the run policy — a shippable
// run mints a proven shippable head, every other run a quarantined artifact-only
// head — so a non-shippable run structurally cannot ship a unit.

import type { ResolvedRunPolicy } from "../run-policy/index.js";
import { releaseUnit } from "./policy.js";
import type { FinalizedUnit, WorkflowArtifactStore } from "./ports.js";

/** Finalize ONE unit's `final` head, gated through the run policy. Advances only
 * this unit's head; the returned release proves whether it may ship. */
export async function finalizeUnit(
  store: WorkflowArtifactStore,
  policy: ResolvedRunPolicy,
  input: { readonly unitId: string; readonly contentHash: `sha256:${string}` },
): Promise<FinalizedUnit> {
  const release = releaseUnit(policy, {
    unitId: input.unitId,
    stage: "final",
    contentHash: input.contentHash,
    version: 0,
  });
  const ref = await store.finalizeUnit({
    unitId: input.unitId,
    stage: "final",
    contentHash: input.contentHash,
    shippable: release.shippable,
  });
  return { unitId: input.unitId, ref, shippable: release.shippable };
}

/** The outcome of finalizing a batch of units — the units that finalized and,
 * separately, any that a CAS conflict rejected. A rejection on one unit never
 * prevents the others from finalizing (per-unit independence). */
export interface FinalizeBatchResult {
  readonly finalized: readonly FinalizedUnit[];
  readonly rejected: readonly { readonly unitId: string; readonly reason: string }[];
}

/**
 * Finalize a set of units independently. Each unit is finalized on its own head;
 * a failure on one is captured and reported without aborting the rest, so one
 * unit's finalize does not couple another's.
 */
export async function finalizeUnits(
  store: WorkflowArtifactStore,
  policy: ResolvedRunPolicy,
  units: readonly { readonly unitId: string; readonly contentHash: `sha256:${string}` }[],
): Promise<FinalizeBatchResult> {
  const finalized: FinalizedUnit[] = [];
  const rejected: { unitId: string; reason: string }[] = [];
  for (const unit of units) {
    try {
      finalized.push(await finalizeUnit(store, policy, unit));
    } catch (error: unknown) {
      rejected.push({
        unitId: unit.unitId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { finalized, rejected };
}
