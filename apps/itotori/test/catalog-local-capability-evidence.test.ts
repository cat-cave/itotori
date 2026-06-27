import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type CapabilityEvidenceInput as DbCapabilityEvidenceInput,
  capabilityEvidenceLabelValues,
  engineCapabilityEvidenceKindValues,
  engineCapabilityEvidenceSourceValues,
  engineCapabilityEvidenceStatusValues,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import {
  type CatalogCapabilityEvidenceMergeInput,
  type CatalogCapabilityEvidenceReadiness,
  catalogCapabilityEvidenceInputSchemaVersion,
  catalogPublicRpgMakerMvMzAdapterId,
  mapLocalCapabilityEvidenceToDbInput,
  mapLocalEngineEvidenceToCapabilityEvidence,
  mergeCapabilityEvidenceFixture,
} from "../src/services/catalog-local-capability-evidence.js";
import type { CatalogLocalEngineEvidence } from "../src/services/catalog-local-scan.js";

describe("catalog local capability evidence mapper", () => {
  it("maps only MV/MZ local scan sidecar evidence into private aggregate identify evidence", () => {
    const mapped = mapLocalEngineEvidenceToCapabilityEvidence(localMvMzEvidence());

    expect(mapped).toEqual([
      {
        schemaVersion: catalogCapabilityEvidenceInputSchemaVersion,
        adapterId: catalogPublicRpgMakerMvMzAdapterId,
        level: "identify",
        evidenceSource: "private_local_aggregate",
        evidenceKind: "local_corpus_sidecar",
        sourceAdapterId: "local-scan:rpg_maker_mv_mz",
        sourceSchemaVersion: "catalog.local_corpus_engine_evidence.v0.1",
        status: "partial",
        aggregateCounts: {
          "extension.json": 2,
          "extension.unknown_extension": 1,
          "file_kind.other": 1,
          "file_kind.script": 2,
          "marker.rpgmaker_mv_metadata": 1,
        },
        evidenceLabels: ["rpgmaker_mv_metadata"],
        limitations: [
          "private-local aggregate marker evidence only; no public fixture support claimed",
          "local scan marker evidence does not claim adapter execution, extraction, inventory, decryption, or patch support",
          "local readiness identify=partial; inventory=unknown; extract=unknown; patch=unknown",
        ],
      },
    ]);
    expect(mapped.every((entry) => entry.level === "identify")).toBe(true);
    expect(JSON.stringify(mapped)).not.toContain("supported");
    expect(JSON.stringify(mapped)).not.toContain("public_fixture");
  });

  it("translates mapped MV/MZ local sidecar evidence into DB-approved capability input", () => {
    const [mapped] = mapLocalEngineEvidenceToCapabilityEvidence(localMvMzEvidence());
    const dbInput = mapLocalCapabilityEvidenceToDbInput(mapped);
    const expected = {
      schemaVersion: catalogCapabilityEvidenceInputSchemaVersion,
      adapterId: catalogPublicRpgMakerMvMzAdapterId,
      level: "identify",
      evidenceSource: engineCapabilityEvidenceSourceValues.privateLocalAggregate,
      evidenceKind: engineCapabilityEvidenceKindValues.localCorpusSidecar,
      status: engineCapabilityEvidenceStatusValues.partial,
      aggregateCounts: {
        local_extension_count: 3,
        local_file_kind_count: 3,
        local_marker_count: 1,
      },
      evidenceLabels: [
        capabilityEvidenceLabelValues.localCorpusMarkerEvidence,
        capabilityEvidenceLabelValues.localEngineMarkerCount,
        capabilityEvidenceLabelValues.localExtensionCount,
        capabilityEvidenceLabelValues.localFileKindCount,
        capabilityEvidenceLabelValues.mvMzMarkerEvidence,
        capabilityEvidenceLabelValues.rpgmakerMvMetadata,
      ],
      limitations: [
        "private-local aggregate marker evidence only; no public fixture support claimed",
        "local scan marker evidence does not claim adapter execution, extraction, inventory, decryption, or patch support",
        "local readiness identify=partial; inventory=unknown; extract=unknown; patch=unknown",
      ],
    } satisfies DbCapabilityEvidenceInput;

    expect(dbInput).toEqual(expected);
    expect(Object.keys(dbInput).sort()).toEqual([
      "adapterId",
      "aggregateCounts",
      "evidenceKind",
      "evidenceLabels",
      "evidenceSource",
      "level",
      "limitations",
      "schemaVersion",
      "status",
    ]);
    expect(Object.keys(dbInput.aggregateCounts ?? {}).every((key) => !key.includes("."))).toBe(
      true,
    );

    const serialized = JSON.stringify(dbInput);
    for (const forbidden of [
      "sourceAdapterId",
      "sourceSchemaVersion",
      "extension.json",
      "file_kind.script",
      "/home",
      "/tmp",
      "C:\\",
      "file:",
      ".rpgmvp",
      "SECRET_KEY",
      "screenshot",
      "pathHash",
      "localScanEntryId",
      "rawText",
      "filename",
      "keyMaterial",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rejects non-MV/MZ local scanner evidence", () => {
    expect(() =>
      mapLocalEngineEvidenceToCapabilityEvidence({
        ...localMvMzEvidence(),
        adapterId: "local-scan:renpy",
        engineName: "renpy",
      }),
    ).toThrow(/unsupported local engine evidence adapterId/u);

    expect(() =>
      mapLocalEngineEvidenceToCapabilityEvidence({
        ...localMvMzEvidence(),
        producer: "third-party-scanner" as CatalogLocalEngineEvidence["producer"],
      }),
    ).toThrow(/unsupported local engine evidence producer/u);
  });

  it("rejects private path, filename, text, key, screenshot, id, and hash shaped data", () => {
    for (const unsafe of unsafeEvidenceVariants()) {
      expect(() => mapLocalEngineEvidenceToCapabilityEvidence(unsafe)).toThrow(
        /forbidden private evidence|not aggregate-safe/u,
      );
    }
  });

  it("loads the public synthetic merge fixture and preserves source separation", async () => {
    const input = await readJson<CatalogCapabilityEvidenceMergeInput>(
      "fixtures/public/catalog-capability-evidence-mv-mz-merge/input/merge-fixture-v0.1.json",
    );
    const expected = await readJson<CatalogCapabilityEvidenceReadiness>(
      "fixtures/public/catalog-capability-evidence-mv-mz-merge/expected/readiness-merge-v0.1.json",
    );

    const merged = mergeCapabilityEvidenceFixture(input);

    expect(merged).toEqual(expected);
    expect(merged.matrix.extract.kind).toBe("unsupported");
    expect(merged.matrix.patch.kind).toBe("unsupported");
    expect(merged.supportEvidence.publicFixture).toHaveLength(1);
    expect(merged.supportEvidence.publicFixture[0]?.evidenceSource).toBe("public_fixture");
    expect(merged.supportEvidence.privateLocalAggregate).toHaveLength(1);
    expect(merged.supportEvidence.privateLocalAggregate[0]?.evidenceSource).toBe(
      "private_local_aggregate",
    );

    const serialized = JSON.stringify(merged);
    for (const forbidden of [
      "/home",
      "/tmp",
      "C:\\",
      "file:",
      ".rpgmvp",
      "SECRET_KEY",
      "screenshot",
      "pathHash",
      "localScanEntryId",
      "rawText",
      "Private Story",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("loads the public-only merge fixture without private/local corpus scanning", async () => {
    const input = await readJson<CatalogCapabilityEvidenceMergeInput>(
      "fixtures/public/catalog-capability-evidence-mv-mz-merge/input/merge-public-only-v0.1.json",
    );
    const expected = await readJson<CatalogCapabilityEvidenceReadiness>(
      "fixtures/public/catalog-capability-evidence-mv-mz-merge/expected/readiness-public-only-v0.1.json",
    );

    expect("privateLocalAggregate" in input).toBe(false);

    const merged = mergeCapabilityEvidenceFixture(input);

    expect(merged).toEqual(expected);
    expect(merged.matrix.identify.kind).toBe("supported");
    expect(merged.matrix.extract.kind).toBe("unsupported");
    expect(merged.matrix.patch.kind).toBe("unsupported");
    expect(merged.supportEvidence.publicFixture).toHaveLength(1);
    expect(merged.supportEvidence.privateLocalAggregate).toEqual([]);

    const serialized = JSON.stringify(merged);
    expect(serialized).not.toContain("local-scan:rpg_maker_mv_mz");
    expect(serialized).not.toContain("catalog.local_corpus_engine_evidence.v0.1");
  });
});

function localMvMzEvidence(): CatalogLocalEngineEvidence {
  return {
    schemaVersion: "catalog.local_corpus_engine_evidence.v0.1",
    producer: "itotori-local-corpus-scanner",
    localDetectionSchemaVersion: "catalog.local_corpus_detection.v0.1",
    adapterId: "local-scan:rpg_maker_mv_mz",
    engineName: "rpg_maker_mv_mz",
    engineSource: "local_scan",
    engineConfidence: "high",
    readiness: {
      identify: "partial",
      inventory: "unknown",
      extract: "unknown",
      patch: "unknown",
    },
    evidence: {
      markerKinds: ["rpgmaker_mv_metadata"],
      extensionCounts: {
        ".json": 2,
        unknown_extension: 1,
      },
      fileKindCounts: {
        other: 1,
        script: 2,
      },
    },
  };
}

function unsafeEvidenceVariants(): CatalogLocalEngineEvidence[] {
  return [
    { ...localMvMzEvidence(), pathHash: "sha256:private" } as CatalogLocalEngineEvidence,
    {
      ...localMvMzEvidence(),
      localScanEntryId: "catalog-local-entry:secret",
    } as CatalogLocalEngineEvidence,
    { ...localMvMzEvidence(), filename: "SecretRoute.rpgmvp" } as CatalogLocalEngineEvidence,
    { ...localMvMzEvidence(), rawText: "Private Story branch text" } as CatalogLocalEngineEvidence,
    { ...localMvMzEvidence(), secretKey: "SECRET_KEY" } as CatalogLocalEngineEvidence,
    { ...localMvMzEvidence(), screenshot: "screen.png" } as CatalogLocalEngineEvidence,
    {
      ...localMvMzEvidence(),
      extra: { path: "/home/local/private-game" },
    } as CatalogLocalEngineEvidence,
    {
      ...localMvMzEvidence(),
      extra: { uri: "file:/tmp/private-game/System.json" },
    } as CatalogLocalEngineEvidence,
  ];
}

async function readJson<T>(path: string): Promise<T> {
  const content = await readFile(resolve("../..", path), "utf8");
  return JSON.parse(content) as T;
}
