import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalizationPassRunConfigRecord } from "@itotori/db";
import {
  createDetachedLocalizationPassRunner,
  driveLocalizationPass,
  parseLaunchConfigDocument,
} from "../src/services/launch-localization-pass.js";
import { parseLaunchPassRequest } from "../src/api-schema.js";
import { ItotoriProjectWorkflowService } from "../src/services/project-workflow-service.js";
import {
  bridge,
  recordedPorts,
  recordedRunState,
  structure,
  type RecordedRunState,
} from "./recorded-localize-run.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("launch localization pass", () => {
  it("refuses when no pass run configuration is saved", async () => {
    const service = workflowService({
      resolveRunConfig: async () => null,
      start: async () => {
        throw new Error("pass runner must not run without a config");
      },
    });

    await expect(
      service.launchNextLocalizationPass({
        projectId: "project-launch",
        localeBranchId: "branch-launch",
      }),
    ).resolves.toEqual({
      outcome: "refused",
      refusalMessage:
        "no pass run configuration is saved for project project-launch and locale branch branch-launch",
    });
  });

  it("returns started with a non-null journalRunId when a config resolves", async () => {
    const startedAt = new Date("2026-07-26T12:00:00.000Z");
    const service = workflowService({
      resolveRunConfig: async () => runConfigRecord(),
      start: async () => ({ journalRunId: "launch-pass-journal-1", startedAt }),
    });

    await expect(
      service.launchNextLocalizationPass({
        projectId: "project-launch",
        localeBranchId: "branch-launch",
      }),
    ).resolves.toEqual({
      outcome: "started",
      journalRunId: "launch-pass-journal-1",
      startedAt,
    });
  });

  it("refuses the second concurrent launch for the same branch", async () => {
    const firstStart = deferred();
    let active = false;
    const service = workflowService({
      resolveRunConfig: async () => runConfigRecord(),
      start: async () => {
        if (active) {
          throw new Error("active run", {
            cause: { constraint: "itotori_project_runs_one_active_branch_idx" },
          });
        }
        active = true;
        await firstStart.promise;
        return { journalRunId: "launch-pass-journal-1", startedAt: new Date() };
      },
    });

    const first = service.launchNextLocalizationPass({
      projectId: "project-launch",
      localeBranchId: "branch-launch",
    });
    await vi.waitFor(() => expect(active).toBe(true));
    const second = service.launchNextLocalizationPass({
      projectId: "project-launch",
      localeBranchId: "branch-launch",
    });

    await expect(second).resolves.toEqual({
      outcome: "refused",
      refusalMessage: "a localization pass is already active for project-launch/branch-launch",
    });
    firstStart.resolve();
    await expect(first).resolves.toMatchObject({ outcome: "started" });
  });

  it("parses operator-local launch config paths relative to the config file", () => {
    const parsed = parseLaunchConfigDocument("/operator/runs/project.localize.json", {
      structurePath: "./structure.json",
      bridgePath: "./bridge.json",
      runMode: "pilot",
      outputScope: "dialogue-and-choices",
    });
    expect(parsed).toEqual({
      structurePath: "/operator/runs/structure.json",
      bridgePath: "/operator/runs/bridge.json",
      runMode: "pilot",
      contextScope: "whole-game",
      outputScope: "dialogue-and-choices",
    });
  });

  it("rejects the retired cancellation fields instead of launching another run", () => {
    expect(() =>
      parseLaunchPassRequest({
        localeBranchId: "branch-launch",
        cancelled: true,
        resumeRunId: "run-to-cancel",
      }),
    ).toThrow(/cancelled is not part of the public API response/);
  });

  it("admits a durable journal run id before the pass finishes", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "itotori-launch-pass-"));
    tempDirs.push(workDir);
    const structurePath = join(workDir, "structure.json");
    const bridgePath = join(workDir, "bridge.json");
    const configPath = join(workDir, "launch.config.json");
    const runDir = join(workDir, "run");
    writeFileSync(structurePath, JSON.stringify(structure));
    writeFileSync(bridgePath, JSON.stringify(bridge));
    writeFileSync(
      configPath,
      JSON.stringify({ structurePath: "structure.json", bridgePath: "bridge.json" }),
    );

    const reviewGate = deferred();
    const state = recordedRunState(reviewGate);
    const workflow = memoryProjectWorkflow();
    const files = new Map<string, unknown>();
    const readJson = (path: string): unknown => {
      if (path === structurePath) return structure;
      if (path === bridgePath) return bridge;
      if (path === configPath) {
        return { structurePath: "structure.json", bridgePath: "bridge.json" };
      }
      throw new Error(`unexpected read: ${path}`);
    };

    let admittedAt = 0;
    let completedAt = 0;
    const drive = driveLocalizationPass(
      {
        projectId: "project-launch",
        localeBranchId: "branch-launch",
        config: runConfigRecord({ configPath, runDir }),
      },
      {
        readJson,
        writeJson: (path, value) => {
          files.set(path, value);
        },
        projectWorkflow: workflow,
        createRunId: () => "launch-pass-fixed-id",
        now: () => new Date("2026-07-26T15:00:00.000Z"),
        resolvePortSource: (_request, perRun) => recordedSource(state, perRun),
      },
      {
        onAdmitted: () => {
          admittedAt = Date.now();
        },
      },
    );

    await state.reviewEntered;
    expect(admittedAt).toBeGreaterThan(0);
    expect(workflow.runs.has("launch-pass-fixed-id")).toBe(true);
    expect(workflow.runs.get("launch-pass-fixed-id")?.status).toBe("running");

    reviewGate.resolve();
    await drive;
    completedAt = Date.now();
    expect(completedAt).toBeGreaterThanOrEqual(admittedAt);
    expect(workflow.runs.get("launch-pass-fixed-id")?.status).toBe("completed");
    expect(files.get(join(runDir, "launch-pass-fixed-id.summary.json"))).toMatchObject({
      runId: "launch-pass-fixed-id",
      projectId: "project-launch",
      patchId: "patch:recorded",
    });
    expect([...workflow.progress.values()]).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "patched", costMicrosUsd: 7 })]),
    );
  });

  it("detached runner returns started before the long pass resolves", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "itotori-launch-pass-detached-"));
    tempDirs.push(workDir);
    const structurePath = join(workDir, "structure.json");
    const bridgePath = join(workDir, "bridge.json");
    const configPath = join(workDir, "launch.config.json");
    writeFileSync(structurePath, JSON.stringify(structure));
    writeFileSync(bridgePath, JSON.stringify(bridge));
    writeFileSync(
      configPath,
      JSON.stringify({ structurePath: "structure.json", bridgePath: "bridge.json" }),
    );

    const reviewGate = deferred();
    const state = recordedRunState(reviewGate);
    const workflow = memoryProjectWorkflow();
    let sessionDone = false;

    const runner = createDetachedLocalizationPassRunner({
      createRunId: () => "detached-run-1",
      now: () => new Date("2026-07-26T16:00:00.000Z"),
      openSession: async (run) => {
        try {
          await run({
            readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
            writeJson: () => undefined,
            projectWorkflow: workflow,
            resolvePortSource: (_request, perRun) => recordedSource(state, perRun),
          });
        } finally {
          sessionDone = true;
        }
      },
    });

    const started = await runner.start({
      projectId: "project-launch",
      localeBranchId: "branch-launch",
      config: runConfigRecord({ configPath, runDir: workDir }),
    });
    expect(started).toEqual({
      journalRunId: "detached-run-1",
      startedAt: new Date("2026-07-26T16:00:00.000Z"),
    });
    expect(sessionDone).toBe(false);

    reviewGate.resolve();
    await vi.waitFor(() => {
      expect(sessionDone).toBe(true);
    });
    expect(workflow.runs.get("detached-run-1")?.status).toBe("completed");
  });

  it("marks an admitted run failed and saves its exception after a detached pass fails", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "itotori-launch-pass-failure-"));
    tempDirs.push(workDir);
    for (const [name, value] of Object.entries({
      "structure.json": structure,
      "bridge.json": bridge,
      "launch.config.json": { structurePath: "structure.json", bridgePath: "bridge.json" },
    })) {
      writeFileSync(join(workDir, name), JSON.stringify(value));
    }
    const state = recordedRunState();
    state.failOnDraft = new Error("draft provider disconnected");
    const workflow = memoryProjectWorkflow();
    const files = new Map<string, unknown>();
    const runner = createDetachedLocalizationPassRunner({
      createRunId: () => "detached-failed-run",
      openSession: async (run) =>
        await run({
          readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
          writeJson: (path, value) => files.set(path, value),
          projectWorkflow: workflow,
          resolvePortSource: (_request, perRun) => recordedSource(state, perRun),
        }),
    });

    await expect(
      runner.start({
        projectId: "project-launch",
        localeBranchId: "branch-launch",
        config: runConfigRecord({
          configPath: join(workDir, "launch.config.json"),
          runDir: workDir,
        }),
      }),
    ).resolves.toMatchObject({ journalRunId: "detached-failed-run" });
    await vi.waitFor(() => expect(workflow.runs.get("detached-failed-run")?.status).toBe("failed"));
    expect(files.get(join(workDir, "detached-failed-run.failure.json"))).toMatchObject({
      runId: "detached-failed-run",
      failure: { message: "draft provider disconnected" },
    });
  });
});

function workflowService(input: {
  resolveRunConfig: (
    projectId: string,
    localeBranchId: string,
  ) => Promise<LocalizationPassRunConfigRecord | null>;
  start: (args: {
    projectId: string;
    localeBranchId: string;
    config: LocalizationPassRunConfigRecord;
  }) => Promise<{ journalRunId: string; startedAt: Date }>;
}) {
  return new ItotoriProjectWorkflowService({
    actor: { userId: "local-user" },
    projects: {} as never,
    runs: {} as never,
    snapshots: {} as never,
    ledger: {} as never,
    passRunConfig: {
      resolveRunConfig: input.resolveRunConfig,
      saveRunConfig: async () => {
        throw new Error("saveRunConfig is not used by launch tests");
      },
    },
    passRunner: { start: input.start },
    conformance: {} as never,
    defaultTargetLocale: "en-US",
  });
}

function runConfigRecord(
  overrides: Partial<LocalizationPassRunConfigRecord> = {},
): LocalizationPassRunConfigRecord {
  return {
    projectId: "project-launch",
    localeBranchId: "branch-launch",
    configPath: "/operator/runs/project.localize.json",
    dataRoot: "/operator/game",
    pairPolicyPath: "/operator/policies/pair-policy.json",
    modelId: "model",
    providerId: "provider",
    runDir: "/operator/runs/project-pass",
    updatedAt: new Date("2026-07-26T00:00:00.000Z"),
    ...overrides,
  };
}

function recordedSource(
  state: RecordedRunState,
  perRun: {
    projectRun?: { projectId: string; runId: string; localeBranchId: string; leaseOwnerId: string };
  },
) {
  if (perRun.projectRun === undefined) throw new Error("project run identity is required");
  return {
    ports: recordedPorts(state),
    attachRunCostObserver: (observer: Parameters<typeof recordedPorts>[1]) =>
      recordedPorts(state, observer),
    runPlane: {
      ...perRun.projectRun,
      contextSnapshotId: "context-snapshot",
      localizationSnapshotId: "localization-snapshot",
      capMicrosUsd: 100,
    },
  };
}

function memoryProjectWorkflow() {
  type RunRow = {
    status: "queued" | "running" | "completed" | "failed";
    leaseOwnerId: string | null;
    fenceToken: number;
  };
  const runs = new Map<string, RunRow>();
  const progress = new Map<string, { status: string; costMicrosUsd: number }>();
  return {
    runs,
    progress,
    async createOrResumeRun(input: {
      projectId: string;
      runId: string;
      localeBranchId: string;
      contextSnapshotId: string;
      localizationSnapshotId: string;
      capMicrosUsd: number | null;
    }) {
      runs.set(input.runId, { status: "queued", leaseOwnerId: null, fenceToken: 0 });
      return {
        projectId: input.projectId,
        runId: input.runId,
        localeBranchId: input.localeBranchId,
        contextSnapshotId: input.contextSnapshotId,
        localizationSnapshotId: input.localizationSnapshotId,
        status: "queued" as const,
        leaseOwnerId: null,
        leaseExpiresAt: null,
        fenceToken: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        cost: { capMicrosUsd: input.capMicrosUsd, spentMicrosUsd: 0, reservedMicrosUsd: 0 },
      };
    },
    async acquireLease(input: {
      projectId: string;
      runId: string;
      leaseOwnerId: string;
      leaseDurationSeconds: number;
    }) {
      const run = runs.get(input.runId);
      if (run === undefined) throw new Error("unknown run");
      run.leaseOwnerId = input.leaseOwnerId;
      run.fenceToken += 1;
      return {
        projectId: input.projectId,
        runId: input.runId,
        leaseOwnerId: input.leaseOwnerId,
        fenceToken: run.fenceToken,
        leaseExpiresAt: new Date(Date.now() + input.leaseDurationSeconds * 1000),
      };
    },
    async renewLease(input: {
      lease: { projectId: string; runId: string; leaseOwnerId: string; fenceToken: number };
      leaseDurationSeconds: number;
    }) {
      return {
        ...input.lease,
        leaseExpiresAt: new Date(Date.now() + input.leaseDurationSeconds * 1000),
      };
    },
    async releaseLease(lease: {
      projectId: string;
      runId: string;
      leaseOwnerId: string;
      fenceToken: number;
    }) {
      const run = runs.get(lease.runId);
      if (run !== undefined) run.leaseOwnerId = null;
    },
    async advanceRun(input: {
      lease: { runId: string };
      status: "queued" | "running" | "completed" | "failed";
    }) {
      const run = runs.get(input.lease.runId);
      if (run === undefined) throw new Error("unknown run");
      run.status = input.status;
      return { runId: input.lease.runId, status: input.status } as never;
    },
    async recordProgress(input: {
      lease: { runId: string };
      bridgeUnitId: string;
      status: string;
      costMicrosUsd: number;
    }) {
      progress.set(`${input.lease.runId}:${input.bridgeUnitId}`, {
        status: input.status,
        costMicrosUsd: input.costMicrosUsd,
      });
      return undefined as never;
    },
    async reserveCost() {
      return undefined as never;
    },
    async settleCost() {
      return undefined as never;
    },
    async releaseCost(input: { reservationId: string }) {
      return {
        reservationId: input.reservationId,
        reservedMicrosUsd: 0,
        settledMicrosUsd: null,
        state: "released" as const,
        createdAt: new Date(),
        settledAt: null,
        releasedAt: new Date(),
      };
    },
    async loadLiveReadModel(projectId: string, runId: string) {
      const run = runs.get(runId);
      if (run === undefined) return null;
      return {
        run: {
          projectId,
          runId,
          status: run.status,
        },
        progress: { statusCounts: {}, totalCostMicrosUsd: 0, units: [] },
      } as never;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
