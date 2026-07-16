// The production {@link EnhancementRunner}: it launches the one bounded child
// enhancement through RB-012's `dispatch` on the deepseek-v4-flash profile with
// NO provider pin. Building the exact call (encrypted prior-object + human
// delta payload, terminal WikiObject schema, role binding) is the caller's
// planner seam — that plumbing belongs to the line-editor role node that
// consumes RB-033. This adapter enforces the "bounded" contract (tool-free,
// deepseek-v4-flash) and maps a verified terminal into a proposal.

import { deepSeekV4FlashProfile } from "../../llm/role-model-profiles.js";
import { dispatch as defaultDispatch, type DispatchRuntime } from "../../llm/dispatch.js";
import type { CallResult, CallSpec } from "../../contracts/index.js";
import type { EnhancementProposal, EnhancementRequest, EnhancementRunner } from "./enhancement.js";
import type { JsonValue } from "./field-path.js";

export interface DispatchEnhancementPlan {
  readonly spec: CallSpec;
  readonly runtime: DispatchRuntime;
}

export type EnhancementCallPlanner = (
  request: EnhancementRequest,
) => Promise<DispatchEnhancementPlan> | DispatchEnhancementPlan;

export interface DispatchEnhancementRunnerDeps {
  readonly plan: EnhancementCallPlanner;
  /** Override the RB-012 primitive (recorded/memo path for offline proof). */
  readonly dispatch?: (spec: CallSpec, runtime: DispatchRuntime) => Promise<CallResult>;
}

export function createDispatchEnhancementRunner(
  deps: DispatchEnhancementRunnerDeps,
): EnhancementRunner {
  const run = deps.dispatch ?? defaultDispatch;
  return async (request: EnhancementRequest): Promise<EnhancementProposal> => {
    const { spec, runtime } = await deps.plan(request);
    // Bounded: a single terminal step over the deepseek-v4-flash profile, never
    // a blind retranslation or a tool-driven exploration.
    if (spec.tools.length !== 0) {
      throw new Error("bounded enhancement must dispatch a tool-free call");
    }
    if (spec.requestedModel !== deepSeekV4FlashProfile.model) {
      throw new Error("enhancement must use the deepseek-v4-flash profile");
    }
    const result = await run(spec, runtime);
    if (result.status !== "success") {
      throw new Error(`enhancement dispatch did not succeed: ${result.failureKind}`);
    }
    return { objectJson: result.value as unknown as JsonValue, authorMemoKey: result.memoKey };
  };
}
