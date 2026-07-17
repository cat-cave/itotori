// Precise enhancement + rerun-only-implicated — the offline-provable core.
//
// A route/play-scoped ONE-FIELD change to a Wiki/bible object (or a translation
// edit), batched behind an intentional apply action, returns immediately. This
// module plans what that change reaches by COMPOSING the real substrate — it
// never re-implements a kernel:
//   - the scoped-invalidation impact set (field/claim-scoped intersection of a
//     structured diff with the recorded consumption edges) finds ONLY the
//     consumers that CITED the changed field — the precise enhancement set;
//   - the same partition the bible reflow uses (reflow set vs preserved set)
//     keeps every UNRELATED consumer byte/hash-identical;
//   - the workflow rerun scope restricts the post-enhancement review/repair
//     re-run to ONLY the lanes the enhanced units' defects implicate.
//
// The whole plan is a pure, content-addressed function of (the two object
// bodies, the recorded bindings, the defect bundle): no model, no I/O, no
// clock. It is the offline-provable core; the live lane proves the same
// scoping over REAL patch bytes (see ./patch-scope.js).

import type { DefectBundle } from "../../contracts/index.js";
import type { ImpactSet } from "../../wiki/scoped-invalidation/impact-set.js";
import type { JsonValue } from "../../wiki/human-enhancement/field-path.js";
import { implicatedRerun, type RerunScope } from "../../workflow/rerun-scope.js";
import { bindingsToEdges, planBibleReflow, reflowPlanFor } from "../ground-truth/reflow.js";
import type { UnitBibleBinding } from "../ground-truth/types.js";

/** The offline-provable plan for one batched enhancement: the precise impact
 * set (who cited the changed field), the enhanced vs preserved unit partition,
 * and the rerun scope (which lanes/units the change re-opens). */
export interface EnhancementImpact {
  /** The content-addressed impact set the plan is derived from — identical
   * inputs hash identically, so the plan is reproducible. */
  readonly impactSet: ImpactSet;
  /** Units whose recorded consumption cited the changed field — the ONLY units
   * an enhancement may touch. */
  readonly enhancedUnitIds: readonly string[];
  /** Units that did not cite the changed field — provably untouched. */
  readonly preservedUnitIds: readonly string[];
  /** The post-enhancement rerun: ONLY the lanes the enhanced units' defects
   * implicate, over ONLY those units. Empty when nothing was implicated. */
  readonly rerun: RerunScope;
}

/**
 * Plan one batched enhancement. The change is the structured diff of `prior` ->
 * `next` on ONE upstream object; the bindings record each unit's consumption
 * (so the impact set finds the citing consumers); the bundle carries the
 * defects whose implicated lanes a post-enhancement rerun re-opens. Pure in all
 * three inputs: the same bodies + bindings + bundle always plan identically.
 */
export function planEnhancementImpact(input: {
  readonly prior: JsonValue;
  readonly next: JsonValue;
  readonly bindings: readonly UnitBibleBinding[];
  readonly bundle: DefectBundle;
}): EnhancementImpact {
  const edges = bindingsToEdges(input.bindings);
  const impactSet = planBibleReflow({ prior: input.prior, next: input.next, edges });
  const partition = reflowPlanFor(impactSet, input.bindings);
  const rerun = implicatedRerun(input.bundle, partition.reflowUnitIds);
  return {
    impactSet,
    enhancedUnitIds: partition.reflowUnitIds,
    preservedUnitIds: partition.preservedUnitIds,
    rerun,
  };
}

/** One artifact whose content hash is the hash-identity proof. A precise
 * enhancement re-emits the enhanced artifacts and copies every preserved
 * artifact BYTE-IDENTICAL (the same object reference). Generalized from the
 * bible reflow's {@link UnitLineOutput} so the proof covers objects, memos,
 * units, and routes alike. */
export interface HashIdenticalTarget {
  readonly key: string;
  readonly contentHash: string;
}

/**
 * Apply a precise enhancement: re-emit the enhanced artifacts (via `enhance`)
 * and return every preserved artifact UNCHANGED — the same object reference, so
 * an unrelated object / memo / unit / route is provably byte-identical. Mirrors
 * the bible reflow's output partition over the general hash-identity target;
 * remove the scoping and a preserved artifact would change, which is what the
 * proof falsifies.
 */
export function applyPreciseEnhancement(
  prior: readonly HashIdenticalTarget[],
  enhancedKeys: readonly string[],
  enhance: (key: string) => string,
): readonly HashIdenticalTarget[] {
  const enhanced = new Set(enhancedKeys);
  return prior.map((target) =>
    enhanced.has(target.key) ? { key: target.key, contentHash: enhance(target.key) } : target,
  );
}
