// Runtime conformance ingestion schema mirror.
//
// This module mirrors the Rust validator in
// `crates/utsushi-core/src/conformance/{mod,result,manifest}.rs`. It is the
// single TypeScript seam Itotori uses to re-validate `ConformanceResult` and
// `ConformanceManifest` JSON payloads before ingest. The validator is
// conservative: evidence tier and fidelity tier strings are preserved
// byte-equal, unknown semantic-code prefixes are rejected at the schema
// layer, and `Skip` / `Unsupported` outcomes can never be widened into a
// `Pass` because the variants are distinct tagged-union arms.

export const CONFORMANCE_SCHEMA_VERSION_V01 = "0.2.0-alpha" as const;

export const CONFORMANCE_ABI_VERSION_V01 = 1 as const;

export const CONFORMANCE_PROFILE_IDS_V01 = [
  "text-trace",
  "branch-capture",
  "snapshot-restore",
  "frame-capture",
  "recording-capture",
  "deterministic-replay",
] as const;
export type ConformanceProfileIdV01 = (typeof CONFORMANCE_PROFILE_IDS_V01)[number];

export const CONFORMANCE_EVIDENCE_TIERS_V01 = ["E0", "E1", "E2", "E3", "E4"] as const;
export type ConformanceEvidenceTierV01 = (typeof CONFORMANCE_EVIDENCE_TIERS_V01)[number];

export const CONFORMANCE_SUBSYSTEM_REQUIREMENTS_V01 = [
  "asset_access",
  "input",
  "clock",
  "replay_log",
  "text_sink",
  "frame_sink",
  "audio_sink",
  "artifact_store",
  "snapshot_primitives",
] as const;
export type ConformanceSubsystemRequirementV01 =
  (typeof CONFORMANCE_SUBSYSTEM_REQUIREMENTS_V01)[number];

export const CONFORMANCE_RUNTIME_ARTIFACT_KINDS_V01 = [
  "trace_log",
  "screenshot",
  "frame_capture",
  "recording",
  "reference_comparison",
] as const;
export type ConformanceRuntimeArtifactKindV01 =
  (typeof CONFORMANCE_RUNTIME_ARTIFACT_KINDS_V01)[number];

export const CONFORMANCE_OUTCOME_KINDS_V01 = ["pass", "fail", "skip", "unsupported"] as const;
export type ConformanceOutcomeKindV01 = (typeof CONFORMANCE_OUTCOME_KINDS_V01)[number];

export const CONFORMANCE_EVIDENCE_REF_KINDS_V01 = [
  "runtimeArtifact",
  "textLine",
  "frameArtifactRef",
  "replayLogRef",
  "implMapFixture",
  "bridgeUnit",
  "statePath",
] as const;
export type ConformanceEvidenceRefKindV01 = (typeof CONFORMANCE_EVIDENCE_REF_KINDS_V01)[number];

// Per-profile evidence-tier ceilings mirror `ProfileId::evidence_tier_ceiling`
// in `crates/utsushi-core/src/conformance/mod.rs`.
const PROFILE_EVIDENCE_TIER_CEILING: Record<ConformanceProfileIdV01, ConformanceEvidenceTierV01> = {
  "text-trace": "E1",
  "branch-capture": "E1",
  "snapshot-restore": "E1",
  "frame-capture": "E2",
  "recording-capture": "E2",
  "deterministic-replay": "E1",
};

// Per-profile required-subsystems mirror `ProfileId::required_subsystems`.
const PROFILE_REQUIRED_SUBSYSTEMS: Record<
  ConformanceProfileIdV01,
  ReadonlyArray<ConformanceSubsystemRequirementV01>
> = {
  "text-trace": ["text_sink"],
  "branch-capture": ["text_sink"],
  "snapshot-restore": ["snapshot_primitives"],
  "frame-capture": ["frame_sink", "artifact_store"],
  "recording-capture": ["frame_sink", "artifact_store"],
  "deterministic-replay": ["replay_log", "clock", "text_sink"],
};

const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]{7,63}$/u;
const EXTENSION_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const SEMANTIC_CODE_PATTERN = /^(utsushi|kaifuu)\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u;
const ALLOWED_SEMANTIC_CODE_PREFIXES = [
  "utsushi.conformance.",
  "utsushi.snapshot.",
  "kaifuu.",
] as const;
const RUNTIME_ARTIFACT_URI_PREFIX = "artifacts/utsushi/runtime/";
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const RFC3339_INSTANT_PATTERN_CONFORMANCE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;

// Bounded length policy (plan §4 - "max 64 bytes per id, 4 KiB per detail").
const MAX_ID_LENGTH = 64;
const MAX_PATH_LENGTH = 256;
const MAX_DETAIL_LENGTH = 4096;
const MAX_NOTE_LENGTH = 1024;
const MAX_REASON_LENGTH = 4096;
const MAX_URI_LENGTH = 1024;

export type ConformanceRuntimeArtifactEvidenceV01 = {
  artifactKind: "runtimeArtifact";
  kind: ConformanceRuntimeArtifactKindV01;
  uri: string;
  artifactId?: string;
};

export type ConformanceTextLineEvidenceV01 = {
  artifactKind: "textLine";
  lineId: string;
};

export type ConformanceFrameArtifactRefEvidenceV01 = {
  artifactKind: "frameArtifactRef";
  frameId: string;
};

export type ConformanceReplayLogRefEvidenceV01 = {
  artifactKind: "replayLogRef";
  runId: string;
};

export type ConformanceImplMapFixtureEvidenceV01 = {
  artifactKind: "implMapFixture";
  fixtureId: string;
};

export type ConformanceBridgeUnitEvidenceV01 = {
  artifactKind: "bridgeUnit";
  bridgeUnitId: string;
};

export type ConformanceStatePathEvidenceV01 = {
  artifactKind: "statePath";
  path: string;
};

export type ConformanceEvidenceRefV01 =
  | ConformanceRuntimeArtifactEvidenceV01
  | ConformanceTextLineEvidenceV01
  | ConformanceFrameArtifactRefEvidenceV01
  | ConformanceReplayLogRefEvidenceV01
  | ConformanceImplMapFixtureEvidenceV01
  | ConformanceBridgeUnitEvidenceV01
  | ConformanceStatePathEvidenceV01;

export type ConformanceResultOutcomePassV01 = {
  kind: "pass";
  evidenceTier: ConformanceEvidenceTierV01;
};

export type ConformanceResultOutcomeFailV01 = {
  kind: "fail";
  semanticCode: string;
  detail: string;
};

export type ConformanceResultOutcomeSkipV01 = {
  kind: "skip";
  semanticCode: string;
  reason: string;
};

export type ConformanceResultOutcomeUnsupportedV01 = {
  kind: "unsupported";
  semanticCode: string;
  declaredInManifest: boolean;
};

export type ConformanceResultOutcomeV01 =
  | ConformanceResultOutcomePassV01
  | ConformanceResultOutcomeFailV01
  | ConformanceResultOutcomeSkipV01
  | ConformanceResultOutcomeUnsupportedV01;

export type ConformanceProfileV01 = {
  id: ConformanceProfileIdV01;
  requiredSubsystems: ConformanceSubsystemRequirementV01[];
  evidenceTierCeiling: ConformanceEvidenceTierV01;
};

export type ConformanceProfileExtensionV01 = {
  profileId: ConformanceProfileIdV01;
  key: string;
  note: string;
};

export type ConformanceManifestV01 = {
  schemaVersion: typeof CONFORMANCE_SCHEMA_VERSION_V01;
  adapterId: string;
  abiVersion: typeof CONFORMANCE_ABI_VERSION_V01;
  supportedProfiles: ConformanceProfileV01[];
  optionalExtensions?: ConformanceProfileExtensionV01[];
};

export type ConformanceResultV01 = {
  schemaVersion: typeof CONFORMANCE_SCHEMA_VERSION_V01;
  adapterId: string;
  profileId: ConformanceProfileIdV01;
  outcome: ConformanceResultOutcomeV01;
  evidence: ConformanceEvidenceRefV01[];
  recordedAt: string;
};

export type ConformanceIngestionErrorOptions = {
  code: string;
  message: string;
};

export class ConformanceIngestionError extends Error {
  readonly code: string;
  constructor(options: ConformanceIngestionErrorOptions) {
    super(`${options.code}: ${options.message}`);
    this.name = "ConformanceIngestionError";
    this.code = options.code;
  }
}

function reject(code: string, message: string): never {
  throw new ConformanceIngestionError({ code, message });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("itotori.conformance.shape_invalid", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    reject("itotori.conformance.shape_invalid", `${label} must be an array`);
  }
  return value;
}

function assertBoundedString(
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

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    reject("itotori.conformance.shape_invalid", `${label} must be a boolean`);
  }
  return value;
}

function assertEnum<T extends string>(
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

function assertAllowedKeys(
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

function assertRecordedAt(value: unknown, label: string): string {
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

function assertAdapterId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ADAPTER_ID_PATTERN.test(value)) {
    reject(
      "itotori.conformance.adapter_id_malformed",
      `${label} (${String(value)}) is not a valid adapter id`,
    );
  }
  return value;
}

function assertExtensionKey(value: unknown, label: string): string {
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

function assertIdString(value: unknown, label: string): string {
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

function assertRuntimeArtifactUri(value: unknown, label: string): string {
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

function assertStatePath(value: unknown, label: string): string {
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

function assertEvidenceRef(value: unknown, label: string): ConformanceEvidenceRefV01 {
  const record = asRecord(value, label);
  const artifactKind = assertEnum(
    record.artifactKind,
    CONFORMANCE_EVIDENCE_REF_KINDS_V01,
    `${label}.artifactKind`,
  );
  switch (artifactKind) {
    case "runtimeArtifact": {
      assertAllowedKeys(record, ["artifactKind", "kind", "uri", "artifactId"], label);
      const kind = assertEnum(record.kind, CONFORMANCE_RUNTIME_ARTIFACT_KINDS_V01, `${label}.kind`);
      const uri = assertRuntimeArtifactUri(record.uri, `${label}.uri`);
      let artifactId: string | undefined;
      if (record.artifactId !== undefined) {
        artifactId = assertIdString(record.artifactId, `${label}.artifactId`);
      }
      return artifactId === undefined
        ? { artifactKind, kind, uri }
        : { artifactKind, kind, uri, artifactId };
    }
    case "textLine": {
      assertAllowedKeys(record, ["artifactKind", "lineId"], label);
      const lineId = assertIdString(record.lineId, `${label}.lineId`);
      return { artifactKind, lineId };
    }
    case "frameArtifactRef": {
      assertAllowedKeys(record, ["artifactKind", "frameId"], label);
      const frameId = assertIdString(record.frameId, `${label}.frameId`);
      return { artifactKind, frameId };
    }
    case "replayLogRef": {
      assertAllowedKeys(record, ["artifactKind", "runId"], label);
      const runId = assertIdString(record.runId, `${label}.runId`);
      return { artifactKind, runId };
    }
    case "implMapFixture": {
      assertAllowedKeys(record, ["artifactKind", "fixtureId"], label);
      const fixtureId = assertIdString(record.fixtureId, `${label}.fixtureId`);
      return { artifactKind, fixtureId };
    }
    case "bridgeUnit": {
      assertAllowedKeys(record, ["artifactKind", "bridgeUnitId"], label);
      const bridgeUnitId = assertIdString(record.bridgeUnitId, `${label}.bridgeUnitId`);
      return { artifactKind, bridgeUnitId };
    }
    case "statePath": {
      assertAllowedKeys(record, ["artifactKind", "path"], label);
      const path = assertStatePath(record.path, `${label}.path`);
      return { artifactKind, path };
    }
  }
}

function assertOutcome(value: unknown, label: string): ConformanceResultOutcomeV01 {
  const record = asRecord(value, label);
  const kind = assertEnum(record.kind, CONFORMANCE_OUTCOME_KINDS_V01, `${label}.kind`);
  switch (kind) {
    case "pass": {
      assertAllowedKeys(record, ["kind", "evidenceTier"], label);
      const evidenceTier = assertEnum(
        record.evidenceTier,
        CONFORMANCE_EVIDENCE_TIERS_V01,
        `${label}.evidenceTier`,
        "itotori.conformance.evidence_tier_malformed",
      );
      return { kind, evidenceTier };
    }
    case "fail": {
      assertAllowedKeys(record, ["kind", "semanticCode", "detail"], label);
      const semanticCode = assertBoundedString(
        record.semanticCode,
        `${label}.semanticCode`,
        MAX_ID_LENGTH * 4,
        "itotori.conformance.semantic_code_malformed",
      );
      assertSemanticCodeAllowedV01(semanticCode, `${label}.semanticCode`);
      const detail = assertBoundedString(record.detail, `${label}.detail`, MAX_DETAIL_LENGTH);
      return { kind, semanticCode, detail };
    }
    case "skip": {
      assertAllowedKeys(record, ["kind", "semanticCode", "reason"], label);
      const semanticCode = assertBoundedString(
        record.semanticCode,
        `${label}.semanticCode`,
        MAX_ID_LENGTH * 4,
        "itotori.conformance.semantic_code_malformed",
      );
      assertSemanticCodeAllowedV01(semanticCode, `${label}.semanticCode`);
      const reason = assertBoundedString(record.reason, `${label}.reason`, MAX_REASON_LENGTH);
      return { kind, semanticCode, reason };
    }
    case "unsupported": {
      assertAllowedKeys(record, ["kind", "semanticCode", "declaredInManifest"], label);
      const semanticCode = assertBoundedString(
        record.semanticCode,
        `${label}.semanticCode`,
        MAX_ID_LENGTH * 4,
        "itotori.conformance.semantic_code_malformed",
      );
      assertSemanticCodeAllowedV01(semanticCode, `${label}.semanticCode`);
      const declaredInManifest = assertBoolean(
        record.declaredInManifest,
        `${label}.declaredInManifest`,
      );
      if (declaredInManifest) {
        reject(
          "itotori.conformance.declared_profile_reported_as_unsupported",
          `${label}.declaredInManifest must be false (declared profiles cannot be Unsupported)`,
        );
      }
      return { kind, semanticCode, declaredInManifest };
    }
  }
}

function assertProfile(value: unknown, label: string): ConformanceProfileV01 {
  const record = asRecord(value, label);
  assertAllowedKeys(record, ["id", "requiredSubsystems", "evidenceTierCeiling"], label);
  const id = assertEnum(record.id, CONFORMANCE_PROFILE_IDS_V01, `${label}.id`);
  const requiredArray = asArray(record.requiredSubsystems, `${label}.requiredSubsystems`);
  const seen = new Set<ConformanceSubsystemRequirementV01>();
  const requiredSubsystems: ConformanceSubsystemRequirementV01[] = [];
  for (const [index, entry] of requiredArray.entries()) {
    const sub = assertEnum(
      entry,
      CONFORMANCE_SUBSYSTEM_REQUIREMENTS_V01,
      `${label}.requiredSubsystems[${String(index)}]`,
    );
    if (seen.has(sub)) {
      reject(
        "itotori.conformance.duplicate_subsystem",
        `${label}.requiredSubsystems[${String(index)}] duplicates ${sub}`,
      );
    }
    seen.add(sub);
    requiredSubsystems.push(sub);
  }
  for (const needed of PROFILE_REQUIRED_SUBSYSTEMS[id]) {
    if (!seen.has(needed)) {
      reject(
        "itotori.conformance.missing_subsystem",
        `${label}.requiredSubsystems is missing ${needed} for profile ${id}`,
      );
    }
  }
  const evidenceTierCeiling = assertEnum(
    record.evidenceTierCeiling,
    CONFORMANCE_EVIDENCE_TIERS_V01,
    `${label}.evidenceTierCeiling`,
    "itotori.conformance.evidence_tier_malformed",
  );
  const profileCeiling = PROFILE_EVIDENCE_TIER_CEILING[id];
  if (compareEvidenceTier(evidenceTierCeiling, profileCeiling) > 0) {
    reject(
      "itotori.conformance.evidence_tier_above_profile_ceiling",
      `${label}.evidenceTierCeiling (${evidenceTierCeiling}) exceeds profile ${id} ceiling ${profileCeiling}`,
    );
  }
  return { id, requiredSubsystems, evidenceTierCeiling };
}

function assertProfileExtension(value: unknown, label: string): ConformanceProfileExtensionV01 {
  const record = asRecord(value, label);
  assertAllowedKeys(record, ["profileId", "key", "note"], label);
  const profileId = assertEnum(record.profileId, CONFORMANCE_PROFILE_IDS_V01, `${label}.profileId`);
  const key = assertExtensionKey(record.key, `${label}.key`);
  const note = assertBoundedString(record.note, `${label}.note`, MAX_NOTE_LENGTH);
  return { profileId, key, note };
}

function compareEvidenceTier(a: ConformanceEvidenceTierV01, b: ConformanceEvidenceTierV01): number {
  return CONFORMANCE_EVIDENCE_TIERS_V01.indexOf(a) - CONFORMANCE_EVIDENCE_TIERS_V01.indexOf(b);
}

export function assertConformanceManifestV01(
  value: unknown,
): asserts value is ConformanceManifestV01 {
  const record = asRecord(value, "ConformanceManifestV01");
  assertAllowedKeys(
    record,
    ["schemaVersion", "adapterId", "abiVersion", "supportedProfiles", "optionalExtensions"],
    "ConformanceManifestV01",
  );
  if (record.schemaVersion !== CONFORMANCE_SCHEMA_VERSION_V01) {
    reject(
      "itotori.conformance.schema_version_mismatch",
      `ConformanceManifestV01.schemaVersion must be ${CONFORMANCE_SCHEMA_VERSION_V01} (got ${String(record.schemaVersion)})`,
    );
  }
  assertAdapterId(record.adapterId, "ConformanceManifestV01.adapterId");
  if (record.abiVersion !== CONFORMANCE_ABI_VERSION_V01) {
    reject(
      "itotori.conformance.abi_version_unsupported",
      `ConformanceManifestV01.abiVersion must be ${String(CONFORMANCE_ABI_VERSION_V01)} (got ${String(record.abiVersion)})`,
    );
  }
  const profilesArray = asArray(
    record.supportedProfiles,
    "ConformanceManifestV01.supportedProfiles",
  );
  if (profilesArray.length === 0) {
    reject(
      "itotori.conformance.manifest_empty",
      "ConformanceManifestV01.supportedProfiles must not be empty",
    );
  }
  const seenIds = new Set<ConformanceProfileIdV01>();
  const profiles: ConformanceProfileV01[] = [];
  for (const [index, entry] of profilesArray.entries()) {
    const profile = assertProfile(
      entry,
      `ConformanceManifestV01.supportedProfiles[${String(index)}]`,
    );
    if (seenIds.has(profile.id)) {
      reject(
        "itotori.conformance.duplicate_profile",
        `ConformanceManifestV01.supportedProfiles[${String(index)}] duplicates profile ${profile.id}`,
      );
    }
    seenIds.add(profile.id);
    profiles.push(profile);
  }
  if (record.optionalExtensions !== undefined) {
    const extArray = asArray(
      record.optionalExtensions,
      "ConformanceManifestV01.optionalExtensions",
    );
    const seenExt = new Set<string>();
    for (const [index, entry] of extArray.entries()) {
      const extension = assertProfileExtension(
        entry,
        `ConformanceManifestV01.optionalExtensions[${String(index)}]`,
      );
      if (!seenIds.has(extension.profileId)) {
        reject(
          "itotori.conformance.orphaned_extension",
          `ConformanceManifestV01.optionalExtensions[${String(index)}] references undeclared profile ${extension.profileId}`,
        );
      }
      const key = `${extension.profileId}::${extension.key}`;
      if (seenExt.has(key)) {
        reject(
          "itotori.conformance.duplicate_extension",
          `ConformanceManifestV01.optionalExtensions[${String(index)}] duplicates ${extension.profileId}/${extension.key}`,
        );
      }
      seenExt.add(key);
    }
  }
}

export function assertConformanceResultV01(value: unknown): asserts value is ConformanceResultV01 {
  const record = asRecord(value, "ConformanceResultV01");
  assertAllowedKeys(
    record,
    ["schemaVersion", "adapterId", "profileId", "outcome", "evidence", "recordedAt"],
    "ConformanceResultV01",
  );
  if (record.schemaVersion !== CONFORMANCE_SCHEMA_VERSION_V01) {
    reject(
      "itotori.conformance.schema_version_mismatch",
      `ConformanceResultV01.schemaVersion must be ${CONFORMANCE_SCHEMA_VERSION_V01} (got ${String(record.schemaVersion)})`,
    );
  }
  assertAdapterId(record.adapterId, "ConformanceResultV01.adapterId");
  const profileId = assertEnum(
    record.profileId,
    CONFORMANCE_PROFILE_IDS_V01,
    "ConformanceResultV01.profileId",
  );
  assertRecordedAt(record.recordedAt, "ConformanceResultV01.recordedAt");
  const evidenceArray = asArray(record.evidence, "ConformanceResultV01.evidence");
  const evidence: ConformanceEvidenceRefV01[] = [];
  for (const [index, entry] of evidenceArray.entries()) {
    evidence.push(assertEvidenceRef(entry, `ConformanceResultV01.evidence[${String(index)}]`));
  }
  const outcome = assertOutcome(record.outcome, "ConformanceResultV01.outcome");
  if (outcome.kind === "pass") {
    if (evidence.length === 0) {
      reject(
        "itotori.conformance.pass_without_evidence",
        `ConformanceResultV01.evidence must be non-empty for Pass outcomes on profile ${profileId}`,
      );
    }
    const profileCeiling = PROFILE_EVIDENCE_TIER_CEILING[profileId];
    if (compareEvidenceTier(outcome.evidenceTier, profileCeiling) > 0) {
      reject(
        "itotori.conformance.evidence_tier_above_profile_ceiling",
        `ConformanceResultV01.outcome.evidenceTier (${outcome.evidenceTier}) exceeds profile ${profileId} ceiling ${profileCeiling}`,
      );
    }
  }
}

export type ConformanceCrossValidationIssueV01 = {
  code: string;
  message: string;
  profileId?: ConformanceProfileIdV01;
};

// Mirrors the Rust `cross_validate_results_against_manifest` invariants.
// Returns the first issue found via the error throw; returns successfully
// otherwise.
export function assertConformanceManifestResultJoinV01(
  manifest: ConformanceManifestV01,
  results: ReadonlyArray<ConformanceResultV01>,
): void {
  const declared = new Map<ConformanceProfileIdV01, ConformanceProfileV01>();
  for (const profile of manifest.supportedProfiles) {
    declared.set(profile.id, profile);
  }
  const reported = new Set<ConformanceProfileIdV01>();
  for (const result of results) {
    if (result.adapterId !== manifest.adapterId) {
      reject(
        "itotori.conformance.adapter_id_mismatch",
        `result.adapterId (${result.adapterId}) does not match manifest.adapterId (${manifest.adapterId})`,
      );
    }
    reported.add(result.profileId);
    const profileDeclared = declared.has(result.profileId);
    switch (result.outcome.kind) {
      case "pass": {
        if (!profileDeclared) {
          reject(
            "itotori.conformance.profile_not_declared",
            `result.profileId (${result.profileId}) is not declared in manifest`,
          );
        }
        const profile = declared.get(result.profileId);
        if (profile !== undefined) {
          if (compareEvidenceTier(result.outcome.evidenceTier, profile.evidenceTierCeiling) > 0) {
            reject(
              "itotori.conformance.pass_above_manifest_ceiling",
              `result.outcome.evidenceTier (${result.outcome.evidenceTier}) exceeds manifest profile ${result.profileId} ceiling ${profile.evidenceTierCeiling}`,
            );
          }
        }
        break;
      }
      case "fail": {
        if (!profileDeclared) {
          reject(
            "itotori.conformance.profile_not_declared",
            `result.profileId (${result.profileId}) is not declared in manifest`,
          );
        }
        break;
      }
      case "skip": {
        if (profileDeclared) {
          reject(
            "itotori.conformance.declared_profile_skipped",
            `declared profile ${result.profileId} reported as Skip`,
          );
        }
        break;
      }
      case "unsupported": {
        if (profileDeclared) {
          reject(
            "itotori.conformance.declared_profile_reported_as_unsupported",
            `declared profile ${result.profileId} reported as Unsupported`,
          );
        }
        // declared_in_manifest=true is already rejected by assertOutcome.
        break;
      }
    }
  }
  for (const profile of manifest.supportedProfiles) {
    if (!reported.has(profile.id)) {
      reject(
        "itotori.conformance.profile_not_reported",
        `manifest profile ${profile.id} has no matching result`,
      );
    }
  }
}

export function profileEvidenceTierCeilingV01(
  profileId: ConformanceProfileIdV01,
): ConformanceEvidenceTierV01 {
  return PROFILE_EVIDENCE_TIER_CEILING[profileId];
}

export function profileRequiredSubsystemsV01(
  profileId: ConformanceProfileIdV01,
): ReadonlyArray<ConformanceSubsystemRequirementV01> {
  return PROFILE_REQUIRED_SUBSYSTEMS[profileId];
}
