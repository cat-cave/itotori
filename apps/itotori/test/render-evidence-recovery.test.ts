import { describe, expect, it } from "vitest";

import {
  AcceptedOutputSchema,
  ReviewVerdictSchema,
  type RenderAndOcrResult,
} from "../src/contracts/index.js";
import {
  createProductionRenderEvidencePatchback,
  type BuildLqaReviewEvidence,
  type BuildLqaReviewer,
  type ProductionRenderEvidencePlan,
} from "../src/composition/live/render-evidence-adapter.js";
import { sha256 } from "../src/llm/canonical-json.js";
import type { AcceptedUnitOutput, NativePatchbackInput } from "../src/patchback/index.js";
import { buildFactSnapshot } from "../src/prepass/index.js";
import type { FinalizedUnit, LaneVerdict } from "../src/workflow/index.js";
import {
  CLEAN_Q5_TARGET,
  Q5_BACKGROUND_ASSET,
  stageRealLiveQ5Fixture,
} from "./production-role-bindings-reallive-fixture.support.js";

describe("production render evidence recovery", () => {
  it("replays the persisted patched bytes and rehydrates the sealed Q5 evidence", async () => {
    const fixture = stageRealLiveQ5Fixture();
    try {
      const snapshot = buildFactSnapshot(fixture.structure, fixture.bridge);
      const fact = snapshot.orderedUnits[0];
      if (fact === undefined) throw new Error("recovery fixture has no native unit");
      const accepted = acceptedOutput({
        unitId: fact.factId,
        sourceHash: fact.sourceHash,
        localizationSnapshotId: snapshot.snapshotId,
        targetSkeleton: CLEAN_Q5_TARGET,
      });
      const plan: ProductionRenderEvidencePlan = {
        sourceRoot: fixture.sourceRoot,
        buildRoot: fixture.buildRoot,
        patchScope: "dialogue-only",
        runId: "q5-render-evidence-recovery",
        backgroundAsset: Q5_BACKGROUND_ASSET,
      };
      const buildPatchInput = (): NativePatchbackInput => ({
        snapshot,
        accepted: [accepted],
        rawBridge: fixture.bridge,
        workScope: { inScopeUnitFactIds: [fact.factId] },
        sourceLocale: fixture.bridge.sourceLocale,
        targetLocale: "en-US",
      });
      const final: FinalizedUnit = {
        unitId: fact.factId,
        ref: {
          unitId: fact.factId,
          stage: "final",
          contentHash: sha256({ unitId: fact.factId, stage: "final" }),
          version: 1,
        },
        shippable: true,
      };

      const producer = createProductionRenderEvidencePatchback({
        plan,
        snapshot,
        buildPatchInput,
        reviewer: recordingQ5Reviewer([]),
      });
      if (producer.exportPatch === undefined) {
        throw new Error("production render evidence has no patch exporter");
      }
      const { patchId } = await producer.exportPatch([final]);

      const recoveredRenders: RenderAndOcrResult[] = [];
      const sealedEvidence: BuildLqaReviewEvidence[] = [];
      const recoveringAdapter = createProductionRenderEvidencePatchback({
        plan,
        snapshot,
        buildPatchInput: () => {
          throw new Error("fresh Q5 adapter must recover, not produce a new patch");
        },
        recoveredAccepted: [accepted],
        reviewer: recordingQ5Reviewer(recoveredRenders),
        recordBuildLqaEvidence(evidence) {
          sealedEvidence.push(...evidence);
        },
      });
      const verdicts = await recoveringAdapter.buildLqa({
        patchId,
        unitIds: [fact.factId],
      });

      expect(verdicts).toMatchObject([
        { lane: "Q5", verdict: { roleId: "Q5", rubric: "build-lqa", verdict: "PASS" } },
      ]);
      expect(recoveredRenders).toHaveLength(1);
      const render = recoveredRenders[0];
      if (render === undefined) throw new Error("fresh Q5 adapter did not produce render evidence");
      expect(render.frames).toHaveLength(1);
      expect(render.frames[0]?.observedUnitIds).toEqual([fact.factId]);
      expect(render.frames[0]?.observations.map((observation) => observation.status)).toEqual([
        "PASS",
        "PASS",
        "PASS",
        "PASS",
        "PASS",
      ]);
      expect(sealedEvidence).toHaveLength(1);
      expect(sealedEvidence[0]).toMatchObject({
        unitId: fact.factId,
        patchId,
        renderResultHash: render.resultHash,
        patchedBytesHash: render.patchedBytesHash,
      });

      let unexpectedBuildInputCalls = 0;
      let unexpectedReviewerCalls = 0;
      const hydratedEvidence: BuildLqaReviewEvidence[] = [];
      const hydratingAdapter = createProductionRenderEvidencePatchback({
        plan,
        snapshot,
        buildPatchInput: () => {
          unexpectedBuildInputCalls += 1;
          throw new Error("Q5 evidence hydration must not produce or render a patch");
        },
        recoveredAccepted: [accepted],
        reviewer: async () => {
          unexpectedReviewerCalls += 1;
          throw new Error("Q5 evidence hydration must not invoke its reviewer");
        },
        recordBuildLqaEvidence(evidence) {
          hydratedEvidence.push(...evidence);
        },
      });
      if (hydratingAdapter.hydrateBuildLqaEvidence === undefined) {
        throw new Error("production render evidence has no Q5 evidence hydrator");
      }
      await hydratingAdapter.hydrateBuildLqaEvidence({
        patchId,
        unitIds: [fact.factId],
        verdicts,
      });

      expect(unexpectedBuildInputCalls).toBe(0);
      expect(unexpectedReviewerCalls).toBe(0);
      expect(hydratedEvidence).toEqual(sealedEvidence);
    } finally {
      fixture.dispose();
    }
  }, 120_000);
});

function recordingQ5Reviewer(renders: RenderAndOcrResult[]): BuildLqaReviewer {
  return async ({ render, accepted, unitIds, recordReceipt }) => {
    renders.push(render);
    const verdicts: LaneVerdict[] = [];
    for (const unitId of unitIds) {
      const output = accepted.find((candidate) => candidate.subjectId === unitId);
      const frame = render.frames.find((candidate) => candidate.observedUnitIds.includes(unitId));
      if (output === undefined || frame === undefined) {
        throw new Error(
          "Q5 reviewer did not receive the captured native frame for its accepted unit",
        );
      }
      const reviewId = `review:q5:recovery:${unitId}`;
      recordReceipt?.({
        unitId,
        reviewId,
        memoKey: sha256({ reviewId, renderResultHash: render.resultHash }),
      });
      verdicts.push({
        lane: "Q5",
        verdict: ReviewVerdictSchema.parse({
          schemaVersion: "itotori.review-verdict.v1",
          reviewId,
          localizationSnapshotId: output.localizationSnapshotId,
          roleId: "Q5",
          rubric: "build-lqa",
          unitId,
          basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:q5-recovery"] },
          evidenceIds: [frame.frameId],
          verdict: "PASS",
          severity: "none",
          span: null,
          category: null,
          repairConstraint: null,
        }),
      });
    }
    return verdicts;
  };
}

function acceptedOutput(input: {
  readonly unitId: string;
  readonly sourceHash: `sha256:${string}`;
  readonly localizationSnapshotId: `sha256:${string}`;
  readonly targetSkeleton: string;
}): AcceptedUnitOutput {
  const output = AcceptedOutputSchema.parse({
    schemaVersion: "itotori.accepted-output.v1",
    outputId: `accepted:q5-recovery:${input.unitId}`,
    version: 1,
    parentOutputIds: [],
    memoKeys: [],
    evidenceIds: [input.unitId],
    acceptedAt: "2026-08-03T00:00:00.000Z",
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
      translationObjectId: "translation:q5-recovery",
      translationObjectVersion: 1,
      parentDraftBatchId: "batch:q5-recovery",
      basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:q5-recovery"] },
      gateReceipts: [
        { gate: "protected-spans", evidenceHash: sha256(input.targetSkeleton), status: "PASS" },
      ],
      reviewVerdictIds: [],
    },
  });
  if (output.subjectType !== "unit") {
    throw new Error("Q5 recovery fixture did not create a unit accepted output");
  }
  return output;
}
