// The kept `localize` command's SOLE path into the new pipeline.
//
// It does exactly what the composition-root localize entrypoint prescribes:
// resolve the run policy, project the decoded narrative structure into coherence-
// ordered scenes, and drive the deterministic workflow driver through
// `runLocalization`. It constructs NOTHING from the legacy service graph — no
// `ProjectWorkflowService.draftProject`, no provider object, no orchestrator
// journal reservation/finalizer, no context-correction worker, no raw-MTL path.
//
// The live port SUBSTRATE is injected as a `LocalizationPortSource` factory so this
// module's own transitive import closure stays clean of the legacy graph:
// production returns `{ deps }` — the live `WorkflowPortDeps` assembled from
// `composition/live` (dispatch runtime over the ZDR boundary + Postgres-backed CAS
// store + decode→scene projection); an offline proof returns `{ ports }` (fake
// ports) to drive the driver without a live ZDR/Postgres run.

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
import type { WorkflowOptions } from "../workflow/index.js";
import { optionalFlag, requiredFlag } from "./flags.js";

/** The minimal JSON store the localize command reads its structure from and writes
 * its run summary to. */
export interface LocalizeCommandIo {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
}

/** The injected localize substrate. `resolvePortSource` is the ONLY seam the live
 * substrate enters through — production builds the live `WorkflowPortDeps`; a proof
 * injects fake ports. The handler never reaches for it any other way. */
export interface LocalizeCommandDeps {
  readonly io: LocalizeCommandIo;
  resolvePortSource(
    request: RunPolicyRequest,
  ): LocalizationPortSource | Promise<LocalizationPortSource>;
  log?(message: string): void;
}

const RUN_MODE_VALUES: readonly RunModeValue[] = ["production", "pilot", "test-dev"];

function parseRunMode(value: string): RunModeValue {
  if ((RUN_MODE_VALUES as readonly string[]).includes(value)) return value as RunModeValue;
  throw new Error(`localize refused: --run-mode must be one of ${RUN_MODE_VALUES.join(", ")}`);
}

function parseOutputScope(value: string): OutputScope {
  if (OUTPUT_SCOPE_VALUES.includes(value)) return value as OutputScope;
  throw new Error(
    `localize refused: --output-scope must be one of ${OUTPUT_SCOPE_VALUES.join(", ")}`,
  );
}

/** Parse the run request from the CLI flags. `resolveRunPolicy` is the authority
 * on legality — this only shapes the request; an illegal combination is rejected
 * (loudly, by policy) below. Roster defaults to the full roster (production/pilot
 * require it); the context scope is passed through verbatim so a `narrowed:` scope
 * is validated by the policy resolver. */
export function parseLocalizeRunRequest(args: readonly string[]): RunPolicyRequest {
  const runMode = parseRunMode(requiredFlag(args, "--run-mode"));
  const contextScope = (optionalFlag(args, "--context-scope") ?? "whole-game") as ContextScopeValue;
  const outputScope = parseOutputScope(optionalFlag(args, "--output-scope") ?? "dialogue-only");
  return { runMode, contextScope, outputScope, roster: FULL_ROSTER };
}

/**
 * Run one `itotori localize` invocation through the new pipeline. This is the ONLY
 * path the kept command takes — the old orchestrator/service path is unreachable
 * from here.
 *
 * Required flags:
 *   --run-mode production|pilot|test-dev   the operational posture (gates legality)
 *   --structure <PATH>                     decoded narrative-structure JSON (the
 *                                          decode→scene projection input)
 * Optional flags:
 *   --context-scope <scope>   whole-game (default) | external-augmented | narrowed:<…>
 *   --output-scope <scope>    dialogue-only (default) | dialogue-and-choices | …
 *   --whole-scene-max-units <N>  the whole-scene draft budget
 *   --output <PATH>           write the run summary here (else stdout)
 */
export async function runLocalizeCommand(
  args: readonly string[],
  deps: LocalizeCommandDeps,
): Promise<void> {
  const request = parseLocalizeRunRequest(args);
  // Resolve the policy up front so an illegal run fails loudly at the boundary
  // (the driver re-resolves it as its own first gate — this is not a bypass).
  resolveRunPolicy(request);

  const structurePath = requiredFlag(args, "--structure");
  const structureJson = deps.io.readJson(structurePath);
  const { scenes } = projectDecodeStructure(structureJson);

  let wholeSceneMaxUnits: number | undefined;
  const wholeSceneMaxUnitsRaw = optionalFlag(args, "--whole-scene-max-units");
  if (wholeSceneMaxUnitsRaw !== undefined) {
    const parsed = Number.parseInt(wholeSceneMaxUnitsRaw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== wholeSceneMaxUnitsRaw) {
      throw new Error(
        `localize refused: --whole-scene-max-units '${wholeSceneMaxUnitsRaw}' must be a positive integer`,
      );
    }
    wholeSceneMaxUnits = parsed;
  }
  const options: WorkflowOptions = wholeSceneMaxUnits === undefined ? {} : { wholeSceneMaxUnits };

  const source = await deps.resolvePortSource(request);
  const report = await runLocalization(request, scenes, source, options);

  // Project a summary that carries NO source/target script text (copyrighted on
  // real bytes) — only run-shape counts + the resolved policy posture.
  const summary = {
    runMode: report.policy.runMode,
    contextScope: report.policy.contextScope,
    outputScope: report.policy.outputScope,
    shippable: report.policy.shippable,
    sceneCount: report.scenes.length,
    finalizedUnitCount: report.finalized.length,
    patchId: report.patchId,
    buildLqaVerdictCount: report.buildLqa.length,
    attemptCount: report.attemptLineage.length,
  };

  const outputPath = optionalFlag(args, "--output");
  if (outputPath !== undefined) {
    deps.io.writeJson(outputPath, summary);
    return;
  }
  (deps.log ?? ((message: string) => process.stdout.write(`${message}\n`)))(
    JSON.stringify(summary, null, 2),
  );
}
