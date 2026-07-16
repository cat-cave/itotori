// The top-of-run policy gate — composed, never re-implemented.
//
// Every run resolves its policy FIRST (the deterministic legality boundary), and
// the shippable finalization is gated through the same re-derived invariant. A
// non-shippable run (test-dev / narrowed / null-Wiki ablation) can never mint a
// shippable artifact: this module routes each finalized unit through the run
// policy's own unbypassable gate rather than trusting a flag.

import {
  finalizeShippable,
  isShippablePolicy,
  resolveRunPolicy,
  type ResolvedRunPolicy,
  type RunPolicyRequest,
} from "../run-policy/index.js";
import type { UnitArtifactRef } from "./ports.js";

/** Resolve the raw run request into a legal, self-consistent policy — the single
 * gate every run passes before any unit is touched. Delegates to the run-policy
 * boundary; an illegal combination throws a `RunPolicyError` there. */
export function resolveWorkflowPolicy(request: RunPolicyRequest): ResolvedRunPolicy {
  return resolveRunPolicy(request);
}

/** The release disposition a finalized unit takes under the resolved policy. A
 * shippable policy mints a proven shippable head; every other run is quarantined
 * to an artifact-only head, with the reason surfaced. */
export type UnitRelease =
  | { readonly shippable: true; readonly ref: UnitArtifactRef }
  | { readonly shippable: false; readonly ref: UnitArtifactRef; readonly reason: string };

/** Whether the resolved policy may finalize a shippable artifact — re-derived
 * from its own axes, not read off a flag. */
export function mayShip(policy: ResolvedRunPolicy): boolean {
  return isShippablePolicy(policy);
}

/**
 * Gate a finalized unit head through the run policy. For a shippable policy the
 * head passes through `finalizeShippable`, so holding the `shippable:true` result
 * is proof the run was permitted to ship. For any non-shippable run the unit is
 * released artifact-only with the policy's reason — the driver structurally
 * cannot ship from a test-dev / narrowed / ablation run.
 */
export function releaseUnit(policy: ResolvedRunPolicy, ref: UnitArtifactRef): UnitRelease {
  if (mayShip(policy)) {
    // Passing through the run-policy gate re-derives the invariant and throws if
    // the run may not ship — a forged policy cannot open it.
    const artifact = finalizeShippable(policy, ref).artifact;
    return { shippable: true, ref: artifact };
  }
  return {
    shippable: false,
    ref,
    reason: policy.contextProvenance.narrowed
      ? "narrowed context — quarantined to artifact-only"
      : policy.bibleBasis !== "wiki-first"
        ? "null-Wiki ablation basis — artifact-only"
        : `run mode '${policy.runMode}' does not ship — artifact-only`,
  };
}
