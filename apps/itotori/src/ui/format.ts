// fnd-spa-shell — presentation formatters ported verbatim from the deleted
// HTML-string dashboard so the SPA keeps byte-for-byte number/label parity
// (real recorded micros-USD, token counts, the $25 indie cost target). No
// game is named; these are pure functions over the typed read-models.

import type { DashboardPendingDecision, ProjectDashboardStatus } from "@itotori/db";

// ITOTORI-027 — the indie-localization cost target the dashboard tracks
// EMPIRICALLY (real billed micros-USD vs this ceiling, never an estimate).
export const INDIE_LOCALIZATION_COST_TARGET_MICROS_USD = 25_000_000;

export function formatMicrosUsd(value: number | null): string {
  if (value === null) {
    return "unknown";
  }
  return `$${(value / 1_000_000).toFixed(6)}`;
}

export function formatSignedMicrosUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${(Math.abs(value) / 1_000_000).toFixed(6)}`;
}

export function formatTokens(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

export function formatDiff(
  diff: ProjectDashboardStatus["importStatus"]["units"],
  total: number,
): string {
  return `${total} (${diff.added} new / ${diff.updated} updated / ${diff.removed} removed)`;
}

export function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

export function decisionSignal(decision: DashboardPendingDecision): string {
  if (decision.decisionKind === "runtime_validation") {
    return decision.runtimeStatus ?? decision.branchStatus ?? "pending";
  }
  return decision.qualityCategory ?? decision.severity;
}

export function decisionGroupSignal(
  pendingDecisions: DashboardPendingDecision[],
  decisionKind: DashboardPendingDecision["decisionKind"],
): string {
  const decision = pendingDecisions.find((candidate) => candidate.decisionKind === decisionKind);
  return decision === undefined ? "pending" : decisionSignal(decision);
}

export function groupedBranchDecisions(
  pendingDecisions: DashboardPendingDecision[],
): Array<{ area: string; count: number; signal: string }> {
  const groups = new Map<string, { area: string; count: number; signal: string }>();
  for (const decision of pendingDecisions) {
    if (decision.decisionKind !== "locale_branch_finding") {
      continue;
    }
    const area = decision.targetLocale ?? decision.localeBranchId ?? "Locale branch";
    const existing = groups.get(area);
    if (existing === undefined) {
      groups.set(area, {
        area,
        count: 1,
        signal: decision.branchStatus ?? decisionSignal(decision),
      });
      continue;
    }
    existing.count += 1;
  }
  return [...groups.values()];
}
