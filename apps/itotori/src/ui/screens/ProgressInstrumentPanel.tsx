// ovw-progress-instrument-ui — the Overview screen's localization progress
// instrument.
//
// A panel WITHIN the Workbench dashboard (not a new route) that renders the
// stage breakouts + iteration cycle + remaining-work readout for the project's
// selected locale branch. It CONSUMES the composed `projects.overview` read
// model THROUGH the typed client (`useApiQuery`) — the same read model that
// composes `progress` (`ProjectDashboardStatus`) + the durable execution journal
// — and settles into loading / empty / error / populated independently, so a
// failed overview read degrades only this panel. Rendered with the `@itotori/ds`
// `LocalizationProgress` instrument + `StatReadout`s (className-based, ds tokens,
// no literal styles, no ad-hoc fetch).
//
// HONESTY / no-fabrication (PROJECT LAW): every number is a real read-model
// field or arithmetic over real fields. The stage funnel is derived from the
// selected branch's aggregate counts (`unitCount` / `translatedUnitCount` /
// `openFindingCount`), which the read model exposes; the cycle comes from the
// durable journal's run count. Two dimensions have NO first-class
// source in the exposed overview read model and are therefore represented
// honestly rather than fabricated:
//   - a distinct per-unit "revised" bucket is not derivable from the branch
//     aggregates (it needs per-unit stage state); the revision DIMENSION is
//     surfaced as the count of prior recorded runs + the cycle counter.
//   - there is NO time-based ETA field; the "eta" slot renders the exact
//     remaining-work unit count (sourced), never an invented completion time.

import type { ReactNode } from "react";
import { LocalizationProgress, Panel, StatReadout } from "@itotori/ds";
import type { LocalizationStage } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type { ProjectOverviewReadModel } from "../../project-overview-read-model.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";

/**
 * The derived progress instrument for a project's selected locale branch. Every
 * field is a real read-model value or arithmetic over real values.
 */
export type ProgressInstrument = {
  localeBranchId: string;
  targetLocale: string;
  /** Total addressable units on the branch (`branch.unitCount`). */
  total: number;
  /** Drafted units (`branch.translatedUnitCount`, clamped to total). */
  drafted: number;
  /** Drafted units currently carrying an open QA finding (`openFindingCount`). */
  inQa: number;
  /** Drafted units with NO open QA finding (drafted - inQa). */
  cleared: number;
  /** Units not yet drafted (total - drafted). */
  pending: number;
  /** Units still needing work before the branch is cleared (inQa + pending). */
  remaining: number;
  /** Disjoint stage segments (sum to total), for the ds segmented bar. */
  stages: LocalizationStage[];
  /** Iteration cycle from the durable journal, or null when no run is recorded. */
  cycle: { current: number; of: number } | null;
  /** Recorded runs before the latest run (an iteration signal). */
  priorRuns: number;
};

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Derive the progress instrument from the composed overview read model. Pure +
 * deterministic. Returns `null` when the project has no locale branch to scope
 * the instrument to (rendered as an empty state).
 */
export function deriveProgressInstrument(
  overview: ProjectOverviewReadModel,
): ProgressInstrument | null {
  const status = overview.progress;
  const branch =
    status.localeBranches.find((b) => b.localeBranchId === status.selectedLocaleBranchId) ??
    status.localeBranches[0] ??
    null;
  if (branch === null) {
    return null;
  }

  const total = Math.max(0, branch.unitCount);
  const drafted = clamp(branch.translatedUnitCount, 0, total);
  const inQa = clamp(branch.openFindingCount, 0, drafted);
  const cleared = drafted - inQa;
  const pending = total - drafted;
  const remaining = inQa + pending;

  // Disjoint funnel: cleared | in-qa | pending sum to total. The ds `proven`
  // key drives the headline %, so the QA-clean-drafted bucket carries it — the
  // read model exposes no first-class per-unit "proven"/ZDR count, so "cleared"
  // (drafted with no open finding) is the honest headline proxy.
  const stages: LocalizationStage[] = [
    { key: "proven", label: "cleared", count: cleared, tone: "mint" },
    { key: "qa", label: "in qa", count: inQa, tone: "amber" },
    { key: "pending", label: "pending", count: pending, tone: "neutral" },
  ];

  const journalRunCount = overview.journal.pagination.total;
  const cycle = journalRunCount > 0 ? { current: journalRunCount, of: journalRunCount } : null;
  const priorRuns = Math.max(0, journalRunCount - 1);

  return {
    localeBranchId: branch.localeBranchId,
    targetLocale: branch.targetLocale,
    total,
    drafted,
    inQa,
    cleared,
    pending,
    remaining,
    stages,
    cycle,
    priorRuns,
  };
}

/**
 * The Overview localization progress instrument panel. Consumes the composed
 * `projects.overview` read model through the typed client and renders the ds
 * `LocalizationProgress` instrument (stage breakouts + cycle + remaining-work),
 * with independent loading / empty / error surfaces.
 */
export function ProgressInstrumentPanel(): ReactNode {
  const overview = useApiQuery("projects.overview", {}, "overview");
  return (
    <Panel
      title="Localization progress"
      eyebrow="Progress"
      className="itotori-panel--progress"
      data-panel-state={overview.state}
    >
      <ProgressInstrumentBody overview={overview} />
    </Panel>
  );
}

function ProgressInstrumentBody({
  overview,
}: {
  overview: ApiCallState<ProjectOverviewReadModel>;
}): ReactNode {
  if (overview.state === "loading") {
    return <LoadingState label="Loading progress…" />;
  }
  if (overview.state === "error") {
    return <ErrorState title="Localization progress" error={overview.error} />;
  }
  // `empty` (no body) and a `ready` project with no locale branch both surface
  // the empty state — never a fabricated zeroed instrument.
  const instrument = overview.state === "ready" ? deriveProgressInstrument(overview.data) : null;
  if (instrument === null) {
    return (
      <EmptyState
        title="No localization progress"
        message="No locale branch is available to scope the progress instrument."
      />
    );
  }
  return <ProgressInstrumentReadout instrument={instrument} />;
}

function ProgressInstrumentReadout({ instrument }: { instrument: ProgressInstrument }): ReactNode {
  const { total, drafted, inQa, cleared, pending, remaining, cycle, priorRuns } = instrument;
  return (
    <div className="itotori-progress-instrument" data-locale-branch-id={instrument.localeBranchId}>
      <LocalizationProgress
        total={total}
        stages={instrument.stages}
        {...(cycle !== null ? { cycle } : {})}
        eta={
          <span data-progress-remaining={remaining}>
            {remaining} unit{remaining === 1 ? "" : "s"} remaining
          </span>
        }
      />
      <div className="itotori-metric-row" aria-label="Progress breakouts">
        <StatReadout label="Total units" value={total} />
        <StatReadout label="Translated" value={drafted} />
        <StatReadout label="In QA" value={inQa} />
        <StatReadout label="Cleared" value={cleared} />
        <StatReadout label="Pending" value={pending} />
        <StatReadout label="Prior runs" value={priorRuns} />
      </div>
    </div>
  );
}
