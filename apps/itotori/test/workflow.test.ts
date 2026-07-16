import { describe, expect, it } from "vitest";

import { buildDefect } from "../src/gates/index.js";
import type { Defect } from "../src/contracts/index.js";
import type { ReviewVerdict } from "../src/contracts/index.js";
import { FULL_ROSTER, type RunPolicyRequest } from "../src/run-policy/index.js";
import {
  applyCorrections,
  classifyStratum,
  coherenceSchedule,
  finalizeUnit,
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

// ---------------------------------------------------------------------------
// Fixtures — minimal valid role outputs. The driver proves control flow; these
// stand in for the best-effort content the roles produce.
// ---------------------------------------------------------------------------

const SNAP = `sha256:${"a".repeat(64)}` as const;
const SRC = `sha256:${"b".repeat(64)}` as const;

function draftFor(unitId: string, uncertain = false): DraftedUnit {
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

function draftedScene(sceneId: string, unitIds: readonly string[], mode: DraftMode): DraftedScene {
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

function scene(sceneId: string, unitIds: readonly string[]): WorkflowScene {
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

function passVerdict(lane: ReviewLane, unitId: string): ReviewVerdict {
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

function terminologyFail(unitId: string): ReviewVerdict {
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

function protectedSpanDefect(
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

// ---------------------------------------------------------------------------
// Fake substrate + ports.
// ---------------------------------------------------------------------------

class FakeStore {
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

interface Recorder {
  draftCalls: { sceneId: string; mode: DraftMode; unitIds: readonly string[] }[];
  reviewCalls: { lane: ReviewLane; unitIds: readonly string[] }[];
  lineEditCalls: { unitIds: readonly string[] }[];
  semanticRepairCalls: { unitIds: readonly string[] }[];
  adjudicateCalls: { unitId: string }[];
  exportCalls: { finalized: readonly FinalizedUnit[]; at: number }[];
  buildLqaCalls: { patchId: string; at: number }[];
  maxDraftInFlight: number;
}

function newRecorder(): Recorder {
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

interface FakeOptions {
  readonly readiness?: (unitId: string) => UnitReadiness;
  readonly gateDefects?: readonly Defect[];
  readonly verdicts?: (lane: ReviewLane, unitIds: readonly string[]) => readonly LaneVerdict[];
  readonly lineEdit?: CorrectionOutcome;
  readonly semanticRepair?: CorrectionOutcome;
  readonly draftTransientFailures?: number;
}

function buildPorts(store: FakeStore, rec: Recorder, opts: FakeOptions = {}): WorkflowPorts {
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

const PRODUCTION: RunPolicyRequest = {
  runMode: "production",
  contextScope: "whole-game",
  outputScope: "dialogue-only",
  roster: FULL_ROSTER,
};

const TEST_DEV_NARROWED: RunPolicyRequest = {
  runMode: "test-dev",
  contextScope: "narrowed:rin-route",
  outputScope: "dialogue-only",
  roster: FULL_ROSTER,
};

// ---------------------------------------------------------------------------
// Clause tests.
// ---------------------------------------------------------------------------

describe("RB workflow — wiki + bible readiness first (clause 1)", () => {
  it("blocks drafting a unit whose required bible entry is missing; no draft dispatched", async () => {
    const store = new FakeStore();
    const rec = newRecorder();
    const ports = buildPorts(store, rec, {
      readiness: (unitId) =>
        unitId === "u2"
          ? { ready: false, missing: ["voice.speaker.u2"] }
          : { ready: true, bibleRenderingIds: ["bible.rendering.1"] },
    });
    await expect(
      runLocalizationWorkflow(PRODUCTION, [scene("s1", ["u1", "u2"])], ports),
    ).rejects.toBeInstanceOf(WorkflowReadinessError);
    expect(rec.draftCalls).toHaveLength(0);
  });
});

describe("RB workflow — P1 drafting: both realization paths (clause 2)", () => {
  it("drafts a small scene whole and a large scene in overlapping chunks", async () => {
    const store = new FakeStore();
    const rec = newRecorder();
    const ports = buildPorts(store, rec);
    const report = await runLocalizationWorkflow(
      PRODUCTION,
      [scene("small", ["u1", "u2"]), scene("large", ["a", "b", "c"])],
      ports,
      { wholeSceneMaxUnits: 2 },
    );
    const modes = new Map(report.scenes.map((outcome) => [outcome.sceneId, outcome.mode]));
    expect(modes.get("small")).toBe("whole-scene");
    expect(modes.get("large")).toBe("overlapping-chunk");
    expect(rec.draftCalls.map((call) => call.mode).sort()).toEqual([
      "overlapping-chunk",
      "whole-scene",
    ]);
  });
});

describe("RB workflow — deterministic gate defect routed as a deterministic fault (clause 3)", () => {
  it("keeps the gate defect (origin deterministic) and lets its fact dominate a contrary reviewer finding", async () => {
    const store = new FakeStore();
    const rec = newRecorder();
    const ports = buildPorts(store, rec, {
      gateDefects: [protectedSpanDefect("u1")],
      verdicts: (lane, unitIds) =>
        lane === "Q3"
          ? unitIds.map((unitId) => ({ lane, verdict: terminologyFail(unitId) }))
          : unitIds.map((unitId) => ({ lane, verdict: passVerdict(lane, unitId) })),
    });
    const report = await runLocalizationWorkflow(PRODUCTION, [scene("s1", ["u1"])], ports);
    const bundle = report.scenes[0]?.bundle;
    const deterministic =
      bundle?.defects.filter((defect) => defect.origin === "deterministic") ?? [];
    expect(deterministic).toHaveLength(1);
    expect(deterministic[0]?.gate).toBe("protected-spans");
    // The passing glossary fact dominates the contrary terminology FAIL.
    expect(bundle?.factDominance.length).toBeGreaterThanOrEqual(1);
  });
});

describe("RB workflow — stratified review, not uniform (clause 4)", () => {
  it("gives a high-risk unit full lanes and reviews a clean unit non-uniformly", () => {
    const drafted = draftedScene("s1", ["hot", "cold"], "whole-scene");
    // Force one high-risk (uncertain) and one clean unit.
    const draftedWithRisk: DraftedScene = {
      ...drafted,
      units: [draftFor("hot", true), draftFor("cold", false)],
    };
    const identity = new Map([
      ["hot", { speakerId: "sp", routeId: "r", firstAppearance: false }],
      ["cold", { speakerId: "sp", routeId: "r", firstAppearance: false }],
    ]);
    const plan = planStratifiedReview(draftedWithRisk, [], identity);
    const hot = plan.selections.find((sel) => sel.unitId === "hot");
    const cold = plan.selections.find((sel) => sel.unitId === "cold");
    expect(hot?.stratum).toBe("high-risk");
    expect(hot?.lanes.length).toBeGreaterThan(1);
    expect(cold?.stratum).toBe("representative-clean");
    // Not uniform: the clean unit gets strictly fewer lanes than the high-risk one.
    expect(cold?.lanes.length ?? 0).toBeLessThan(hot?.lanes.length ?? 0);
    expect(classifyStratum({ firstAppearance: true, hasGateDefect: false, uncertain: false })).toBe(
      "high-risk",
    );
  });
});

describe("RB workflow — deterministic finding join (clause 5)", () => {
  it("produces a byte-identical bundle regardless of reviewer arrival order", () => {
    const deterministic = [protectedSpanDefect("u1")];
    const reviews: LaneVerdict[] = [
      { lane: "Q1", verdict: passVerdict("Q1", "u1") },
      { lane: "Q2", verdict: passVerdict("Q2", "u2") },
      { lane: "Q4", verdict: passVerdict("Q4", "u3") },
    ];
    const forward = joinFindings({
      localizationSnapshotId: SNAP,
      draftBatchId: "batch.1",
      deterministic,
      evaluatedGates: ["protected-spans", "glossary-exact"],
      reviews,
    });
    const reversed = joinFindings({
      localizationSnapshotId: SNAP,
      draftBatchId: "batch.1",
      deterministic,
      evaluatedGates: ["protected-spans", "glossary-exact"],
      reviews: [...reviews].reverse(),
    });
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});

describe("RB workflow — P2/P3 applied to findings (clause 6)", () => {
  it("routes minor defects to the line editor and major defects to semantic repair", async () => {
    const rec = newRecorder();
    const drafted = draftedScene("s1", ["u1"], "whole-scene");
    const bundle = joinFindings({
      localizationSnapshotId: SNAP,
      draftBatchId: "batch.1",
      deterministic: [
        buildDefect({
          unitId: "minorUnit",
          category: "punctuation",
          detail: "minor",
          basisFactIds: ["f"],
        }),
        protectedSpanDefect("majorUnit"),
      ],
      evaluatedGates: ["protected-spans"],
      reviews: [],
    });
    const ports = buildPorts(new FakeStore(), rec);
    await applyCorrections({
      bundle,
      scene: drafted,
      repair: ports.repair,
      review: ports.review,
      adjudicate: ports.adjudicate,
    });
    expect(rec.lineEditCalls[0]?.unitIds).toEqual(["minorUnit"]);
    expect(rec.semanticRepairCalls[0]?.unitIds).toEqual(["majorUnit"]);
  });
});

describe("RB workflow — rerun only implicated lanes (clause 7)", () => {
  it("re-runs only the lanes/units a correction implicated, never the whole pipeline", async () => {
    const rec = newRecorder();
    const drafted = draftedScene("s1", ["u1", "u4"], "whole-scene");
    // u1's defect implicates Q1; u4's defect implicates Q4.
    const bundle = joinFindings({
      localizationSnapshotId: SNAP,
      draftBatchId: "batch.1",
      deterministic: [protectedSpanDefect("u1", ["Q1"]), protectedSpanDefect("u4", ["Q4"])],
      evaluatedGates: ["protected-spans"],
      reviews: [],
    });
    // A correction changes ONLY u1.
    const scope = implicatedRerun(bundle, ["u1"]);
    expect(scope.unitIds).toEqual(["u1"]);
    expect(scope.lanes).toEqual(["Q1"]);
    expect(scope.lanes).not.toContain("Q4");

    // Drive the same correction through the driver's correction step and observe
    // that ONLY Q1 over ONLY u1 re-ran.
    const ports = buildPorts(new FakeStore(), rec, {
      lineEdit: { route: "repair", changedUnitIds: ["u1"] },
      semanticRepair: { route: "repair", changedUnitIds: ["u1"] },
    });
    const summary = await applyCorrections({
      bundle,
      scene: drafted,
      repair: ports.repair,
      review: ports.review,
      adjudicate: ports.adjudicate,
    });
    for (const call of summary.rerunLaneCalls) {
      expect(call.lane).toBe("Q1");
      expect(call.unitIds).toEqual(["u1"]);
    }
    expect(
      rec.reviewCalls.every(
        (call) => call.lane === "Q1" && call.unitIds.every((id) => id === "u1"),
      ),
    ).toBe(true);
  });
});

describe("RB workflow — bounded adjudication (clause 8)", () => {
  it("fires the adjudicator exactly once per contested unit, never twice", async () => {
    const rec = newRecorder();
    const drafted = draftedScene("s1", ["u1"], "whole-scene");
    const bundle = joinFindings({
      localizationSnapshotId: SNAP,
      draftBatchId: "batch.1",
      deterministic: [protectedSpanDefect("u1")],
      evaluatedGates: ["protected-spans"],
      reviews: [],
    });
    const ports = buildPorts(new FakeStore(), rec, {
      // The semantic repair spends its one bounded attempt → adjudication.
      semanticRepair: { route: "adjudication", contestedUnitIds: ["u1", "u1"] },
    });
    const summary = await applyCorrections({
      bundle,
      scene: drafted,
      repair: ports.repair,
      review: ports.review,
      adjudicate: ports.adjudicate,
    });
    expect(summary.adjudications).toBe(1);
    expect(rec.adjudicateCalls).toHaveLength(1);
    expect(rec.adjudicateCalls[0]?.unitId).toBe("u1");
  });
});

describe("RB workflow — independent per-unit CAS finalize (clause 9)", () => {
  it("advances each unit's head independently; one unit's re-finalize never couples another's", async () => {
    const store = new FakeStore();
    const policy = resolveWorkflowPolicy(PRODUCTION);
    const a1 = await finalizeUnit(store, policy, { unitId: "uA", contentHash: SRC });
    const b1 = await finalizeUnit(store, policy, { unitId: "uB", contentHash: SRC });
    expect(a1.ref.version).toBe(1);
    expect(b1.ref.version).toBe(1);
    // Re-finalize uA only.
    const a2 = await finalizeUnit(store, policy, { unitId: "uA", contentHash: SRC });
    expect(a2.ref.version).toBe(2);
    // uB is untouched — decoupled.
    const bHead = await store.readUnitHead("uB", "final");
    expect(bHead?.version).toBe(1);
  });
});

describe("RB workflow — patchback + downstream Build-LQA (clauses 10, 11)", () => {
  it("exports finalized units and runs Q5 strictly after patch export", async () => {
    const store = new FakeStore();
    const rec = newRecorder();
    const ports = buildPorts(store, rec);
    const report = await runLocalizationWorkflow(PRODUCTION, [scene("s1", ["u1", "u2"])], ports);
    expect(report.patchId).toBe("patch.1");
    expect(rec.exportCalls).toHaveLength(1);
    expect(rec.exportCalls[0]?.finalized.map((unit) => unit.unitId).sort()).toEqual(["u1", "u2"]);
    expect(rec.buildLqaCalls).toHaveLength(1);
    // Q5 runs on the patched result, strictly after export.
    expect(rec.buildLqaCalls[0]?.patchId).toBe("patch.1");
    expect(rec.buildLqaCalls[0]!.at).toBeGreaterThan(rec.exportCalls[0]!.at);
    expect(report.buildLqa.every((verdict) => verdict.lane === "Q5")).toBe(true);
  });
});

describe("RB workflow — durability: restart produces only missing artifacts (clause 12a)", () => {
  it("produces only the units without a finalized head and never re-runs completed work", async () => {
    const store = new FakeStore();
    const rec = newRecorder();
    const ports = buildPorts(store, rec);
    const scenes = [scene("s1", ["u1", "u2", "u3", "u4"])];

    // Seed u1 and u2 as already finalized (a prior partial run).
    store.seedFinal("u1");
    store.seedFinal("u2");

    const first = await runLocalizationWorkflow(PRODUCTION, scenes, ports);
    // Only the MISSING units were drafted.
    expect(rec.draftCalls).toHaveLength(1);
    expect(rec.draftCalls[0]?.unitIds).toEqual(["u3", "u4"]);
    expect(first.scenes[0]?.draftedUnitIds).toEqual(["u3", "u4"]);
    expect(first.scenes[0]?.skippedUnitIds).toEqual(["u1", "u2"]);

    // Restart on the SAME store: every unit now has a head → produce nothing.
    rec.draftCalls.length = 0;
    const second = await runLocalizationWorkflow(PRODUCTION, scenes, ports);
    expect(rec.draftCalls).toHaveLength(0);
    expect(second.scenes[0]?.mode).toBeNull();
    expect(second.scenes[0]?.draftedUnitIds).toEqual([]);
    expect(await missingStageUnits(store, ["u1", "u2", "u3", "u4"], "final")).toEqual([]);
  });
});

describe("RB workflow — durability: coherence-only serialization (clause 12b)", () => {
  it("serializes a scene's units but runs independent scenes in parallel", async () => {
    const store = new FakeStore();
    const rec = newRecorder();
    const ports = buildPorts(store, rec);
    const scenes = [scene("s1", ["u1"]), scene("s2", ["u2"]), scene("s3", ["u3"])];
    const report = await runLocalizationWorkflow(PRODUCTION, scenes, ports);
    // Each scene is one serial chain of its units; scenes are independent.
    expect(report.schedule.serialChains).toEqual([["u1"], ["u2"], ["u3"]]);
    expect(report.schedule.parallelScenes).toEqual(["s1", "s2", "s3"]);
    // Independent scenes actually overlapped in flight.
    expect(rec.maxDraftInFlight).toBe(3);
    // A single scene's units form one coherence chain.
    const oneScene = coherenceSchedule([scene("s9", ["x", "y", "z"])]);
    expect(oneScene.serialChains).toEqual([["x", "y", "z"]]);
  });
});

describe("RB workflow — durability: every physical attempt is counted (clause 12c)", () => {
  it("counts each transient retry in the lineage — no silent retries", async () => {
    const store = new FakeStore();
    const rec = newRecorder();
    // The draft fails transiently twice, then succeeds on the third attempt.
    const ports = buildPorts(store, rec, { draftTransientFailures: 2 });
    const report = await runLocalizationWorkflow(PRODUCTION, [scene("s1", ["u1"])], ports);
    const draftAttempts = report.attemptLineage.filter((entry) => entry.memoKey.includes(""));
    const forDraft = report.attemptLineage.filter(
      (entry) => entry.outcome === "transient-retry" || entry.outcome === "completed",
    );
    expect(forDraft).toHaveLength(3);
    expect(forDraft.map((entry) => entry.outcome)).toEqual([
      "transient-retry",
      "transient-retry",
      "completed",
    ]);
    expect(forDraft.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
    expect(draftAttempts.length).toBeGreaterThan(0);
  });
});

describe("RB workflow — policy gate: a non-shippable run cannot finalize shippable", () => {
  it("mints artifact-only heads for a test-dev/narrowed run and shippable heads for production", async () => {
    const prodPolicy = resolveWorkflowPolicy(PRODUCTION);
    const prodRelease = releaseUnit(prodPolicy, {
      unitId: "u1",
      stage: "final",
      contentHash: SRC,
      version: 0,
    });
    expect(prodRelease.shippable).toBe(true);

    const devPolicy = resolveWorkflowPolicy(TEST_DEV_NARROWED);
    const devRelease = releaseUnit(devPolicy, {
      unitId: "u1",
      stage: "final",
      contentHash: SRC,
      version: 0,
    });
    expect(devRelease.shippable).toBe(false);

    // End to end: a narrowed test-dev run finalizes only artifact-only units.
    const store = new FakeStore();
    const rec = newRecorder();
    const ports = buildPorts(store, rec);
    const report = await runLocalizationWorkflow(TEST_DEV_NARROWED, [scene("s1", ["u1"])], ports);
    expect(report.finalized.every((unit) => unit.shippable === false)).toBe(true);
  });

  it("refuses an illegal run at the policy gate before any scene is touched", () => {
    const illegal: RunPolicyRequest = { ...PRODUCTION, contextScope: "narrowed:rin-route" };
    expect(() => resolveWorkflowPolicy(illegal)).toThrow();
  });
});
