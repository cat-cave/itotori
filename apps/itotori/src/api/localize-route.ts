// The kept API localize/draft mutation's SOLE path into the new pipeline.
//
// It does exactly what the composition-root localize entrypoint prescribes:
// resolve the run policy, project the decoded narrative structure into coherence-
// ordered scenes, and drive the deterministic workflow driver through
// `runLocalization`. It constructs NOTHING from the legacy service graph — no
// `ProjectWorkflowService.draftProject`, no provider object, no orchestrator
// journal reservation/finalizer, no context-correction worker, no raw-MTL path.
//
// The live port SUBSTRATE is injected as a `LocalizationPortSource` factory so this
// module's own transitive import closure stays clean of the legacy graph.

import { runLocalization, type LocalizationPortSource } from "../composition/index.js";
import { projectDecodeStructure } from "../composition/live/index.js";
import {
  FULL_ROSTER,
  OUTPUT_SCOPE_VALUES,
  resolveRunPolicy,
  type OutputScope,
  type RunPolicyRequest,
} from "../run-policy/index.js";
import type { ContextScopeValue, RunModeValue } from "../contracts/index.js";
import type { WorkflowOptions, WorkflowRunReport } from "../workflow/index.js";

/** The injected localize substrate. `resolvePortSource` is the ONLY seam the live
 * substrate enters through — production builds the live `WorkflowPortDeps`; a proof
 * injects fake ports. The handler never reaches for it any other way. */
export interface LocalizeRouteDeps {
  resolvePortSource(
    request: RunPolicyRequest,
  ): LocalizationPortSource | Promise<LocalizationPortSource>;
}

const RUN_MODE_VALUES: readonly RunModeValue[] = ["production", "pilot", "test-dev"];

/** One localize/draft request the API mutation surface can drive. */
export interface ApiLocalizeInput {
  readonly runMode: RunModeValue;
  readonly contextScope?: ContextScopeValue;
  readonly outputScope?: OutputScope;
  readonly structureJson: unknown;
  readonly wholeSceneMaxUnits?: number;
}

function parseRunMode(value: string): RunModeValue {
  if ((RUN_MODE_VALUES as readonly string[]).includes(value)) return value as RunModeValue;
  throw new Error(
    `localize refused: runMode must be one of ${RUN_MODE_VALUES.join(", ")} (got '${value}')`,
  );
}

function parseOutputScope(value: string): OutputScope {
  if (OUTPUT_SCOPE_VALUES.includes(value)) return value as OutputScope;
  throw new Error(
    `localize refused: outputScope must be one of ${OUTPUT_SCOPE_VALUES.join(", ")} (got '${value}')`,
  );
}

/** Shape a localize request into a `RunPolicyRequest`. Policy legality is the
 * resolver's authority — this only assembles the request. */
export function buildLocalizeRunRequest(input: ApiLocalizeInput): RunPolicyRequest {
  const runMode = parseRunMode(input.runMode);
  const contextScope = (input.contextScope ?? "whole-game") as ContextScopeValue;
  const outputScope = parseOutputScope(input.outputScope ?? "dialogue-only");
  return { runMode, contextScope, outputScope, roster: FULL_ROSTER };
}

/**
 * Drive one API localize/draft mutation through the new pipeline. This is the ONLY
 * path the kept mutation takes — the old orchestrator/service path is unreachable
 * from here.
 */
export async function runApiLocalize(
  input: ApiLocalizeInput,
  deps: LocalizeRouteDeps,
): Promise<WorkflowRunReport> {
  const request = buildLocalizeRunRequest(input);
  // Resolve the policy up front so an illegal run fails loudly at the boundary
  // (the driver re-resolves it as its own first gate — this is not a bypass).
  resolveRunPolicy(request);

  const { scenes } = projectDecodeStructure(input.structureJson);

  const options: WorkflowOptions =
    input.wholeSceneMaxUnits === undefined ? {} : { wholeSceneMaxUnits: input.wholeSceneMaxUnits };

  const source = await deps.resolvePortSource(request);
  return await runLocalization(request, scenes, source, options);
}
