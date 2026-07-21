// Build reviewed, metadata-only corpus records from private aligned text.

import { sha256Bytes, stableJson, type Sha256 } from "../corpus-manifest/manifest.js";
import {
  TRIPLE_TIER_BENCHMARK_CORPUS_SCHEMA_VERSION,
  TRIPLE_TIER_PRIVATE_PAYLOAD_SCHEMA_VERSION,
  type FileFingerprint,
  type TierFingerprint,
  type TripleTierAlignmentUnit,
  type TripleTierBenchmarkCorpusManifest,
  type TripleTierPrivatePayload,
} from "./types.js";
import {
  addressTripleTierBenchmarkCorpusManifest,
  assertTripleTierBenchmarkCorpusManifest,
} from "./validate.js";

export type TripleTierCorpusBuildInput = {
  manifestId: string;
  corpusId: string;
  engine: string;
  sourceLocale: string;
  targetLocale: string;
  kaifuuDecode: {
    bridgeExport: FileFingerprint;
    decompileReport: FileFingerprint;
    sourceBundleHash: Sha256;
    assetCount: number;
    decodedUnitCount: number;
    sceneCount: number;
    totalOpcodes: number;
    recognizedOpcodes: number;
    unknownOpcodes: number;
  };
  units: Array<{
    bridgeUnitId: string;
    sourceUnitKey: string;
    sceneKey: string;
    sourceHash: Sha256;
    sourceText: string;
    fanTranslation: string;
    officialTranslation: string;
  }>;
  split: {
    tuningUnitIds: string[];
    heldOutUnitIds: string[];
  };
};

export type TripleTierCorpusBuildResult = {
  manifest: TripleTierBenchmarkCorpusManifest;
  privatePayload: TripleTierPrivatePayload;
};

/**
 * Derive a public-safe manifest and matching private payload. Callers retain
 * the payload locally; only the returned manifest is suitable for review.
 */
export function buildTripleTierBenchmarkCorpus(
  input: TripleTierCorpusBuildInput,
): TripleTierCorpusBuildResult {
  const alignment = input.units.map(toAlignmentUnit);
  const payloadUnits = input.units.map(
    ({ bridgeUnitId, sourceText, fanTranslation, officialTranslation }) => ({
      bridgeUnitId,
      sourceText,
      fanTranslation,
      officialTranslation,
    }),
  );
  const manifest = addressTripleTierBenchmarkCorpusManifest({
    schemaVersion: TRIPLE_TIER_BENCHMARK_CORPUS_SCHEMA_VERSION,
    manifestId: input.manifestId,
    privacy: {
      classification: "private-corpus-metadata-only",
      containsCopyrightedText: false,
      retention: "read-only-never-publish",
      forbiddenPayloads: [
        "sourceText",
        "fanTranslationText",
        "officialTranslationText",
        "rawSourceBytes",
        "rawTargetBytes",
        "privateLocalPath",
      ],
    },
    corpus: {
      corpusId: input.corpusId,
      engine: input.engine,
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      kaifuuDecode: input.kaifuuDecode,
      tiers: {
        source: tierFingerprint(payloadUnits, "sourceText", input.sourceLocale),
        fanTranslation: tierFingerprint(payloadUnits, "fanTranslation", input.targetLocale),
        officialTranslation: tierFingerprint(
          payloadUnits,
          "officialTranslation",
          input.targetLocale,
        ),
      },
    },
    alignment: {
      units: alignment,
      projectionSha256: sha256Bytes(stableJson(alignment)),
    },
    split: {
      locked: true,
      heldOutUsage: "report-results-only",
      heldOutMayTuneModel: false,
      heldOutMayCalibrateRubric: false,
      tuningUnitIds: input.split.tuningUnitIds,
      heldOutUnitIds: input.split.heldOutUnitIds,
      selectionSha256: sha256Bytes(stableJson(input.split)),
    },
  });
  assertTripleTierBenchmarkCorpusManifest(manifest);
  return {
    manifest,
    privatePayload: {
      schemaVersion: TRIPLE_TIER_PRIVATE_PAYLOAD_SCHEMA_VERSION,
      manifestSha256: manifest.contentAddress.manifestSha256,
      units: payloadUnits,
    },
  };
}

function toAlignmentUnit(
  unit: TripleTierCorpusBuildInput["units"][number],
): TripleTierAlignmentUnit {
  return {
    bridgeUnitId: unit.bridgeUnitId,
    sourceUnitKey: unit.sourceUnitKey,
    sceneKey: unit.sceneKey,
    sourceHash: unit.sourceHash,
    sourceTextSha256: sha256Bytes(unit.sourceText),
    fanTranslationSha256: sha256Bytes(unit.fanTranslation),
    officialTranslationSha256: sha256Bytes(unit.officialTranslation),
  };
}

function tierFingerprint(
  units: TripleTierPrivatePayload["units"],
  textKey: "sourceText" | "fanTranslation" | "officialTranslation",
  locale: string,
): TierFingerprint {
  const projection = units.map((unit) => ({
    bridgeUnitId: unit.bridgeUnitId,
    text: unit[textKey],
  }));
  return {
    locale,
    unitTextProjectionSha256: sha256Bytes(stableJson(projection)),
    unitCount: units.length,
    characterCount: units.reduce((count, unit) => count + Array.from(unit[textKey]).length, 0),
  };
}
