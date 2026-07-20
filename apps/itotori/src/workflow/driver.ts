// The fixed artifact-driven localization workflow — the capstone driver.
//
// A single deterministic control flow that drives the whole pipeline end to end
// by composing the already-built pieces. It SEQUENCES/GATES/ROUTES/FINALIZES; the
// roles produce the content. In order, for a run:
//   1. resolve the run policy FIRST (the legality gate);
//   2. per scene (independent scenes in parallel; a scene's units serial):
//      a. query which units are already finalized and produce ONLY the gap;
//      b. gate drafting on wiki + bible readiness;
//      c. draft (whole-scene OR overlapping-chunk) through a memoized step that
//         counts every physical attempt;
//      d. run the deterministic gates;
//      e. route by risk stratum to stratified reviewers (parallel);
//      f. join the parallel findings deterministically;
//      g. apply P2/P3 corrections, re-running only implicated lanes, with the
//         adjudicator bounded to one firing per contested unit;
//      h. finalize each unit independently into the CAS, gated by the policy;
//   3. export the finalized units to a patch;
//   4. run the downstream Build-LQA review over the patched result.

import type { DefectBundle } from "../contracts/index.js";
import { stableDigest } from "../gates/index.js";
import type { ResolvedRunPolicy, RunPolicyRequest } from "../run-policy/index.js";
import { applyCorrections, type CorrectionSummary } from "./correction.js";
import { coherenceSchedule, missingStageUnits, type CoherenceSchedule } from "./durability.js";
import { finalizeUnits } from "./finalize.js";
import { joinFindings } from "./finding-join.js";
import { resolveWorkflowPolicy } from "./policy.js";
import { resolveSceneReadiness } from "./readiness.js";
import { planStratifiedReview, type ReviewPlan } from "./risk-routing.js";
import type { AttemptLineageEntry, FinalizedUnit, WorkflowPorts } from "./ports.js";
import {
  WorkflowSequenceError,
  type DraftMode,
  type DraftedScene,
  type LaneVerdict,
  type WorkflowScene,
} from "./types.js";

/** Tuning for the draft-path decision. A scene with at most `wholeSceneMaxUnits`
 * units is drafted whole; a larger scene is drafted in overlapping chunks. */
export interface WorkflowOptions {
  readonly wholeSceneMaxUnits?: number;
}

const DEFAULT_WHOLE_SCENE_MAX_UNITS = 50;

/** The outcome of one scene's pass through the pipeline. */
export interface SceneOutcome {
  readonly sceneId: string;
  /** null when the scene was fully restart-skipped (no drafting needed). */
  readonly mode: DraftMode | null;
  readonly draftedUnitIds: readonly string[];
  readonly skippedUnitIds: readonly string[];
  readonly reviewPlan: ReviewPlan | null;
  readonly bundle: DefectBundle | null;
  readonly corrections: CorrectionSummary | null;
  readonly finalized: readonly FinalizedUnit[];
}

/** The full run report — the proof surface for the control-flow guarantees. */
export interface WorkflowRunReport {
  readonly policy: ResolvedRunPolicy;
  readonly schedule: CoherenceSchedule;
  readonly scenes: readonly SceneOutcome[];
  readonly finalized: readonly FinalizedUnit[];
  readonly patchId: string | null;
  readonly buildLqa: readonly LaneVerdict[];
  readonly attemptLineage: readonly AttemptLineageEntry[];
}

/** Choose the draft path: whole-scene when it fits the budget, else chunked. Both
 * are real P1 paths; neither is a fallback. */
function chooseDraftMode(unitCount: number, options: WorkflowOptions): DraftMode {
  const limit = options.wholeSceneMaxUnits ?? DEFAULT_WHOLE_SCENE_MAX_UNITS;
  return unitCount <= limit ? "whole-scene" : "overlapping-chunk";
}

/** Drive one scene through readiness → draft → gates → review → join →
 * corrections → finalize, producing ONLY the units not already finalized. */
async function processScene(
  scene: WorkflowScene,
  policy: ResolvedRunPolicy,
  ports: WorkflowPorts,
  options: WorkflowOptions,
): Promise<SceneOutcome> {
  const allUnitIds = scene.units.map((unit) => unit.unitId);
  // (12a) Restart-queries-missing: produce ONLY the units without a final head.
  const missing = await missingStageUnits(ports.store, allUnitIds, "final");
  const missingSet = new Set(missing);
  const skippedUnitIds = allUnitIds.filter((unitId) => !missingSet.has(unitId));
  if (missing.length === 0) {
    return {
      sceneId: scene.sceneId,
      mode: null,
      draftedUnitIds: [],
      skippedUnitIds,
      reviewPlan: null,
      bundle: null,
      corrections: null,
      finalized: [],
    };
  }

  const subScene: WorkflowScene = {
    sceneId: scene.sceneId,
    units: scene.units.filter((unit) => missingSet.has(unit.unitId)),
  };

  // (1) Readiness FIRST — a missing required bible entry blocks the draft.
  const readiness = await resolveSceneReadiness(subScene, ports.readiness);

  // (2) Draft — whole-scene OR overlapping-chunk — through a memoized physical
  // step so every attempt is counted and a restart hit is skipped (12c).
  const mode = chooseDraftMode(subScene.units.length, options);
  const draftKey = stableDigest("draft", scene.sceneId, mode, missing);
  const draftStep = await ports.store.runMemoizedStep(draftKey, () =>
    ports.draft.draftScene({
      scene: subScene,
      mode,
      bibleRenderingIdsByUnit: readiness.bibleRenderingIdsByUnit,
      bibleBindingsByUnit: readiness.bibleBindingsByUnit,
    }),
  );
  const drafted: DraftedScene = draftStep.value;
  assertDraftCoverage(drafted, missing);

  // (3) Deterministic gates on each draft — gate defects are deterministic faults.
  const gateReport = await ports.gates.evaluate(drafted);

  // (4) Risk routing + stratified review — the plan selects lanes per stratum.
  const identity = new Map(
    subScene.units.map((unit) => [
      unit.unitId,
      { speakerId: unit.speakerId, routeId: unit.routeId, firstAppearance: unit.firstAppearance },
    ]),
  );
  const reviewPlan = planStratifiedReview(drafted, gateReport.defects, identity);

  // Run the selected lanes in PARALLEL, each through a memoized step.
  const laneVerdicts = await runStratifiedReview(drafted, reviewPlan, ports);

  // (5) Deterministic finding join — order-independent, facts dominate.
  const bundle = joinFindings({
    localizationSnapshotId: drafted.batches[0]?.localizationSnapshotId ?? draftKey,
    draftBatchId: drafted.batches[0]?.batchId ?? `${scene.sceneId}:draft`,
    deterministic: gateReport.defects,
    evaluatedGates: gateReport.evaluatedGates,
    reviews: laneVerdicts,
  });

  // (6/7/8) Corrections: P2/P3, rerun-only-implicated, bounded adjudication.
  const corrections =
    bundle.defects.length > 0
      ? await applyCorrections({
          bundle,
          scene: drafted,
          verdicts: laneVerdicts,
          repair: ports.repair,
          review: ports.review,
          adjudicate: ports.adjudicate,
        })
      : null;

  // (9) Independent per-unit CAS finalize — gated by the run policy.
  const { finalized } = await finalizeUnits(
    ports.store,
    policy,
    drafted.units.map((unit) => ({
      unitId: unit.unitId,
      contentHash: stableSha(scene.sceneId, unit.unitId, unit.draft.targetSkeleton),
    })),
  );

  return {
    sceneId: scene.sceneId,
    mode,
    draftedUnitIds: drafted.units.map((unit) => unit.unitId),
    skippedUnitIds,
    reviewPlan,
    bundle,
    corrections,
    finalized,
  };
}

/** Run the stratified review plan: each selected lane over its selected units,
 * lanes in parallel, each a memoized physical step. */
async function runStratifiedReview(
  scene: DraftedScene,
  plan: ReviewPlan,
  ports: WorkflowPorts,
): Promise<readonly LaneVerdict[]> {
  const laneJobs = [...plan.unitsByLane.entries()].map(async ([lane, unitIds]) => {
    const key = stableDigest("review", scene.sceneId, lane, unitIds);
    const step = await ports.store.runMemoizedStep(key, () =>
      ports.review.review({ lane, scene, unitIds }),
    );
    return step.value;
  });
  const perLane = await Promise.all(laneJobs);
  return perLane.flat();
}

/** A stable content hash for a finalized unit — deterministic, no clock. */
function stableSha(...parts: readonly string[]): `sha256:${string}` {
  return `sha256:${stableDigest("unit-final", ...parts)}`;
}

/** The draft must cover exactly the missing units — an under- or over-covering
 * draft is a control-flow bug, not a role-output fault. */
function assertDraftCoverage(scene: DraftedScene, missing: readonly string[]): void {
  const drafted = new Set(scene.units.map((unit) => unit.unitId));
  if (drafted.size !== missing.length || missing.some((unitId) => !drafted.has(unitId))) {
    throw new WorkflowSequenceError(
      `scene ${scene.sceneId} draft covered ${drafted.size} units but ${missing.length} were requested`,
    );
  }
}

/**
 * Run the whole localization workflow for a request over a set of scenes. The
 * policy is resolved first; scenes are driven concurrently (independent work
 * stays parallel) while each scene's units are serialized; the finalized units
 * flow to patch export and then the downstream Build-LQA review.
 */
export async function runLocalizationWorkflow(
  request: RunPolicyRequest,
  scenes: readonly WorkflowScene[],
  ports: WorkflowPorts,
  options: WorkflowOptions = {},
): Promise<WorkflowRunReport> {
  // Gate: resolve the policy FIRST. An illegal run never reaches a scene.
  const policy = resolveWorkflowPolicy(request);
  const schedule = coherenceSchedule(scenes);

  // Independent scenes run in parallel; each scene serializes its own units.
  const sceneOutcomes = await Promise.all(
    scenes.map((scene) => processScene(scene, policy, ports, options)),
  );

  const finalized = sceneOutcomes.flatMap((outcome) => outcome.finalized);

  // (10) Patchback — finalized units flow to patch export.
  let patchId: string | null = null;
  let buildLqa: readonly LaneVerdict[] = [];
  if (finalized.length > 0) {
    const exported = await ports.patchback.exportPatch({ finalized });
    patchId = exported.patchId;
    // (11) Downstream Q5 Build-LQA — strictly AFTER patch export, on the patched
    // result.
    buildLqa = await ports.patchback.buildLqaReview({
      patchId,
      unitIds: finalized.map((unit) => unit.unitId),
    });
  }

  return {
    policy,
    schedule,
    scenes: sceneOutcomes,
    finalized,
    patchId,
    buildLqa,
    attemptLineage: ports.store.attemptLineage(),
  };
}
