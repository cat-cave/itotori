// The Terminology Analyst's model boundary — dispatch only through the certified
// ZDR route, in every run mode.
//
// The shared dispatcher temporarily permits a relaxed route check in test-dev.
// A2 closes that escape hatch before calling its injected port: its model
// profile, profile version, requested model, and account-wide ZDR/fallback
// policy must exactly match the RB-019 role binding. This module names no
// provider and owns no retry policy.

import { CallSpecSchema, type CallResult, type CallSpec } from "../../contracts/index.js";
import { canonicalJson } from "../../llm/canonical-json.js";
import { dispatch, type DispatchRuntime } from "../../llm/dispatch.js";
import { resolveRoleModelProfile } from "../../llm/role-model-profiles.js";

/** A loud refusal before a non-certified A2 call can reach a model port. */
export class TermAnalystRouteError extends Error {
  constructor(detail: string) {
    super(`terminology route not certified: ${detail}`);
    this.name = "TermAnalystRouteError";
  }
}

/** Assert A2's full RB-019 route in every run mode, including test-dev. */
export function assertTermAnalystCertifiedRoute(specInput: CallSpec): void {
  const spec = CallSpecSchema.parse(specInput);
  const certified = resolveRoleModelProfile(spec.roleId);
  const selected = {
    modelProfile: spec.modelProfile,
    modelProfileVersion: spec.modelProfileVersion,
    requestedModel: spec.requestedModel,
    providerPolicy: spec.providerPolicy,
  };
  const expected = {
    modelProfile: certified.modelProfile,
    modelProfileVersion: certified.version,
    requestedModel: certified.model,
    providerPolicy: certified.providerPolicy,
  };
  if (canonicalJson(selected) !== canonicalJson(expected)) {
    throw new TermAnalystRouteError(
      `call route for ${spec.roleId} does not match the certified model profile`,
    );
  }
}

/** The model seam. The real implementation is the sole shared dispatcher; the
 * offline path is a recorded result that still goes through every semantic gate. */
export type TermAnalystModelPort = (spec: CallSpec) => Promise<CallResult>;

/** Check the certified account-wide-ZDR route, then invoke the model seam. */
export async function dispatchTermAnalyst(
  spec: CallSpec,
  port: TermAnalystModelPort,
): Promise<CallResult> {
  assertTermAnalystCertifiedRoute(spec);
  return port(spec);
}

/** Production binding: one shared ZDR dispatcher, with no provider pin. */
export function dispatchingTermAnalystModel(
  runtime: DispatchRuntime,
  dispatcher: typeof dispatch = dispatch,
): TermAnalystModelPort {
  return (spec) => dispatcher(spec, runtime);
}

/** Offline / recorded binding. The result is still parsed, citation-resolved,
 * enumeration-checked, and claim-validated by the caller. */
export function recordedTermAnalystModel(result: CallResult): TermAnalystModelPort {
  return async () => result;
}
