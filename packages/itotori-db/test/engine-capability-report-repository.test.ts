import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  type AdapterCapabilityMatrixRecord,
  capabilityLevelValues,
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

describe("EngineCapabilityReportRepository", () => {
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
