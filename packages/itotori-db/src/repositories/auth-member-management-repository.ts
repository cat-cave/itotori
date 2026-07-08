import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  type AuthorizationActor,
  isReservedAuthUserId,
  type Permission,
  permissionValues,
  requirePermission,
} from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  authAccountMemberships,
  authAuditEventActionValues,
  authAuditEvents,
  authExternalIdentities,
  authInvitations,
  authPermissionSets,
  authPrincipalKindValues,
  authPrincipalPermissionSetGrants,
  authPrincipals,
  authUsers,
} from "../schema.js";

export type InviteMemberInput = {
  actorPrincipalId: string;
  accountId: string;
  email: string;
  initialPermissionSetIds?: readonly string[];
  expiresAt: Date;
  reason?: string;
  requestId?: string;
};

export type AcceptMemberInvitationInput = {
  actorPrincipalId: string;
  invitationId: string;
  userId?: string;
  principalId?: string;
  displayName: string;
  email?: string;
  externalIdentity?: {
    provider: string;
    subject: string;
  };
  reason?: string;
  requestId?: string;
};

export type RemoveMemberInput = {
  actorPrincipalId: string;
  membershipId: string;
  reason?: string;
  requestId?: string;
};

export type MemberInvitationRecord = {
  invitationId: string;
  accountId: string;
  email: string;
  initialPermissionSetIds: string[];
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export type MemberRecord = {
  membershipId: string;
  accountId: string;
  userId: string;
  principalId: string;
  email: string | null;
  displayName: string;
  permissionSetIds: string[];
  createdAt: Date;
};

export interface ItotoriAuthMemberManagementRepositoryPort {
  inviteMember(
    actor: AuthorizationActor,
    input: InviteMemberInput,
  ): Promise<MemberInvitationRecord>;
  acceptInvitation(
    actor: AuthorizationActor,
    input: AcceptMemberInvitationInput,
  ): Promise<MemberRecord>;
  listMembers(actor: AuthorizationActor, accountId: string): Promise<MemberRecord[]>;
  removeMember(actor: AuthorizationActor, input: RemoveMemberInput): Promise<MemberRecord>;
}

export class ItotoriAuthMemberManagementRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItotoriAuthMemberManagementRepositoryError";
  }
}

type MemberTransaction = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];

export class ItotoriAuthMemberManagementRepository implements ItotoriAuthMemberManagementRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async inviteMember(
    actor: AuthorizationActor,
    input: InviteMemberInput,
  ): Promise<MemberInvitationRecord> {
    await requirePermission(this.db, actor, permissionValues.authMembersManage);
    const email = normalizeEmail(input.email);
    assertNonEmpty(input.accountId, "accountId");
    assertFuture(input.expiresAt, "expiresAt");
    const initialPermissionSetIds = uniqueStrings(input.initialPermissionSetIds ?? []);
    await this.requirePermissionSetsInAccount(this.db, input.accountId, initialPermissionSetIds);
    const invitationId = `auth-invitation-${randomUUID()}`;
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(authInvitations)
        .values({
          invitationId,
          accountId: input.accountId,
          email,
          initialPermissionSetIds,
          expiresAt: input.expiresAt,
        })
        .returning();
      const invitation = rows[0];
      if (invitation === undefined) {
        throw new ItotoriAuthMemberManagementRepositoryError("member invitation was not created");
      }
      await this.recordAuditEvent(tx, {
        actorPrincipalId: input.actorPrincipalId,
        accountId: input.accountId,
        invitationId,
        targetEmail: email,
        action: authAuditEventActionValues.invited,
        reason: input.reason,
        requestId: input.requestId,
      });
      return invitationRecord(invitation);
    });
  }

  async acceptInvitation(
    actor: AuthorizationActor,
    input: AcceptMemberInvitationInput,
  ): Promise<MemberRecord> {
    await requirePermission(this.db, actor, permissionValues.authMembersManage);
    assertNonEmpty(input.invitationId, "invitationId");
    assertNonEmpty(input.displayName, "displayName");
    if (input.userId !== undefined && isReservedAuthUserId(input.userId)) {
      throw new ItotoriAuthMemberManagementRepositoryError(
        `userId ${input.userId} is reserved for the legacy single-user substrate`,
      );
    }
    const suppliedEmail = input.email === undefined ? undefined : normalizeEmail(input.email);
    return this.db.transaction(async (tx) => {
      const invitation = await this.claimOpenInvitation(tx, input.invitationId);
      // Accept must be bound to the invited identity: the invited email is the
      // source of truth. A caller-supplied email that disagrees is rejected
      // rather than silently overriding the invitation address.
      if (suppliedEmail !== undefined && suppliedEmail !== invitation.email) {
        throw new ItotoriAuthMemberManagementRepositoryError(
          "supplied email does not match the invited address",
        );
      }
      const email = invitation.email;
      const user = await this.findOrCreateUser(tx, {
        email,
        displayName: input.displayName,
        userId: input.userId,
        principalId: input.principalId,
      });
      if (input.externalIdentity !== undefined) {
        assertNonEmpty(input.externalIdentity.provider, "externalIdentity.provider");
        assertNonEmpty(input.externalIdentity.subject, "externalIdentity.subject");
        await tx
          .insert(authExternalIdentities)
          .values({
            externalIdentityId: `external-identity-${randomUUID()}`,
            userId: user.userId,
            provider: input.externalIdentity.provider,
            subject: input.externalIdentity.subject,
          })
          .onConflictDoNothing();
      }
      const membership = await this.ensureMembership(tx, invitation.accountId, user.userId);
      await this.requirePermissionSetsInAccount(
        tx,
        invitation.accountId,
        invitation.initialPermissionSetIds,
      );
      await this.recordAuditEvent(tx, {
        actorPrincipalId: input.actorPrincipalId,
        targetPrincipalId: user.principalId,
        accountId: invitation.accountId,
        invitationId: invitation.invitationId,
        targetEmail: email,
        action: authAuditEventActionValues.accepted,
        reason: input.reason,
        requestId: input.requestId,
      });
      for (const permissionSetId of invitation.initialPermissionSetIds) {
        const inserted = await tx
          .insert(authPrincipalPermissionSetGrants)
          .values({ principalId: user.principalId, permissionSetId })
          .onConflictDoNothing()
          .returning({ permissionSetId: authPrincipalPermissionSetGrants.permissionSetId });
        if (inserted.length > 0) {
          await this.recordAuditEvent(tx, {
            actorPrincipalId: input.actorPrincipalId,
            targetPrincipalId: user.principalId,
            accountId: invitation.accountId,
            invitationId: invitation.invitationId,
            targetEmail: email,
            action: authAuditEventActionValues.granted,
            permissionSetId,
            reason: input.reason,
            requestId: input.requestId,
          });
        }
      }
      return {
        ...membership,
        principalId: user.principalId,
        email: user.email,
        displayName: user.displayName,
        permissionSetIds: [...invitation.initialPermissionSetIds].sort(),
      };
    });
  }

  async listMembers(actor: AuthorizationActor, accountId: string): Promise<MemberRecord[]> {
    await requirePermission(this.db, actor, permissionValues.authMembersManage);
    assertNonEmpty(accountId, "accountId");
    return this.listMembersForAccount(this.db, accountId);
  }

  async removeMember(actor: AuthorizationActor, input: RemoveMemberInput): Promise<MemberRecord> {
    await requirePermission(this.db, actor, permissionValues.authMembersManage);
    assertNonEmpty(input.membershipId, "membershipId");
    return this.db.transaction(async (tx) => {
      const member = await this.requireMemberByMembershipId(tx, input.membershipId);
      const grants = await tx
        .select({ permissionSetId: authPrincipalPermissionSetGrants.permissionSetId })
        .from(authPrincipalPermissionSetGrants)
        .innerJoin(
          authPermissionSets,
          eq(authPermissionSets.permissionSetId, authPrincipalPermissionSetGrants.permissionSetId),
        )
        .where(
          and(
            eq(authPrincipalPermissionSetGrants.principalId, member.principalId),
            eq(authPermissionSets.accountId, member.accountId),
          ),
        );
      for (const grant of grants) {
        await tx
          .delete(authPrincipalPermissionSetGrants)
          .where(
            and(
              eq(authPrincipalPermissionSetGrants.principalId, member.principalId),
              eq(authPrincipalPermissionSetGrants.permissionSetId, grant.permissionSetId),
            ),
          );
        await this.recordAuditEvent(tx, {
          actorPrincipalId: input.actorPrincipalId,
          targetPrincipalId: member.principalId,
          accountId: member.accountId,
          targetEmail: member.email ?? undefined,
          action: authAuditEventActionValues.revoked,
          permissionSetId: grant.permissionSetId,
          reason: input.reason,
          requestId: input.requestId,
        });
      }
      await tx
        .delete(authAccountMemberships)
        .where(eq(authAccountMemberships.membershipId, input.membershipId));
      await this.recordAuditEvent(tx, {
        actorPrincipalId: input.actorPrincipalId,
        targetPrincipalId: member.principalId,
        accountId: member.accountId,
        targetEmail: member.email ?? undefined,
        action: authAuditEventActionValues.removed,
        reason: input.reason,
        requestId: input.requestId,
      });
      return { ...member, permissionSetIds: grants.map((grant) => grant.permissionSetId).sort() };
    });
  }

  private async findOrCreateUser(
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

  private async ensureMembership(
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
  private async claimOpenInvitation(
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
    return invitationRecord(invitation);
  }

  private async requirePermissionSetsInAccount(
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

  private async listMembersForAccount(
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

  private async requireMemberByMembershipId(
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

  private async recordAuditEvent(
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
}

function invitationRecord(row: {
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

function normalizeEmailValue(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value.trim().toLowerCase();
}

function normalizeEmail(value: string): string {
  assertNonEmpty(value, "email");
  const email = value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) {
    throw new ItotoriAuthMemberManagementRepositoryError("email must be a valid address");
  }
  return email;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new ItotoriAuthMemberManagementRepositoryError(`${label} must be non-empty`);
  }
}

function assertFuture(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ItotoriAuthMemberManagementRepositoryError(`${label} must be a valid date`);
  }
  if (value.getTime() <= Date.now()) {
    throw new ItotoriAuthMemberManagementRepositoryError(`${label} must be in the future`);
  }
}

function uniqueStrings(values: readonly string[]): string[] {
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

export const authMembersManagePermission = permissionValues.authMembersManage satisfies Permission;
