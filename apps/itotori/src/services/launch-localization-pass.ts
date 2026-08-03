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
import { LocalizeRunTracker } from "../cli/localize-run-tracker.js";
import type { ItotoriProjectWorkflowPort } from "./project-operations-port.js";

const RUN_MODE_VALUES: readonly RunModeValue[] = ["production", "pilot", "test-dev"];

/** Operator-local launch document named by the pass-run config's configPath. */
export type LocalizationLaunchConfigDocument = {
  readonly structurePath: string;
  readonly bridgePath: string;
  readonly runMode: RunModeValue;
  readonly contextScope: ContextScopeValue;
  readonly outputScope: OutputScope;
  readonly wholeSceneMaxUnits?: number;
};

export type LocalizationPassRunnerPort = {
  /**
   * Admit a durable localization run and return its id without waiting for the
   * pass to finish. The runner keeps driving the pass after this resolves.
   */
  start(input: {
    projectId: string;
    localeBranchId: string;
    config: LocalizationPassRunConfigRecord;
  }): Promise<{ journalRunId: string; startedAt: Date }>;
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
    | "createRun"
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
  /** Override only in tests — production uses a fresh random id per launch. */
  readonly createRunId?: () => string;
  readonly now?: () => Date;
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
  },
  deps: DriveLocalizationPassDeps,
  hooks: {
    onAdmitted?: (admitted: { journalRunId: string; startedAt: Date }) => void;
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

  const journalRunId = (deps.createRunId ?? defaultRunId)();
  const projectRun = {
    projectId: input.projectId,
    runId: journalRunId,
    localeBranchId: input.localeBranchId,
    leaseOwnerId: `launch-pass:${journalRunId}`,
  };
  const options: WorkflowOptions =
    launch.wholeSceneMaxUnits === undefined
      ? {}
      : { wholeSceneMaxUnits: launch.wholeSceneMaxUnits };

  const source = await deps.resolvePortSource(request, {
    structureJson,
    bridge,
    projectRun,
  });
  if (source.runPlane === undefined) {
    throw new Error("launch-pass run plane is not configured by the localization substrate");
  }
  assertRunPlaneIdentity(source, projectRun);

  const tracker = new LocalizeRunTracker(deps.projectWorkflow, source.runPlane);
  const writeJson = deps.writeJson ?? defaultWriteJson;
  try {
    try {
      await tracker.start(scenes.flatMap((scene) => scene.units.map((unit) => unit.unitId)));
    } catch (error: unknown) {
      if (isActiveLocalizationPassConflict(error)) {
        throw new LocalizationPassAlreadyActiveError(input.projectId, input.localeBranchId);
      }
      throw error;
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
    let failedTransitionError: unknown;
    try {
      await tracker.fail();
    } catch (failure: unknown) {
      failedTransitionError = failure;
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
  }
}

/**
 * Production-shaped runner: opens a detached service session, admits the run,
 * resolves with the journal id, then keeps the session open until the pass
 * finishes (or fails durably).
 */
export function createDetachedLocalizationPassRunner(options: {
  openSession: (run: (deps: DriveLocalizationPassDeps) => Promise<void>) => Promise<void>;
  createRunId?: () => string;
  now?: () => Date;
}): LocalizationPassRunnerPort {
  return {
    async start(input) {
      let admitted = false;
      let resolveAdmitted!: (value: { journalRunId: string; startedAt: Date }) => void;
      let rejectAdmitted!: (error: unknown) => void;
      const admittedPromise = new Promise<{ journalRunId: string; startedAt: Date }>(
        (resolve, reject) => {
          resolveAdmitted = resolve;
          rejectAdmitted = reject;
        },
      );

      const execution = options.openSession(async (deps) => {
        await driveLocalizationPass(
          input,
          {
            ...deps,
            ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
            ...(options.now === undefined ? {} : { now: options.now }),
          },
          {
            onAdmitted: (value) => {
              admitted = true;
              resolveAdmitted(value);
            },
          },
        );
      });
      execution.catch((error: unknown) => {
        if (!admitted) rejectAdmitted(error);
      });

      return await admittedPromise;
    },
  };
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
  return {
    structurePath: resolveAgainst(baseDir, structurePath),
    bridgePath: resolveAgainst(baseDir, bridgePath),
    runMode,
    contextScope,
    outputScope,
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
