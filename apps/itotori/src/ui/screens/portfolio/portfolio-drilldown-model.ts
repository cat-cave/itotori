// Portfolio drill-down: one project's units / review / patch / validate view,
// derived PURELY from the `projects.list` portfolio row already on screen.
//
// HONESTY: every metric below is a real field on `ProjectPortfolioEntry`
// (`ProjectDashboardStatus` + `ProjectRunPortfolioProgressSummary`) or
// arithmetic over those fields. Where an id the payload does not carry would be
// needed for a deep-link, the section says so instead of inventing one.
//
// Every link target is a route this SPA already serves:
//   units    → `/play?projectId&localeBranchId`      (PlayHubScreen)
//   review   → `/play/units/:bridgeUnitId`           (addressable unit focus)
//   patch    → `/projects/:p/locale-branches/:b/asset-decisions`
//   validate → `/runs/:runId`                        (addressable run focus)
//
// Engine identity is never read here: the drill-down for a project on any
// engine is derived by the same arithmetic over the same fields.

import type { ProjectPortfolioEntry } from "../../../api-schema.js";
import { hrefForAddressable } from "../../addressable-routing.js";
import { formatMicrosUsd } from "../../format.js";
import {
  activeRunCount,
  provenUnitCount,
  summarizeBlockerReasons,
  unitStageTotal,
} from "../portfolio-progress-model.js";

/** Stable identity for the four drill-down sections. */
export type PortfolioDrilldownSectionKey = "units" | "review" | "patch" | "validate";

/** One labelled number in a drill-down section. */
export type PortfolioDrilldownMetric = {
  key: string;
  label: string;
  value: string | number;
  /** Render in the mono face (ids, money, ratios). */
  mono?: boolean;
};

/** One real, in-app destination reachable from a section. */
export type PortfolioDrilldownLink = {
  key: string;
  label: string;
  detail: string;
  href: string;
};

export type PortfolioDrilldownSection = {
  key: PortfolioDrilldownSectionKey;
  title: string;
  /** One-line statement of what this section is derived from. */
  summary: string;
  metrics: PortfolioDrilldownMetric[];
  links: PortfolioDrilldownLink[];
  /**
   * Stated when the section has no destinations, naming what the portfolio
   * payload lacks. Never a silent empty list.
   */
  emptyLinkNote: string | null;
};

/** Cap on rendered destinations per section so a large project stays scannable. */
export const PORTFOLIO_DRILLDOWN_LINK_LIMIT = 8;

/**
 * Derive all four drill-down sections for one portfolio row. Pure and
 * deterministic: the same row always yields the same sections.
 */
export function derivePortfolioDrilldown(
  project: ProjectPortfolioEntry,
): PortfolioDrilldownSection[] {
  return [
    unitsSection(project),
    reviewSection(project),
    patchSection(project),
    validateSection(project),
  ];
}

function unitsSection(project: ProjectPortfolioEntry): PortfolioDrilldownSection {
  const { unitCounts } = project.progress;
  const total = unitStageTotal(unitCounts);
  const branchUnits = project.localeBranches.reduce((sum, branch) => sum + branch.unitCount, 0);
  const translated = project.localeBranches.reduce(
    (sum, branch) => sum + branch.translatedUnitCount,
    0,
  );
  return {
    key: "units",
    title: "Units",
    summary: "Unit stage rollup across every run, and the branch inventory it draws from.",
    metrics: [
      { key: "tracked", label: "Tracked units", value: total },
      { key: "decoded", label: "Decoded", value: unitCounts.decoded },
      { key: "drafted", label: "Drafted", value: unitCounts.drafted },
      { key: "qa", label: "In QA", value: unitCounts.QA },
      { key: "accepted", label: "Accepted", value: unitCounts.accepted },
      { key: "branch-units", label: "Branch units", value: branchUnits },
      { key: "branch-translated", label: "Branch translated", value: translated },
    ],
    links: project.localeBranches.slice(0, PORTFOLIO_DRILLDOWN_LINK_LIMIT).map((branch) => ({
      key: `units:${branch.localeBranchId}`,
      label: `Play ${branch.targetLocale}`,
      detail: `${String(branch.translatedUnitCount)}/${String(branch.unitCount)} translated`,
      href: `/play?projectId=${encodeURIComponent(project.projectId)}&localeBranchId=${encodeURIComponent(branch.localeBranchId)}`,
    })),
    emptyLinkNote:
      project.localeBranches.length === 0
        ? "This project has no locale branch yet, so there is no unit surface to open."
        : null,
  };
}

function reviewSection(project: ProjectPortfolioEntry): PortfolioDrilldownSection {
  const { blockers } = project.progress;
  const reasons = summarizeBlockerReasons(blockers);
  const blockedRoles = new Set(blockers.map((blocker) => blocker.role));
  const branchFindings = project.localeBranches.reduce(
    (sum, branch) => sum + branch.openFindingCount,
    0,
  );
  const seen = new Set<string>();
  const links: PortfolioDrilldownLink[] = [];
  for (const blocker of blockers) {
    if (seen.has(blocker.bridgeUnitId) || links.length >= PORTFOLIO_DRILLDOWN_LINK_LIMIT) {
      continue;
    }
    seen.add(blocker.bridgeUnitId);
    links.push({
      key: `review:${blocker.bridgeUnitId}`,
      label: "Open unit",
      detail: `${blocker.role} · ${blocker.blockers.length === 0 ? "blocked" : blocker.blockers.join(", ")}`,
      href: hrefForAddressable({
        kind: "unit",
        id: blocker.bridgeUnitId,
        projectId: project.projectId,
        localeBranchId: project.selectedLocaleBranchId,
      }),
    });
  }
  return {
    key: "review",
    title: "Review",
    summary: "Open findings and the blocked unit-roles waiting on a reviewer.",
    metrics: [
      { key: "findings", label: "Open findings", value: project.findingCount },
      { key: "branch-findings", label: "Branch findings", value: branchFindings },
      { key: "blocked", label: "Blocked unit-roles", value: blockers.length },
      { key: "blocked-roles", label: "Blocked roles", value: blockedRoles.size },
      { key: "reasons", label: "Distinct reasons", value: reasons.length },
    ],
    links,
    emptyLinkNote:
      blockers.length === 0 ? "Nothing is blocked on review, so no unit needs opening." : null,
  };
}

function patchSection(project: ProjectPortfolioEntry): PortfolioDrilldownSection {
  const { unitCounts, totalCostMicrosUsd } = project.progress;
  const branchArtifacts = project.localeBranches.reduce(
    (sum, branch) => sum + branch.artifactCount,
    0,
  );
  return {
    key: "patch",
    title: "Patch",
    summary: "Units carried to the terminal patched stage, and the artifacts they produced.",
    metrics: [
      { key: "patched", label: "Patched units", value: provenUnitCount(unitCounts) },
      { key: "awaiting", label: "Accepted, unpatched", value: unitCounts.accepted },
      { key: "artifacts", label: "Artifacts", value: project.artifactCount },
      { key: "branch-artifacts", label: "Branch artifacts", value: branchArtifacts },
      { key: "spend", label: "Spend", value: formatMicrosUsd(totalCostMicrosUsd), mono: true },
    ],
    links: project.localeBranches.slice(0, PORTFOLIO_DRILLDOWN_LINK_LIMIT).map((branch) => ({
      key: `patch:${branch.localeBranchId}`,
      label: `Asset decisions ${branch.targetLocale}`,
      detail: `${String(branch.artifactCount)} artifacts`,
      href: `/projects/${encodeURIComponent(project.projectId)}/locale-branches/${encodeURIComponent(branch.localeBranchId)}/asset-decisions`,
    })),
    emptyLinkNote:
      project.localeBranches.length === 0
        ? "This project has no locale branch yet, so there is no patch surface to open."
        : null,
  };
}

function validateSection(project: ProjectPortfolioEntry): PortfolioDrilldownSection {
  const { runStatusCounts, runCount, averageCoveragePercent, blockers } = project.progress;
  const coverage = Number.isFinite(averageCoveragePercent)
    ? Math.round(averageCoveragePercent * 10) / 10
    : 0;
  const seen = new Set<string>();
  const links: PortfolioDrilldownLink[] = [];
  for (const blocker of blockers) {
    if (seen.has(blocker.runId) || links.length >= PORTFOLIO_DRILLDOWN_LINK_LIMIT) {
      continue;
    }
    seen.add(blocker.runId);
    links.push({
      key: `validate:${blocker.runId}`,
      label: "Open run",
      detail: `${String(blockers.filter((entry) => entry.runId === blocker.runId).length)} blocked unit-roles`,
      href: hrefForAddressable({
        kind: "run",
        id: blocker.runId,
        projectId: project.projectId,
        localeBranchId: project.selectedLocaleBranchId,
      }),
    });
  }
  return {
    key: "validate",
    title: "Validate",
    summary: "Run outcomes and observed coverage for this project.",
    metrics: [
      { key: "runs", label: "Runs", value: runCount },
      { key: "active", label: "In flight", value: activeRunCount(runStatusCounts) },
      { key: "completed", label: "Completed", value: runStatusCounts.completed },
      { key: "failed", label: "Failed", value: runStatusCounts.failed },
      { key: "cancelled", label: "Cancelled", value: runStatusCounts.cancelled },
      { key: "coverage", label: "Avg coverage", value: `${String(coverage)}%`, mono: true },
      { key: "event", label: "Latest event", value: project.latestEventKind ?? "none" },
    ],
    links,
    emptyLinkNote:
      links.length === 0
        ? "The portfolio payload carries a run id only for a blocked unit-role; this project has none, so no run can be opened from here."
        : null,
  };
}
