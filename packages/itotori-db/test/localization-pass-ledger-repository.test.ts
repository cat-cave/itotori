// itotori-multipass-pass-ledger — DB-backed localization pass ledger tests.
//
// Each test stands up an isolated migrated schema, seeds the project / source
// bundle / locale branch / source revision the ledger row links to, and
// exercises a distinct invariant: deterministic per-branch pass numbering on
// `recordPass`, latest-pass read-back, full branch history read-back, and the
// `draft.write` permission gate on every one of the three gated methods (a
// denied actor is rejected before touching the ledger).

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriLocalizationPassLedgerRepository,
  type RecordLocalizationPassInput,
} from "../src/repositories/localization-pass-ledger-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };

const projectId = "project-pass-ledger";
const localeBranchId = "locale-branch-pass-ledger";
const otherLocaleBranchId = "locale-branch-pass-ledger-fr";
const sourceRevisionId = "source-revision-pass-ledger";

async function seedScope(context: Awaited<ReturnType<typeof isolatedMigratedContext>>) {
  await context.db.execute(sql`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-pass-ledger', 'Workspace Pass Ledger')
    on conflict (workspace_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    )
    values (${projectId}, 'workspace-pass-ledger', 'passledger', 'Pass Ledger Project', 'ja-JP', 'imported')
    on conflict (project_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values (${sourceRevisionId}, ${projectId}, 'bridge_revision', 'passledger-v1')
    on conflict (source_revision_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    )
    values (
      'source-bundle-pass-ledger', ${projectId}, ${sourceRevisionId}, 'bridge-pass-ledger',
      '0.2.0', 'hash:passledger', 'ja-JP', 'fixture-extractor', '1.0.0', 0, 0
    )
    on conflict (source_bundle_id) do nothing
  `);
  for (const branchId of [localeBranchId, otherLocaleBranchId]) {
    await context.db.execute(sql`
      insert into itotori_locale_branches (
        locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
      )
      values (
        ${branchId}, ${projectId}, 'source-bundle-pass-ledger', 'en-US', ${branchId}, 'active'
      )
      on conflict (locale_branch_id) do nothing
    `);
  }
}

function baseInput(
  overrides: Partial<RecordLocalizationPassInput> = {},
): RecordLocalizationPassInput {
  return {
    projectId,
    localeBranchId,
    sourceRevisionId,
    recordedAt: new Date("2026-07-06T00:00:00.000Z"),
    totalUsageCostUsd: 0.0123,
    zdrConfirmed: true,
    recordBody: { accepted: 12, flagged: 1 },
    ...overrides,
  };
}

describe("ItotoriLocalizationPassLedgerRepository", () => {
  it("recordPass assigns deterministic per-branch pass numbers + lineage", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriLocalizationPassLedgerRepository(context.db);

      const first = await repo.recordPass(localActor, baseInput());
      expect(first.passLedgerId).toMatch(/^localization-pass-/);
      expect(first.passNumber).toBe(1);
      expect(first.priorPassNumber).toBeUndefined();
      expect(first.totalUsageCostUsd).toBe(0.0123);
      expect(first.zdrConfirmed).toBe(true);
      expect(first.recordBody).toEqual({ accepted: 12, flagged: 1 });

      const second = await repo.recordPass(localActor, baseInput({ totalUsageCostUsd: 0.5 }));
      expect(second.passNumber).toBe(2);
      expect(second.priorPassNumber).toBe(1);

      const rows = await context.db.execute(sql`
        select count(*)::int as n from itotori_localization_pass_ledger
        where locale_branch_id = ${localeBranchId}
      `);
      expect(Number((rows.rows[0] as { n: number }).n)).toBe(2);
    } finally {
      await context.close();
    }
  });

  it("recordPass refuses a negative usage.cost before touching the ledger", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriLocalizationPassLedgerRepository(context.db);
      await expect(
        repo.recordPass(localActor, baseInput({ totalUsageCostUsd: -1 })),
      ).rejects.toMatchObject({ name: "LocalizationPassLedgerRepositoryError" });
    } finally {
      await context.close();
    }
  });

  it("loadLatestPass returns the highest-numbered pass for the branch", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriLocalizationPassLedgerRepository(context.db);
      expect(await repo.loadLatestPass(localActor, localeBranchId)).toBeUndefined();

      await repo.recordPass(localActor, baseInput());
      await repo.recordPass(localActor, baseInput({ totalUsageCostUsd: 0.9 }));

      const latest = await repo.loadLatestPass(localActor, localeBranchId);
      expect(latest?.passNumber).toBe(2);
      expect(latest?.totalUsageCostUsd).toBe(0.9);
    } finally {
      await context.close();
    }
  });

  it("loadPassesForBranch returns only that branch's passes in pass order", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriLocalizationPassLedgerRepository(context.db);
      await repo.recordPass(localActor, baseInput());
      await repo.recordPass(localActor, baseInput({ totalUsageCostUsd: 0.2 }));
      await repo.recordPass(localActor, baseInput({ localeBranchId: otherLocaleBranchId }));

      const here = await repo.loadPassesForBranch(localActor, localeBranchId);
      const other = await repo.loadPassesForBranch(localActor, otherLocaleBranchId);
      expect(here.map((pass) => pass.passNumber)).toEqual([1, 2]);
      expect(other.map((pass) => pass.passNumber)).toEqual([1]);
      expect(here.every((pass) => pass.localeBranchId === localeBranchId)).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("refuses every gated method without draft.write (a denied actor is rejected)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriLocalizationPassLedgerRepository(context.db);

      await expect(repo.recordPass(deniedActor, baseInput())).rejects.toMatchObject({
        name: "AuthorizationError",
      });
      await expect(repo.loadLatestPass(deniedActor, localeBranchId)).rejects.toMatchObject({
        name: "AuthorizationError",
      });
      await expect(repo.loadPassesForBranch(deniedActor, localeBranchId)).rejects.toMatchObject({
        name: "AuthorizationError",
      });

      const rows = await context.db.execute(sql`
        select count(*)::int as n from itotori_localization_pass_ledger
      `);
      expect(Number((rows.rows[0] as { n: number }).n)).toBe(0);
    } finally {
      await context.close();
    }
  });
});
