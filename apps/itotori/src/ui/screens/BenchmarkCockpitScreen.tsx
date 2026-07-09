// bmk-cockpit-ui (HI-FI STUDIO EPIC · Benchmark) — the benchmark cockpit screen.
//
// A full routed surface (rendered INSIDE the shell frame) that paints the
// benchmark cockpit read model as a DIAGNOSTIC INSTRUMENT, not a leaderboard:
//   - the comparative CONTESTANT PALETTE (official / self / self_nocontext /
//     fan / mtl) — each swatch painted from the `--ito-contestant-*` token group
//     so the field reads at a glance and never collapses onto a status hue,
//   - the §8 panel↔human ANCHOR + the headline CONFIDENCE + the strong-caliber
//     verdict (reusing the headline tile's pure derivation so the two surfaces
//     never disagree),
//   - the §10 ACTIONABLE BACKLOG — the cockpit's PRIMARY output: the ranked
//     failure modes + their adjudicated cause + the concrete fix-candidate
//     lever, telling us where to improve (the dyno-not-leaderboard ambition).
//
// Every read goes THROUGH the typed client (`useApiQuery`, never an ad-hoc
// fetch) off the EXISTING gated `projects.bmkCockpit` route — no api-contract /
// api-schema / api-handlers edits. The cockpit route is project-scoped, so the
// screen waits on the composed `projects.overview` read for the projectId (the
// same read the Overview headline tile waits on) before issuing the cockpit
// read. Loading / empty / error settle independently. className-based, ds
// tokens, no literal styles, no game named.
// [[feedback_behavior_first_code_agnostic_testing]]

import type { ReactNode } from "react";
import { Badge, ContestantSwatch, DataTable, Panel, StatReadout } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type {
  BmkCockpitConfidence,
  BmkCockpitContestantRole,
  BmkCockpitReadModel,
  BmkCockpitRunHistoryPage,
  BmkCockpitRunHistoryRow,
} from "../../bmk-cockpit-read-model.js";
import type { BenchmarkImprovementBacklog } from "../../benchmark-stages/index.js";
import type { BacklogItem, BacklogRankTier } from "../../benchmark-stages/actionable-backlog.js";
import type { ProjectOverviewReadModel } from "../../project-overview-read-model.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";
import { BENCHMARK_CONTESTANT_LABELS, deriveBenchmarkVerdict } from "./BenchmarkHeadlineTile.js";

// ---------------------------------------------------------------------------
// Route identity — `/benchmark` (bare). The cockpit route is project-scoped;
// the screen reads the project identity from `projects.overview`, so the bare
// path is all that is dispatched (no query params to parse).
// ---------------------------------------------------------------------------

export const benchmarkCockpitRoutePathRegex = /^\/benchmark\/?$/u;

export function isBenchmarkCockpitRoute(pathname: string): boolean {
  return benchmarkCockpitRoutePathRegex.test(pathname);
}

// ---------------------------------------------------------------------------
// Pure derivation — the cockpit's view-models. Pure + deterministic so a
// behavior-first test can assert the rendered backlog + confidence directly.
// ---------------------------------------------------------------------------

/** Human-readable label for each §10.2 backlog ladder rung. */
export const BACKLOG_RANK_LABELS: Readonly<Record<BacklogRankTier, string>> = {
  top_priority: "Top priority",
  improvement_backlog: "Improvement backlog",
  regression_protection: "Regression protection",
};

/** The ds Badge status each backlog rung maps onto (its diagnostic urgency). */
const BACKLOG_RANK_STATUS: Readonly<Record<BacklogRankTier, "critical" | "ok" | "failed">> = {
  top_priority: "critical",
  improvement_backlog: "failed",
  regression_protection: "ok",
};

const SEVERITY_LABELS: Readonly<Record<string, string>> = {
  critical: "Critical",
  major: "Major",
  minor: "Minor",
  neutral: "Neutral",
};

const CONFIDENCE_BASIS_LABELS: Readonly<Record<BmkCockpitConfidence["basis"], string>> = {
  pearson: "Pearson panel↔human",
  agreement: "agreement rollup",
  none: "no anchor",
};

/** A ranked backlog row projected for the cockpit table. */
export type BenchmarkCockpitBacklogRow = {
  backlogItemId: string;
  priorityOrder: number;
  failureMode: string;
  dimension: string;
  signalSource: BacklogItem["signalSource"];
  rankTier: BacklogRankTier;
  rankLabel: string;
  severityLabel: string;
  cause: string;
  fixCandidate: string;
  scopeDescription: string;
  unitCount: number;
};

/**
 * Project the §10 actionable backlog into the ranked cockpit rows. The backlog
 * IS the cockpit's primary output — the items arrive already ranked by the
 * facility (`priorityOrder`, 0 = top), so this is a pure projection onto the
 * display vocabulary (labels + the diagnostic framing), never a re-rank.
 */
export function benchmarkCockpitBacklogRows(
  cockpit: BmkCockpitReadModel,
): BenchmarkCockpitBacklogRow[] {
  const backlog: BenchmarkImprovementBacklog = cockpit.actionableBacklog;
  return [...backlog.items]
    .sort((a, b) => a.priorityOrder - b.priorityOrder)
    .map((item) => ({
      backlogItemId: item.backlogItemId,
      priorityOrder: item.priorityOrder,
      failureMode: item.failureMode,
      dimension: item.dimension,
      signalSource: item.signalSource,
      rankTier: item.rank,
      rankLabel: BACKLOG_RANK_LABELS[item.rank],
      severityLabel: SEVERITY_LABELS[item.worstSeverity] ?? item.worstSeverity,
      cause: item.cause,
      fixCandidate: item.fixCandidate,
      scopeDescription: item.scope.description,
      unitCount: item.scope.unitCount,
    }));
}

/**
 * The headline confidence label the cockpit paints: the sourced value (prefer
 * Pearson) with the basis that produced it, or an honest "—" when the anchor
 * lacks signal (never a fabricated 0 — a divergent panel cannot self-report).
 */
export function formatCockpitConfidence(confidence: BmkCockpitConfidence): string {
  if (confidence.value === null) {
    return "—";
  }
  return `${formatPercent(confidence.value)} · ${CONFIDENCE_BASIS_LABELS[confidence.basis]}`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatScore(value: number | null): string {
  return value === null ? "—" : formatPercent(value);
}

function formatRank(rank: number | null): string {
  return rank === null ? "—" : `#${rank + 1}`;
}

function formatJudgeMean(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return value.toFixed(1);
}

function formatIsoDate(value: string): string {
  return value.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Screen — owns its reads through the typed client. The cockpit read is
// project-scoped, so the screen waits on `projects.overview` for the projectId
// (the same read the Overview headline tile waits on).
// ---------------------------------------------------------------------------

/**
 * The benchmark cockpit screen — contestants (palette) + human anchor +
 * confidence + the actionable backlog, sourced from the `projects.bmkCockpit`
 * read model through the typed client. Rendered inside the shell frame.
 */
export function BenchmarkCockpitScreen(): ReactNode {
  const overview = useApiQuery("projects.overview", {}, "bmk-cockpit:overview");
  return <BenchmarkCockpitShell overview={overview} />;
}

function BenchmarkCockpitShell({
  overview,
}: {
  overview: ApiCallState<ProjectOverviewReadModel>;
}): ReactNode {
  const projectId = overview.state === "ready" ? overview.data.projectId : null;
  return (
    <main className="itotori-shell" data-screen="benchmark-cockpit" data-state={overview.state}>
      <ShellHeader eyebrow="Benchmark" title="Benchmark cockpit">
        <p className="itotori-shell__lede">
          A diagnostic instrument — where to improve, not a leaderboard.
        </p>
      </ShellHeader>
      {projectId === null ? (
        <BenchmarkCockpitOverviewSurface overview={overview} />
      ) : (
        <BenchmarkCockpitBody projectId={projectId} />
      )}
    </main>
  );
}

function BenchmarkCockpitOverviewSurface({
  overview,
}: {
  overview: ApiCallState<ProjectOverviewReadModel>;
}): ReactNode {
  if (overview.state === "loading") {
    return <LoadingState label="Loading benchmark cockpit…" />;
  }
  if (overview.state === "error") {
    return <ErrorState title="Benchmark cockpit" error={overview.error} />;
  }
  return (
    <EmptyState
      title="Benchmark cockpit"
      message="No project context is available to scope the benchmark cockpit."
    />
  );
}

function BenchmarkCockpitBody({ projectId }: { projectId: string }): ReactNode {
  const cockpit = useApiQuery(
    "projects.bmkCockpit",
    { pathParams: { projectId } },
    `bmk-cockpit:${projectId}`,
  );
  const history = useApiQuery(
    "projects.bmkCockpitHistory",
    { pathParams: { projectId } },
    `bmk-cockpit-history:${projectId}`,
  );
  return <BenchmarkCockpitContent cockpit={cockpit} history={history} />;
}

/**
 * The cockpit state surface. Exported so a behavior-first test can mount the
 * resolved-content body directly over a pre-settled cockpit state.
 */
export function BenchmarkCockpitContent({
  cockpit,
  history,
}: {
  cockpit: ApiCallState<BmkCockpitReadModel>;
  history: ApiCallState<BmkCockpitRunHistoryPage>;
}): ReactNode {
  if (cockpit.state === "loading") {
    return <LoadingState label="Loading benchmark cockpit…" />;
  }
  if (cockpit.state === "error") {
    return <ErrorState title="Benchmark cockpit" error={cockpit.error} />;
  }
  if (cockpit.state === "empty" || isCockpitEmpty(cockpit.data)) {
    return (
      <EmptyState
        title="Benchmark cockpit"
        message="No benchmark runs have been scored for this project yet."
      />
    );
  }
  return <BenchmarkCockpitReady cockpit={cockpit.data} history={history} />;
}

/**
 * True when the cockpit carries no scored signal at all — the honest empty
 * case (a run recorded but scored zero items, so neither a contestant standing
 * nor a confidence nor a backlog exists). PROJECT LAW: a real empty, not a
 * degraded ready.
 */
export function isCockpitEmpty(cockpit: BmkCockpitReadModel): boolean {
  const noConfidence = cockpit.confidence.basis === "none";
  const noScoredContestant = cockpit.contestants.every((c) => c.aggregateScore === null);
  const noBacklog = cockpit.actionableBacklog.items.length === 0;
  return noConfidence && noScoredContestant && noBacklog;
}

function BenchmarkCockpitReady({
  cockpit,
  history,
}: {
  cockpit: BmkCockpitReadModel;
  history: ApiCallState<BmkCockpitRunHistoryPage>;
}): ReactNode {
  const verdict = deriveBenchmarkVerdict(cockpit);
  const rows = cockpitRows(cockpit);
  const backlogRows = benchmarkCockpitBacklogRows(cockpit);
  const counts = cockpit.actionableBacklog.countsByRank;
  return (
    <>
      <Panel
        title="Confidence & verdict"
        eyebrow="Calibration"
        className="itotori-panel--bmk-confidence"
        lamps={<Badge status={cockpit.status}>{cockpit.status}</Badge>}
      >
        <div className="itotori-metric-row" aria-label="Benchmark confidence">
          <StatReadout label="Confidence" value={formatCockpitConfidence(cockpit.confidence)} />
          <StatReadout label="Units scored" value={cockpit.unitsScored} />
          <StatReadout label="Anchor items" value={cockpit.humanAnchor.overall.itemsCompared} />
          <StatReadout label="Divergent dims" value={cockpit.humanAnchor.divergentDimensionCount} />
        </div>
        <p className="itotori-benchmark-verdict" data-verdict={verdict.status}>
          <Badge status={verdict.status}>{verdict.status}</Badge>
          <span className="itotori-benchmark-verdict__reason">{verdict.reason}</span>
        </p>
        <p className="itotori-bmk-run-meta">
          <code>{cockpit.runId}</code> · {cockpit.kind} · {cockpit.targetLocale}
          {cockpit.localeBranchId !== null ? ` · ${cockpit.localeBranchId}` : ""}
        </p>
      </Panel>

      <ContestantsPanel rows={rows} />

      <BenchmarkHistoryPanel history={history} />

      <ActionableBacklogPanel
        backlogRows={backlogRows}
        counts={counts}
        backlogSize={cockpit.actionableBacklogSize}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// History — the prior-run trend.
// ---------------------------------------------------------------------------

type CockpitHistoryRow = {
  runId: string;
  recordedAtLabel: string;
  status: BmkCockpitRunHistoryRow["status"];
  kind: BmkCockpitRunHistoryRow["kind"];
  targetLocale: string;
  bestRoleLabel: string;
  confidenceLabel: string;
  backlogSize: number;
  unitsScored: number;
};

function cockpitHistoryRows(history: BmkCockpitRunHistoryPage): CockpitHistoryRow[] {
  return history.rows.map((row) => ({
    runId: row.runId,
    recordedAtLabel: formatIsoDate(row.recordedAt),
    status: row.status,
    kind: row.kind,
    targetLocale: row.targetLocale,
    bestRoleLabel: row.bestRole === null ? "—" : BENCHMARK_CONTESTANT_LABELS[row.bestRole],
    confidenceLabel: formatScore(row.confidence),
    backlogSize: row.actionableBacklogSize,
    unitsScored: row.unitsScored,
  }));
}

function trendSeries(
  rows: readonly BmkCockpitRunHistoryRow[],
  select: (row: BmkCockpitRunHistoryRow) => number | null,
): number[] {
  return rows
    .slice()
    .reverse()
    .map(select)
    .filter((value): value is number => value !== null);
}

function latestHistoryRow(history: BmkCockpitRunHistoryPage): BmkCockpitRunHistoryRow | null {
  return history.rows[0] ?? null;
}

function BenchmarkHistoryPanel({
  history,
}: {
  history: ApiCallState<BmkCockpitRunHistoryPage>;
}): ReactNode {
  if (history.state === "loading") {
    return (
      <Panel title="Benchmark history" eyebrow="Trend" className="itotori-panel--bmk-history">
        <p role="status">Loading benchmark history…</p>
      </Panel>
    );
  }
  if (history.state === "error") {
    return <ErrorState title="Benchmark history" error={history.error} />;
  }
  if (history.state === "empty" || history.data.rows.length === 0) {
    return (
      <EmptyState
        title="Benchmark history"
        message="No prior benchmark runs are available for this project yet."
      />
    );
  }

  const latest = latestHistoryRow(history.data);
  const rows = cockpitHistoryRows(history.data);
  const confidenceSeries = trendSeries(history.data.rows, (row) => row.confidence);
  const backlogSeries = trendSeries(history.data.rows, (row) => row.actionableBacklogSize);

  return (
    <Panel
      title="Benchmark history"
      eyebrow="Trend"
      className="itotori-panel--bmk-history"
      lamps={
        <Badge status="neutral">{`${history.data.rows.length} run${
          history.data.rows.length === 1 ? "" : "s"
        }`}</Badge>
      }
    >
      <p className="itotori-shell__lede">
        Prior benchmark runs — confidence should rise while the actionable backlog shrinks.
      </p>
      <div className="itotori-metric-row" aria-label="Benchmark history trend">
        <StatReadout
          label="Latest confidence"
          value={latest === null ? "—" : formatScore(latest.confidence)}
          series={confidenceSeries}
        />
        <StatReadout
          label="Latest backlog"
          value={latest === null ? "—" : latest.actionableBacklogSize}
          series={backlogSeries}
        />
        <StatReadout
          label="History rows"
          value={history.data.rows.length}
          delta={history.data.pagination.hasMore ? "more" : "complete"}
        />
      </div>
      <DataTable
        caption="Benchmark run history"
        emptyLabel="No prior benchmark runs."
        columns={[
          {
            key: "recorded",
            header: "Recorded",
            render: (row: CockpitHistoryRow) => row.recordedAtLabel,
          },
          {
            key: "run",
            header: "Run",
            render: (row: CockpitHistoryRow) => <code>{row.runId}</code>,
          },
          {
            key: "status",
            header: "Status",
            render: (row: CockpitHistoryRow) => <Badge status={row.status}>{row.status}</Badge>,
          },
          {
            key: "locale",
            header: "Locale",
            render: (row: CockpitHistoryRow) => row.targetLocale,
          },
          {
            key: "best",
            header: "Best",
            render: (row: CockpitHistoryRow) => row.bestRoleLabel,
          },
          {
            key: "confidence",
            header: "Confidence",
            align: "end",
            render: (row: CockpitHistoryRow) => row.confidenceLabel,
          },
          {
            key: "backlog",
            header: "Backlog",
            align: "end",
            render: (row: CockpitHistoryRow) => row.backlogSize,
          },
          {
            key: "units",
            header: "Units",
            align: "end",
            render: (row: CockpitHistoryRow) => row.unitsScored,
          },
        ]}
        rows={rows}
        getRowKey={(row) => row.runId}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Contestants — the comparative palette.
// ---------------------------------------------------------------------------

type CockpitContestantRow = {
  role: BmkCockpitContestantRole;
  label: string;
  aggregateScoreLabel: string;
  rankLabel: string;
  judgeMeanLabel: string;
  metricMeanLabel: string;
  isSelf: boolean;
};

function cockpitRows(cockpit: BmkCockpitReadModel): CockpitContestantRow[] {
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
      judgeMeanLabel: formatJudgeMean(contestant?.judgeMean ?? null),
      metricMeanLabel: formatScore(contestant?.metricMean ?? null),
      isSelf: role === "self",
    };
  });
}

function ContestantsPanel({ rows }: { rows: CockpitContestantRow[] }): ReactNode {
  return (
    <Panel
      title="Contestants"
      eyebrow="Comparative field"
      className="itotori-panel--bmk-contestants"
    >
      <p className="itotori-shell__lede">
        The system under test vs the field — ranked best to worst, calibrated by the §8 human
        anchor.
      </p>
      <ul className="itotori-contestant-list" aria-label="Benchmark contestants">
        {rows.map((row) => (
          <li
            key={row.role}
            className="itotori-contestant-list__row"
            data-contestant={row.role}
            data-self={row.isSelf ? "true" : "false"}
          >
            <span className="itotori-contestant-list__label">
              <ContestantSwatch role={row.role} label={row.label} />
              {row.label}
            </span>
            <span className="itotori-contestant-list__score">{row.aggregateScoreLabel}</span>
            <span className="itotori-contestant-list__rank">{row.rankLabel}</span>
          </li>
        ))}
      </ul>
      <p className="itotori-bmk-judge-metric-note" aria-label="Contestant judge/metric means">
        {rows.map((row) => (
          <span key={row.role} data-contestant={row.role}>
            {row.label}: judge {row.judgeMeanLabel} · metric {row.metricMeanLabel}
            {row.isSelf ? " (self)" : ""}
          </span>
        ))}
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Actionable backlog — the cockpit's PRIMARY output (§10 diagnostic).
// ---------------------------------------------------------------------------

function ActionableBacklogPanel({
  backlogRows,
  counts,
  backlogSize,
}: {
  backlogRows: BenchmarkCockpitBacklogRow[];
  counts: Record<BacklogRankTier, number>;
  backlogSize: number;
}): ReactNode {
  return (
    <Panel
      title="Actionable backlog"
      eyebrow="Diagnostic instrument"
      className="itotori-panel--bmk-backlog"
      lamps={<Badge status="neutral">{`${backlogSize} item${backlogSize === 1 ? "" : "s"}`}</Badge>}
    >
      <p className="itotori-shell__lede">
        The ranked failure modes — each tied to an adjudicated cause + a concrete fix candidate.
        This is the cockpit&apos;s primary output: where to steer next.
      </p>
      <div className="itotori-metric-row" aria-label="Backlog counts by rank">
        {(Object.keys(BACKLOG_RANK_LABELS) as BacklogRankTier[]).map((tier) => (
          <StatReadout key={tier} label={BACKLOG_RANK_LABELS[tier]} value={counts[tier] ?? 0} />
        ))}
      </div>
      <DataTable
        caption="Ranked improvement backlog"
        emptyLabel="No ranked failure modes — the field held."
        columns={[
          {
            key: "priority",
            header: "Priority",
            align: "end",
            render: (row: BenchmarkCockpitBacklogRow) => row.priorityOrder + 1,
          },
          {
            key: "rank",
            header: "Rank",
            render: (row: BenchmarkCockpitBacklogRow) => (
              <Badge status={BACKLOG_RANK_STATUS[row.rankTier]}>{row.rankLabel}</Badge>
            ),
          },
          {
            key: "failure",
            header: "Failure mode",
            render: (row: BenchmarkCockpitBacklogRow) => (
              <span>
                {row.failureMode}
                <br />
                <code>{row.backlogItemId}</code>
              </span>
            ),
          },
          {
            key: "dimension",
            header: "Dimension",
            render: (row: BenchmarkCockpitBacklogRow) => row.dimension,
          },
          {
            key: "severity",
            header: "Severity",
            render: (row: BenchmarkCockpitBacklogRow) => row.severityLabel,
          },
          {
            key: "cause",
            header: "Cause",
            render: (row: BenchmarkCockpitBacklogRow) => <code>{row.cause}</code>,
          },
          {
            key: "fix",
            header: "Fix candidate",
            render: (row: BenchmarkCockpitBacklogRow) => row.fixCandidate,
          },
        ]}
        rows={backlogRows}
        getRowKey={(row) => row.backlogItemId}
      />
    </Panel>
  );
}
