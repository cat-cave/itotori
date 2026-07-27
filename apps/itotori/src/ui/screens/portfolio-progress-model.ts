// Pure portfolio progress helpers — aggregates, stage mapping, sort keys.
// Kept out of the panel module so the React surface stays under the line budget.

import type {
  ProjectRunPortfolioProgressSummary,
  ProjectRunProgressStatusCounts,
  ProjectRunStatusCounts,
} from "@itotori/db";
import type { LocalizationStage } from "@itotori/ds";
import type { ProjectPortfolioEntry } from "../../api-schema.js";

const STAGE_ORDER = ["decoded", "drafted", "QA", "accepted", "patched"] as const;

type StageTone = NonNullable<LocalizationStage["tone"]>;

const STAGE_META: Readonly<
  Record<(typeof STAGE_ORDER)[number], { label: string; tone: StageTone; key: string }>
> = {
  decoded: { label: "decoded", tone: "cyan", key: "decoded" },
  drafted: { label: "drafted", tone: "amber", key: "drafted" },
  QA: { label: "qa", tone: "sakura", key: "qa" },
  accepted: { label: "accepted", tone: "mint", key: "accepted" },
  // Proven slot = terminal patched stage for the portfolio rollup.
  patched: { label: "patched", tone: "mint", key: "proven" },
};

/** Portfolio-wide arithmetic rollup over ready `projects.list` rows. */
export type PortfolioAggregate = {
  projectCount: number;
  activeRunCount: number;
  totalRunCount: number;
  totalCostMicrosUsd: number;
  totalBlockers: number;
  totalFindings: number;
  engineCount: number;
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

/** Sum unit stage counts into a total addressable unit count. */
export function unitStageTotal(unitCounts: ProjectRunProgressStatusCounts): number {
  return STAGE_ORDER.reduce((sum, stage) => sum + unitCounts[stage], 0);
}

/** Build stage segments from portfolio unitCounts (composition legend / mix bar). */
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

/** Units in the terminal proven stage (patched). */
export function provenUnitCount(unitCounts: ProjectRunProgressStatusCounts): number {
  return unitCounts.patched;
}

/** True when the project has no recorded runs (clean empty-state path). */
export function isRunlessPortfolioProgress(progress: ProjectRunPortfolioProgressSummary): boolean {
  return progress.runCount <= 0;
}

/** Active (in-flight) run count for one project's status rollup. */
export function activeRunCount(counts: ProjectRunStatusCounts): number {
  return counts.running + counts.paused + counts.queued;
}

/**
 * Aggregate portfolio metrics from the real list payload. Pure + deterministic.
 */
export function aggregatePortfolio(projects: readonly ProjectPortfolioEntry[]): PortfolioAggregate {
  let activeRuns = 0;
  let totalRuns = 0;
  let totalCost = 0;
  let totalBlockers = 0;
  let totalFindings = 0;
  const engines = new Set<string>();
  for (const project of projects) {
    activeRuns += activeRunCount(project.progress.runStatusCounts);
    totalRuns += project.progress.runCount;
    totalCost += project.progress.totalCostMicrosUsd;
    totalBlockers += project.progress.blockers.length;
    totalFindings += project.findingCount;
    if (project.engineFamily !== null && project.engineFamily.length > 0) {
      engines.add(project.engineFamily);
    }
  }
  return {
    projectCount: projects.length,
    activeRunCount: activeRuns,
    totalRunCount: totalRuns,
    totalCostMicrosUsd: totalCost,
    totalBlockers,
    totalFindings,
    engineCount: engines.size,
  };
}

/** Priority score: running ≫ paused ≫ queued so in-flight work sorts first. */
export function activityScore(counts: ProjectRunStatusCounts): number {
  return counts.running * 100 + counts.paused * 10 + counts.queued;
}

/**
 * Stable sort for at-a-glance scanning: in-flight work first (running, then
 * paused, then queued), then anything needing attention (blockers / findings),
 * then project key.
 */
export function sortPortfolioProjects(
  projects: readonly ProjectPortfolioEntry[],
): ProjectPortfolioEntry[] {
  return [...projects].sort((left, right) => {
    const leftActive = activityScore(left.progress.runStatusCounts);
    const rightActive = activityScore(right.progress.runStatusCounts);
    if (leftActive !== rightActive) {
      return rightActive - leftActive;
    }
    const leftAttention = left.progress.blockers.length + left.findingCount;
    const rightAttention = right.progress.blockers.length + right.findingCount;
    if (leftAttention !== rightAttention) {
      return rightAttention - leftAttention;
    }
    return left.projectKey.localeCompare(right.projectKey);
  });
}

export type BlockerReasonRow = {
  key: string;
  role: string;
  reasons: string;
  count: number;
};

/**
 * Collapse portfolio blockers to role + reason codes only. Does not surface
 * run / unit identifiers in the UI (those are internal handles, not labels).
 */
export function summarizeBlockerReasons(
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
