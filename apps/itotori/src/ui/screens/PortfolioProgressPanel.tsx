// Portfolio live-progress surface — at-a-glance across ALL concurrent projects
// from the mp-04 `projects.list` portfolio response (unit stage counts, run
// status, cost, coverage, blockers, open findings, engine family).
//
// HONESTY: every number is a real field on `ProjectPortfolioEntry` /
// `ProjectRunPortfolioProgressSummary` (or arithmetic over those fields).
// No game names are hardcoded; identity is project name / key / engine family
// from the wire. Each row selects the project into the shell so the portfolio
// is a way *into* the project, not a dead end.
//
// Density: ≤8 projects → multi-column cards with full stage mix. Above that →
// a compact virtualized table (one project per line) so scale gets denser.

import type { ReactNode } from "react";
import type { ProjectRunPortfolioProgressSummary } from "@itotori/db";
import { Badge, Panel, ProgressBar, StatReadout, type LocalizationStage } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type { ApiProjectsResponse, ProjectPortfolioEntry } from "../../api-schema.js";
import { formatMicrosUsd, plural } from "../format.js";
import { useShellSelection } from "../shell-selection.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";
import { VirtualList } from "../virtual-list.js";
import {
  aggregatePortfolio,
  derivePortfolioRunStatus,
  isRunlessPortfolioProgress,
  portfolioUnitStages,
  provenUnitCount,
  sortPortfolioProjects,
  summarizeBlockerReasons,
  unitStageTotal,
  type PortfolioAggregate,
} from "./portfolio-progress-model.js";
import "./PortfolioProgressPanel.css";

// Re-export pure helpers so existing tests keep importing from this module.
export {
  activityScore,
  activeRunCount,
  aggregatePortfolio,
  derivePortfolioRunStatus,
  isRunlessPortfolioProgress,
  portfolioUnitStages,
  provenUnitCount,
  sortPortfolioProjects,
  unitStageTotal,
  type PortfolioAggregate,
} from "./portfolio-progress-model.js";

/** Default live-refresh cadence for portfolio progress (ms). */
export const PORTFOLIO_PROGRESS_POLL_MS = 5_000;

/** Above this count, switch from card grid to compact virtualized table. */
export const PORTFOLIO_DENSE_THRESHOLD = 8;

/** Estimated dense-row height for virtualization (content only). */
const PORTFOLIO_DENSE_ROW_HEIGHT = 36;

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
  const rows = sortPortfolioProjects(projects.data.projects);
  const rollup = aggregatePortfolio(rows);
  const dense = rows.length > PORTFOLIO_DENSE_THRESHOLD;
  return (
    <div
      className="itotori-portfolio"
      data-portfolio-count={rows.length}
      data-portfolio-density={dense ? "dense" : "standard"}
    >
      <PortfolioRollup rollup={rollup} />
      {dense ? (
        <PortfolioDenseTable projects={rows} />
      ) : (
        <div
          className="itotori-portfolio-grid"
          aria-label="Concurrent project progress"
          data-portfolio-layout="grid"
        >
          {rows.map((project) => (
            <PortfolioProjectCard key={project.projectId} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}

function PortfolioRollup({ rollup }: { rollup: PortfolioAggregate }): ReactNode {
  return (
    <div
      className="itotori-metric-row itotori-metric-row--compact itotori-portfolio__rollup"
      aria-label="Portfolio aggregate"
      data-portfolio-rollup="true"
      data-portfolio-project-count={rollup.projectCount}
      data-portfolio-active-runs={rollup.activeRunCount}
      data-portfolio-blockers={rollup.totalBlockers}
      data-portfolio-findings={rollup.totalFindings}
      data-portfolio-engines={rollup.engineCount}
    >
      <StatReadout label="Projects" value={rollup.projectCount} />
      <StatReadout label="Active runs" value={rollup.activeRunCount} />
      <StatReadout label="Runs" value={rollup.totalRunCount} />
      <StatReadout label="Cost" value={formatMicrosUsd(rollup.totalCostMicrosUsd)} mono />
      <StatReadout label="Blockers" value={rollup.totalBlockers} />
      <StatReadout label="Findings" value={rollup.totalFindings} />
      <StatReadout label="Engines" value={rollup.engineCount} />
    </div>
  );
}

/** Compact virtualized table — one project per line for large portfolios. */
function PortfolioDenseTable({
  projects,
}: {
  projects: readonly ProjectPortfolioEntry[];
}): ReactNode {
  return (
    <div className="itotori-portfolio-dense" data-portfolio-layout="dense">
      <div className="itotori-portfolio-dense__head" aria-hidden="true">
        <span>Project</span>
        <span>Engine</span>
        <span>State</span>
        <span>Proven</span>
        <span>Coverage</span>
        <span>Cost</span>
        <span>Flags</span>
        <span />
      </div>
      <VirtualList
        ariaLabel="Concurrent project progress"
        items={projects}
        getItemKey={(project) => project.projectId}
        itemHeight={PORTFOLIO_DENSE_ROW_HEIGHT}
        viewportHeight={Math.min(560, projects.length * (PORTFOLIO_DENSE_ROW_HEIGHT + 2) + 4)}
        rowGap={2}
        className="itotori-portfolio-dense__list"
        renderItem={(project) => <PortfolioDenseRow project={project} />}
      />
    </div>
  );
}

function PortfolioDenseRow({ project }: { project: ProjectPortfolioEntry }): ReactNode {
  const { progress } = project;
  const runStatus = derivePortfolioRunStatus(progress.runStatusCounts, progress.runCount);
  const blockerCount = progress.blockers.length;
  const runless = isRunlessPortfolioProgress(progress);
  const shell = useShellSelection();
  const selected = shell?.override.projectId === project.projectId;
  const attentionCount = blockerCount + project.findingCount;
  const total = unitStageTotal(progress.unitCounts);
  const proven = provenUnitCount(progress.unitCounts);
  const provenPct = total > 0 ? Math.round((proven / total) * 1000) / 10 : 0;
  const coverage = Number.isFinite(progress.averageCoveragePercent)
    ? Math.round(progress.averageCoveragePercent * 10) / 10
    : 0;
  const engine = project.engineFamily ?? "unbound";

  return (
    <article
      className="itotori-portfolio-row"
      data-portfolio-project={project.projectId}
      data-run-count={progress.runCount}
      data-runless={runless ? "true" : "false"}
      data-blocker-count={blockerCount}
      data-finding-count={project.findingCount}
      data-engine-family={project.engineFamily ?? ""}
      data-portfolio-selected={selected ? "true" : "false"}
      data-attention={attentionCount > 0 ? "true" : "false"}
      data-portfolio-proven={provenPct}
    >
      <div className="itotori-portfolio-row__identity">
        <span className="itotori-portfolio-row__name">{project.name}</span>
      </div>
      <span className="itotori-portfolio-row__engine" data-portfolio-engine={engine}>
        {engine}
      </span>
      <div className="itotori-portfolio-row__state">
        <Badge status={runStatus}>{runStatus}</Badge>
      </div>
      <div className="itotori-portfolio-row__proven">
        {runless ? (
          <span className="itotori-portfolio-row__muted">—</span>
        ) : (
          <>
            <span className="itotori-portfolio-row__pct">{provenPct}%</span>
            <span className="itotori-portfolio-row__units">
              {proven}/{total}
            </span>
            <ProgressBar
              value={proven}
              max={total > 0 ? total : 1}
              tone="mint"
              label={`${proven} of ${total} units proven`}
            />
          </>
        )}
      </div>
      <span className="itotori-portfolio-row__coverage" data-portfolio-coverage={coverage}>
        {runless ? "—" : `${coverage}%`}
      </span>
      <span className="itotori-portfolio-row__cost">
        {formatMicrosUsd(progress.totalCostMicrosUsd)}
      </span>
      <div className="itotori-portfolio-row__flags">
        {blockerCount > 0 && (
          <Badge status="blocker" tone="critical">
            {blockerCount}b
          </Badge>
        )}
        {project.findingCount > 0 && (
          <Badge status="warning" tone="critical">
            {project.findingCount}f
          </Badge>
        )}
        {blockerCount === 0 && project.findingCount === 0 && (
          <span className="itotori-portfolio-row__muted">—</span>
        )}
      </div>
      <button
        type="button"
        className="itotori-portfolio-row__open"
        data-portfolio-open={project.projectId}
        aria-label={`Open project ${project.name}`}
        onClick={() => {
          shell?.selectProject(project.projectId);
        }}
      >
        Open
      </button>
    </article>
  );
}

function PortfolioProjectCard({ project }: { project: ProjectPortfolioEntry }): ReactNode {
  const { progress } = project;
  const runStatus = derivePortfolioRunStatus(progress.runStatusCounts, progress.runCount);
  const blockerCount = progress.blockers.length;
  const runless = isRunlessPortfolioProgress(progress);
  const shell = useShellSelection();
  const selected = shell?.override.projectId === project.projectId;
  const attentionCount = blockerCount + project.findingCount;
  // Identity: print the display name once. Engine + locale are supporting meta.
  // When name === projectKey (common fixture / default), skip the key to avoid
  // "project-beta" twice; otherwise show the key as a mono secondary token.
  const showKey = project.projectKey !== project.name;

  return (
    <article
      className="itotori-portfolio-card"
      data-portfolio-project={project.projectId}
      data-run-count={progress.runCount}
      data-runless={runless ? "true" : "false"}
      data-blocker-count={blockerCount}
      data-finding-count={project.findingCount}
      data-engine-family={project.engineFamily ?? ""}
      data-portfolio-selected={selected ? "true" : "false"}
      data-attention={attentionCount > 0 ? "true" : "false"}
    >
      <header className="itotori-portfolio-card__header">
        <div className="itotori-portfolio-card__identity">
          <h3 className="itotori-portfolio-card__title">{project.name}</h3>
          <p className="itotori-portfolio-card__meta">
            {showKey && (
              <>
                <code>{project.projectKey}</code>
                <span aria-hidden="true"> · </span>
              </>
            )}
            <span data-portfolio-engine={project.engineFamily ?? "unbound"}>
              {project.engineFamily ?? "engine unbound"}
            </span>
            <span aria-hidden="true"> · </span>
            <span>{project.sourceLocale}</span>
          </p>
        </div>
        {/* Always a dedicated chip row so card header height is stable. */}
        <div className="itotori-portfolio-card__lamps">
          <Badge status={project.status}>{project.status}</Badge>
          <Badge status={runStatus}>{runStatus}</Badge>
          {blockerCount > 0 && (
            <Badge status="blocker" tone="critical">
              {blockerCount} {plural(blockerCount, "blocker")}
            </Badge>
          )}
          {project.findingCount > 0 && (
            <Badge status="warning" tone="critical">
              {project.findingCount} {plural(project.findingCount, "finding")}
            </Badge>
          )}
        </div>
      </header>

      {runless ? (
        <div className="itotori-portfolio-card__empty" data-portfolio-empty="runless">
          <p className="itotori-empty-copy">
            No runs recorded yet. Progress will appear when a run starts.
          </p>
          <div
            className="itotori-metric-row itotori-metric-row--compact"
            aria-label="Idle portfolio metrics"
          >
            <StatReadout label="Runs" value={0} />
            <StatReadout label="Cost" value={formatMicrosUsd(0)} mono />
            <StatReadout label="Blockers" value={0} />
          </div>
        </div>
      ) : (
        <PortfolioProjectProgress progress={progress} />
      )}

      <footer className="itotori-portfolio-card__footer">
        <button
          type="button"
          className="itotori-portfolio-card__open"
          data-portfolio-open={project.projectId}
          aria-label={`Open project ${project.name}`}
          onClick={() => {
            shell?.selectProject(project.projectId);
          }}
        >
          Open project
        </button>
      </footer>
    </article>
  );
}

function PortfolioProjectProgress({
  progress,
}: {
  progress: ProjectRunPortfolioProgressSummary;
}): ReactNode {
  const total = unitStageTotal(progress.unitCounts);
  const proven = provenUnitCount(progress.unitCounts);
  const provenPct = total > 0 ? Math.round((proven / total) * 1000) / 10 : 0;
  const stages = portfolioUnitStages(progress.unitCounts);
  const coverage = Number.isFinite(progress.averageCoveragePercent)
    ? Math.round(progress.averageCoveragePercent * 10) / 10
    : 0;
  const blockerReasons = summarizeBlockerReasons(progress.blockers);

  return (
    <div className="itotori-portfolio-card__body">
      <div className="itotori-portfolio-progress" data-portfolio-proven={provenPct}>
        <div className="itotori-portfolio-progress__head">
          <div className="itotori-portfolio-progress__proven">
            <span className="itotori-portfolio-progress__pct">{provenPct}%</span>
            <span className="itotori-portfolio-progress__pct-label">proven</span>
            <span className="itotori-portfolio-progress__counts">
              {proven}/{total} units
            </span>
          </div>
          <span className="itotori-portfolio-progress__coverage" data-portfolio-coverage={coverage}>
            {coverage}% avg coverage
          </span>
        </div>
        {/* Proven fill only — width tracks proven%, never full when proven is 0. */}
        <ProgressBar
          value={proven}
          max={total > 0 ? total : 1}
          tone="mint"
          label={`${proven} of ${total} units proven`}
        />
        <StageMixBar stages={stages} total={total} />
      </div>
      <div
        className="itotori-metric-row itotori-metric-row--compact"
        aria-label="Portfolio progress metrics"
      >
        <StatReadout label="Runs" value={progress.runCount} />
        <StatReadout label="Units" value={total} />
        <StatReadout label="Cost" value={formatMicrosUsd(progress.totalCostMicrosUsd)} mono />
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

/** Labeled composition bar — stage mix, not proven progress. */
function StageMixBar({
  stages,
  total,
}: {
  stages: readonly LocalizationStage[];
  total: number;
}): ReactNode {
  const safeTotal = total > 0 ? total : 1;
  return (
    <div className="itotori-portfolio-stage-mix" data-portfolio-stage-mix="true">
      <span className="itotori-portfolio-stage-mix__label">Stage mix</span>
      <div
        className="itotori-portfolio-stage-mix__bar"
        role="img"
        aria-label="Unit stage composition"
      >
        {stages.map((stage) => {
          const pct = (stage.count / safeTotal) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={stage.key}
              className={`itotori-portfolio-stage-mix__seg itotori-portfolio-stage-mix__seg--${stage.tone ?? "neutral"}`}
              style={{ width: `${pct}%` }}
              data-stage={stage.key}
              title={`${stage.label}: ${stage.count}`}
            />
          );
        })}
      </div>
      <ul className="itotori-portfolio-stage-mix__legend">
        {stages.map((stage) => (
          <li key={stage.key} className="itotori-portfolio-stage-mix__legend-item">
            <span
              className={`itotori-portfolio-stage-mix__dot itotori-portfolio-stage-mix__seg--${stage.tone ?? "neutral"}`}
              aria-hidden="true"
            />
            <span>{stage.label}</span>
            <code className="itotori-portfolio-stage-mix__legend-count">{stage.count}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
