import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { handleReadOnlyItotoriApiRequest, readOnlyApiServices } from "../src/api-handlers.js";
import { runLocalizeCommand } from "../src/cli/localize-command.js";
import {
  withDatabaseItotoriServices,
  type ItotoriApplicationServices,
} from "../src/services/database-services.js";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import type {
  AttemptContext,
  AttemptLineageEntry,
  DraftedScene,
  LaneVerdict,
  MemoStepResult,
  UnitArtifactRef,
  UnitStage,
  WorkflowPorts,
} from "../src/workflow/index.js";
import type { PhysicalAttemptCostObserver } from "../src/llm/physical-attempt-policy.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const structure = JSON.parse(
  readFileSync(new URL("./fixtures/narrative-structure-v2-units.json", import.meta.url), "utf8"),
) as unknown;
const bridge = JSON.parse(
  readFileSync(new URL("./fixtures/whole-seen-bridge.json", import.meta.url), "utf8"),
) as BridgeBundleV02;
const SOURCE_HASH = `sha256:${"b".repeat(64)}` as const;
const SNAPSHOT_HASH = `sha256:${"a".repeat(64)}` as const;

postgresDescribe("localize run progress over Postgres", () => {
  beforeAll(() => {
    process.env.ITOTORI_FIELD_CIPHER_KEY ??= Buffer.alloc(32, 11).toString("base64");
  });

  it("persists real localize transitions, billed cost, and isolated portfolio runs", async () => {
    const context = await isolatedMigratedContext();
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        const workflow = services.projectWorkflow;
        const projectId = "localize-progress-project";
        const localeBranchId = "localize-progress-branch";
        await workflow.ensureRunProjectScope({
          projectId,
          localeBranchId,
          sourceRevisionId: "localize-progress-source",
          sourceLocale: "ja-JP",
          targetLocale: "en-US",
          engineFamily: "synthetic_fixture",
          sourceRoot: "/fixture/localize-progress/source",
          buildRoot: "/fixture/localize-progress/build",
          extractProfile: { surface: "localize-run-progress-live-db" },
        });
        const contextSnapshot = await workflow.putContext({
          sourceLanguage: "ja-JP",
          decode: revision("a"),
          sourceUnits: [{ unitId: "localize-progress-unit", sourceHash: hash("b") }],
          facts: [
            {
              factId: "unit:localize-progress-unit",
              playOrderIndex: 0,
              routeScope: { kind: "global" },
            },
          ],
          structure: revision("c"),
          routeGraph: revision("d"),
          glossary: revision("e"),
          style: revision("f"),
          revealHorizon: { kind: "complete" },
          humanCorrections: revision("0"),
          externalSources: null,
          contextScope: "whole-game",
        });
        const localizationSnapshot = await workflow.putLocalization({
          contextSnapshotId: contextSnapshot.snapshotId,
          targetLocale: "en-US",
          localeBranchId,
          acceptedBibleHead: null,
          acceptedTargetOutputHead: null,
        });

        const firstReviewGate = deferred();
        const firstFinalizeGate = deferred();
        const firstPatchGate = deferred();
        const firstState = recordedRunState(firstReviewGate, firstFinalizeGate, firstPatchGate);
        const first = runLocalizeCommand(
          commandArgs(projectId, "localize-progress-run-one", localeBranchId),
          commandDeps(
            services,
            contextSnapshot.snapshotId,
            localizationSnapshot.snapshotId,
            firstState,
          ),
        );
        let second: Promise<void> | undefined;
        try {
          await firstState.reviewEntered;

          const during = await workflow.loadLiveReadModel(projectId, "localize-progress-run-one");
          expect(during?.run.status).toBe("running");
          expect(during?.progress.statusCounts.drafted).toBeGreaterThan(0);
          expect(during?.progress.totalCostMicrosUsd).toBeGreaterThan(0);

          const secondState = recordedRunState();
          second = runLocalizeCommand(
            commandArgs(projectId, "localize-progress-run-two", localeBranchId),
            commandDeps(
              services,
              contextSnapshot.snapshotId,
              localizationSnapshot.snapshotId,
              secondState,
            ),
          );
          firstReviewGate.resolve();
          await firstState.finalizeEntered;
          const duringQa = await workflow.loadLiveReadModel(projectId, "localize-progress-run-one");
          expect(duringQa?.progress.statusCounts.QA).toBeGreaterThan(0);

          firstFinalizeGate.resolve();
          await firstState.patchEntered;
          const duringAccepted = await workflow.loadLiveReadModel(
            projectId,
            "localize-progress-run-one",
          );
          expect(duringAccepted?.progress.statusCounts.accepted).toBeGreaterThan(0);

          firstPatchGate.resolve();
          await Promise.all([first, second]);

          const [firstLive, secondLive] = await Promise.all([
            workflow.loadLiveReadModel(projectId, "localize-progress-run-one"),
            workflow.loadLiveReadModel(projectId, "localize-progress-run-two"),
          ]);
          for (const [live, state] of [
            [firstLive, firstState],
            [secondLive, secondState],
          ] as const) {
            expect(live?.run).toMatchObject({
              status: "completed",
              leaseOwnerId: null,
              cost: { spentMicrosUsd: state.providerCallCount * 7, reservedMicrosUsd: 0 },
            });
            expect(live?.progress.totalCostMicrosUsd).toBe(state.providerCallCount * 7);
            expect(live?.progress.statusCounts.patched).toBeGreaterThan(0);
            expect(live?.progress.units).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  role: "localize",
                  status: "patched",
                  coveragePercent: 100,
                }),
              ]),
            );
          }

          const portfolio = await handleReadOnlyItotoriApiRequest(
            { method: "GET", pathname: "/api/projects" },
            readOnlyApiServices({
              ...services,
              authorization: { requirePermission: async () => undefined },
            }),
          );
          expect(portfolio.statusCode).toBe(200);
          if (!("projects" in portfolio.body))
            throw new Error("projects.list did not return a portfolio");
          const project = portfolio.body.projects.find((entry) => entry.projectId === projectId);
          expect(project?.progress).toMatchObject({
            runCount: 2,
            runStatusCounts: { completed: 2 },
            totalCostMicrosUsd: (firstState.providerCallCount + secondState.providerCallCount) * 7,
          });
        } finally {
          // Assertions deliberately inspect in-flight runs. Always open every
          // gate and settle their promises before the DB service scope closes.
          firstReviewGate.resolve();
          firstFinalizeGate.resolve();
          firstPatchGate.resolve();
          await Promise.allSettled(second === undefined ? [first] : [first, second]);
        }
      });
    } finally {
      await context.close();
    }
  });
});

function commandArgs(projectId: string, runId: string, localeBranchId: string): string[] {
  return [
    "localize",
    "--run-mode",
    "production",
    "--project-id",
    projectId,
    "--run-id",
    runId,
    "--locale-branch-id",
    localeBranchId,
    "--structure",
    "structure.json",
    "--bridge",
    "bridge.json",
  ];
}

function commandDeps(
  services: ItotoriApplicationServices,
  contextSnapshotId: string,
  localizationSnapshotId: string,
  state: RecordedRunState,
) {
  return {
    io: {
      readJson: (path: string) => (path === "bridge.json" ? bridge : structure),
      writeJson: () => undefined,
    },
    projectWorkflow: services.projectWorkflow,
    resolvePortSource: (_request: unknown, perRun: { projectRun?: RunIdentity }) => {
      if (perRun.projectRun === undefined) throw new Error("localize test run identity is missing");
      return {
        ports: recordedPorts(state),
        attachRunCostObserver: (observer: PhysicalAttemptCostObserver) =>
          recordedPorts(state, observer),
        runPlane: {
          ...perRun.projectRun,
          contextSnapshotId,
          localizationSnapshotId,
          capMicrosUsd: 100,
        },
      };
    },
  };
}

type RunIdentity = {
  projectId: string;
  runId: string;
  localeBranchId: string;
  leaseOwnerId: string;
};

type RecordedRunState = {
  heads: Map<string, UnitArtifactRef>;
  attempts: AttemptLineageEntry[];
  providerCallCount: number;
  reviewEntered: Promise<void>;
  finalizeEntered: Promise<void>;
  patchEntered: Promise<void>;
  waitForReview: () => Promise<void>;
  waitForFinalize: () => Promise<void>;
  waitForPatch: () => Promise<void>;
};

function recordedRunState(
  reviewGate?: ReturnType<typeof deferred>,
  finalizeGate?: ReturnType<typeof deferred>,
  patchGate?: ReturnType<typeof deferred>,
): RecordedRunState {
  const review = deferred();
  const finalize = deferred();
  const patch = deferred();
  return {
    heads: new Map(),
    attempts: [],
    providerCallCount: 0,
    reviewEntered: review.promise,
    finalizeEntered: finalize.promise,
    patchEntered: patch.promise,
    waitForReview: async () => {
      review.resolve();
      await reviewGate?.promise;
    },
    waitForFinalize: async () => {
      finalize.resolve();
      await finalizeGate?.promise;
    },
    waitForPatch: async () => {
      patch.resolve();
      await patchGate?.promise;
    },
  };
}

function recordedPorts(
  state: RecordedRunState,
  observer?: PhysicalAttemptCostObserver,
): WorkflowPorts {
  return {
    readiness: {
      async resolve() {
        return { ready: true, bibleRenderingIds: ["bible:recorded"] };
      },
    },
    draft: {
      async draftScene(input) {
        state.providerCallCount += 1;
        const memoKey = `recorded-provider-call-${state.providerCallCount}`;
        const attempt = { ordinal: 1, startedAt: "2026-07-21T00:00:00.000Z" };
        await observer?.onAttemptStarted({
          memoKey,
          attempt,
          maxAttemptExposureUsd: "0.000010",
        });
        // This is the recorded provider completion, not a modeled price: the
        // tracker settles exactly the provider-confirmed seven micros below.
        await observer?.onAttemptCompleted({
          memoKey,
          attempt,
          execution: {
            kind: "completed",
            billing: { status: "confirmed", costUsd: "0.000007" },
          } as never,
        });
        const drafts = input.scene.units.map((unit) => ({
          unitId: unit.unitId,
          sourceHash: SOURCE_HASH,
          targetSkeleton: `target:${unit.unitId}`,
          evidenceIds: ["evidence:recorded"],
          basis: { kind: "wiki-first" as const, bibleRenderingIds: ["bible:recorded"] },
          uncertainty: ["none"] as const,
        }));
        return {
          sceneId: input.scene.sceneId,
          mode: input.mode,
          batches: [
            {
              schemaVersion: "itotori.draft-batch.v1",
              localizationSnapshotId: SNAPSHOT_HASH,
              batchId: `batch:${input.scene.sceneId}`,
              scope: {
                kind: "whole-scene",
                sceneId: input.scene.sceneId,
                expectedUnitIds: drafts.map((draft) => draft.unitId),
              },
              drafts,
            },
          ],
          units: drafts.map((draft) => ({
            unitId: draft.unitId,
            draft,
            bibleRenderingIds: ["bible:recorded"],
          })),
        } as DraftedScene;
      },
    },
    gates: {
      async evaluate() {
        return { defects: [], evaluatedGates: ["protected-spans"] };
      },
    },
    review: {
      async review(input) {
        await state.waitForReview();
        return input.unitIds.map((unitId) => passingVerdict(input.lane, unitId));
      },
    },
    repair: {
      async lineEdit() {
        return { route: "repair" as const, changedUnitIds: [] };
      },
      async semanticRepair() {
        return { route: "repair" as const, changedUnitIds: [] };
      },
    },
    adjudicate: {
      async adjudicate() {
        return { disposition: "finalize" as const };
      },
    },
    patchback: {
      async exportPatch() {
        await state.waitForPatch();
        return { patchId: "patch:recorded" };
      },
      async buildLqaReview(input) {
        return input.unitIds.map((unitId) => passingVerdict("Q5", unitId));
      },
    },
    store: {
      async readUnitHead(unitId: string, stage: UnitStage) {
        return state.heads.get(`${unitId}:${stage}`) ?? null;
      },
      async finalizeUnit(input) {
        if (input.stage === "final") await state.waitForFinalize();
        const key = `${input.unitId}:${input.stage}`;
        const ref = {
          unitId: input.unitId,
          stage: input.stage,
          contentHash: input.contentHash,
          version: (state.heads.get(key)?.version ?? 0) + 1,
        } as UnitArtifactRef;
        state.heads.set(key, ref);
        return ref;
      },
      async runMemoizedStep<T>(memoKey: string, produce: (attempt: AttemptContext) => Promise<T>) {
        const value = await produce({ memoKey, ordinal: 1 });
        state.attempts.push({ memoKey, ordinal: 1, outcome: "completed" });
        return { memoHit: false, value } as MemoStepResult<T>;
      },
      attemptLineage: () => state.attempts,
    },
  };
}

function passingVerdict(lane: "Q1" | "Q2" | "Q3" | "Q4" | "Q5", unitId: string): LaneVerdict {
  return {
    lane,
    verdict: {
      schemaVersion: "itotori.review-verdict.v1",
      reviewId: `review:${lane}:${unitId}`,
      localizationSnapshotId: SNAPSHOT_HASH,
      roleId: lane,
      rubric: "meaning",
      unitId,
      basis: { kind: "wiki-first", bibleRenderingIds: ["bible:recorded"] },
      verdict: "PASS",
      severity: "none",
      span: null,
      category: null,
      evidenceIds: ["evidence:recorded"],
      repairConstraint: null,
    },
  } as LaneVerdict;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(character).digest("hex")}`;
}

function revision(character: string) {
  return { revisionId: `revision-${character}`, contentHash: hash(character) };
}
