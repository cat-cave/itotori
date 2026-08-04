import { describe, expect, it, vi } from "vitest";

import { type LocalizeCommandDeps } from "../src/cli/localize-command.js";
import { runLocalizePortfolioCommand } from "../src/cli/localize-portfolio-command.js";
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

describe("localize portfolio provider-budget cohort lifecycle", () => {
  it("releases a completed member before a sibling finishes", async () => {
    const siblingGate = deferred();
    const firstState = recordedRunState();
    const siblingState = recordedRunState(undefined, undefined, undefined, siblingGate);
    const firstReleased = deferred();
    const releasedRunIds: string[] = [];
    const release = vi.fn(
      async (
        _cohort: LocalizationProviderBudgetCohort,
        member: LocalizationProviderBudgetCohortMember,
      ) => {
        releasedRunIds.push(member.runId);
        if (member.runId === "portfolio-run-first") firstReleased.resolve();
      },
    );
    const providerBudgetCohorts: LocalizationProviderBudgetCohorts = {
      activate: vi.fn(),
      release,
    };
    const portfolio = {
      maxConcurrency: 2,
      runs: [
        runSpec("portfolio-project-first", "portfolio-run-first"),
        runSpec("portfolio-project-sibling", "portfolio-run-sibling"),
      ],
    };

    const result = runLocalizePortfolioCommand(
      ["localize-portfolio", "--portfolio", "portfolio.json"],
      {
        io: {
          readJson: (path) =>
            path === "portfolio.json" ? portfolio : path === "bridge.json" ? bridge : structure,
          writeJson: () => undefined,
        },
        projectWorkflow: portfolioWorkflow(),
        providerBudgetCohorts,
        log: () => undefined,
        resolvePortSource: (_request, perRun) => {
          if (perRun.projectRun === undefined) throw new Error("portfolio run identity is missing");
          const state =
            perRun.projectRun.runId === "portfolio-run-first" ? firstState : siblingState;
          return {
            ports: recordedPorts(state),
            runPlane: {
              ...perRun.projectRun,
              contextSnapshotId: "portfolio-context",
              localizationSnapshotId: "portfolio-localization",
              capMicrosUsd: 100,
            },
          };
        },
      },
    );

    await siblingState.draftProgressEntered;
    await firstReleased.promise;
    expect(releasedRunIds).toEqual(["portfolio-run-first"]);
    expect(release).toHaveBeenCalledTimes(1);

    siblingGate.resolve();
    await expect(result).resolves.toMatchObject({ completedCount: 2, failedCount: 0 });
    expect(releasedRunIds.sort()).toEqual(["portfolio-run-first", "portfolio-run-sibling"]);
    expect(release).toHaveBeenCalledTimes(2);
  });
});

function runSpec(projectId: string, runId: string) {
  return {
    structure: "structure.json",
    bridge: "bridge.json",
    projectId,
    runId,
    localeBranchId: `${runId}-branch`,
    targetLocale: "en-US",
    sourceRoot: "/fixture/portfolio/source",
    buildRoot: "/fixture/portfolio/build",
    runMode: "production",
    costCapMicrosUsd: 100,
  };
}

function portfolioWorkflow(): LocalizeCommandDeps["projectWorkflow"] {
  const leaseExpiresAt = new Date("2026-08-03T00:01:30.000Z");
  return {
    ensureRunProjectScope: vi.fn(),
    createOrResumeRun: vi.fn(),
    acquireLease: vi.fn(
      async (input: { projectId: string; runId: string; leaseOwnerId: string }) => ({
        ...input,
        fenceToken: 1,
        leaseExpiresAt,
      }),
    ),
    renewLease: vi.fn(
      async (input: {
        lease: { projectId: string; runId: string; leaseOwnerId: string; fenceToken: number };
      }) => ({ ...input.lease, leaseExpiresAt }),
    ),
    releaseLease: vi.fn(),
    advanceRun: vi.fn(),
    recordProgress: vi.fn(),
    reserveCost: vi.fn(),
    settleCost: vi.fn(),
    releaseCost: vi.fn(),
    loadLiveReadModel: vi.fn(async () => ({
      run: { status: "completed" },
      progress: {
        statusCounts: { decoded: 0, drafted: 0, QA: 0, accepted: 0, patched: 1 },
        totalCostMicrosUsd: 0,
        averageCoveragePercent: 100,
        blockers: [],
        units: [],
      },
    })),
  };
}
