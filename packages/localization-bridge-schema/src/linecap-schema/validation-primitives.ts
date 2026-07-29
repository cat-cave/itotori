import { Uuid7 } from "./bridge-core-types.js";
import { ByteRangeV02, PixelRegionV02 } from "./bridge-context-types.js";
import { isUuid7 } from "./runtime-evidence-validation.js";
import { asArray, asRecord } from "./fixture-utility-validation.js";

export function assertUniqueUuid7ArrayV02(value: unknown, label: string): Uuid7[] {
  const array = asArray(value, label);
  const seen = new Set<Uuid7>();
  const ids: Uuid7[] = [];
  for (const [index, item] of array.entries()) {
    assertUuid7(item, `${label}[${index}]`);
    if (seen.has(item)) {
      throw new Error(`${label}[${index}] must not duplicate ${item}`);
    }
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

export function assertEqual(value: unknown, expected: string, label: string): void {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
}

export function assertUuid7(value: unknown, label: string): asserts value is Uuid7 {
  if (!isUuid7(value)) {
    throw new Error(`${label} must be a UUID7 string`);
  }
}

export function assertOptionalUuid7(
  value: unknown,
  label: string,
): asserts value is Uuid7 | undefined {
  if (value !== undefined) {
    assertUuid7(value, label);
  }
}

export function assertEnum<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !allowedValues.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowedValues.join(", ")}`);
  }
}

export function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

export function assertOptionalNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number | undefined {
  if (value !== undefined) {
    assertNonNegativeInteger(value, label);
  }
}

export function assertNonNegativeNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
}

export function assertNumberWithinTolerance(
  value: number,
  expected: number,
  tolerance: number,
  label: string,
  expectation: string,
): void {
  if (Math.abs(value - expected) > tolerance) {
    throw new Error(`${label} must match ${expectation}`);
  }
}

export function assertRatio(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number between 0 and 1`);
  }
}

export function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}

export function assertByteRangeV02(value: unknown, label: string): asserts value is ByteRangeV02 {
  const range = asRecord(value, label);
  asByteRangeNumbers(range.startByte, range.endByte, label);
}

export function asByteRangeNumbers(
  startByte: unknown,
  endByte: unknown,
  label: string,
): [number, number] {
  assertNonNegativeInteger(startByte, `${label}.startByte`);
  assertNonNegativeInteger(endByte, `${label}.endByte`);
  if ((endByte as number) <= startByte) {
    throw new Error(`${label}.endByte must be greater than ${label}.startByte`);
  }
  return [startByte, endByte as number];
}

export function assertPixelRegionV02(
  value: unknown,
  label: string,
): asserts value is PixelRegionV02 {
  const region = asRecord(value, label);
  assertNonNegativeInteger(region.x, `${label}.x`);
  assertNonNegativeInteger(region.y, `${label}.y`);
  assertPositiveInteger(region.width, `${label}.width`);
  assertPositiveInteger(region.height, `${label}.height`);
}

export function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export function assertSpanRawMatchesSource(
  sourceText: string,
  raw: string,
  startByte: number,
  endByte: number,
  label: string,
): void {
  const sourceBytes = Buffer.from(sourceText, "utf8");
  if (endByte > sourceBytes.length) {
    throw new Error(`${label}.endByte must be within sourceText UTF-8 bytes`);
  }
  const spanText = sourceBytes.subarray(startByte, endByte).toString("utf8");
  if (spanText !== raw) {
    throw new Error(`${label}.raw must match sourceText byte range`);
  }
}

export function assertNoConfidenceFields(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoConfidenceFields(item, `${label}[${index}]`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase().includes("confidence")) {
      throw new Error(`${label}.${key} is not allowed; record evidence instead of confidence`);
    }
    assertNoConfidenceFields(child, `${label}.${key}`);
  }
}

export function assertNoRawPrivateOrSecretFieldsV02(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null) {
    if (typeof value === "string" && value.includes("fixtures/private-local/")) {
      throw new Error(`${label} must not reference fixtures/private-local`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoRawPrivateOrSecretFieldsV02(item, `${label}[${index}]`);
    }
    return;
  }
  const forbiddenKeys = new Set([
    "authorization",
    "apiKey",
    "api_key",
    "bearer",
    "completionText",
    "completion_text",
    "password",
    "privateKey",
    "private_key",
    "promptText",
    "prompt_text",
    "rawContent",
    "raw_content",
    "rawPrivateData",
    "raw_private_data",
    "rawText",
    "raw_text",
    "requestBody",
    "request_body",
    "responseBody",
    "response_body",
    "secret",
  ]);
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) {
      throw new Error(`${label}.${key} is not allowed; record ids, hashes, or artifact refs`);
    }
    assertNoRawPrivateOrSecretFieldsV02(child, `${label}.${key}`);
  }
}

export function assertNoMutableEventBucketFields(value: unknown, label: string): void {
  const mutableKeys = new Set(["status", "currentStatus", "updatedAt", "deletedAt"]);
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoMutableEventBucketFields(item, `${label}[${index}]`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (mutableKeys.has(key)) {
      throw new Error(`${label}.${key} is not allowed on append-only events`);
    }
    assertNoMutableEventBucketFields(child, `${label}.${key}`);
  }
}
