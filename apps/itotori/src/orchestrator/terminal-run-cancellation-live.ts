// F-P1-5 — operator cancellation for an existing durable localization run.
//
// This path deliberately does not parse a localization config, construct a
// provider, or run the executor. It terminalizes the identified DB run as
// aborted, then projects run-summary.json from the committed canonical row.

import { join } from "node:path";
import {
  ItotoriLocalizationRunFinalizerRepository,
  bootstrapLocalUser,
  createDatabaseContext,
  databaseUrlFromEnv,
  localUserId,
  type AuthorizationActor,
} from "@itotori/db";
import { DbTerminalRunFinalizerAdapter } from "./terminal-run-finalizer-db-adapter.js";
import { finalizeTerminalRun, type TerminalRunSummary } from "./terminal-run-finalizer.js";

export type TerminalRunCancellationJsonProjection = {
  writeJson(path: string, value: unknown): void;
};

export type CancelTerminalRunLiveArgs = {
  runId: string;
  runDir: string;
  io: TerminalRunCancellationJsonProjection;
  /**
   * Optional server-resolved ownership fence. CLI callers omit it; an API/live
   * workflow supplies it so knowledge of a run id cannot cancel another
   * project or locale branch's run.
   */
  expectedScope?: {
    projectId: string;
    localeBranchId: string;
  };
};

export type CancelTerminalRunLiveResult = {
  journalRunId: string;
  runState: "aborted";
  summaryPath: string;
  summary: TerminalRunSummary;
};

/**
 * Cancel one existing run through the production DB adapter. The operator
 * override atomically clears any live executor lease as the run becomes
 * aborted, fencing subsequent executor writes. The summary file is written
 * only after the repository transaction has committed its canonical row.
 */
export async function cancelTerminalRunLive(
  args: CancelTerminalRunLiveArgs,
): Promise<CancelTerminalRunLiveResult> {
  const runId = requireNonBlank(args.runId, "runId");
  const runDir = requireNonBlank(args.runDir, "runDir");
  const summaryPath = join(runDir, "run-summary.json");
  const context = createDatabaseContext(databaseUrlFromEnv());

  try {
    await bootstrapLocalUser(context.db);
    const actor: AuthorizationActor = { userId: localUserId };
    const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
    const initial = await repository.loadSnapshot(actor, runId);
    if (initial === null) {
      throw new Error(`cannot cancel localization run ${runId}: run does not exist`);
    }
    if (args.expectedScope !== undefined) {
      const expectedProjectId = requireNonBlank(
        args.expectedScope.projectId,
        "expectedScope.projectId",
      );
      const expectedLocaleBranchId = requireNonBlank(
        args.expectedScope.localeBranchId,
        "expectedScope.localeBranchId",
      );
      if (
        initial.run.projectId !== expectedProjectId ||
        initial.run.localeBranchId !== expectedLocaleBranchId
      ) {
        throw new Error(
          `cannot cancel localization run ${runId}: run does not belong to the requested project and locale branch`,
        );
      }
    }
    if (initial.run.status === "aborted") {
      const committed = await repository.loadTerminalSummary(actor, runId);
      if (committed === null || committed.terminalStatus !== "aborted") {
        throw new Error(
          `cannot replay cancellation for ${runId}: no committed aborted summary exists`,
        );
      }
      const canonical = committed.summary as TerminalRunSummary;
      args.io.writeJson(summaryPath, canonical);
      await repository.upsertPatchStageEvidence(actor, {
        runId,
        stage: "summary",
        status: "succeeded",
        evidence: { path: summaryPath },
        lastError: null,
      });
      return {
        journalRunId: runId,
        runState: "aborted",
        summaryPath,
        summary: canonical,
      };
    }
    if (initial.run.status === "succeeded" || initial.run.status === "failed") {
      throw new Error(
        `cannot cancel localization run ${runId}: run is already ${initial.run.status}`,
      );
    }

    const persistence = new DbTerminalRunFinalizerAdapter(
      repository,
      actor,
      undefined,
      {},
      { operatorCancellation: true, runLockPool: context.pool },
    );
    let projectedSummary: TerminalRunSummary | null = null;
    let projectionError: unknown;

    const finalization = await finalizeTerminalRun({
      runId,
      persistence,
      cancelled: true,
      workers: {
        summary: async () => {
          try {
            const committed = await repository.loadTerminalSummary(actor, runId);
            if (committed === null || committed.terminalStatus !== "aborted") {
              throw new Error(
                `refusing to project cancellation summary for ${runId}: no committed aborted row`,
              );
            }
            const canonical = committed.summary as TerminalRunSummary;
            args.io.writeJson(summaryPath, canonical);
            projectedSummary = canonical;
            return { evidence: { path: summaryPath } };
          } catch (error) {
            projectionError = error;
            throw error;
          }
        },
      },
    });

    if (!finalization.committed || finalization.terminalStatus !== "aborted") {
      throw new Error(
        `operator cancellation for ${runId} did not commit an aborted terminal state`,
      );
    }
    if (projectionError !== undefined) throw projectionError;
    if (projectedSummary === null) {
      throw new Error(`operator cancellation for ${runId} did not project its canonical summary`);
    }

    return {
      journalRunId: runId,
      runState: "aborted",
      summaryPath,
      summary: projectedSummary,
    };
  } finally {
    await context.close();
  }
}

function requireNonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-blank`);
  return normalized;
}
