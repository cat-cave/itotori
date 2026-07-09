import { eq } from "drizzle-orm";
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
import { ItotoriAuthBillingSeatRepository } from "../src/repositories/auth-billing-seat-repository.js";
import { ItotoriPrincipalRepository } from "../src/repositories/principal-repository.js";
import { authAccountBillingSeats, authAccountMemberships, authInvitations } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("ItotoriAuthBillingSeatRepository", () => {
  it("loads an account plan and derives seat usage from memberships and open invitations", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
      await context.db
        .insert(authAccountBillingSeats)
        .values({
          accountId: defaultLocalAccountId,
          planId: "studio-pro",
          planName: "Studio Pro",
          seatLimit: 2,
          includedSeats: 2,
          billingPeriod: "annual",
        })
        .onConflictDoUpdate({
          target: authAccountBillingSeats.accountId,
          set: {
            planId: "studio-pro",
            planName: "Studio Pro",
            seatLimit: 2,
            includedSeats: 2,
            billingPeriod: "annual",
          },
        });
      await context.db.insert(authInvitations).values({
        invitationId: "invitation-seat-pending",
        accountId: defaultLocalAccountId,
        email: "pending@example.test",
        initialPermissionSetIds: [],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      await context.db.insert(authInvitations).values({
        invitationId: "invitation-seat-accepted",
        accountId: defaultLocalAccountId,
        email: "accepted@example.test",
        initialPermissionSetIds: [],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        acceptedAt: new Date(),
      });
      const repo = new ItotoriAuthBillingSeatRepository(context.db);

      const usage = await repo.loadSeatUsage(localActor, defaultLocalAccountId);

      expect(usage).toMatchObject({
        accountId: defaultLocalAccountId,
        planId: "studio-pro",
        planName: "Studio Pro",
        billingPeriod: "annual",
        seatLimit: 2,
        includedSeats: 2,
        usedSeats: 1,
        pendingInvitations: 1,
        availableSeats: 1,
        overSeatLimit: false,
      });
      expect(
        await context.db
          .select()
          .from(authAccountMemberships)
          .where(eq(authAccountMemberships.accountId, defaultLocalAccountId)),
      ).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it("denies a manager whose auth.members.manage grant belongs to another account", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
      const principalRepo = new ItotoriPrincipalRepository(context.db);
      await principalRepo.createAccount(localActor, {
        accountId: "account-seat-a",
        slug: "seat-a",
        name: "Seat A",
      });
      await principalRepo.createAccount(localActor, {
        accountId: "account-seat-b",
        slug: "seat-b",
        name: "Seat B",
      });
      await principalRepo.createPrincipal(localActor, {
        kind: "human_user",
        principalId: "principal-seat-manager-a",
        userId: "user-seat-manager-a",
        displayName: "Seat Manager A",
      });
      await context.db.insert(authAccountMemberships).values({
        membershipId: "membership-seat-manager-a",
        accountId: "account-seat-a",
        userId: "user-seat-manager-a",
      });
      await principalRepo.createPermissionSet(localActor, {
        actorPrincipalId: localOperatorPrincipalId,
        permissionSetId: "permission-set-seat-manager-a",
        accountId: "account-seat-a",
        name: "Seat Manager",
        permissions: [permissionValues.authMembersManage],
      });
      await principalRepo.grantPermissionSet(localActor, {
        actorPrincipalId: localOperatorPrincipalId,
        targetPrincipalId: "principal-seat-manager-a",
        permissionSetId: "permission-set-seat-manager-a",
      });
      const repo = new ItotoriAuthBillingSeatRepository(context.db);
      const managerActor: AuthorizationActor = { userId: "user-seat-manager-a" };

      await expect(repo.loadSeatUsage(managerActor, "account-seat-b")).rejects.toMatchObject(
        new AuthorizationError(managerActor, permissionValues.authMembersManage),
      );
    } finally {
      await context.close();
    }
  });
});
