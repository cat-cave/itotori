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

import type { Defect, DefectBundle } from "../contracts/index.js";
import { stableDigest } from "../gates/index.js";
import type { ResolvedRunPolicy, RunPolicyRequest } from "../run-policy/index.js";
import { applyCorrections, type CorrectionSummary } from "./correction.js";
import { coherenceSchedule, missingStageUnits, type CoherenceSchedule } from "./durability.js";
import { finalizeUnits } from "./finalize.js";
import { joinFindings } from "./finding-join.js";
import { projectOutputScope } from "./output-scope.js";
import { mayShip, resolveWorkflowPolicy } from "./policy.js";
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

/** The two legal executions of the one workflow driver. The policy, rather than
 * a caller switch, selects the execution: only the explicit test-dev ablation
 * reaches the null-Wiki/direct/zero-QA branch. */
interface WorkflowExecution {
  readonly needsBibleReadiness: boolean;
  readonly runsModelQa: boolean;
  readonly runsBuildLqa: boolean;
}

const QUALIFYING_EXECUTION: WorkflowExecution = {
  needsBibleReadiness: true,
  runsModelQa: true,
  runsBuildLqa: true,
};

const PURE_MTL_EXECUTION: WorkflowExecution = {
  needsBibleReadiness: false,
  runsModelQa: false,
  runsBuildLqa: false,
};

/** The literal null Wiki passed to direct P1. Keeping this shared frozen map
 * makes it impossible for an ablation scene to inherit a rendering id. */
const NULL_WIKI_BIBLE: ReadonlyMap<string, readonly string[]> = new Map();
const PURE_MTL_ATTEMPT_PREFIX = "pure-mtl:";

function executionFor(policy: ResolvedRunPolicy): WorkflowExecution {
  return policy.bibleBasis === "pure-mtl-ablation" ? PURE_MTL_EXECUTION : QUALIFYING_EXECUTION;
}

/** Physical workflow steps for the control arm live under an explicit namespace.
 * The qualifier's historic keys remain unchanged; it additionally filters this
 * namespace out when projecting its own lineage report. */
function memoKeyFor(policy: ResolvedRunPolicy, ...parts: readonly unknown[]): string {
  const key = stableDigest(...parts);
  return policy.bibleBasis === "pure-mtl-ablation" ? `${PURE_MTL_ATTEMPT_PREFIX}${key}` : key;
}

function reportAttemptLineage(
  policy: ResolvedRunPolicy,
  ports: WorkflowPorts,
): readonly AttemptLineageEntry[] {
  const attempts = ports.store.attemptLineage();
  return policy.bibleBasis === "pure-mtl-ablation"
    ? attempts.filter((attempt) => attempt.memoKey.startsWith(PURE_MTL_ATTEMPT_PREFIX))
    : attempts.filter((attempt) => !attempt.memoKey.startsWith(PURE_MTL_ATTEMPT_PREFIX));
}

/** The outcome of one scene's pass through the pipeline. */
export interface SceneOutcome {
  readonly sceneId: string;
  /** null when the scene was fully restart-skipped (no drafting needed). */
  readonly mode: DraftMode | null;
  readonly draftedUnitIds: readonly string[];
  readonly skippedUnitIds: readonly string[];
  /** Deterministic findings always run. In the direct control arm they are
   * reported but deliberately do not trigger model review or repair. */
  readonly deterministicDefects: readonly Defect[];
  readonly reviewPlan: ReviewPlan | null;
  readonly bundle: DefectBundle | null;
  readonly corrections: CorrectionSummary | null;
  readonly finalized: readonly FinalizedUnit[];
}

/** The full run report — the proof surface for the control-flow guarantees. */
export interface WorkflowRunReport {
  readonly policy: ResolvedRunPolicy;
  readonly schedule: CoherenceSchedule;
  /** Units deliberately outside the independently selected output tier. They
   * remain part of whole-game context; no draft or final head was attempted. */
  readonly excludedOutputUnitIds: readonly string[];
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
  const execution = executionFor(policy);
  const allUnitIds = scene.units.map((unit) => unit.unitId);
  // (12a) Restart-queries-missing: produce ONLY the units without a final head.
  const finalHeads = await Promise.all(
    allUnitIds.map(async (unitId) => ({
      unitId,
      head: await ports.store.readUnitHead(unitId, "final"),
    })),
  );
  const missing = finalHeads.flatMap(({ unitId, head }) => (head === null ? [unitId] : []));
  const missingSet = new Set(missing);
  const skippedUnitIds = allUnitIds.filter((unitId) => !missingSet.has(unitId));
  const alreadyFinalized: FinalizedUnit[] = finalHeads.flatMap(({ unitId, head }) =>
    head === null ? [] : [{ unitId, ref: head, shippable: mayShip(policy) }],
  );
  if (missing.length === 0) {
    return {
      sceneId: scene.sceneId,
      mode: null,
      draftedUnitIds: [],
      skippedUnitIds,
      deterministicDefects: [],
      reviewPlan: null,
      bundle: null,
      corrections: null,
      // A restart still needs every current head to construct (or memo-hit) the
      // complete patch; never silently emit a patch containing only new units.
      finalized: alreadyFinalized,
    };
  }

  const subScene: WorkflowScene = {
    sceneId: scene.sceneId,
    units: scene.units.filter((unit) => missingSet.has(unit.unitId)),
  };

  // (1) Wiki-first runs resolve the exact localized bible before drafting. The
  // policy-selected pure-MTL control is the sole exception: it passes the
  // concrete null Wiki directly to P1 and does not touch the readiness port.
  const readiness = execution.needsBibleReadiness
    ? await resolveSceneReadiness(subScene, ports.readiness)
    : { bibleRenderingIdsByUnit: NULL_WIKI_BIBLE, bibleBindingsByUnit: undefined };

  // (2) Draft — whole-scene OR overlapping-chunk — through a memoized physical
  // step so every attempt is counted and a restart hit is skipped (12c).
  const mode = chooseDraftMode(subScene.units.length, options);
  const draftKey = memoKeyFor(policy, "draft", scene.sceneId, mode, missing);
  const draftStep = await ports.store.runMemoizedStep(draftKey, () =>
    ports.draft.draftScene({
      scene: subScene,
      mode,
      bibleRenderingIdsByUnit: readiness.bibleRenderingIdsByUnit,
      ...(readiness.bibleBindingsByUnit === undefined
        ? {}
        : { bibleBindingsByUnit: readiness.bibleBindingsByUnit }),
      bibleBasis: policy.bibleBasis,
    }),
  );
  const drafted: DraftedScene = draftStep.value;
  assertDraftCoverage(drafted, missing);
  assertDraftBasis(drafted, policy);

  // (3) Deterministic gates on each draft — gate defects are deterministic faults.
  const gateReport = await ports.gates.evaluate(drafted);

  let reviewPlan: ReviewPlan | null = null;
  let bundle: DefectBundle | null = null;
  let corrections: CorrectionSummary | null = null;
  if (execution.runsModelQa) {
    // (4) Risk routing + stratified review — the plan selects lanes per stratum.
    const identity = new Map(
      subScene.units.map((unit) => [
        unit.unitId,
        { speakerId: unit.speakerId, routeId: unit.routeId, firstAppearance: unit.firstAppearance },
      ]),
    );
    reviewPlan = planStratifiedReview(drafted, gateReport.defects, identity);

    // Run the selected lanes in PARALLEL, each through a memoized step.
    const laneVerdicts = await runStratifiedReview(drafted, reviewPlan, policy, ports);

    // (5) Deterministic finding join — order-independent, facts dominate.
    bundle = joinFindings({
      localizationSnapshotId: drafted.batches[0]?.localizationSnapshotId ?? draftKey,
      draftBatchId: drafted.batches[0]?.batchId ?? `${scene.sceneId}:draft`,
      deterministic: gateReport.defects,
      evaluatedGates: gateReport.evaluatedGates,
      reviews: laneVerdicts,
    });

    // (6/7/8) Corrections: P2/P3, rerun-only-implicated, bounded adjudication.
    corrections =
      bundle.defects.length > 0
        ? await applyCorrections({
            bundle,
            scene: drafted,
            verdicts: laneVerdicts,
            repair: ports.repair,
            review: ports.review,
            adjudicate: ports.adjudicate,
            store: ports.store,
          })
        : null;
  }

  // (9) Independent per-unit CAS finalize — gated by the run policy.
  const unresolved = new Set(corrections?.unresolvedUnitIds ?? []);
  const { finalized } = await finalizeUnits(
    ports.store,
    policy,
    drafted.units
      .filter((unit) => !unresolved.has(unit.unitId))
      .map((unit) => ({
        unitId: unit.unitId,
        contentHash: stableSha(scene.sceneId, unit.unitId, unit.draft.targetSkeleton),
      })),
  );

  return {
    sceneId: scene.sceneId,
    mode,
    draftedUnitIds: drafted.units.map((unit) => unit.unitId),
    skippedUnitIds,
    deterministicDefects: gateReport.defects,
    reviewPlan,
    bundle,
    corrections,
    finalized: [...alreadyFinalized, ...finalized],
  };
}

/** Run the stratified review plan: each selected lane over its selected units,
 * lanes in parallel, each a memoized physical step. */
async function runStratifiedReview(
  scene: DraftedScene,
  plan: ReviewPlan,
  policy: ResolvedRunPolicy,
  ports: WorkflowPorts,
): Promise<readonly LaneVerdict[]> {
  const laneJobs = [...plan.unitsByLane.entries()].map(async ([lane, unitIds]) => {
    const key = memoKeyFor(policy, "review", scene.sceneId, lane, unitIds);
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

/** A policy-selected direct run must not accept a wiki-grounded draft, and a
 * qualifying run must not silently bypass its bible. This is checked before
 * deterministic gates/finalize, independent of the P1 adapter. */
function assertDraftBasis(scene: DraftedScene, policy: ResolvedRunPolicy): void {
  for (const unit of scene.units) {
    const basis = unit.draft.basis;
    if (basis.kind !== policy.bibleBasis) {
      throw new WorkflowSequenceError(
        `unit ${unit.unitId} draft basis '${basis.kind}' does not match policy '${policy.bibleBasis}'`,
      );
    }
    if (basis.kind === "pure-mtl-ablation" && basis.bibleRenderingIds.length !== 0) {
      throw new WorkflowSequenceError(`unit ${unit.unitId} direct draft carried a bible rendering`);
    }
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
  return await runLocalizationWorkflowForPolicy(policy, scenes, ports, options);
}

/**
 * Drive the same artifact workflow from an already-resolved policy. The
 * ablation entrypoint uses this after it pins and validates the sanctioned
 * selector; ordinary callers use `runLocalizationWorkflow` above. There is no
 * second ablation control flow: `executionFor(policy)` configures this driver.
 */
export async function runLocalizationWorkflowForPolicy(
  policy: ResolvedRunPolicy,
  scenes: readonly WorkflowScene[],
  ports: WorkflowPorts,
  options: WorkflowOptions = {},
): Promise<WorkflowRunReport> {
  const execution = executionFor(policy);
  const output = projectOutputScope(scenes, policy.outputScope);
  const schedule = coherenceSchedule(output.scenes);

  // Independent scenes run in parallel; each scene serializes its own units.
  const sceneOutcomes = await Promise.all(
    output.scenes.map((scene) => processScene(scene, policy, ports, options)),
  );

  const finalized = sceneOutcomes.flatMap((outcome) => outcome.finalized);

  // (10) Patchback — finalized units flow to patch export.
  let patchId: string | null = null;
  let buildLqa: readonly LaneVerdict[] = [];
  if (finalized.length > 0) {
    const patchKey = memoKeyFor(
      policy,
      "patchback",
      ...[...finalized]
        .sort((left, right) => (left.unitId < right.unitId ? -1 : 1))
        .map((unit) => `${unit.unitId}:${unit.ref.contentHash}:${unit.ref.version}`),
    );
    const exported = await ports.store.runMemoizedStep(patchKey, () =>
      ports.patchback.exportPatch({ finalized }),
    );
    const currentPatchId = exported.value.patchId;
    patchId = currentPatchId;
    if (execution.runsBuildLqa) {
      // (11) Downstream Q5 Build-LQA — strictly AFTER patch export, on the patched
      // result. Its per-unit stage heads make a restart dispatch only units whose
      // on-screen assessment is absent; the review result itself is memoized too.
      const missingBuildLqa = await missingStageUnits(
        ports.store,
        finalized.map((unit) => unit.unitId),
        "build-lqa",
      );
      if (missingBuildLqa.length > 0) {
        const q5Key = memoKeyFor(policy, "build-lqa", currentPatchId, ...missingBuildLqa);
        const reviewed = await ports.store.runMemoizedStep(q5Key, () =>
          ports.patchback.buildLqaReview({ patchId: currentPatchId, unitIds: missingBuildLqa }),
        );
        buildLqa = reviewed.value;
        await Promise.all(
          missingBuildLqa.map((unitId) =>
            ports.store.finalizeUnit({
              unitId,
              stage: "build-lqa",
              contentHash: stableSha(
                "build-lqa",
                currentPatchId,
                unitId,
                ...buildLqa
                  .filter((verdict) => verdict.verdict.unitId === unitId)
                  .map((verdict) => verdict.verdict.reviewId)
                  .sort(),
              ),
              shippable: mayShip(policy),
            }),
          ),
        );
      }
    }
  }

  return {
    policy,
    schedule,
    excludedOutputUnitIds: output.excludedUnitIds,
    scenes: sceneOutcomes,
    finalized,
    patchId,
    buildLqa,
    attemptLineage: reportAttemptLineage(policy, ports),
  };
}
