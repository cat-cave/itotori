// auth-005-grant-audit-log — DB-backed proof that EVERY auth
// permission-management mutation writes a COMPLETE audit event.
//
// The audit model spans two append-only tables:
//
//   - `itotori_auth_audit_events` records mutations whose SUBJECT is a target
//     principal: grant/revoke a direct permission, grant/revoke a permission set.
//     Each row carries {actor, target, permission/set delta, action, reason,
//     requestId, timestamp}.
//   - `itotori_auth_permission_set_audit_events` records mutations whose SUBJECT
//     is the permission SET itself (no target principal): create, rename,
//     add/remove a permission, delete. auth-004 keeps this table SEPARATE
//     precisely because a set-model edit has no target principal; unifying the
//     two would force a nullable target and lose that distinction. Both tables
//     are held to the same completeness bar (reason + requestId + full delta).
//
// This test performs every mutation and asserts the exact recorded row so the
// trail is provably complete end to end.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, permissionValues, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriPrincipalRepository } from "../src/repositories/principal-repository.js";
import type { DatabaseContext } from "../src/connection.js";
import {
  authAccountMemberships,
  authAuditEvents,
  authPermissionSetAuditEvents,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

/** Stand up an account + admin principal + target principal for a test. */
async function bootstrap(
  repo: ItotoriPrincipalRepository,
  db: DatabaseContext["db"],
): Promise<void> {
  await repo.createAccount(localActor, {
    accountId: "account-audit",
    slug: "audit",
    name: "Audit Workspace",
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
  await db.insert(authAccountMemberships).values({
    membershipId: "membership-target",
    accountId: "account-audit",
    userId: "user-target",
  });
}

describe("auth grant/revoke audit log (auth-005)", () => {
  it("permission editor API is gated by auth.permissions.manage and audits effective-permission changes", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await bootstrap(repo, context.db);
      await repo.createPrincipal(localActor, {
        kind: "human_user",
        principalId: "principal-permission-manager",
        userId: "user-permission-manager",
        displayName: "Permission Manager",
      });
      await repo.createPrincipal(localActor, {
        kind: "human_user",
        principalId: "principal-admin-only",
        userId: "user-admin-only",
        displayName: "Admin Only",
      });
      await repo.grantDirectPermission(localActor, {
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-permission-manager",
        permission: permissionValues.authPermissionsManage,
        reason: "delegate permission editing",
        requestId: "req-delegate-permission-manager",
      });
      await repo.grantDirectPermission(localActor, {
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-admin-only",
        permission: permissionValues.authAdmin,
        reason: "delegate account administration only",
        requestId: "req-delegate-admin-only",
      });

      const managerActor: AuthorizationActor = { userId: "user-permission-manager" };
      const adminOnlyActor: AuthorizationActor = { userId: "user-admin-only" };

      await expect(
        repo.grantDirectPermission(adminOnlyActor, {
          actorPrincipalId: "principal-admin-only",
          targetPrincipalId: "principal-target",
          permission: permissionValues.draftWrite,
        }),
      ).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: permissionValues.authPermissionsManage,
      });

      await repo.createPermissionSet(managerActor, {
        actorPrincipalId: "principal-permission-manager",
        permissionSetId: "permission-set-editor-api",
        accountId: "account-audit",
        name: "Editor API",
        permissions: [permissionValues.queueRead],
        reason: "create editable bundle",
        requestId: "req-editor-create-set",
      });

      await repo.grantDirectPermission(managerActor, {
        actorPrincipalId: "principal-permission-manager",
        targetPrincipalId: "principal-target",
        permission: permissionValues.draftWrite,
        reason: "temporary drafting access",
        requestId: "req-editor-grant-direct",
      });
      expect(await repo.resolvePrincipalPermissions(managerActor, "principal-target")).toEqual([
        permissionValues.draftWrite,
      ]);

      await repo.revokeDirectPermission(managerActor, {
        actorPrincipalId: "principal-permission-manager",
        targetPrincipalId: "principal-target",
        permission: permissionValues.draftWrite,
        reason: "temporary drafting access ended",
        requestId: "req-editor-revoke-direct",
      });
      expect(await repo.resolvePrincipalPermissions(managerActor, "principal-target")).toEqual([]);

      await repo.grantPermissionSet(managerActor, {
        actorPrincipalId: "principal-permission-manager",
        targetPrincipalId: "principal-target",
        permissionSetId: "permission-set-editor-api",
        reason: "assign queue bundle",
        requestId: "req-editor-grant-set",
      });
      expect(await repo.resolvePrincipalPermissions(managerActor, "principal-target")).toEqual([
        permissionValues.queueRead,
      ]);

      await repo.addPermissionToSet(managerActor, {
        actorPrincipalId: "principal-permission-manager",
        permissionSetId: "permission-set-editor-api",
        permission: permissionValues.patchExport,
        reason: "extend bundle",
        requestId: "req-editor-add-set-permission",
      });
      expect(await repo.resolvePrincipalPermissions(managerActor, "principal-target")).toEqual(
        [permissionValues.patchExport, permissionValues.queueRead].sort(),
      );

      await repo.removePermissionFromSet(managerActor, {
        actorPrincipalId: "principal-permission-manager",
        permissionSetId: "permission-set-editor-api",
        permission: permissionValues.queueRead,
        reason: "narrow bundle",
        requestId: "req-editor-remove-set-permission",
      });
      expect(await repo.resolvePrincipalPermissions(managerActor, "principal-target")).toEqual([
        permissionValues.patchExport,
      ]);

      await repo.revokePermissionSet(managerActor, {
        actorPrincipalId: "principal-permission-manager",
        targetPrincipalId: "principal-target",
        permissionSetId: "permission-set-editor-api",
        reason: "remove queue bundle",
        requestId: "req-editor-revoke-set",
      });
      expect(await repo.resolvePrincipalPermissions(managerActor, "principal-target")).toEqual([]);

      const principalAuditRows = await context.db
        .select()
        .from(authAuditEvents)
        .where(eq(authAuditEvents.targetPrincipalId, "principal-target"));
      const principalAuditByRequestId = new Map(
        principalAuditRows.map((row) => [row.requestId, row]),
      );
      for (const requestId of [
        "req-editor-grant-direct",
        "req-editor-revoke-direct",
        "req-editor-grant-set",
        "req-editor-revoke-set",
      ]) {
        expect(principalAuditByRequestId.get(requestId)).toMatchObject({
          actorPrincipalId: "principal-permission-manager",
          targetPrincipalId: "principal-target",
          requestId,
        });
      }
      expect(principalAuditByRequestId.get("req-editor-grant-direct")).toMatchObject({
        action: "granted",
        permission: permissionValues.draftWrite,
        permissionSetId: null,
      });
      expect(principalAuditByRequestId.get("req-editor-revoke-set")).toMatchObject({
        action: "revoked",
        permission: null,
        permissionSetId: "permission-set-editor-api",
      });

      const setAuditRows = await context.db
        .select()
        .from(authPermissionSetAuditEvents)
        .where(eq(authPermissionSetAuditEvents.permissionSetId, "permission-set-editor-api"));
      const setAuditByRequestId = new Map(setAuditRows.map((row) => [row.requestId, row]));
      expect(setAuditRows).toHaveLength(3);
      expect(setAuditByRequestId.get("req-editor-create-set")).toMatchObject({
        actorPrincipalId: "principal-permission-manager",
        action: "set_created",
        setName: "Editor API",
        permission: null,
      });
      expect(setAuditByRequestId.get("req-editor-add-set-permission")).toMatchObject({
        actorPrincipalId: "principal-permission-manager",
        action: "permission_added",
        permission: permissionValues.patchExport,
      });
      expect(setAuditByRequestId.get("req-editor-remove-set-permission")).toMatchObject({
        actorPrincipalId: "principal-permission-manager",
        action: "permission_removed",
        permission: permissionValues.queueRead,
      });
    } finally {
      await context.close();
    }
  });

  it("records a complete audit event for every principal-scoped grant AND revoke", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await bootstrap(repo, context.db);
      await repo.createPermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-audit",
        accountId: "account-audit",
        name: "Audited",
        permissions: [permissionValues.draftWrite],
      });

      // 1. grant a permission set
      await repo.grantPermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-target",
        permissionSetId: "permission-set-audit",
        reason: "onboarding",
        requestId: "req-grant-set",
      });
      // 2. grant a direct permission
      await repo.grantDirectPermission(localActor, {
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-target",
        permission: permissionValues.patchExport,
        reason: "release access",
        requestId: "req-grant-direct",
      });
      // 3. revoke the direct permission
      await repo.revokeDirectPermission(localActor, {
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-target",
        permission: permissionValues.patchExport,
        reason: "access no longer needed",
        requestId: "req-revoke-direct",
      });
      // 4. revoke the permission set
      await repo.revokePermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-target",
        permissionSetId: "permission-set-audit",
        reason: "offboarding",
        requestId: "req-revoke-set",
      });

      const rows = await context.db
        .select()
        .from(authAuditEvents)
        .where(eq(authAuditEvents.targetPrincipalId, "principal-target"));
      const byRequestId = new Map(rows.map((row) => [row.requestId, row]));
      expect(rows).toHaveLength(4);

      const grantSet = byRequestId.get("req-grant-set");
      expect(grantSet).toMatchObject({
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-target",
        action: "granted",
        permission: null,
        permissionSetId: "permission-set-audit",
        reason: "onboarding",
        requestId: "req-grant-set",
      });
      expect(grantSet?.createdAt).toBeInstanceOf(Date);

      expect(byRequestId.get("req-grant-direct")).toMatchObject({
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-target",
        action: "granted",
        permission: permissionValues.patchExport,
        permissionSetId: null,
        reason: "release access",
        requestId: "req-grant-direct",
      });

      expect(byRequestId.get("req-revoke-direct")).toMatchObject({
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-target",
        action: "revoked",
        permission: permissionValues.patchExport,
        permissionSetId: null,
        reason: "access no longer needed",
        requestId: "req-revoke-direct",
      });

      expect(byRequestId.get("req-revoke-set")).toMatchObject({
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-target",
        action: "revoked",
        permission: null,
        permissionSetId: "permission-set-audit",
        reason: "offboarding",
        requestId: "req-revoke-set",
      });

      // The revokes actually removed the grants: the principal resolves nothing.
      expect(await repo.resolvePrincipalPermissions(localActor, "principal-target")).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("records a complete audit event for every permission-set MODEL mutation", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await bootstrap(repo, context.db);

      // create -> add -> remove -> rename -> delete (delete is reachable because
      // the set is never granted, so no revoke-first is required here).
      await repo.createPermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-model",
        accountId: "account-audit",
        name: "Model",
        permissions: [permissionValues.queueRead],
        reason: "create bundle",
        requestId: "req-create",
      });
      await repo.addPermissionToSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-model",
        permission: permissionValues.draftWrite,
        reason: "widen bundle",
        requestId: "req-add",
      });
      await repo.removePermissionFromSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-model",
        permission: permissionValues.queueRead,
        reason: "narrow bundle",
        requestId: "req-remove",
      });
      await repo.renamePermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-model",
        name: "Model Renamed",
        reason: "clarify label",
        requestId: "req-rename",
      });
      await repo.deletePermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-model",
        reason: "retire bundle",
        requestId: "req-delete",
      });

      const rows = await context.db
        .select()
        .from(authPermissionSetAuditEvents)
        .where(eq(authPermissionSetAuditEvents.permissionSetId, "permission-set-model"));
      const byRequestId = new Map(rows.map((row) => [row.requestId, row]));
      expect(rows).toHaveLength(5);
      expect(rows.every((row) => row.actorPrincipalId === "principal-admin")).toBe(true);

      expect(byRequestId.get("req-create")).toMatchObject({
        action: "set_created",
        setName: "Model",
        permission: null,
        reason: "create bundle",
        requestId: "req-create",
      });
      expect(byRequestId.get("req-add")).toMatchObject({
        action: "permission_added",
        setName: "Model",
        permission: permissionValues.draftWrite,
        reason: "widen bundle",
        requestId: "req-add",
      });
      expect(byRequestId.get("req-remove")).toMatchObject({
        action: "permission_removed",
        setName: "Model",
        permission: permissionValues.queueRead,
        reason: "narrow bundle",
        requestId: "req-remove",
      });
      expect(byRequestId.get("req-rename")).toMatchObject({
        action: "set_renamed",
        setName: "Model Renamed",
        permission: null,
        reason: "clarify label",
        requestId: "req-rename",
      });
      // The `set_deleted` row snapshots the name and SURVIVES the set's deletion
      // (the id is retained, not a foreign key).
      expect(byRequestId.get("req-delete")).toMatchObject({
        action: "set_deleted",
        setName: "Model Renamed",
        permission: null,
        reason: "retire bundle",
        requestId: "req-delete",
      });
    } finally {
      await context.close();
    }
  });

  it("refuses to record a phantom revoke when nothing is granted", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await bootstrap(repo, context.db);
      await repo.createPermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-ungranted",
        accountId: "account-audit",
        name: "Ungranted",
        permissions: [permissionValues.draftWrite],
      });

      await expect(
        repo.revokePermissionSet(localActor, {
          actorPrincipalId: "principal-admin",
          targetPrincipalId: "principal-target",
          permissionSetId: "permission-set-ungranted",
        }),
      ).rejects.toThrow(/not granted/u);
      await expect(
        repo.revokeDirectPermission(localActor, {
          actorPrincipalId: "principal-admin",
          targetPrincipalId: "principal-target",
          permission: permissionValues.draftWrite,
        }),
      ).rejects.toThrow(/not granted/u);

      const rows = await context.db
        .select()
        .from(authAuditEvents)
        .where(eq(authAuditEvents.targetPrincipalId, "principal-target"));
      expect(rows).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
