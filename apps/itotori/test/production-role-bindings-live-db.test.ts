import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWorkflowPorts } from "../src/composition/index.js";
import { runLocalizeCommand } from "../src/cli/localize-command.js";
import { withDatabaseItotoriServices } from "../src/services/database-services.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import {
  commandArgs,
  commandDeps,
  contestedVerdicts,
  launchEnvironment,
  seedStyleBible,
} from "./production-role-bindings-live-db.support.js";
import { deterministicProvider } from "./production-role-bindings-provider.support.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const previousEnvironment = new Map<string, string | undefined>();

postgresDescribe("production role bindings over live Postgres", () => {
  beforeAll(() => {
    for (const [key, value] of Object.entries(launchEnvironment)) {
      previousEnvironment.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  afterAll(() => {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("completes a PURE_MTL production composition run without model QA", async () => {
    const context = await isolatedMigratedContext();
    try {
      const transport = deterministicProvider({ reviewMode: "pass" });
      await withDatabaseItotoriServices(
        { databaseUrl: context.databaseUrl, providerFetcher: transport.fetcher },
        async (services) => {
          const outputs = new Map<string, unknown>();
          await runLocalizeCommand(
            commandArgs("role-binding-pure", "role-binding-pure-run", "pure-en-US", true),
            commandDeps(services, outputs),
          );

          const live = await services.projectWorkflow.loadLiveReadModel(
            "role-binding-pure",
            "role-binding-pure-run",
          );
          expect(outputs.get("summary.json")).toMatchObject({
            runId: "role-binding-pure-run",
            runStatus: "completed",
            buildLqaVerdictCount: 0,
          });
          expect(live?.run.status).toBe("completed");
          expect(live?.progress.statusCounts.patched).toBe(2);
          expect(transport.count("P1")).toBeGreaterThan(0);
          expect(transport.count("Q1")).toBe(0);
          expect(transport.count("Q3")).toBe(0);
        },
      );
    } finally {
      await context.close();
    }
  }, 120_000);

  it("exercises real qualifying review and adjudication bindings before the known Q5 adapter gap", async () => {
    const context = await isolatedMigratedContext();
    let sourceInstalled = false;
    try {
      const qualifyingTransport = deterministicProvider({
        reviewMode: "pass",
        localizationSnapshotId: undefined,
        bibleRenderingId: undefined,
      });
      await withDatabaseItotoriServices(
        { databaseUrl: context.databaseUrl, providerFetcher: qualifyingTransport.fetcher },
        async (services) => {
          const seeded = await seedStyleBible({
            services,
            context,
            projectId: "role-binding-qualifying",
            runId: "role-binding-qualifying-run",
            localeBranchId: "qualifying-en-US",
            sourceInstalled,
          });
          sourceInstalled = true;
          qualifyingTransport.setLocalizationSnapshotId(seeded.localizationSnapshotId);
          qualifyingTransport.setBibleRenderingId(seeded.bibleRenderingId);
          qualifyingTransport.setVoiceRenderingId(seeded.voiceRenderingId);

          const unitId = seeded.deps.readiness.snapshot.orderedUnits[0]?.factId;
          if (unitId === undefined) throw new Error("role-binding proof fixture has no unit");
          const adjudicate = createWorkflowPorts(seeded.deps).adjudicate;
          const contest = {
            unitId,
            defects: [],
            contested: contestedVerdicts(
              unitId,
              seeded.localizationSnapshotId,
              seeded.bibleRenderingId,
            ),
          };
          const q6Input = seeded.deps.adjudicate.buildInput(contest);
          const resolvedEvidence = q6Input.positions.flatMap((position) => position.evidence);
          expect(resolvedEvidence).toHaveLength(2);
          expect(resolvedEvidence.every((evidence) => evidence.text.length > 0)).toBe(true);
          const q6 = await adjudicate.adjudicate(contest);
          expect(q6).toEqual({ disposition: "finalize" });
          expect(qualifyingTransport.count("Q6")).toBe(2);
          expect(qualifyingTransport.promptsFor("Q6").join("\n")).toContain(
            "Deterministic global style guidance",
          );
          await expect(
            adjudicate.adjudicate({
              ...contest,
            }),
          ).resolves.toEqual({ disposition: "finalize" });
          expect(qualifyingTransport.count("Q6")).toBe(2);
          await expect(
            adjudicate.adjudicate({
              ...contest,
              contested: contestedVerdicts(
                unitId,
                seeded.localizationSnapshotId,
                seeded.bibleRenderingId,
                "Preserve the revised grounded sense.",
              ),
            }),
          ).resolves.toEqual({ disposition: "finalize" });
          expect(qualifyingTransport.count("Q6")).toBe(4);

          await expect(
            runLocalizeCommand(
              commandArgs(
                "role-binding-qualifying",
                "role-binding-qualifying-run",
                "qualifying-en-US",
                false,
              ),
              commandDeps(services, new Map()),
            ),
          ).rejects.toThrow("Build-LQA requires a patched-byte render/OCR adapter");

          const live = await services.projectWorkflow.loadLiveReadModel(
            "role-binding-qualifying",
            "role-binding-qualifying-run",
          );
          expect(live?.run.status).toBe("failed");
          expect(live?.progress.statusCounts.patched).toBe(2);
          expect(qualifyingTransport.count("Q1")).toBeGreaterThan(0);
          expect(qualifyingTransport.count("Q2")).toBeGreaterThan(0);
          expect(qualifyingTransport.count("Q3")).toBeGreaterThan(0);
          expect(qualifyingTransport.count("Q4")).toBeGreaterThan(0);
          expect(qualifyingTransport.responsesFor("Q1")).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                roleId: "Q1",
                verdict: "PASS",
                evidenceIds: [seeded.bibleRenderingId],
              }),
            ]),
          );
          expect(qualifyingTransport.responsesFor("Q3")).toEqual(
            expect.arrayContaining([expect.objectContaining({ roleId: "Q3", verdict: "PASS" })]),
          );
          expect(qualifyingTransport.responsesFor("Q2")).toEqual(
            expect.arrayContaining([expect.objectContaining({ roleId: "Q2", verdict: "PASS" })]),
          );
          expect(qualifyingTransport.responsesFor("Q4")).toEqual(
            expect.arrayContaining([expect.objectContaining({ roleId: "Q4", verdict: "PASS" })]),
          );
        },
      );

      const failingTransport = deterministicProvider({
        reviewMode: "cannot-assess",
        localizationSnapshotId: undefined,
        bibleRenderingId: undefined,
      });
      await withDatabaseItotoriServices(
        { databaseUrl: context.databaseUrl, providerFetcher: failingTransport.fetcher },
        async (services) => {
          const seeded = await seedStyleBible({
            services,
            context,
            projectId: "role-binding-review-failure",
            runId: "role-binding-review-failure-run",
            localeBranchId: "review-failure-en-US",
            sourceInstalled,
          });
          failingTransport.setLocalizationSnapshotId(seeded.localizationSnapshotId);
          failingTransport.setBibleRenderingId(seeded.bibleRenderingId);
          failingTransport.setVoiceRenderingId(seeded.voiceRenderingId);

          await expect(
            runLocalizeCommand(
              commandArgs(
                "role-binding-review-failure",
                "role-binding-review-failure-run",
                "review-failure-en-US",
                false,
              ),
              commandDeps(services, new Map()),
            ),
          ).rejects.toThrow("Q1 cannot assess");

          const live = await services.projectWorkflow.loadLiveReadModel(
            "role-binding-review-failure",
            "role-binding-review-failure-run",
          );
          expect(live?.run.status).toBe("failed");
          expect(live?.progress.statusCounts.QA).toBeGreaterThan(0);
          expect(live?.progress.statusCounts.accepted ?? 0).toBe(0);
          expect(failingTransport.count("Q1")).toBeGreaterThan(0);
          expect(failingTransport.responsesFor("Q1")).toEqual(
            expect.arrayContaining([expect.objectContaining({ verdict: "CANNOT_ASSESS" })]),
          );
        },
      );
    } finally {
      await context.close();
    }
  }, 120_000);
});
