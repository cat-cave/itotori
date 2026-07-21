import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { describe, expect, it } from "vitest";
import { bootstrapLocalUser, localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriDraftJobRepository } from "../src/repositories/draft-job-repository.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import { draftJobFixtureInput } from "./draft-job-fixtures.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

// wholegame-localize-project-provisioning (issue #60) — the whole-game
// `localize` driver persists draft jobs (FK -> projects +
// locale_branches) and pass-ledger rows (FK -> ... + source_revisions) keyed on
// its config run-identity, but never provisioned those parent rows, so the
// first live draft-job insert violated the FK. `ensureRunProjectScope` fixes
// that by idempotently upserting the parent graph the run-identity implies.
describe("ItotoriProjectRepository.ensureRunProjectScope", () => {
  const scope = {
    projectId: "run-scope-project-60",
    engineFamily: "synthetic_fixture",
    sourceRoot: "/workspace/source",
    buildRoot: "/workspace/build",
    extractProfile: { adapter: "fixture" },
    localeBranchId: "run-scope-branch-60",
    sourceRevisionId: "run-scope-rev-60",
    targetLocale: "en-US",
    sourceLocale: "ja-JP",
  } as const;

  async function countOf(
    pool: { query: (text: string) => Promise<{ rows: unknown[] }> },
    table: string,
    column: string,
    value: string,
  ): Promise<number> {
    const result = await pool.query(
      `select count(*)::int as n from ${table} where ${column} = '${value}'`,
    );
    return (result.rows[0] as { n: number }).n;
  }

  it("provisions the project/locale-branch/source-revision graph so a draft-job insert no longer violates the FK", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      const projectRepo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);

      // Before: the parent rows the FK requires do not exist.
      expect(await countOf(context.pool, "itotori_projects", "project_id", scope.projectId)).toBe(
        0,
      );

      await projectRepo.ensureRunProjectScope(localActor, scope);

      // The run identity is now fully provisioned, in FK order.
      expect(await countOf(context.pool, "itotori_projects", "project_id", scope.projectId)).toBe(
        1,
      );
      expect(
        await countOf(
          context.pool,
          "itotori_locale_branches",
          "locale_branch_id",
          scope.localeBranchId,
        ),
      ).toBe(1);
      expect(
        await countOf(
          context.pool,
          "itotori_source_revisions",
          "source_revision_id",
          scope.sourceRevisionId,
        ),
      ).toBe(1);
      // The locale branch's restrict FK requires a source bundle to exist.
      expect(
        await countOf(context.pool, "itotori_source_bundles", "project_id", scope.projectId),
      ).toBe(1);

      // The draft-job insert that used to fail the FK now persists.
      const draftJobs = new ItotoriDraftJobRepository(context.db);
      const job = await draftJobs.createDraftJob(
        localActor,
        draftJobFixtureInput({
          projectId: scope.projectId,
          localeBranchId: scope.localeBranchId,
          sourceUnitIds: ["run-scope-unit-1"],
        }),
      );
      expect(job.projectId).toBe(scope.projectId);
      expect(job.localeBranchId).toBe(scope.localeBranchId);
      expect(await countOf(context.pool, "itotori_draft_jobs", "project_id", scope.projectId)).toBe(
        1,
      );
    } finally {
      await context.close();
    }
  });

  it("is idempotent — re-running the same run-scope neither throws nor duplicates rows", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      const projectRepo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);

      await projectRepo.ensureRunProjectScope(localActor, scope);
      await projectRepo.ensureRunProjectScope(localActor, scope);
      await projectRepo.ensureRunProjectScope(localActor, scope);

      expect(await countOf(context.pool, "itotori_projects", "project_id", scope.projectId)).toBe(
        1,
      );
      expect(
        await countOf(
          context.pool,
          "itotori_locale_branches",
          "locale_branch_id",
          scope.localeBranchId,
        ),
      ).toBe(1);
      expect(
        await countOf(
          context.pool,
          "itotori_source_revisions",
          "source_revision_id",
          scope.sourceRevisionId,
        ),
      ).toBe(1);
      expect(
        await countOf(context.pool, "itotori_source_bundles", "project_id", scope.projectId),
      ).toBe(1);
    } finally {
      await context.close();
    }
  });
});
