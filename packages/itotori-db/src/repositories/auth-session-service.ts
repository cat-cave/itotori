import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { AuthorizationActor } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import { authSessions, authUsers } from "../schema.js";

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
