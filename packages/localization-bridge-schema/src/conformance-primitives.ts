import {
  ADAPTER_ID_PATTERN,
  ALLOWED_SEMANTIC_CODE_PREFIXES,
  ConformanceIngestionError,
  EXTENSION_KEY_PATTERN,
  MAX_ID_LENGTH,
  MAX_PATH_LENGTH,
  MAX_URI_LENGTH,
  RFC3339_INSTANT_PATTERN_CONFORMANCE,
  RUNTIME_ARTIFACT_URI_PREFIX,
  SEMANTIC_CODE_PATTERN,
  URI_SCHEME_PATTERN,
} from "./conformance-types.js";

export function reject(code: string, message: string): never {
  throw new ConformanceIngestionError({ code, message });
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("itotori.conformance.shape_invalid", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    reject("itotori.conformance.shape_invalid", `${label} must be an array`);
  }
  return value;
}

export function assertBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
  code = "itotori.conformance.shape_invalid",
): string {
  if (typeof value !== "string") {
    reject(code, `${label} must be a string`);
  }
  if (value.length === 0) {
    reject(code, `${label} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    reject(code, `${label} exceeds ${String(maxLength)}-byte ceiling`);
  }
  return value;
}

export function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    reject("itotori.conformance.shape_invalid", `${label} must be a boolean`);
  }
  return value;
}

export function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  code = "itotori.conformance.shape_invalid",
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    reject(code, `${label} must be one of ${allowed.join(", ")} (got ${String(value)})`);
  }
  return value as T;
}

export function assertAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      reject("itotori.conformance.unknown_field", `${label} has unexpected field ${key}`);
    }
  }
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function assertRecordedAt(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    reject("itotori.conformance.recorded_at_malformed", `${label} must be an RFC3339 instant`);
  }
  const match = RFC3339_INSTANT_PATTERN_CONFORMANCE.exec(value);
  if (match === null) {
    reject("itotori.conformance.recorded_at_malformed", `${label} (${value}) is not RFC3339`);
  }
  const yearText = match[1] ?? "";
  const monthText = match[2] ?? "";
  const dayText = match[3] ?? "";
  const hourText = match[4] ?? "";
  const minuteText = match[5] ?? "";
  const secondText = match[6] ?? "";
  const offsetText = match[7] ?? "";
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !isCalendarDate(year, month, day)
  ) {
    reject(
      "itotori.conformance.recorded_at_malformed",
      `${label} (${value}) is not a valid instant`,
    );
  }
  if (offsetText !== "Z") {
    const offsetHour = Number(offsetText.slice(1, 3));
    const offsetMinute = Number(offsetText.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      reject(
        "itotori.conformance.recorded_at_malformed",
        `${label} (${value}) has malformed offset`,
      );
    }
  }
  if (!Number.isFinite(Date.parse(value))) {
    reject("itotori.conformance.recorded_at_malformed", `${label} (${value}) is not parseable`);
  }
  return value;
}

export function assertAdapterId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ADAPTER_ID_PATTERN.test(value)) {
    reject(
      "itotori.conformance.adapter_id_malformed",
      `${label} (${String(value)}) is not a valid adapter id`,
    );
  }
  return value;
}

export function assertExtensionKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !EXTENSION_KEY_PATTERN.test(value)) {
    reject(
      "itotori.conformance.extension_key_malformed",
      `${label} (${String(value)}) is not a valid extension key`,
    );
  }
  return value;
}

function looksLikeLocalPath(value: string): boolean {
  // Mirrors `crate::looks_like_local_path` and the Rust StatePath parser
  // negative-shape policy: leading `/`, drive letters, or backslashes.
  if (value.startsWith("/")) return true;
  if (value.includes("\\")) return true;
  if (/^[A-Za-z]:/u.test(value)) return true;
  return false;
}

export function assertIdString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    reject("itotori.conformance.evidence_ref_invalid", `${label} must be a non-empty string`);
  }
  if (value.length > MAX_ID_LENGTH) {
    reject(
      "itotori.conformance.evidence_ref_invalid",
      `${label} exceeds ${String(MAX_ID_LENGTH)}-byte ceiling`,
    );
  }
  if (/\s/u.test(value)) {
    reject("itotori.conformance.evidence_ref_invalid", `${label} must not contain whitespace`);
  }
  if (looksLikeLocalPath(value)) {
    reject("itotori.conformance.evidence_ref_invalid", `${label} must not look like a local path`);
  }
  return value;
}

export function assertRuntimeArtifactUri(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    reject("itotori.conformance.evidence_ref_invalid", `${label} must be a non-empty string`);
  }
  if (value.length > MAX_URI_LENGTH) {
    reject(
      "itotori.conformance.evidence_ref_invalid",
      `${label} exceeds ${String(MAX_URI_LENGTH)}-byte ceiling`,
    );
  }
  if (URI_SCHEME_PATTERN.test(value)) {
    reject(
      "itotori.conformance.evidence_ref_invalid",
      `${label} must not be a URI scheme (got ${value})`,
    );
  }
  if (value.startsWith("/")) {
    reject(
      "itotori.conformance.evidence_ref_invalid",
      `${label} must not be an absolute path (got ${value})`,
    );
  }
  if (value.includes("\\")) {
    reject(
      "itotori.conformance.evidence_ref_invalid",
      `${label} must not contain backslashes (got ${value})`,
    );
  }
  if (value.includes("..")) {
    reject(
      "itotori.conformance.evidence_ref_invalid",
      `${label} must not contain path traversal (got ${value})`,
    );
  }
  if (!value.startsWith(RUNTIME_ARTIFACT_URI_PREFIX)) {
    reject(
      "itotori.conformance.evidence_ref_invalid",
      `${label} must live under ${RUNTIME_ARTIFACT_URI_PREFIX} (got ${value})`,
    );
  }
  return value;
}

export function assertStatePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    reject("itotori.conformance.evidence_ref_invalid", `${label} must be a non-empty string`);
  }
  if (value.length > MAX_PATH_LENGTH) {
    reject(
      "itotori.conformance.evidence_ref_invalid",
      `${label} exceeds ${String(MAX_PATH_LENGTH)}-byte ceiling`,
    );
  }
  if (/\s/u.test(value)) {
    reject("itotori.conformance.evidence_ref_invalid", `${label} must not contain whitespace`);
  }
  if (looksLikeLocalPath(value)) {
    reject("itotori.conformance.evidence_ref_invalid", `${label} must not look like a local path`);
  }
  // Lowercase ASCII + digits + `.` + `_` segments, leading lowercase letter
  // per StatePath wire form. Allow underscores in segments to mirror the Rust
  // parser policy (segments are `[a-z][a-z0-9_]*`).
  const STATE_PATH_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/u;
  if (!STATE_PATH_PATTERN.test(value)) {
    reject(
      "itotori.conformance.evidence_ref_invalid",
      `${label} (${value}) is not a canonical StatePath`,
    );
  }
  return value;
}

export function assertSemanticCodeAllowedV01(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    reject(
      "itotori.conformance.semantic_code_malformed",
      `${label} must be a non-empty semantic code string`,
    );
  }
  if (value.length > MAX_ID_LENGTH * 4) {
    reject(
      "itotori.conformance.semantic_code_malformed",
      `${label} exceeds ${String(MAX_ID_LENGTH * 4)}-byte ceiling`,
    );
  }
  if (!SEMANTIC_CODE_PATTERN.test(value)) {
    reject(
      "itotori.conformance.semantic_code_malformed",
      `${label} (${value}) is not <provider>.<subsystem>.<reason>`,
    );
  }
  if (!ALLOWED_SEMANTIC_CODE_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    reject(
      "itotori.conformance.semantic_code_not_allowed",
      `${label} (${value}) prefix not in whitelist`,
    );
  }
}
