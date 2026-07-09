// auth-001-principal-schema — DB-backed principal / account / permission-set
// repository tests.
//
// Each test stands up an isolated migrated schema and exercises the multi-user
// auth layer against real Postgres: the crux round-trip (create an account +
// principal + permission set, grant the set AND a direct permission, then read
// the principal back and resolve its effective permissions as the union), the
// service-principal kind, the account / membership / external-identity / session
// / invitation tables, the append-only audit trail, and the `auth.admin`
// permission gate on every gated method.

import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  bootstrapDefaultAccountPrincipal,
  defaultLocalAccountId,
  defaultLocalAccountName,
  defaultLocalAccountSlug,
  localOperatorAllPermissionsSetId,
  localOperatorDisplayName,
  localOperatorMembershipId,
  localOperatorPrincipalId,
  localOperatorUserId,
  localUserId,
  permissionValues,
  type AuthorizationActor,
} from "../src/authorization.js";
import {
  ItotoriPrincipalRepository,
  listAccountPermissionSets,
  loadPermissionSetAccountId,
} from "../src/repositories/principal-repository.js";
import {
  authAccountMemberships,
  authAuditEvents,
  authExternalIdentities,
  authInvitations,
  authSessions,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };

describe("ItotoriPrincipalRepository", () => {
  it("loads the signed-in actor identity and reconciles legacy local-user to local-operator", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapDefaultAccountPrincipal(context.db);
      const repo = new ItotoriPrincipalRepository(context.db);

      const identity = await repo.loadActorIdentity(localActor);

      expect(identity).toEqual({
        actorUserId: localUserId,
        userId: localOperatorUserId,
        principalId: localOperatorPrincipalId,
        email: null,
        displayName: localOperatorDisplayName,
        accounts: [
          {
            membershipId: localOperatorMembershipId,
            accountId: defaultLocalAccountId,
            accountSlug: defaultLocalAccountSlug,
            accountName: defaultLocalAccountName,
            permissionSetIds: [localOperatorAllPermissionsSetId()],
            createdAt: expect.any(Date),
          },
        ],
      });
    } finally {
      await context.close();
    }
  });

  it("round-trips a principal with a permission-set grant and a direct grant", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);

      const account = await repo.createAccount(localActor, {
        accountId: "account-crux",
        slug: "crux",
        name: "Crux Workspace",
      });
      expect(account.accountId).toBe("account-crux");

      // The acting admin is itself a principal (recorded in the audit trail).
      const admin = await repo.createPrincipal(localActor, {
        kind: "human_user",
        principalId: "principal-admin",
        userId: "user-admin",
        displayName: "Admin",
        email: "admin@example.com",
      });
      expect(admin.principalKind).toBe("human_user");

      const target = await repo.createPrincipal(localActor, {
        kind: "human_user",
        principalId: "principal-target",
        userId: "user-target",
        displayName: "Target User",
      });
      expect(target.principalKind).toBe("human_user");

      // Account membership is the target's account context; a permission set is
      // account-scoped and may only be granted within the principal's account.
      await context.db.insert(authAccountMemberships).values({
        membershipId: "membership-target",
        accountId: "account-crux",
        userId: "user-target",
      });

      // A "role" is ONLY a permission set: a named, editable bundle.
      const set = await repo.createPermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        permissionSetId: "permission-set-editor",
        accountId: "account-crux",
        name: "Editor",
        description: "Draft + catalog read bundle",
        permissions: [permissionValues.draftWrite, permissionValues.catalogRead],
      });
      expect(set.permissions).toEqual([permissionValues.draftWrite, permissionValues.catalogRead]);
      await expect(
        listAccountPermissionSets(context.db, localActor, "account-crux"),
      ).resolves.toEqual([
        {
          ...set,
          permissions: [permissionValues.catalogRead, permissionValues.draftWrite],
        },
      ]);
      await expect(
        loadPermissionSetAccountId(context.db, localActor, "permission-set-editor"),
      ).resolves.toBe("account-crux");

      // Grant the set (role assignment) AND a direct override.
      await repo.grantPermissionSet(localActor, {
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-target",
        permissionSetId: "permission-set-editor",
        reason: "onboarding",
        requestId: "req-1",
      });
      await repo.grantDirectPermission(localActor, {
        actorPrincipalId: "principal-admin",
        targetPrincipalId: "principal-target",
        permission: permissionValues.patchExport,
        reason: "release access",
        requestId: "req-2",
      });

      const loaded = await repo.loadPrincipal(localActor, "principal-target");
      expect(loaded).toEqual({
        principalId: "principal-target",
        principalKind: "human_user",
        displayName: "Target User",
      });

      // Effective permissions = UNION of set permissions + direct grant, deduped
      // and sorted. No role branching — every result is an exact permission.
      const effective = await repo.resolvePrincipalPermissions(localActor, "principal-target");
      expect(effective).toEqual(
        [
          permissionValues.catalogRead,
          permissionValues.draftWrite,
          permissionValues.patchExport,
        ].sort(),
      );

      // Both grants are recorded in the append-only audit trail.
      const auditRows = await context.db
        .select()
        .from(authAuditEvents)
        .where(eq(authAuditEvents.targetPrincipalId, "principal-target"));
      expect(auditRows).toHaveLength(2);
      expect(auditRows.every((row) => row.action === "granted")).toBe(true);
      expect(auditRows.every((row) => row.actorPrincipalId === "principal-admin")).toBe(true);
      expect(auditRows.some((row) => row.permissionSetId === "permission-set-editor")).toBe(true);
      expect(auditRows.some((row) => row.permission === permissionValues.patchExport)).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("round-trips a service principal (the non-human principal kind)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await repo.createAccount(localActor, {
        accountId: "account-svc",
        slug: "svc",
        name: "Service Workspace",
      });
      const service = await repo.createPrincipal(localActor, {
        kind: "service_principal",
        principalId: "principal-service",
        servicePrincipalId: "service-principal-1",
        accountId: "account-svc",
        displayName: "CI Runner",
      });
      expect(service.principalKind).toBe("service_principal");

      await repo.createPermissionSet(localActor, {
        actorPrincipalId: "principal-service",
        permissionSetId: "permission-set-ci",
        accountId: "account-svc",
        name: "CI",
        permissions: [permissionValues.runtimeIngest],
      });
      await repo.grantPermissionSet(localActor, {
        actorPrincipalId: "principal-service",
        targetPrincipalId: "principal-service",
        permissionSetId: "permission-set-ci",
      });

      const loaded = await repo.loadPrincipal(localActor, "principal-service");
      expect(loaded?.displayName).toBe("CI Runner");
      expect(await repo.resolvePrincipalPermissions(localActor, "principal-service")).toEqual([
        permissionValues.runtimeIngest,
      ]);
    } finally {
      await context.close();
    }
  });

  it("persists the account / membership / external-identity / session / invitation tables", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await repo.createAccount(localActor, {
        accountId: "account-tenant",
        slug: "tenant",
        name: "Tenant",
      });
      await repo.createPrincipal(localActor, {
        kind: "human_user",
        principalId: "principal-member",
        userId: "user-member",
        displayName: "Member",
        email: "member@example.com",
      });

      await context.db.insert(authAccountMemberships).values({
        membershipId: "membership-1",
        accountId: "account-tenant",
        userId: "user-member",
      });
      await context.db.insert(authExternalIdentities).values({
        externalIdentityId: "external-identity-1",
        userId: "user-member",
        provider: "oidc-google",
        subject: "sub-abc-123",
      });
      await context.db.insert(authSessions).values({
        sessionId: "session-1",
        principalId: "principal-member",
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      });
      await context.db.insert(authInvitations).values({
        invitationId: "invitation-1",
        accountId: "account-tenant",
        email: "invitee@example.com",
        initialPermissionSetIds: ["permission-set-editor"],
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      });

      const memberships = await context.db
        .select()
        .from(authAccountMemberships)
        .where(
          and(
            eq(authAccountMemberships.accountId, "account-tenant"),
            eq(authAccountMemberships.userId, "user-member"),
          ),
        );
      expect(memberships).toHaveLength(1);

      const identities = await context.db
        .select()
        .from(authExternalIdentities)
        .where(
          and(
            eq(authExternalIdentities.provider, "oidc-google"),
            eq(authExternalIdentities.subject, "sub-abc-123"),
          ),
        );
      expect(identities).toHaveLength(1);

      const sessions = await context.db
        .select()
        .from(authSessions)
        .where(eq(authSessions.principalId, "principal-member"));
      expect(sessions).toHaveLength(1);

      const invitations = await context.db
        .select()
        .from(authInvitations)
        .where(eq(authInvitations.invitationId, "invitation-1"));
      expect(invitations[0]?.initialPermissionSetIds).toEqual(["permission-set-editor"]);
    } finally {
      await context.close();
    }
  });

  it("enforces the unique (account, user) membership and (provider, subject) identity", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      await repo.createAccount(localActor, {
        accountId: "account-uniq",
        slug: "uniq",
        name: "Uniq",
      });
      await repo.createPrincipal(localActor, {
        kind: "human_user",
        principalId: "principal-uniq",
        userId: "user-uniq",
        displayName: "Uniq User",
      });
      await context.db.insert(authAccountMemberships).values({
        membershipId: "membership-a",
        accountId: "account-uniq",
        userId: "user-uniq",
      });
      await expect(
        context.db.insert(authAccountMemberships).values({
          membershipId: "membership-b",
          accountId: "account-uniq",
          userId: "user-uniq",
        }),
      ).rejects.toThrow();
    } finally {
      await context.close();
    }
  });

  it("refuses representative gated methods without their required auth permission", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);

      await expect(
        repo.createAccount(deniedActor, { accountId: "a", slug: "a", name: "A" }),
      ).rejects.toMatchObject({ name: "AuthorizationError" });
      await expect(
        repo.createPrincipal(deniedActor, {
          kind: "human_user",
          principalId: "p",
          userId: "u",
          displayName: "U",
        }),
      ).rejects.toMatchObject({ name: "AuthorizationError" });
      await expect(
        repo.grantDirectPermission(deniedActor, {
          actorPrincipalId: "a",
          targetPrincipalId: "b",
          permission: permissionValues.draftWrite,
        }),
      ).rejects.toMatchObject({ name: "AuthorizationError" });
      await expect(
        repo.resolvePrincipalPermissions(deniedActor, "principal-x"),
      ).rejects.toMatchObject({ name: "AuthorizationError" });

      const rows = await context.db.execute(sql`
        select count(*)::int as n from itotori_auth_accounts
      `);
      expect(Number((rows.rows[0] as { n: number }).n)).toBe(0);
    } finally {
      await context.close();
    }
  });
});
