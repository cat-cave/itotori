// Correction routing — repair, rerun-only-implicated, and bounded adjudication.
//
// A defect bundle drives corrections in three composed steps:
//   - P2 line-edit for minor style/format/voice defects, P3 semantic-repair for
//     material meaning/continuity defects (clause: P2/P3 applied to findings);
//   - after a repair lands, ONLY the review lanes the change implicated re-run,
//     over ONLY the units the change touched (rerun-only-implicated);
//   - when a semantic repair spends its one bounded attempt it routes to the
//     adjudicator, which fires exactly ONCE per contested unit — never a second
//     time, never an unbounded loop (bounded Q6).

import type { Defect, DefectBundle } from "../contracts/index.js";
import { stableDigest } from "../gates/index.js";
import type { AdjudicatePort, RepairPort, ReviewPort, WorkflowArtifactStore } from "./ports.js";
import { implicatedRerun, type RerunScope } from "./rerun-scope.js";
import type { DraftedScene, LaneVerdict } from "./types.js";

/** One correction the driver applied, with its route and (for a repair) the
 * implicated-only rerun scope it triggered. */
export interface CorrectionRecord {
  readonly kind: "line-edit" | "semantic-repair";
  readonly unitIds: readonly string[];
  readonly route: "repair" | "adjudication";
  readonly rerun: RerunScope | null;
}

/** The result of routing a bundle's defects through corrections. */
export interface CorrectionSummary {
  readonly corrections: readonly CorrectionRecord[];
  readonly reruns: readonly RerunScope[];
  /** How many bounded adjudications fired — one per genuinely contested unit. */
  readonly adjudications: number;
  /** Units that require a human or a further explicitly-started child workflow.
   * They must not receive a final CAS head from this pass. */
  readonly unresolvedUnitIds: readonly string[];
  /** The lanes actually re-run after corrections, over which units — the proof
   * surface for rerun-only-implicated. */
  readonly rerunLaneCalls: readonly {
    readonly lane: string;
    readonly unitIds: readonly string[];
  }[];
}

const MAJOR_SEVERITIES = new Set(["major", "critical"]);

function unitsWith(
  defects: readonly Defect[],
  predicate: (defect: Defect) => boolean,
): {
  readonly unitIds: readonly string[];
  readonly defects: readonly Defect[];
} {
  const matched = defects.filter(predicate);
  const unitIds = [...new Set(matched.map((defect) => defect.unitId))].sort((a, b) =>
    a < b ? -1 : 1,
  );
  return { unitIds, defects: matched };
}

/** A Q6 call is an exception, not a generic repair fallback. Facts must not be
 * re-litigated, and the remaining dispute must be a high-impact FAIL/PASS split
 * between review lanes. CANNOT_ASSESS is not an affirmative position. */
function isGenuineHighImpactContest(
  bundle: DefectBundle,
  unitId: string,
  verdicts: readonly LaneVerdict[],
): boolean {
  const defects = bundle.defects.filter((defect) => defect.unitId === unitId);
  if (defects.some((defect) => defect.origin === "deterministic")) return false;
  const contested = verdicts
    .filter((candidate) => candidate.verdict.unitId === unitId)
    .map((candidate) => candidate.verdict);
  const highImpactFail = contested.some(
    (verdict) =>
      verdict.verdict === "FAIL" &&
      (verdict.severity === "major" || verdict.severity === "critical"),
  );
  const lanes = new Set(contested.map((verdict) => verdict.roleId));
  return (
    highImpactFail && contested.some((verdict) => verdict.verdict === "PASS") && lanes.size > 1
  );
}

/** Keep correction-time model work on the same durable memo/attempt seam as
 * drafting and first-pass review. Direct callers may omit the store for a pure
 * unit proof; the workflow driver always supplies it. */
async function memoized<T>(
  store: WorkflowArtifactStore | undefined,
  keyParts: readonly string[],
  produce: () => Promise<T>,
): Promise<T> {
  if (store === undefined) return await produce();
  const step = await store.runMemoizedStep(stableDigest("workflow-correction", ...keyParts), () =>
    produce(),
  );
  return step.value;
}

/**
 * Route a bundle's defects through P2/P3 corrections, re-running only the
 * implicated lanes after each repair and firing the bounded adjudicator at most
 * once per contested unit.
 */
export async function applyCorrections(input: {
  readonly bundle: DefectBundle;
  readonly scene: DraftedScene;
  /** The lane verdicts that judged this scene — the source of the contested A/B
   * positions the adjudicator weighs. Threaded from the driver so the correction
   * step never re-derives a contest from the defects alone. */
  readonly verdicts: readonly LaneVerdict[];
  readonly repair: RepairPort;
  readonly review: ReviewPort;
  readonly adjudicate: AdjudicatePort;
  /** Supplied by the driver so P2/P3/Q6 and correction reruns are durable,
   * idempotent physical steps too. */
  readonly store?: WorkflowArtifactStore;
}): Promise<CorrectionSummary> {
  const { bundle, scene, verdicts } = input;
  const corrections: CorrectionRecord[] = [];
  const reruns: RerunScope[] = [];
  const rerunLaneCalls: { lane: string; unitIds: readonly string[] }[] = [];
  const adjudicated = new Set<string>();
  const unresolved = new Set<string>();
  let adjudications = 0;

  // The implicated-only rerun after a repair: re-run EXACTLY the lanes the change
  // implicated, over EXACTLY the changed units. An unimplicated lane never runs.
  const rerunImplicated = async (changedUnitIds: readonly string[]): Promise<RerunScope> => {
    const scope = implicatedRerun(bundle, changedUnitIds);
    const reviewed = await Promise.all(
      scope.lanes.map(async (lane) => {
        await memoized(input.store, ["rerun-review", scene.sceneId, lane, ...scope.unitIds], () =>
          input.review.review({ lane, scene, unitIds: scope.unitIds }),
        );
        return { lane, unitIds: scope.unitIds };
      }),
    );
    rerunLaneCalls.push(...reviewed);
    return scope;
  };

  const fireAdjudication = async (contestedUnitIds: readonly string[]): Promise<void> => {
    for (const unitId of contestedUnitIds) {
      // BOUNDED: a unit already adjudicated is never adjudicated again.
      if (adjudicated.has(unitId)) continue;
      if (!isGenuineHighImpactContest(bundle, unitId, verdicts)) {
        // The bounded judge is not a substitute for a factual fix or a missing
        // assessment. Preserve the unit for a human/explicit child workflow.
        unresolved.add(unitId);
        continue;
      }
      adjudicated.add(unitId);
      const disposition = await memoized(
        input.store,
        [
          "adjudicate",
          scene.sceneId,
          unitId,
          ...bundle.defects
            .filter((defect) => defect.unitId === unitId)
            .map((defect) => defect.defectId)
            .sort(),
        ],
        () =>
          input.adjudicate.adjudicate({
            unitId,
            defects: bundle.defects.filter((defect) => defect.unitId === unitId),
            // The two blinded positions live in the verdicts that judged THIS unit.
            contested: verdicts.filter((laneVerdict) => laneVerdict.verdict.unitId === unitId),
          }),
      );
      adjudications += 1;
      if (disposition.disposition !== "finalize") unresolved.add(unitId);
    }
  };

  // P2 line-edit — the minor style/format/voice repairs.
  const edit = unitsWith(bundle.defects, (defect) => !MAJOR_SEVERITIES.has(defect.severity));
  if (edit.unitIds.length > 0) {
    const outcome = await memoized(
      input.store,
      [
        "line-edit",
        scene.sceneId,
        ...edit.unitIds,
        ...edit.defects.map((defect) => defect.defectId).sort(),
      ],
      () =>
        input.repair.lineEdit({
          scene,
          unitIds: edit.unitIds,
          defects: edit.defects,
        }),
    );
    if (outcome.route === "repair") {
      const scope = await rerunImplicated(outcome.changedUnitIds);
      corrections.push({
        kind: "line-edit",
        unitIds: outcome.changedUnitIds,
        route: "repair",
        rerun: scope,
      });
      reruns.push(scope);
    } else {
      await fireAdjudication(outcome.contestedUnitIds);
      corrections.push({
        kind: "line-edit",
        unitIds: outcome.contestedUnitIds,
        route: "adjudication",
        rerun: null,
      });
    }
  }

  // P3 semantic-repair — material meaning/continuity, bounded to one per defect.
  const repair = unitsWith(bundle.defects, (defect) => MAJOR_SEVERITIES.has(defect.severity));
  if (repair.unitIds.length > 0) {
    const outcome = await memoized(
      input.store,
      [
        "semantic-repair",
        scene.sceneId,
        ...repair.unitIds,
        ...repair.defects.map((defect) => defect.defectId).sort(),
      ],
      () =>
        input.repair.semanticRepair({
          scene,
          unitIds: repair.unitIds,
          defects: repair.defects,
          repairedDefectLedger: new Set<string>(),
        }),
    );
    if (outcome.route === "repair") {
      const scope = await rerunImplicated(outcome.changedUnitIds);
      corrections.push({
        kind: "semantic-repair",
        unitIds: outcome.changedUnitIds,
        route: "repair",
        rerun: scope,
      });
      reruns.push(scope);
    } else {
      // The one bounded attempt is spent → adjudicate, exactly once per unit.
      await fireAdjudication(outcome.contestedUnitIds);
      corrections.push({
        kind: "semantic-repair",
        unitIds: outcome.contestedUnitIds,
        route: "adjudication",
        rerun: null,
      });
    }
  }

  return {
    corrections,
    reruns,
    adjudications,
    unresolvedUnitIds: [...unresolved].sort((left, right) => (left < right ? -1 : 1)),
    rerunLaneCalls,
  };
}
