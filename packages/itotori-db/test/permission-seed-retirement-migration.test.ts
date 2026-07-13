import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "./db-test-context.js";

const retirementMigrationSql = readFileSync(
  new URL("../migrations/0095_retire_reviewer_permission_seed.sql", import.meta.url),
  "utf8",
);

describe("permission-seed retirement migration", () => {
  it("moves deterministic reviewer grants and invitations without colliding with a custom Contributor set", async () => {
    const context = await isolatedMigratedContext();
    try {
      const accountId = "account-permission-retirement";
      const oldSeedId = `permission-set-${accountId}-reviewer`;
      const contributorSeedId = `permission-set-${accountId}-contributor`;
      const customSetId = "custom-contributor-label";
      const customReviewerLikeSetId = "permission-set-custom-reviewer";

      await context.db.execute(sql`
        insert into itotori_auth_accounts (account_id, slug, name)
        values (${accountId}, 'permission-retirement', 'Permission retirement')
      `);
      await context.db.execute(sql`
        insert into itotori_auth_principals (principal_id, principal_kind)
        values ('principal-permission-retirement', 'human_user')
      `);
      await context.db.execute(sql`
        insert into itotori_auth_permission_sets (permission_set_id, account_id, name)
        values
          (${oldSeedId}, ${accountId}, 'Reviewer'),
          (${customSetId}, ${accountId}, 'Contributor'),
          (${customReviewerLikeSetId}, ${accountId}, 'Custom reviewer label')
      `);
      await context.db.execute(sql`
        insert into itotori_auth_permission_set_permissions (permission_set_id, permission)
        values
          (${oldSeedId}, 'draft.write'),
          (${oldSeedId}, 'queue.read'),
          (${oldSeedId}, 'queue.manage'),
          (${oldSeedId}, 'style_guide.approve'),
          (${customSetId}, 'queue.manage')
      `);
      await context.db.execute(sql`
        insert into itotori_auth_principal_permission_set_grants (
          principal_id,
          permission_set_id
        )
        values ('principal-permission-retirement', ${oldSeedId})
      `);
      await context.db.execute(sql`
        insert into itotori_auth_invitations (
          invitation_id,
          account_id,
          email,
          initial_permission_set_ids,
          expires_at
        )
        values (
          'invitation-permission-retirement',
          ${accountId},
          'retirement@example.test',
          ${JSON.stringify([customSetId, oldSeedId])}::jsonb,
          now() + interval '1 day'
        )
      `);

      await context.db.execute(sql.raw(retirementMigrationSql));

      const contributorPermissions = await context.db.execute(sql`
        select permission
        from itotori_auth_permission_set_permissions
        where permission_set_id = ${contributorSeedId}
        order by permission
      `);
      expect(contributorPermissions.rows).toEqual([
        { permission: "catalog.read" },
        { permission: "draft.write" },
        { permission: "feedback.import" },
        { permission: "style_guide.approve" },
      ]);

      const contributorSet = await context.db.execute(sql`
        select name
        from itotori_auth_permission_sets
        where permission_set_id = ${contributorSeedId}
      `);
      expect(contributorSet.rows).toEqual([
        { name: `Contributor (migrated: ${contributorSeedId})` },
      ]);

      const grants = await context.db.execute(sql`
        select permission_set_id
        from itotori_auth_principal_permission_set_grants
        where principal_id = 'principal-permission-retirement'
      `);
      expect(grants.rows).toEqual([{ permission_set_id: contributorSeedId }]);

      const invitation = await context.db.execute(sql`
        select initial_permission_set_ids
        from itotori_auth_invitations
        where invitation_id = 'invitation-permission-retirement'
      `);
      expect(invitation.rows).toEqual([
        { initial_permission_set_ids: [customSetId, contributorSeedId] },
      ]);

      const remainingSets = await context.db.execute(sql`
        select permission_set_id, name
        from itotori_auth_permission_sets
        where permission_set_id in (${oldSeedId}, ${customSetId}, ${customReviewerLikeSetId})
        order by permission_set_id
      `);
      expect(remainingSets.rows).toEqual([
        { permission_set_id: customSetId, name: "Contributor" },
        { permission_set_id: customReviewerLikeSetId, name: "Custom reviewer label" },
      ]);

      const customPermissions = await context.db.execute(sql`
        select permission
        from itotori_auth_permission_set_permissions
        where permission_set_id = ${customSetId}
      `);
      expect(customPermissions.rows).toEqual([{ permission: "queue.manage" }]);
    } finally {
      await context.close();
    }
  });
});
