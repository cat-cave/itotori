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
import { authAccountMemberships, authExternalIdentities, authSessions } from "../src/schema.js";
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
