// p0-core-terminal-run-finalizer — all-path terminal-state contract.
//
// The fixture deliberately models durable rows, including the PatchVersion
// state mutations performed by the production persistence adapter.  That keeps
// this suite focused on the transport-free terminalizer's coverage predicate
// and all-path summary behavior.

import { describe, expect, it } from "vitest";
import { DbTerminalRunFinalizerAdapter } from "../src/orchestrator/terminal-run-finalizer-db-adapter.js";
import {
  TERMINAL_RUN_SUMMARY_SCHEMA_VERSION,
  TerminalRunCommitResumableError,
  TerminalRunOperationalBlockerError,
  evaluateTerminalRunCoverage,
  finalizeTerminalRun,
  terminalFinalizerStageValues,
  type TerminalFinalizerStage,
  type TerminalPatchVersion,
  type TerminalRunFinalizerPersistencePort,
  type TerminalRunSnapshot,
  type TerminalRunSummary,
  type TerminalRunSummaryStage,
  type TerminalStageStatus,
} from "../src/orchestrator/terminal-run-finalizer.js";

const RUN_ID = "terminal-finalizer-run";
const FIXED_NOW = () => new Date("2026-07-12T12:00:00.000Z");

class InMemoryTerminalPersistence implements TerminalRunFinalizerPersistencePort {
  readonly commits: Array<{
    terminalStatus: TerminalRunSummary["terminalStatus"];
    summary: TerminalRunSummary;
  }> = [];
  readonly recordedStages: Array<{
    stage: TerminalFinalizerStage;
    status: TerminalStageStatus;
    evidence: Record<string, unknown> | null;
    error: string | null;
  }> = [];
  readonly ensuredPatchInputs: Array<{
    frozenUnitIds: string[];
    artifactHashes: Record<string, string>;
    artifactRefs: Record<string, string>;
  }> = [];
  commitFailuresBeforeWrite = 0;
  throwAfterNextCommit = false;
  stageRecordFailure: { stage: TerminalFinalizerStage; status: TerminalStageStatus } | null = null;

  constructor(private snapshot: TerminalRunSnapshot = completeSnapshot()) {}

  async loadSnapshot(runId: string): Promise<TerminalRunSnapshot | null> {
    if (runId !== this.snapshot.runId) return null;
    return structuredClone(this.snapshot);
  }

  async loadTerminalSummary(runId: string): Promise<TerminalRunSummary | null> {
    this.requireRun(runId);
    return this.commits.at(-1)?.summary === undefined
      ? null
      : structuredClone(this.commits.at(-1)!.summary);
  }

  async enterFinalizing(runId: string): Promise<void> {
    this.requireRun(runId);
    this.snapshot = { ...this.snapshot, runStatus: "finalizing" };
  }

  async ensurePatchVersion(input: {
    runId: string;
    frozenUnitIds: string[];
    memberships: Array<{ unitId: string; outcomeId: string; resultRevisionId: string }>;
    artifactHashes: Record<string, string>;
    artifactRefs: Record<string, string>;
  }): Promise<TerminalPatchVersion> {
    this.requireRun(input.runId);
    this.ensuredPatchInputs.push({
      frozenUnitIds: [...input.frozenUnitIds],
      artifactHashes: { ...input.artifactHashes },
      artifactRefs: { ...input.artifactRefs },
    });
    expect(input.memberships.map((membership) => membership.unitId)).toEqual(input.frozenUnitIds);

    const current = this.snapshot.patch;
    const patch: TerminalPatchVersion = {
      patchVersionId: current?.patchVersionId ?? `patch-version:${input.runId}`,
      unitIds: [...input.frozenUnitIds],
      artifactHashes:
        Object.keys(input.artifactHashes).length === 0
          ? { ...current?.artifactHashes }
          : { ...input.artifactHashes },
      artifactRefs:
        Object.keys(input.artifactRefs).length === 0
          ? { ...current?.artifactRefs }
          : { ...input.artifactRefs },
      buildSucceeded: current?.buildSucceeded ?? false,
      applySucceeded: current?.applySucceeded ?? false,
      validationSucceeded: current?.validationSucceeded ?? false,
      playable: false,
    };
    this.snapshot = { ...this.snapshot, patch };
    return structuredClone(patch);
  }

  async recordStage(input: {
    runId: string;
    stage: TerminalFinalizerStage;
    status: TerminalStageStatus;
    evidence?: Record<string, unknown> | null;
    error?: string | null;
  }): Promise<void> {
    this.requireRun(input.runId);
    if (
      this.stageRecordFailure?.stage === input.stage &&
      this.stageRecordFailure.status === input.status
    ) {
      throw new Error(`could not persist ${input.stage} ${input.status} evidence`);
    }
    const record = {
      stage: input.stage,
      status: input.status,
      evidence: input.evidence ?? null,
      error: input.error ?? null,
    } as const;
    this.recordedStages.push(record);
    const summaryStage = summaryStageFor(input.stage);
    const summaryRecord = { ...record, stage: summaryStage };
    this.snapshot = {
      ...this.snapshot,
      stages: [
        ...this.snapshot.stages.filter((stage) => stage.stage !== summaryStage),
        summaryRecord,
      ],
      patch: patchAfterStage(this.snapshot.patch, input.stage, input.status),
    };
  }

  async commitTerminal(input: {
    runId: string;
    terminalStatus: TerminalRunSummary["terminalStatus"];
    rootCause: TerminalRunSummary["rootCause"];
    blocker: TerminalRunSummary["blocker"];
    patchVersionId?: string;
    summary: TerminalRunSummary;
  }): Promise<TerminalRunSummary> {
    this.requireRun(input.runId);
    if (this.commitFailuresBeforeWrite > 0) {
      this.commitFailuresBeforeWrite -= 1;
      throw new Error("injected terminal commit failure");
    }
    const patch = this.snapshot.patch;
    this.snapshot = {
      ...this.snapshot,
      runStatus: input.terminalStatus,
      blocker: input.blocker,
      patch: patch === null ? null : { ...patch, playable: input.terminalStatus === "succeeded" },
    };
    const summary: TerminalRunSummary = {
      ...input.summary,
      terminalStatus: input.terminalStatus,
      rootCause: input.rootCause,
      blocker: input.blocker,
      summaryEpoch: this.commits.length + 1,
      patch: {
        ...input.summary.patch,
        playable: input.terminalStatus === "succeeded",
      },
    };
    this.commits.push({ terminalStatus: input.terminalStatus, summary: structuredClone(summary) });
    if (this.throwAfterNextCommit) {
      this.throwAfterNextCommit = false;
      throw new Error("terminal commit response was lost after commit");
    }
    return summary;
  }

  durableSnapshot(): TerminalRunSnapshot {
    return structuredClone(this.snapshot);
  }

  resume(): void {
    this.snapshot = { ...this.snapshot, runStatus: "running", blocker: null };
  }

  private requireRun(runId: string): void {
    if (runId !== this.snapshot.runId) throw new Error(`unexpected run ${runId}`);
  }
}

describe("terminal run finalizer", () => {
  it("succeeds on coverage despite QA findings, which remain metrics only", async () => {
    const persistence = new InMemoryTerminalPersistence({
      ...completeSnapshot(),
      quality: { findingCount: 3, contestedFindingCount: 2 },
    });

    const result = await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      workers: successfulWorkers(),
      now: FIXED_NOW,
    });

    expect(result).toMatchObject({ terminalStatus: "succeeded", committed: true });
    expect(result.summary).toMatchObject({
      schemaVersion: TERMINAL_RUN_SUMMARY_SCHEMA_VERSION,
      terminalStatus: "succeeded",
      quality: { findingCount: 3, contestedFindingCount: 2 },
      patch: { exactFrozenScope: true, playable: true },
    });
    expect(persistence.ensuredPatchInputs).toHaveLength(2);
    expect(persistence.commits).toHaveLength(1);
  });

  it("pauses a durable coverage gap instead of declaring a partial run successful", async () => {
    const incomplete = completeSnapshot();
    incomplete.outcomes[1] = {
      ...incomplete.outcomes[1]!,
      selectedCandidate: { id: "candidate-b", body: "   ", valid: true },
    };
    const persistence = new InMemoryTerminalPersistence(incomplete);

    const result = await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      workers: successfulWorkers(),
      now: FIXED_NOW,
    });

    expect(result).toMatchObject({
      terminalStatus: "paused",
      committed: true,
      summary: {
        rootCause: { kind: "operational_blocker", code: "coverage_incomplete" },
        coverage: { missingUnitIds: ["unit-b"] },
      },
    });
    expect(persistence.commits).toHaveLength(1);
  });

  it("keeps a released reservation unresolved until its exact provider bill reconciles", () => {
    const snapshot = completeSnapshot();
    snapshot.reservations = [{ reservationId: "reservation-a", state: "released" }];

    expect(evaluateTerminalRunCoverage(snapshot)).toMatchObject({
      complete: false,
      unreconciledReservationIds: ["reservation-a"],
    });
  });

  it("keeps an operational blocker resumable, then completes after resume", async () => {
    const persistence = new InMemoryTerminalPersistence();
    const blocker = {
      kind: "provider_outage" as const,
      detail: "provider is temporarily unavailable",
      evidence: "provider-status:unavailable",
      raisedAt: FIXED_NOW().toISOString(),
      operatorAction: "retry after the provider recovers",
    };

    const paused = await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      workers: {
        ...successfulWorkers(),
        provider: () => {
          throw new TerminalRunOperationalBlockerError(blocker);
        },
      },
      now: FIXED_NOW,
    });
    expect(paused).toMatchObject({
      terminalStatus: "paused",
      summary: { blocker, rootCause: { kind: "operational_blocker", stage: "provider" } },
    });

    persistence.resume();
    const completed = await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      workers: successfulWorkers(),
      now: FIXED_NOW,
    });
    expect(completed).toMatchObject({ terminalStatus: "succeeded", committed: true });
    expect(persistence.commits).toHaveLength(2);
  });

  it("writes the unified summary for explicit cancellation", async () => {
    const persistence = new InMemoryTerminalPersistence();

    const result = await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      cancelled: true,
      now: FIXED_NOW,
    });

    expect(result).toMatchObject({
      terminalStatus: "aborted",
      committed: true,
      summary: {
        schemaVersion: TERMINAL_RUN_SUMMARY_SCHEMA_VERSION,
        rootCause: { kind: "cancelled", code: "explicit_cancellation" },
      },
    });
    expect(persistence.commits).toHaveLength(1);
  });

  it("retries only the summary outbox after a terminal decision", async () => {
    const persistence = new InMemoryTerminalPersistence();
    await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      workers: {
        ...successfulWorkers(),
        summary: () => {
          throw new Error("summary projection is temporarily unavailable");
        },
      },
      now: FIXED_NOW,
    });

    let patchCalls = 0;
    let summaryCalls = 0;
    const replay = await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      workers: {
        patch_build: () => {
          patchCalls += 1;
          throw new Error("terminal patch build must not replay");
        },
        patch_apply: () => {
          patchCalls += 1;
          throw new Error("terminal patch apply must not replay");
        },
        summary: () => {
          summaryCalls += 1;
        },
      },
      now: FIXED_NOW,
    });

    expect(replay.terminalStatus).toBe("succeeded");
    expect(patchCalls).toBe(0);
    expect(summaryCalls).toBe(1);
    expect(persistence.commits).toHaveLength(1);
  });

  it("skips a durably succeeded build and retries only patch apply", async () => {
    const existing = completeSnapshot();
    existing.runStatus = "finalizing";
    existing.patch = {
      patchVersionId: `patch-version:${RUN_ID}`,
      unitIds: existing.frozenUnits.map((unit) => unit.unitId),
      artifactHashes: { "patch-export": "sha256:terminal-finalizer-test" },
      artifactRefs: { "patch-export": "patch-export-bundle.json" },
      buildSucceeded: true,
      applySucceeded: false,
      validationSucceeded: false,
      playable: false,
    };
    existing.stages = [{ stage: "patch", status: "pending", evidence: null, error: null }];
    const persistence = new InMemoryTerminalPersistence(existing);
    let buildCalls = 0;
    let applyCalls = 0;

    const result = await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      workers: {
        patch_build: () => {
          buildCalls += 1;
          throw new Error("completed build must not replay");
        },
        patch_apply: () => {
          applyCalls += 1;
          return { evidence: { retry: "apply-only" } };
        },
      },
      now: FIXED_NOW,
    });

    expect(result.terminalStatus).toBe("succeeded");
    expect(buildCalls).toBe(0);
    expect(applyCalls).toBe(1);
    expect(persistence.recordedStages).toContainEqual(
      expect.objectContaining({ stage: "patch_apply", status: "succeeded" }),
    );
  });

  it("retries a terminal commit before projecting its canonical summary", async () => {
    const persistence = new InMemoryTerminalPersistence();
    persistence.commitFailuresBeforeWrite = 1;
    const projections: TerminalRunSummary[] = [];

    const result = await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      workers: {
        ...successfulWorkers(),
        summary: ({ summary }) => {
          if (summary === undefined) throw new Error("missing committed summary");
          projections.push(structuredClone(summary));
        },
      },
      now: FIXED_NOW,
    });

    expect(result).toMatchObject({ terminalStatus: "succeeded", committed: true });
    expect(persistence.commits).toHaveLength(1);
    expect(projections).toEqual([persistence.commits[0]!.summary]);
  });

  it("reconciles an ambiguous after-commit error before summary projection", async () => {
    const persistence = new InMemoryTerminalPersistence();
    persistence.throwAfterNextCommit = true;
    const projections: TerminalRunSummary[] = [];

    const result = await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      workers: {
        ...successfulWorkers(),
        summary: ({ summary }) => {
          if (summary === undefined) throw new Error("missing committed summary");
          projections.push(structuredClone(summary));
        },
      },
      now: FIXED_NOW,
    });

    expect(result.summary).toEqual(persistence.commits[0]!.summary);
    expect(persistence.commits).toHaveLength(1);
    expect(projections).toEqual([persistence.commits[0]!.summary]);
  });

  it("does not mistake an older paused summary for a failed aborted commit", async () => {
    const persistence = new InMemoryTerminalPersistence();
    const blocker = {
      kind: "provider_outage" as const,
      detail: "provider temporarily unavailable",
      evidence: "provider-status:down",
      raisedAt: FIXED_NOW().toISOString(),
      operatorAction: "retry later",
    };
    await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      workers: {
        ...successfulWorkers(),
        provider: () => {
          throw new TerminalRunOperationalBlockerError(blocker);
        },
      },
      now: FIXED_NOW,
    });
    persistence.commitFailuresBeforeWrite = 1;

    const cancelled = await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      cancelled: true,
      now: FIXED_NOW,
    });

    expect(cancelled.terminalStatus).toBe("aborted");
    expect(cancelled.summary.summaryEpoch).toBe(2);
    expect(persistence.commits.map((entry) => entry.terminalStatus)).toEqual(["paused", "aborted"]);
  });

  it("throws a typed resumable error and never projects when commit remains unavailable", async () => {
    const persistence = new InMemoryTerminalPersistence();
    persistence.commitFailuresBeforeWrite = 2;
    let summaryCalls = 0;

    const finalization = finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      workers: {
        ...successfulWorkers(),
        summary: () => {
          summaryCalls += 1;
        },
      },
      now: FIXED_NOW,
    });

    await expect(finalization).rejects.toMatchObject({
      name: "TerminalRunCommitResumableError",
      runId: RUN_ID,
      durableRunStatus: "finalizing",
    } satisfies Partial<TerminalRunCommitResumableError>);
    expect(persistence.commits).toHaveLength(0);
    expect(persistence.durableSnapshot().runStatus).toBe("finalizing");
    expect(summaryCalls).toBe(0);
  });

  it("keeps the worker fault primary when recording its failure also fails", async () => {
    const persistence = new InMemoryTerminalPersistence();
    persistence.stageRecordFailure = { stage: "provider", status: "failed" };
    const rootFault = Object.assign(new Error("provider worker root fault"), {
      code: "provider_root_fault",
    });

    const result = await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      workers: {
        ...successfulWorkers(),
        provider: () => {
          throw rootFault;
        },
      },
      now: FIXED_NOW,
    });

    expect(result.summary.rootCause).toEqual({
      kind: "itotori_defect",
      stage: "provider",
      code: "provider_root_fault",
      message: "provider worker root fault",
    });
  });

  it.each(terminalFinalizerStageValues)(
    "writes exactly one unified summary when %s is fault-injected",
    async (stage) => {
      const persistence = new InMemoryTerminalPersistence();
      const stageFaults: Partial<Record<TerminalFinalizerStage, () => unknown>> = {
        [stage]: () => new Error(`injected ${stage} fault`),
      };

      const result = await finalizeTerminalRun({
        runId: RUN_ID,
        persistence,
        workers: successfulWorkers(),
        stageFaults,
        now: FIXED_NOW,
      });

      const expectedStatus = stage === "summary" || stage === "cleanup" ? "succeeded" : "failed";
      expect(result).toMatchObject({
        terminalStatus: expectedStatus,
        committed: true,
        summary: { schemaVersion: TERMINAL_RUN_SUMMARY_SCHEMA_VERSION, runId: RUN_ID },
      });
      expect(persistence.commits).toHaveLength(1);
      expect(persistence.recordedStages).toContainEqual(
        expect.objectContaining({ stage, status: "failed", error: `injected ${stage} fault` }),
      );
    },
  );

  it("does not let cleanup replace an earlier patch fault root cause", async () => {
    const persistence = new InMemoryTerminalPersistence();

    const result = await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      workers: successfulWorkers(),
      stageFaults: {
        patch_apply: () => new Error("patch artifact write failed"),
        cleanup: () => new Error("cleanup transport failed"),
      },
      now: FIXED_NOW,
    });

    expect(result).toMatchObject({
      terminalStatus: "failed",
      summary: {
        rootCause: {
          kind: "patch_fault",
          stage: "patch",
          message: "patch artifact write failed",
        },
        cleanup: { error: "cleanup transport failed" },
      },
    });
    expect(persistence.commits).toHaveLength(1);
  });
});

describe("DB terminal finalizer adapter patch stages", () => {
  it("keeps physical writes independent and collapses incomplete patch work to pending", async () => {
    const writes: string[] = [];
    const repository = {
      async loadSnapshot() {
        return {
          run: { runId: RUN_ID, status: "finalizing", pausedBlocker: null },
          units: [],
          outcomes: [],
          attempts: [],
          reservations: [],
          patch: null,
          summary: null,
          outbox: [
            {
              stage: "patch_build",
              status: "succeeded",
              evidence: { artifact: "built" },
              lastError: null,
            },
            {
              stage: "patch_apply",
              status: "pending",
              evidence: null,
              lastError: null,
            },
          ],
          quality: { findingCount: 0, contestedFindingCount: 0 },
        };
      },
      async upsertPatchStageEvidence(_actor: unknown, input: { stage: string }): Promise<never> {
        writes.push(input.stage);
        return undefined as never;
      },
    } as unknown as ConstructorParameters<typeof DbTerminalRunFinalizerAdapter>[0];
    const adapter = new DbTerminalRunFinalizerAdapter(repository, { userId: "adapter-test" });

    const snapshot = await adapter.loadSnapshot(RUN_ID);
    expect(snapshot?.stages.find((stage) => stage.stage === "patch")).toEqual({
      stage: "patch",
      status: "pending",
      evidence: null,
      error: null,
    });

    await adapter.recordStage({
      runId: RUN_ID,
      stage: "patch_build",
      status: "succeeded",
      evidence: { artifact: "built" },
    });
    expect(writes).toEqual(["patch_build"]);
  });
});

function completeSnapshot(): TerminalRunSnapshot {
  return {
    runId: RUN_ID,
    runStatus: "running",
    blocker: null,
    frozenUnits: [
      { unitId: "unit-a", ordinal: 0 },
      { unitId: "unit-b", ordinal: 1 },
    ],
    outcomes: [
      {
        unitId: "unit-a",
        outcomeId: "outcome-a",
        selectedCandidate: { id: "candidate-a", body: "A translated line.", valid: true },
        resultRevisionId: "run-result:terminal-finalizer-run:unit-a",
      },
      {
        unitId: "unit-b",
        outcomeId: "outcome-b",
        selectedCandidate: { id: "candidate-b", body: "Another translated line.", valid: true },
        resultRevisionId: "run-result:terminal-finalizer-run:unit-b",
      },
    ],
    attempts: [{ attemptId: "attempt-a", lifecycle: "completed" }],
    reservations: [{ reservationId: "reservation-a", state: "reconciled" }],
    patch: null,
    stages: [],
    quality: { findingCount: 0, contestedFindingCount: 0 },
  };
}

function successfulWorkers() {
  return {
    patch_build: () => ({
      artifactHashes: { "patch-export": "sha256:terminal-finalizer-test" },
      artifactRefs: { "patch-export": "patch-export-bundle.json" },
      evidence: { patchExport: "written" },
    }),
    patch_apply: () => ({ evidence: { patchApply: "written" } }),
  };
}

function patchAfterStage(
  patch: TerminalPatchVersion | null,
  stage: TerminalFinalizerStage,
  status: TerminalStageStatus,
): TerminalPatchVersion | null {
  if (patch === null || status !== "succeeded") return patch;
  if (stage === "patch_build") return { ...patch, buildSucceeded: true };
  if (stage === "patch_apply") return { ...patch, applySucceeded: true };
  if (stage === "validation") return { ...patch, validationSucceeded: true };
  return patch;
}

function summaryStageFor(stage: TerminalFinalizerStage): TerminalRunSummaryStage {
  return stage === "patch_build" || stage === "patch_apply" ? "patch" : stage;
}
