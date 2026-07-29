import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { isolatedMigratedContext } from "./db-test-context.js";

// db-side capability-leveled engine detector coverage. The CHECK
// constraint declared in
// `migrations/0028_engine_capability_reports.sql` is asserted to reject
// each mismatched shape; the repository acts as the application-side
// guard before SQL is reached. `bootstrapLocalUser` (run by `migrate`)
// already grants `local-user` every permission, so no per-test grant is
// needed.

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
