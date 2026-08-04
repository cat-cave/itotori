import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";

import { createWorkflowPorts } from "../src/composition/index.js";
import { runLocalizeCommand } from "../src/cli/localize-command.js";
import { renderAndOcrPatchedBuild } from "../src/composition/live/render-evidence-adapter.js";
import { renderOcrGate } from "../src/gates/index.js";
import { sha256 } from "../src/llm/canonical-json.js";
import { type AcceptedUnitOutput } from "../src/patchback/index.js";
import { produceNativePatchbackBuild } from "../src/patchback/produce-build.js";
import type { FactSnapshot } from "../src/prepass/index.js";
import { withDatabaseItotoriServices } from "../src/services/database-services.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { requireLivePostgres } from "../../../packages/itotori-db/test/live-postgres-suite.js";
import {
  commandArgs,
  commandDeps,
  launchEnvironment,
  seedStyleBible,
} from "./production-role-bindings-live-db.support.js";
import { contestedVerdicts } from "./production-role-bindings-adjudication.support.js";
import { deterministicProvider } from "./production-role-bindings-provider.support.js";
import {
  CLEAN_Q5_TARGET,
  OCR_FAILURE_Q5_TARGET,
  Q5_BACKGROUND_ASSET,
  stageRealLiveQ5Fixture,
  type RealLiveQ5Fixture,
} from "./production-role-bindings-reallive-fixture.support.js";

const postgresDescribe = requireLivePostgres(describe);
const previousEnvironment = new Map<string, string | undefined>();
let runtimeFixture: RealLiveQ5Fixture | undefined;

postgresDescribe("production Q5 fixture over live Postgres", () => {
  beforeAll(() => {
    for (const [key, value] of Object.entries(launchEnvironment)) {
      previousEnvironment.set(key, process.env[key]);
      process.env[key] = value;
    }
    runtimeFixture = stageRealLiveQ5Fixture();
  }, 120_000);

  afterAll(() => {
    runtimeFixture?.dispose();
    runtimeFixture = undefined;
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
            commandArgs("pure-mtl-project", "pure-mtl-run", "pure-en-US", true),
            commandDeps(services, outputs),
          );

          const live = await services.projectWorkflow.loadLiveReadModel(
            "pure-mtl-project",
            "pure-mtl-run",
          );
          expect(outputs.get("summary.json")).toMatchObject({
            runId: "pure-mtl-run",
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

  it("completes QUALIFYING through Q5 on real patched render/OCR evidence and fails closed", async () => {
    const fixture = requiredRuntimeFixture();
    const context = await isolatedMigratedContext();
    try {
      const qualifyingTransport = deterministicProvider({
        reviewMode: "pass",
        targetSkeleton: CLEAN_Q5_TARGET,
      });
      await withDatabaseItotoriServices(
        { databaseUrl: context.databaseUrl, providerFetcher: qualifyingTransport.fetcher },
        async (services) => {
          const seeded = await seedStyleBible({
            services,
            context,
            projectId: "qualifying-production-project",
            runId: "qualifying-production-run",
            localeBranchId: "qualifying-en-US",
            sourceInstalled: false,
            runtimeFixture: fixture,
            runMode: "production",
          });
          qualifyingTransport.setLocalizationSnapshotId(seeded.localizationSnapshotId);
          qualifyingTransport.setBibleRenderingId(seeded.bibleRenderingId);
          qualifyingTransport.setVoiceRenderingId(seeded.voiceRenderingId);
          const unitId = seeded.deps.readiness.snapshot.orderedUnits[0]?.factId;
          if (unitId === undefined) throw new Error("Q5 fixture has no unit");
          await seeded.activateProviderBudget();
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
          expect(await adjudicate.adjudicate(contest)).toEqual({ disposition: "finalize" });
          expect(qualifyingTransport.count("Q6")).toBe(2);
          expect(qualifyingTransport.promptsFor("Q6").join("\n")).toContain(
            "Deterministic global style guidance",
          );
          await expect(adjudicate.adjudicate({ ...contest })).resolves.toEqual({
            disposition: "finalize",
          });
          expect(qualifyingTransport.count("Q6")).toBe(2);

          const outputs = new Map<string, unknown>();
          await runLocalizeCommand(
            commandArgs(
              "qualifying-production-project",
              "qualifying-production-run",
              "qualifying-en-US",
              false,
              fixture,
              "production",
            ),
            commandDeps(services, outputs, fixture),
          );

          const live = await services.projectWorkflow.loadLiveReadModel(
            "qualifying-production-project",
            "qualifying-production-run",
          );
          expect(outputs.get("summary.json")).toMatchObject({
            runId: "qualifying-production-run",
            runStatus: "completed",
            finalizedUnitCount: 1,
            buildLqaVerdictCount: 1,
            patchId: expect.any(String),
          });
          expect(live?.run.status).toBe("completed");
          expect(live?.progress.statusCounts.patched).toBe(1);
          expect(qualifyingTransport.count("Q1")).toBeGreaterThan(0);
          expect(qualifyingTransport.count("Q2")).toBeGreaterThan(0);
          expect(qualifyingTransport.count("Q3")).toBeGreaterThan(0);
          expect(qualifyingTransport.count("Q4")).toBeGreaterThan(0);
          expect(qualifyingTransport.count("Q5")).toBe(1);
          expect(qualifyingTransport.responsesFor("Q5")).toEqual(
            expect.arrayContaining([expect.objectContaining({ roleId: "Q5", verdict: "PASS" })]),
          );
          expect(qualifyingTransport.responsesFor("Q1")).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                roleId: "Q1",
                verdict: "PASS",
                evidenceIds: [seeded.bibleRenderingId],
              }),
            ]),
          );

          const cleanRender = await renderActualPatchedBuild({
            fixture,
            snapshot: seeded.deps.readiness.snapshot,
            unitId,
            localizationSnapshotId: seeded.localizationSnapshotId,
            bibleRenderingId: seeded.bibleRenderingId,
            actualTargetSkeleton: CLEAN_Q5_TARGET,
            buildLabel: "clean",
          });
          const cleanObservations = cleanRender.frames[0]?.observations ?? [];
          expect(cleanRender.frames).toHaveLength(1);
          expect(cleanRender.frames[0]?.observedUnitIds).toEqual([unitId]);
          expect(cleanObservations).not.toHaveLength(0);
          expect(cleanObservations.every((observation) => observation.status === "PASS")).toBe(
            true,
          );

          const failureRender = await renderActualPatchedBuild({
            fixture,
            snapshot: seeded.deps.readiness.snapshot,
            unitId,
            localizationSnapshotId: seeded.localizationSnapshotId,
            bibleRenderingId: seeded.bibleRenderingId,
            actualTargetSkeleton: OCR_FAILURE_Q5_TARGET,
            buildLabel: "failure-direction",
          });
          expect(failureRender.frames).toHaveLength(1);
          expect(failureRender.frames[0]?.observedUnitIds).toEqual([unitId]);
          const failureObservations = failureRender.frames[0]?.observations ?? [];
          const failures = failureObservations.filter(
            (observation) => observation.status === "FAIL",
          );
          const failedObservationKinds = failures.map((observation) => observation.kind);
          expect(failedObservationKinds).toEqual(
            expect.arrayContaining(["missing-glyph", "charset", "ocr-mismatch"]),
          );
          const defects = renderOcrGate(
            seeded.deps.readiness.snapshot,
            [
              acceptedOutput({
                unitId,
                sourceHash: seeded.deps.readiness.orderedFact(unitId).sourceHash,
                localizationSnapshotId: seeded.localizationSnapshotId,
                bibleRenderingId: seeded.bibleRenderingId,
                targetSkeleton: CLEAN_Q5_TARGET,
                outputId: "accepted:q5-failure-direction:clean",
              }),
            ],
            failureRender,
          );
          expect(defects.some((defect) => defect.category === "ocr")).toBe(true);
          expect(defects.some((defect) => defect.category === "render")).toBe(true);
          console.log(
            JSON.stringify({
              q5ProductionProof: {
                runTransitions: ["queued", "running", "completed"],
                completedRun: outputs.get("summary.json"),
                terminalStatus: live?.run.status,
                qCounts: {
                  Q1: qualifyingTransport.count("Q1"),
                  Q2: qualifyingTransport.count("Q2"),
                  Q3: qualifyingTransport.count("Q3"),
                  Q4: qualifyingTransport.count("Q4"),
                  Q5: qualifyingTransport.count("Q5"),
                },
                cleanRender: {
                  frameCount: cleanRender.frames.length,
                  observedUnitCount: cleanRender.frames[0]?.observedUnitIds.length ?? 0,
                  observationStatusCounts: statusCounts(cleanObservations),
                },
                failureDirection: {
                  frameCount: failureRender.frames.length,
                  observedUnitCount: failureRender.frames[0]?.observedUnitIds.length ?? 0,
                  observationStatusCounts: statusCounts(failureObservations),
                  defectCount: defects.length,
                },
              },
            }),
          );
        },
      );

      const failureContext = await isolatedMigratedContext();
      try {
        const failingRenderTransport = deterministicProvider({
          reviewMode: "pass",
          targetSkeleton: OCR_FAILURE_Q5_TARGET,
        });
        await withDatabaseItotoriServices(
          {
            databaseUrl: failureContext.databaseUrl,
            providerFetcher: failingRenderTransport.fetcher,
          },
          async (services) => {
            const seeded = await seedStyleBible({
              services,
              context: failureContext,
              projectId: "render-failure-project",
              runId: "render-failure-run",
              localeBranchId: "render-failure-en-US",
              sourceInstalled: false,
              runtimeFixture: fixture,
              runMode: "production",
            });
            failingRenderTransport.setLocalizationSnapshotId(seeded.localizationSnapshotId);
            failingRenderTransport.setBibleRenderingId(seeded.bibleRenderingId);
            failingRenderTransport.setVoiceRenderingId(seeded.voiceRenderingId);

            await expect(
              runLocalizeCommand(
                commandArgs(
                  "render-failure-project",
                  "render-failure-run",
                  "render-failure-en-US",
                  false,
                  fixture,
                  "production",
                ),
                commandDeps(services, new Map(), fixture),
              ),
            ).rejects.toThrow("production render evidence refused");

            const live = await services.projectWorkflow.loadLiveReadModel(
              "render-failure-project",
              "render-failure-run",
            );
            expect(live?.run.status).toBe("failed");
            expect(live?.progress.statusCounts.patched).toBe(1);
            expect(failingRenderTransport.count("Q1")).toBeGreaterThan(0);
            expect(failingRenderTransport.count("Q4")).toBeGreaterThan(0);
            expect(failingRenderTransport.count("Q5")).toBe(0);
            console.log(
              JSON.stringify({
                q5FailureDirectionRun: {
                  terminalStatus: live?.run.status,
                  q5ProviderCalls: failingRenderTransport.count("Q5"),
                },
              }),
            );
          },
        );
      } finally {
        await failureContext.close();
      }
    } finally {
      await context.close();
    }
  }, 300_000);

  it("fails a pre-Q5 review with zero accepted units", async () => {
    const fixture = requiredRuntimeFixture();
    const context = await isolatedMigratedContext();
    try {
      const failingTransport = deterministicProvider({ reviewMode: "cannot-assess" });
      await withDatabaseItotoriServices(
        { databaseUrl: context.databaseUrl, providerFetcher: failingTransport.fetcher },
        async (services) => {
          const seeded = await seedStyleBible({
            services,
            context,
            projectId: "review-failure-project",
            runId: "review-failure-run",
            localeBranchId: "review-failure-en-US",
            sourceInstalled: false,
            runtimeFixture: fixture,
          });
          failingTransport.setLocalizationSnapshotId(seeded.localizationSnapshotId);
          failingTransport.setBibleRenderingId(seeded.bibleRenderingId);
          failingTransport.setVoiceRenderingId(seeded.voiceRenderingId);

          await expect(
            runLocalizeCommand(
              commandArgs(
                "review-failure-project",
                "review-failure-run",
                "review-failure-en-US",
                false,
                fixture,
              ),
              commandDeps(services, new Map(), fixture),
            ),
          ).rejects.toThrow("Q1 cannot assess");

          const live = await services.projectWorkflow.loadLiveReadModel(
            "review-failure-project",
            "review-failure-run",
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

function requiredRuntimeFixture(): RealLiveQ5Fixture {
  if (runtimeFixture === undefined) {
    throw new Error("public Q5 runtime fixture was not staged");
  }
  return runtimeFixture;
}

async function renderActualPatchedBuild(input: {
  readonly fixture: RealLiveQ5Fixture;
  readonly snapshot: FactSnapshot;
  readonly unitId: string;
  readonly localizationSnapshotId: string;
  readonly bibleRenderingId: string;
  readonly actualTargetSkeleton: string;
  readonly buildLabel: string;
}) {
  const fact = input.snapshot.orderedUnits.find((candidate) => candidate.factId === input.unitId);
  if (fact === undefined) throw new Error("failure-direction fixture unit is absent from snapshot");
  const expectedAccepted = acceptedOutput({
    unitId: input.unitId,
    sourceHash: fact.sourceHash,
    localizationSnapshotId: input.localizationSnapshotId,
    bibleRenderingId: input.bibleRenderingId,
    targetSkeleton: CLEAN_Q5_TARGET,
    outputId: "accepted:q5-failure-direction:clean",
  });
  const actuallyPatched = acceptedOutput({
    unitId: input.unitId,
    sourceHash: fact.sourceHash,
    localizationSnapshotId: input.localizationSnapshotId,
    bibleRenderingId: input.bibleRenderingId,
    targetSkeleton: input.actualTargetSkeleton,
    outputId: `accepted:q5-render:${input.buildLabel}:patched`,
  });
  const buildRoot = join(input.fixture.buildRoot, input.buildLabel);
  const produced = produceNativePatchbackBuild(
    {
      snapshot: input.snapshot,
      accepted: [actuallyPatched],
      rawBridge: input.fixture.bridge,
      workScope: { inScopeUnitFactIds: [input.unitId] },
      sourceLocale: input.fixture.bridge.sourceLocale,
      targetLocale: "en-US",
    },
    {
      sourceRoot: input.fixture.sourceRoot,
      buildRoot,
      scope: "dialogue-only",
      runId: `q5-render-${input.buildLabel}`,
    },
  );
  return await renderAndOcrPatchedBuild({
    snapshot: input.snapshot,
    patch: produced.patch,
    accepted: [expectedAccepted],
    unitIds: [input.unitId],
    buildRoot,
    runtimeAssetRoot: input.fixture.sourceRoot,
    backgroundAsset: Q5_BACKGROUND_ASSET,
  });
}

function statusCounts(
  observations: ReadonlyArray<{ readonly status: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { status } of observations) {
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function acceptedOutput(input: {
  readonly unitId: string;
  readonly sourceHash: `sha256:${string}`;
  readonly localizationSnapshotId: string;
  readonly bibleRenderingId: string;
  readonly targetSkeleton: string;
  readonly outputId: string;
}): AcceptedUnitOutput {
  return {
    schemaVersion: "itotori.accepted-output.v1",
    outputId: input.outputId,
    version: 1,
    parentOutputIds: [],
    memoKeys: [],
    evidenceIds: [input.unitId],
    acceptedAt: "2026-08-02T00:00:00.000Z",
    releaseEligibility: {
      kind: "artifact-only",
      runMode: "test-dev",
      contextScope: "whole-game",
      reason: "test-dev",
    },
    subjectType: "unit",
    subjectId: input.unitId,
    localizationSnapshotId: input.localizationSnapshotId,
    stage: "final",
    sourceHash: input.sourceHash,
    value: {
      targetSkeleton: input.targetSkeleton,
      targetHash: sha256(input.targetSkeleton),
      translationObjectId: "translation:q5-failure-direction",
      translationObjectVersion: 1,
      parentDraftBatchId: "batch:q5-failure-direction",
      basis: { kind: "wiki-first", bibleRenderingIds: [input.bibleRenderingId] },
      gateReceipts: [
        {
          gate: "protected-spans",
          evidenceHash: sha256(input.targetSkeleton),
          status: "PASS",
        },
      ],
      reviewVerdictIds: [],
    },
  };
}
