import { describe, expect, it } from "vitest";
import { sha256Bytes, stableJson } from "../src/corpus-manifest/manifest.js";
import {
  buildTripleTierBenchmarkCorpus,
  materializeMetricCorpus,
  materializeTripleTierCorpus,
  parseTripleTierBenchmarkCorpusManifest,
  parseTripleTierPrivatePayload,
  readdressTripleTierBenchmarkCorpusManifest,
  type TripleTierBenchmarkCorpusManifest,
  type TripleTierPrivatePayload,
} from "../src/benchmark-corpus/index.js";

const PAYLOAD_UNITS = [
  {
    bridgeUnitId: "unit-a",
    sourceText: "source-a",
    fanTranslation: "fan-a",
    officialTranslation: "official-a",
  },
  {
    bridgeUnitId: "unit-b",
    sourceText: "source-b",
    fanTranslation: "fan-b",
    officialTranslation: "official-b",
  },
  {
    bridgeUnitId: "unit-c",
    sourceText: "source-c",
    fanTranslation: "fan-c",
    officialTranslation: "official-c",
  },
] as const;

function fingerprint(value: string) {
  return { sha256: sha256Bytes(value), byteLength: value.length };
}

function tier(
  units: readonly (typeof PAYLOAD_UNITS)[number][],
  key: "sourceText" | "fanTranslation" | "officialTranslation",
  locale: string,
) {
  const projection = units.map((unit) => ({ bridgeUnitId: unit.bridgeUnitId, text: unit[key] }));
  return {
    locale,
    unitTextProjectionSha256: sha256Bytes(stableJson(projection)),
    unitCount: units.length,
    characterCount: units.reduce((count, unit) => count + Array.from(unit[key]).length, 0),
  };
}

function fixture(): {
  manifest: TripleTierBenchmarkCorpusManifest;
  payload: TripleTierPrivatePayload;
} {
  const alignment = PAYLOAD_UNITS.map((unit, index) => ({
    bridgeUnitId: unit.bridgeUnitId,
    sourceUnitKey: `scene-00${index + 1}#0000`,
    sceneKey: `scene-00${index + 1}`,
    sourceHash: sha256Bytes(`decoded-source-${index + 1}`),
    sourceTextSha256: sha256Bytes(unit.sourceText),
    fanTranslationSha256: sha256Bytes(unit.fanTranslation),
    officialTranslationSha256: sha256Bytes(unit.officialTranslation),
  }));
  const tuningUnitIds = ["unit-a", "unit-b"];
  const heldOutUnitIds = ["unit-c"];
  const manifest = readdressTripleTierBenchmarkCorpusManifest({
    schemaVersion: "itotori.triple-tier-benchmark-corpus.v1",
    manifestId: "private-triple-tier-example",
    contentAddress: {
      algorithm: "sha256",
      canonicalization: "json-key-sort-v1",
      manifestSha256: sha256Bytes("replace-me"),
    },
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
      corpusId: "private-triple-tier-example",
      engine: "example-engine",
      sourceLocale: "ja-JP",
      targetLocale: "en-US",
      kaifuuDecode: {
        bridgeExport: fingerprint("bridge"),
        decompileReport: fingerprint("report"),
        sourceBundleHash: sha256Bytes("source-bundle"),
        assetCount: 3,
        decodedUnitCount: alignment.length,
        sceneCount: 3,
        totalOpcodes: 9,
        recognizedOpcodes: 9,
        unknownOpcodes: 0,
      },
      tiers: {
        source: tier(PAYLOAD_UNITS, "sourceText", "ja-JP"),
        fanTranslation: tier(PAYLOAD_UNITS, "fanTranslation", "en-US"),
        officialTranslation: tier(PAYLOAD_UNITS, "officialTranslation", "en-US"),
      },
    },
    alignment: { units: alignment, projectionSha256: sha256Bytes(stableJson(alignment)) },
    split: {
      locked: true,
      heldOutUsage: "report-results-only",
      heldOutMayTuneModel: false,
      heldOutMayCalibrateRubric: false,
      tuningUnitIds,
      heldOutUnitIds,
      selectionSha256: sha256Bytes(stableJson({ tuningUnitIds, heldOutUnitIds })),
    },
  });
  return {
    manifest,
    payload: {
      schemaVersion: "itotori.triple-tier-benchmark-private-payload.v1",
      manifestSha256: manifest.contentAddress.manifestSha256,
      units: structuredClone(PAYLOAD_UNITS),
    },
  };
}

describe("triple-tier benchmark corpus", () => {
  it("builds a reviewable metadata record without retaining copyrighted-tier text", () => {
    const built = buildTripleTierBenchmarkCorpus({
      manifestId: "private-triple-tier-built-example",
      corpusId: "private-triple-tier-built-example",
      engine: "example-engine",
      sourceLocale: "ja-JP",
      targetLocale: "en-US",
      kaifuuDecode: fixture().manifest.corpus.kaifuuDecode,
      units: PAYLOAD_UNITS.map((unit, index) => ({
        bridgeUnitId: unit.bridgeUnitId,
        sourceUnitKey: `scene-00${index + 1}#0000`,
        sceneKey: `scene-00${index + 1}`,
        sourceHash: sha256Bytes(`decoded-source-${index + 1}`),
        sourceText: unit.sourceText,
        fanTranslation: unit.fanTranslation,
        officialTranslation: unit.officialTranslation,
      })),
      split: { tuningUnitIds: ["unit-a", "unit-b"], heldOutUnitIds: ["unit-c"] },
    });

    expect(JSON.stringify(built.manifest)).not.toContain("source-a");
    expect(JSON.stringify(built.manifest)).not.toContain("fan-a");
    expect(JSON.stringify(built.manifest)).not.toContain("official-a");
    expect(built.privatePayload.manifestSha256).toBe(built.manifest.contentAddress.manifestSha256);
  });

  it("admits exact three-tier alignment and exposes separate harness and metric inputs", () => {
    const { manifest, payload } = fixture();
    const heldOut = materializeTripleTierCorpus(manifest, payload, "held_out_evaluation");
    const metrics = materializeMetricCorpus(manifest, payload, "held_out_evaluation");

    expect(heldOut.split).toBe("held_out");
    expect(heldOut.sourceUnits.map((unit) => unit.bridgeUnitId)).toEqual(["unit-c"]);
    expect(heldOut.fixedCandidateTiers.fanTranslation).toEqual([
      { bridgeUnitId: "unit-c", targetText: "fan-c" },
    ]);
    expect(heldOut.fixedCandidateTiers.officialTranslation).toEqual([
      { bridgeUnitId: "unit-c", targetText: "official-c" },
    ]);
    expect(metrics.units).toEqual([
      {
        bridgeUnitId: "unit-c",
        sourceUnitKey: "scene-003#0000",
        sceneKey: "scene-003",
        sourceHash: sha256Bytes("decoded-source-3"),
        sourceText: "source-c",
        candidates: { fanTranslation: "fan-c", officialTranslation: "official-c" },
      },
    ]);
  });

  it("excludes the held-out unit from tuning access", () => {
    const { manifest, payload } = fixture();
    const tuning = materializeTripleTierCorpus(manifest, payload, "tuning");

    expect(tuning.split).toBe("tuning");
    expect(tuning.sourceUnits.map((unit) => unit.bridgeUnitId)).toEqual(["unit-a", "unit-b"]);
    expect(tuning.sourceUnits.map((unit) => unit.bridgeUnitId)).not.toContain("unit-c");
  });

  it("rejects an unpinned tier, a changed private translation, and split contamination", () => {
    const { manifest, payload } = fixture();

    const changedTranslation = structuredClone(payload);
    changedTranslation.units[0]!.fanTranslation = "changed";
    expect(() => materializeTripleTierCorpus(manifest, changedTranslation, "tuning")).toThrow(
      /committed unit alignment/u,
    );

    const unpinnedTier = structuredClone(manifest);
    unpinnedTier.corpus.tiers.officialTranslation.unitCount = 2;
    const readdressedTier = readdressTripleTierBenchmarkCorpusManifest(unpinnedTier);
    const tierPayload = structuredClone(payload);
    tierPayload.manifestSha256 = readdressedTier.contentAddress.manifestSha256;
    expect(() => materializeTripleTierCorpus(readdressedTier, tierPayload, "tuning")).toThrow(
      /every tier must align/u,
    );

    const contaminated = structuredClone(manifest);
    contaminated.split.tuningUnitIds.push("unit-c");
    const readdressedSplit = readdressTripleTierBenchmarkCorpusManifest(contaminated);
    const splitPayload = structuredClone(payload);
    splitPayload.manifestSha256 = readdressedSplit.contentAddress.manifestSha256;
    expect(() => materializeTripleTierCorpus(readdressedSplit, splitPayload, "tuning")).toThrow(
      /disjoint and unique/u,
    );
  });

  it("rejects public payload fields and duplicate JSON keys before content addressing", () => {
    const { manifest } = fixture();
    const withPayload = structuredClone(manifest) as TripleTierBenchmarkCorpusManifest & {
      sourceText: string;
    };
    withPayload.sourceText = "must not enter metadata";
    const readdressed = readdressTripleTierBenchmarkCorpusManifest(withPayload);
    expect(() => materializeTripleTierCorpus(readdressed, fixture().payload, "tuning")).toThrow(
      /forbidden payload/u,
    );

    expect(() =>
      parseTripleTierBenchmarkCorpusManifest(
        '{"manifestId":"first","manifestId":"second","schemaVersion":"itotori.triple-tier-benchmark-corpus.v1"}',
      ),
    ).toThrow(/duplicate JSON object key/u);
  });

  it("uses strict parsing for private payload admission", () => {
    const { payload } = fixture();
    expect(parseTripleTierPrivatePayload(JSON.stringify(payload))).toEqual(payload);
    expect(() =>
      parseTripleTierPrivatePayload(
        '{"schemaVersion":"itotori.triple-tier-benchmark-private-payload.v1","schemaVersion":"wrong"}',
      ),
    ).toThrow(/duplicate JSON object key/u);
  });

  it("rejects decode evidence or split policy that weakens the locked evaluation boundary", () => {
    const { manifest, payload } = fixture();
    const unknownOpcode = structuredClone(manifest);
    unknownOpcode.corpus.kaifuuDecode.recognizedOpcodes = 8;
    unknownOpcode.corpus.kaifuuDecode.unknownOpcodes = 1;
    const readdressedDecode = readdressTripleTierBenchmarkCorpusManifest(unknownOpcode);
    const decodePayload = structuredClone(payload);
    decodePayload.manifestSha256 = readdressedDecode.contentAddress.manifestSha256;
    expect(() => materializeTripleTierCorpus(readdressedDecode, decodePayload, "tuning")).toThrow(
      /zero-unknown decode/u,
    );

    const tuneableHeldOut = structuredClone(manifest) as TripleTierBenchmarkCorpusManifest & {
      split: { heldOutMayTuneModel: boolean };
    };
    tuneableHeldOut.split.heldOutMayTuneModel = true;
    const readdressedPolicy = readdressTripleTierBenchmarkCorpusManifest(tuneableHeldOut);
    const policyPayload = structuredClone(payload);
    policyPayload.manifestSha256 = readdressedPolicy.contentAddress.manifestSha256;
    expect(() => materializeTripleTierCorpus(readdressedPolicy, policyPayload, "tuning")).toThrow(
      /heldOutMayTuneModel/u,
    );
  });
});
