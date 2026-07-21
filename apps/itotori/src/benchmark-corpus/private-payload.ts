// Private-text admission and consumer projections for benchmark evaluation.

import { parseStrictJson } from "../corpus-manifest/json.js";
import { sha256Bytes, stableJson, type Sha256 } from "../corpus-manifest/manifest.js";
import {
  TRIPLE_TIER_PRIVATE_PAYLOAD_SCHEMA_VERSION,
  type BenchmarkCorpusAccess,
  type ContestantHarnessCorpusInput,
  type MetricCorpusInput,
  type TripleTierBenchmarkCorpusManifest,
  type TripleTierPrivatePayload,
} from "./types.js";
import { TripleTierCorpusError, assertTripleTierBenchmarkCorpusManifest } from "./validate.js";

type PrivateUnit = TripleTierPrivatePayload["units"][number];

export function parseTripleTierPrivatePayload(raw: string): TripleTierPrivatePayload {
  const value = parseStrictJson(raw);
  assertPrivatePayloadShape(value);
  return value;
}

/**
 * Verify all private text against the committed metadata, then select one
 * permitted split. There is intentionally no all-units access mode.
 */
export function materializeTripleTierCorpus(
  manifest: TripleTierBenchmarkCorpusManifest,
  payload: TripleTierPrivatePayload,
  access: BenchmarkCorpusAccess,
): ContestantHarnessCorpusInput {
  assertTripleTierBenchmarkCorpusManifest(manifest);
  assertPrivatePayloadShape(payload);
  if (payload.manifestSha256 !== manifest.contentAddress.manifestSha256) {
    fail("content_address_mismatch", "private payload does not belong to this corpus manifest");
  }

  const byId = new Map(payload.units.map((unit) => [unit.bridgeUnitId, unit]));
  if (byId.size !== payload.units.length) {
    fail("alignment_mismatch", "private payload contains duplicate bridge unit identities");
  }
  if (byId.size !== manifest.alignment.units.length) {
    fail(
      "alignment_mismatch",
      "private payload must contain every aligned source unit exactly once",
    );
  }

  for (const aligned of manifest.alignment.units) {
    const privateUnit = byId.get(aligned.bridgeUnitId);
    if (privateUnit === undefined) {
      fail("alignment_mismatch", "private payload is missing an aligned source unit");
    }
    assertUnitMatchesAlignment(privateUnit, aligned);
  }
  assertTierFingerprints(manifest, payload.units);

  const split = access === "tuning" ? "tuning" : "held_out";
  const selectedIds = new Set(
    split === "tuning" ? manifest.split.tuningUnitIds : manifest.split.heldOutUnitIds,
  );
  const selected = manifest.alignment.units
    .filter((unit) => selectedIds.has(unit.bridgeUnitId))
    .map((alignment) => ({ alignment, privateUnit: byId.get(alignment.bridgeUnitId)! }));
  if (selected.length !== selectedIds.size) {
    fail("locked_split_violation", "selected benchmark split does not resolve every locked unit");
  }

  return {
    manifestSha256: manifest.contentAddress.manifestSha256,
    split,
    sourceLocale: manifest.corpus.sourceLocale,
    targetLocale: manifest.corpus.targetLocale,
    sourceUnits: selected.map(({ alignment, privateUnit }) => ({
      bridgeUnitId: alignment.bridgeUnitId,
      sourceUnitKey: alignment.sourceUnitKey,
      sceneKey: alignment.sceneKey,
      sourceHash: alignment.sourceHash,
      sourceText: privateUnit.sourceText,
    })),
    fixedCandidateTiers: {
      fanTranslation: selected.map(({ alignment, privateUnit }) => ({
        bridgeUnitId: alignment.bridgeUnitId,
        targetText: privateUnit.fanTranslation,
      })),
      officialTranslation: selected.map(({ alignment, privateUnit }) => ({
        bridgeUnitId: alignment.bridgeUnitId,
        targetText: privateUnit.officialTranslation,
      })),
    },
  };
}

/** Build a metric projection from the same locked, verified corpus selection. */
export function materializeMetricCorpus(
  manifest: TripleTierBenchmarkCorpusManifest,
  payload: TripleTierPrivatePayload,
  access: BenchmarkCorpusAccess,
): MetricCorpusInput {
  const harnessInput = materializeTripleTierCorpus(manifest, payload, access);
  const fanById = new Map(
    harnessInput.fixedCandidateTiers.fanTranslation.map((unit) => [
      unit.bridgeUnitId,
      unit.targetText,
    ]),
  );
  const officialById = new Map(
    harnessInput.fixedCandidateTiers.officialTranslation.map((unit) => [
      unit.bridgeUnitId,
      unit.targetText,
    ]),
  );
  return {
    manifestSha256: harnessInput.manifestSha256,
    split: harnessInput.split,
    units: harnessInput.sourceUnits.map((unit) => {
      const fanTranslation = fanById.get(unit.bridgeUnitId);
      const officialTranslation = officialById.get(unit.bridgeUnitId);
      if (fanTranslation === undefined || officialTranslation === undefined) {
        fail("alignment_mismatch", "fixed candidate projection is incomplete");
      }
      return {
        bridgeUnitId: unit.bridgeUnitId,
        sourceUnitKey: unit.sourceUnitKey,
        sceneKey: unit.sceneKey,
        sourceHash: unit.sourceHash,
        sourceText: unit.sourceText,
        candidates: { fanTranslation, officialTranslation },
      };
    }),
  };
}

function assertPrivatePayloadShape(value: unknown): asserts value is TripleTierPrivatePayload {
  const payload = record(value, "private payload");
  exactKeys(payload, ["schemaVersion", "manifestSha256", "units"]);
  if (payload.schemaVersion !== TRIPLE_TIER_PRIVATE_PAYLOAD_SCHEMA_VERSION) {
    fail("invalid_manifest", "private payload schema version is not supported");
  }
  sha256(payload.manifestSha256, "private payload.manifestSha256");
  if (!Array.isArray(payload.units) || payload.units.length === 0) {
    fail("invalid_manifest", "private payload.units must be a non-empty array");
  }
  for (const unit of payload.units) {
    const entry = record(unit, "private payload unit");
    exactKeys(entry, ["bridgeUnitId", "sourceText", "fanTranslation", "officialTranslation"]);
    for (const key of ["bridgeUnitId", "sourceText", "fanTranslation", "officialTranslation"]) {
      if (typeof entry[key] !== "string" || entry[key].length === 0) {
        fail("invalid_manifest", "private payload unit has an invalid text field");
      }
    }
  }
}

function assertUnitMatchesAlignment(
  privateUnit: PrivateUnit,
  alignment: TripleTierBenchmarkCorpusManifest["alignment"]["units"][number],
): void {
  const hashes: Array<[string, Sha256]> = [
    [privateUnit.sourceText, alignment.sourceTextSha256],
    [privateUnit.fanTranslation, alignment.fanTranslationSha256],
    [privateUnit.officialTranslation, alignment.officialTranslationSha256],
  ];
  if (hashes.some(([text, expected]) => sha256Bytes(text) !== expected)) {
    fail("alignment_mismatch", "private payload text does not match the committed unit alignment");
  }
}

function assertTierFingerprints(
  manifest: TripleTierBenchmarkCorpusManifest,
  units: PrivateUnit[],
): void {
  const source = units.map((unit) => ({ bridgeUnitId: unit.bridgeUnitId, text: unit.sourceText }));
  const fan = units.map((unit) => ({ bridgeUnitId: unit.bridgeUnitId, text: unit.fanTranslation }));
  const official = units.map((unit) => ({
    bridgeUnitId: unit.bridgeUnitId,
    text: unit.officialTranslation,
  }));
  const actual = [source, fan, official].map((tier) => ({
    unitTextProjectionSha256: sha256Bytes(stableJson(tier)),
    unitCount: tier.length,
    characterCount: tier.reduce((count, unit) => count + Array.from(unit.text).length, 0),
  }));
  const expected = [
    manifest.corpus.tiers.source,
    manifest.corpus.tiers.fanTranslation,
    manifest.corpus.tiers.officialTranslation,
  ];
  if (
    actual.some(
      (tier, index) =>
        tier.unitTextProjectionSha256 !== expected[index]!.unitTextProjectionSha256 ||
        tier.unitCount !== expected[index]!.unitCount ||
        tier.characterCount !== expected[index]!.characterCount,
    )
  ) {
    fail("alignment_mismatch", "private tier fingerprint does not match committed metadata");
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalid_manifest", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  if (stableJson(Object.keys(value).sort()) !== stableJson([...expected].sort())) {
    fail("invalid_manifest", "private payload shape drifted");
  }
}

function sha256(value: unknown, label: string): asserts value is Sha256 {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    fail("invalid_manifest", `${label} must be a SHA-256 content address`);
  }
}

function fail(code: TripleTierCorpusError["code"], message: string): never {
  throw new TripleTierCorpusError(code, message);
}
