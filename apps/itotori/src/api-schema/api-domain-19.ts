import {
  CostDrilldownPage,
  JobsRunTableReadModel,
  PROJECT_OVERVIEW_SCHEMA_VERSION,
  ProjectOverviewReadModel,
  ProjectTelemetryTimeseries,
} from "./dependencies.js";
import { STRICT_API_BODY_KEYS } from "./api-domain-02.js";
import { ApiJobsRunTableResponse, ApiProjectCostDrilldownResponse } from "./api-domain-03.js";
import { assertProjectDashboardStatus } from "./api-domain-16.js";
import { assertProjectCostReport } from "./api-domain-18.js";
import {
  assertDashboardDecisionReadModel,
  assertProjectOverviewBenchmarkHeadline,
  assertProjectOverviewJournalPage,
  assertProjectOverviewPagination,
} from "./api-domain-20.js";
import { asRecord } from "./api-domain-28.js";
import {
  asArray,
  asStrictRecord,
  assertBoolean,
  assertDateLike,
  assertEnum,
  assertLiteral,
  assertNonNegativeInteger,
  assertNonNegativeNumber,
  assertNull,
  assertNullableString,
  assertPositiveInteger,
  assertString,
} from "./api-domain-29.js";

export function assertProjectCostDrilldownResponse(
  value: unknown,
  label = "ApiProjectCostDrilldownResponse",
): asserts value is ApiProjectCostDrilldownResponse {
  const page = asStrictRecord(value, label, STRICT_API_BODY_KEYS.CostDrilldownPage);

  const filter = asStrictRecord(page.filter, `${label}.filter`, [
    "projectId",
    "systemId",
    "from",
    "to",
  ]);
  assertString(filter.projectId, `${label}.filter.projectId`);
  assertNullableString(filter.systemId, `${label}.filter.systemId`);
  assertNullableString(filter.from, `${label}.filter.from`);
  assertNullableString(filter.to, `${label}.filter.to`);

  const pagination = asStrictRecord(page.pagination, `${label}.pagination`, [
    "total",
    "limit",
    "offset",
    "page",
    "pageCount",
    "hasMore",
    "nextOffset",
  ]);
  assertNonNegativeInteger(pagination.total, `${label}.pagination.total`);
  assertPositiveInteger(pagination.limit, `${label}.pagination.limit`);
  assertNonNegativeInteger(pagination.offset, `${label}.pagination.offset`);
  assertPositiveInteger(pagination.page, `${label}.pagination.page`);
  assertNonNegativeInteger(pagination.pageCount, `${label}.pagination.pageCount`);
  assertBoolean(pagination.hasMore, `${label}.pagination.hasMore`);
  if (pagination.nextOffset !== null) {
    assertNonNegativeInteger(pagination.nextOffset, `${label}.pagination.nextOffset`);
  }
  // Determinism/consistency invariant: hasMore and nextOffset must agree.
  if (pagination.hasMore === (pagination.nextOffset === null)) {
    throw new Error(`${label}.pagination.hasMore must agree with nextOffset`);
  }

  const rows = asArray(page.rows, `${label}.rows`);
  if (rows.length > Number(pagination.limit)) {
    throw new Error(`${label}.rows must not exceed pagination.limit`);
  }
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}.rows[${index}]`, [
      "providerRunId",
      "projectId",
      "systemId",
      "taskKind",
      "status",
      "startedAt",
      "cost",
      "provider",
    ]);
    assertString(row.providerRunId, `${label}.rows[${index}].providerRunId`);
    assertString(row.projectId, `${label}.rows[${index}].projectId`);
    assertNullableString(row.systemId, `${label}.rows[${index}].systemId`);
    assertString(row.taskKind, `${label}.rows[${index}].taskKind`);
    assertString(row.status, `${label}.rows[${index}].status`);
    assertString(row.startedAt, `${label}.rows[${index}].startedAt`);
    assertCostDrilldownRowCost(row.cost, `${label}.rows[${index}].cost`);
    assertCostDrilldownProviderMetadata(row.provider, `${label}.rows[${index}].provider`);
  }
}

export function assertCostDrilldownRowCost(value: unknown, label: string): void {
  // policy — zero and unknown are DISTINCT states, never collapsed. The
  // `state` discriminator carries the distinction (there is intentionally no
  // `costKind: "unknown"` — that is the deleted, audit-forbidden ledger enum).
  const record = asRecord(value, label);
  assertEnum(record.state, ["billed", "zero", "unknown"] as const, `${label}.state`);
  if (record.state === "unknown") {
    // An unrecorded cost carries NO amount fields — it must not masquerade as
    // a $0.00 billed record.
    for (const key of Object.keys(record)) {
      if (key !== "state") {
        throw new Error(`${label}.${key} is not permitted on an unknown-cost row`);
      }
    }
    return;
  }
  asStrictRecord(record, label, ["state", "amountMicrosUsd", "displayAmountUsd"]);
  assertNonNegativeInteger(record.amountMicrosUsd, `${label}.amountMicrosUsd`);
  assertString(record.displayAmountUsd, `${label}.displayAmountUsd`);
  if (
    record.state === "zero" &&
    (record.amountMicrosUsd !== 0 || record.displayAmountUsd !== "0")
  ) {
    throw new Error(`${label} zero-cost row must carry amountMicrosUsd 0 and displayAmountUsd "0"`);
  }
}

export function assertCostDrilldownProviderMetadata(value: unknown, label: string): void {
  const provider = asStrictRecord(value, label, [
    "providerId",
    "providerFamily",
    "endpointFamily",
    "providerName",
    "requestedModelId",
    "actualModelId",
    "upstreamProvider",
    "routeSettingsHash",
    "adapterMetadata",
  ]);
  assertString(provider.providerId, `${label}.providerId`);
  assertString(provider.providerFamily, `${label}.providerFamily`);
  assertString(provider.endpointFamily, `${label}.endpointFamily`);
  assertString(provider.providerName, `${label}.providerName`);
  assertString(provider.requestedModelId, `${label}.requestedModelId`);
  assertString(provider.actualModelId, `${label}.actualModelId`);
  assertNullableString(provider.upstreamProvider, `${label}.upstreamProvider`);
  assertNullableString(provider.routeSettingsHash, `${label}.routeSettingsHash`);
  // Curated adapter metadata (jsonb object). Only allowlisted keys surface
  // (sanitizeAdapterMetadata is default-deny); the API schema only asserts
  // the surviving value is an object.
  asRecord(provider.adapterMetadata, `${label}.adapterMetadata`);
}

export function assertJobsRunTableReadModel(
  value: unknown,
  label = "JobsRunTableReadModel",
): asserts value is ApiJobsRunTableResponse {
  const model = asStrictRecord(value, label, STRICT_API_BODY_KEYS.JobsRunTableReadModel);
  assertLiteral(model.schemaVersion, "jobs.run_table.v0.3", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  const filter = asStrictRecord(model.filter, `${label}.filter`, ["projectId"]);
  assertString(filter.projectId, `${label}.filter.projectId`);
  assertProjectOverviewPagination(model.pagination, `${label}.pagination`);
  const rows = asArray(model.rows, `${label}.rows`);
  if (rows.length > Number((model.pagination as { limit: unknown }).limit)) {
    throw new Error(`${label}.rows must not exceed pagination.limit`);
  }
  for (const [index, row] of rows.entries()) {
    assertJobsRunTableRow(row, `${label}.rows[${index}]`);
  }
}

export function assertJobsRunTableRow(value: unknown, label: string): void {
  const row = asStrictRecord(value, label, [
    "runId",
    "jobId",
    "projectId",
    "localeBranchId",
    "task",
    "status",
    "servedModel",
    "servedProvider",
    "zdr",
    "cost",
    "tokens",
    "fallback",
    "createdAt",
  ]);
  assertString(row.runId, `${label}.runId`);
  assertNullableString(row.jobId, `${label}.jobId`);
  assertString(row.projectId, `${label}.projectId`);
  assertNullableString(row.localeBranchId, `${label}.localeBranchId`);
  assertString(row.task, `${label}.task`);
  assertString(row.status, `${label}.status`);
  assertString(row.servedModel, `${label}.servedModel`);
  assertString(row.servedProvider, `${label}.servedProvider`);
  assertJobsRunTableZdr(row.zdr, `${label}.zdr`);
  assertJobsRunTableCost(row.cost, `${label}.cost`);
  assertJobsRunTableTokens(row.tokens, `${label}.tokens`);
  assertJobsRunTableFallback(row.fallback, `${label}.fallback`);
  assertDateLike(row.createdAt, `${label}.createdAt`);
}

export function assertJobsRunTableCost(value: unknown, label: string): void {
  const cost = asStrictRecord(value, label, ["availability", "unit", "amount"]);
  assertEnum(cost.availability, ["captured", "not_captured"] as const, `${label}.availability`);
  assertLiteral(cost.unit, "usd", `${label}.unit`);
  if (cost.availability === "captured") assertString(cost.amount, `${label}.amount`);
  else assertNull(cost.amount, `${label}.amount`);
}

export function assertJobsRunTableTokens(value: unknown, label: string): void {
  const tokens = asStrictRecord(value, label, ["in", "out", "total"]);
  if (tokens.in !== null) {
    assertNonNegativeInteger(tokens.in, `${label}.in`);
  }
  if (tokens.out !== null) {
    assertNonNegativeInteger(tokens.out, `${label}.out`);
  }
  if (tokens.total !== null) {
    assertNonNegativeInteger(tokens.total, `${label}.total`);
  }
}

export function assertJobsRunTableFallback(value: unknown, label: string): void {
  const fallback = asStrictRecord(value, label, ["used", "plan", "chain"]);
  assertBoolean(fallback.used, `${label}.used`);
  for (const [index, entry] of asArray(fallback.plan, `${label}.plan`).entries()) {
    assertString(entry, `${label}.plan[${index}]`);
  }
  assertNull(fallback.chain, `${label}.chain`);
}

export function assertJobsRunTableZdr(value: unknown, label: string): void {
  const zdr = asStrictRecord(value, label, ["availability", "enforced"]);
  assertEnum(zdr.availability, ["captured", "not_captured"] as const, `${label}.availability`);
  if (zdr.availability === "captured") assertBoolean(zdr.enforced, `${label}.enforced`);
  else assertNull(zdr.enforced, `${label}.enforced`);
}

export function assertProjectOverviewReadModel(
  value: unknown,
  label = "ProjectOverviewReadModel",
): asserts value is ProjectOverviewReadModel {
  const model = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ProjectOverviewReadModel);
  assertLiteral(model.schemaVersion, PROJECT_OVERVIEW_SCHEMA_VERSION, `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertString(model.projectId, `${label}.projectId`);
  assertProjectDashboardStatus(model.progress, `${label}.progress`);
  assertDashboardDecisionReadModel(model.decisions, `${label}.decisions`);
  assertProjectCostReport(model.cost, `${label}.cost`);
  assertProjectTelemetryTimeseries(model.telemetry, `${label}.telemetry`);
  assertProjectCostDrilldownResponse(model.costDrilldown, `${label}.costDrilldown`);
  assertProjectOverviewJournalPage(model.journal, `${label}.journal`);
  assertProjectOverviewBenchmarkHeadline(model.benchmarkHeadline, `${label}.benchmarkHeadline`);
  // ovw-launch-pass-action — the server-derived steer capability the Overview
  // launch-pass action gates itself on.
  assertBoolean(model.canSteer, `${label}.canSteer`);
}

export function assertProjectTelemetryTimeseries(
  value: unknown,
  label: string,
): asserts value is ProjectTelemetryTimeseries {
  const telemetry = asStrictRecord(value, label, [
    "projectId",
    "bucket",
    "rows",
    "throughputSeries",
    "costPerRunSeries",
  ]);
  assertString(telemetry.projectId, `${label}.projectId`);
  assertLiteral(telemetry.bucket, "day", `${label}.bucket`);
  const rows = asArray(telemetry.rows, `${label}.rows`);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}.rows[${index}]`, [
      "bucketStart",
      "runCount",
      "billedMicrosUsd",
      "costPerRunMicrosUsd",
    ]);
    assertDateLike(row.bucketStart, `${label}.rows[${index}].bucketStart`);
    assertNonNegativeInteger(row.runCount, `${label}.rows[${index}].runCount`);
    assertNonNegativeInteger(row.billedMicrosUsd, `${label}.rows[${index}].billedMicrosUsd`);
    assertNonNegativeNumber(row.costPerRunMicrosUsd, `${label}.rows[${index}].costPerRunMicrosUsd`);
  }
  const throughputSeries = assertNumberSeries(
    telemetry.throughputSeries,
    `${label}.throughputSeries`,
  );
  const costPerRunSeries = assertNumberSeries(
    telemetry.costPerRunSeries,
    `${label}.costPerRunSeries`,
  );
  if (throughputSeries.length !== rows.length) {
    throw new Error(`${label}.throughputSeries length must match rows length`);
  }
  if (costPerRunSeries.length !== rows.length) {
    throw new Error(`${label}.costPerRunSeries length must match rows length`);
  }
}

export function assertNumberSeries(value: unknown, label: string): unknown[] {
  const series = asArray(value, label);
  for (const [index, item] of series.entries()) {
    assertNonNegativeNumber(item, `${label}[${index}]`);
  }
  return series;
}
