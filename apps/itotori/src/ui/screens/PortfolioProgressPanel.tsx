// Portfolio live-progress surface — renders every concurrent project from the
// mp-04 `projects.list` portfolio response with its per-project progress
// rollup (unit stage counts, run status, cost, coverage, blockers).
//
// HONESTY: every number is a real field on `ProjectRunPortfolioProgressSummary`
// (or arithmetic over those fields). Engine family is NOT on
// `ProjectDashboardStatus` / the portfolio entry today, so it is not painted
// (title + project status + source locale come from the API instead).
// No game names are hardcoded; identity is project name / key from the wire.

import type { ReactNode } from "react";
import type {
  ProjectRunPortfolioProgressSummary,
  ProjectRunProgressStatusCounts,
  ProjectRunStatusCounts,
} from "@itotori/db";
import {
  Badge,
  LocalizationProgress,
  Panel,
  StatReadout,
  type LocalizationStage,
} from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type { ApiProjectsResponse, ProjectPortfolioEntry } from "../../api-schema.js";
import { formatMicrosUsd, plural } from "../format.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";
import "./PortfolioProgressPanel.css";

/** Default live-refresh cadence for portfolio progress (ms). */
export const PORTFOLIO_PROGRESS_POLL_MS = 5_000;

const STAGE_ORDER = ["decoded", "drafted", "QA", "accepted", "patched"] as const;

type StageTone = NonNullable<LocalizationStage["tone"]>;

const STAGE_META: Readonly<
  Record<(typeof STAGE_ORDER)[number], { label: string; tone: StageTone; key: string }>
> = {
  decoded: { label: "decoded", tone: "cyan", key: "decoded" },
  drafted: { label: "drafted", tone: "amber", key: "drafted" },
  QA: { label: "qa", tone: "sakura", key: "qa" },
  accepted: { label: "accepted", tone: "mint", key: "accepted" },
  // LocalizationProgress headlines the `proven` key; patched is the terminal
  // unit stage in the portfolio rollup, so it owns the proven slot.
  patched: { label: "patched", tone: "mint", key: "proven" },
};

/**
 * Derive the dominant run status badge label from the portfolio rollup's
 * `runStatusCounts`. Priority favors active work over terminal states.
 */
export function derivePortfolioRunStatus(counts: ProjectRunStatusCounts, runCount: number): string {
  if (runCount <= 0) {
    return "pending";
  }
  if (counts.running > 0) {
    return "running";
  }
  if (counts.paused > 0) {
    return "paused";
  }
  if (counts.queued > 0) {
    return "pending";
  }
  if (counts.failed > 0) {
    return "failed";
  }
  if (counts.completed > 0) {
    return "succeeded";
  }
  if (counts.cancelled > 0) {
    return "stale";
  }
  return "pending";
}

/** Sum unit stage counts into a total addressable unit count for the bar. */
export function unitStageTotal(unitCounts: ProjectRunProgressStatusCounts): number {
  return STAGE_ORDER.reduce((sum, stage) => sum + unitCounts[stage], 0);
}

/** Build the ds `LocalizationProgress` stage segments from portfolio unitCounts. */
export function portfolioUnitStages(
  unitCounts: ProjectRunProgressStatusCounts,
): LocalizationStage[] {
  return STAGE_ORDER.map((stage) => {
    const meta = STAGE_META[stage];
    return {
      key: meta.key,
      label: meta.label,
      count: unitCounts[stage],
      tone: meta.tone,
    };
  });
}

/** True when the project has no recorded runs (clean empty-state path). */
export function isRunlessPortfolioProgress(progress: ProjectRunPortfolioProgressSummary): boolean {
  return progress.runCount <= 0;
}

/**
 * Outer portfolio panel. Accepts the settled `projects.list` state so the
 * dashboard can share one polled query with sibling panels.
 */
export function PortfolioProgressPanel({
  projects,
}: {
  projects: ApiCallState<ApiProjectsResponse>;
}): ReactNode {
  return (
    <Panel
      title="Live portfolio"
      eyebrow="Progress"
      className="itotori-panel--portfolio"
      data-panel="portfolio-progress"
      data-panel-state={projects.state}
    >
      <PortfolioProgressBody projects={projects} />
    </Panel>
  );
}

function PortfolioProgressBody({
  projects,
}: {
  projects: ApiCallState<ApiProjectsResponse>;
}): ReactNode {
  if (projects.state === "loading") {
    return <LoadingState label="Loading portfolio progress…" />;
  }
  if (projects.state === "error") {
    return <ErrorState title="Live portfolio" error={projects.error} />;
  }
  if (projects.state === "empty") {
    return (
      <EmptyState title="No projects" message="No projects were returned by the portfolio API." />
    );
  }
  return (
    <div
      className="itotori-portfolio-grid"
      aria-label="Concurrent project progress"
      data-portfolio-count={projects.data.projects.length}
    >
      {projects.data.projects.map((project) => (
        <PortfolioProjectCard key={project.projectId} project={project} />
      ))}
    </div>
  );
}

function PortfolioProjectCard({ project }: { project: ProjectPortfolioEntry }): ReactNode {
  const { progress } = project;
  const runStatus = derivePortfolioRunStatus(progress.runStatusCounts, progress.runCount);
  const blockerCount = progress.blockers.length;
  const runless = isRunlessPortfolioProgress(progress);

  return (
    <article
      className="itotori-portfolio-card"
      data-portfolio-project={project.projectId}
      data-run-count={progress.runCount}
      data-runless={runless ? "true" : "false"}
      data-blocker-count={blockerCount}
    >
      <header className="itotori-portfolio-card__header">
        <div className="itotori-portfolio-card__identity">
          <h3 className="itotori-portfolio-card__title">{project.name}</h3>
          <p className="itotori-portfolio-card__meta">
            <code>{project.projectKey}</code>
            <span aria-hidden="true"> · </span>
            <span>{project.sourceLocale}</span>
          </p>
        </div>
        <div className="itotori-portfolio-card__lamps">
          <Badge status={project.status}>{project.status}</Badge>
          <Badge status={runStatus}>{runStatus}</Badge>
          {blockerCount > 0 && (
            <Badge status="blocker" tone="critical">
              {blockerCount} {plural(blockerCount, "blocker")}
            </Badge>
          )}
        </div>
      </header>

      {runless ? (
        <div className="itotori-portfolio-card__empty" data-portfolio-empty="runless">
          <p className="itotori-empty-copy">
            No runs recorded yet. Progress will appear when a run starts.
          </p>
          <div className="itotori-metric-row" aria-label="Idle portfolio metrics">
            <StatReadout label="Runs" value={0} />
            <StatReadout label="Cost" value={formatMicrosUsd(0)} mono />
            <StatReadout label="Coverage" value="—" unit="%" />
            <StatReadout label="Blockers" value={0} />
          </div>
        </div>
      ) : (
        <PortfolioProjectProgress progress={progress} />
      )}
    </article>
  );
}

function PortfolioProjectProgress({
  progress,
}: {
  progress: ProjectRunPortfolioProgressSummary;
}): ReactNode {
  const total = unitStageTotal(progress.unitCounts);
  const stages = portfolioUnitStages(progress.unitCounts);
  const coverage = Number.isFinite(progress.averageCoveragePercent)
    ? Math.round(progress.averageCoveragePercent * 10) / 10
    : 0;
  const blockerReasons = summarizeBlockerReasons(progress.blockers);

  return (
    <div className="itotori-portfolio-card__body">
      <LocalizationProgress
        total={total}
        stages={stages}
        {...(progress.runCount > 0
          ? { cycle: { current: progress.runCount, of: progress.runCount } }
          : {})}
        eta={<span data-portfolio-coverage={coverage}>{coverage}% avg coverage</span>}
      />
      <div className="itotori-metric-row" aria-label="Portfolio progress metrics">
        <StatReadout label="Runs" value={progress.runCount} />
        <StatReadout label="Units" value={total} />
        <StatReadout label="Cost" value={formatMicrosUsd(progress.totalCostMicrosUsd)} mono />
        <StatReadout label="Coverage" value={coverage} unit="%" />
        <StatReadout label="Blockers" value={progress.blockers.length} />
      </div>
      {progress.blockers.length > 0 && (
        <ul className="itotori-portfolio-card__blockers" aria-label="Blockers">
          {blockerReasons.map((entry) => (
            <li key={entry.key}>
              <Badge status="blocker" tone="critical">
                {entry.role}
              </Badge>{" "}
              <span>{entry.reasons}</span>
              {entry.count > 1 && (
                <span className="itotori-portfolio-card__blocker-count"> ×{entry.count}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type BlockerReasonRow = {
  key: string;
  role: string;
  reasons: string;
  count: number;
};

/**
 * Collapse portfolio blockers to role + reason codes only. Does not surface
 * run / unit identifiers in the UI (those are internal handles, not labels).
 */
function summarizeBlockerReasons(
  blockers: ProjectRunPortfolioProgressSummary["blockers"],
): BlockerReasonRow[] {
  const groups = new Map<string, BlockerReasonRow>();
  for (const blocker of blockers) {
    const reasons = blocker.blockers.length === 0 ? "blocked" : blocker.blockers.join(", ");
    const key = `${blocker.role}::${reasons}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { key, role: blocker.role, reasons, count: 1 });
      continue;
    }
    existing.count += 1;
  }
  return [...groups.values()];
}
