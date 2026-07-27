// One project's portfolio card — identity, run/status lamps, proven progress,
// stage mix, per-role bars, cost/coverage/blockers, and the control that opens
// the project's drill-down.
//
// Engine identity is printed as a data label; no branch anywhere reads it.

import type { ReactNode } from "react";
import type { ProjectRunPortfolioProgressSummary } from "@itotori/db";
import { Badge, ProgressBar, StatReadout } from "@itotori/ds";
import type { ProjectPortfolioEntry } from "../../../api-schema.js";
import { formatMicrosUsd, plural } from "../../format.js";
import { useShellSelection } from "../../shell-selection.js";
import {
  derivePortfolioRunStatus,
  isRunlessPortfolioProgress,
  portfolioUnitStages,
  provenUnitCount,
  summarizeBlockerReasons,
  unitStageTotal,
} from "../portfolio-progress-model.js";
import { PortfolioRoleBars } from "./PortfolioRoleBars.js";
import { StageMixBar } from "./PortfolioStageMixBar.js";

export function PortfolioProjectCard({
  project,
  open,
  onOpen,
}: {
  project: ProjectPortfolioEntry;
  open: boolean;
  onOpen: (projectId: string) => void;
}): ReactNode {
  const { progress } = project;
  const runStatus = derivePortfolioRunStatus(progress.runStatusCounts, progress.runCount);
  const blockerCount = progress.blockers.length;
  const runless = isRunlessPortfolioProgress(progress);
  const shell = useShellSelection();
  const selected = shell?.override.projectId === project.projectId;
  const attentionCount = blockerCount + project.findingCount;
  // Identity: print the display name once. Engine + locale are supporting meta.
  // When name === projectKey (common fixture / default), skip the key to avoid
  // printing it twice; otherwise show the key as a mono secondary token.
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
      data-portfolio-expanded={open ? "true" : "false"}
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
          aria-expanded={open}
          aria-label={`Open project ${project.name}`}
          onClick={() => {
            shell?.selectProject(project.projectId);
            onOpen(project.projectId);
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
        <PortfolioRoleBars roleCounts={progress.roleCounts} />
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
