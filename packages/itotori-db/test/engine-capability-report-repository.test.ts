import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  type AdapterCapabilityMatrixRecord,
  type CapabilityEvidenceInput,
  capabilityEvidenceLabelValues,
  capabilityLevelValues,
  engineCapabilityEvidenceKindValues,
  engineCapabilityEvidenceSourceValues,
  engineCapabilityEvidenceStatusValues,
  EngineCapabilityReportRepository,
  EngineCapabilityReportShapeError,
} from "../src/index.js";
import { isolatedMigratedContext } from "./db-test-context.js";

// KAIFUU-053 db-side coverage. The CHECK constraint declared in
// `migrations/0028_engine_capability_reports.sql` is asserted to reject
// each mismatched shape; the repository acts as the application-side
// guard before SQL is reached. `bootstrapLocalUser` (run by `migrate`)
// already grants `local-user` every permission, so no per-test grant is
// needed.

const localActor = { userId: "local-user" } as const;

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
  it("rejects leakage-shaped public and private evidence before persistence", async () => {
    const sourceInputs = [publicFixtureEvidenceInput, privateLocalAggregateEvidenceInput];
    const leakageCases: Record<string, unknown>[] = [
      { adapterId: "/tmp/private/kaifuu" },
      { schemaVersion: "catalog.rawText.v0.1" },
      { aggregateCounts: { pathHash_abcdefabcdefabcdefabcdefabcdefab: 1 } },
      { evidenceLabels: ["rawText"] },
      { limitations: ["found in /home/example/private/Game.rpgmvp"] },
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

  it("rejects public fixture ids with scan-entry leakage before persistence", async () => {
    await expect(
      repositoryWithAuthorizedStub().recordCapabilityEvidence(
        localActor,
        publicFixtureEvidenceInput({ publicFixtureId: "localScanEntryId_123" }),
      ),
    ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("EngineCapabilityReportRepository", () => {
  it("upserts a full matrix and round-trips through readMatrix", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new EngineCapabilityReportRepository(context.db);
      const matrix: AdapterCapabilityMatrixRecord = {
        adapterId: "kaifuu.fixture",
        identify: { kind: "supported" },
        inventory: { kind: "supported" },
        extract: { kind: "partial", limitations: ["only some surfaces"] },
        patch: { kind: "unsupported", reason: "no patch path yet" },
      };
      const rows = await repo.writeMatrix(localActor, matrix);
      expect(rows.length).toBe(4);
      const round = await repo.readMatrix("kaifuu.fixture");
      expect(round).toEqual(matrix);
    } finally {
      await context.close();
    }
  });

  it("strict gate: isAdapterUsable rejects partial / unsupported at the same level", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new EngineCapabilityReportRepository(context.db);
      await repo.writeMatrix(localActor, {
        adapterId: "kaifuu.partial_extract",
        identify: { kind: "supported" },
        inventory: { kind: "supported" },
        extract: { kind: "partial", limitations: ["only text surfaces"] },
        patch: { kind: "unsupported", reason: "no" },
      });
      expect(await repo.isAdapterUsable("kaifuu.partial_extract", "identify")).toBe(true);
      expect(await repo.isAdapterUsable("kaifuu.partial_extract", "inventory")).toBe(true);
      expect(await repo.isAdapterUsable("kaifuu.partial_extract", "extract")).toBe(false);
      expect(await repo.isAdapterUsable("kaifuu.partial_extract", "patch")).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("adaptersSupporting returns only adapters that are Supported at a level", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new EngineCapabilityReportRepository(context.db);
      await repo.writeMatrix(localActor, {
        adapterId: "kaifuu.identify_only",
        identify: { kind: "supported" },
        inventory: { kind: "unsupported", reason: "detector-only fixture" },
        extract: { kind: "unsupported", reason: "detector-only fixture" },
        patch: { kind: "unsupported", reason: "detector-only fixture" },
      });
      await repo.writeMatrix(localActor, fullSupportedMatrix("kaifuu.full"));
      const identify = await repo.adaptersSupporting(capabilityLevelValues.identify);
      expect(identify).toEqual(["kaifuu.full", "kaifuu.identify_only"]);
      const extract = await repo.adaptersSupporting(capabilityLevelValues.extract);
      expect(extract).toEqual(["kaifuu.full"]);
    } finally {
      await context.close();
    }
  });

  it("re-upsert overwrites the prior row instead of duplicating per (adapter, level)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new EngineCapabilityReportRepository(context.db);
      await repo.writeMatrix(localActor, fullSupportedMatrix("kaifuu.x"));
      await repo.writeMatrix(localActor, {
        adapterId: "kaifuu.x",
        identify: { kind: "supported" },
        inventory: { kind: "supported" },
        extract: { kind: "partial", limitations: ["narrower than before"] },
        patch: { kind: "unsupported", reason: "regressed" },
      });
      const round = await repo.readMatrix("kaifuu.x");
      expect(round?.extract).toEqual({
        kind: "partial",
        limitations: ["narrower than before"],
      });
      expect(round?.patch).toEqual({ kind: "unsupported", reason: "regressed" });
    } finally {
      await context.close();
    }
  });

  it("attaches public fixture and private-local aggregate evidence to the same adapter separately", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new EngineCapabilityReportRepository(context.db);
      await repo.writeMatrix(localActor, {
        adapterId: "kaifuu.rpg_maker_mv_mz",
        identify: { kind: "supported" },
        inventory: { kind: "partial", limitations: ["fixture inventory surfaces only"] },
        extract: { kind: "unsupported", reason: "public fixture does not prove extraction" },
        patch: { kind: "unsupported", reason: "public fixture does not prove patching" },
      });

      const publicEvidence = await repo.recordCapabilityEvidence(localActor, {
        adapterId: "kaifuu.rpg_maker_mv_mz",
        level: capabilityLevelValues.identify,
        evidenceSource: engineCapabilityEvidenceSourceValues.publicFixture,
        evidenceKind: engineCapabilityEvidenceKindValues.adapterMatrix,
        schemaVersion: "catalog.capability_evidence.v0.1",
        status: engineCapabilityEvidenceStatusValues.present,
        aggregateCounts: { fixture_rows: 4 },
        evidenceLabels: [
          capabilityEvidenceLabelValues.adapterCapabilityMatrix,
          capabilityEvidenceLabelValues.publicFixtureMatrix,
        ],
        limitations: ["fixture support matrix only"],
        publicFixtureId: "rpg-maker-mv-mz-key-validation-success-v0.1",
      });
      const privateEvidence = await repo.recordCapabilityEvidence(localActor, {
        adapterId: "kaifuu.rpg_maker_mv_mz",
        level: capabilityLevelValues.identify,
        evidenceSource: engineCapabilityEvidenceSourceValues.privateLocalAggregate,
        evidenceKind: engineCapabilityEvidenceKindValues.localCorpusSidecar,
        schemaVersion: "catalog.local_corpus_engine_evidence.v0.1",
        status: engineCapabilityEvidenceStatusValues.partial,
        aggregateCounts: {
          marker_kinds: 3,
          encrypted_asset_extensions: 2,
          file_kind_counts: 9,
        },
        evidenceLabels: [
          capabilityEvidenceLabelValues.localCorpusMarkerEvidence,
          capabilityEvidenceLabelValues.encryptedAssetExtension,
          capabilityEvidenceLabelValues.systemJsonLayout,
        ],
        limitations: ["aggregate marker evidence only; no adapter execution claimed"],
      });

      const readiness = await repo.readCapabilityReadiness("kaifuu.rpg_maker_mv_mz");
      expect(readiness?.matrix.extract).toEqual({
        kind: "unsupported",
        reason: "public fixture does not prove extraction",
      });
      expect(readiness?.evidenceByLevel.identify.publicFixture).toMatchObject([
        {
          engineCapabilityEvidenceId: publicEvidence.engineCapabilityEvidenceId,
          evidenceSource: engineCapabilityEvidenceSourceValues.publicFixture,
          publicFixtureId: "rpg-maker-mv-mz-key-validation-success-v0.1",
        },
      ]);
      expect(readiness?.evidenceByLevel.identify.privateLocalAggregate).toMatchObject([
        {
          engineCapabilityEvidenceId: privateEvidence.engineCapabilityEvidenceId,
          evidenceSource: engineCapabilityEvidenceSourceValues.privateLocalAggregate,
          publicFixtureId: null,
          aggregateCounts: {
            marker_kinds: 3,
            encrypted_asset_extensions: 2,
            file_kind_counts: 9,
          },
        },
      ]);

      const listed = await repo.listMatricesWithEvidence();
      expect(listed.map((entry) => entry.adapterId)).toContain("kaifuu.rpg_maker_mv_mz");
      const listedMvMz = listed.find((entry) => entry.adapterId === "kaifuu.rpg_maker_mv_mz");
      expect(listedMvMz?.evidenceByLevel.identify.publicFixture).toHaveLength(1);
      expect(listedMvMz?.evidenceByLevel.identify.privateLocalAggregate).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it("round-trips DB-approved mapped MV/MZ local sidecar evidence input", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new EngineCapabilityReportRepository(context.db);
      await repo.writeMatrix(localActor, {
        adapterId: "kaifuu.rpg-maker-mv-mz",
        identify: { kind: "supported" },
        inventory: { kind: "unsupported", reason: "public fixture does not prove inventory" },
        extract: { kind: "unsupported", reason: "public fixture does not prove extraction" },
        patch: { kind: "unsupported", reason: "public fixture does not prove patching" },
      });

      const input = {
        adapterId: "kaifuu.rpg-maker-mv-mz",
        level: capabilityLevelValues.identify,
        evidenceSource: engineCapabilityEvidenceSourceValues.privateLocalAggregate,
        evidenceKind: engineCapabilityEvidenceKindValues.localCorpusSidecar,
        schemaVersion: "catalog.capability_evidence_input.v0.1",
        status: engineCapabilityEvidenceStatusValues.partial,
        aggregateCounts: {
          local_extension_count: 5,
          local_file_kind_count: 4,
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
      } satisfies CapabilityEvidenceInput;

      const row = await repo.recordCapabilityEvidence(localActor, input);
      expect(row).toMatchObject(input);

      const readiness = await repo.readCapabilityReadiness("kaifuu.rpg-maker-mv-mz");
      expect(readiness?.matrix.extract).toEqual({
        kind: "unsupported",
        reason: "public fixture does not prove extraction",
      });
      expect(readiness?.matrix.patch).toEqual({
        kind: "unsupported",
        reason: "public fixture does not prove patching",
      });
      expect(readiness?.evidenceByLevel.identify.privateLocalAggregate).toMatchObject([
        {
          engineCapabilityEvidenceId: row.engineCapabilityEvidenceId,
          aggregateCounts: input.aggregateCounts,
          evidenceLabels: input.evidenceLabels,
          publicFixtureId: null,
        },
      ]);

      const serialized = JSON.stringify(input);
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
    } finally {
      await context.close();
    }
  });

  it("private-local aggregate evidence cannot upgrade unsupported matrix support", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new EngineCapabilityReportRepository(context.db);
      await repo.writeMatrix(localActor, {
        adapterId: "kaifuu.mv_mz.aggregate_only",
        identify: { kind: "unsupported", reason: "no public adapter fixture support" },
        inventory: { kind: "unsupported", reason: "no public adapter fixture support" },
        extract: { kind: "unsupported", reason: "no public adapter fixture support" },
        patch: { kind: "unsupported", reason: "no public adapter fixture support" },
      });
      await repo.recordCapabilityEvidence(localActor, {
        adapterId: "kaifuu.mv_mz.aggregate_only",
        level: capabilityLevelValues.identify,
        evidenceSource: engineCapabilityEvidenceSourceValues.privateLocalAggregate,
        evidenceKind: engineCapabilityEvidenceKindValues.localCorpusSidecar,
        schemaVersion: "catalog.local_corpus_engine_evidence.v0.1",
        status: engineCapabilityEvidenceStatusValues.present,
        aggregateCounts: { marker_kinds: 4, encrypted_asset_extensions: 2 },
        evidenceLabels: [
          capabilityEvidenceLabelValues.localEngineMarkerCount,
          capabilityEvidenceLabelValues.mvMzMarkerEvidence,
        ],
        limitations: ["aggregate marker evidence only; support matrix unchanged"],
      });

      expect(
        await repo.isAdapterUsable("kaifuu.mv_mz.aggregate_only", capabilityLevelValues.identify),
      ).toBe(false);
      expect(await repo.adaptersSupporting(capabilityLevelValues.identify)).not.toContain(
        "kaifuu.mv_mz.aggregate_only",
      );
      const readiness = await repo.readCapabilityReadiness("kaifuu.mv_mz.aggregate_only");
      expect(readiness?.matrix.identify).toEqual({
        kind: "unsupported",
        reason: "no public adapter fixture support",
      });
      expect(readiness?.evidenceByLevel.identify.privateLocalAggregate).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it("rejects private-local leakage-shaped evidence before persistence", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new EngineCapabilityReportRepository(context.db);
      const base = {
        adapterId: "kaifuu.rpg_maker_mv_mz",
        level: capabilityLevelValues.identify,
        evidenceSource: engineCapabilityEvidenceSourceValues.privateLocalAggregate,
        evidenceKind: engineCapabilityEvidenceKindValues.localCorpusSidecar,
        schemaVersion: "catalog.local_corpus_engine_evidence.v0.1",
        status: engineCapabilityEvidenceStatusValues.partial,
        aggregateCounts: { marker_kinds: 1 },
        evidenceLabels: [capabilityEvidenceLabelValues.localCorpusMarkerEvidence],
        limitations: ["aggregate marker evidence only"],
      } as const;

      await expect(
        repo.recordCapabilityEvidence(localActor, {
          ...base,
          limitations: ["found in /home/example/private/Game.rpgmvp"],
        }),
      ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
      await expect(
        repo.recordCapabilityEvidence(localActor, {
          ...base,
          limitations: ["SECRET_KEY was present in rawText"],
        }),
      ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
      await expect(
        repo.recordCapabilityEvidence(localActor, {
          ...base,
          aggregateCounts: { pathHash_abcdefabcdefabcdefabcdefabcdefab: 1 },
        }),
      ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
      await expect(
        repo.recordCapabilityEvidence(localActor, {
          ...base,
          rawSignals: [{ blob: "marker" }],
        } as never),
      ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
    } finally {
      await context.close();
    }
  });

  it("repository rejects a partial status with empty limitations before SQL is reached", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new EngineCapabilityReportRepository(context.db);
      await expect(
        repo.writeMatrix(localActor, {
          adapterId: "kaifuu.bad",
          identify: { kind: "supported" },
          inventory: { kind: "partial", limitations: [] },
          extract: { kind: "supported" },
          patch: { kind: "supported" },
        }),
      ).rejects.toBeInstanceOf(EngineCapabilityReportShapeError);
    } finally {
      await context.close();
    }
  });

  it("Postgres CHECK constraint rejects supported rows with a non-null reason", async () => {
    const context = await isolatedMigratedContext();
    try {
      await expect(
        context.db.execute(sql`
          insert into itotori_engine_capability_reports (
            engine_capability_report_id,
            adapter_id,
            level,
            status_kind,
            limitations,
            reason
          ) values (
            'eng-cap-test-1',
            'kaifuu.bad',
            'identify'::capability_level_enum,
            'supported'::capability_level_status_kind,
            '[]'::jsonb,
            'should not be present'
          )
        `),
      ).rejects.toBeDefined();
    } finally {
      await context.close();
    }
  });

  it("Postgres CHECK constraint rejects unsupported rows without a reason", async () => {
    const context = await isolatedMigratedContext();
    try {
      await expect(
        context.db.execute(sql`
          insert into itotori_engine_capability_reports (
            engine_capability_report_id,
            adapter_id,
            level,
            status_kind,
            limitations,
            reason
          ) values (
            'eng-cap-test-2',
            'kaifuu.bad',
            'identify'::capability_level_enum,
            'unsupported'::capability_level_status_kind,
            '[]'::jsonb,
            null
          )
        `),
      ).rejects.toBeDefined();
    } finally {
      await context.close();
    }
  });

  it("Postgres CHECK constraint rejects partial rows with an empty limitations array", async () => {
    const context = await isolatedMigratedContext();
    try {
      await expect(
        context.db.execute(sql`
          insert into itotori_engine_capability_reports (
            engine_capability_report_id,
            adapter_id,
            level,
            status_kind,
            limitations,
            reason
          ) values (
            'eng-cap-test-3',
            'kaifuu.bad',
            'identify'::capability_level_enum,
            'partial'::capability_level_status_kind,
            '[]'::jsonb,
            null
          )
        `),
      ).rejects.toBeDefined();
    } finally {
      await context.close();
    }
  });
});
