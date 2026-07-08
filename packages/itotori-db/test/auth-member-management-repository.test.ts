import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  bootstrapDefaultAccountPrincipal,
  bootstrapLocalUser,
  defaultLocalAccountId,
  localOperatorPrincipalId,
  localUserId,
  permissionValues,
  type AuthorizationActor,
} from "../src/authorization.js";
import { ItotoriAuthMemberManagementRepository } from "../src/repositories/auth-member-management-repository.js";
import { ItotoriPrincipalRepository } from "../src/repositories/principal-repository.js";
import {
  authAccountMemberships,
  authAuditEvents,
  authExternalIdentities,
  authInvitations,
  authPrincipalPermissionSetGrants,
  authUsers,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };

describe("ItotoriAuthMemberManagementRepository", () => {
  it("invites, accepts, lists, and removes a member with initial permission sets and audit trail", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
      const principalRepo = new ItotoriPrincipalRepository(context.db);
      await principalRepo.createPermissionSet(localActor, {
        actorPrincipalId: localOperatorPrincipalId,
        permissionSetId: "permission-set-member-editor",
        accountId: defaultLocalAccountId,
        name: "Member editor",
        permissions: [permissionValues.queueRead],
      });
      const repo = new ItotoriAuthMemberManagementRepository(context.db);

      const invitation = await repo.inviteMember(localActor, {
        actorPrincipalId: localOperatorPrincipalId,
        accountId: defaultLocalAccountId,
        email: "New.Member@Example.TEST",
        initialPermissionSetIds: ["permission-set-member-editor"],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        reason: "project onboarding",
        requestId: "req-member-invite",
      });

      expect(invitation).toMatchObject({
        accountId: defaultLocalAccountId,
        email: "new.member@example.test",
        initialPermissionSetIds: ["permission-set-member-editor"],
      });

      const accepted = await repo.acceptInvitation(localActor, {
        actorPrincipalId: localOperatorPrincipalId,
        invitationId: invitation.invitationId,
        userId: "user-new-member",
        principalId: "principal-new-member",
        displayName: "New Member",
        externalIdentity: { provider: "zitadel", subject: "sub-new-member" },
        reason: "accepted invite",
        requestId: "req-member-accept",
      });

      expect(accepted).toMatchObject({
        accountId: defaultLocalAccountId,
        userId: "user-new-member",
        principalId: "principal-new-member",
        email: "new.member@example.test",
        displayName: "New Member",
        permissionSetIds: ["permission-set-member-editor"],
      });
      expect(
        await principalRepo.resolvePrincipalPermissions(localActor, "principal-new-member"),
      ).toEqual([permissionValues.queueRead]);

      const identityRows = await context.db
        .select()
        .from(authExternalIdentities)
        .where(eq(authExternalIdentities.userId, "user-new-member"));
      expect(identityRows).toHaveLength(1);

      const listed = await repo.listMembers(localActor, defaultLocalAccountId);
      expect(listed.find((member) => member.userId === "user-new-member")).toMatchObject({
        membershipId: accepted.membershipId,
        permissionSetIds: ["permission-set-member-editor"],
      });

      const removed = await repo.removeMember(localActor, {
        actorPrincipalId: localOperatorPrincipalId,
        membershipId: accepted.membershipId,
        reason: "offboarding",
        requestId: "req-member-remove",
      });
      expect(removed).toMatchObject({
        userId: "user-new-member",
        permissionSetIds: ["permission-set-member-editor"],
      });
      expect(
        await context.db
          .select()
          .from(authAccountMemberships)
          .where(eq(authAccountMemberships.membershipId, accepted.membershipId)),
      ).toHaveLength(0);
      expect(
        await context.db
          .select()
          .from(authPrincipalPermissionSetGrants)
          .where(eq(authPrincipalPermissionSetGrants.principalId, "principal-new-member")),
      ).toHaveLength(0);

      const auditRows = await context.db
        .select()
        .from(authAuditEvents)
        .where(eq(authAuditEvents.targetEmail, "new.member@example.test"));
      expect(auditRows.map((row) => row.action).sort()).toEqual(
        ["accepted", "granted", "invited", "removed", "revoked"].sort(),
      );
      expect(auditRows.every((row) => row.actorPrincipalId === localOperatorPrincipalId)).toBe(
        true,
      );
    } finally {
      await context.close();
    }
  });

  it("rolls back user and membership creation when invitation acceptance cannot grant sets", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
      const repo = new ItotoriAuthMemberManagementRepository(context.db);
      await context.db.insert(authInvitations).values({
        invitationId: "invitation-bad-set",
        accountId: defaultLocalAccountId,
        email: "rollback@example.test",
        initialPermissionSetIds: ["permission-set-missing"],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      await expect(
        repo.acceptInvitation(localActor, {
          actorPrincipalId: localOperatorPrincipalId,
          invitationId: "invitation-bad-set",
          userId: "user-rollback",
          principalId: "principal-rollback",
          displayName: "Rollback",
        }),
      ).rejects.toThrow(/permission set permission-set-missing does not exist/u);

      expect(
        await context.db.select().from(authUsers).where(eq(authUsers.userId, "user-rollback")),
      ).toHaveLength(0);
      expect(
        await context.db
          .select()
          .from(authAccountMemberships)
          .where(
            and(
              eq(authAccountMemberships.accountId, defaultLocalAccountId),
              eq(authAccountMemberships.userId, "user-rollback"),
            ),
          ),
      ).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("allows exactly one of two concurrent accepts to create the membership and grants", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
      const principalRepo = new ItotoriPrincipalRepository(context.db);
      await principalRepo.createPermissionSet(localActor, {
        actorPrincipalId: localOperatorPrincipalId,
        permissionSetId: "permission-set-race",
        accountId: defaultLocalAccountId,
        name: "Race editor",
        permissions: [permissionValues.queueRead],
      });
      const repo = new ItotoriAuthMemberManagementRepository(context.db);

      const invitation = await repo.inviteMember(localActor, {
        actorPrincipalId: localOperatorPrincipalId,
        accountId: defaultLocalAccountId,
        email: "race@example.test",
        initialPermissionSetIds: ["permission-set-race"],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        reason: "race",
        requestId: "req-race-invite",
      });

      const accept = (suffix: string) =>
        repo.acceptInvitation(localActor, {
          actorPrincipalId: localOperatorPrincipalId,
          invitationId: invitation.invitationId,
          displayName: "Race Member",
          email: "race@example.test",
          reason: `accept-${suffix}`,
          requestId: `req-race-accept-${suffix}`,
        });

      const results = await Promise.allSettled([accept("a"), accept("b")]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const loser = rejected[0];
      if (loser?.status === "rejected") {
        expect(String(loser.reason)).toMatch(/already been accepted/u);
      }

      const memberships = await context.db
        .select()
        .from(authAccountMemberships)
        .where(eq(authAccountMemberships.accountId, defaultLocalAccountId));
      const raceMemberships = memberships.filter(
        (row) => row.userId !== localUserId && row.userId !== undefined,
      );
      // Exactly one membership was created for the invited email (localUserId is
      // the bootstrapped operator, which owns its own membership row).
      const winner = fulfilled[0];
      if (winner?.status === "fulfilled") {
        expect(
          raceMemberships.filter((row) => row.membershipId === winner.value.membershipId),
        ).toHaveLength(1);
        const grants = await context.db
          .select()
          .from(authPrincipalPermissionSetGrants)
          .where(eq(authPrincipalPermissionSetGrants.principalId, winner.value.principalId));
        expect(grants).toHaveLength(1);
      }

      // Belt-and-suspenders: total membership/grant count for the invited email is
      // exactly 1, so a second sneaked-in membership is caught even if the
      // fulfilled/rejected split looked right.
      const invitedUsers = await context.db
        .select()
        .from(authUsers)
        .where(eq(authUsers.email, "race@example.test"));
      expect(invitedUsers).toHaveLength(1);
      const invitedUserIds = invitedUsers.map((row) => row.userId);
      const invitedMemberships = raceMemberships.filter((row) =>
        invitedUserIds.includes(row.userId),
      );
      expect(invitedMemberships).toHaveLength(1);
      const invitedPrincipalIds = invitedUsers.map((row) => row.principalId);
      const allInvitedGrants = (
        await Promise.all(
          invitedPrincipalIds.map((principalId) =>
            context.db
              .select()
              .from(authPrincipalPermissionSetGrants)
              .where(eq(authPrincipalPermissionSetGrants.principalId, principalId)),
          ),
        )
      ).flat();
      expect(allInvitedGrants).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it("rejects an accept whose supplied email does not match the invited address", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
      const repo = new ItotoriAuthMemberManagementRepository(context.db);

      const invitation = await repo.inviteMember(localActor, {
        actorPrincipalId: localOperatorPrincipalId,
        accountId: defaultLocalAccountId,
        email: "invited@example.test",
        initialPermissionSetIds: [],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        reason: "identity",
        requestId: "req-identity-invite",
      });

      await expect(
        repo.acceptInvitation(localActor, {
          actorPrincipalId: localOperatorPrincipalId,
          invitationId: invitation.invitationId,
          userId: "user-attacker",
          principalId: "principal-attacker",
          displayName: "Attacker",
          email: "attacker@example.test",
        }),
      ).rejects.toThrow(/supplied email does not match the invited address/u);

      expect(
        await context.db.select().from(authUsers).where(eq(authUsers.userId, "user-attacker")),
      ).toHaveLength(0);
      expect(
        await context.db
          .select()
          .from(authAccountMemberships)
          .where(eq(authAccountMemberships.userId, "user-attacker")),
      ).toHaveLength(0);
      // The invitation is still open (the failed accept rolled back its claim).
      const invitationRows = await context.db
        .select()
        .from(authInvitations)
        .where(eq(authInvitations.invitationId, invitation.invitationId));
      expect(invitationRows[0]?.acceptedAt).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("rejects binding an existing user whose email differs from the invited address", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
      const repo = new ItotoriAuthMemberManagementRepository(context.db);

      // First, an unrelated existing member accepts their own invite.
      const otherInvite = await repo.inviteMember(localActor, {
        actorPrincipalId: localOperatorPrincipalId,
        accountId: defaultLocalAccountId,
        email: "other@example.test",
        initialPermissionSetIds: [],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        reason: "other",
        requestId: "req-other-invite",
      });
      const other = await repo.acceptInvitation(localActor, {
        actorPrincipalId: localOperatorPrincipalId,
        invitationId: otherInvite.invitationId,
        userId: "user-other",
        principalId: "principal-other",
        displayName: "Other",
        email: "other@example.test",
      });

      // A new invite for a different email may not be bound to the existing user.
      const targetInvite = await repo.inviteMember(localActor, {
        actorPrincipalId: localOperatorPrincipalId,
        accountId: defaultLocalAccountId,
        email: "target@example.test",
        initialPermissionSetIds: [],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        reason: "target",
        requestId: "req-target-invite",
      });

      await expect(
        repo.acceptInvitation(localActor, {
          actorPrincipalId: localOperatorPrincipalId,
          invitationId: targetInvite.invitationId,
          userId: other.userId,
          displayName: "Other",
          email: "target@example.test",
        }),
      ).rejects.toThrow(/resolved user does not match the invited identity/u);

      const targetRows = await context.db
        .select()
        .from(authInvitations)
        .where(eq(authInvitations.invitationId, targetInvite.invitationId));
      expect(targetRows[0]?.acceptedAt).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("denies member lifecycle operations without auth.members.manage", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
      const repo = new ItotoriAuthMemberManagementRepository(context.db);

      await expect(repo.listMembers(deniedActor, defaultLocalAccountId)).rejects.toMatchObject(
        new AuthorizationError(deniedActor, permissionValues.authMembersManage),
      );
    } finally {
      await context.close();
    }
  });
});
