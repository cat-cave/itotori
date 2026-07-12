import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthorizationActor } from "@itotori/db";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";
import type { OperationalBlocker } from "../src/orchestrator/invocation-supervisor.js";
import { runLocalizeFullProjectCommand } from "../src/orchestrator/localize-fullproject-command.js";
import type {
  DrivenJournalRunPlan,
  DrivenUnitJournalSink,
} from "../src/orchestrator/project-driven-executor.js";
import { FakeModelProvider } from "../src/providers/fake.js";

const ACTOR: AuthorizationActor = { userId: "localize-resume-plumbing-test" };

describe("localize resume operator plumbing", () => {
  it("forwards the durable run id and writes the exact paused blocker to run-summary.json", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "itotori-resume-plumbing-"));
    const bridgePath = join(workDir, "bridge.json");
    const pairPolicyPath = join(workDir, "pair-policy.json");
    const configPath = join(workDir, "localize.config.json");
    const runSummaryPath = join(workDir, "run-summary.json");
    const resumeRunId = "localization-journal-run-resume-operator-test";
    const bridge = JSON.parse(
      readFileSync(new URL("./fixtures/whole-seen-bridge.json", import.meta.url), "utf8"),
    ) as BridgeBundleV02;
    writeFileSync(bridgePath, JSON.stringify(bridge));
    writeFileSync(
      pairPolicyPath,
      readFileSync(
        new URL("./fixtures/agentic-loop-smoke-pair-policy.json", import.meta.url),
        "utf8",
      ),
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: "itotori.localize-fullproject.config.v0",
        projectId: "resume-plumbing-project",
        localeBranchId: "resume-plumbing-branch",
        sourceRevisionId: "resume-plumbing-revision",
        engineProfile: "reallive",
        translationScope: "dialogue-only",
        targetLocale: "en-US",
        bridgePath,
        pairPolicyPath,
        maxUnits: 1,
      }),
    );

    let plannedRun: DrivenJournalRunPlan | undefined;
    let persistedBlocker: OperationalBlocker | undefined;
    let patchExports = 0;
    const journal = {
      loadResumeState: async () => ({
        status: "running" as const,
        pausedBlocker: null,
        writtenOutcomes: [],
        attempts: [],
      }),
      resumeJournalRun: async () => {},
      beginJournalRun: async (plan) => {
        plannedRun = plan;
      },
      pauseRun: async (_runId, blocker) => {
        persistedBlocker = blocker;
      },
      persistUnitJournal: async () => {},
      persistFailedUnitAttempts: async () => {},
    } satisfies DrivenUnitJournalSink;

    const output = await runLocalizeFullProjectCommand({
      configPath,
      runSummaryPath,
      resumeRunId,
      deps: {
        io: {
          readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
          writeJson: (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`),
        },
        actor: ACTOR,
        providerFactory: () =>
          new FakeModelProvider({
            providerName: "resume-plumbing-outage",
            generate: () => {
              throw Object.assign(new Error("provider route unavailable"), { status: 503 });
            },
          }),
        sinks: {
          journal,
          patchExport: {
            exportPatch: async () => {
              patchExports += 1;
            },
          },
        },
      },
    });

    const summary = JSON.parse(readFileSync(runSummaryPath, "utf8")) as {
      journalRunId: string;
      runState: string;
      pausedBlocker: OperationalBlocker | null;
    };
    expect(plannedRun?.run.runId).toBe(resumeRunId);
    expect(output.result.journalRunId).toBe(resumeRunId);
    expect(output.result.runState).toBe("paused");
    expect(output.result.pausedBlocker).toEqual(persistedBlocker);
    expect(summary).toMatchObject({
      journalRunId: resumeRunId,
      runState: "paused",
    });
    expect(summary.pausedBlocker).toEqual(output.result.pausedBlocker);
    expect(summary.pausedBlocker).toMatchObject({ kind: "provider_outage" });
    expect(patchExports).toBe(0);
  });
});
