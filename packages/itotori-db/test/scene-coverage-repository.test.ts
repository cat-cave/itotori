// play-mark-validated — scene localization coverage repository tests.
//
// Stands up an isolated migrated schema, seeds project + locale branch, and
// proves: setCoverage UPSERTs + persists, loadCoverageForBranch returns the
// durable state, and queue.manage / queue.read denials refuse at the gate.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriSceneCoverageRepository,
  SceneCoverageRepositoryError,
  sceneLocalizationCoverageStateValues,
} from "../src/repositories/scene-coverage-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };

const projectId = "project-play-markvalid";
const localeBranchId = "locale-branch-play-markvalid";
const otherBranchId = "locale-branch-play-markvalid-other";

async function seedScope(context: Awaited<ReturnType<typeof isolatedMigratedContext>>) {
  await context.db.execute(sql`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-play-markvalid', 'Workspace play-markvalid')
    on conflict (workspace_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    )
    values (
      ${projectId}, 'workspace-play-markvalid', 'play-markvalid',
      'Play Markvalid Project', 'ja-JP', 'imported'
    )
    on conflict (project_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values ('source-revision-play-markvalid', ${projectId}, 'bridge_revision', 'v1')
    on conflict (source_revision_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    )
    values (
      'source-bundle-play-markvalid', ${projectId}, 'source-revision-play-markvalid',
      'bridge-play-markvalid', '0.2.0', 'hash:play-markvalid', 'ja-JP',
      'fixture-extractor', '1.0.0', 0, 0
    )
    on conflict (source_bundle_id) do nothing
  `);
  for (const branchId of [localeBranchId, otherBranchId]) {
    await context.db.execute(sql`
      insert into itotori_locale_branches (
        locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
      )
      values (
        ${branchId}, ${projectId}, 'source-bundle-play-markvalid',
        'en-US', ${branchId}, 'active'
      )
      on conflict (locale_branch_id) do nothing
    `);
  }
}

describe("ItotoriSceneCoverageRepository", () => {
  it("setCoverage persists validated state and loadCoverageForBranch returns it", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriSceneCoverageRepository(context.db);

      const written = await repo.setCoverage(localActor, {
        projectId,
        localeBranchId,
        sceneId: "scene-opening",
        coverageState: sceneLocalizationCoverageStateValues.validated,
        updatedByUserId: localUserId,
        updatedAt: new Date("2026-07-08T12:00:00.000Z"),
      });

      expect(written.sceneId).toBe("scene-opening");
      expect(written.coverageState).toBe("validated");
      expect(written.projectId).toBe(projectId);
      expect(written.localeBranchId).toBe(localeBranchId);

      const rows = await repo.loadCoverageForBranch(localActor, { projectId, localeBranchId });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.coverageState).toBe("validated");
      expect(rows[0]?.sceneId).toBe("scene-opening");
    } finally {
      await context.close();
    }
  });

  it("setCoverage UPSERTs the same scene without duplicating rows", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriSceneCoverageRepository(context.db);

      await repo.setCoverage(localActor, {
        projectId,
        localeBranchId,
        sceneId: "scene-a",
        coverageState: sceneLocalizationCoverageStateValues.needsCheck,
        updatedByUserId: localUserId,
      });
      const updated = await repo.setCoverage(localActor, {
        projectId,
        localeBranchId,
        sceneId: "scene-a",
        coverageState: sceneLocalizationCoverageStateValues.flagged,
        updatedByUserId: localUserId,
      });

      expect(updated.coverageState).toBe("flagged");
      const rows = await repo.loadCoverageForBranch(localActor, { projectId, localeBranchId });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.coverageState).toBe("flagged");
    } finally {
      await context.close();
    }
  });

  it("loadCoverageForScene returns null when no row exists", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriSceneCoverageRepository(context.db);
      const missing = await repo.loadCoverageForScene(localActor, {
        projectId,
        localeBranchId,
        sceneId: "scene-never-marked",
      });
      expect(missing).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("scopes loadCoverageForBranch to the requested locale branch", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriSceneCoverageRepository(context.db);

      await repo.setCoverage(localActor, {
        projectId,
        localeBranchId,
        sceneId: "scene-en",
        coverageState: sceneLocalizationCoverageStateValues.validated,
        updatedByUserId: localUserId,
      });
      await repo.setCoverage(localActor, {
        projectId,
        localeBranchId: otherBranchId,
        sceneId: "scene-other",
        coverageState: sceneLocalizationCoverageStateValues.flagged,
        updatedByUserId: localUserId,
      });

      const enRows = await repo.loadCoverageForBranch(localActor, { projectId, localeBranchId });
      expect(enRows.map((r) => r.sceneId)).toEqual(["scene-en"]);
    } finally {
      await context.close();
    }
  });

  it("setCoverage denies an actor missing queue.manage", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriSceneCoverageRepository(context.db);

      await expect(
        repo.setCoverage(deniedActor, {
          projectId,
          localeBranchId,
          sceneId: "scene-denied",
          coverageState: sceneLocalizationCoverageStateValues.validated,
          updatedByUserId: deniedActor.userId,
        }),
      ).rejects.toThrow(/queue\.manage|permission/i);
    } finally {
      await context.close();
    }
  });

  it("loadCoverageForBranch denies an actor missing queue.read", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriSceneCoverageRepository(context.db);

      await expect(
        repo.loadCoverageForBranch(deniedActor, { projectId, localeBranchId }),
      ).rejects.toThrow(/queue\.read|permission/i);
    } finally {
      await context.close();
    }
  });

  it("refuses an empty sceneId", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriSceneCoverageRepository(context.db);

      await expect(
        repo.setCoverage(localActor, {
          projectId,
          localeBranchId,
          sceneId: "   ",
          coverageState: sceneLocalizationCoverageStateValues.validated,
          updatedByUserId: localUserId,
        }),
      ).rejects.toBeInstanceOf(SceneCoverageRepositoryError);
    } finally {
      await context.close();
    }
  });
});
