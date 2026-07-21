// Shared recorded-port harness for localize live-db tests.
// Drivers inject these fake WorkflowPorts so the mp-02 plane is exercised
// without a live LLM while still billing a fixed confirmed cost per draft.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import type { ItotoriApplicationServices } from "../src/services/database-services.js";
import type { PhysicalAttemptCostObserver } from "../src/llm/physical-attempt-policy.js";
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

export const SOURCE_HASH = `sha256:${"b".repeat(64)}` as const;
export const SNAPSHOT_HASH = `sha256:${"a".repeat(64)}` as const;

export const structure = JSON.parse(
  readFileSync(new URL("./fixtures/narrative-structure-v2-units.json", import.meta.url), "utf8"),
) as unknown;
export const bridge = JSON.parse(
  readFileSync(new URL("./fixtures/whole-seen-bridge.json", import.meta.url), "utf8"),
) as BridgeBundleV02;

export type RunIdentity = {
  projectId: string;
  runId: string;
  localeBranchId: string;
  leaseOwnerId: string;
};

export type RecordedRunState = {
  heads: Map<string, UnitArtifactRef>;
  attempts: AttemptLineageEntry[];
  providerCallCount: number;
  /** When set, draftScene throws after optional observer calls — induces failure. */
  failOnDraft?: Error;
  reviewEntered: Promise<void>;
  finalizeEntered: Promise<void>;
  patchEntered: Promise<void>;
  waitForReview: () => Promise<void>;
  waitForFinalize: () => Promise<void>;
  waitForPatch: () => Promise<void>;
};

export function commandArgs(projectId: string, runId: string, localeBranchId: string): string[] {
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

export function commandDeps(
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

export function recordedRunState(
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

export function recordedPorts(
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
        if (state.failOnDraft !== undefined) throw state.failOnDraft;
        state.providerCallCount += 1;
        const memoKey = `recorded-provider-call-${state.providerCallCount}`;
        const attempt = { ordinal: 1, startedAt: "2026-07-21T00:00:00.000Z" };
        await observer?.onAttemptStarted({
          memoKey,
          attempt,
          maxAttemptExposureUsd: "0.000010",
        });
        // Recorded provider completion: tracker settles the confirmed seven micros.
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

export function passingVerdict(
  lane: "Q1" | "Q2" | "Q3" | "Q4" | "Q5",
  unitId: string,
): LaneVerdict {
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

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

export function hash(character: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(character).digest("hex")}`;
}

export function revision(character: string) {
  return { revisionId: `revision-${character}`, contentHash: hash(character) };
}
