// The Cultural Adaptation Analyst's model boundary — dispatch deepseek-v4-flash
// through the SOLE ZDR dispatch boundary, route-bound in EVERY run mode.
//
// A6 is a model-calling role. This module owns the public dispatch entry: it
// asserts the call's route IS the role's certified deepseek-v4-flash profile —
// the exact model, the exact ZDR + automatic-fallback policy, the profile version
// — BEFORE the call reaches the wire, in every run mode INCLUDING test-dev. The
// shared dispatch boundary waives its certified-route check under test-dev; a
// role that trusted that alone could dispatch a forged, non-certified model
// whenever it ran in a test mode. This entry closes that gap: a spec whose model
// does not match the certified profile is rejected here, in every mode, before a
// single byte is sent. It names no provider — the certified profile carries the
// routing policy — and owns no retries.

import { canonicalJson } from "../../llm/canonical-json.js";
import { resolveRoleModelProfile } from "../../llm/role-model-profiles.js";
import { dispatch, type DispatchRuntime } from "../../llm/dispatch.js";
import { CallSpecSchema, type CallResult, type CallSpec } from "../../contracts/index.js";

/** A loud, typed refusal: a call whose route is not the role's certified
 * deepseek-v4-flash profile is rejected before it can reach a provider. */
export class AdaptationRouteError extends Error {
  constructor(detail: string) {
    super(`adaptation route not certified: ${detail}`);
    this.name = "AdaptationRouteError";
  }
}

/**
 * Assert a call's route is the role's certified deepseek-v4-flash profile — in
 * EVERY run mode. Unlike the shared boundary, this does NOT waive the check under
 * test-dev: a forged, non-certified model is refused here whether the run is
 * production, pilot, or test-dev. The certified subject is resolved from the
 * fail-closed certificate store, so a call can only pass by naming the exact
 * model, provider policy, and profile version the certificate covers.
 */
export function assertCertifiedRouteEveryMode(specInput: CallSpec): void {
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
    throw new AdaptationRouteError(
      `call route for ${spec.roleId} does not match the certified model profile`,
    );
  }
}

/** The model seam: it takes the strict CallSpec and returns the dispatch result.
 * Production binds the real dispatcher; the offline proof binds a recorded
 * result. The port is the ONLY place a model is reached. */
export type AdaptationModelPort = (spec: CallSpec) => Promise<CallResult>;

/**
 * The public dispatch entry. It asserts the certified route in EVERY mode and
 * ONLY THEN hands the spec to the model port — so a forged model is rejected
 * before the port (and thus the wire) is ever touched, even under test-dev.
 */
export async function dispatchAdaptationAnalyst(
  spec: CallSpec,
  port: AdaptationModelPort,
): Promise<CallResult> {
  assertCertifiedRouteEveryMode(spec);
  return port(spec);
}

/** Production binding: route the CallSpec through the real dispatcher. No
 * provider is chosen here — the spec's certified profile does the routing, and
 * the entry above already proved the route certified. */
export function dispatchingAdaptationModel(
  runtime: DispatchRuntime,
  dispatcher: typeof dispatch = dispatch,
): AdaptationModelPort {
  return (spec) => dispatcher(spec, runtime);
}

/** Offline / recorded binding: replay a captured success result. The recorded
 * value is still validated downstream — the memo cannot smuggle a different
 * terminal kind, a wrong served model, or an unprovable claim past the analyst. */
export function recordedAdaptationModel(result: CallResult): AdaptationModelPort {
  return async () => result;
}

/** Offline / recorded binding keyed per flagged unit: replay the captured result
 * whose transcript anchor matches the dispatched spec. A spec for a unit the map
 * does not cover is a hard failure — the offline path cannot invent a note. */
export function recordedAdaptationModelByAnchor(
  byAnchor: ReadonlyMap<string, CallResult>,
): AdaptationModelPort {
  return async (spec) => {
    const result = byAnchor.get(spec.parentEventId);
    if (!result) {
      throw new AdaptationRouteError(`no recorded result for anchor ${spec.parentEventId}`);
    }
    return result;
  };
}
