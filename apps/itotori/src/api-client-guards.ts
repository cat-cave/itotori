import type { ApiErrorResponse, ItotoriApiRouteId } from "./api-schema.js";
import type { CatalogContextPanelReadModel } from "./catalog-context-panel.js";
import type { CatalogReleaseRecord } from "@itotori/db";

export type BrowserCatalogContextPanelResponse = Omit<
  CatalogContextPanelReadModel,
  "generatedAt" | "releases"
> & {
  generatedAt: string;
  releases: BrowserCatalogReleaseRecord[];
};

type BrowserCatalogReleaseRecord = Omit<CatalogReleaseRecord, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

const API_ERROR_RESPONSE_CODES = [
  "bad_request",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "run_transition_rejected",
  "internal_error",
] as const satisfies readonly ApiErrorResponse["code"][];

const BROWSER_BRIDGE_SCHEMA_VERSION = "0.2.0";

const REQUIRED_RESPONSE_KEYS: Readonly<Partial<Record<ItotoriApiRouteId, readonly string[]>>> = {
  "auth.capabilities": ["schemaVersion", "actorUserId", "denials"],
  "projects.list": ["projects"],
  "projects.status": ["projectId", "selectedLocaleBranchId"],
  "projects.overview": ["projectId", "progress"],
  "projects.decisions": ["pendingDecisions"],
  "projects.cost": ["recentRuns"],
  "projects.costDrilldown": ["rows"],
  "projects.benchmarks": ["reports"],
  "jobs.runTable": ["rows"],
  "runtime.status": ["runtimeRunId", "traceEvents"],
  "assetDecisions.active": ["decisions"],
  "assetDecisions.candidates": ["candidateAssets"],
  "terminology.search": ["rows"],
  "wiki.list": ["schemaVersion", "sourceObjects", "renderings"],
  "wiki.show": ["schemaVersion", "view", "history", "dependencyImpact"],
  "wiki.history": ["schemaVersion", "view", "history"],
  "wiki.edit": ["schemaVersion", "receipt", "history", "dependencyImpact"],
  "wiki.feedback": ["schemaVersion", "receipt", "history", "dependencyImpact"],
  "wiki.apply": ["schemaVersion", "receipt", "history", "dependencyImpact"],
  "queue.health": ["outbox", "jobs"],
  "catalog.conflicts": ["rows"],
  "catalog.completeness": ["pools"],
  "catalog.benchmarkSeeds": ["rows"],
  "catalog.contextPanel": ["params", "row", "releases", "projectState"],
  "catalog.opportunities": ["rows"],
  "settings.translationScope.get": ["projectId", "localeBranchId", "scope"],
  "settings.translationScope.save": ["projectId", "localeBranchId", "scope"],
  "projects.pausePass": ["schemaVersion", "action", "journalRunId", "status", "transitionedAt"],
  "projects.resumePass": ["schemaVersion", "action", "journalRunId", "status", "transitionedAt"],
  "play.targetEdit": ["patchVersionId", "resultRevisionId", "selectedAt"],
  "play.addressableUnit": ["schemaVersion", "projectId", "localeBranchId", "unit"],
  "play.delivery": ["patchVersionId", "artifactHashes", "downloadUrl", "units"],
  "patchIteration.delivery": ["patchVersionId", "artifactHashes", "downloadUrl", "units"],
  "patchIteration.versions": ["schemaVersion", "versions"],
  "patchIteration.surface": ["schemaVersion", "patch", "versions", "feedback"],
  "patchIteration.play": ["schemaVersion", "receipt"],
  "patchIteration.feedbackBatch": ["schemaVersion", "batch"],
  "patchIteration.feedback": ["schemaVersion", "feedback"],
  "patchIteration.refine": ["schemaVersion", "refinement", "patch"],
};

/**
 * Browser-side response guard for the React shell client.
 *
 * The server, fixture tests, and contract harness continue to use the full
 * `api-schema.ts` guard. The browser client cannot import that module at
 * runtime because it also imports Node-oriented bridge-schema validators that
 * reference `Buffer` during bundle evaluation.
 */
export function assertBrowserItotoriApiResponse(
  routeId: "catalog.contextPanel",
  body: unknown,
): asserts body is BrowserCatalogContextPanelResponse;
export function assertBrowserItotoriApiResponse(routeId: ItotoriApiRouteId, body: unknown): void;
export function assertBrowserItotoriApiResponse(routeId: ItotoriApiRouteId, body: unknown): void {
  if (routeId === "projects.decodeExtract") {
    const response = assertRecord(body, "response for projects.decodeExtract");
    assertBrowserBridgeInput(response.bridge);
  }
  const record = assertRecord(body, `response for ${routeId}`);
  for (const key of REQUIRED_RESPONSE_KEYS[routeId] ?? []) {
    if (!(key in record)) {
      throw new Error(`response for ${routeId}.${key} is required`);
    }
  }
  if (routeId === "catalog.contextPanel") {
    assertBrowserCatalogContextPanelResponse(body);
  }
}

export function assertBrowserItotoriApiRequest(routeId: ItotoriApiRouteId, body: unknown): void {
  if (routeId === "imports.bridge") {
    const request = assertRecord(body, "request for imports.bridge");
    assertBrowserBridgeInput(request.bridge);
  }
}

export function assertBrowserItotoriApiErrorResponse(
  body: unknown,
): asserts body is ApiErrorResponse {
  const record = assertRecord(body, "ApiErrorResponse");
  if (typeof record.error !== "string") {
    throw new Error("ApiErrorResponse.error must be a string");
  }
  if (
    typeof record.code !== "string" ||
    !(API_ERROR_RESPONSE_CODES as readonly string[]).includes(record.code)
  ) {
    throw new Error("ApiErrorResponse.code is invalid");
  }
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertBrowserCatalogContextPanelResponse(
  value: unknown,
): asserts value is BrowserCatalogContextPanelResponse {
  const model = assertRecord(value, "catalog.contextPanel");
  assertProperties(model, [
    "schemaVersion",
    "generatedAt",
    "params",
    "row",
    "releases",
    "projectState",
  ]);
  assertLiteral(
    model.schemaVersion,
    "catalog.context_panel_route.v0.1",
    "catalog.contextPanel.schemaVersion",
  );
  assertDateString(model.generatedAt, "catalog.contextPanel.generatedAt");
  assertParams(model.params);
  assertCatalogRow(model.row);
  assertReleases(model.releases);
  assertProjectState(model.projectState);
}

function assertParams(value: unknown): void {
  const params = assertRecord(value, "catalog.contextPanel.params");
  assertProperties(params, ["projectId", "localeBranchId", "workId"]);
  for (const key of ["projectId", "localeBranchId", "workId"] as const) {
    assertString(params[key], `catalog.contextPanel.params.${key}`);
  }
}

function assertCatalogRow(value: unknown): void {
  const row = assertRecord(value, "catalog.contextPanel.row");
  assertProperties(row, [
    "workId",
    "canonicalTitle",
    "originalLanguage",
    "sourceIds",
    "completenessPool",
    "translationStatuses",
    "localOwnership",
    "localEvidenceCount",
    "demandBucket",
    "readiness",
    "provenance",
    "decision",
    "rank",
    "seedRank",
    "explanationCodes",
  ]);
  for (const key of [
    "workId",
    "canonicalTitle",
    "completenessPool",
    "localOwnership",
    "demandBucket",
    "decision",
  ] as const) {
    assertString(row[key], `catalog.contextPanel.row.${key}`);
  }
  assertNullableString(row.originalLanguage, "catalog.contextPanel.row.originalLanguage");
  assertNonNegativeNumber(row.localEvidenceCount, "catalog.contextPanel.row.localEvidenceCount");
  assertNonNegativeInteger(row.rank, "catalog.contextPanel.row.rank");
  assertNullableNonNegativeInteger(row.seedRank, "catalog.contextPanel.row.seedRank");
  assertStringArray(row.explanationCodes, "catalog.contextPanel.row.explanationCodes");
  assertSourceIds(row.sourceIds);
  assertTranslationStatuses(row.translationStatuses);
  assertReadiness(row.readiness);
  assertProvenance(row.provenance);
}

function assertSourceIds(value: unknown): void {
  assertArray(value, "catalog.contextPanel.row.sourceIds").forEach((entry, index) => {
    const sourceId = assertRecord(entry, `catalog.contextPanel.row.sourceIds[${index}]`);
    assertProperties(sourceId, ["catalogSource", "sourceId", "externalIdKind"]);
    for (const key of ["catalogSource", "sourceId", "externalIdKind"] as const) {
      assertString(sourceId[key], `catalog.contextPanel.row.sourceIds[${index}].${key}`);
    }
  });
}

function assertTranslationStatuses(value: unknown): void {
  assertArray(value, "catalog.contextPanel.row.translationStatuses").forEach((entry, index) => {
    const status = assertRecord(entry, `catalog.contextPanel.row.translationStatuses[${index}]`);
    assertProperties(status, ["language", "status", "confidence", "statusScope", "platform"]);
    for (const key of ["language", "status", "confidence", "statusScope"] as const) {
      assertString(status[key], `catalog.contextPanel.row.translationStatuses[${index}].${key}`);
    }
    assertNullableString(
      status.platform,
      `catalog.contextPanel.row.translationStatuses[${index}].platform`,
    );
  });
}

function assertReadiness(value: unknown): void {
  const readiness = assertRecord(value, "catalog.contextPanel.row.readiness");
  assertProperties(readiness, [
    "adapterId",
    "identify",
    "inventory",
    "extract",
    "patch",
    "helper",
    "runtime",
  ]);
  assertNullableString(readiness.adapterId, "catalog.contextPanel.row.readiness.adapterId");
  for (const key of ["identify", "inventory", "extract", "patch", "helper", "runtime"] as const) {
    assertString(readiness[key], `catalog.contextPanel.row.readiness.${key}`);
  }
}

function assertProvenance(value: unknown): void {
  assertArray(value, "catalog.contextPanel.row.provenance").forEach((entry, index) => {
    const provenance = assertRecord(entry, `catalog.contextPanel.row.provenance[${index}]`);
    assertProperties(provenance, [
      "catalogSource",
      "sourceId",
      "sourceRecordKind",
      "sourceVersion",
      "fixtureId",
      "redactionClass",
    ]);
    for (const key of [
      "catalogSource",
      "sourceId",
      "sourceRecordKind",
      "redactionClass",
    ] as const) {
      assertString(provenance[key], `catalog.contextPanel.row.provenance[${index}].${key}`);
    }
    assertNullableString(
      provenance.sourceVersion,
      `catalog.contextPanel.row.provenance[${index}].sourceVersion`,
    );
    assertNullableString(
      provenance.fixtureId,
      `catalog.contextPanel.row.provenance[${index}].fixtureId`,
    );
  });
}

function assertReleases(value: unknown): void {
  assertArray(value, "catalog.contextPanel.releases").forEach((entry, index) => {
    const release = assertRecord(entry, `catalog.contextPanel.releases[${index}]`);
    assertProperties(release, [
      "releaseId",
      "workId",
      "catalogSource",
      "sourceReleaseId",
      "releaseTitle",
      "releaseKind",
      "editionName",
      "milestone",
      "packageKind",
      "engineName",
      "engineSource",
      "engineConfidence",
      "engineProvenanceId",
      "platform",
      "language",
      "releaseDate",
      "releaseYear",
      "isOfficial",
      "sourceProvenanceId",
      "metadata",
      "createdAt",
      "updatedAt",
    ]);
    for (const key of [
      "releaseId",
      "workId",
      "catalogSource",
      "releaseTitle",
      "releaseKind",
      "packageKind",
    ] as const) {
      assertString(release[key], `catalog.contextPanel.releases[${index}].${key}`);
    }
    for (const key of [
      "sourceReleaseId",
      "editionName",
      "milestone",
      "engineName",
      "engineSource",
      "engineConfidence",
      "engineProvenanceId",
      "platform",
      "language",
      "releaseDate",
      "sourceProvenanceId",
    ] as const) {
      assertNullableString(release[key], `catalog.contextPanel.releases[${index}].${key}`);
    }
    assertNullableNonNegativeInteger(
      release.releaseYear,
      `catalog.contextPanel.releases[${index}].releaseYear`,
    );
    if (typeof release.isOfficial !== "boolean")
      throw new Error(`catalog.contextPanel.releases[${index}].isOfficial must be a boolean`);
    assertRecord(release.metadata, `catalog.contextPanel.releases[${index}].metadata`);
    assertDateString(release.createdAt, `catalog.contextPanel.releases[${index}].createdAt`);
    assertDateString(release.updatedAt, `catalog.contextPanel.releases[${index}].updatedAt`);
  });
}

function assertProjectState(value: unknown): void {
  const state = assertRecord(value, "catalog.contextPanel.projectState");
  assertProperties(state, ["targetLanguage", "localeBranch"]);
  assertString(state.targetLanguage, "catalog.contextPanel.projectState.targetLanguage");
  if (state.localeBranch === null) return;
  const branch = assertRecord(state.localeBranch, "catalog.contextPanel.projectState.localeBranch");
  assertProperties(branch, [
    "localeBranchId",
    "targetLocale",
    "status",
    "currentStyleGuidePolicyVersionId",
    "unitCount",
    "translatedUnitCount",
    "openFindingCount",
    "artifactCount",
  ]);
  for (const key of ["localeBranchId", "targetLocale", "status"] as const) {
    assertString(branch[key], `catalog.contextPanel.projectState.localeBranch.${key}`);
  }
  assertNullableString(
    branch.currentStyleGuidePolicyVersionId,
    "catalog.contextPanel.projectState.localeBranch.currentStyleGuidePolicyVersionId",
  );
  for (const key of [
    "unitCount",
    "translatedUnitCount",
    "openFindingCount",
    "artifactCount",
  ] as const) {
    assertNonNegativeInteger(branch[key], `catalog.contextPanel.projectState.localeBranch.${key}`);
  }
}

function assertProperties(record: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) if (!(key in record)) throw new Error(`${key} is required`);
}

function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
}

function assertNullableString(value: unknown, label: string): void {
  if (value !== null && typeof value !== "string")
    throw new Error(`${label} must be a string or null`);
}

function assertStringArray(value: unknown, label: string): void {
  assertArray(value, label).forEach((entry, index) => assertString(entry, `${label}[${index}]`));
}

function assertNonNegativeNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be a non-negative number`);
}

function assertNonNegativeInteger(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function assertNullableNonNegativeInteger(value: unknown, label: string): void {
  if (value !== null) assertNonNegativeInteger(value, label);
}

function assertDateString(value: unknown, label: string): void {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime()))
    throw new Error(`${label} must be a parseable ISO date string`);
}

function assertLiteral(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`${label} must be ${expected}`);
}

/**
 * Browser-side structural gate for an uploaded bridge JSON.
 *
 * Do NOT call `assertBridgeInput` from `api-schema.ts` in the SPA: that module
 * pulls `@itotori/localization-bridge-schema` validators that evaluate Node
 * `Buffer` at import time and crash the client bundle (`Buffer is not defined`).
 * Full bridge validation still runs server-side on `imports.bridge`.
 */
export function assertBrowserBridgeInput(value: unknown): asserts value is Record<string, unknown> {
  const bridge = assertRecord(value, "BridgeInput");
  if (bridge.schemaVersion !== BROWSER_BRIDGE_SCHEMA_VERSION) {
    throw new Error("BridgeInput.schemaVersion must be 0.2.0; migrate before import");
  }
}
