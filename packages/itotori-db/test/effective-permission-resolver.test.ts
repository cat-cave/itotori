// auth-002-effective-permission-resolver — DB-backed proof that
// `requirePermission` authorizes an actor by its EFFECTIVE permissions: the
// union of legacy single-user direct grants, new principal direct grants, and
// permissions expanded from granted permission sets ("roles").
//
// GOVERNING INVARIANT (docs/permissions.md): access control is PERMISSION-based,
// never role-based, and an external-provider claim (OIDC/SAML identity) grants
// NOTHING unless a grant row exists. These tests exercise the real resolver
// against real Postgres.

import { describe, expect, it } from "vitest";
import {
  localUserId,
  permissionValues,
  requirePermission,
  type AuthorizationActor,
  type Permission,
} from "../src/authorization.js";
import { ItotoriPrincipalRepository } from "../src/repositories/principal-repository.js";
import { authExternalIdentities } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

// The bootstrap local user is granted every permission directly in the LEGACY
// single-user table by `migrate` -> `bootstrapLocalUser`; it acts as auth admin.
const localActor: AuthorizationActor = { userId: localUserId };

async function expectDenied(run: Promise<void>, permission: Permission): Promise<void> {
  await expect(run).rejects.toMatchObject({ name: "AuthorizationError", permission });
}

describe("requirePermission effective-permission resolution", () => {
  it("authorizes a principal via an expanded permission-set grant (a role)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await repo.createAccount(localActor, { accountId: "acct", slug: "acct", name: "Acct" });
      await repo.createPrincipal(localActor, {
        kind: "human_user",
        principalId: "principal-set",
        userId: "user-set",
        displayName: "Set User",
      });
      await repo.createPermissionSet(localActor, {
        permissionSetId: "set-editor",
        accountId: "acct",
        name: "Editor",
        permissions: [permissionValues.draftWrite, permissionValues.catalogRead],
      });
      await repo.grantPermissionSet(localActor, {
        actorPrincipalId: "principal-set",
        targetPrincipalId: "principal-set",
        permissionSetId: "set-editor",
      });

      const setActor: AuthorizationActor = { userId: "user-set" };
      // Every permission in the granted set resolves through requirePermission.
      await expect(
        requirePermission(context.db, setActor, permissionValues.draftWrite),
      ).resolves.toBeUndefined();
      await expect(
        requirePermission(context.db, setActor, permissionValues.catalogRead),
      ).resolves.toBeUndefined();
      // A permission NOT in the set is denied — no over-grant.
      await expectDenied(
        requirePermission(context.db, setActor, permissionValues.patchExport),
        permissionValues.patchExport,
      );
    } finally {
      await context.close();
    }
  });

  it("authorizes a principal via a direct grant", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await repo.createAccount(localActor, { accountId: "acct", slug: "acct", name: "Acct" });
      await repo.createPrincipal(localActor, {
        kind: "human_user",
        principalId: "principal-direct",
        userId: "user-direct",
        displayName: "Direct User",
      });
      await repo.grantDirectPermission(localActor, {
        actorPrincipalId: "principal-direct",
        targetPrincipalId: "principal-direct",
        permission: permissionValues.patchExport,
      });

      const directActor: AuthorizationActor = { userId: "user-direct" };
      await expect(
        requirePermission(context.db, directActor, permissionValues.patchExport),
      ).resolves.toBeUndefined();
      // An ungranted permission stays denied.
      await expectDenied(
        requirePermission(context.db, directActor, permissionValues.draftWrite),
        permissionValues.draftWrite,
      );
    } finally {
      await context.close();
    }
  });

  it("preserves the legacy single-user direct-grant path for the local user", async () => {
    const context = await isolatedMigratedContext();
    try {
      // No principal rows for the local user at all; its grants live only in the
      // legacy table, and they must still authorize.
      await expect(
        requirePermission(context.db, localActor, permissionValues.authAdmin),
      ).resolves.toBeUndefined();
      await expect(
        requirePermission(context.db, localActor, permissionValues.draftWrite),
      ).resolves.toBeUndefined();
    } finally {
      await context.close();
    }
  });

  it("an external-provider claim authorizes NOTHING without a grant row", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await repo.createAccount(localActor, { accountId: "acct", slug: "acct", name: "Acct" });
      await repo.createPrincipal(localActor, {
        kind: "human_user",
        principalId: "principal-claim",
        userId: "user-claim",
        displayName: "Claim User",
      });
      // The user has a linked OIDC identity — a "provider claim" — but NO grant
      // row of any kind. Provider roles/groups map to nothing here.
      await context.db.insert(authExternalIdentities).values({
        externalIdentityId: "ext-claim",
        userId: "user-claim",
        provider: "oidc-google",
        subject: "sub-claim-123",
      });

      const claimActor: AuthorizationActor = { userId: "user-claim" };
      // Not a single permission is authorized: the identity carries no grants.
      for (const permission of Object.values(permissionValues)) {
        await expectDenied(requirePermission(context.db, claimActor, permission), permission);
      }
    } finally {
      await context.close();
    }
  });
});
