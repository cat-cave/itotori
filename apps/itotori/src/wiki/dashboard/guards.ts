// Browser-safe structural guards for the Wiki bible dashboard responses.
//
// The surface reads these over real HTTP, so it validates the envelope it
// received before trusting it — the same discipline the shell's typed client
// applies. These guards are STRUCTURAL and dependency-free (no zod, no db): they
// assert the schema tag and the required top-level keys so a drifted or hostile
// payload fails loudly in the data layer instead of corrupting the render. The
// deep field contracts stay with the server-side object API that produced them.

import {
  WIKI_DASHBOARD_OBJECT_SCHEMA,
  WIKI_DASHBOARD_OVERVIEW_SCHEMA,
  WIKI_DASHBOARD_WRITE_SCHEMA,
  type WikiDashboardObject,
  type WikiDashboardOverview,
  type WikiDashboardWriteReceipt,
} from "./read-model.js";

export function assertWikiDashboardOverview(
  value: unknown,
): asserts value is WikiDashboardOverview {
  const record = asRecord(value, "WikiDashboardOverview");
  assertSchema(record, WIKI_DASHBOARD_OVERVIEW_SCHEMA);
  assertKeys(record, "WikiDashboardOverview", [
    "snapshotId",
    "sourceObjects",
    "renderings",
    "routes",
    "readiness",
  ]);
}

export function assertWikiDashboardObject(value: unknown): asserts value is WikiDashboardObject {
  const record = asRecord(value, "WikiDashboardObject");
  assertSchema(record, WIKI_DASHBOARD_OBJECT_SCHEMA);
  assertKeys(record, "WikiDashboardObject", ["object", "history", "dependents"]);
}

export function assertWikiDashboardWriteReceipt(
  value: unknown,
): asserts value is WikiDashboardWriteReceipt {
  const record = asRecord(value, "WikiDashboardWriteReceipt");
  assertSchema(record, WIKI_DASHBOARD_WRITE_SCHEMA);
  assertKeys(record, "WikiDashboardWriteReceipt", [
    "inputId",
    "addressedObjectId",
    "head",
    "object",
    "badges",
    "invalidatedObjectIds",
  ]);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertSchema(record: Record<string, unknown>, expected: string): void {
  if (record.schemaVersion !== expected) {
    throw new Error(`expected schemaVersion ${expected}, received ${String(record.schemaVersion)}`);
  }
}

function assertKeys(record: Record<string, unknown>, label: string, keys: readonly string[]): void {
  for (const key of keys) {
    if (!(key in record)) {
      throw new Error(`${label}.${key} is required`);
    }
  }
}
