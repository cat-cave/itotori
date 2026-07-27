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

/** A batch with no accepted heads is not a partial-success result. Returning it
 * normally lets the driver report a completed run that produced no localized
 * output, which is operationally indistinguishable from success to callers. */
export class FinalizeBatchError extends Error {
  constructor(readonly rejected: readonly { readonly unitId: string; readonly reason: string }[]) {
    super(
      `accepted-output finalization rejected every unit: ${rejected
        .map((entry) => `${entry.unitId}: ${entry.reason}`)
        .join("; ")}`,
    );
    this.name = "FinalizeBatchError";
  }
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
  // The CAS key is per unit, so these writes have no coherence dependency.
  // Let them overlap while retaining each independent result.
  const settled = await Promise.all(
    units.map(async (unit) => {
      try {
        return { unit, finalized: await finalizeUnit(store, policy, unit) } as const;
      } catch (error: unknown) {
        return { unit, error } as const;
      }
    }),
  );
  const finalized: FinalizedUnit[] = [];
  const rejected: { unitId: string; reason: string }[] = [];
  settled.forEach((result) => {
    if ("finalized" in result) {
      finalized.push(result.finalized);
      return;
    }
    rejected.push({
      unitId: result.unit.unitId,
      reason: result.error instanceof Error ? result.error.message : String(result.error),
    });
  });
  if (units.length > 0 && finalized.length === 0) {
    throw new FinalizeBatchError(rejected);
  }
  return { finalized, rejected };
}
