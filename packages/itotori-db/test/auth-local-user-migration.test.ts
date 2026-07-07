// auth-003-local-user-migration — DB-backed proof that the single local
// operator is migrated into the multi-user model WITHOUT breaking the legacy
// path and WITHOUT tripping the 0061 `local-user` reservation.
//
// GOVERNING INVARIANT (docs/permissions.md): access control is PERMISSION-based,
// never role-based. The operator resolves permissions through an editable
// permission SET (a data bundle), never a role string.
//
//   - the default-account operator principal resolves EVERY permission via its
//     seeded, editable all-permissions set (account-scope boundary satisfied);
//   - the legacy `local-user` direct-grant path still authorizes (no breakage);
//   - the migration is idempotent;
//   - the 0061 reservation of `local-user` is untouched (a distinct,
//     non-colliding `local-operator` principal is created instead).

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  allPermissions,
  bootstrapDefaultAccountPrincipal,
  defaultLocalAccountId,
  localOperatorAllPermissionsSetId,
  localOperatorMembershipId,
  localOperatorPrincipalId,
  localOperatorUserId,
  localUserId,
  permissionValues,
  requirePermission,
  resolvePrincipalEffectivePermissions,
  type AuthorizationActor,
} from "../src/authorization.js";
import { ItotoriPrincipalRepository } from "../src/repositories/principal-repository.js";
import {
  authAccountMemberships,
  authAccounts,
  authPermissionSetPermissions,
  authPermissionSets,
  authPrincipalPermissionSetGrants,
  authPrincipals,
  authUsers,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const legacyActor: AuthorizationActor = { userId: localUserId };
const operatorActor: AuthorizationActor = { userId: localOperatorUserId };

describe("auth-003 local operator migration", () => {
  it("plain migrate seeds only the legacy substrate (no multi-user account yet)", async () => {
    const context = await isolatedMigratedContext();
    try {
      // The legacy local-user authorizes every permission via the legacy table.
      for (const permission of allPermissions) {
        await expect(
          requirePermission(context.db, legacyActor, permission),
        ).resolves.toBeUndefined();
      }
      // No multi-user account / operator principal exists before the migration.
      expect(await context.db.select().from(authAccounts)).toHaveLength(0);
      expect(await context.db.select().from(authPrincipals)).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("materializes the default account + operator principal + editable all-permissions set", async () => {
    const context = await isolatedMigratedContext();
    try {
      const actor = await bootstrapDefaultAccountPrincipal(context.db);
      expect(actor).toEqual({ userId: localOperatorUserId });

      // Default account.
      const accounts = await context.db
        .select()
        .from(authAccounts)
        .where(eq(authAccounts.accountId, defaultLocalAccountId));
      expect(accounts).toHaveLength(1);

      // Operator principal + human-user row under a NON-reserved userId.
      const principals = await context.db
        .select()
        .from(authPrincipals)
        .where(eq(authPrincipals.principalId, localOperatorPrincipalId));
      expect(principals).toHaveLength(1);
      expect(principals[0]?.principalKind).toBe("human_user");
      const operatorUsers = await context.db
        .select()
        .from(authUsers)
        .where(eq(authUsers.userId, localOperatorUserId));
      expect(operatorUsers).toHaveLength(1);
      expect(localOperatorUserId).not.toBe(localUserId);

      // Membership links the operator into the default account.
      const memberships = await context.db
        .select()
        .from(authAccountMemberships)
        .where(
          and(
            eq(authAccountMemberships.accountId, defaultLocalAccountId),
            eq(authAccountMemberships.userId, localOperatorUserId),
          ),
        );
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.membershipId).toBe(localOperatorMembershipId);

      // The all-permissions set is owned by the default account, granted to the
      // operator, and contains EVERY permission.
      const setId = localOperatorAllPermissionsSetId();
      const sets = await context.db
        .select()
        .from(authPermissionSets)
        .where(eq(authPermissionSets.permissionSetId, setId));
      expect(sets).toHaveLength(1);
      expect(sets[0]?.accountId).toBe(defaultLocalAccountId);
      const setPermissions = await context.db
        .select({ permission: authPermissionSetPermissions.permission })
        .from(authPermissionSetPermissions)
        .where(eq(authPermissionSetPermissions.permissionSetId, setId));
      expect(setPermissions.map((row) => row.permission).sort()).toEqual(
        [...allPermissions].sort(),
      );
      const grants = await context.db
        .select()
        .from(authPrincipalPermissionSetGrants)
        .where(eq(authPrincipalPermissionSetGrants.principalId, localOperatorPrincipalId));
      expect(grants).toHaveLength(1);
      expect(grants[0]?.permissionSetId).toBe(setId);
    } finally {
      await context.close();
    }
  });

  it("the operator principal resolves ALL permissions via its seeded set (crux)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapDefaultAccountPrincipal(context.db);

      // Resolver of record: the union expands the granted set to every permission.
      const effective = await resolvePrincipalEffectivePermissions(
        context.db,
        localOperatorPrincipalId,
      );
      expect([...effective].sort()).toEqual([...allPermissions].sort());

      // And requirePermission authorizes the operator actor for each permission
      // through the PRINCIPAL layer (it holds no legacy grants of its own).
      for (const permission of allPermissions) {
        await expect(
          requirePermission(context.db, operatorActor, permission),
        ).resolves.toBeUndefined();
      }

      // The gated repository read agrees (the operator holds auth.admin via the set).
      const repo = new ItotoriPrincipalRepository(context.db);
      const resolved = await repo.resolvePrincipalPermissions(
        operatorActor,
        localOperatorPrincipalId,
      );
      expect([...resolved].sort()).toEqual([...allPermissions].sort());
    } finally {
      await context.close();
    }
  });

  it("the all-permissions set is an ordinary EDITABLE set (removing a permission takes effect)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapDefaultAccountPrincipal(context.db);
      const repo = new ItotoriPrincipalRepository(context.db);

      // The operator (which holds auth.admin via its own set) edits the set.
      await repo.removePermissionFromSet(operatorActor, {
        actorPrincipalId: localOperatorPrincipalId,
        permissionSetId: localOperatorAllPermissionsSetId(),
        permission: permissionValues.catalogRead,
        reason: "prove editable",
      });

      const effective = await resolvePrincipalEffectivePermissions(
        context.db,
        localOperatorPrincipalId,
      );
      expect(effective.has(permissionValues.catalogRead)).toBe(false);
      // Everything else is retained.
      expect(effective.has(permissionValues.draftWrite)).toBe(true);
      await expect(
        requirePermission(context.db, operatorActor, permissionValues.catalogRead),
      ).rejects.toMatchObject({ name: "AuthorizationError" });
    } finally {
      await context.close();
    }
  });

  it("is idempotent — running it twice changes nothing", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapDefaultAccountPrincipal(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);

      expect(
        await context.db
          .select()
          .from(authAccounts)
          .where(eq(authAccounts.accountId, defaultLocalAccountId)),
      ).toHaveLength(1);
      expect(
        await context.db
          .select()
          .from(authAccountMemberships)
          .where(eq(authAccountMemberships.userId, localOperatorUserId)),
      ).toHaveLength(1);
      expect(
        await context.db
          .select()
          .from(authPrincipalPermissionSetGrants)
          .where(eq(authPrincipalPermissionSetGrants.principalId, localOperatorPrincipalId)),
      ).toHaveLength(1);
      const effective = await resolvePrincipalEffectivePermissions(
        context.db,
        localOperatorPrincipalId,
      );
      expect([...effective].sort()).toEqual([...allPermissions].sort());
    } finally {
      await context.close();
    }
  });

  it("does NOT break the legacy local-user path and does NOT trip the 0061 reservation", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapDefaultAccountPrincipal(context.db);

      // Legacy local-user still authorizes every permission (backward-compat).
      for (const permission of allPermissions) {
        await expect(
          requirePermission(context.db, legacyActor, permission),
        ).resolves.toBeUndefined();
      }

      // The reserved `local-user` was NOT registered as an auth user; only the
      // non-colliding operator id is present.
      const reservedRows = await context.db
        .select()
        .from(authUsers)
        .where(eq(authUsers.userId, localUserId));
      expect(reservedRows).toHaveLength(0);

      // The 0061 CHECK still rejects registering `local-user` as a principal.
      await context.db.insert(authPrincipals).values({
        principalId: "principal-reserved",
        principalKind: "human_user",
      });
      await expect(
        context.db.insert(authUsers).values({
          userId: localUserId,
          principalId: "principal-reserved",
          displayName: "Reserved",
        }),
      ).rejects.toThrow();
    } finally {
      await context.close();
    }
  });
});
