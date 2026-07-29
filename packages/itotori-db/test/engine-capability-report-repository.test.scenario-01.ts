import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  type AdapterCapabilityMatrixRecord,
  type CapabilityEvidenceInput,
  capabilityEvidenceLabelValues,
  EngineCapabilityReportRepository,
  EngineCapabilityReportShapeError,
} from "../src/repositories/engine-capability-report-repository.js";
import {
  capabilityLevelValues,
  engineCapabilityEvidenceKindValues,
  engineCapabilityEvidenceSourceValues,
  engineCapabilityEvidenceStatusValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

// db-side capability-leveled engine detector coverage. The CHECK
// constraint declared in
// `migrations/0028_engine_capability_reports.sql` is asserted to reject
// each mismatched shape; the repository acts as the application-side
// guard before SQL is reached. `bootstrapLocalUser` (run by `migrate`)
// already grants `local-user` every permission, so no per-test grant is
// needed.

const localActor = { userId: "local-user" } as const;

const publicFixtureLabelValues = [
  capabilityEvidenceLabelValues.adapterCapabilityMatrix,
  capabilityEvidenceLabelValues.publicFixtureMatrix,
  capabilityEvidenceLabelValues.publicFixtureKeyValidation,
];

const privateLocalEvidenceLabelValues = [
  capabilityEvidenceLabelValues.rpgmakerMvMetadata,
  capabilityEvidenceLabelValues.rpgmakerMzMetadata,
  capabilityEvidenceLabelValues.encryptedAssetExtension,
  capabilityEvidenceLabelValues.systemJsonLayout,
  capabilityEvidenceLabelValues.localEngineMarkerCount,
  capabilityEvidenceLabelValues.localExtensionCount,
  capabilityEvidenceLabelValues.localFileKindCount,
  capabilityEvidenceLabelValues.localCorpusMarkerEvidence,
  capabilityEvidenceLabelValues.mvMzMarkerEvidence,
];

function fullSupportedMatrix(adapterId: string): AdapterCapabilityMatrixRecord {
  return {
    adapterId,
    identify: { kind: "supported" },
    inventory: { kind: "supported" },
    extract: { kind: "supported" },
    patch: { kind: "supported" },
  };
}

function repositoryWithAuthorizedStub(): EngineCapabilityReportRepository {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ permission: "project.import" }],
        }),
      }),
    }),
    insert: () => {
      throw new Error("invalid evidence should be rejected before persistence");
    },
  } as never;
  return new EngineCapabilityReportRepository(db);
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

function publicFixtureEvidenceInput(
  overrides: Record<string, unknown> = {},
): CapabilityEvidenceInput {
  return {
    adapterId: "kaifuu.rpg_maker_mv_mz",
    level: capabilityLevelValues.identify,
    evidenceSource: engineCapabilityEvidenceSourceValues.publicFixture,
    evidenceKind: engineCapabilityEvidenceKindValues.adapterMatrix,
    schemaVersion: "catalog.capability_evidence.v0.1",
    status: engineCapabilityEvidenceStatusValues.present,
    aggregateCounts: { fixture_rows: 1 },
    evidenceLabels: [capabilityEvidenceLabelValues.publicFixtureMatrix],
    limitations: ["fixture support matrix only"],
    publicFixtureId: "rpg-maker-mv-mz-key-validation-success-v0.1",
    ...overrides,
  } as CapabilityEvidenceInput;
}

function privateLocalAggregateEvidenceInput(
  overrides: Record<string, unknown> = {},
): CapabilityEvidenceInput {
  return {
    adapterId: "kaifuu.rpg_maker_mv_mz",
    level: capabilityLevelValues.identify,
    evidenceSource: engineCapabilityEvidenceSourceValues.privateLocalAggregate,
    evidenceKind: engineCapabilityEvidenceKindValues.localCorpusSidecar,
    schemaVersion: "catalog.local_corpus_engine_evidence.v0.1",
    status: engineCapabilityEvidenceStatusValues.partial,
    aggregateCounts: { marker_kinds: 1 },
    evidenceLabels: [capabilityEvidenceLabelValues.localCorpusMarkerEvidence],
    limitations: ["aggregate marker evidence only"],
    ...overrides,
  } as CapabilityEvidenceInput;
}

describe("EngineCapabilityReportRepository evidence input validation", () => {
  it("accepts valid source-specific evidence before persistence", async () => {
    await expect(
      repositoryWithCapturingStub().recordCapabilityEvidence(
        localActor,
        publicFixtureEvidenceInput({
          evidenceKind: engineCapabilityEvidenceKindValues.keyValidation,
          evidenceLabels: [capabilityEvidenceLabelValues.publicFixtureKeyValidation],
        }),
      ),
    ).resolves.toMatchObject({
      evidenceSource: engineCapabilityEvidenceSourceValues.publicFixture,
      evidenceKind: engineCapabilityEvidenceKindValues.keyValidation,
      evidenceLabels: [capabilityEvidenceLabelValues.publicFixtureKeyValidation],
    });

    await expect(
      repositoryWithCapturingStub().recordCapabilityEvidence(
        localActor,
        privateLocalAggregateEvidenceInput({
          evidenceLabels: privateLocalEvidenceLabelValues,
        }),
      ),
    ).resolves.toMatchObject({
      evidenceSource: engineCapabilityEvidenceSourceValues.privateLocalAggregate,
      evidenceKind: engineCapabilityEvidenceKindValues.localCorpusSidecar,
      evidenceLabels: privateLocalEvidenceLabelValues,
    });
  });

  it("rejects leakage-shaped public and private evidence before persistence", async () => {
    const sourceInputs = [publicFixtureEvidenceInput, privateLocalAggregateEvidenceInput];
    const leakageCases: Record<string, unknown>[] = [
      { adapterId: "/tmp/private/kaifuu" },
      { schemaVersion: "catalog.rawText.v0.1" },
      { aggregateCounts: { pathHash_abcdefabcdefabcdefabcdefabcdefab: 1 } },
      { evidenceLabels: ["rawText"] },
      { limitations: ["found in /home/example/private/Game.rpgmvp"] },
      { limitations: ["found in /private/example/Game.rpgmvp"] },
      { limitations: ["SECRET_KEY was present in rawText"] },
      { limitations: ["screenshot_capture.png was present"] },
      { limitations: ["localScanEntryId entry_123 was present"] },
      { rawSignals: [{ blob: "marker" }] },
    ];

    for (const makeInput of sourceInputs) {
      for (const overrides of leakageCases) {
        await expect(
          repositoryWithAuthorizedStub().recordCapabilityEvidence(localActor, makeInput(overrides)),
        ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
      }
    }
  });

  it("rejects /private rooted values on persisted evidence surfaces", async () => {
    const sourceInputs = [publicFixtureEvidenceInput, privateLocalAggregateEvidenceInput];

    for (const makeInput of sourceInputs) {
      for (const overrides of [
        { limitations: ["aggregate source was /private/corpus/mv/System.json"] },
        { aggregateCounts: { "/private/corpus/mv/system_json_layout": 1 } },
      ]) {
        await expect(
          repositoryWithAuthorizedStub().recordCapabilityEvidence(localActor, makeInput(overrides)),
        ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
      }
    }

    await expect(
      repositoryWithAuthorizedStub().recordCapabilityEvidence(
        localActor,
        publicFixtureEvidenceInput({ publicFixtureId: "/private/corpus/fixture-a" }),
      ),
    ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
  });

  it("rejects /private rooted values that follow a key=value or key:value delimiter (CATALOG-007)", async () => {
    // CATALOG-007 (e3badaa2-3335-4f01-a0d3-73f68e52c953): the leakage guard
    // originally only caught private roots at string starts, whitespace
    // boundaries, and quoted boundaries — a private path glued directly
    // after a `key=`/`key:` delimiter (no separating whitespace) slipped
    // through. These cases assert the `=`/`:` boundary is now caught too.
    const sourceInputs = [publicFixtureEvidenceInput, privateLocalAggregateEvidenceInput];
    const keyValueLeakageCases: Record<string, unknown>[] = [
      { limitations: ["source=/private/corpus"] },
      { limitations: ["path:/private/corpus/mv/System.json"] },
      { schemaVersion: "source=/private/corpus" },
      { aggregateCounts: { "source=/private/corpus": 1 } },
    ];

    for (const makeInput of sourceInputs) {
      for (const overrides of keyValueLeakageCases) {
        await expect(
          repositoryWithAuthorizedStub().recordCapabilityEvidence(localActor, makeInput(overrides)),
        ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
      }
    }

    await expect(
      repositoryWithAuthorizedStub().recordCapabilityEvidence(
        localActor,
        publicFixtureEvidenceInput({ publicFixtureId: "source=/private/corpus" }),
      ),
    ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
  });

  it("rejects path-hash-shaped aggregate keys for public and private evidence", async () => {
    const sourceInputs = [publicFixtureEvidenceInput, privateLocalAggregateEvidenceInput];
    const leakageCases: Record<string, number>[] = [
      { "path.hash": 1 },
      { "path hash": 1 },
      { private_path_hash: 1 },
      { privatePathHash: 1 },
      { "public-path-hash-count": 1 },
      { fixturePathHashCount: 1 },
      { path_hash_private: 1 },
    ];

    for (const makeInput of sourceInputs) {
      for (const aggregateCounts of leakageCases) {
        await expect(
          repositoryWithAuthorizedStub().recordCapabilityEvidence(
            localActor,
            makeInput({ aggregateCounts }),
          ),
        ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
      }
    }
  });

  it("rejects public fixture ids with scan-entry leakage before persistence", async () => {
    await expect(
      repositoryWithAuthorizedStub().recordCapabilityEvidence(
        localActor,
        publicFixtureEvidenceInput({ publicFixtureId: "localScanEntryId_123" }),
      ),
    ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
  });

  it("rejects every private-local evidence label on public fixture evidence", async () => {
    const currentPrivateLabelVocabulary = Object.values(capabilityEvidenceLabelValues).filter(
      (label) => !publicFixtureLabelValues.includes(label),
    );
    expect(privateLocalEvidenceLabelValues).toEqual(currentPrivateLabelVocabulary);

    for (const label of privateLocalEvidenceLabelValues) {
      await expect(
        repositoryWithAuthorizedStub().recordCapabilityEvidence(
          localActor,
          publicFixtureEvidenceInput({ evidenceLabels: [label] }),
        ),
      ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
    }
  });

  it("rejects source/kind and source/label vocabulary mismatches before persistence", async () => {
    const mismatchedInputs = [
      publicFixtureEvidenceInput({
        evidenceKind: engineCapabilityEvidenceKindValues.localCorpusSidecar,
      }),
      publicFixtureEvidenceInput({
        evidenceKind: engineCapabilityEvidenceKindValues.engineMarkerCount,
      }),
      publicFixtureEvidenceInput({
        evidenceLabels: [capabilityEvidenceLabelValues.localCorpusMarkerEvidence],
      }),
      publicFixtureEvidenceInput({
        evidenceLabels: [capabilityEvidenceLabelValues.localEngineMarkerCount],
      }),
      privateLocalAggregateEvidenceInput({
        evidenceKind: engineCapabilityEvidenceKindValues.adapterMatrix,
      }),
      privateLocalAggregateEvidenceInput({
        evidenceKind: engineCapabilityEvidenceKindValues.keyValidation,
      }),
      privateLocalAggregateEvidenceInput({
        evidenceLabels: [capabilityEvidenceLabelValues.adapterCapabilityMatrix],
      }),
      privateLocalAggregateEvidenceInput({
        evidenceLabels: [capabilityEvidenceLabelValues.publicFixtureMatrix],
      }),
      privateLocalAggregateEvidenceInput({
        evidenceLabels: [capabilityEvidenceLabelValues.publicFixtureKeyValidation],
      }),
    ];

    for (const input of mismatchedInputs) {
      await expect(
        repositoryWithAuthorizedStub().recordCapabilityEvidence(localActor, input),
      ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
    }
  });
});
