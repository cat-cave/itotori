// Compact virtualized portfolio table — one project per line, used above the
// density threshold so a large portfolio gets denser rather than longer.

import type { ReactNode } from "react";
import { Badge, ProgressBar } from "@itotori/ds";
import type { ProjectPortfolioEntry } from "../../../api-schema.js";
import { formatMicrosUsd } from "../../format.js";
import { useShellSelection } from "../../shell-selection.js";
import { VirtualList } from "../../virtual-list.js";
import {
  derivePortfolioRunStatus,
  isRunlessPortfolioProgress,
  provenUnitCount,
  unitStageTotal,
} from "../portfolio-progress-model.js";
import { portfolioRoleCount } from "./portfolio-role-model.js";

/** Estimated dense-row height for virtualization (content only). */
export const PORTFOLIO_DENSE_ROW_HEIGHT = 36;

export function PortfolioDenseTable({
  projects,
  openProjectId,
  onOpen,
}: {
  projects: readonly ProjectPortfolioEntry[];
  openProjectId: string | null;
  onOpen: (projectId: string) => void;
}): ReactNode {
  return (
    <div className="itotori-portfolio-dense" data-portfolio-layout="dense">
      <div className="itotori-portfolio-dense__head" aria-hidden="true">
        <span>Project</span>
        <span>Engine</span>
        <span>State</span>
        <span>Proven</span>
        <span>Roles</span>
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
        renderItem={(project) => (
          <PortfolioDenseRow
            project={project}
            open={openProjectId === project.projectId}
            onOpen={onOpen}
          />
        )}
      />
    </div>
  );
}

function PortfolioDenseRow({
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
  const total = unitStageTotal(progress.unitCounts);
  const proven = provenUnitCount(progress.unitCounts);
  const provenPct = total > 0 ? Math.round((proven / total) * 1000) / 10 : 0;
  const coverage = Number.isFinite(progress.averageCoveragePercent)
    ? Math.round(progress.averageCoveragePercent * 10) / 10
    : 0;
  const engine = project.engineFamily ?? "unbound";
  const roleCount = portfolioRoleCount(progress.roleCounts);

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
      data-portfolio-expanded={open ? "true" : "false"}
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
      <span className="itotori-portfolio-row__roles" data-portfolio-roles={roleCount}>
        {roleCount === 0 ? "—" : roleCount}
      </span>
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
        aria-expanded={open}
        aria-label={`Open project ${project.name}`}
        onClick={() => {
          shell?.selectProject(project.projectId);
          onOpen(project.projectId);
        }}
      >
        Open
      </button>
    </article>
  );
}
