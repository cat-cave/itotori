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
  "workspace.correctionSubmit": ["submittedCount", "edits"],
  "assetDecisions.active": ["decisions"],
  "assetDecisions.candidates": ["candidateAssets"],
  "terminology.search": ["rows"],
  "wiki.entries": ["entries"],
  "queue.health": ["outbox", "jobs"],
  "catalog.conflicts": ["rows"],
  "catalog.completeness": ["pools"],
  "catalog.benchmarkSeeds": ["rows"],
  "catalog.contextPanel": ["params", "row", "releases", "projectState"],
  "catalog.opportunities": ["rows"],
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
