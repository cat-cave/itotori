import { isLocaleTaggedSourceEcho } from "./target-text.js";
import type { NonBlankTargetText } from "./target-text.js";
import {
  PATCH_EXPORT_ASSET_DECISION_POLICIES,
  PATCH_EXPORT_BUNDLE_SCHEMA_VERSION,
  PATCH_EXPORT_PREFLIGHT_CHECK_KINDS,
  PATCH_EXPORT_PREFLIGHT_STATUSES,
  PATCH_EXPORT_PROTECTED_SPAN_KINDS,
  PATCH_EXPORT_PROTECTED_SPAN_PRESERVATION_RULES,
  PatchExportBundleValidationError,
  type PatchExportAssetDecision,
  type PatchExportBundle,
  type PatchExportDraft,
  type PatchExportProvenance,
  type PreflightResult,
  type ProtectedSpanMapping,
} from "./patch-export-bundle.types.js";

const PATCH_EXPORT_PREFLIGHT_CHECK_VALUES: ReadonlyArray<string> = [
  ...PATCH_EXPORT_PREFLIGHT_CHECK_KINDS,
];

const PATCH_EXPORT_PREFLIGHT_STATUS_VALUES: ReadonlyArray<string> = [
  ...PATCH_EXPORT_PREFLIGHT_STATUSES,
];

const PATCH_EXPORT_PROTECTED_SPAN_KIND_VALUES: ReadonlyArray<string> = [
  ...PATCH_EXPORT_PROTECTED_SPAN_KINDS,
];

const PATCH_EXPORT_PROTECTED_SPAN_PRESERVATION_RULE_VALUES: ReadonlyArray<string> = [
  ...PATCH_EXPORT_PROTECTED_SPAN_PRESERVATION_RULES,
];

const PATCH_EXPORT_ASSET_DECISION_POLICY_VALUES: ReadonlyArray<string> = [
  ...PATCH_EXPORT_ASSET_DECISION_POLICIES,
];

export function assertPatchExportBundle(value: unknown): asserts value is PatchExportBundle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PatchExportBundleValidationError("", "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "projectId",
    "localeBranchId",
    "sourceBridgeHash",
    "targetLocale",
    "drafts",
    "assetDecisions",
    "preflightResults",
    "provenance",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new PatchExportBundleValidationError(
        key,
        "additionalProperties",
        `unexpected top-level property ${key}`,
      );
    }
  }
  if (record.schemaVersion !== PATCH_EXPORT_BUNDLE_SCHEMA_VERSION) {
    throw new PatchExportBundleValidationError(
      "schemaVersion",
      "const",
      `expected ${PATCH_EXPORT_BUNDLE_SCHEMA_VERSION}, got ${String(record.schemaVersion)}`,
    );
  }
  assertNonEmptyString(record.projectId, "projectId");
  assertNonEmptyString(record.localeBranchId, "localeBranchId");
  assertNonEmptyString(record.sourceBridgeHash, "sourceBridgeHash");
  assertNonEmptyString(record.targetLocale, "targetLocale");
  if (!Array.isArray(record.drafts)) {
    throw new PatchExportBundleValidationError("drafts", "type", "expected array");
  }
  for (const [index, entry] of record.drafts.entries()) {
    assertDraft(entry, `drafts[${index}]`);
  }
  if (!Array.isArray(record.assetDecisions)) {
    throw new PatchExportBundleValidationError("assetDecisions", "type", "expected array");
  }
  for (const [index, entry] of record.assetDecisions.entries()) {
    assertAssetDecision(entry, `assetDecisions[${index}]`);
  }
  if (!Array.isArray(record.preflightResults)) {
    throw new PatchExportBundleValidationError("preflightResults", "type", "expected array");
  }
  for (const [index, entry] of record.preflightResults.entries()) {
    assertPreflightResult(entry, `preflightResults[${index}]`);
  }
  assertProvenance(record.provenance, "provenance");
}

function assertDraft(value: unknown, label: string): asserts value is PatchExportDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PatchExportBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "sourceUnitId",
    "draftId",
    "sourceText",
    "draftText",
    "protectedSpanMappings",
    "sourceUnitHash",
    "draftUnitHash",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new PatchExportBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertNonEmptyString(record.sourceUnitId, `${label}.sourceUnitId`);
  assertNonEmptyString(record.draftId, `${label}.draftId`);
  if (typeof record.sourceText !== "string") {
    throw new PatchExportBundleValidationError(`${label}.sourceText`, "type", "expected string");
  }
  assertNonBlankTargetDraftText(record.draftText, `${label}.draftText`);
  if (record.sourceText.trim().length > 0 && record.draftText === record.sourceText.trim()) {
    throw new PatchExportBundleValidationError(
      `${label}.draftText`,
      "sourceEcho",
      "must not repeat the source text",
    );
  }
  assertNonEmptyString(record.sourceUnitHash, `${label}.sourceUnitHash`);
  assertNonEmptyString(record.draftUnitHash, `${label}.draftUnitHash`);
  if (!Array.isArray(record.protectedSpanMappings)) {
    throw new PatchExportBundleValidationError(
      `${label}.protectedSpanMappings`,
      "type",
      "expected array",
    );
  }
  for (const [index, mapping] of record.protectedSpanMappings.entries()) {
    assertProtectedSpanMapping(mapping, `${label}.protectedSpanMappings[${index}]`);
  }
}

function assertNonBlankTargetDraftText(
  value: unknown,
  label: string,
): asserts value is NonBlankTargetText {
  if (typeof value !== "string") {
    throw new PatchExportBundleValidationError(label, "type", "expected string");
  }
  if (value.trim().length === 0) {
    throw new PatchExportBundleValidationError(label, "nonBlank", "must not be blank");
  }
  if (value !== value.trim()) {
    throw new PatchExportBundleValidationError(
      label,
      "trimmed",
      "must not have leading or trailing whitespace",
    );
  }
  if (isLocaleTaggedSourceEcho(value)) {
    throw new PatchExportBundleValidationError(
      label,
      "sourceEcho",
      "must not use a locale-tagged source replay",
    );
  }
}

function assertProtectedSpanMapping(
  value: unknown,
  label: string,
): asserts value is ProtectedSpanMapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PatchExportBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "spanRef",
    "sourceStart",
    "sourceEnd",
    "draftStart",
    "draftEnd",
    "kind",
    "preservationRule",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new PatchExportBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertNonEmptyString(record.spanRef, `${label}.spanRef`);
  assertNonNegativeInteger(record.sourceStart, `${label}.sourceStart`);
  assertNonNegativeInteger(record.sourceEnd, `${label}.sourceEnd`);
  assertNonNegativeInteger(record.draftStart, `${label}.draftStart`);
  assertNonNegativeInteger(record.draftEnd, `${label}.draftEnd`);
  if (record.sourceEnd < record.sourceStart) {
    throw new PatchExportBundleValidationError(
      `${label}.sourceEnd`,
      "range",
      "sourceEnd must be >= sourceStart",
    );
  }
  if (record.draftEnd < record.draftStart) {
    throw new PatchExportBundleValidationError(
      `${label}.draftEnd`,
      "range",
      "draftEnd must be >= draftStart",
    );
  }
  if (
    typeof record.kind !== "string" ||
    !PATCH_EXPORT_PROTECTED_SPAN_KIND_VALUES.includes(record.kind)
  ) {
    throw new PatchExportBundleValidationError(
      `${label}.kind`,
      "enum",
      `must be one of [${PATCH_EXPORT_PROTECTED_SPAN_KIND_VALUES.join(", ")}]`,
    );
  }
  if (
    typeof record.preservationRule !== "string" ||
    !PATCH_EXPORT_PROTECTED_SPAN_PRESERVATION_RULE_VALUES.includes(record.preservationRule)
  ) {
    throw new PatchExportBundleValidationError(
      `${label}.preservationRule`,
      "enum",
      `must be one of [${PATCH_EXPORT_PROTECTED_SPAN_PRESERVATION_RULE_VALUES.join(", ")}]`,
    );
  }
}

function assertAssetDecision(
  value: unknown,
  label: string,
): asserts value is PatchExportAssetDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PatchExportBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["assetRef", "assetKind", "policy", "decisionId", "rationale"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new PatchExportBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertNonEmptyString(record.assetRef, `${label}.assetRef`);
  assertNonEmptyString(record.assetKind, `${label}.assetKind`);
  assertNonEmptyString(record.decisionId, `${label}.decisionId`);
  if (
    typeof record.policy !== "string" ||
    !PATCH_EXPORT_ASSET_DECISION_POLICY_VALUES.includes(record.policy)
  ) {
    throw new PatchExportBundleValidationError(
      `${label}.policy`,
      "enum",
      `must be one of [${PATCH_EXPORT_ASSET_DECISION_POLICY_VALUES.join(", ")}]`,
    );
  }
  if (record.rationale !== undefined && typeof record.rationale !== "string") {
    throw new PatchExportBundleValidationError(
      `${label}.rationale`,
      "type",
      "expected string when present",
    );
  }
}

function assertPreflightResult(value: unknown, label: string): asserts value is PreflightResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PatchExportBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["check", "status", "detail", "blockingExport"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new PatchExportBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  if (
    typeof record.check !== "string" ||
    !PATCH_EXPORT_PREFLIGHT_CHECK_VALUES.includes(record.check)
  ) {
    throw new PatchExportBundleValidationError(
      `${label}.check`,
      "enum",
      `must be one of [${PATCH_EXPORT_PREFLIGHT_CHECK_VALUES.join(", ")}]`,
    );
  }
  if (
    typeof record.status !== "string" ||
    !PATCH_EXPORT_PREFLIGHT_STATUS_VALUES.includes(record.status)
  ) {
    throw new PatchExportBundleValidationError(
      `${label}.status`,
      "enum",
      `must be one of [${PATCH_EXPORT_PREFLIGHT_STATUS_VALUES.join(", ")}]`,
    );
  }
  if (typeof record.blockingExport !== "boolean") {
    throw new PatchExportBundleValidationError(
      `${label}.blockingExport`,
      "type",
      "expected boolean",
    );
  }
  if (record.detail !== undefined && typeof record.detail !== "string") {
    throw new PatchExportBundleValidationError(
      `${label}.detail`,
      "type",
      "expected string when present",
    );
  }
}

function assertProvenance(value: unknown, label: string): asserts value is PatchExportProvenance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PatchExportBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "draftArtifactBundleId",
    "agreedQaScore",
    "exportedAt",
    "exportedByUserId",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new PatchExportBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertNonEmptyString(record.draftArtifactBundleId, `${label}.draftArtifactBundleId`);
  assertNonEmptyString(record.exportedAt, `${label}.exportedAt`);
  assertNonEmptyString(record.exportedByUserId, `${label}.exportedByUserId`);
  if (record.agreedQaScore !== undefined) {
    if (typeof record.agreedQaScore !== "number" || Number.isNaN(record.agreedQaScore)) {
      throw new PatchExportBundleValidationError(
        `${label}.agreedQaScore`,
        "type",
        "expected number",
      );
    }
    if (record.agreedQaScore < 0 || record.agreedQaScore > 1) {
      throw new PatchExportBundleValidationError(
        `${label}.agreedQaScore`,
        "range",
        "must be between 0 and 1 inclusive",
      );
    }
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new PatchExportBundleValidationError(label, "type", "expected string");
  }
  if (value.length === 0) {
    throw new PatchExportBundleValidationError(label, "minLength", "must be non-empty");
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PatchExportBundleValidationError(label, "type", "expected integer");
  }
  if (value < 0) {
    throw new PatchExportBundleValidationError(label, "minimum", "must be >= 0");
  }
}

/**
 * Strict-parsing wrapper for raw JSON. JSON parse failures are wrapped
 * in `PatchExportBundleValidationError` so callers never see a raw
 * `SyntaxError`.
 */
export function parsePatchExportBundle(raw: string): PatchExportBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PatchExportBundleValidationError(
      "",
      "json",
      `bundle is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertPatchExportBundle(parsed);
  return parsed;
}
