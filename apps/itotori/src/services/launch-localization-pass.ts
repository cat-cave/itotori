// Dashboard "Launch next pass" execution path.
//
// Reuses the same composition-root localize entrypoint the CLI uses
// (`runLocalization` + `LocalizeRunTracker` + live `resolvePortSource`). The
// HTTP mutation must return as soon as the durable project run is admitted;
// the long localization work continues on a detached service session so the
// request-scoped DB connection can close without aborting the pass.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { assertBridgeBundleV02, type BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import type { LocalizationPassRunConfigRecord } from "@itotori/db";

import {
  buildLocalizationPorts,
  runLocalization,
  type LocalizationPerRunInput,
  type LocalizationPortSource,
} from "../composition/localize-entrypoint.js";
import {
  providerBudgetCohort,
  type LocalizationProviderBudgetCohorts,
} from "../composition/provider-budget-cohort.js";
import { projectDecodeStructure } from "../composition/live/scene-projection.js";
import type { ContextScopeValue, RunModeValue } from "../contracts/index.js";
import { withPhysicalAttemptCostObserver } from "../llm/physical-attempt-cost-context.js";
import {
  FULL_ROSTER,
  OUTPUT_SCOPE_VALUES,
  resolveRunPolicy,
  type OutputScope,
  type RunPolicyRequest,
} from "../run-policy/index.js";
import type { WorkflowOptions } from "../workflow/index.js";
import { LocalizeRunTracker, type LocalizeRunTrackerTiming } from "../cli/localize-run-tracker.js";
import type { ItotoriProjectWorkflowPort } from "./project-operations-port.js";
import {
  isLocalizationPassPause,
  LocalizationPassControlError,
  LocalizationPassPausedError,
} from "./localization-pass-control.js";

export {
  createDetachedLocalizationPassRunner,
  type LocalizationPassRunnerPort,
} from "./localization-pass-runner.js";

const RUN_MODE_VALUES: readonly RunModeValue[] = ["production", "pilot", "test-dev"];

/** Operator-local launch document named by the pass-run config's configPath. */
export type LocalizationLaunchConfigDocument = {
  readonly structurePath: string;
  readonly bridgePath: string;
  readonly runMode: RunModeValue;
  readonly contextScope: ContextScopeValue;
  readonly outputScope: OutputScope;
  /** Optional engine-owned real background asset used only when a headless
   * scene inherits graphics from an earlier scene. */
  readonly runtimeBackgroundAsset?: string;
  readonly wholeSceneMaxUnits?: number;
};

/** A branch already has a queued, running, or paused pass. */
export class LocalizationPassAlreadyActiveError extends Error {
  constructor(
    readonly projectId: string,
    readonly localeBranchId: string,
  ) {
    super(`a localization pass is already active for ${projectId}/${localeBranchId}`);
    this.name = "LocalizationPassAlreadyActiveError";
  }
}

export type DriveLocalizationPassDeps = {
  readonly readJson: (path: string) => unknown;
  readonly writeJson?: (path: string, value: unknown) => void;
  readonly projectWorkflow: Pick<
    ItotoriProjectWorkflowPort,
    | "createOrResumeRun"
    | "acquireLease"
    | "renewLease"
    | "releaseLease"
    | "advanceRun"
    | "recordProgress"
    | "reserveCost"
    | "settleCost"
    | "releaseCost"
    | "loadLiveReadModel"
  >;
  resolvePortSource(
    request: RunPolicyRequest,
    perRun: LocalizationPerRunInput,
  ): LocalizationPortSource | Promise<LocalizationPortSource>;
  /** The live provider-budget cohort lifecycle; offline proofs may omit it. */
  readonly providerBudgetCohorts?: LocalizationProviderBudgetCohorts;
  /** Test-only lease timing override used by interrupted-run integration proofs. */
  readonly localizeRunTrackerTiming?: LocalizeRunTrackerTiming;
  /** Override only in tests — production uses a fresh random id per launch. */
  readonly createRunId?: () => string;
  readonly now?: () => Date;
  log?(message: string): void;
};

/**
 * Drive one whole-project localization pass from a resolved registry row.
 * `onAdmitted` fires after `LocalizeRunTracker.start` (durable run + lease +
 * running transition), so a detached caller can return the journal run id
 * without blocking on drafting/QA/patchback.
 */
export async function driveLocalizationPass(
  input: {
    projectId: string;
    localeBranchId: string;
    config: LocalizationPassRunConfigRecord;
    /** Present only when an existing durable paused run is resumed. */
    journalRunId?: string;
    /** Process-local operator pause request, forwarded to physical dispatch. */
    abortSignal?: AbortSignal;
  },
  deps: DriveLocalizationPassDeps,
  hooks: {
    onAdmitted?: (admitted: { journalRunId: string; startedAt: Date }) => void;
    onPaused?: (paused: { journalRunId: string; pausedAt: Date }) => void;
  } = {},
): Promise<void> {
  const launch = parseLaunchConfigDocument(
    input.config.configPath,
    deps.readJson(input.config.configPath),
  );
  const structureJson = deps.readJson(launch.structurePath);
  const bridgeJson = deps.readJson(launch.bridgePath);
  assertBridgeBundleV02(bridgeJson);
  const bridge: BridgeBundleV02 = bridgeJson;
  const { scenes } = projectDecodeStructure(structureJson, bridge);

  const request: RunPolicyRequest = {
    runMode: launch.runMode,
    contextScope: launch.contextScope,
    outputScope: launch.outputScope,
    roster: FULL_ROSTER,
    ablation: null,
  };
  resolveRunPolicy(request);

  const journalRunId = input.journalRunId ?? (deps.createRunId ?? defaultRunId)();
  const projectRun = {
    projectId: input.projectId,
    runId: journalRunId,
    localeBranchId: input.localeBranchId,
    leaseOwnerId: `launch-pass:${journalRunId}`,
  };
  const providerBudgetMember = { projectId: projectRun.projectId, runId: projectRun.runId };
  const admissionCohort = providerBudgetCohort([providerBudgetMember]);
  const options: WorkflowOptions =
    launch.wholeSceneMaxUnits === undefined
      ? {}
      : { wholeSceneMaxUnits: launch.wholeSceneMaxUnits };

  const perRun = {
    structureJson,
    bridge,
    projectRun,
    admissionCohort,
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    renderEvidence: {
      // The pass record owns both roots: `dataRoot` is the read-only extracted
      // runtime and `runDir` is the operator-owned output location. Keep the
      // physical plan at the invocation boundary; no renderer guesses a path.
      sourceRoot: input.config.dataRoot,
      buildRoot: join(input.config.runDir, "patch-builds"),
      patchScope: patchbackScopeForOutputScope(launch.outputScope),
      runId: journalRunId,
      ...(launch.runtimeBackgroundAsset === undefined
        ? {}
        : { backgroundAsset: launch.runtimeBackgroundAsset }),
    },
  };
  const writeJson = deps.writeJson ?? defaultWriteJson;
  const providerBudgetCohorts = deps.providerBudgetCohorts;
  let tracker: LocalizeRunTracker | undefined;
  let providerBudgetCohortActive = false;
  let workFailed = false;
  try {
    const source = await deps.resolvePortSource(request, perRun);
    if (source.runPlane === undefined) {
      throw new Error("launch-pass run plane is not configured by the localization substrate");
    }
    assertRunPlaneIdentity(source, projectRun);
    tracker = new LocalizeRunTracker(
      deps.projectWorkflow,
      source.runPlane,
      deps.localizeRunTrackerTiming,
      input.abortSignal,
    );
    try {
      await tracker.start(scenes.flatMap((scene) => scene.units.map((unit) => unit.unitId)));
    } catch (error: unknown) {
      if (isActiveLocalizationPassConflict(error)) {
        throw new LocalizationPassAlreadyActiveError(input.projectId, input.localeBranchId);
      }
      throw error;
    }
    if (providerBudgetCohorts !== undefined) {
      await providerBudgetCohorts.activate(admissionCohort);
      providerBudgetCohortActive = true;
    }
    hooks.onAdmitted?.({
      journalRunId,
      startedAt: (deps.now ?? (() => new Date()))(),
    });

    const ports = tracker.wrapPorts(portsWithRunCostObserver(source, tracker));
    const report = await withPhysicalAttemptCostObserver(
      tracker.costObserver,
      async () => await runLocalization(request, scenes, { ports }, options),
    );
    throwIfLocalizationPassPaused(input.abortSignal, journalRunId);
    const live = await tracker.complete();

    const summary = {
      runMode: report.policy.runMode,
      contextScope: report.policy.contextScope,
      contextProvenance: report.policy.contextProvenance,
      outputScope: report.policy.outputScope,
      excludedOutputUnitIds: report.excludedOutputUnitIds,
      shippable: report.policy.shippable,
      sceneCount: report.scenes.length,
      finalizedUnitCount: report.finalized.length,
      patchId: report.patchId,
      buildLqaVerdictCount: report.buildLqa.length,
      attemptCount: report.attemptLineage.length,
      projectId: projectRun.projectId,
      runId: projectRun.runId,
      runStatus: live?.run.status ?? null,
      progress: live === null ? null : live.progress,
    };
    writeJson(join(input.config.runDir, `${journalRunId}.summary.json`), summary);
  } catch (error: unknown) {
    workFailed = true;
    if (tracker !== undefined && isLocalizationPassPause(input.abortSignal)) {
      const live = await tracker.pause();
      if (live?.run.status !== "paused") {
        throw new LocalizationPassControlError(
          "pause_requires_running",
          "pause",
          journalRunId,
          `cannot pause localization pass ${journalRunId}: it completed before the pause took effect`,
        );
      }
      const pausedAt = (deps.now ?? (() => new Date()))();
      // The durable transition and lease release are complete. Resolve the
      // control request before writing the optional operator artifact so a
      // local output-volume failure cannot strand a successfully paused run.
      hooks.onPaused?.({ journalRunId, pausedAt });
      writeJson(join(input.config.runDir, `${journalRunId}.paused.json`), {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        runId: journalRunId,
        runStatus: live?.run.status ?? null,
        progress: live === null ? null : live.progress,
      });
      return;
    }
    let failedTransitionError: unknown;
    if (tracker !== undefined) {
      try {
        await tracker.fail();
      } catch (failure: unknown) {
        failedTransitionError = failure;
      }
    }
    // The project-run transition is the dashboard's durable terminal signal.
    // This artifact retains the exception itself for operators after the HTTP
    // admission response has already returned.
    writeJson(join(input.config.runDir, `${journalRunId}.failure.json`), {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      runId: journalRunId,
      failure: errorSummary(error),
      ...(failedTransitionError === undefined
        ? {}
        : { failedTransitionError: errorSummary(failedTransitionError) }),
    });
    throw error;
  } finally {
    if (providerBudgetCohortActive && providerBudgetCohorts !== undefined) {
      try {
        await providerBudgetCohorts.release(admissionCohort, providerBudgetMember);
      } catch (releaseError: unknown) {
        if (!workFailed) throw releaseError;
        reportProviderBudgetReleaseFailure(deps.log, releaseError);
      }
    }
  }
}

export function parseLaunchConfigDocument(
  configPath: string,
  raw: unknown,
): LocalizationLaunchConfigDocument {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`launch-pass config at ${configPath} must be a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  const structurePath = requiredPathField(record, "structurePath", configPath);
  const bridgePath = requiredPathField(record, "bridgePath", configPath);
  const baseDir = dirname(resolve(configPath));
  const runMode = parseRunMode(record.runMode, configPath);
  const contextScope = (record.contextScope ?? "whole-game") as ContextScopeValue;
  if (typeof contextScope !== "string" || contextScope.trim().length === 0) {
    throw new Error(`launch-pass config at ${configPath} has an invalid contextScope`);
  }
  const outputScope = parseOutputScope(record.outputScope, configPath);
  let wholeSceneMaxUnits: number | undefined;
  if (record.wholeSceneMaxUnits !== undefined) {
    if (
      typeof record.wholeSceneMaxUnits !== "number" ||
      !Number.isInteger(record.wholeSceneMaxUnits) ||
      record.wholeSceneMaxUnits <= 0
    ) {
      throw new Error(
        `launch-pass config at ${configPath} wholeSceneMaxUnits must be a positive integer`,
      );
    }
    wholeSceneMaxUnits = record.wholeSceneMaxUnits;
  }
  const runtimeBackgroundAsset = optionalPathField(record, "runtimeBackgroundAsset", configPath);
  return {
    structurePath: resolveAgainst(baseDir, structurePath),
    bridgePath: resolveAgainst(baseDir, bridgePath),
    runMode,
    contextScope,
    outputScope,
    ...(runtimeBackgroundAsset === undefined ? {} : { runtimeBackgroundAsset }),
    ...(wholeSceneMaxUnits === undefined ? {} : { wholeSceneMaxUnits }),
  };
}

export function defaultReadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function defaultWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function defaultRunId(): string {
  return `launch-pass-${randomUUID()}`;
}

function requiredPathField(
  record: Record<string, unknown>,
  field: "structurePath" | "bridgePath",
  configPath: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`launch-pass config at ${configPath} requires a non-empty ${field}`);
  }
  return value.trim();
}

function optionalPathField(
  record: Record<string, unknown>,
  field: "runtimeBackgroundAsset",
  configPath: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`launch-pass config at ${configPath} has an invalid ${field}`);
  }
  return value.trim();
}

function patchbackScopeForOutputScope(
  outputScope: OutputScope,
): "dialogue-only" | "dialogue+choices" {
  if (outputScope === "dialogue-only") return "dialogue-only";
  if (outputScope === "dialogue-and-choices") return "dialogue+choices";
  throw new Error(`launch-pass physical Build-LQA does not support output scope '${outputScope}'`);
}

function resolveAgainst(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function parseRunMode(value: unknown, configPath: string): RunModeValue {
  if (value === undefined) return "production";
  if (typeof value === "string" && (RUN_MODE_VALUES as readonly string[]).includes(value)) {
    return value as RunModeValue;
  }
  throw new Error(
    `launch-pass config at ${configPath} runMode must be one of ${RUN_MODE_VALUES.join(", ")}`,
  );
}

function parseOutputScope(value: unknown, configPath: string): OutputScope {
  if (value === undefined) return "dialogue-only";
  if (typeof value === "string" && OUTPUT_SCOPE_VALUES.includes(value)) {
    return value as OutputScope;
  }
  throw new Error(
    `launch-pass config at ${configPath} outputScope must be one of ${OUTPUT_SCOPE_VALUES.join(", ")}`,
  );
}

function assertRunPlaneIdentity(
  source: LocalizationPortSource,
  requested: NonNullable<LocalizationPerRunInput["projectRun"]>,
): asserts source is LocalizationPortSource & {
  readonly runPlane: NonNullable<LocalizationPortSource["runPlane"]>;
} {
  if (source.runPlane === undefined) return;
  for (const field of ["projectId", "runId", "localeBranchId", "leaseOwnerId"] as const) {
    if (source.runPlane[field] !== requested[field]) {
      throw new Error(`launch-pass substrate returned a run plane with a different ${field}`);
    }
  }
}

function portsWithRunCostObserver(source: LocalizationPortSource, tracker: LocalizeRunTracker) {
  if (source.ports !== undefined) {
    return source.attachRunCostObserver?.(tracker.costObserver) ?? source.ports;
  }
  return buildLocalizationPorts(source.deps);
}

function errorSummary(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "NonErrorThrown", message: String(error) };
}

function reportProviderBudgetReleaseFailure(
  log: ((message: string) => void) | undefined,
  error: unknown,
): void {
  try {
    (log ?? ((message: string) => process.stderr.write(`${message}\n`)))(
      `launch localization pass provider budget cohort release failed: ${errorSummary(error).message}`,
    );
  } catch {
    // A diagnostic cannot replace the original pass failure.
  }
}

function throwIfLocalizationPassPaused(
  signal: AbortSignal | undefined,
  journalRunId: string,
): void {
  if (isLocalizationPassPause(signal)) throw new LocalizationPassPausedError(journalRunId);
}

export function isActiveLocalizationPassConflict(error: unknown): boolean {
  let current = error;
  while (typeof current === "object" && current !== null) {
    if (
      ("code" in current && (current as { code?: unknown }).code === "active_run_exists") ||
      ("constraint" in current &&
        (current as { constraint?: unknown }).constraint ===
          "itotori_project_runs_one_active_branch_idx")
    ) {
      return true;
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}
