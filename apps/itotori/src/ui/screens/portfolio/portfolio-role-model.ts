// Per-ROLE portfolio progress rows.
//
// `projects.list` carries `progress.roleCounts` — a `role -> unit-stage counts`
// aggregate produced by the portfolio SQL rollup. Roles are opaque registry
// keys from the wire (the same vocabulary the run pipeline writes); this module
// never enumerates them, so a new role appears without a code change. Engine
// identity is not consulted here at all.

import type { ProjectRunProgressStatusCounts } from "@itotori/db";
import type { LocalizationStage } from "@itotori/ds";
import {
  portfolioUnitStages,
  provenUnitCount,
  unitStageTotal,
} from "../portfolio-progress-model.js";

/** One role's unit-stage rollup within a single project. */
export type PortfolioRoleRow = {
  /** Opaque role key exactly as the wire carries it. */
  role: string;
  counts: ProjectRunProgressStatusCounts;
  /** Unit-role records across every stage. */
  total: number;
  /** Records in the terminal proven (patched) stage. */
  proven: number;
  /** proven/total as a percentage, one decimal; 0 when the role has no records. */
  provenPercent: number;
  /** Stage segments for the composition bar (same vocabulary as the card). */
  stages: LocalizationStage[];
};

/**
 * Build per-role rows from `progress.roleCounts`. Rows with zero records are
 * dropped (an empty role contributes no bar), and the result is ordered by
 * volume desc then role asc so the busiest role reads first and the order is
 * stable across polls.
 */
export function portfolioRoleRows(
  roleCounts: Readonly<Record<string, ProjectRunProgressStatusCounts>>,
): PortfolioRoleRow[] {
  const rows: PortfolioRoleRow[] = [];
  for (const [role, counts] of Object.entries(roleCounts)) {
    const total = unitStageTotal(counts);
    if (total <= 0) {
      continue;
    }
    const proven = provenUnitCount(counts);
    rows.push({
      role,
      counts,
      total,
      proven,
      provenPercent: Math.round((proven / total) * 1000) / 10,
      stages: portfolioUnitStages(counts),
    });
  }
  return rows.sort((left, right) => {
    if (left.total !== right.total) {
      return right.total - left.total;
    }
    return left.role.localeCompare(right.role);
  });
}

/** Distinct roles that carry at least one unit-role record. */
export function portfolioRoleCount(
  roleCounts: Readonly<Record<string, ProjectRunProgressStatusCounts>>,
): number {
  return portfolioRoleRows(roleCounts).length;
}
