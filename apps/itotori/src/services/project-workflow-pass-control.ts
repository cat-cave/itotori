import type {
  AuthorizationActor,
  ItotoriLocalizationPassRunConfigRepositoryPort,
  ItotoriProjectRunRepositoryPort,
} from "@itotori/db";

import {
  LocalizationPassControlError,
  type LocalizationPassControlAction,
} from "./localization-pass-control.js";
import type { LocalizationPassRunnerPort } from "./localization-pass-runner.js";
import type { LocalizationPassControlResult } from "./project-operations-port.js";

type PassControlDeps = {
  readonly actor: AuthorizationActor;
  readonly runs: ItotoriProjectRunRepositoryPort;
  readonly passRunConfig: ItotoriLocalizationPassRunConfigRepositoryPort;
  readonly passRunner: LocalizationPassRunnerPort;
};

type PassControlInput = { projectId: string; journalRunId: string };

// Service instances are request-scoped, while operator controls are not. Keep
// the read-status → worker-transition sequence exclusive per durable run so a
// double click receives the same actionable rejection as any stale request.
const controlTails = new Map<string, Promise<void>>();

export async function pauseLocalizationPass(
  deps: PassControlDeps,
  input: PassControlInput,
): Promise<LocalizationPassControlResult> {
  return await withControlLock(input, async () => {
    const run = await requireControlStatus(deps, input, "pause", "running");
    const paused = await deps.passRunner.pause({ ...input, localeBranchId: run.localeBranchId });
    return {
      action: "pause",
      journalRunId: paused.journalRunId,
      status: "paused",
      transitionedAt: paused.pausedAt,
    };
  });
}

export async function resumeLocalizationPass(
  deps: PassControlDeps,
  input: PassControlInput,
): Promise<LocalizationPassControlResult> {
  return await withControlLock(input, async () => {
    const run = await requireControlStatus(deps, input, "resume", "paused");
    const config = await deps.passRunConfig.resolveRunConfig(input.projectId, run.localeBranchId);
    if (config === null) {
      throw new LocalizationPassControlError(
        "configuration_missing",
        "resume",
        input.journalRunId,
        `cannot resume localization pass ${input.journalRunId}: its saved run configuration is unavailable`,
      );
    }
    if (config.updatedAt > run.createdAt) {
      throw new LocalizationPassControlError(
        "configuration_changed",
        "resume",
        input.journalRunId,
        `cannot resume localization pass ${input.journalRunId}: its saved configuration changed after this pass started; restore it or launch a new pass`,
      );
    }
    const resumed = await deps.passRunner.resume({
      ...input,
      localeBranchId: run.localeBranchId,
      config,
    });
    return {
      action: "resume",
      journalRunId: resumed.journalRunId,
      status: "running",
      transitionedAt: resumed.resumedAt,
    };
  });
}

async function withControlLock<T>(
  input: PassControlInput,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${input.projectId}\u0000${input.journalRunId}`;
  const previous = controlTails.get(key);
  let release: (() => void) | undefined;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (release === undefined) throw new Error("localization pass control lock was not initialized");
  controlTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (controlTails.get(key) === tail) controlTails.delete(key);
  }
}

async function requireControlStatus(
  deps: PassControlDeps,
  input: PassControlInput,
  action: LocalizationPassControlAction,
  expectedStatus: "running" | "paused",
): Promise<{ localeBranchId: string; createdAt: Date }> {
  const live = await deps.runs.loadLiveReadModel(deps.actor, input.projectId, input.journalRunId);
  if (live === null) {
    throw new LocalizationPassControlError(
      "run_not_found",
      action,
      input.journalRunId,
      `cannot ${action} localization pass ${input.journalRunId}: no matching run exists for this project`,
    );
  }
  if (live.run.status === expectedStatus) {
    return { localeBranchId: live.run.localeBranchId, createdAt: live.run.createdAt };
  }
  const requiredAction = expectedStatus === "running" ? "pause" : "resume";
  throw new LocalizationPassControlError(
    expectedStatus === "running" ? "pause_requires_running" : "resume_requires_paused",
    action,
    input.journalRunId,
    `cannot ${action} localization pass ${input.journalRunId}: it is ${live.run.status}; only a ${expectedStatus} pass can ${requiredAction}`,
  );
}
