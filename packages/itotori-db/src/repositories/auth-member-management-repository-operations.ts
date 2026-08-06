import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  type AuthorizationActor,
  isReservedAuthUserId,
  permissionValues,
  requirePermission,
} from "../authorization.js";
import { requireAuthMembersManageForAccount } from "../authorization-account-permission.js";
import type { ItotoriDatabase } from "../connection.js";

import {
  authAccountMemberships,
  authAuditEventActionValues,
  authExternalIdentities,
  authInvitations,
  authPermissionSets,
  authPrincipalPermissionSetGrants,
} from "../schema.js";
import {
  assertFuture,
  assertNonEmpty,
  AuthMemberManagementRepositorySupport,
  normalizeEmail,
  uniqueStrings,
} from "./auth-member-management-repository-support.js";
import {
  type AcceptMemberInvitationInput,
  type InviteMemberInput,
  ItotoriAuthMemberManagementRepositoryError,
  type MemberInvitationRecord,
  type MemberRecord,
  type RemoveMemberInput,
} from "./auth-member-management-repository-types.js";

export class AuthMemberManagementRepositoryOperations {
  private readonly support = new AuthMemberManagementRepositorySupport();

  constructor(private readonly db: ItotoriDatabase) {}

  async inviteMember(
    actor: AuthorizationActor,
    input: InviteMemberInput,
  ): Promise<MemberInvitationRecord> {
    // Unscoped gate first so missing-permission denials surface before input access.
    // @repository-permission-gate ItotoriAuthMemberManagementRepository.inviteMember authMembersManage
    await requirePermission(this.db, actor, permissionValues.authMembersManage);
    assertNonEmpty(input.accountId, "accountId");
    await requireAuthMembersManageForAccount(this.db, actor, input.accountId);
    const email = normalizeEmail(input.email);
    assertFuture(input.expiresAt, "expiresAt");
    const initialPermissionSetIds = uniqueStrings(input.initialPermissionSetIds ?? []);
    await this.support.requirePermissionSetsInAccount(
      this.db,
      input.accountId,
      initialPermissionSetIds,
    );
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
      await this.support.recordAuditEvent(tx, {
        actorPrincipalId: input.actorPrincipalId,
        accountId: input.accountId,
        invitationId,
        targetEmail: email,
        action: authAuditEventActionValues.invited,
        reason: input.reason,
        requestId: input.requestId,
      });
      return this.support.invitationRecord(invitation);
    });
  }

  async acceptInvitation(
    actor: AuthorizationActor,
    input: AcceptMemberInvitationInput,
  ): Promise<MemberRecord> {
    // Unscoped gate first so missing-permission denials surface before resource lookup.
    // @repository-permission-gate ItotoriAuthMemberManagementRepository.acceptInvitation authMembersManage
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
      const invitation = await this.support.claimOpenInvitation(tx, input.invitationId);
      // Account-scope chokepoint: the invitation's account must match the actor's grants.
      await requireAuthMembersManageForAccount(tx, actor, invitation.accountId);
      // Accept must be bound to the invited identity: the invited email is the
      // source of truth. A caller-supplied email that disagrees is rejected
      // rather than silently overriding the invitation address.
      if (suppliedEmail !== undefined && suppliedEmail !== invitation.email) {
        throw new ItotoriAuthMemberManagementRepositoryError(
          "supplied email does not match the invited address",
        );
      }
      const email = invitation.email;
      const user = await this.support.findOrCreateUser(tx, {
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
      const membership = await this.support.ensureMembership(tx, invitation.accountId, user.userId);
      await this.support.requirePermissionSetsInAccount(
        tx,
        invitation.accountId,
        invitation.initialPermissionSetIds,
      );
      await this.support.recordAuditEvent(tx, {
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
          await this.support.recordAuditEvent(tx, {
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
    // Unscoped gate first so missing-permission denials surface before account lookup.
    // @repository-permission-gate ItotoriAuthMemberManagementRepository.listMembers authMembersManage
    await requirePermission(this.db, actor, permissionValues.authMembersManage);
    assertNonEmpty(accountId, "accountId");
    await requireAuthMembersManageForAccount(this.db, actor, accountId);
    return this.support.listMembersForAccount(this.db, accountId);
  }

  async removeMember(actor: AuthorizationActor, input: RemoveMemberInput): Promise<MemberRecord> {
    // Unscoped gate first so missing-permission denials surface before resource lookup.
    // @repository-permission-gate ItotoriAuthMemberManagementRepository.removeMember authMembersManage
    await requirePermission(this.db, actor, permissionValues.authMembersManage);
    assertNonEmpty(input.membershipId, "membershipId");
    return this.db.transaction(async (tx) => {
      const member = await this.support.requireMemberByMembershipId(tx, input.membershipId);
      // Account-scope chokepoint: the membership's account must match the actor's grants.
      await requireAuthMembersManageForAccount(tx, actor, member.accountId);
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
        await this.support.recordAuditEvent(tx, {
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
      await this.support.recordAuditEvent(tx, {
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
}
