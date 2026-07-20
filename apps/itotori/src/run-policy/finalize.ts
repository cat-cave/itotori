// The shippable-finalization gate — UNBYPASSABLE. A shippable artifact can be
// produced only through `finalizeShippable`, and that function re-derives the
// shippability invariant from the policy's own axes rather than trusting the
// `shippable` flag. So even a hand-forged `ResolvedRunPolicy` that sets
// `shippable: true` on a narrowed / test-dev / null-Wiki run is refused here:
// there is no parameter, flag, or alternate constructor that reaches a shippable
// artifact from a run that may not ship.

import { contextCoversWholeGame } from "./resolve.js";
import { profileFor, rosterIsFull } from "./mode-profiles.js";
import {
  ShippableFinalizationError,
  type ResolvedRunPolicy,
  type ShippableArtifact,
} from "./types.js";

/** Independently re-derive whether a resolved policy may ship — from its run
 * mode, context scope, and bible basis — WITHOUT trusting `policy.shippable`.
 * The finalization gate uses this so a forged flag cannot open the gate. */
export function isShippablePolicy(policy: ResolvedRunPolicy): boolean {
  const profile = profileFor(policy.runMode);
  return (
    profile.canFinalizeShippable &&
    (!profile.requiresWholeGameContext || contextCoversWholeGame(policy.contextScope)) &&
    (!profile.requiresFullRoster || rosterIsFull(policy.roster)) &&
    policy.bibleBasis === "wiki-first"
  );
}

/** The reason a policy may not ship, or `null` if it may. Used to build a precise
 * error and to make the rejection cause visible. */
function unshippableReason(policy: ResolvedRunPolicy): string | null {
  const profile = profileFor(policy.runMode);
  if (!profile.canFinalizeShippable) {
    return `run mode '${policy.runMode}' is not a shippable mode`;
  }
  if (profile.requiresWholeGameContext && !contextCoversWholeGame(policy.contextScope)) {
    return `context '${policy.contextScope}' is narrowed — below whole-game`;
  }
  if (profile.requiresFullRoster && !rosterIsFull(policy.roster)) {
    return "the context roster is not the complete A1-A10 analyst set";
  }
  if (policy.bibleBasis !== "wiki-first") {
    return `bible basis '${policy.bibleBasis}' bypasses the wiki-first bible`;
  }
  return null;
}

/**
 * Assert a resolved policy may finalize a shippable artifact, throwing a
 * `ShippableFinalizationError` if not. The check is on the re-derived invariant,
 * not the stored flag — so it holds even against a forged policy object.
 */
export function assertMayFinalizeShippable(policy: ResolvedRunPolicy): void {
  const reason = unshippableReason(policy);
  if (reason !== null) {
    throw new ShippableFinalizationError(policy.runMode, reason);
  }
}

/**
 * Finalize a shippable artifact under a resolved policy. This is the ONLY
 * constructor of a `ShippableArtifact`; it passes through the finalization gate
 * first, so holding a `ShippableArtifact` is proof the producing run was
 * permitted to ship. A test-dev / narrowed / null-Wiki run can never reach it.
 */
export function finalizeShippable<T>(policy: ResolvedRunPolicy, artifact: T): ShippableArtifact<T> {
  assertMayFinalizeShippable(policy);
  return {
    shippable: true,
    runMode: policy.runMode,
    outputScope: policy.outputScope,
    artifact,
  };
}
