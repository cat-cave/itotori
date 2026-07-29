import {
  CatalogExternalIdKind,
  CatalogRawContentRedactionClass,
  CatalogSource,
  CatalogSourceRecordKind,
  catalogExternalIdKindValues,
  catalogRawContentRedactionClassValues,
  catalogSourceRecordKindValues,
  catalogSourceValues,
} from "./dependencies.js";
import { benchmarkSeedPrivateLeakagePatterns } from "./api-private-leakage.js";
import { asRecord } from "./api-domain-28.js";

export function asStrictRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const record = asRecord(value, label);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${label}.${key} is not part of the public API response`);
    }
  }
  return record;
}

export function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

export function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  assertString(value, label);
  return value;
}

export function assertLiteral<T extends string>(
  value: unknown,
  expected: T,
  label: string,
): asserts value is T {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
}

export function assertNullableString(
  value: unknown,
  label: string,
): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${label} must be a string or null`);
  }
}

export function assertNull(value: unknown, label: string): asserts value is null {
  if (value !== null) {
    throw new Error(`${label} must be null`);
  }
}

export function assertStringArray(value: unknown, label: string): void {
  const entries = asArray(value, label);
  for (const [index, entry] of entries.entries()) {
    assertString(entry, `${label}[${index}]`);
  }
}

export function assertConflictReviewSourceIds(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}[${index}]`, ["catalogSource", "sourceId"]);
    assertString(row.catalogSource, `${label}[${index}].catalogSource`);
    assertPublicCatalogSource(row.catalogSource, `${label}[${index}].catalogSource`);
    assertString(row.sourceId, `${label}[${index}].sourceId`);
    assertNoCatalogPrivateLeakage(row.sourceId, `${label}[${index}].sourceId`);
  }
}

export function assertConflictReviewExactLinkRefs(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}[${index}]`, [
      "externalIdId",
      "catalogSource",
      "sourceId",
      "externalIdKind",
      "workId",
      "sourceProvenanceId",
    ]);
    assertString(row.externalIdId, `${label}[${index}].externalIdId`);
    assertString(row.catalogSource, `${label}[${index}].catalogSource`);
    assertPublicCatalogSource(row.catalogSource, `${label}[${index}].catalogSource`);
    assertString(row.sourceId, `${label}[${index}].sourceId`);
    assertNoCatalogPrivateLeakage(row.sourceId, `${label}[${index}].sourceId`);
    assertEnum(
      row.externalIdKind,
      Object.values(catalogExternalIdKindValues) as CatalogExternalIdKind[],
      `${label}[${index}].externalIdKind`,
    );
    assertString(row.workId, `${label}[${index}].workId`);
    assertNullableString(row.sourceProvenanceId, `${label}[${index}].sourceProvenanceId`);
  }
}

export function assertConflictReviewFuzzyScores(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}[${index}]`, [
      "candidateId",
      "score",
      "diagnosticCode",
      "generatorVersion",
    ]);
    assertString(row.candidateId, `${label}[${index}].candidateId`);
    assertNonNegativeInteger(row.score, `${label}[${index}].score`);
    assertString(row.diagnosticCode, `${label}[${index}].diagnosticCode`);
    assertString(row.generatorVersion, `${label}[${index}].generatorVersion`);
  }
}

export function assertConflictReviewProvenance(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}[${index}]`, [
      "sourceProvenanceId",
      "catalogSource",
      "sourceId",
      "sourceRecordKind",
      "payloadHash",
      "fetchedAt",
    ]);
    assertString(row.sourceProvenanceId, `${label}[${index}].sourceProvenanceId`);
    assertString(row.catalogSource, `${label}[${index}].catalogSource`);
    assertPublicCatalogSource(row.catalogSource, `${label}[${index}].catalogSource`);
    assertString(row.sourceId, `${label}[${index}].sourceId`);
    assertNoCatalogPrivateLeakage(row.sourceId, `${label}[${index}].sourceId`);
    assertString(row.sourceRecordKind, `${label}[${index}].sourceRecordKind`);
    assertPublicCatalogSourceRecordKind(
      row.sourceRecordKind,
      `${label}[${index}].sourceRecordKind`,
    );
    assertNullableString(row.payloadHash, `${label}[${index}].payloadHash`);
    assertDateLike(row.fetchedAt, `${label}[${index}].fetchedAt`);
  }
}

export function assertPublicCatalogSource(value: string, label: string): void {
  assertEnum(value, Object.values(catalogSourceValues) as CatalogSource[], label);
  if (value === catalogSourceValues.localCorpus) {
    throw new Error(`${label} must not expose local corpus sources`);
  }
}

export function assertPublicCatalogSourceRecordKind(value: string, label: string): void {
  assertEnum(
    value,
    Object.values(catalogSourceRecordKindValues) as CatalogSourceRecordKind[],
    label,
  );
  if (value === catalogSourceRecordKindValues.localScan) {
    throw new Error(`${label} must not expose local scan sources`);
  }
}

export function assertPublicCatalogRedactionClass(value: string, label: string): void {
  assertEnum(
    value,
    Object.values(catalogRawContentRedactionClassValues) as CatalogRawContentRedactionClass[],
    label,
  );
  if (value === catalogRawContentRedactionClassValues.privateCorpus) {
    throw new Error(`${label} must not expose private corpus data`);
  }
}

export function assertNoCatalogPrivateLeakage(value: string, label: string): void {
  if (benchmarkSeedPrivateLeakagePatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} must not expose private response data`);
  }
}

export function assertDateLike(value: unknown, label: string): void {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a date`);
  }
}

export function assertNullableDateLike(value: unknown, label: string): void {
  if (value !== null) {
    assertDateLike(value, label);
  }
}

export function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

export function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export function assertNonNegativeNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
}

export function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

export function assertNullableNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number | null {
  if (value !== null) {
    assertNonNegativeInteger(value, label);
  }
}

export function assertNullableNonNegativeNumber(
  value: unknown,
  label: string,
): asserts value is number | null {
  if (value !== null) {
    assertNonNegativeNumber(value, label);
  }
}

export function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}

export function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(
      `${label} must be one of ${allowed.join(", ")} (received ${JSON.stringify(value)})`,
    );
  }
}

export function assertNullableEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T | null {
  if (value === null) {
    return;
  }
  assertEnum(value, allowed, label);
}
