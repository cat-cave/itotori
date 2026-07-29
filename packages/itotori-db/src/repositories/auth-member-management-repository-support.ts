import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { isReservedAuthUserId, type Permission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  authAccountMemberships,
  authAuditEventActionValues,
  authAuditEvents,
  authInvitations,
  authPermissionSets,
  authPrincipalKindValues,
  authPrincipalPermissionSetGrants,
  authPrincipals,
  authUsers,
} from "../schema.js";
import {
  ItotoriAuthMemberManagementRepositoryError,
  type MemberInvitationRecord,
  type MemberRecord,
  type MemberTransaction,
} from "./auth-member-management-repository-types.js";

export class AuthMemberManagementRepositorySupport {
  async findOrCreateUser(
    tx: MemberTransaction,
    input: {
      email: string;
      displayName: string;
      userId?: string | undefined;
      principalId?: string | undefined;
    },
  ): Promise<{ userId: string; principalId: string; email: string | null; displayName: string }> {
    if (input.userId !== undefined) {
      const existing = await tx
        .select({
          userId: authUsers.userId,
          principalId: authUsers.principalId,
          email: authUsers.email,
          displayName: authUsers.displayName,
        })
        .from(authUsers)
        .where(eq(authUsers.userId, input.userId))
        .limit(1);
      const existingUser = existing[0];
      if (existingUser !== undefined) {
        // An existing user may only accept an invitation addressed to their own
        // email. Otherwise a caller could bind an unrelated identity's user id
        // to the invited grants.
        if (normalizeEmailValue(existingUser.email) !== input.email) {
          throw new ItotoriAuthMemberManagementRepositoryError(
            "resolved user does not match the invited identity",
          );
        }
        if (input.principalId !== undefined && input.principalId !== existingUser.principalId) {
          throw new ItotoriAuthMemberManagementRepositoryError(
            "resolved user does not match the invited identity",
          );
        }
        return existingUser;
      }
    } else {
      const byEmail = await tx
        .select({
          userId: authUsers.userId,
          principalId: authUsers.principalId,
          email: authUsers.email,
          displayName: authUsers.displayName,
        })
        .from(authUsers)
        .where(eq(authUsers.email, input.email))
        .limit(1);
      const byEmailUser = byEmail[0];
      if (byEmailUser !== undefined) {
        if (input.principalId !== undefined && input.principalId !== byEmailUser.principalId) {
          throw new ItotoriAuthMemberManagementRepositoryError(
            "resolved user does not match the invited identity",
          );
        }
        return byEmailUser;
      }
    }
    const userId = input.userId ?? `auth-user-${randomUUID()}`;
    const principalId = input.principalId ?? `auth-principal-${randomUUID()}`;
    if (isReservedAuthUserId(userId)) {
      throw new ItotoriAuthMemberManagementRepositoryError(
        `userId ${userId} is reserved for the legacy single-user substrate`,
      );
    }
    await tx.insert(authPrincipals).values({
      principalId,
      principalKind: authPrincipalKindValues.humanUser,
    });
    await tx.insert(authUsers).values({
      userId,
      principalId,
      email: input.email,
      displayName: input.displayName,
    });
    return { userId, principalId, email: input.email, displayName: input.displayName };
  }

  async ensureMembership(
    tx: MemberTransaction,
    accountId: string,
    userId: string,
  ): Promise<{ membershipId: string; accountId: string; userId: string; createdAt: Date }> {
    await tx
      .insert(authAccountMemberships)
      .values({
        membershipId: `auth-membership-${randomUUID()}`,
        accountId,
        userId,
      })
      .onConflictDoNothing();
    const rows = await tx
      .select({
        membershipId: authAccountMemberships.membershipId,
        accountId: authAccountMemberships.accountId,
        userId: authAccountMemberships.userId,
        createdAt: authAccountMemberships.createdAt,
      })
      .from(authAccountMemberships)
      .where(
        and(
          eq(authAccountMemberships.accountId, accountId),
          eq(authAccountMemberships.userId, userId),
        ),
      )
      .limit(1);
    const membership = rows[0];
    if (membership === undefined) {
      throw new ItotoriAuthMemberManagementRepositoryError("account membership was not created");
    }
    return membership;
  }

  /**
   * Atomically claim an open, unexpired, unrevoked invitation. The conditional
   * `UPDATE ... WHERE accepted_at IS NULL RETURNING` flips the invitation and
   * returns the row only for the single caller that wins the race; concurrent
   * accepts block on the row lock and then observe zero affected rows, so
   * exactly one accept can create the membership/grants. A loser (or an
   * already-accepted invitation) fails loud and creates nothing.
   */
  async claimOpenInvitation(
    tx: MemberTransaction,
    invitationId: string,
  ): Promise<MemberInvitationRecord> {
    // Distinguish "already accepted" from "missing/revoked/expired" so the
    // concurrency loser gets a precise typed error.
    const existingRows = await tx
      .select({
        acceptedAt: authInvitations.acceptedAt,
        revokedAt: authInvitations.revokedAt,
        expiresAt: authInvitations.expiresAt,
      })
      .from(authInvitations)
      .where(eq(authInvitations.invitationId, invitationId))
      .limit(1);
    const existing = existingRows[0];
    if (existing === undefined) {
      throw new ItotoriAuthMemberManagementRepositoryError(
        `invitation ${invitationId} is not open`,
      );
    }
    if (existing.revokedAt !== null) {
      throw new ItotoriAuthMemberManagementRepositoryError(
        `invitation ${invitationId} is not open`,
      );
    }
    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new ItotoriAuthMemberManagementRepositoryError(
        `invitation ${invitationId} has expired`,
      );
    }
    const claimed = await tx
      .update(authInvitations)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(authInvitations.invitationId, invitationId),
          isNull(authInvitations.acceptedAt),
          isNull(authInvitations.revokedAt),
        ),
      )
      .returning();
    const invitation = claimed[0];
    if (invitation === undefined) {
      // The conditional update matched zero rows: another accept already
      // flipped this invitation (or it was revoked/expired since the read).
      throw new ItotoriAuthMemberManagementRepositoryError(
        `invitation ${invitationId} has already been accepted`,
      );
    }
    return this.invitationRecord(invitation);
  }

  async requirePermissionSetsInAccount(
    db: Pick<ItotoriDatabase, "select"> | MemberTransaction,
    accountId: string,
    permissionSetIds: readonly string[],
  ): Promise<void> {
    if (permissionSetIds.length === 0) {
      return;
    }
    const rows = await db
      .select({
        permissionSetId: authPermissionSets.permissionSetId,
        accountId: authPermissionSets.accountId,
      })
      .from(authPermissionSets)
      .where(inArray(authPermissionSets.permissionSetId, [...permissionSetIds]));
    const found = new Map(rows.map((row) => [row.permissionSetId, row.accountId]));
    for (const permissionSetId of permissionSetIds) {
      const setAccountId = found.get(permissionSetId);
      if (setAccountId === undefined) {
        throw new ItotoriAuthMemberManagementRepositoryError(
          `permission set ${permissionSetId} does not exist`,
        );
      }
      if (setAccountId !== accountId) {
        throw new ItotoriAuthMemberManagementRepositoryError(
          `permission set ${permissionSetId} belongs to account ${setAccountId}, not ${accountId}`,
        );
      }
    }
  }

  async listMembersForAccount(
    db: Pick<ItotoriDatabase, "select"> | MemberTransaction,
    accountId: string,
  ): Promise<MemberRecord[]> {
    const rows = await db
      .select({
        membershipId: authAccountMemberships.membershipId,
        accountId: authAccountMemberships.accountId,
        userId: authUsers.userId,
        principalId: authUsers.principalId,
        email: authUsers.email,
        displayName: authUsers.displayName,
        createdAt: authAccountMemberships.createdAt,
      })
      .from(authAccountMemberships)
      .innerJoin(authUsers, eq(authUsers.userId, authAccountMemberships.userId))
      .where(eq(authAccountMemberships.accountId, accountId));
    if (rows.length === 0) {
      return [];
    }
    const principalIds = rows.map((row) => row.principalId);
    const grants = await db
      .select({
        principalId: authPrincipalPermissionSetGrants.principalId,
        permissionSetId: authPrincipalPermissionSetGrants.permissionSetId,
      })
      .from(authPrincipalPermissionSetGrants)
      .innerJoin(
        authPermissionSets,
        eq(authPermissionSets.permissionSetId, authPrincipalPermissionSetGrants.permissionSetId),
      )
      .where(
        and(
          inArray(authPrincipalPermissionSetGrants.principalId, principalIds),
          eq(authPermissionSets.accountId, accountId),
        ),
      );
    const grantsByPrincipal = new Map<string, string[]>();
    for (const grant of grants) {
      const set = grantsByPrincipal.get(grant.principalId) ?? [];
      set.push(grant.permissionSetId);
      grantsByPrincipal.set(grant.principalId, set);
    }
    return rows
      .map((row) => ({
        ...row,
        permissionSetIds: [...(grantsByPrincipal.get(row.principalId) ?? [])].sort(),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async requireMemberByMembershipId(
    tx: MemberTransaction,
    membershipId: string,
  ): Promise<MemberRecord> {
    const rows = await tx
      .select({
        membershipId: authAccountMemberships.membershipId,
        accountId: authAccountMemberships.accountId,
        userId: authUsers.userId,
        principalId: authUsers.principalId,
        email: authUsers.email,
        displayName: authUsers.displayName,
        createdAt: authAccountMemberships.createdAt,
      })
      .from(authAccountMemberships)
      .innerJoin(authUsers, eq(authUsers.userId, authAccountMemberships.userId))
      .where(eq(authAccountMemberships.membershipId, membershipId))
      .limit(1);
    const member = rows[0];
    if (member === undefined) {
      throw new ItotoriAuthMemberManagementRepositoryError(
        `membership ${membershipId} does not exist`,
      );
    }
    return { ...member, permissionSetIds: [] };
  }

  async recordAuditEvent(
    db: Pick<ItotoriDatabase, "insert"> | MemberTransaction,
    input: {
      actorPrincipalId: string;
      action: (typeof authAuditEventActionValues)[keyof typeof authAuditEventActionValues];
      targetPrincipalId?: string | undefined;
      accountId?: string | undefined;
      invitationId?: string | undefined;
      targetEmail?: string | undefined;
      permission?: Permission | undefined;
      permissionSetId?: string | undefined;
      reason?: string | undefined;
      requestId?: string | undefined;
    },
  ): Promise<void> {
    await db.insert(authAuditEvents).values({
      authAuditEventId: `auth-audit-${randomUUID()}`,
      actorPrincipalId: input.actorPrincipalId,
      action: input.action,
      ...(input.targetPrincipalId !== undefined
        ? { targetPrincipalId: input.targetPrincipalId }
        : {}),
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.invitationId !== undefined ? { invitationId: input.invitationId } : {}),
      ...(input.targetEmail !== undefined ? { targetEmail: input.targetEmail } : {}),
      ...(input.permission !== undefined ? { permission: input.permission } : {}),
      ...(input.permissionSetId !== undefined ? { permissionSetId: input.permissionSetId } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
  }

  invitationRecord(row: {
    invitationId: string;
    accountId: string;
    email: string;
    initialPermissionSetIds: string[];
    expiresAt: Date;
    acceptedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
  }): MemberInvitationRecord {
    return {
      invitationId: row.invitationId,
      accountId: row.accountId,
      email: row.email,
      initialPermissionSetIds: [...row.initialPermissionSetIds].sort(),
      expiresAt: row.expiresAt,
      acceptedAt: row.acceptedAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    };
  }
}

function normalizeEmailValue(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value.trim().toLowerCase();
}

export function normalizeEmail(value: string): string {
  assertNonEmpty(value, "email");
  const email = value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) {
    throw new ItotoriAuthMemberManagementRepositoryError("email must be a valid address");
  }
  return email;
}

export function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new ItotoriAuthMemberManagementRepositoryError(`${label} must be non-empty`);
  }
}

export function assertFuture(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ItotoriAuthMemberManagementRepositoryError(`${label} must be a valid date`);
  }
  if (value.getTime() <= Date.now()) {
    throw new ItotoriAuthMemberManagementRepositoryError(`${label} must be in the future`);
  }
}

export function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    assertNonEmpty(value, "permissionSetId");
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}
