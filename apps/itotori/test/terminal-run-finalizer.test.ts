// p0-core-terminal-run-finalizer — all-path terminal-state contract.
//
// The fixture deliberately models durable rows, including the PatchVersion
// state mutations performed by the production persistence adapter.  That keeps
// this suite focused on the transport-free terminalizer's coverage predicate
// and all-path summary behavior.

import { describe, expect, it } from "vitest";
import {
  TERMINAL_RUN_SUMMARY_SCHEMA_VERSION,
  TerminalRunOperationalBlockerError,
  finalizeTerminalRun,
  terminalFinalizerStageValues,
  type TerminalFinalizerStage,
  type TerminalPatchVersion,
  type TerminalRunFinalizerPersistencePort,
  type TerminalRunSnapshot,
  type TerminalRunSummary,
  type TerminalStageStatus,
} from "../src/orchestrator/terminal-run-finalizer.js";

const RUN_ID = "terminal-finalizer-run";
const FIXED_NOW = () => new Date("2026-07-12T12:00:00.000Z");

class InMemoryTerminalPersistence implements TerminalRunFinalizerPersistencePort {
  readonly commits: Array<{
    terminalStatus: TerminalRunSummary["terminalStatus"];
    summary: TerminalRunSummary;
  }> = [];
  readonly recordedStages: TerminalRunSnapshot["stages"] = [];
  readonly ensuredPatchInputs: Array<{
    frozenUnitIds: string[];
    artifactHashes: Record<string, string>;
    artifactRefs: Record<string, string>;
  }> = [];

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
    const record = {
      stage: input.stage,
      status: input.status,
      evidence: input.evidence ?? null,
      error: input.error ?? null,
    } as const;
    this.recordedStages.push(record);
    this.snapshot = {
      ...this.snapshot,
      stages: [...this.snapshot.stages.filter((stage) => stage.stage !== input.stage), record],
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
    return summary;
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
      workers: successfulWorkers(),
      now: FIXED_NOW,
    });

    let patchCalls = 0;
    let summaryCalls = 0;
    const replay = await finalizeTerminalRun({
      runId: RUN_ID,
      persistence,
      workers: {
        patch: () => {
          patchCalls += 1;
          throw new Error("terminal patch must not replay");
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
        patch: () => new Error("patch artifact write failed"),
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
    patch: () => ({
      artifactHashes: { "patch-export": "sha256:terminal-finalizer-test" },
      artifactRefs: { "patch-export": "patch-export-bundle.json" },
      evidence: { patchExport: "written" },
    }),
  };
}

function patchAfterStage(
  patch: TerminalPatchVersion | null,
  stage: TerminalFinalizerStage,
  status: TerminalStageStatus,
): TerminalPatchVersion | null {
  if (patch === null || status !== "succeeded") return patch;
  if (stage === "patch") return { ...patch, buildSucceeded: true, applySucceeded: true };
  if (stage === "validation") return { ...patch, validationSucceeded: true };
  return patch;
}
