import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  localUserId,
  permissionValues,
  requirePermission,
  type AuthorizationActor,
  type Permission,
} from "../src/authorization.js";
import type { DatabaseContext } from "../src/connection.js";
import { ItotoriAuthSessionService } from "../src/repositories/auth-session-service.js";
import { ItotoriPrincipalRepository } from "../src/repositories/principal-repository.js";
import {
  authAccountMemberships,
  authAuditEvents,
  authExternalIdentities,
  authSessions,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

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

async function expectDenied(run: Promise<void>, permission: Permission): Promise<void> {
  await expect(run).rejects.toMatchObject({ name: "AuthorizationError", permission });
}

describe("ItotoriAuthSessionService", () => {
  it("creates an opaque login session and resolves requests to the session actor", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      const sessions = new ItotoriAuthSessionService(context.db);
      await repo.createAccount(localActor, {
        accountId: "account-session",
        slug: "sess",
        name: "Session",
      });
      await createHumanMember(repo, context.db, {
        principalId: "principal-session",
        userId: "user-session",
        accountId: "account-session",
        membershipId: "membership-session",
      });
      await repo.grantDirectPermission(localActor, {
        actorPrincipalId: "principal-session",
        targetPrincipalId: "principal-session",
        permission: permissionValues.draftWrite,
      });

      const session = await sessions.createLoginSession({
        principalId: "principal-session",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      expect(session.sessionId).not.toBe("principal-session");
      expect(session.sessionId.length).toBeGreaterThanOrEqual(32);
      const resolved = await sessions.resolveActorFromSessionId(session.sessionId);
      expect(resolved?.actor).toEqual({
        userId: "user-session",
        sessionId: session.sessionId,
      });
      await expect(
        requirePermission(
          context.db,
          resolved?.actor ?? { userId: "missing" },
          permissionValues.draftWrite,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await context.close();
    }
  });

  it("enforces expiry and immediate local revocation through revokedAt", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      const sessions = new ItotoriAuthSessionService(context.db);
      await repo.createAccount(localActor, {
        accountId: "account-revoke",
        slug: "revoke",
        name: "Revoke",
      });
      await createHumanMember(repo, context.db, {
        principalId: "principal-revoke",
        userId: "user-revoke",
        accountId: "account-revoke",
        membershipId: "membership-revoke",
      });
      await repo.grantDirectPermission(localActor, {
        actorPrincipalId: "principal-revoke",
        targetPrincipalId: "principal-revoke",
        permission: permissionValues.draftWrite,
      });

      const active = await sessions.createLoginSession({
        principalId: "principal-revoke",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      await context.db.insert(authSessions).values({
        sessionId: "expired-session",
        principalId: "principal-revoke",
        expiresAt: new Date(Date.now() - 60 * 1000),
      });

      expect(await sessions.resolveActorFromSessionId("expired-session")).toBeNull();
      await expectDenied(
        requirePermission(
          context.db,
          { userId: "user-revoke", sessionId: "expired-session" },
          permissionValues.draftWrite,
        ),
        permissionValues.draftWrite,
      );

      await expect(sessions.revokeSession(active.sessionId)).resolves.toBe(true);
      await expect(sessions.resolveActorFromSessionId(active.sessionId)).resolves.toBeNull();
      await expectDenied(
        requirePermission(
          context.db,
          { userId: "user-revoke", sessionId: active.sessionId },
          permissionValues.draftWrite,
        ),
        permissionValues.draftWrite,
      );
    } finally {
      await context.close();
    }
  });

  it("lets a session admin inspect active sessions and revoke one immediately with audit", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      const sessions = new ItotoriAuthSessionService(context.db);
      await repo.createAccount(localActor, {
        accountId: "account-session-admin",
        slug: "session-admin",
        name: "Session admin",
      });
      await createHumanMember(repo, context.db, {
        principalId: "principal-session-admin",
        userId: "user-session-admin",
        accountId: "account-session-admin",
        membershipId: "membership-session-admin",
      });
      await repo.grantDirectPermission(localActor, {
        actorPrincipalId: "principal-session-admin",
        targetPrincipalId: "principal-session-admin",
        permission: permissionValues.authSessionsManage,
      });
      await repo.grantDirectPermission(localActor, {
        actorPrincipalId: "principal-session-admin",
        targetPrincipalId: "principal-session-admin",
        permission: permissionValues.draftWrite,
      });
      const sessionAdminActor = { userId: "user-session-admin" };

      const active = await sessions.createLoginSession({
        principalId: "principal-session-admin",
        sessionId: "active-session-admin",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        device: {
          deviceLabel: "Primary workstation",
          userAgent: "Mozilla/5.0 session-admin-test",
          ipAddress: "203.0.113.10",
        },
      });
      await context.db.insert(authSessions).values({
        sessionId: "expired-session-admin",
        principalId: "principal-session-admin",
        expiresAt: new Date(Date.now() - 60 * 1000),
      });

      expect(
        await sessions.listPrincipalSessions(sessionAdminActor, {
          actorPrincipalId: "principal-session-admin",
          targetPrincipalId: "principal-session-admin",
        }),
      ).toEqual([
        expect.objectContaining({
          sessionId: active.sessionId,
          principalId: "principal-session-admin",
          isActive: true,
          deviceLabel: "Primary workstation",
          userAgent: "Mozilla/5.0 session-admin-test",
          ipAddress: "203.0.113.10",
        }),
      ]);

      await expect(
        sessions.revokePrincipalSession(sessionAdminActor, {
          actorPrincipalId: "principal-session-admin",
          targetPrincipalId: "principal-session-admin",
          sessionId: "expired-session-admin",
        }),
      ).rejects.toMatchObject({
        name: "ItotoriAuthSessionServiceError",
      });

      const revoked = await sessions.revokePrincipalSession(sessionAdminActor, {
        actorPrincipalId: "principal-session-admin",
        targetPrincipalId: "principal-session-admin",
        sessionId: active.sessionId,
        reason: "lost device",
        requestId: "req-session-revoke",
      });

      expect(revoked).toMatchObject({
        sessionId: active.sessionId,
        principalId: "principal-session-admin",
        isActive: false,
      });
      await expect(sessions.resolveActorFromSessionId(active.sessionId)).resolves.toBeNull();
      await expectDenied(
        requirePermission(
          context.db,
          { userId: "user-session-admin", sessionId: active.sessionId },
          permissionValues.draftWrite,
        ),
        permissionValues.draftWrite,
      );
      await expect(
        sessions.listPrincipalSessions(sessionAdminActor, {
          actorPrincipalId: "principal-session-admin",
          targetPrincipalId: "principal-session-admin",
        }),
      ).resolves.toEqual([]);

      const auditRows = await context.db
        .select()
        .from(authAuditEvents)
        .where(eq(authAuditEvents.requestId, "req-session-revoke"));
      expect(auditRows).toEqual([
        expect.objectContaining({
          actorPrincipalId: "principal-session-admin",
          targetPrincipalId: "principal-session-admin",
          action: "session_revoked",
          reason: "lost device",
        }),
      ]);
    } finally {
      await context.close();
    }
  });

  it("requires auth.sessions.manage for session admin tools", async () => {
    const context = await isolatedMigratedContext();
    try {
      const sessions = new ItotoriAuthSessionService(context.db);
      await expectDenied(
        sessions.listPrincipalSessions(
          { userId: "missing-session-admin" },
          {
            actorPrincipalId: "principal-missing-session-admin",
            targetPrincipalId: "principal-session-admin",
          },
        ),
        permissionValues.authSessionsManage,
      );
      await expectDenied(
        sessions.revokePrincipalSession(
          { userId: "missing-session-admin" },
          {
            actorPrincipalId: "principal-missing-session-admin",
            targetPrincipalId: "principal-session-admin",
            sessionId: "session-denied",
          },
        ),
        permissionValues.authSessionsManage,
      );
    } finally {
      await context.close();
    }
  });

  it("does not persist provider tokens or use them as the authorization source", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriPrincipalRepository(context.db);
      const sessions = new ItotoriAuthSessionService(context.db);
      await repo.createAccount(localActor, { accountId: "account-idp", slug: "idp", name: "IdP" });
      await createHumanMember(repo, context.db, {
        principalId: "principal-idp",
        userId: "user-idp",
        accountId: "account-idp",
        membershipId: "membership-idp",
      });
      await context.db.insert(authExternalIdentities).values({
        externalIdentityId: "external-idp",
        userId: "user-idp",
        provider: "zitadel",
        subject: "subject-idp",
      });

      const session = await sessions.createLoginSession({
        principalId: "principal-idp",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        providerTokens: {
          accessToken: "provider-access-token-with-admin-scope",
          refreshToken: "provider-refresh-token",
          idToken: "provider-id-token",
        },
      });
      const storedRows = await context.db
        .select()
        .from(authSessions)
        .where(eq(authSessions.sessionId, session.sessionId));
      expect(JSON.stringify(storedRows)).not.toContain("provider-access-token");

      const resolved = await sessions.resolveActorFromSessionId(session.sessionId);
      await expectDenied(
        requirePermission(
          context.db,
          resolved?.actor ?? { userId: "missing" },
          permissionValues.draftWrite,
        ),
        permissionValues.draftWrite,
      );

      await repo.grantDirectPermission(localActor, {
        actorPrincipalId: "principal-idp",
        targetPrincipalId: "principal-idp",
        permission: permissionValues.draftWrite,
      });
      await expect(
        requirePermission(
          context.db,
          resolved?.actor ?? { userId: "missing" },
          permissionValues.draftWrite,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await context.close();
    }
  });
});
