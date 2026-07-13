import type { ApiErrorResponse, ItotoriApiRouteId } from "./api-schema.js";

const API_ERROR_RESPONSE_CODES = [
  "bad_request",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "internal_error",
] as const satisfies readonly ApiErrorResponse["code"][];

const REQUIRED_RESPONSE_KEYS: Readonly<Partial<Record<ItotoriApiRouteId, readonly string[]>>> = {
  "auth.capabilities": ["schemaVersion", "actorUserId", "denials"],
  "projects.list": ["projects"],
  "projects.status": ["projectId", "selectedLocaleBranchId"],
  "projects.overview": ["projectId", "progress"],
  "projects.decisions": ["pendingDecisions"],
  "projects.cost": ["recentRuns"],
  "projects.costDrilldown": ["rows"],
  "projects.benchmarks": ["reports"],
  "projects.bmkCockpit": ["contestants", "humanAnchor", "confidence"],
  "projects.bmkCockpitHistory": ["rows"],
  "jobs.runTable": ["rows"],
  "runtime.status": ["runtimeRunId", "traceEvents"],
  "reviewer.queue": ["rows", "aggregate"],
  "reviewer.detail": ["reviewItemId"],
  "reviewer.batchPreview": ["request", "items"],
  "reviewer.batchExecute": ["request", "applied"],
  "reviewer.itemAction": ["request", "outcome"],
  "workspace.projects": ["projects"],
  "workspace.scenes": ["scenes"],
  "workspace.assets": ["assets"],
  "workspace.comparison": ["reviewItemId", "cells"],
  "workspace.search": ["results"],
  "workspace.correctionPreview": ["units"],
  "assetDecisions.active": ["decisions"],
  "assetDecisions.candidates": ["candidateAssets"],
  "terminology.search": ["rows"],
  "wiki.list": ["schemaVersion", "entries"],
  "wiki.show": ["schemaVersion", "entry"],
  "wiki.history": ["schemaVersion", "versions"],
  "wiki.edit": ["schemaVersion", "contextEntryVersionId", "rerun", "entry"],
  "wiki.add": ["schemaVersion", "contextEntryVersionId", "rerun", "entry"],
  "queue.health": ["outbox", "jobs"],
  "catalog.conflicts": ["rows"],
  "catalog.completeness": ["pools"],
  "catalog.benchmarkSeeds": ["rows"],
  "catalog.contextPanel": ["params", "row", "releases", "projectState"],
  "catalog.opportunities": ["rows"],
  "settings.translationScope.get": ["projectId", "localeBranchId", "scope"],
  "settings.translationScope.save": ["projectId", "localeBranchId", "scope"],
  "play.targetEdit": ["patchVersionId", "resultRevisionId", "selectedAt"],
  "play.delivery": ["patchVersionId", "artifactHashes", "downloadUrl", "units"],
  "patchIteration.delivery": ["patchVersionId", "artifactHashes", "downloadUrl", "units"],
  "patchIteration.versions": ["schemaVersion", "versions"],
  "patchIteration.surface": ["schemaVersion", "patch", "versions", "feedback"],
  "patchIteration.play": ["schemaVersion", "session"],
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
export function assertBrowserItotoriApiResponse(routeId: ItotoriApiRouteId, body: unknown): void {
  const record = assertRecord(body, `response for ${routeId}`);
  for (const key of REQUIRED_RESPONSE_KEYS[routeId] ?? []) {
    if (!(key in record)) {
      throw new Error(`response for ${routeId}.${key} is required`);
    }
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
  if (typeof bridge.schemaVersion !== "string" || bridge.schemaVersion.length === 0) {
    throw new Error("BridgeInput.schemaVersion is required");
  }
}
