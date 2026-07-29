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
  bridge: deps.BridgeBundle | deps.BridgeBundleV02,
): void {
  const schemaVersion =
    typeof bridge === "object" && bridge !== null
      ? (bridge as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (schemaVersion === deps.BRIDGE_SCHEMA_VERSION_V02) {
    deps.assertBridgeBundleV02(bridge);
    return;
  }
  deps.assertBridgeBundle(bridge);
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
  if (helpers.isBridgeBundleV02(project.bridge)) {
    const revisions = helpers.uniqueRevisions([
      project.bridge.sourceGame.sourceProfileRevision,
      project.bridge.sourceBundleRevision,
      ...project.bridge.assets.map((asset) => asset.sourceRevision),
      ...project.bridge.units.map((unit) => unit.sourceRevision),
    ]);
    return {
      sourceBundleId: project.bridge.bridgeId,
      bridgeId: project.bridge.bridgeId,
      schemaVersion: project.bridge.schemaVersion,
      sourceBundleHash: project.bridge.sourceBundleHash,
      sourceBundleRevision: project.bridge.sourceBundleRevision,
      sourceLocale: project.bridge.sourceLocale,
      sourceGame: {
        gameId: project.bridge.sourceGame.gameId,
        gameVersion: project.bridge.sourceGame.gameVersion,
        sourceProfileId: project.bridge.sourceGame.sourceProfileId,
      },
      extractor: project.bridge.extractor,
      revisions,
      assets: project.bridge.assets,
      units: project.bridge.units,
    };
  }

  const sourceBundleRevision = helpers.revision(
    `${project.bridge.bridgeId}:bundle-revision`,
    project.bridge.sourceBundleHash,
  );
  const assetById = new Map<string, deps.BridgeAssetV02>();
  for (const unit of project.bridge.units) {
    const assetId = unit.patchRef.assetId;
    if (!assetById.has(assetId)) {
      assetById.set(assetId, {
        assetId,
        assetKey: assetId,
        assetKind: "text",
        sourceHash: project.bridge.sourceBundleHash,
        sourceRevision: helpers.revision(
          `${project.bridge.bridgeId}:asset:${assetId}`,
          project.bridge.sourceBundleHash,
        ),
        path: assetId,
      });
    }
  }

  const assetsV02 = [...assetById.values()];
  const revisions = helpers.uniqueRevisions([
    helpers.revision(`${project.bridge.bridgeId}:source-profile`, project.bridge.sourceBundleHash),
    sourceBundleRevision,
    ...assetsV02.map((asset) => asset.sourceRevision),
    ...project.bridge.units.map((unit) =>
      helpers.revision(`${project.bridge.bridgeId}:unit:${unit.bridgeUnitId}`, unit.sourceHash),
    ),
  ]);

  return {
    sourceBundleId: project.bridge.bridgeId,
    bridgeId: project.bridge.bridgeId,
    schemaVersion: project.bridge.schemaVersion,
    sourceBundleHash: project.bridge.sourceBundleHash,
    sourceBundleRevision,
    sourceLocale: project.bridge.sourceLocale,
    sourceGame: {
      gameId: "hello-game",
      gameVersion: "fixture",
      sourceProfileId: "kaifuu-fixture",
    },
    extractor: {
      name: project.bridge.extractorName,
      version: project.bridge.extractorVersion,
    },
    revisions,
    assets: assetsV02,
    units: project.bridge.units.map(
      (unit): deps.LocalizationUnitV02 => ({
        bridgeUnitId: unit.bridgeUnitId,
        surfaceId: unit.bridgeUnitId,
        surfaceKind: unit.textSurface === "system" ? "ui_label" : "dialogue",
        sourceUnitKey: unit.sourceUnitKey,
        occurrenceId: unit.occurrenceId,
        sourceLocale: unit.sourceLocale,
        sourceText: unit.sourceText,
        sourceHash: unit.sourceHash,
        sourceRevision: helpers.revision(
          `${project.bridge.bridgeId}:unit:${unit.bridgeUnitId}`,
          unit.sourceHash,
        ),
        sourceAssetRef: { assetId: unit.patchRef.assetId, assetKey: unit.patchRef.assetId },
        sourceLocation: {},
        speaker: unit.speaker
          ? {
              knowledgeState: "known",
              speakerId: `${unit.bridgeUnitId}:speaker`,
              displayName: unit.speaker,
            }
          : { knowledgeState: "not_applicable" },
        context:
          unit.context === undefined ? {} : { route: { sceneId: unit.context.route.sceneId } },
        spans: unit.protectedSpans.map((span) => ({
          spanId: `${unit.bridgeUnitId}:${span.start}:${span.end}`,
          spanKind: "variable_placeholder",
          raw: span.raw,
          startByte: span.start,
          endByte: span.end,
          preserveMode: span.preserveMode,
        })),
        patchRef: {
          assetId: unit.patchRef.assetId,
          writeMode: unit.patchRef.writeMode,
          sourceUnitKey: unit.patchRef.sourceUnitKey,
          sourceRevision: helpers.revision(
            `${project.bridge.bridgeId}:unit:${unit.bridgeUnitId}`,
            unit.sourceHash,
          ),
        },
        runtimeExpectation: { expectationKind: "trace_text" },
      }),
    ),
  };
}

export function revision(revisionId: string, value: string): deps.SourceRevisionV02 {
  return {
    revisionId,
    revisionKind: "content_hash",
    value,
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

export function isBridgeBundleV02(
  bundle: deps.BridgeBundle | deps.BridgeBundleV02,
): bundle is deps.BridgeBundleV02 {
  return bundle.schemaVersion === "0.2.0";
}

export function sourceBundleIdFor(bundle: deps.BridgeBundle | deps.BridgeBundleV02): string {
  return bundle.bridgeId;
}
