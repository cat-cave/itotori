import { describe, expect, it } from "vitest";
import { buildDefect } from "../src/gates/index.js";
import type { Defect } from "../src/contracts/index.js";
import type { ReviewVerdict } from "../src/contracts/index.js";
import { FULL_ROSTER, type RunPolicyRequest } from "../src/run-policy/index.js";
import {
  applyCorrections,
  classifyStratum,
  coherenceSchedule,
  FinalizeBatchError,
  finalizeUnit,
  finalizeUnits,
  implicatedRerun,
  joinFindings,
  missingStageUnits,
  planStratifiedReview,
  releaseUnit,
  resolveWorkflowPolicy,
  runLocalizationWorkflow,
  TransientStepError,
  WorkflowReadinessError,
  type AttemptContext,
  type AttemptLineageEntry,
  type CorrectionOutcome,
  type DraftMode,
  type DraftedScene,
  type DraftedUnit,
  type FinalizedUnit,
  type LaneVerdict,
  type MemoStepResult,
  type ReviewLane,
  type UnitArtifactRef,
  type UnitReadiness,
  type UnitStage,
  type WorkflowPorts,
  type WorkflowScene,
} from "../src/workflow/index.js";

export const SNAP = `sha256:${"a".repeat(64)}` as const;

export const SRC = `sha256:${"b".repeat(64)}` as const;

export function draftFor(unitId: string, uncertain = false): DraftedUnit {
  return {
    unitId,
    bibleRenderingIds: ["bible.rendering.1"],
    draft: {
      unitId,
      sourceHash: SRC,
      targetSkeleton: `target for ${unitId}`,
      evidenceIds: ["ev.1"],
      basis: { kind: "wiki-first", bibleRenderingIds: ["bible.rendering.1"] },
      uncertainty: uncertain ? ["term"] : ["none"],
    },
  };
}

export function draftedScene(
  sceneId: string,
  unitIds: readonly string[],
  mode: DraftMode,
): DraftedScene {
  return {
    sceneId,
    mode,
    batches: [
      {
        schemaVersion: "itotori.draft-batch.v1",
        localizationSnapshotId: SNAP,
        batchId: `${sceneId}.batch`,
        scope: { kind: "whole-scene", sceneId, expectedUnitIds: [...unitIds] },
        drafts: unitIds.map((unitId) => draftFor(unitId).draft),
      },
    ],
    units: unitIds.map((unitId) => draftFor(unitId)),
  };
}

export function scene(sceneId: string, unitIds: readonly string[]): WorkflowScene {
  return {
    sceneId,
    units: unitIds.map((unitId) => ({
      unitId,
      sourceHash: SRC,
      speakerId: `speaker.${unitId}`,
      routeId: `route.${sceneId}`,
      firstAppearance: false,
    })),
  };
}

export function passVerdict(lane: ReviewLane, unitId: string): ReviewVerdict {
  const rubric = (
    {
      Q1: "meaning",
      Q2: "voice",
      Q3: "terminology",
      Q4: "continuity",
      Q5: "build-lqa",
      Q6: "adjudication",
    } as const
  )[lane];
  return {
    schemaVersion: "itotori.review-verdict.v1",
    reviewId: `review.${lane}.${unitId}`,
    localizationSnapshotId: SNAP,
    roleId: lane,
    rubric,
    unitId,
    basis: { kind: "wiki-first", bibleRenderingIds: ["bible.rendering.1"] },
    verdict: "PASS",
    severity: "none",
    span: null,
    category: null,
    evidenceIds: ["ev.1"],
    repairConstraint: null,
  };
}

export function terminologyFail(unitId: string): ReviewVerdict {
  return {
    schemaVersion: "itotori.review-verdict.v1",
    reviewId: `review.Q3.${unitId}`,
    localizationSnapshotId: SNAP,
    roleId: "Q3",
    rubric: "terminology",
    unitId,
    basis: { kind: "wiki-first", bibleRenderingIds: ["bible.rendering.1"] },
    verdict: "FAIL",
    severity: "major",
    span: { spanId: "span.1", surface: "target", text: "off-term" },
    category: "term-sense",
    evidenceIds: ["ev.1"],
    repairConstraint: "use the approved form",
  };
}

export function meaningFail(unitId: string): ReviewVerdict {
  return {
    schemaVersion: "itotori.review-verdict.v1",
    reviewId: `review.Q1.${unitId}`,
    localizationSnapshotId: SNAP,
    roleId: "Q1",
    rubric: "meaning",
    unitId,
    basis: { kind: "wiki-first", bibleRenderingIds: ["bible.rendering.1"] },
    verdict: "FAIL",
    severity: "major",
    span: { spanId: "span.1", surface: "target", text: "wrong meaning" },
    category: "mistranslation",
    evidenceIds: ["ev.1"],
    repairConstraint: "preserve the source meaning",
  };
}

export function protectedSpanDefect(
  unitId: string,
  lanes: readonly ("Q1" | "Q2" | "Q3" | "Q4" | "Q5" | "Q6")[] = [],
): Defect {
  return buildDefect({
    unitId,
    category: "protected-span",
    detail: `protected span dropped in ${unitId}`,
    basisFactIds: ["fact.1"],
    implicatedReviewLanes: [...lanes],
  });
}

export class FakeStore {
  readonly heads = new Map<string, UnitArtifactRef>();
  readonly completed = new Map<string, unknown>();
  readonly lineage: AttemptLineageEntry[] = [];
  readonly attemptCounts = new Map<string, number>();

  seedFinal(unitId: string): void {
    this.heads.set(`${unitId}:final`, { unitId, stage: "final", contentHash: SRC, version: 1 });
  }

  async readUnitHead(unitId: string, stage: UnitStage): Promise<UnitArtifactRef | null> {
    return this.heads.get(`${unitId}:${stage}`) ?? null;
  }

  async finalizeUnit(input: {
    unitId: string;
    stage: UnitStage;
    contentHash: `sha256:${string}`;
    shippable: boolean;
  }): Promise<UnitArtifactRef> {
    const key = `${input.unitId}:${input.stage}`;
    const prev = this.heads.get(key);
    const ref: UnitArtifactRef = {
      unitId: input.unitId,
      stage: input.stage,
      contentHash: input.contentHash,
      version: (prev?.version ?? 0) + 1,
    };
    this.heads.set(key, ref);
    return ref;
  }

  async runMemoizedStep<T>(
    memoKey: string,
    produce: (attempt: AttemptContext) => Promise<T>,
  ): Promise<MemoStepResult<T>> {
    if (this.completed.has(memoKey)) {
      return { memoHit: true, value: this.completed.get(memoKey) as T };
    }
    let ordinal = this.attemptCounts.get(memoKey) ?? 0;
    for (;;) {
      ordinal += 1;
      this.attemptCounts.set(memoKey, ordinal);
      try {
        const value = await produce({ memoKey, ordinal });
        this.lineage.push({ memoKey, ordinal, outcome: "completed" });
        this.completed.set(memoKey, value);
        return { memoHit: false, value };
      } catch (error: unknown) {
        if (error instanceof TransientStepError && ordinal < 3) {
          this.lineage.push({ memoKey, ordinal, outcome: "transient-retry" });
          continue;
        }
        this.lineage.push({ memoKey, ordinal, outcome: "failed" });
        throw error;
      }
    }
  }

  attemptLineage(): readonly AttemptLineageEntry[] {
    return this.lineage;
  }
}

export interface Recorder {
  draftCalls: { sceneId: string; mode: DraftMode; unitIds: readonly string[] }[];
  reviewCalls: { lane: ReviewLane; unitIds: readonly string[] }[];
  lineEditCalls: { unitIds: readonly string[] }[];
  semanticRepairCalls: { unitIds: readonly string[] }[];
  adjudicateCalls: { unitId: string }[];
  exportCalls: { finalized: readonly FinalizedUnit[]; at: number }[];
  buildLqaCalls: { patchId: string; at: number }[];
  maxDraftInFlight: number;
}

export function newRecorder(): Recorder {
  return {
    draftCalls: [],
    reviewCalls: [],
    lineEditCalls: [],
    semanticRepairCalls: [],
    adjudicateCalls: [],
    exportCalls: [],
    buildLqaCalls: [],
    maxDraftInFlight: 0,
  };
}

export interface FakeOptions {
  readonly readiness?: (unitId: string) => UnitReadiness;
  readonly gateDefects?: readonly Defect[];
  readonly verdicts?: (lane: ReviewLane, unitIds: readonly string[]) => readonly LaneVerdict[];
  readonly lineEdit?: CorrectionOutcome;
  readonly semanticRepair?: CorrectionOutcome;
  readonly draftTransientFailures?: number;
  readonly draftProbe?: () => Promise<void>;
}

export function buildPorts(store: FakeStore, rec: Recorder, opts: FakeOptions = {}): WorkflowPorts {
  let inFlight = 0;
  let remainingTransient = opts.draftTransientFailures ?? 0;
  return {
    readiness: {
      async resolve(unitId: string): Promise<UnitReadiness> {
        return opts.readiness
          ? opts.readiness(unitId)
          : { ready: true, bibleRenderingIds: ["bible.rendering.1"] };
      },
    },
    draft: {
      async draftScene(input): Promise<DraftedScene> {
        if (remainingTransient > 0) {
          remainingTransient -= 1;
          throw new TransientStepError("simulated transport blip");
        }
        inFlight += 1;
        rec.maxDraftInFlight = Math.max(rec.maxDraftInFlight, inFlight);
        await opts.draftProbe?.();
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const unitIds = input.scene.units.map((unit) => unit.unitId);
        rec.draftCalls.push({ sceneId: input.scene.sceneId, mode: input.mode, unitIds });
        return draftedScene(input.scene.sceneId, unitIds, input.mode);
      },
    },
    gates: {
      async evaluate(): Promise<{
        defects: readonly Defect[];
        evaluatedGates: readonly ("protected-spans" | "glossary-exact")[];
      }> {
        return {
          defects: opts.gateDefects ?? [],
          evaluatedGates: ["protected-spans", "glossary-exact"],
        };
      },
    },
    review: {
      async review(input): Promise<readonly LaneVerdict[]> {
        rec.reviewCalls.push({ lane: input.lane, unitIds: input.unitIds });
        if (opts.verdicts) return opts.verdicts(input.lane, input.unitIds);
        return input.unitIds.map((unitId) => ({
          lane: input.lane,
          verdict: passVerdict(input.lane, unitId),
        }));
      },
    },
    repair: {
      async lineEdit(input): Promise<CorrectionOutcome> {
        rec.lineEditCalls.push({ unitIds: input.unitIds });
        return opts.lineEdit ?? { route: "repair", changedUnitIds: input.unitIds };
      },
      async semanticRepair(input): Promise<CorrectionOutcome> {
        rec.semanticRepairCalls.push({ unitIds: input.unitIds });
        return opts.semanticRepair ?? { route: "repair", changedUnitIds: input.unitIds };
      },
    },
    adjudicate: {
      async adjudicate(input): Promise<{ disposition: "finalize" | "repair" | "escalate" }> {
        rec.adjudicateCalls.push({ unitId: input.unitId });
        return { disposition: "finalize" };
      },
    },
    patchback: {
      async exportPatch(input): Promise<{ patchId: string }> {
        rec.exportCalls.push({
          finalized: input.finalized,
          at: rec.exportCalls.length + rec.buildLqaCalls.length,
        });
        return { patchId: "patch.1" };
      },
      async buildLqaReview(input): Promise<readonly LaneVerdict[]> {
        rec.buildLqaCalls.push({
          patchId: input.patchId,
          at: rec.exportCalls.length + rec.buildLqaCalls.length,
        });
        return input.unitIds.map((unitId) => ({
          lane: "Q5" as const,
          verdict: passVerdict("Q5", unitId),
        }));
      },
    },
    store: store as unknown as WorkflowPorts["store"],
  };
}

export const PRODUCTION: RunPolicyRequest = {
  runMode: "production",
  contextScope: "whole-game",
  outputScope: "dialogue-only",
  roster: FULL_ROSTER,
};

export const TEST_DEV_NARROWED: RunPolicyRequest = {
  runMode: "test-dev",
  contextScope: "narrowed:rin-route",
  outputScope: "dialogue-only",
  roster: FULL_ROSTER,
};
