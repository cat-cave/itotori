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
import type { AdjudicatePort, RepairPort, ReviewPort } from "./ports.js";
import { implicatedRerun, type RerunScope } from "./rerun-scope.js";
import type { DraftedScene } from "./types.js";

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

/**
 * Route a bundle's defects through P2/P3 corrections, re-running only the
 * implicated lanes after each repair and firing the bounded adjudicator at most
 * once per contested unit.
 */
export async function applyCorrections(input: {
  readonly bundle: DefectBundle;
  readonly scene: DraftedScene;
  readonly repair: RepairPort;
  readonly review: ReviewPort;
  readonly adjudicate: AdjudicatePort;
}): Promise<CorrectionSummary> {
  const { bundle, scene } = input;
  const corrections: CorrectionRecord[] = [];
  const reruns: RerunScope[] = [];
  const rerunLaneCalls: { lane: string; unitIds: readonly string[] }[] = [];
  const adjudicated = new Set<string>();
  let adjudications = 0;

  // The implicated-only rerun after a repair: re-run EXACTLY the lanes the change
  // implicated, over EXACTLY the changed units. An unimplicated lane never runs.
  const rerunImplicated = async (changedUnitIds: readonly string[]): Promise<RerunScope> => {
    const scope = implicatedRerun(bundle, changedUnitIds);
    for (const lane of scope.lanes) {
      await input.review.review({ lane, scene, unitIds: scope.unitIds });
      rerunLaneCalls.push({ lane, unitIds: scope.unitIds });
    }
    return scope;
  };

  const fireAdjudication = async (contestedUnitIds: readonly string[]): Promise<void> => {
    for (const unitId of contestedUnitIds) {
      // BOUNDED: a unit already adjudicated is never adjudicated again.
      if (adjudicated.has(unitId)) continue;
      adjudicated.add(unitId);
      await input.adjudicate.adjudicate({
        unitId,
        defects: bundle.defects.filter((defect) => defect.unitId === unitId),
      });
      adjudications += 1;
    }
  };

  // P2 line-edit — the minor style/format/voice repairs.
  const edit = unitsWith(bundle.defects, (defect) => !MAJOR_SEVERITIES.has(defect.severity));
  if (edit.unitIds.length > 0) {
    const outcome = await input.repair.lineEdit({ unitIds: edit.unitIds, defects: edit.defects });
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
    const outcome = await input.repair.semanticRepair({
      unitIds: repair.unitIds,
      defects: repair.defects,
      repairedDefectLedger: new Set<string>(),
    });
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

  return { corrections, reruns, adjudications, rerunLaneCalls };
}
