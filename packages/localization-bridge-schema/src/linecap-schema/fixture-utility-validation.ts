import { Uuid7 } from "./bridge-core-types.js";
import {
  AlphaVerticalProofArtifactKindV02,
  AlphaVerticalProofHashScopeV02,
  CONTRACT_COMPATIBILITY_STATUSES_V02,
  CONTRACT_FIXTURE_KINDS_V02,
  RFC3339_INSTANT_PATTERN,
  Rfc3339InstantValidationError,
} from "./schema-enums.js";
import {
  AlphaVerticalProofContentHashV02,
  ContractFixtureManifestEntryV02,
  InvalidContractFixtureManifestEntryV02,
} from "./patch-and-runtime-types.js";
import { ContractCompatibilityCoverageV02 } from "./bridge-bundle-validation.js";
import { assertPortableArtifactUriV02 } from "./runtime-capability-and-unit-validation.js";
import { assertBoolean, assertEnum, assertUuid7 } from "./validation-primitives.js";

export function assertAlphaVerticalProofRequiredHashScopesV02(
  hashes: readonly AlphaVerticalProofContentHashV02[],
): void {
  const scopes = new Set(hashes.map((hash) => hash.scope));
  for (const scope of [
    "public_fixture_manifest",
    "source_bundle",
    "bridge_bundle",
    "bridge_unit",
    "patch_export",
    "patch_result",
    "delta_package",
    "runtime_report",
    "benchmark_report",
    "provider_proof",
  ] as const) {
    if (!scopes.has(scope)) {
      throw new Error(`AlphaVerticalProofManifestV02.contentHashes must include ${scope}`);
    }
  }
}

export function assertAlphaVerticalProofHashCoveredV02(
  hashes: readonly AlphaVerticalProofContentHashV02[],
  scope: AlphaVerticalProofHashScopeV02,
  contentId: string,
  hash: string,
  label: string,
): void {
  if (
    !hashes.some(
      (entry) => entry.scope === scope && entry.contentId === contentId && entry.hash === hash,
    )
  ) {
    throw new Error(`${label} must be represented in AlphaVerticalProofManifestV02.contentHashes`);
  }
}

export function assertAlphaVerticalProofHashScopeContentIdV02(
  hashes: readonly AlphaVerticalProofContentHashV02[],
  scope: AlphaVerticalProofHashScopeV02,
  contentId: string,
  label: string,
): void {
  if (!hashes.some((entry) => entry.scope === scope && entry.contentId === contentId)) {
    throw new Error(`${label} must be represented in AlphaVerticalProofManifestV02.contentHashes`);
  }
}

export function alphaVerticalProofHashScopeForArtifactKindV02(
  kind: AlphaVerticalProofArtifactKindV02,
): AlphaVerticalProofHashScopeV02 {
  switch (kind) {
    case "public_fixture_manifest":
      return "public_fixture_manifest";
    case "bridge_bundle":
      return "bridge_bundle";
    case "patch_export":
      return "patch_export";
    case "patch_result":
      return "patch_result";
    case "delta_package":
      return "delta_package";
    case "runtime_report":
      return "runtime_report";
    case "finding_report":
      return "finding_report";
    case "benchmark_report":
      return "benchmark_report";
  }
}

export function assertContractFixtureManifestEntryV02(
  value: unknown,
  label: string,
): asserts value is ContractFixtureManifestEntryV02 {
  const fixture = asRecord(value, label);
  assertEnum(fixture.kind, CONTRACT_FIXTURE_KINDS_V02, `${label}.kind`);
  assertContractFixturePathV02(fixture.path, `${label}.path`);
  assertString(fixture.description, `${label}.description`);
}

export function assertInvalidContractFixtureManifestEntryV02(
  value: unknown,
  label: string,
): asserts value is InvalidContractFixtureManifestEntryV02 {
  assertContractFixtureManifestEntryV02(value, label);
  const fixture = asRecord(value, label);
  assertString(fixture.expectedSemanticError, `${label}.expectedSemanticError`);
}

export function assertContractCompatibilityCoverageV02(
  value: unknown,
  label: string,
): asserts value is ContractCompatibilityCoverageV02 {
  const coverage = asRecord(value, label);
  assertEnum(coverage.kind, CONTRACT_FIXTURE_KINDS_V02, `${label}.kind`);
  assertString(coverage.typescriptValidator, `${label}.typescriptValidator`);
  assertString(coverage.rustValidator, `${label}.rustValidator`);
  assertFixturePathArrayV02(coverage.validFixtures, `${label}.validFixtures`, true);
  assertFixturePathArrayV02(coverage.invalidFixtures, `${label}.invalidFixtures`, false);
  assertEnum(coverage.status, CONTRACT_COMPATIBILITY_STATUSES_V02, `${label}.status`);
}

export function assertFixturePathArrayV02(
  value: unknown,
  label: string,
  requireNonEmpty: boolean,
): void {
  const paths = asArray(value, label);
  if (requireNonEmpty && paths.length === 0) {
    throw new Error(`${label} must contain at least one fixture path`);
  }
  for (const [index, path] of paths.entries()) {
    assertContractFixturePathV02(path, `${label}[${index}]`);
  }
}

export function assertContractFixturePathV02(
  value: unknown,
  label: string,
): asserts value is string {
  assertString(value, label);
  if (!value.startsWith("./")) {
    throw new Error(`${label} must be a relative fixture path starting with ./`);
  }
  assertPortableArtifactUriV02(value, label);
  if (value.includes("..") || value.includes("//") || !value.endsWith(".json")) {
    throw new Error(`${label} must be a normalized JSON fixture path`);
  }
}

export function assertUniqueFixturePathV02(
  path: string,
  label: string,
  seenPaths: Set<string>,
): void {
  if (seenPaths.has(path)) {
    throw new Error(`${label}.path must be unique within the contract fixture manifest`);
  }
  seenPaths.add(path);
}

export function assertCommandTokensV02(value: unknown, label: string): asserts value is string[] {
  const tokens = asArray(value, label);
  if (tokens.length === 0) {
    throw new Error(`${label} must contain at least one command token`);
  }
  for (const [index, token] of tokens.entries()) {
    assertString(token, `${label}[${index}]`);
  }
}

export function assertEnumArrayV02<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  label: string,
): T[] {
  const array = asArray(value, label);
  return array.map((entry, index) => {
    assertEnum(entry, allowedValues, `${label}[${index}]`);
    return entry;
  });
}

export function assertExactStringSetV02(
  values: readonly string[],
  expectedValues: readonly string[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${label} must not contain duplicate value ${value}`);
    }
    seen.add(value);
  }
  for (const expectedValue of expectedValues) {
    if (!seen.has(expectedValue)) {
      throw new Error(`${label} must include ${expectedValue}`);
    }
  }
  for (const value of seen) {
    if (!expectedValues.includes(value)) {
      throw new Error(`${label} contains unsupported value ${value}`);
    }
  }
}

export function assertExtractor(value: unknown, label: string): void {
  const extractor = asRecord(value, label);
  assertString(extractor.name, `${label}.name`);
  assertString(extractor.version, `${label}.version`);
}

export function assertAllowedKeysV02(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${label}.${key} is not allowed`);
    }
  }
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
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

export function assertPublicFixtureIdV02(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a public fixture id`);
  }
}

export function assertNonBlankString(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function isBlankString(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

export function assertHashStringV02(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a canonical sha256 hash string`);
  }
}

export function assertOptionalString(
  value: unknown,
  label: string,
): asserts value is string | undefined {
  if (value !== undefined) {
    assertString(value, label);
  }
}

export function assertOptionalBoolean(
  value: unknown,
  label: string,
): asserts value is boolean | undefined {
  if (value !== undefined) {
    assertBoolean(value, label);
  }
}

/**
 * Assert that `value` is a valid RFC3339 date-time instant per the canonical
 * cross-language acceptance rule shared with the Rust contract validator
 * (`validate_rfc3339_instant` in `crates/kaifuu-core/src/contracts.rs`).
 *
 * Both validators are locked to the same accept/reject boundary by the shared
 * parity matrix in
 * `packages/localization-bridge-schema/test/rfc3339-instant-parity-matrix.v0.2.json`.
 * Rejections throw a {@link Rfc3339InstantValidationError} carrying the shared
 * {@link RFC3339_INSTANT_MALFORMED_CODE}. See
 * `docs/contracts/rfc3339-instant-acceptance.md` for the canonical rule.
 *
 * The acceptance decision is a pure regular-expression + numeric-range check,
 * matching the Rust validator exactly. It deliberately does NOT consult
 * `Date.parse`, whose engine-defined leniency (e.g. rolling `2026-02-29` over
 * to March, or version-specific offset handling) is a cross-language
 * divergence hazard and is redundant with the range checks below.
 */
export function assertRfc3339Instant(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Rfc3339InstantValidationError(label, value);
  }
  const match = RFC3339_INSTANT_PATTERN.exec(value);
  if (match === null) {
    throw new Rfc3339InstantValidationError(label, value);
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (offsetText === undefined) {
    throw new Rfc3339InstantValidationError(label, value);
  }
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !isValidCalendarDate(year, month, day)
  ) {
    throw new Rfc3339InstantValidationError(label, value);
  }
  if (offsetText !== "Z") {
    const offsetHour = Number(offsetText.slice(1, 3));
    const offsetMinute = Number(offsetText.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      throw new Rfc3339InstantValidationError(label, value);
    }
  }
}

export function assertOptionalRfc3339Instant(
  value: unknown,
  label: string,
): asserts value is string | undefined {
  if (value !== undefined) {
    assertRfc3339Instant(value, label);
  }
}

export function assertStartedCompletedInstantsV02(
  startedAt: unknown,
  completedAt: unknown,
  label: string,
): void {
  assertRfc3339Instant(startedAt, `${label}.startedAt`);
  assertOptionalRfc3339Instant(completedAt, `${label}.completedAt`);
  if (completedAt !== undefined && Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error(`${label}.completedAt must not be before ${label}.startedAt`);
  }
}

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function assertOptionalHashStringV02(
  value: unknown,
  label: string,
): asserts value is string | undefined {
  if (value !== undefined) {
    assertHashStringV02(value, label);
  }
}

export function assertArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

export function assertStringArray(value: unknown, label: string): asserts value is string[] {
  const array = asArray(value, label);
  for (const [index, item] of array.entries()) {
    assertString(item, `${label}[${index}]`);
  }
}

export function assertUniqueNonEmptyStringArrayV02(value: unknown, label: string): string[] {
  const array = asArray(value, label);
  if (array.length === 0) {
    throw new Error(`${label} must contain at least one value`);
  }
  const seen = new Set<string>();
  const strings: string[] = [];
  for (const [index, item] of array.entries()) {
    assertString(item, `${label}[${index}]`);
    if (seen.has(item)) {
      throw new Error(`${label}[${index}] must not duplicate ${item}`);
    }
    seen.add(item);
    strings.push(item);
  }
  return strings;
}

export function assertUuid7Array(value: unknown, label: string): asserts value is Uuid7[] {
  const array = asArray(value, label);
  for (const [index, item] of array.entries()) {
    assertUuid7(item, `${label}[${index}]`);
  }
}
