// The ablation entry gate — composed over the run-policy boundary, never forked.
//
// The pure-MTL posture is ALREADY a run-policy selector: `resolveRunPolicy`
// yields the null-Wiki / direct-translation basis ONLY under the explicit
// `{ kind: "pure-mtl" }` ablation selector, and ONLY under a test-dev run. This
// module PINS that selector onto the request and re-derives that the composed
// policy actually landed on the `pure-mtl-ablation` basis — so the ablation
// driver can never run on a wiki-first policy, and a caller can never smuggle a
// shippable run through the ablation entrypoint. It re-implements no legality
// rule; every rejection ultimately comes from `resolveRunPolicy`.

import { resolveRunPolicy, type ResolvedRunPolicy } from "../run-policy/index.js";
import { AblationPolicyError, type AblationRunRequest, type LineageClass } from "./types.js";

/** The one sanctioned ablation selector — pinned onto every ablation request so
 * the null-Wiki basis is reached through the SAME run-policy boundary the real
 * pipeline uses, not a parallel switch. */
const PURE_MTL_ABLATION = { kind: "pure-mtl" } as const;

/** The lineage class a resolved policy's telemetry belongs to — DERIVED from the
 * bible basis, never a hand-set flag. A null-Wiki (`pure-mtl-ablation`) basis is
 * `ablation`; every wiki-first basis is `qualifying`. This is the single source
 * of the isolation tag the metrics guard keys on. */
export function lineageClassOf(policy: ResolvedRunPolicy): LineageClass {
  return policy.bibleBasis === "pure-mtl-ablation" ? "ablation" : "qualifying";
}

/**
 * Resolve an ablation request into its legal run policy, or refuse it. It pins
 * the `pure-mtl` selector and delegates every legality decision to
 * `resolveRunPolicy` (which forces test-dev, forbids shipping, and derives the
 * null-Wiki basis). It then re-derives that the composed policy is genuinely the
 * ablation basis — a defensive check that this entrypoint is the ONLY way it is
 * used, and that a future run-policy change can never silently route a wiki-first
 * policy through here. A caller-supplied ablation field is impossible: the
 * request type omits it, so the selector is always exactly the sanctioned one.
 */
export function resolveAblationPolicy(request: AblationRunRequest): ResolvedRunPolicy {
  const policy = resolveRunPolicy({ ...request, ablation: PURE_MTL_ABLATION });
  // Re-derive the two invariants that make this a genuine ablation: the null-Wiki
  // basis and non-shippability. Both already follow from `resolveRunPolicy`; we
  // assert them so the ablation driver has a proven, not assumed, precondition.
  if (policy.bibleBasis !== "pure-mtl-ablation") {
    throw new AblationPolicyError(
      `ablation policy did not resolve to the null-Wiki basis (got '${policy.bibleBasis}')`,
    );
  }
  if (policy.shippable) {
    throw new AblationPolicyError(
      "ablation policy resolved as shippable — a non-shippable control arm must never ship",
    );
  }
  return policy;
}
