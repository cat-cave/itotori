// The localization target policy registry.
//
// Engines/adapters appear in the deterministic gate path ONLY as policies
// registered here — there is no `if engine === …` anywhere in the shared gates.
// A policy is resolved either by its content-addressed `policyId` or by the
// `adapterId` of the extract/patch adapter that produced a bridge. An unknown id
// FAILS LOUD: a future adapter must register its policy, never silently fall
// through to another engine's rules.

import type { LocalizationTargetPolicy, LocalizationTargetPolicyId } from "./types.js";

/** Thrown when a policy id / adapter id is not registered, or a duplicate
 * registration is attempted. */
export class LocalizationTargetPolicyError extends Error {
  constructor(detail: string) {
    super(`localization target policy: ${detail}`);
    this.name = "LocalizationTargetPolicyError";
  }
}

const BY_POLICY_ID = new Map<string, LocalizationTargetPolicy>();
const BY_ADAPTER_ID = new Map<string, LocalizationTargetPolicy>();

/** Register a policy under its `policyId` and `adapterId`. Both must be unique;
 * a collision is a wiring bug and throws. */
export function registerLocalizationTargetPolicy(policy: LocalizationTargetPolicy): void {
  if (BY_POLICY_ID.has(policy.policyId)) {
    throw new LocalizationTargetPolicyError(`duplicate policy id ${policy.policyId}`);
  }
  if (BY_ADAPTER_ID.has(policy.adapterId)) {
    throw new LocalizationTargetPolicyError(`duplicate adapter id ${policy.adapterId}`);
  }
  BY_POLICY_ID.set(policy.policyId, policy);
  BY_ADAPTER_ID.set(policy.adapterId, policy);
}

/** Resolve a policy by its content-addressed id. Throws if unregistered. */
export function resolveLocalizationTargetPolicy(
  policyId: LocalizationTargetPolicyId | string,
): LocalizationTargetPolicy {
  const policy = BY_POLICY_ID.get(policyId);
  if (policy === undefined) {
    throw new LocalizationTargetPolicyError(`no policy registered for id ${policyId}`);
  }
  return policy;
}

/** Resolve the policy for the extract/patch adapter that produced a bridge
 * (its `extractor.name`). Throws if no policy is registered for that adapter. */
export function resolveTargetPolicyForAdapter(adapterId: string): LocalizationTargetPolicy {
  const policy = BY_ADAPTER_ID.get(adapterId);
  if (policy === undefined) {
    throw new LocalizationTargetPolicyError(
      `no policy registered for adapter ${adapterId}; register the adapter's target policy`,
    );
  }
  return policy;
}

/** Every registered policy, in registration order. */
export function listLocalizationTargetPolicies(): readonly LocalizationTargetPolicy[] {
  return [...BY_POLICY_ID.values()];
}
