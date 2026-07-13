// auth-004-permission-set-model — DB-backed tests for the data-driven
// permission-set MODEL that replaces any role concept.
//
// A "role" is ONLY a permission_set: a named, editable DATA bundle of permission
// rows. These tests exercise the model against real Postgres: the crux proof
// that EDITING a granted set changes a principal's effective permissions
// (add -> gain, remove -> lose), the full CRUD (create / rename / add / remove /
// delete) with its audit trail, the delete-vs-grant safety semantics
// (deletion blocked while granted, so no principal loses authorization
// silently), and the least-privilege DATA seed sets. Nothing branches on a
// set/role NAME anywhere — resolution is purely by the permissions in the set.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  defaultPermissionSetId,
  defaultPermissionSetSeeds,
  localUserId,
  permissionValues,
  seedDefaultPermissionSets,
  type AuthorizationActor,
} from "../src/authorization.js";
import type { DatabaseContext } from "../src/connection.js";
import {
  ItotoriPrincipalRepository,
  ItotoriPrincipalRepositoryError,
} from "../src/repositories/principal-repository.js";
import {
  authAccountMemberships,
  authPermissionSetAuditEvents,
  authPrincipalPermissionSetGrants,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

/** Stand up an account + admin principal + target principal for a test. */
async function bootstrapAccountAndPrincipals(
  repo: ItotoriPrincipalRepository,
  db: DatabaseContext["db"],
): Promise<void> {
  await repo.createAccount(localActor, {
    accountId: "account-model",
    slug: "model",
    name: "Model Workspace",
  });
  await repo.createPrincipal(localActor, {
    kind: "human_user",
    principalId: "principal-admin",
    userId: "user-admin",
    displayName: "Admin",
  });
  await repo.createPrincipal(localActor, {
    kind: "human_user",
    principalId: "principal-target",
    userId: "user-target",
    displayName: "Target",
  });
  // The target's account context: a permission set is account-scoped and may
  // only be granted within an account the principal is a member of.
  await db.insert(authAccountMemberships).values({
    membershipId: "membership-target",
    accountId: "account-model",
    userId: "user-target",
  });
}

describe("permission-set model (auth-004)", () => {
  it("editing a GRANTED set changes the principal's effective permissions (add -> gain, remove -> lose)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await bootstrapAccountAndPrincipals(repo, context.db);

      // A set with a single permission, granted to the target.
      await repo.createPermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-x",
        accountId: "account-model",
        name: "Starter",
        permissions: [permissionValues.queueRead],
      });
      await repo.grantPermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-target",
        permissionSetId: "permission-set-x",
      });

      expect(await repo.resolvePrincipalPermissions(localActor, "principal-target")).toEqual([
        permissionValues.queueRead,
      ]);

      // ADD a permission to the granted set -> the principal GAINS it.
      await repo.addPermissionToSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-x",
        permission: permissionValues.draftWrite,
        reason: "grant drafting",
      });
      expect(await repo.resolvePrincipalPermissions(localActor, "principal-target")).toEqual(
        [permissionValues.draftWrite, permissionValues.queueRead].sort(),
      );

      // REMOVE the original permission -> the principal LOSES it.
      await repo.removePermissionFromSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-x",
        permission: permissionValues.queueRead,
        reason: "tighten scope",
      });
      expect(await repo.resolvePrincipalPermissions(localActor, "principal-target")).toEqual([
        permissionValues.draftWrite,
      ]);
    } finally {
      await context.close();
    }
  });

  it("records every set mutation in the permission-set audit trail", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await bootstrapAccountAndPrincipals(repo, context.db);

      await repo.createPermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-audited",
        accountId: "account-model",
        name: "Audited",
        permissions: [permissionValues.queueRead],
      });
      await repo.addPermissionToSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-audited",
        permission: permissionValues.draftWrite,
      });
      await repo.removePermissionFromSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-audited",
        permission: permissionValues.queueRead,
      });
      await repo.renamePermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-audited",
        name: "Renamed",
      });

      const auditRows = await context.db
        .select()
        .from(authPermissionSetAuditEvents)
        .where(eq(authPermissionSetAuditEvents.permissionSetId, "permission-set-audited"));
      const actions = auditRows.map((row) => row.action).sort();
      expect(actions).toEqual(
        ["set_created", "permission_added", "permission_removed", "set_renamed"].sort(),
      );
      // Every mutation is attributed to the acting principal.
      expect(auditRows.every((row) => row.actorPrincipalId === "principal-admin")).toBe(true);
      // add/remove capture which permission changed; the rename snapshots the new name.
      const added = auditRows.find((row) => row.action === "permission_added");
      expect(added?.permission).toBe(permissionValues.draftWrite);
      const renamed = auditRows.find((row) => row.action === "set_renamed");
      expect(renamed?.setName).toBe("Renamed");
    } finally {
      await context.close();
    }
  });

  it("BLOCKS deletion while the set is granted, then allows it once revoked (no silent authorization loss)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await bootstrapAccountAndPrincipals(repo, context.db);

      await repo.createPermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-del",
        accountId: "account-model",
        name: "Deletable",
        permissions: [permissionValues.catalogRead],
      });
      await repo.grantPermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-target",
        permissionSetId: "permission-set-del",
      });

      // Deleting while granted is refused — the principal keeps its authorization.
      await expect(
        repo.deletePermissionSet(localActor, {
          actorPrincipalId: "principal-admin",
          permissionSetId: "permission-set-del",
        }),
      ).rejects.toBeInstanceOf(ItotoriPrincipalRepositoryError);
      expect(await repo.resolvePrincipalPermissions(localActor, "principal-target")).toEqual([
        permissionValues.catalogRead,
      ]);

      // Explicitly revoke the grant, then deletion proceeds and is audited.
      await context.db
        .delete(authPrincipalPermissionSetGrants)
        .where(eq(authPrincipalPermissionSetGrants.permissionSetId, "permission-set-del"));
      await repo.deletePermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-del",
        reason: "retired",
      });

      // The deleted set is gone, the principal now has nothing, and the deletion
      // survives in the append-only audit trail.
      expect(await repo.resolvePrincipalPermissions(localActor, "principal-target")).toEqual([]);
      const deletedAudit = await context.db
        .select()
        .from(authPermissionSetAuditEvents)
        .where(eq(authPermissionSetAuditEvents.permissionSetId, "permission-set-del"));
      expect(deletedAudit.some((row) => row.action === "set_deleted")).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("editing a non-existent set is rejected", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await bootstrapAccountAndPrincipals(repo, context.db);
      await expect(
        repo.addPermissionToSet(localActor, {
          actorPrincipalId: "principal-admin",
          permissionSetId: "permission-set-missing",
          permission: permissionValues.queueRead,
        }),
      ).rejects.toBeInstanceOf(ItotoriPrincipalRepositoryError);
    } finally {
      await context.close();
    }
  });

  it("seeds the least-privilege default permission sets as editable DATA rows", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await bootstrapAccountAndPrincipals(repo, context.db);

      // Seeds are DATA, materialized for an account, not code branches.
      await seedDefaultPermissionSets(context.db, { accountId: "account-model" });
      // Idempotent.
      await seedDefaultPermissionSets(context.db, { accountId: "account-model" });

      const viewerSetId = defaultPermissionSetId("account-model", "viewer");
      // Granting the seed 'Viewer' set resolves to exactly its seeded permissions
      // — proving resolution is by permissions, never by the set's name.
      await repo.grantPermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-target",
        permissionSetId: viewerSetId,
      });
      const viewerSeed = defaultPermissionSetSeeds.find((seed) => seed.key === "viewer");
      expect(viewerSeed).toBeDefined();
      expect(defaultPermissionSetSeeds.map((seed) => seed.key)).not.toContain("reviewer");
      expect(defaultPermissionSetSeeds.find((seed) => seed.key === "contributor")).toMatchObject({
        name: "Contributor",
        permissions: [
          permissionValues.draftWrite,
          permissionValues.feedbackImport,
          permissionValues.styleGuideApprove,
          permissionValues.catalogRead,
        ],
      });
      expect(await repo.resolvePrincipalPermissions(localActor, "principal-target")).toEqual(
        [...(viewerSeed?.permissions ?? [])].sort(),
      );

      // The seeded set is an ordinary editable set: extend it and the grantee gains.
      await repo.addPermissionToSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: viewerSetId,
        permission: permissionValues.patchExport,
      });
      expect(await repo.resolvePrincipalPermissions(localActor, "principal-target")).toContain(
        permissionValues.patchExport,
      );
    } finally {
      await context.close();
    }
  });
});
