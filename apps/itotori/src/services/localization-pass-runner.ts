import type { LocalizationPassRunConfigRecord } from "@itotori/db";

import type { DriveLocalizationPassDeps } from "./launch-localization-pass.js";
import { driveLocalizationPass } from "./launch-localization-pass.js";
import {
  LocalizationPassControlError,
  LocalizationPassPausedError,
} from "./localization-pass-control.js";

export type LocalizationPassRunnerPort = {
  /** Admit a durable localization run without waiting for its long workflow. */
  start(input: {
    projectId: string;
    localeBranchId: string;
    config: LocalizationPassRunConfigRecord;
  }): Promise<{ journalRunId: string; startedAt: Date }>;
  /** Stop the currently admitted worker and wait for its durable paused state. */
  pause(input: {
    projectId: string;
    localeBranchId: string;
    journalRunId: string;
  }): Promise<{ journalRunId: string; pausedAt: Date }>;
  /** Resume a paused run with its original durable identity and checkpoints. */
  resume(input: {
    projectId: string;
    localeBranchId: string;
    journalRunId: string;
    config: LocalizationPassRunConfigRecord;
  }): Promise<{ journalRunId: string; resumedAt: Date }>;
};

type ActiveLocalizationPass = {
  readonly controller: AbortController;
  readonly journalRunId: string;
  readonly paused: Promise<{ journalRunId: string; pausedAt: Date }>;
  resolvePaused(value: { journalRunId: string; pausedAt: Date }): void;
  rejectPaused(error: unknown): void;
};

/**
 * Process-scoped detached-worker coordinator. A server factory owns one
 * instance so a later HTTP pause request reaches the worker admitted by an
 * earlier request. The DB remains the source of truth for lifecycle state.
 */
export function createDetachedLocalizationPassRunner(options: {
  openSession: (run: (deps: DriveLocalizationPassDeps) => Promise<void>) => Promise<void>;
  createRunId?: () => string;
  now?: () => Date;
}): LocalizationPassRunnerPort {
  const activeByRun = new Map<string, ActiveLocalizationPass>();
  return {
    async start(input) {
      return await begin(input);
    },
    async pause(input) {
      const key = runKey(input.projectId, input.journalRunId);
      const active = activeByRun.get(key);
      if (active === undefined) {
        throw new LocalizationPassControlError(
          "worker_unavailable",
          "pause",
          input.journalRunId,
          `cannot pause localization pass ${input.journalRunId}: its active worker is unavailable; refresh the run state and retry`,
        );
      }
      active.controller.abort(new LocalizationPassPausedError(input.journalRunId));
      return await active.paused;
    },
    async resume(input) {
      const admitted = await begin(input, input.journalRunId);
      return { journalRunId: admitted.journalRunId, resumedAt: admitted.startedAt };
    },
  };

  async function begin(
    input: {
      projectId: string;
      localeBranchId: string;
      config: LocalizationPassRunConfigRecord;
    },
    journalRunId?: string,
  ): Promise<{ journalRunId: string; startedAt: Date }> {
    const controller = new AbortController();
    let admitted = false;
    let resolveAdmitted!: (value: { journalRunId: string; startedAt: Date }) => void;
    let rejectAdmitted!: (error: unknown) => void;
    const admittedPromise = new Promise<{ journalRunId: string; startedAt: Date }>(
      (resolve, reject) => {
        resolveAdmitted = resolve;
        rejectAdmitted = reject;
      },
    );
    let resolvePaused!: (value: { journalRunId: string; pausedAt: Date }) => void;
    let rejectPaused!: (error: unknown) => void;
    const paused = new Promise<{ journalRunId: string; pausedAt: Date }>((resolve, reject) => {
      resolvePaused = resolve;
      rejectPaused = reject;
    });
    // A normal worker failure can occur before an operator asks it to pause.
    // Keep that rejection observable to a pause caller, without making it an
    // unhandled rejection when no pause request is ever made.
    void paused.catch(() => undefined);
    let active: ActiveLocalizationPass | undefined;
    const execution = options.openSession(async (deps) => {
      await driveLocalizationPass(
        {
          ...input,
          ...(journalRunId === undefined ? {} : { journalRunId }),
          abortSignal: controller.signal,
        },
        {
          ...deps,
          ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
          ...(options.now === undefined ? {} : { now: options.now }),
        },
        {
          onAdmitted: (value) => {
            admitted = true;
            active = {
              controller,
              journalRunId: value.journalRunId,
              paused,
              resolvePaused,
              rejectPaused,
            };
            activeByRun.set(runKey(input.projectId, value.journalRunId), active);
            resolveAdmitted(value);
          },
          onPaused: (value) => resolvePaused(value),
        },
      );
    });
    void execution.then(
      () => {
        if (!admitted) {
          rejectAdmitted(new Error("localization pass ended before durable admission"));
          return;
        }
        rejectPaused(
          new LocalizationPassControlError(
            "pause_requires_running",
            "pause",
            active?.journalRunId ?? journalRunId ?? "unknown",
            `cannot pause localization pass ${active?.journalRunId ?? journalRunId ?? "unknown"}: it completed before the pause took effect`,
          ),
        );
      },
      (error: unknown) => {
        if (!admitted) rejectAdmitted(error);
        rejectPaused(error);
      },
    );
    const admittedValue = await admittedPromise;
    const key = runKey(input.projectId, admittedValue.journalRunId);
    const removeActive = () => {
      // A quick resume can admit a replacement worker before the paused
      // worker's cleanup runs. Only remove the worker this invocation owned.
      if (active !== undefined && activeByRun.get(key) === active) activeByRun.delete(key);
    };
    void execution.then(removeActive, removeActive);
    return admittedValue;
  }
}

function runKey(projectId: string, journalRunId: string): string {
  return `${projectId}\u0000${journalRunId}`;
}
