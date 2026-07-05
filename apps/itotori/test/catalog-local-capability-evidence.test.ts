import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type CapabilityEvidenceInput as DbCapabilityEvidenceInput,
  EngineCapabilityReportRepository,
  capabilityEvidenceLabelValues,
  engineCapabilityEvidenceKindValues,
  engineCapabilityEvidenceSourceValues,
  engineCapabilityEvidenceStatusValues,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import {
  type CatalogCapabilityEvidenceMergeInput,
  type CatalogCapabilityEvidenceReadiness,
  type CatalogKeyValidationFixture,
  catalogCapabilityEvidenceInputSchemaVersion,
  catalogPublicRpgMakerMvMzAdapterId,
  catalogRpgMakerMvMzKeyValidationFixtureId,
  mapKeyValidationFixtureToCapabilityEvidence,
  mapLocalCapabilityEvidenceToDbInput,
  mapLocalEngineEvidenceToCapabilityEvidence,
  mapPublicKeyValidationEvidenceToDbInput,
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

  it("loads the public-only merge fixture with an explicit empty private aggregate", async () => {
    const input = await readJson<CatalogCapabilityEvidenceMergeInput>(
      "fixtures/public/catalog-capability-evidence-mv-mz-merge/input/merge-public-only-v0.1.json",
    );

    (input as unknown as { privateLocalAggregate: [] }).privateLocalAggregate = [];

    const merged = mergeCapabilityEvidenceFixture(input);

    expect(merged.supportEvidence.publicFixture).toHaveLength(1);
    expect(merged.supportEvidence.privateLocalAggregate).toEqual([]);
  });

  it("rejects contaminated public fixture merge evidence before readiness JSON generation", () => {
    for (const [name, contaminate] of unsafePublicFixtureMergeVariants()) {
      const input = publicOnlyMergeInput() as unknown as Record<string, unknown>;
      contaminate(input);

      expect(
        () =>
          mergeCapabilityEvidenceFixture(input as unknown as CatalogCapabilityEvidenceMergeInput),
        name,
      ).toThrow(
        /unsupported|not supported|forbidden public evidence|not allowed in public fixture (?:evidence|matrix(?: status)?)|must be/u,
      );
    }
  });

  it("produces public_fixture key_validation runtime evidence from the KAIFUU fixture (not adapter_matrix)", async () => {
    const fixture = await readJson<CatalogKeyValidationFixture>(
      "fixtures/public/kaifuu-encrypted-matrix/expected/rpg-maker-mv-mz-key-validation-success-v0.1.json",
    );
    expect(fixture.fixtureId).toBe(catalogRpgMakerMvMzKeyValidationFixtureId);

    const evidence = mapKeyValidationFixtureToCapabilityEvidence(fixture);

    // The gap this closes: it is `key_validation` runtime readiness, NOT the
    // static `adapter_matrix` shape the merge producer hard-codes.
    expect(evidence.evidenceSource).toBe("public_fixture");
    expect(evidence.evidenceKind).toBe("key_validation");
    expect(evidence.evidenceKind).not.toBe("adapter_matrix");
    expect(evidence).toEqual({
      schemaVersion: catalogCapabilityEvidenceInputSchemaVersion,
      adapterId: catalogPublicRpgMakerMvMzAdapterId,
      level: "extract",
      evidenceSource: "public_fixture",
      evidenceKind: "key_validation",
      fixtureId: catalogRpgMakerMvMzKeyValidationFixtureId,
      status: "present",
      aggregateCounts: {
        key_validation_records: 1,
        key_validation_success: 1,
      },
      evidenceLabels: [capabilityEvidenceLabelValues.publicFixtureKeyValidation],
      limitations: [
        "public fixture key-validation runtime evidence; validates fixture-safe MV/MZ key evidence against System metadata and encrypted image evidence only",
        "key validation does not decrypt, extract, replace, or patch encrypted media",
      ],
    });

    // No fixture proof hashes / key material may leak into surfaced evidence.
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("proofHash");
    expect(serialized).not.toContain("sha256:");
    for (const record of fixture.records) {
      expect(serialized).not.toContain(record.proofHash);
      expect(serialized).not.toContain(record.systemJsonProofHash);
      expect(serialized).not.toContain(record.imageEvidenceHash);
    }
  });

  it("maps key_validation evidence into a DB input the consumer repository accepts as runtime readiness", async () => {
    const fixture = await readJson<CatalogKeyValidationFixture>(
      "fixtures/public/kaifuu-encrypted-matrix/expected/rpg-maker-mv-mz-key-validation-success-v0.1.json",
    );
    const evidence = mapKeyValidationFixtureToCapabilityEvidence(fixture);
    const dbInput = mapPublicKeyValidationEvidenceToDbInput(evidence);

    expect(dbInput).toEqual({
      adapterId: catalogPublicRpgMakerMvMzAdapterId,
      level: "extract",
      evidenceSource: engineCapabilityEvidenceSourceValues.publicFixture,
      evidenceKind: engineCapabilityEvidenceKindValues.keyValidation,
      schemaVersion: catalogCapabilityEvidenceInputSchemaVersion,
      status: engineCapabilityEvidenceStatusValues.present,
      aggregateCounts: {
        key_validation_records: 1,
        key_validation_success: 1,
      },
      evidenceLabels: [capabilityEvidenceLabelValues.publicFixtureKeyValidation],
      limitations: [
        "public fixture key-validation runtime evidence; validates fixture-safe MV/MZ key evidence against System metadata and encrypted image evidence only",
        "key validation does not decrypt, extract, replace, or patch encrypted media",
      ],
      publicFixtureId: catalogRpgMakerMvMzKeyValidationFixtureId,
    } satisfies DbCapabilityEvidenceInput);

    // The DB-side consumer must accept this exact shape: the repository's
    // source/kind pairing + leakage guards run before persistence. A capturing
    // stub returns the normalized row, proving validation passed.
    const persisted = await repositoryWithCapturingStub().recordCapabilityEvidence(
      { userId: "local-user" },
      dbInput,
    );
    expect(persisted).toMatchObject({
      evidenceSource: engineCapabilityEvidenceSourceValues.publicFixture,
      evidenceKind: engineCapabilityEvidenceKindValues.keyValidation,
      publicFixtureId: catalogRpgMakerMvMzKeyValidationFixtureId,
      evidenceLabels: [capabilityEvidenceLabelValues.publicFixtureKeyValidation],
    });
  });

  it("derives partial/missing key_validation status and per-outcome aggregate counts", () => {
    const partial = mapKeyValidationFixtureToCapabilityEvidence(
      keyValidationFixture({
        records: [
          keyValidationRecord("success"),
          keyValidationRecord("bad_key"),
          keyValidationRecord("unsupported_suffix"),
        ],
      }),
    );
    expect(partial.status).toBe("partial");
    expect(partial.aggregateCounts).toEqual({
      key_validation_bad_key: 1,
      key_validation_records: 3,
      key_validation_success: 1,
      key_validation_unsupported_suffix: 1,
    });

    const failed = mapKeyValidationFixtureToCapabilityEvidence(
      keyValidationFixture({
        status: "failed",
        records: [keyValidationRecord("missing_key")],
      }),
    );
    expect(failed.status).toBe("missing");
    expect(failed.aggregateCounts).toEqual({
      key_validation_missing_key: 1,
      key_validation_records: 1,
    });
  });

  it("rejects unknown key_validation fixtures and outcomes", () => {
    expect(() =>
      mapKeyValidationFixtureToCapabilityEvidence(
        keyValidationFixture({ fixtureId: "some-other-fixture" }),
      ),
    ).toThrow(/unsupported key validation fixtureId/u);

    expect(() =>
      mapKeyValidationFixtureToCapabilityEvidence(
        keyValidationFixture({
          records: [keyValidationRecord("mystery_outcome" as "success")],
        }),
      ),
    ).toThrow(/unsupported diagnosticResult/u);

    expect(() =>
      mapKeyValidationFixtureToCapabilityEvidence(keyValidationFixture({ records: [] })),
    ).toThrow(/at least one record/u);
  });
});

function keyValidationRecord(
  diagnosticResult: CatalogKeyValidationFixture["records"][number]["diagnosticResult"],
): CatalogKeyValidationFixture["records"][number] {
  return {
    requirementId: "rpg-maker-mv-mz-asset-key",
    secretRefScheme: "local-secret",
    surface: "image_asset",
    codec: "png_image",
    diagnosticResult,
    proofHash: "sha256:a326ae67c10fd2c4de4907469f85292b85f2040b318c739ea8bac2f2c6ebb176",
    systemJsonProofHash: "sha256:c7a19c8919ea7345ac69ac2e6591f6cbd35bd354a3e6be27de7b3461e233246d",
    imageEvidenceHash: "sha256:5bda4203182bc8aecb1a49af627733d73728a98f0483ed02ed409e3619e12572",
  };
}

function keyValidationFixture(
  overrides: Partial<CatalogKeyValidationFixture> = {},
): CatalogKeyValidationFixture {
  return {
    schemaVersion: "0.1.0",
    fixtureId: catalogRpgMakerMvMzKeyValidationFixtureId,
    status: "passed",
    supportBoundary: "fixture-safe MV/MZ key evidence only",
    records: [keyValidationRecord("success")],
    decryptOrPatchClaimed: false,
    ...overrides,
  };
}

function repositoryWithCapturingStub(): EngineCapabilityReportRepository {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ permission: "project.import" }],
        }),
      }),
    }),
    insert: () => ({
      values: (row: unknown) => ({
        returning: async () => [row],
      }),
    }),
  } as never;
  return new EngineCapabilityReportRepository(db);
}

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

function publicOnlyMergeInput(): CatalogCapabilityEvidenceMergeInput {
  return {
    schemaVersion: "catalog.capability_evidence_merge_fixture.v0.1",
    publicFixture: {
      fixtureId: "catalog-capability-evidence-mv-mz-public-matrix",
      matrix: {
        adapterId: "kaifuu.rpg-maker-mv-mz",
        identify: {
          kind: "supported",
        },
        inventory: {
          kind: "unsupported",
          reason: "public synthetic fixture records identify-only MV/MZ matrix support",
        },
        extract: {
          kind: "unsupported",
          reason: "public synthetic fixture does not claim extraction support",
        },
        patch: {
          kind: "unsupported",
          reason: "public synthetic fixture does not claim patch support",
        },
      },
      evidence: [
        {
          level: "identify",
          evidenceSource: "public_fixture",
          evidenceKind: "adapter_matrix",
          status: "present",
          evidenceLabels: ["rpg_maker_mv_mz_public_fixture_matrix"],
          limitations: [
            "public synthetic fixture matrix only; no private-local aggregate sidecar is required",
          ],
        },
      ],
    },
  };
}

function unsafePublicFixtureMergeVariants(): [string, (input: Record<string, unknown>) => void][] {
  return [
    [
      "unsupported public matrix key",
      (input) => {
        publicMatrix(input).debug = true;
      },
    ],
    [
      "unsupported public matrix status key",
      (input) => {
        matrixStatus(input, "identify").sourcePath = "/scratch/local/private-game/System.json";
      },
    ],
    [
      "unknown public matrix status kind",
      (input) => {
        matrixStatus(input, "inventory").kind = "unknown";
      },
    ],
    [
      "public matrix supported status reason",
      (input) => {
        matrixStatus(input, "identify").reason = "supported status must not carry reasons";
      },
    ],
    [
      "public matrix unsupported status limitations",
      (input) => {
        matrixStatus(input, "extract").limitations = ["unsupported status must not carry limits"];
      },
    ],
    [
      "public matrix reason private path",
      (input) => {
        matrixStatus(input, "extract").reason = "/scratch/local/private-game/System.json";
      },
    ],
    [
      "public matrix partial limitation private path",
      (input) => {
        publicMatrix(input).inventory = {
          kind: "partial",
          limitations: ["~/private-game/dialogue.txt"],
        };
      },
    ],
    [
      "public matrix empty partial limitations",
      (input) => {
        publicMatrix(input).inventory = { kind: "partial", limitations: [] };
      },
    ],
    [
      "public matrix malformed partial limitations",
      (input) => {
        publicMatrix(input).inventory = { kind: "partial", limitations: [""] };
      },
    ],
    [
      "private path fixture id",
      (input) => {
        publicFixture(input).fixtureId = "/home/local/private-game";
      },
    ],
    [
      "private source marker",
      (input) => {
        publicEvidenceRow(input).evidenceSource = "private_local_aggregate";
      },
    ],
    [
      "local sidecar evidence kind",
      (input) => {
        publicEvidenceRow(input).evidenceKind = "local_corpus_sidecar";
      },
    ],
    [
      "unsupported status",
      (input) => {
        publicEvidenceRow(input).status = "supported";
      },
    ],
    [
      "unsupported label",
      (input) => {
        publicEvidenceRow(input).evidenceLabels = ["rpgmaker_mv_metadata"];
      },
    ],
    [
      "private scan id field",
      (input) => {
        publicEvidenceRow(input).localScanEntryId = "catalog-local-entry:secret";
      },
    ],
    [
      "private hash field",
      (input) => {
        publicEvidenceRow(input).pathHash =
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      },
    ],
    [
      "private filename limitation",
      (input) => {
        publicEvidenceRow(input).limitations = ["rawText Private Story Vol 1.zip"];
      },
    ],
    [
      "screenshot evidence field",
      (input) => {
        publicEvidenceRow(input).screenshot = "capture.png";
      },
    ],
    [
      "scratch path limitation",
      (input) => {
        publicEvidenceRow(input).limitations = ["/scratch/local/private-game/System.json"];
      },
    ],
    [
      "mnt path limitation",
      (input) => {
        publicEvidenceRow(input).limitations = ["/mnt/private-game/System.json"];
      },
    ],
    [
      "Users path limitation",
      (input) => {
        publicEvidenceRow(input).limitations = ["/Users/alice/private-game/System.json"];
      },
    ],
    [
      "Volumes path limitation",
      (input) => {
        publicEvidenceRow(input).limitations = ["/Volumes/data/private-game/System.json"];
      },
    ],
    [
      "private path limitation",
      (input) => {
        publicEvidenceRow(input).limitations = ["/private/tmp/private-game/System.json"];
      },
    ],
    [
      "home-relative path limitation",
      (input) => {
        publicEvidenceRow(input).limitations = ["~/private-game/System.json"];
      },
    ],
    [
      "json filename limitation",
      (input) => {
        publicEvidenceRow(input).limitations = ["System.json"];
      },
    ],
    [
      "txt filename limitation",
      (input) => {
        publicEvidenceRow(input).limitations = ["dialogue.txt"];
      },
    ],
  ];
}

function publicFixture(input: Record<string, unknown>): Record<string, unknown> {
  return input.publicFixture as Record<string, unknown>;
}

function publicMatrix(input: Record<string, unknown>): Record<string, unknown> {
  return publicFixture(input).matrix as Record<string, unknown>;
}

function matrixStatus(input: Record<string, unknown>, level: string): Record<string, unknown> {
  return publicMatrix(input)[level] as Record<string, unknown>;
}

function publicEvidenceRow(input: Record<string, unknown>): Record<string, unknown> {
  const evidence = publicFixture(input).evidence as Record<string, unknown>[];
  return evidence[0]!;
}

async function readJson<T>(path: string): Promise<T> {
  const content = await readFile(resolve("../..", path), "utf8");
  return JSON.parse(content) as T;
}
