import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import { requirePermissionForAccount } from "../authorization-account-permission.js";
import type { ItotoriDatabase } from "../connection.js";

import {
  authAccountBillingSeats,
  authAccountMemberships,
  authAccounts,
  authInvitations,
  type AuthBillingPeriod,
} from "../schema.js";

const defaultBillingPlan = {
  planId: "studio-team",
  planName: "Studio Team",
  seatLimit: 5,
  includedSeats: 5,
  billingPeriod: "monthly" as const,
};

export type AuthAccountSeatUsageRecord = {
  accountId: string;
  planId: string;
  planName: string;
  billingPeriod: AuthBillingPeriod;
  seatLimit: number;
  includedSeats: number;
  usedSeats: number;
  pendingInvitations: number;
  availableSeats: number;
  overSeatLimit: boolean;
  updatedAt: Date;
};

export class ItotoriAuthBillingSeatRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItotoriAuthBillingSeatRepositoryError";
  }
}

export class ItotoriAuthBillingSeatRepository {
  constructor(private readonly db: ItotoriDatabase) {}

  async loadSeatUsage(
    actor: AuthorizationActor,
    accountId: string,
  ): Promise<AuthAccountSeatUsageRecord> {
    assertNonEmpty(accountId, "accountId");
    const plan = await this.ensureBillingPlan(actor, accountId);
    const [usedSeats, pendingInvitations] = await Promise.all([
      this.countActiveMemberships(accountId),
      this.countPendingInvitations(accountId),
    ]);
    const availableSeats = Math.max(0, plan.seatLimit - usedSeats);
    return {
      accountId,
      planId: plan.planId,
      planName: plan.planName,
      billingPeriod: plan.billingPeriod,
      seatLimit: plan.seatLimit,
      includedSeats: plan.includedSeats,
      usedSeats,
      pendingInvitations,
      availableSeats,
      overSeatLimit: usedSeats > plan.seatLimit,
      updatedAt: plan.updatedAt,
    };
  }

  private async ensureBillingPlan(
    actor: AuthorizationActor,
    accountId: string,
  ): Promise<{
    planId: string;
    planName: string;
    billingPeriod: AuthBillingPeriod;
    seatLimit: number;
    includedSeats: number;
    updatedAt: Date;
  }> {
    // Unscoped gate first so source-gate scanning and missing-permission denials
    // surface before account membership lookup.
    // @repository-permission-gate ItotoriAuthBillingSeatRepository.loadSeatUsage authMembersManage
    await requirePermission(this.db, actor, permissionValues.authMembersManage);
    await requirePermissionForAccount(
      this.db,
      actor,
      permissionValues.authMembersManage,
      accountId,
    );
    const accountRows = await this.db
      .select({ accountId: authAccounts.accountId })
      .from(authAccounts)
      .where(eq(authAccounts.accountId, accountId))
      .limit(1);
    if (accountRows[0] === undefined) {
      throw new ItotoriAuthBillingSeatRepositoryError(`account ${accountId} does not exist`);
    }
    const inserted = await this.db
      .insert(authAccountBillingSeats)
      .values({ accountId, ...defaultBillingPlan })
      .onConflictDoNothing()
      .returning();
    const rows =
      inserted.length > 0
        ? inserted
        : await this.db
            .select()
            .from(authAccountBillingSeats)
            .where(eq(authAccountBillingSeats.accountId, accountId))
            .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ItotoriAuthBillingSeatRepositoryError(
        `billing seat plan for account ${accountId} was not created`,
      );
    }
    return {
      planId: row.planId,
      planName: row.planName,
      billingPeriod: row.billingPeriod,
      seatLimit: row.seatLimit,
      includedSeats: row.includedSeats,
      updatedAt: row.updatedAt,
    };
  }

  private async countActiveMemberships(accountId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(authAccountMemberships)
      .where(eq(authAccountMemberships.accountId, accountId));
    return rows[0]?.count ?? 0;
  }

  private async countPendingInvitations(accountId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(authInvitations)
      .where(
        and(
          eq(authInvitations.accountId, accountId),
          isNull(authInvitations.acceptedAt),
          isNull(authInvitations.revokedAt),
          gt(authInvitations.expiresAt, new Date()),
        ),
      );
    return rows[0]?.count ?? 0;
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new ItotoriAuthBillingSeatRepositoryError(`${field} is required`);
  }
}
