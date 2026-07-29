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

export function keyValidationRecord(
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

export function keyValidationFixture(
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

export function repositoryWithCapturingStub(): EngineCapabilityReportRepository {
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

export function localMvMzEvidence(): CatalogLocalEngineEvidence {
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

export function unsafeEvidenceVariants(): CatalogLocalEngineEvidence[] {
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

export function publicOnlyMergeInput(): CatalogCapabilityEvidenceMergeInput {
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

export function unsafePublicFixtureMergeVariants(): [
  string,
  (input: Record<string, unknown>) => void,
][] {
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

export function publicFixture(input: Record<string, unknown>): Record<string, unknown> {
  return input.publicFixture as Record<string, unknown>;
}

export function publicMatrix(input: Record<string, unknown>): Record<string, unknown> {
  return publicFixture(input).matrix as Record<string, unknown>;
}

export function matrixStatus(
  input: Record<string, unknown>,
  level: string,
): Record<string, unknown> {
  return publicMatrix(input)[level] as Record<string, unknown>;
}

export function publicEvidenceRow(input: Record<string, unknown>): Record<string, unknown> {
  const evidence = publicFixture(input).evidence as Record<string, unknown>[];
  return evidence[0]!;
}

export async function readJson<T>(path: string): Promise<T> {
  const content = await readFile(resolve("../..", path), "utf8");
  return JSON.parse(content) as T;
}
