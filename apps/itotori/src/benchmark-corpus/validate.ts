// Fail-closed validation for metadata-only, triple-tier benchmark manifests.

import { parseStrictJson } from "../corpus-manifest/json.js";
import { sha256Bytes, stableJson, type Sha256 } from "../corpus-manifest/manifest.js";
import {
  TRIPLE_TIER_BENCHMARK_CORPUS_SCHEMA_VERSION,
  type FileFingerprint,
  type TripleTierAlignmentUnit,
  type TripleTierBenchmarkCorpusManifest,
} from "./types.js";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const METADATA_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,255}$/u;
const FORBIDDEN_PAYLOADS = [
  "sourceText",
  "fanTranslationText",
  "officialTranslationText",
  "rawSourceBytes",
  "rawTargetBytes",
  "privateLocalPath",
] as const;

type JsonRecord = Record<string, unknown>;

export class TripleTierCorpusError extends Error {
  constructor(
    public readonly code:
      | "invalid_manifest"
      | "privacy_violation"
      | "content_address_mismatch"
      | "alignment_mismatch"
      | "locked_split_violation",
    message: string,
  ) {
    super(message);
    this.name = "TripleTierCorpusError";
  }
}

export function parseTripleTierBenchmarkCorpusManifest(
  raw: string,
): TripleTierBenchmarkCorpusManifest {
  const value = parseStrictJson(raw);
  assertTripleTierBenchmarkCorpusManifest(value);
  return value;
}

export function tripleTierManifestContentHash(manifest: TripleTierBenchmarkCorpusManifest): Sha256 {
  const { manifestSha256: _ignored, ...contentAddress } = manifest.contentAddress;
  return sha256Bytes(stableJson({ ...manifest, contentAddress }));
}

/** Address a newly-derived metadata manifest before it reaches any consumer. */
export function addressTripleTierBenchmarkCorpusManifest(
  manifest: Omit<TripleTierBenchmarkCorpusManifest, "contentAddress">,
): TripleTierBenchmarkCorpusManifest {
  const result: TripleTierBenchmarkCorpusManifest = {
    ...structuredClone(manifest),
    contentAddress: {
      algorithm: "sha256",
      canonicalization: "json-key-sort-v1",
      manifestSha256: "" as Sha256,
    },
  };
  result.contentAddress.manifestSha256 = tripleTierManifestContentHash(result);
  return result;
}

export function readdressTripleTierBenchmarkCorpusManifest<
  T extends TripleTierBenchmarkCorpusManifest,
>(manifest: T): T {
  const result = structuredClone(manifest);
  result.contentAddress.manifestSha256 = tripleTierManifestContentHash(result);
  return result as T;
}

export function assertTripleTierBenchmarkCorpusManifest(
  value: unknown,
): asserts value is TripleTierBenchmarkCorpusManifest {
  assertNoForbiddenPayloadKeys(value);
  const manifest = record(value, "manifest");
  exactKeys(manifest, [
    "schemaVersion",
    "manifestId",
    "contentAddress",
    "privacy",
    "corpus",
    "alignment",
    "split",
  ]);
  literal(
    manifest.schemaVersion,
    TRIPLE_TIER_BENCHMARK_CORPUS_SCHEMA_VERSION,
    "manifest.schemaVersion",
  );
  metadataIdentifier(manifest.manifestId, "manifest.manifestId");
  validateContentAddress(manifest.contentAddress);
  validatePrivacy(manifest.privacy);
  validateCorpus(manifest.corpus);
  validateAlignment(manifest.alignment, manifest.corpus);
  validateSplit(manifest.split, manifest.alignment);

  const typed = manifest as unknown as TripleTierBenchmarkCorpusManifest;
  if (typed.contentAddress.manifestSha256 !== tripleTierManifestContentHash(typed)) {
    fail("content_address_mismatch", "triple-tier corpus manifest content address does not match");
  }
}

function validateContentAddress(value: unknown): void {
  const address = record(value, "manifest.contentAddress");
  exactKeys(address, ["algorithm", "canonicalization", "manifestSha256"]);
  literal(address.algorithm, "sha256", "manifest.contentAddress.algorithm");
  literal(address.canonicalization, "json-key-sort-v1", "manifest.contentAddress.canonicalization");
  sha256(address.manifestSha256, "manifest.contentAddress.manifestSha256");
}

function validatePrivacy(value: unknown): void {
  const privacy = record(value, "manifest.privacy");
  exactKeys(privacy, [
    "classification",
    "containsCopyrightedText",
    "retention",
    "forbiddenPayloads",
  ]);
  literal(
    privacy.classification,
    "private-corpus-metadata-only",
    "manifest.privacy.classification",
  );
  literal(privacy.containsCopyrightedText, false, "manifest.privacy.containsCopyrightedText");
  literal(privacy.retention, "read-only-never-publish", "manifest.privacy.retention");
  const payloads = stringArray(privacy.forbiddenPayloads, "manifest.privacy.forbiddenPayloads");
  if (stableJson(payloads) !== stableJson([...FORBIDDEN_PAYLOADS])) {
    fail(
      "privacy_violation",
      "manifest.privacy.forbiddenPayloads must name the complete protected payload set",
    );
  }
}

function validateCorpus(value: unknown): void {
  const corpus = record(value, "manifest.corpus");
  exactKeys(corpus, [
    "corpusId",
    "engine",
    "sourceLocale",
    "targetLocale",
    "kaifuuDecode",
    "tiers",
  ]);
  for (const key of ["corpusId", "engine"])
    metadataIdentifier(corpus[key], `manifest.corpus.${key}`);
  for (const key of ["sourceLocale", "targetLocale"]) locale(corpus[key], `manifest.corpus.${key}`);
  if (corpus.sourceLocale === corpus.targetLocale) {
    fail("invalid_manifest", "manifest.corpus source and target locales must differ");
  }
  validateKaifuuDecode(corpus.kaifuuDecode);
  const tiers = record(corpus.tiers, "manifest.corpus.tiers");
  exactKeys(tiers, ["source", "fanTranslation", "officialTranslation"]);
  validateTier(tiers.source, "manifest.corpus.tiers.source", corpus.sourceLocale);
  validateTier(tiers.fanTranslation, "manifest.corpus.tiers.fanTranslation", corpus.targetLocale);
  validateTier(
    tiers.officialTranslation,
    "manifest.corpus.tiers.officialTranslation",
    corpus.targetLocale,
  );
}

function validateKaifuuDecode(value: unknown): void {
  const decode = record(value, "manifest.corpus.kaifuuDecode");
  exactKeys(decode, [
    "bridgeExport",
    "decompileReport",
    "sourceBundleHash",
    "assetCount",
    "decodedUnitCount",
    "sceneCount",
    "totalOpcodes",
    "recognizedOpcodes",
    "unknownOpcodes",
  ]);
  validateFingerprint(decode.bridgeExport, "manifest.corpus.kaifuuDecode.bridgeExport");
  validateFingerprint(decode.decompileReport, "manifest.corpus.kaifuuDecode.decompileReport");
  sha256(decode.sourceBundleHash, "manifest.corpus.kaifuuDecode.sourceBundleHash");
  for (const key of [
    "assetCount",
    "decodedUnitCount",
    "sceneCount",
    "totalOpcodes",
    "recognizedOpcodes",
  ]) {
    positiveInteger(decode[key], `manifest.corpus.kaifuuDecode.${key}`);
  }
  nonNegativeInteger(decode.unknownOpcodes, "manifest.corpus.kaifuuDecode.unknownOpcodes");
  if (decode.recognizedOpcodes !== decode.totalOpcodes || decode.unknownOpcodes !== 0) {
    fail(
      "invalid_manifest",
      "manifest.corpus.kaifuuDecode must prove a complete zero-unknown decode",
    );
  }
}

function validateTier(value: unknown, label: string, expectedLocale: unknown): void {
  const tier = record(value, label);
  exactKeys(tier, ["locale", "unitTextProjectionSha256", "unitCount", "characterCount"]);
  locale(tier.locale, `${label}.locale`);
  if (tier.locale !== expectedLocale) {
    fail("alignment_mismatch", `${label}.locale must match its corpus locale`);
  }
  sha256(tier.unitTextProjectionSha256, `${label}.unitTextProjectionSha256`);
  positiveInteger(tier.unitCount, `${label}.unitCount`);
  positiveInteger(tier.characterCount, `${label}.characterCount`);
}

function validateAlignment(value: unknown, corpusValue: unknown): void {
  const alignment = record(value, "manifest.alignment");
  exactKeys(alignment, ["units", "projectionSha256"]);
  const units = array(alignment.units, "manifest.alignment.units");
  if (units.length === 0) fail("alignment_mismatch", "manifest.alignment.units must not be empty");
  const identities = new Set<string>();
  const sourceKeys = new Set<string>();
  for (const [index, unit] of units.entries()) {
    validateAlignmentUnit(unit, `manifest.alignment.units[${index}]`);
    const typed = unit as TripleTierAlignmentUnit;
    if (identities.has(typed.bridgeUnitId) || sourceKeys.has(typed.sourceUnitKey)) {
      fail(
        "alignment_mismatch",
        "manifest.alignment units must be unique by bridge and source identity",
      );
    }
    identities.add(typed.bridgeUnitId);
    sourceKeys.add(typed.sourceUnitKey);
  }
  sha256(alignment.projectionSha256, "manifest.alignment.projectionSha256");
  if (sha256Bytes(stableJson(units)) !== alignment.projectionSha256) {
    fail("alignment_mismatch", "manifest.alignment.projectionSha256 does not match unit metadata");
  }
  const corpus = corpusValue as TripleTierBenchmarkCorpusManifest["corpus"];
  if (
    corpus.kaifuuDecode.decodedUnitCount !== units.length ||
    corpus.tiers.source.unitCount !== units.length ||
    corpus.tiers.fanTranslation.unitCount !== units.length ||
    corpus.tiers.officialTranslation.unitCount !== units.length
  ) {
    fail("alignment_mismatch", "every tier must align exactly once to each decoded source unit");
  }
}

function validateAlignmentUnit(value: unknown, label: string): void {
  const unit = record(value, label);
  exactKeys(unit, [
    "bridgeUnitId",
    "sourceUnitKey",
    "sceneKey",
    "sourceHash",
    "sourceTextSha256",
    "fanTranslationSha256",
    "officialTranslationSha256",
  ]);
  for (const key of ["bridgeUnitId", "sourceUnitKey", "sceneKey"]) {
    metadataIdentifier(unit[key], `${label}.${key}`);
  }
  for (const key of [
    "sourceHash",
    "sourceTextSha256",
    "fanTranslationSha256",
    "officialTranslationSha256",
  ]) {
    sha256(unit[key], `${label}.${key}`);
  }
}

function validateSplit(value: unknown, alignmentValue: unknown): void {
  const split = record(value, "manifest.split");
  exactKeys(split, [
    "locked",
    "heldOutUsage",
    "heldOutMayTuneModel",
    "heldOutMayCalibrateRubric",
    "tuningUnitIds",
    "heldOutUnitIds",
    "selectionSha256",
  ]);
  literal(split.locked, true, "manifest.split.locked");
  literal(split.heldOutUsage, "report-results-only", "manifest.split.heldOutUsage");
  literal(split.heldOutMayTuneModel, false, "manifest.split.heldOutMayTuneModel");
  literal(split.heldOutMayCalibrateRubric, false, "manifest.split.heldOutMayCalibrateRubric");
  const tuning = stringArray(split.tuningUnitIds, "manifest.split.tuningUnitIds");
  const heldOut = stringArray(split.heldOutUnitIds, "manifest.split.heldOutUnitIds");
  if (tuning.length === 0 || heldOut.length === 0) {
    fail("locked_split_violation", "locked split requires non-empty tuning and held-out sets");
  }
  const all = new Set([...tuning, ...heldOut]);
  if (all.size !== tuning.length + heldOut.length) {
    fail("locked_split_violation", "locked split unit ids must be disjoint and unique");
  }
  const units = (alignmentValue as { units: TripleTierAlignmentUnit[] }).units;
  const alignedIds = new Set(units.map((unit) => unit.bridgeUnitId));
  if (all.size !== alignedIds.size || [...all].some((id) => !alignedIds.has(id))) {
    fail("locked_split_violation", "locked split must cover every aligned unit exactly once");
  }
  sha256(split.selectionSha256, "manifest.split.selectionSha256");
  if (
    sha256Bytes(stableJson({ tuningUnitIds: tuning, heldOutUnitIds: heldOut })) !==
    split.selectionSha256
  ) {
    fail(
      "locked_split_violation",
      "manifest.split.selectionSha256 does not match the locked unit lists",
    );
  }
}

function validateFingerprint(value: unknown, label: string): asserts value is FileFingerprint {
  const fingerprint = record(value, label);
  exactKeys(fingerprint, ["sha256", "byteLength"]);
  sha256(fingerprint.sha256, `${label}.sha256`);
  positiveInteger(fingerprint.byteLength, `${label}.byteLength`);
}

function assertNoForbiddenPayloadKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoForbiddenPayloadKeys(entry);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if ((FORBIDDEN_PAYLOADS as readonly string[]).includes(key)) {
      fail("privacy_violation", `metadata-only manifest contains forbidden payload field '${key}'`);
    }
    assertNoForbiddenPayloadKeys(entry);
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalid_manifest", `${label} must be an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail("invalid_manifest", `${label} must be an array`);
  return value;
}

function exactKeys(value: JsonRecord, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (stableJson(actual) !== stableJson(sortedExpected)) {
    fail("invalid_manifest", "triple-tier corpus manifest shape drifted");
  }
}

function literal(value: unknown, expected: string | boolean, label: string): void {
  if (value !== expected) fail("invalid_manifest", `${label} must equal its required literal`);
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("invalid_manifest", `${label} must be a non-empty string`);
  }
}

function metadataIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !METADATA_IDENTIFIER_PATTERN.test(value)) {
    fail("privacy_violation", `${label} must be a safe metadata identifier`);
  }
}

function locale(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value)) {
    fail("invalid_manifest", `${label} must be a BCP-47 locale`);
  }
}

function stringArray(value: unknown, label: string): string[] {
  const result = array(value, label);
  for (const [index, entry] of result.entries()) nonEmptyString(entry, `${label}[${index}]`);
  return result as string[];
}

function sha256(value: unknown, label: string): asserts value is Sha256 {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("invalid_manifest", `${label} must be a SHA-256 content address`);
  }
}

function positiveInteger(value: unknown, label: string): void {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    fail("invalid_manifest", `${label} must be a positive integer`);
  }
}

function nonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    fail("invalid_manifest", `${label} must be a non-negative integer`);
  }
}

function fail(code: TripleTierCorpusError["code"], message: string): never {
  throw new TripleTierCorpusError(code, message);
}
