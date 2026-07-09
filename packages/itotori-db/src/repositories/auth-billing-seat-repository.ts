import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  AuthorizationError,
  type AuthorizationActor,
  type Permission,
  permissionValues,
  requirePermission,
} from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  authAccountBillingSeats,
  authAccountMemberships,
  authAccounts,
  authInvitations,
  authPermissionSetPermissions,
  authPermissionSets,
  authPrincipalPermissionGrants,
  type AuthBillingPeriod,
} from "../schema.js";
import { ItotoriPrincipalRepository } from "./principal-repository.js";

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

async function requirePermissionForAccount(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  permission: Permission,
  accountId: string,
): Promise<void> {
  // Billing seat usage is always gated on auth.members.manage for the target account.
  // @repository-permission-gate ItotoriAuthBillingSeatRepository.loadSeatUsage authMembersManage
  await requirePermission(db, actor, permissionValues.authMembersManage);

  const identity = await new ItotoriPrincipalRepository(db).loadActorIdentity(actor);
  const targetAccount = identity.accounts.find((account) => account.accountId === accountId);
  if (targetAccount === undefined || !(await isAccountActive(db, accountId))) {
    throw new AuthorizationError(actor, permissionValues.authMembersManage);
  }

  if (
    identity.principalId !== null &&
    (await hasDirectPermission(db, identity.principalId, permissionValues.authMembersManage))
  ) {
    return;
  }
  if (
    await permissionSetsIncludePermission(
      db,
      targetAccount.permissionSetIds,
      permissionValues.authMembersManage,
    )
  ) {
    return;
  }
  throw new AuthorizationError(actor, permissionValues.authMembersManage);
}

async function hasDirectPermission(
  db: ItotoriDatabase,
  principalId: string,
  permission: Permission,
): Promise<boolean> {
  const rows = await db
    .select({ permission: authPrincipalPermissionGrants.permission })
    .from(authPrincipalPermissionGrants)
    .where(
      and(
        eq(authPrincipalPermissionGrants.principalId, principalId),
        eq(authPrincipalPermissionGrants.permission, permission),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function isAccountActive(db: ItotoriDatabase, accountId: string): Promise<boolean> {
  const rows = await db
    .select({ accountId: authAccounts.accountId })
    .from(authAccounts)
    .where(and(eq(authAccounts.accountId, accountId), isNull(authAccounts.disabledAt)))
    .limit(1);
  return rows.length > 0;
}

async function permissionSetsIncludePermission(
  db: ItotoriDatabase,
  permissionSetIds: readonly string[],
  permission: Permission,
): Promise<boolean> {
  if (permissionSetIds.length === 0) {
    return false;
  }
  const rows = await db
    .select({ permission: authPermissionSetPermissions.permission })
    .from(authPermissionSets)
    .innerJoin(
      authPermissionSetPermissions,
      eq(authPermissionSetPermissions.permissionSetId, authPermissionSets.permissionSetId),
    )
    .where(
      and(
        inArray(authPermissionSets.permissionSetId, [...permissionSetIds]),
        eq(authPermissionSetPermissions.permission, permission),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
