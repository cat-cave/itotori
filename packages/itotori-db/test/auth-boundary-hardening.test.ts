// auth-authorization-boundary-hardening — DB-backed proof that the three
// interrelated authorization holes a security audit found in the multi-user
// auth foundation are closed, exercised against real Postgres.
//
// GOVERNING INVARIANT (docs/permissions.md): access control is PERMISSION-based,
// never role-based. These tests harden the boundaries an exact-match permission
// check relies on; none introduces a role.
//
//   P0  cross-account permission-set escalation — a set from account B cannot be
//       GRANTED to, nor AUTHORIZE, a principal in account A.
//   P1  active-subject boundary — a disabled principal / account / service
//       principal, or a revoked/expired session, authorizes nothing.
//   P1  legacy/principal userId namespace collision — a provider-linked identity
//       cannot inherit a legacy bootstrap grant that merely shares its userId,
//       and the reserved bootstrap userId cannot be registered as a principal.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  localUserId,
  permissionValues,
  requirePermission,
  resolvePrincipalEffectivePermissions,
  type AuthorizationActor,
  type Permission,
} from "../src/authorization.js";
import type { DatabaseContext } from "../src/connection.js";
import {
  ItotoriPrincipalRepository,
  ItotoriPrincipalRepositoryError,
} from "../src/repositories/principal-repository.js";
import {
  authAccountMemberships,
  authAccounts,
  authExternalIdentities,
  authPrincipalPermissionSetGrants,
  authPrincipals,
  authSessions,
  authUsers,
  userPermissionGrants,
  users,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

async function expectDenied(run: Promise<void>, permission: Permission): Promise<void> {
  await expect(run).rejects.toMatchObject({ name: "AuthorizationError", permission });
}

/** Create a human principal + its account membership in one step. */
async function createHumanMember(
  repo: ItotoriPrincipalRepository,
  db: DatabaseContext["db"],
  input: { principalId: string; userId: string; accountId: string; membershipId: string },
): Promise<void> {
  await repo.createPrincipal(localActor, {
    kind: "human_user",
    principalId: input.principalId,
    userId: input.userId,
    displayName: input.userId,
  });
  await db.insert(authAccountMemberships).values({
    membershipId: input.membershipId,
    accountId: input.accountId,
    userId: input.userId,
  });
}

describe("P0 — account-scoped permission-set grants (cross-account escalation)", () => {
  it("refuses to GRANT a permission set from account B to a principal in account A", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await repo.createAccount(localActor, { accountId: "account-a", slug: "a", name: "A" });
      await repo.createAccount(localActor, { accountId: "account-b", slug: "b", name: "B" });
      await createHumanMember(repo, context.db, {
        principalId: "principal-a",
        userId: "user-a",
        accountId: "account-a",
        membershipId: "membership-a",
      });
      // A set owned by account B.
      await repo.createPermissionSet(localActor, {
        actorPrincipalId: "principal-a",
        permissionSetId: "set-b",
        accountId: "account-b",
        name: "B Editor",
        permissions: [permissionValues.draftWrite],
      });

      // Granting B's set to the account-A principal is refused.
      await expect(
        repo.grantPermissionSet(localActor, {
          actorPrincipalId: "principal-a",
          targetPrincipalId: "principal-a",
          permissionSetId: "set-b",
        }),
      ).rejects.toBeInstanceOf(ItotoriPrincipalRepositoryError);

      // No grant row was written.
      const grants = await context.db
        .select()
        .from(authPrincipalPermissionSetGrants)
        .where(eq(authPrincipalPermissionSetGrants.principalId, "principal-a"));
      expect(grants).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("a cross-account set grant AUTHORIZES NOTHING even if a grant row is inserted out of band", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await repo.createAccount(localActor, { accountId: "account-a", slug: "a", name: "A" });
      await repo.createAccount(localActor, { accountId: "account-b", slug: "b", name: "B" });
      await createHumanMember(repo, context.db, {
        principalId: "principal-a",
        userId: "user-a",
        accountId: "account-a",
        membershipId: "membership-a",
      });
      await repo.createPermissionSet(localActor, {
        actorPrincipalId: "principal-a",
        permissionSetId: "set-b",
        accountId: "account-b",
        name: "B Editor",
        permissions: [permissionValues.draftWrite],
      });

      // Bypass the repository's same-account guard and force the cross-account
      // grant row directly — the resolver must still refuse to honor it.
      await context.db.insert(authPrincipalPermissionSetGrants).values({
        principalId: "principal-a",
        permissionSetId: "set-b",
      });

      const effective = await resolvePrincipalEffectivePermissions(context.db, "principal-a");
      expect(effective.has(permissionValues.draftWrite)).toBe(false);
      await expectDenied(
        requirePermission(context.db, { userId: "user-a" }, permissionValues.draftWrite),
        permissionValues.draftWrite,
      );
    } finally {
      await context.close();
    }
  });

  it("a SAME-account set grant authorizes normally (control)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await repo.createAccount(localActor, { accountId: "account-a", slug: "a", name: "A" });
      await createHumanMember(repo, context.db, {
        principalId: "principal-a",
        userId: "user-a",
        accountId: "account-a",
        membershipId: "membership-a",
      });
      await repo.createPermissionSet(localActor, {
        actorPrincipalId: "principal-a",
        permissionSetId: "set-a",
        accountId: "account-a",
        name: "A Editor",
        permissions: [permissionValues.draftWrite],
      });
      await repo.grantPermissionSet(localActor, {
        actorPrincipalId: "principal-a",
        targetPrincipalId: "principal-a",
        permissionSetId: "set-a",
      });
      await expect(
        requirePermission(context.db, { userId: "user-a" }, permissionValues.draftWrite),
      ).resolves.toBeUndefined();
    } finally {
      await context.close();
    }
  });
});

describe("P1 — active-subject boundary (disabled / revoked ignored)", () => {
  it("a disabled principal authorizes nothing", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await repo.createAccount(localActor, { accountId: "account-a", slug: "a", name: "A" });
      await createHumanMember(repo, context.db, {
        principalId: "principal-d",
        userId: "user-d",
        accountId: "account-a",
        membershipId: "membership-d",
      });
      await repo.grantDirectPermission(localActor, {
        actorPrincipalId: "principal-d",
        targetPrincipalId: "principal-d",
        permission: permissionValues.draftWrite,
      });
      // Authorized while active.
      await expect(
        requirePermission(context.db, { userId: "user-d" }, permissionValues.draftWrite),
      ).resolves.toBeUndefined();

      // Disable the principal -> every grant is void.
      await context.db
        .update(authPrincipals)
        .set({ disabledAt: new Date() })
        .where(eq(authPrincipals.principalId, "principal-d"));
      await expectDenied(
        requirePermission(context.db, { userId: "user-d" }, permissionValues.draftWrite),
        permissionValues.draftWrite,
      );
    } finally {
      await context.close();
    }
  });

  it("a disabled account voids that account's set grants (human) and inerts a service principal", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await repo.createAccount(localActor, { accountId: "account-a", slug: "a", name: "A" });
      await createHumanMember(repo, context.db, {
        principalId: "principal-h",
        userId: "user-h",
        accountId: "account-a",
        membershipId: "membership-h",
      });
      await repo.createPermissionSet(localActor, {
        actorPrincipalId: "principal-h",
        permissionSetId: "set-a",
        accountId: "account-a",
        name: "A Editor",
        permissions: [permissionValues.draftWrite],
      });
      await repo.grantPermissionSet(localActor, {
        actorPrincipalId: "principal-h",
        targetPrincipalId: "principal-h",
        permissionSetId: "set-a",
      });
      // A service principal that lives in the same account.
      await repo.createPrincipal(localActor, {
        kind: "service_principal",
        principalId: "principal-sp",
        servicePrincipalId: "sp-1",
        accountId: "account-a",
        displayName: "CI",
      });
      await repo.grantDirectPermission(localActor, {
        actorPrincipalId: "principal-sp",
        targetPrincipalId: "principal-sp",
        permission: permissionValues.catalogRead,
      });

      // Both authorize while the account is active.
      await expect(
        requirePermission(context.db, { userId: "user-h" }, permissionValues.draftWrite),
      ).resolves.toBeUndefined();
      expect(
        (await resolvePrincipalEffectivePermissions(context.db, "principal-sp")).has(
          permissionValues.catalogRead,
        ),
      ).toBe(true);

      // Disable the account.
      await context.db
        .update(authAccounts)
        .set({ disabledAt: new Date() })
        .where(eq(authAccounts.accountId, "account-a"));

      // The human's account-scoped set no longer authorizes.
      await expectDenied(
        requirePermission(context.db, { userId: "user-h" }, permissionValues.draftWrite),
        permissionValues.draftWrite,
      );
      // The service principal (which belongs to exactly this account) is fully
      // inert — even its direct grant is void.
      expect((await resolvePrincipalEffectivePermissions(context.db, "principal-sp")).size).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("a revoked or expired session authorizes nothing; an active session authorizes", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await repo.createAccount(localActor, { accountId: "account-a", slug: "a", name: "A" });
      await createHumanMember(repo, context.db, {
        principalId: "principal-s",
        userId: "user-s",
        accountId: "account-a",
        membershipId: "membership-s",
      });
      await repo.grantDirectPermission(localActor, {
        actorPrincipalId: "principal-s",
        targetPrincipalId: "principal-s",
        permission: permissionValues.draftWrite,
      });

      const future = new Date(Date.now() + 60 * 60 * 1000);
      const past = new Date(Date.now() - 60 * 60 * 1000);
      await context.db.insert(authSessions).values([
        { sessionId: "sess-active", principalId: "principal-s", expiresAt: future },
        {
          sessionId: "sess-revoked",
          principalId: "principal-s",
          expiresAt: future,
          revokedAt: new Date(),
        },
        { sessionId: "sess-expired", principalId: "principal-s", expiresAt: past },
      ]);

      // An active session authorizes.
      await expect(
        requirePermission(
          context.db,
          { userId: "user-s", sessionId: "sess-active" },
          permissionValues.draftWrite,
        ),
      ).resolves.toBeUndefined();
      // A revoked session denies.
      await expectDenied(
        requirePermission(
          context.db,
          { userId: "user-s", sessionId: "sess-revoked" },
          permissionValues.draftWrite,
        ),
        permissionValues.draftWrite,
      );
      // An expired session denies.
      await expectDenied(
        requirePermission(
          context.db,
          { userId: "user-s", sessionId: "sess-expired" },
          permissionValues.draftWrite,
        ),
        permissionValues.draftWrite,
      );
      // A session that belongs to a DIFFERENT principal denies.
      await expectDenied(
        requirePermission(
          context.db,
          { userId: "user-s", sessionId: "does-not-exist" },
          permissionValues.draftWrite,
        ),
        permissionValues.draftWrite,
      );
    } finally {
      await context.close();
    }
  });
});

describe("P1 — legacy/principal userId namespace collision", () => {
  it("an external-provider-linked identity does NOT inherit a legacy bootstrap grant sharing its userId", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      // A legacy single-user grant keyed on a raw userId (the bootstrap shape).
      await context.db
        .insert(users)
        .values({ userId: "shared-id", displayName: "Shared" })
        .onConflictDoNothing();
      await context.db
        .insert(userPermissionGrants)
        .values({ userId: "shared-id", permission: permissionValues.draftWrite });

      // A principal registered under the SAME raw userId, backed by an external
      // identity provider, with NO principal grants of its own.
      await repo.createAccount(localActor, { accountId: "account-a", slug: "a", name: "A" });
      await createHumanMember(repo, context.db, {
        principalId: "principal-ext",
        userId: "shared-id",
        accountId: "account-a",
        membershipId: "membership-ext",
      });
      await context.db.insert(authExternalIdentities).values({
        externalIdentityId: "ext-1",
        userId: "shared-id",
        provider: "oidc-google",
        subject: "sub-shared",
      });

      // The provider-linked actor authorizes ONLY through principal grants — it
      // must NOT inherit the colliding legacy grant.
      await expectDenied(
        requirePermission(context.db, { userId: "shared-id" }, permissionValues.draftWrite),
        permissionValues.draftWrite,
      );
    } finally {
      await context.close();
    }
  });

  it("a NON-provider actor still bridges to a legacy grant of the same userId (the legacy path is intact)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await context.db
        .insert(users)
        .values({ userId: "bridged-id", displayName: "Bridged" })
        .onConflictDoNothing();
      await context.db
        .insert(userPermissionGrants)
        .values({ userId: "bridged-id", permission: permissionValues.draftWrite });
      await repo.createAccount(localActor, { accountId: "account-a", slug: "a", name: "A" });
      await createHumanMember(repo, context.db, {
        principalId: "principal-bridged",
        userId: "bridged-id",
        accountId: "account-a",
        membershipId: "membership-bridged",
      });
      // No external identity -> the legacy path is still consulted.
      await expect(
        requirePermission(context.db, { userId: "bridged-id" }, permissionValues.draftWrite),
      ).resolves.toBeUndefined();
    } finally {
      await context.close();
    }
  });

  it("the reserved bootstrap userId cannot be registered as a principal (repo guard + DB CHECK)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      // Repository guard.
      await expect(
        repo.createPrincipal(localActor, {
          kind: "human_user",
          principalId: "principal-reserved",
          userId: localUserId,
          displayName: "Reserved",
        }),
      ).rejects.toBeInstanceOf(ItotoriPrincipalRepositoryError);

      // Database CHECK constraint (defense in depth): a raw insert is rejected too.
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
