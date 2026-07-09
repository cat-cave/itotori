import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { AuthorizationActor } from "../authorization.js";
import { permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import { authAuditEventActionValues, authAuditEvents, authSessions, authUsers } from "../schema.js";

export type LoginProviderTokenBundle = {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
};

export type CreateLoginSessionInput = {
  principalId: string;
  expiresAt: Date;
  sessionId?: string;
  now?: Date;
  device?: {
    userAgent?: string;
    ipAddress?: string;
    deviceLabel?: string;
  };
  /**
   * External IdP tokens are login-time material only. This service deliberately
   * does not persist them and authorization never reads them.
   */
  providerTokens?: LoginProviderTokenBundle;
};

export type AuthSessionRecord = {
  sessionId: string;
  principalId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type AuthSessionAdminRecord = AuthSessionRecord & {
  isActive: boolean;
  userAgent: string | null;
  ipAddress: string | null;
  deviceLabel: string | null;
};

export type ListPrincipalSessionsInput = {
  actorPrincipalId: string;
  targetPrincipalId: string;
  now?: Date;
};

export type RevokePrincipalSessionInput = {
  actorPrincipalId: string;
  targetPrincipalId: string;
  sessionId: string;
  revokedAt?: Date;
  reason?: string;
  requestId?: string;
};

export type ResolvedAuthSessionActor = {
  actor: AuthorizationActor;
  principalId: string;
  sessionId: string;
  expiresAt: Date;
};

export class ItotoriAuthSessionServiceError extends Error {
  override readonly name = "ItotoriAuthSessionServiceError";
}

export class ItotoriAuthSessionService {
  constructor(private readonly db: ItotoriDatabase) {}

  async createLoginSession(input: CreateLoginSessionInput): Promise<AuthSessionRecord> {
    const now = input.now ?? new Date();
    if (input.expiresAt.getTime() <= now.getTime()) {
      throw new ItotoriAuthSessionServiceError("session expiresAt must be in the future");
    }

    const sessionId = input.sessionId ?? createOpaqueSessionId();
    const rows = await this.db
      .insert(authSessions)
      .values({
        sessionId,
        principalId: input.principalId,
        expiresAt: input.expiresAt,
        userAgent: input.device?.userAgent,
        ipAddress: input.device?.ipAddress,
        deviceLabel: input.device?.deviceLabel,
      })
      .returning({
        sessionId: authSessions.sessionId,
        principalId: authSessions.principalId,
        createdAt: authSessions.createdAt,
        expiresAt: authSessions.expiresAt,
        revokedAt: authSessions.revokedAt,
      });

    const session = rows[0];
    if (session === undefined) {
      throw new ItotoriAuthSessionServiceError("failed to create auth session");
    }
    return session;
  }

  async resolveActorFromSessionId(
    sessionId: string,
    now = new Date(),
  ): Promise<ResolvedAuthSessionActor | null> {
    const rows = await this.db
      .select({
        sessionId: authSessions.sessionId,
        principalId: authSessions.principalId,
        expiresAt: authSessions.expiresAt,
        userId: authUsers.userId,
      })
      .from(authSessions)
      .innerJoin(authUsers, eq(authUsers.principalId, authSessions.principalId))
      .where(
        and(
          eq(authSessions.sessionId, sessionId),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      actor: { userId: row.userId, sessionId: row.sessionId },
      principalId: row.principalId,
      sessionId: row.sessionId,
      expiresAt: row.expiresAt,
    };
  }

  async listPrincipalSessions(
    actor: AuthorizationActor,
    input: ListPrincipalSessionsInput,
  ): Promise<AuthSessionAdminRecord[]> {
    await requirePermission(this.db, actor, permissionValues.authSessionsManage);
    const now = input.now ?? new Date();
    const rows = await this.db
      .select({
        sessionId: authSessions.sessionId,
        principalId: authSessions.principalId,
        createdAt: authSessions.createdAt,
        expiresAt: authSessions.expiresAt,
        revokedAt: authSessions.revokedAt,
        userAgent: authSessions.userAgent,
        ipAddress: authSessions.ipAddress,
        deviceLabel: authSessions.deviceLabel,
      })
      .from(authSessions)
      .where(
        and(
          eq(authSessions.principalId, input.targetPrincipalId),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
        ),
      );
    return rows
      .map((row) => ({ ...row, isActive: true }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async revokePrincipalSession(
    actor: AuthorizationActor,
    input: RevokePrincipalSessionInput,
  ): Promise<AuthSessionAdminRecord> {
    await requirePermission(this.db, actor, permissionValues.authSessionsManage);
    const revokedAt = input.revokedAt ?? new Date();
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(authSessions)
        .set({ revokedAt })
        .where(
          and(
            eq(authSessions.sessionId, input.sessionId),
            eq(authSessions.principalId, input.targetPrincipalId),
            isNull(authSessions.revokedAt),
            gt(authSessions.expiresAt, revokedAt),
          ),
        )
        .returning({
          sessionId: authSessions.sessionId,
          principalId: authSessions.principalId,
          createdAt: authSessions.createdAt,
          expiresAt: authSessions.expiresAt,
          revokedAt: authSessions.revokedAt,
          userAgent: authSessions.userAgent,
          ipAddress: authSessions.ipAddress,
          deviceLabel: authSessions.deviceLabel,
        });
      const session = rows[0];
      if (session === undefined) {
        throw new ItotoriAuthSessionServiceError(
          `active session ${input.sessionId} does not belong to principal ${input.targetPrincipalId} or is already revoked`,
        );
      }
      await tx.insert(authAuditEvents).values({
        authAuditEventId: `auth-audit-${randomUUID()}`,
        actorPrincipalId: input.actorPrincipalId,
        targetPrincipalId: input.targetPrincipalId,
        action: authAuditEventActionValues.sessionRevoked,
        reason: input.reason,
        requestId: input.requestId,
      });
      return { ...session, isActive: false };
    });
  }

  async revokeSession(sessionId: string, revokedAt = new Date()): Promise<boolean> {
    const rows = await this.db
      .update(authSessions)
      .set({ revokedAt })
      .where(and(eq(authSessions.sessionId, sessionId), isNull(authSessions.revokedAt)))
      .returning({ sessionId: authSessions.sessionId });
    return rows.length > 0;
  }
}

export function createOpaqueSessionId(): string {
  return randomBytes(32).toString("base64url");
}
