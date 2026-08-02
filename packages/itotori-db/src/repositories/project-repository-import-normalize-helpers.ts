import * as deps from "./project-repository-dependencies.js";
import * as api from "./project-repository-types.js";
import * as helpers from "./project-repository-helpers.js";

export function timestampString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  return "";
}

export function dashboardPendingDecisionFromRow(
  row: Record<string, unknown>,
): api.DashboardPendingDecision {
  const decisionKind = helpers.dashboardDecisionKind(row.decision_kind);
  const findingId = String(row.finding_id);
  return {
    decisionId: `${decisionKind}:${findingId}`,
    decisionKind,
    projectId: String(row.project_id),
    findingId,
    findingKind: String(row.finding_kind),
    severity: String(row.severity),
    qualityCategory: helpers.nullableString(row.quality_category),
    title: String(row.title),
    localeBranchId: helpers.nullableString(row.locale_branch_id),
    targetLocale: helpers.nullableString(row.target_locale),
    branchStatus: helpers.nullableString(row.branch_status),
    runtimeRunId: helpers.nullableString(row.runtime_run_id),
    runtimeStatus: helpers.nullableString(row.runtime_status),
    createdAt: helpers.timestampString(row.created_at),
  };
}

export function dashboardDecisionKind(value: unknown): api.DashboardPendingDecisionKind {
  if (
    value === "project_finding" ||
    value === "locale_branch_finding" ||
    value === "runtime_validation"
  ) {
    return value;
  }
  throw new Error(`unknown dashboard decision kind: ${String(value)}`);
}

export function dashboardDecisionCounts(
  pendingDecisions: api.DashboardPendingDecision[],
): api.DashboardDecisionCounts {
  const counts: api.DashboardDecisionCounts = {
    pendingDecisionCount: pendingDecisions.length,
    projectFindingDecisionCount: 0,
    localeBranchFindingDecisionCount: 0,
    runtimeValidationDecisionCount: 0,
  };
  for (const decision of pendingDecisions) {
    switch (decision.decisionKind) {
      case "project_finding":
        counts.projectFindingDecisionCount += 1;
        break;
      case "locale_branch_finding":
        counts.localeBranchFindingDecisionCount += 1;
        break;
      case "runtime_validation":
        counts.runtimeValidationDecisionCount += 1;
        break;
    }
  }
  return counts;
}

export function assertImportableBridgeBundle(
  bridge: unknown,
): asserts bridge is deps.BridgeBundleV02 {
  deps.assertBridgeBundleV02(bridge);
}

export function jsonEquals(left: unknown, right: unknown): boolean {
  return helpers.stableJson(left) === helpers.stableJson(right);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => helpers.stableJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${helpers.stableJson(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeSourceBundle(
  project: api.ItotoriProjectRecord,
): helpers.NormalizedSourceBundle {
  const bridge = project.bridge;
  helpers.assertImportableBridgeBundle(bridge);
  const revisions = helpers.uniqueRevisions([
    bridge.sourceGame.sourceProfileRevision,
    bridge.sourceBundleRevision,
    ...bridge.assets.map((asset) => asset.sourceRevision),
    ...bridge.units.map((unit) => unit.sourceRevision),
  ]);
  return {
    sourceBundleId: bridge.bridgeId,
    bridgeId: bridge.bridgeId,
    schemaVersion: bridge.schemaVersion,
    sourceBundleHash: bridge.sourceBundleHash,
    sourceBundleRevision: bridge.sourceBundleRevision,
    sourceLocale: bridge.sourceLocale,
    sourceGame: {
      gameId: bridge.sourceGame.gameId,
      gameVersion: bridge.sourceGame.gameVersion,
      sourceProfileId: bridge.sourceGame.sourceProfileId,
    },
    extractor: bridge.extractor,
    revisions,
    assets: bridge.assets,
    units: bridge.units,
  };
}

export function uniqueRevisions(revisions: deps.SourceRevisionV02[]): deps.SourceRevisionV02[] {
  const byId = new Map<string, deps.SourceRevisionV02>();
  for (const revisionRecord of revisions) {
    const existing = byId.get(revisionRecord.revisionId);
    if (
      existing !== undefined &&
      (existing.revisionKind !== revisionRecord.revisionKind ||
        existing.value !== revisionRecord.value)
    ) {
      throw new Error(
        `source revision ${revisionRecord.revisionId} appears multiple times with different content`,
      );
    }
    byId.set(revisionRecord.revisionId, revisionRecord);
  }
  return [...byId.values()];
}

export function sourceBundleIdFor(bundle: deps.BridgeBundleV02): string {
  return bundle.bridgeId;
}
