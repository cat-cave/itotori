import { describe, expect, it, vi } from "vitest";
import type { LocalizationPassRunConfigRecord } from "@itotori/db";

import { driveLocalizationPass } from "../src/services/launch-localization-pass.js";
import { LocalizationPassPausedError } from "../src/services/localization-pass-control.js";
import type {
  LocalizationProviderBudgetCohort,
  LocalizationProviderBudgetCohortMember,
  LocalizationProviderBudgetCohorts,
} from "../src/composition/provider-budget-cohort.js";
import {
  bridge,
  deferred,
  recordedPorts,
  recordedRunState,
  structure,
} from "./recorded-localize-run.js";

describe("launch localization pass provider-budget cohort", () => {
  it("releases its singleton member after an admitted pass is paused", async () => {
    const reviewGate = deferred();
    const state = recordedRunState(reviewGate);
    const controller = new AbortController();
    const events: string[] = [];
    const activate = vi.fn(async (cohort: LocalizationProviderBudgetCohort) => {
      events.push(`activate:${cohort.members[0]?.runId}`);
    });
    const release = vi.fn(
      async (
        _cohort: LocalizationProviderBudgetCohort,
        member: LocalizationProviderBudgetCohortMember,
      ) => {
        events.push(`release:${member.runId}`);
      },
    );
    const providerBudgetCohorts: LocalizationProviderBudgetCohorts = { activate, release };
    let sourceCohort: LocalizationProviderBudgetCohort | undefined;
    const paused = vi.fn(() => events.push("paused"));
    const configPath = "/fixture/pass-budget/launch.json";
    const structurePath = "/fixture/pass-budget/structure.json";
    const bridgePath = "/fixture/pass-budget/bridge.json";

    const pass = driveLocalizationPass(
      {
        projectId: "pass-budget-project",
        localeBranchId: "pass-budget-branch",
        config: runConfig(configPath),
        abortSignal: controller.signal,
      },
      {
        readJson: launchReadJson(configPath, structurePath, bridgePath),
        writeJson: () => undefined,
        createRunId: () => "pass-budget-run",
        providerBudgetCohorts,
        projectWorkflow: pauseWorkflow(),
        resolvePortSource: (_request, perRun) => {
          if (perRun.projectRun === undefined) throw new Error("pass run identity is missing");
          sourceCohort = perRun.admissionCohort;
          events.push("source");
          return {
            ports: recordedPorts(state),
            runPlane: {
              ...perRun.projectRun,
              contextSnapshotId: "pass-budget-context",
              localizationSnapshotId: "pass-budget-localization",
              capMicrosUsd: 100,
            },
          };
        },
      },
      { onPaused: paused },
    );

    await state.reviewEntered;
    controller.abort(new LocalizationPassPausedError("pass-budget-run"));
    reviewGate.resolve();
    await pass;

    expect(sourceCohort).toBe(activate.mock.calls[0]?.[0]);
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        members: [{ projectId: "pass-budget-project", runId: "pass-budget-run" }],
      }),
    );
    expect(release).toHaveBeenCalledWith(activate.mock.calls[0]?.[0], {
      projectId: "pass-budget-project",
      runId: "pass-budget-run",
    });
    expect(events).toEqual([
      "source",
      "activate:pass-budget-run",
      "paused",
      "release:pass-budget-run",
    ]);
  });

  it("preserves a pass failure when singleton cohort release also fails", async () => {
    const workError = new Error("start failed");
    const releaseError = new Error("release failed");
    const messages: string[] = [];
    const workflow = pauseWorkflow();
    const state = recordedRunState();
    state.failOnDraft = workError;
    const configPath = "/fixture/pass-budget/failure-launch.json";
    const structurePath = "/fixture/pass-budget/failure-structure.json";
    const bridgePath = "/fixture/pass-budget/failure-bridge.json";

    await expect(
      driveLocalizationPass(
        {
          projectId: "pass-budget-project",
          localeBranchId: "pass-budget-branch",
          config: runConfig(configPath),
        },
        {
          readJson: launchReadJson(configPath, structurePath, bridgePath),
          writeJson: () => undefined,
          createRunId: () => "pass-budget-failure-run",
          projectWorkflow: workflow,
          providerBudgetCohorts: {
            activate: vi.fn(),
            release: vi.fn().mockRejectedValue(releaseError),
          },
          resolvePortSource: (_request, perRun) => {
            if (perRun.projectRun === undefined) throw new Error("pass run identity is missing");
            return {
              ports: recordedPorts(state),
              runPlane: {
                ...perRun.projectRun,
                contextSnapshotId: "pass-budget-context",
                localizationSnapshotId: "pass-budget-localization",
                capMicrosUsd: 100,
              },
            };
          },
          log: (message) => messages.push(message),
        },
      ),
    ).rejects.toBe(workError);

    expect(messages).toEqual([
      "launch localization pass provider budget cohort release failed: release failed",
    ]);
  });
});

function launchReadJson(configPath: string, structurePath: string, bridgePath: string) {
  return (path: string): unknown => {
    if (path === configPath) {
      return {
        structurePath,
        bridgePath,
        runMode: "production",
        contextScope: "whole-game",
        outputScope: "dialogue-only",
      };
    }
    if (path === structurePath) return structure;
    if (path === bridgePath) return bridge;
    throw new Error(`unexpected launch-pass read: ${path}`);
  };
}

function runConfig(configPath: string): LocalizationPassRunConfigRecord {
  return {
    projectId: "pass-budget-project",
    localeBranchId: "pass-budget-branch",
    configPath,
    dataRoot: "/fixture/pass-budget/data",
    pairPolicyPath: "/fixture/pass-budget/policy.json",
    modelId: "fixture-model",
    providerId: "fixture-provider",
    runDir: "/fixture/pass-budget/runs",
    updatedAt: new Date("2026-08-03T00:00:00.000Z"),
  };
}

function pauseWorkflow() {
  return {
    createOrResumeRun: vi.fn(),
    acquireLease: vi.fn(
      async (input: { projectId: string; runId: string; leaseOwnerId: string }) => ({
        ...input,
        fenceToken: 1,
        leaseExpiresAt: new Date("2026-08-03T00:01:30.000Z"),
      }),
    ),
    renewLease: vi.fn(
      async (input: {
        lease: { projectId: string; runId: string; leaseOwnerId: string; fenceToken: number };
      }) => ({
        ...input.lease,
        leaseExpiresAt: new Date("2026-08-03T00:01:30.000Z"),
      }),
    ),
    releaseLease: vi.fn(),
    advanceRun: vi.fn(),
    recordProgress: vi.fn(),
    reserveCost: vi.fn(),
    settleCost: vi.fn(),
    releaseCost: vi.fn(),
    loadLiveReadModel: vi.fn(async () => ({ run: { status: "paused" }, progress: {} })),
  };
}
