import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriDraftJobRepository } from "../src/repositories/draft-job-repository.js";
import {
  draftJobFixtureInput,
  provisionDraftJobFixtureProject,
  retryableDraftJobFixture,
} from "./draft-job-fixtures.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

/**
 * Walks the error chain looking for a Postgres error code (DatabaseError.code).
 * node-postgres errors expose `.code`; drizzle wraps the raw error in a higher-
 * level Error and stashes the original at `.cause`.
 */
function pgErrorCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") {
        return code;
      }
    }
    if (typeof current === "object" && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return undefined;
}

describe.skipIf(!process.env.DATABASE_URL)("draft job migration drift", () => {
  it("registers expected foreign keys to projects, locale branches, and draft jobs", async () => {
    const context = await isolatedMigratedContext();
    try {
      const rows = await context.db.execute(sql`
        select
          c.relname as table_name,
          con.conname as constraint_name,
          pg_get_constraintdef(con.oid) as constraint_definition
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema()
          and c.relname in ('itotori_draft_jobs', 'itotori_draft_job_attempts')
          and con.contype = 'f'
        order by c.relname, con.conname
      `);

      const definitions = rows.rows.map(
        (row) => `${String(row.table_name)}: ${String(row.constraint_definition)}`,
      );

      expect(
        definitions.some(
          (def) =>
            def.startsWith("itotori_draft_jobs:") && def.includes("REFERENCES itotori_projects"),
        ),
      ).toBe(true);
      expect(
        definitions.some(
          (def) =>
            def.startsWith("itotori_draft_jobs:") &&
            def.includes("REFERENCES itotori_locale_branches"),
        ),
      ).toBe(true);
      expect(
        definitions.some(
          (def) =>
            def.startsWith("itotori_draft_job_attempts:") &&
            def.includes("REFERENCES itotori_draft_jobs"),
        ),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("status check constraint enforces only the six draft_jobs status values", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const repo = new ItotoriDraftJobRepository(context.db);
      const job = await repo.createDraftJob(localActor, draftJobFixtureInput());

      let captured: unknown;
      try {
        await context.pool.query(
          `update itotori_draft_jobs set status = $1 where draft_job_id = $2`,
          ["not-a-real-status", job.draftJobId],
        );
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23514");

      for (const validStatus of [
        "queued",
        "running",
        "succeeded",
        "failed",
        "retryable",
        "cancelled",
      ]) {
        await context.pool.query(
          `update itotori_draft_jobs set status = $1 where draft_job_id = $2`,
          [validStatus, job.draftJobId],
        );
      }
    } finally {
      await context.close();
    }
  });

  it("attempt status check constraint enforces only the five attempt status values", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const { attempts } = await retryableDraftJobFixture(context.db, localActor, {
        sourceUnitIds: ["unit-draft-1"],
      });
      const attempt = attempts[0];
      if (attempt === undefined) {
        throw new Error("retryable fixture must yield an attempt");
      }

      let captured: unknown;
      try {
        await context.pool.query(
          `update itotori_draft_job_attempts set status = $1 where draft_job_attempt_id = $2`,
          ["queued", attempt.draftJobAttemptId],
        );
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23514");

      for (const validStatus of ["running", "succeeded", "failed", "retryable", "cancelled"]) {
        await context.pool.query(
          `update itotori_draft_job_attempts set status = $1 where draft_job_attempt_id = $2`,
          [validStatus, attempt.draftJobAttemptId],
        );
      }
    } finally {
      await context.close();
    }
  });

  it("a retryable parent has at least one retryable attempt (retry-state semantics)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const { job, attempts } = await retryableDraftJobFixture(context.db, localActor, {
        sourceUnitIds: ["unit-draft-1", "unit-draft-2"],
      });

      expect(job.status).toBe("retryable");
      const retryableAttempts = attempts.filter((attempt) => attempt.status === "retryable");
      expect(retryableAttempts.length).toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
    }
  });

  it("the unique (draft_job_id, attempt_index) index prevents duplicate attempt indices", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const repo = new ItotoriDraftJobRepository(context.db);
      const job = await repo.createDraftJob(
        localActor,
        draftJobFixtureInput({ sourceUnitIds: ["unit-draft-1"] }),
      );

      await repo.recordAttempt(localActor, job.draftJobId, {
        attemptIndex: 1,
        providerRunId: "provider-run-a",
        startedAt: new Date("2026-06-23T13:00:00Z"),
      });

      let captured: unknown;
      try {
        await repo.recordAttempt(localActor, job.draftJobId, {
          attemptIndex: 1,
          providerRunId: "provider-run-b",
          startedAt: new Date("2026-06-23T13:01:00Z"),
        });
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23505");
    } finally {
      await context.close();
    }
  });

  it("bridge_unit_ids must be a non-empty text array", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      let captured: unknown;
      try {
        await context.pool.query(
          `insert into itotori_draft_jobs (
              draft_job_id,
              project_id,
              locale_branch_id,
              bridge_unit_ids,
              style_guide_version,
              glossary_version,
              status
            ) values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            "draft-job-empty",
            "project-draft-job",
            "locale-draft-job",
            [],
            "style-guide-v1",
            "glossary-v1",
            "queued",
          ],
        );
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23514");
    } finally {
      await context.close();
    }
  });
});
