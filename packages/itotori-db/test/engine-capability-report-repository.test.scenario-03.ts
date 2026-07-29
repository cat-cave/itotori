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

describe("EngineCapabilityReportRepository", () => {
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
