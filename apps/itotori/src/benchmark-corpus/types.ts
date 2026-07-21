// Metadata-only contract for a private, aligned translation benchmark corpus.

import type { Sha256 } from "../corpus-manifest/manifest.js";

export const TRIPLE_TIER_BENCHMARK_CORPUS_SCHEMA_VERSION =
  "itotori.triple-tier-benchmark-corpus.v1" as const;
export const TRIPLE_TIER_PRIVATE_PAYLOAD_SCHEMA_VERSION =
  "itotori.triple-tier-benchmark-private-payload.v1" as const;

export type BenchmarkCorpusSplit = "tuning" | "held_out";
export type BenchmarkCorpusAccess = "tuning" | "held_out_evaluation";

export type FileFingerprint = {
  sha256: Sha256;
  byteLength: number;
};

export type TierFingerprint = {
  locale: string;
  unitTextProjectionSha256: Sha256;
  unitCount: number;
  characterCount: number;
};

export type TripleTierAlignmentUnit = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sceneKey: string;
  sourceHash: Sha256;
  sourceTextSha256: Sha256;
  fanTranslationSha256: Sha256;
  officialTranslationSha256: Sha256;
};

export type TripleTierBenchmarkCorpusManifest = {
  schemaVersion: typeof TRIPLE_TIER_BENCHMARK_CORPUS_SCHEMA_VERSION;
  manifestId: string;
  contentAddress: {
    algorithm: "sha256";
    canonicalization: "json-key-sort-v1";
    manifestSha256: Sha256;
  };
  privacy: {
    classification: "private-corpus-metadata-only";
    containsCopyrightedText: false;
    retention: "read-only-never-publish";
    forbiddenPayloads: string[];
  };
  corpus: {
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
    tiers: {
      source: TierFingerprint;
      fanTranslation: TierFingerprint;
      officialTranslation: TierFingerprint;
    };
  };
  alignment: {
    units: TripleTierAlignmentUnit[];
    projectionSha256: Sha256;
  };
  split: {
    locked: true;
    heldOutUsage: "report-results-only";
    heldOutMayTuneModel: false;
    heldOutMayCalibrateRubric: false;
    tuningUnitIds: string[];
    heldOutUnitIds: string[];
    selectionSha256: Sha256;
  };
};

/** Copyright-bearing text is accepted only from this local-only structure. */
export type TripleTierPrivatePayload = {
  schemaVersion: typeof TRIPLE_TIER_PRIVATE_PAYLOAD_SCHEMA_VERSION;
  manifestSha256: Sha256;
  units: Array<{
    bridgeUnitId: string;
    sourceText: string;
    fanTranslation: string;
    officialTranslation: string;
  }>;
};

/** Source and fixed-candidate values ready for a blind contestant runner. */
export type ContestantHarnessCorpusInput = {
  manifestSha256: Sha256;
  split: BenchmarkCorpusSplit;
  sourceLocale: string;
  targetLocale: string;
  sourceUnits: Array<{
    bridgeUnitId: string;
    sourceUnitKey: string;
    sceneKey: string;
    sourceHash: Sha256;
    sourceText: string;
  }>;
  fixedCandidateTiers: {
    fanTranslation: Array<{ bridgeUnitId: string; targetText: string }>;
    officialTranslation: Array<{ bridgeUnitId: string; targetText: string }>;
  };
};

/** Identity and text values ready for deterministic metric consumers. */
export type MetricCorpusInput = {
  manifestSha256: Sha256;
  split: BenchmarkCorpusSplit;
  units: Array<{
    bridgeUnitId: string;
    sourceUnitKey: string;
    sceneKey: string;
    sourceHash: Sha256;
    sourceText: string;
    candidates: {
      fanTranslation: string;
      officialTranslation: string;
    };
  }>;
};
