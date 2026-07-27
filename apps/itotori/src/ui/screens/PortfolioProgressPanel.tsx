// Portfolio live-progress surface — at-a-glance across ALL concurrent projects
// from the `projects.list` portfolio response (unit stage counts, per-role
// counts, run status, cost, coverage, blockers, open findings, engine family),
// plus a drill-down into one project's units / review / patch / validate.
//
// HONESTY: every number is a real field on `ProjectPortfolioEntry` /
// `ProjectRunPortfolioProgressSummary` (or arithmetic over those fields).
// No game names are hardcoded; identity is project name / key / engine family
// from the wire, and NOTHING here branches on which engine a project is on.
//
// Density: ≤8 projects → multi-column cards with full stage mix. Above that →
// a compact virtualized table (one project per line) so scale gets denser.

import { useState, type ReactNode } from "react";
import { Panel, StatReadout } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type { ApiProjectsResponse, ProjectPortfolioEntry } from "../../api-schema.js";
import { formatMicrosUsd } from "../format.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";
import {
  aggregatePortfolio,
  sortPortfolioProjects,
  type PortfolioAggregate,
} from "./portfolio-progress-model.js";
import { PortfolioDenseTable } from "./portfolio/PortfolioDenseTable.js";
import { PortfolioDrilldown } from "./portfolio/PortfolioDrilldown.js";
import { PortfolioProjectCard } from "./portfolio/PortfolioProjectCard.js";
import "./PortfolioProgressPanel.css";

// Re-export pure helpers so existing consumers keep importing from this module.
export {
  activityScore,
  activeRunCount,
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

/** Default live-refresh cadence for portfolio progress (ms). */
export const PORTFOLIO_PROGRESS_POLL_MS = 5_000;

/** Above this count, switch from card grid to compact virtualized table. */
export const PORTFOLIO_DENSE_THRESHOLD = 8;

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
  // Which project's drill-down is open. Held here (not in a route) so opening a
  // project never drops the live board behind it; the SAME polled rows feed
  // both, so the drill-down advances on the same tick.
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);

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
  const open = rows.find((project) => project.projectId === openProjectId) ?? null;
  return (
    <div
      className="itotori-portfolio"
      data-portfolio-count={rows.length}
      data-portfolio-density={dense ? "dense" : "standard"}
    >
      <PortfolioRollup rollup={rollup} />
      {dense ? (
        <PortfolioDenseTable
          projects={rows}
          openProjectId={open?.projectId ?? null}
          onOpen={setOpenProjectId}
        />
      ) : (
        <PortfolioCardGrid rows={rows} open={open} onOpen={setOpenProjectId} />
      )}
      {open !== null && (
        <PortfolioDrilldown
          project={open}
          onClose={() => {
            setOpenProjectId(null);
          }}
        />
      )}
    </div>
  );
}

function PortfolioCardGrid({
  rows,
  open,
  onOpen,
}: {
  rows: readonly ProjectPortfolioEntry[];
  open: ProjectPortfolioEntry | null;
  onOpen: (projectId: string) => void;
}): ReactNode {
  return (
    <div
      className="itotori-portfolio-grid"
      aria-label="Concurrent project progress"
      data-portfolio-layout="grid"
    >
      {rows.map((project) => (
        <PortfolioProjectCard
          key={project.projectId}
          project={project}
          open={open?.projectId === project.projectId}
          onOpen={onOpen}
        />
      ))}
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
