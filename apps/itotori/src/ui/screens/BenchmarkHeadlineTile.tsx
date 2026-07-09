// ovw-benchmark-headline-ui — the Overview screen's benchmark headline tile.
//
// A compact tile WITHIN the Workbench dashboard (not a new route): where
// 'self' stands vs the benchmark contestants (official / self / self_nocontext
// / fan / mtl) + the §8 panel↔human confidence + a strong-caliber VERDICT,
// sourced from the `projects.bmkCockpit` read model THROUGH the typed client
// (`useApiQuery`, never an ad-hoc fetch). It paints each contestant's standing
// verbatim from the cockpit — no fabricated numbers (an unscored contestant
// renders `null`-honestly as "—", never a zero). Independent loading / empty /
// error surfaces, the same way {@link ProgressInstrumentPanel} and
// {@link PassLedgerPanel} paint their panels. ClassName-based, ds tokens, no
// literal styles, no game named. [[feedback_behavior_first_code_agnostic_testing]].
//
// The cockpit route is project-scoped; the project identity comes from the
// composed `projects.overview` read model (the same read the sibling Overview
// panels issue), so this tile waits for the overview's `projectId` before
// issuing the cockpit read — mirroring how the dashboard's reviewer-queue
// panel waits on `projects.status` for its `selectedLocaleBranchId`.

import type { ReactNode } from "react";
import { Badge, Panel, StatReadout } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type {
  BmkCockpitConfidence,
  BmkCockpitContestantRole,
  BmkCockpitReadModel,
} from "../../bmk-cockpit-read-model.js";
import type { ProjectOverviewReadModel } from "../../project-overview-read-model.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";

// ---------------------------------------------------------------------------
// Pure derivation — the verdict + the per-contestant view-model.
// ---------------------------------------------------------------------------

/**
 * The §9.3 panel↔human calibration floor the §10 strong-caliber-readiness-gate
 * applies (`minPanelHumanPearson`, default 0.6). The headline verdict reuses
 * the SAME documented floor so the tile's verdict never drifts from the gate.
 */
export const BENCHMARK_STRONG_CALIBER_CONFIDENCE_FLOOR = 0.6;

/**
 * The headline verdict the tile paints — a product status token (drawn from
 * the closed {@link STATUS_VOCABULARY} so the ds Badge derives its tone) plus
 * a short, sourced justification naming the exact signals that drove it. The
 * verdict is a READ on where 'self' stands, never an action.
 */
export type BenchmarkVerdictStatus = "proven" | "in_review" | "drafting" | "pending";

export type BenchmarkVerdict = {
  status: BenchmarkVerdictStatus;
  reason: string;
};

/** Human-readable label for each cockpit contestant role (no game named). */
export const BENCHMARK_CONTESTANT_LABELS: Readonly<Record<BmkCockpitContestantRole, string>> = {
  official: "Official",
  self: "Self",
  self_nocontext: "Self (no context)",
  fan: "Fan",
  mtl: "MTL",
};

export const VERDICT_LABELS: Readonly<Record<BenchmarkVerdictStatus, string>> = {
  proven: "Strong caliber",
  in_review: "In review",
  drafting: "Drafting",
  pending: "Pending",
};

/**
 * Derive the headline strong-caliber verdict from the cockpit read model.
 * Pure + deterministic; aligns with the §10 strong-caliber-readiness-gate
 * semantics using ONLY the signals the cockpit exposes (self's rank among the
 * contestants + the §8 panel↔human confidence). A run with no calibrated human
 * signal (`confidence.basis === "none"`) or no scored self is `pending` — never
 * a fabricated strong-caliber claim (a self-favorable benchmark cannot rig the
 * external §8 anchor, so a verdict without it is honest indeterminacy).
 */
export function deriveBenchmarkVerdict(cockpit: BmkCockpitReadModel): BenchmarkVerdict {
  const selfRole = cockpit.contestants.find((c) => c.role === "self") ?? null;
  if (selfRole === null || selfRole.aggregateScore === null || selfRole.rank === null) {
    return { status: "pending", reason: "No scored self contestant yet." };
  }
  const confidence = cockpit.confidence;
  if (confidence.basis === "none" || confidence.value === null) {
    return { status: "pending", reason: "Awaiting the §8 panel↔human calibration." };
  }
  const calibrated = confidence.value >= BENCHMARK_STRONG_CALIBER_CONFIDENCE_FLOOR;
  const contestantCount = cockpit.contestants.length;
  if (selfRole.rank === 0 && calibrated) {
    return {
      status: "proven",
      reason: `Self leads the field, calibrated by ${confidence.basis} ${formatPercent(confidence.value)}.`,
    };
  }
  if (selfRole.rank === 0) {
    return {
      status: "in_review",
      reason: `Self leads, but panel↔human ${confidence.basis} ${formatPercent(
        confidence.value,
      )} is below the ${formatPercent(BENCHMARK_STRONG_CALIBER_CONFIDENCE_FLOOR)} floor.`,
    };
  }
  return {
    status: "drafting",
    reason: `Self ranks ${selfRole.rank + 1} of ${contestantCount}; not yet the strongest contestant.`,
  };
}

/**
 * True when the cockpit carries no scored signal at all — the honest empty
 * case (a run recorded but scored zero items, so neither a contestant standing
 * nor a confidence exists). PROJECT LAW: this is a real empty, not a degraded
 * ready — the tile surfaces the empty surface rather than a fabricated zeroed row.
 */
export function isBenchmarkHeadlineEmpty(cockpit: BmkCockpitReadModel): boolean {
  const noConfidence = cockpit.confidence.basis === "none";
  const noScoredContestant = cockpit.contestants.every((c) => c.aggregateScore === null);
  return noConfidence && noScoredContestant;
}

/** Per-contestant view-model for the headline comparison list. */
export type BenchmarkContestantRow = {
  role: BmkCockpitContestantRole;
  label: string;
  aggregateScoreLabel: string;
  rankLabel: string;
  isSelf: boolean;
};

/**
 * Project the cockpit's contestants into the ranked headline rows. The
 * cockpit's `rankedRoles` (best → worst) orders the list so 'self's standing
 * vs the field is read top-to-bottom; a degenerate ranking falls back to the
 * canonical vocabulary order. Pure + deterministic.
 */
export function benchmarkContestantRows(cockpit: BmkCockpitReadModel): BenchmarkContestantRow[] {
  const order: readonly BmkCockpitContestantRole[] =
    cockpit.rankedRoles.length > 0 ? cockpit.rankedRoles : cockpit.contestants.map((c) => c.role);
  const byRole = new Map(cockpit.contestants.map((c) => [c.role, c] as const));
  return order.map((role) => {
    const contestant = byRole.get(role) ?? null;
    return {
      role,
      label: BENCHMARK_CONTESTANT_LABELS[role],
      aggregateScoreLabel: formatScore(contestant?.aggregateScore ?? null),
      rankLabel: formatRank(contestant?.rank ?? null),
      isSelf: role === "self",
    };
  });
}

function formatScore(value: number | null): string {
  return value === null ? "—" : formatPercent(value);
}

function formatRank(rank: number | null): string {
  return rank === null ? "—" : `#${rank + 1}`;
}

function formatConfidence(confidence: BmkCockpitConfidence): string {
  if (confidence.value === null) {
    return "—";
  }
  return formatPercent(confidence.value);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// ---------------------------------------------------------------------------
// Tile — owns its reads through the typed client. The cockpit read is
// project-scoped, so the tile waits on the composed `projects.overview` for
// the projectId (the same read the sibling Overview panels issue). Each read
// settles independently via the api-client's per-depsKey cache.
// ---------------------------------------------------------------------------

/**
 * The Overview benchmark headline tile — Self vs official / fan / MTL
 * contestants + the §8 panel↔human confidence + a strong-caliber verdict,
 * sourced from the `projects.bmkCockpit` read model through the typed client.
 * Renders loading / empty / error surfaces independently of the other
 * dashboard panels.
 */
export function BenchmarkHeadlineTile(): ReactNode {
  const overview = useApiQuery("projects.overview", {}, "overview");
  return <BenchmarkHeadlineShell overview={overview} />;
}

/**
 * The ONE stable panel surface. The title bar (and its heading) stays mounted
 * across every state transition — only the body switches between the overview
 * surface (while the project identity is unresolved) and the cockpit subtree
 * (once it is). This mirrors {@link PassLedgerPanel}'s stable title bar so a
 * behavior-first test can resolve the heading without it detaching on the
 * loading → ready transition.
 */
function BenchmarkHeadlineShell({
  overview,
}: {
  overview: ApiCallState<ProjectOverviewReadModel>;
}): ReactNode {
  const projectId = overview.state === "ready" ? overview.data.projectId : null;
  return (
    <Panel
      title="Benchmark headline"
      eyebrow="Benchmark"
      className="itotori-panel--benchmark-headline"
      data-panel-state={overview.state}
    >
      {projectId === null ? (
        <BenchmarkHeadlineOverviewSurface overview={overview} />
      ) : (
        <BenchmarkHeadlineCockpit projectId={projectId} />
      )}
    </Panel>
  );
}

function BenchmarkHeadlineOverviewSurface({
  overview,
}: {
  overview: ApiCallState<ProjectOverviewReadModel>;
}): ReactNode {
  if (overview.state === "loading") {
    return <LoadingState label="Loading benchmark headline…" />;
  }
  if (overview.state === "error") {
    return <ErrorState title="Benchmark headline" error={overview.error} />;
  }
  return (
    <EmptyState
      title="Benchmark headline"
      message="No project context is available to scope the benchmark cockpit."
    />
  );
}

function BenchmarkHeadlineCockpit({ projectId }: { projectId: string }): ReactNode {
  const cockpit = useApiQuery(
    "projects.bmkCockpit",
    { pathParams: { projectId } },
    `bmk-cockpit:${projectId}`,
  );
  return <BenchmarkHeadlineCockpitContent cockpit={cockpit} />;
}

/**
 * The cockpit state surface. Exported so a behavior-first test can mount the
 * resolved-content body directly over a pre-settled cockpit state.
 */
export function BenchmarkHeadlineCockpitContent({
  cockpit,
}: {
  cockpit: ApiCallState<BmkCockpitReadModel>;
}): ReactNode {
  if (cockpit.state === "loading") {
    return <LoadingState label="Loading benchmark headline…" />;
  }
  if (cockpit.state === "error") {
    return <ErrorState title="Benchmark headline" error={cockpit.error} />;
  }
  if (cockpit.state === "empty" || isBenchmarkHeadlineEmpty(cockpit.data)) {
    return (
      <EmptyState
        title="Benchmark headline"
        message="No benchmark runs have been scored for this project yet."
      />
    );
  }
  return <BenchmarkHeadlineTileReady cockpit={cockpit.data} />;
}

function BenchmarkHeadlineTileReady({ cockpit }: { cockpit: BmkCockpitReadModel }): ReactNode {
  const verdict = deriveBenchmarkVerdict(cockpit);
  const rows = benchmarkContestantRows(cockpit);
  const selfRow = rows.find((row) => row.isSelf) ?? null;
  return (
    <>
      <div className="itotori-metric-row" aria-label="Benchmark headline aggregate">
        <StatReadout label="Self standing" value={selfRow?.aggregateScoreLabel ?? "—"} />
        <StatReadout label="Confidence" value={formatConfidence(cockpit.confidence)} />
        <StatReadout label="Units scored" value={cockpit.unitsScored} />
      </div>
      <p className="itotori-benchmark-verdict" data-verdict={verdict.status}>
        <Badge status={verdict.status}>{VERDICT_LABELS[verdict.status]}</Badge>
        <span className="itotori-benchmark-verdict__reason">{verdict.reason}</span>
      </p>
      <ul className="itotori-benchmark-contestants" aria-label="Benchmark contestants">
        {rows.map((row) => (
          <li
            key={row.role}
            className="itotori-benchmark-contestants__row"
            data-contestant={row.role}
            data-self={row.isSelf ? "true" : "false"}
          >
            <span className="itotori-benchmark-contestants__label">{row.label}</span>
            <span className="itotori-benchmark-contestants__score">{row.aggregateScoreLabel}</span>
            <span className="itotori-benchmark-contestants__rank">{row.rankLabel}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
