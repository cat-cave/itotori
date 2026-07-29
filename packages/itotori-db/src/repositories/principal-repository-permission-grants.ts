import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { resolvePrincipalEffectivePermissions, type Permission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  authAccountMemberships,
  authAuditEventActionValues,
  authAuditEvents,
  authPermissionSets,
  authPrincipalPermissionGrants,
  authPrincipalPermissionSetGrants,
  authPrincipals,
  authProviderClaimPermissionMappings,
  authServicePrincipals,
  authUsers,
} from "../schema.js";
import { ItotoriPrincipalRepositoryError } from "./principal-repository-types.js";
import type {
  GrantDirectPermissionInput,
  GrantPermissionSetInput,
  MapProviderClaimToDirectPermissionInput,
  RevokeDirectPermissionInput,
  RevokePermissionSetInput,
} from "./principal-repository-types.js";

type PrincipalTransaction = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];

export async function grantPermissionSet(
  db: ItotoriDatabase,
  input: GrantPermissionSetInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const setRows = await tx
      .select({ accountId: authPermissionSets.accountId })
      .from(authPermissionSets)
      .where(eq(authPermissionSets.permissionSetId, input.permissionSetId))
      .limit(1);
    const setAccountId = setRows[0]?.accountId;
    if (setAccountId === undefined) {
      throw new ItotoriPrincipalRepositoryError(
        `permission set ${input.permissionSetId} does not exist`,
      );
    }
    const targetAccountIds = await principalAccountIds(tx, input.targetPrincipalId);
    if (!targetAccountIds.has(setAccountId)) {
      throw new ItotoriPrincipalRepositoryError(
        `permission set ${input.permissionSetId} belongs to account ${setAccountId}, which ` +
          `principal ${input.targetPrincipalId} is not a member of; a permission set may only ` +
          "be granted within the principal's own account (cross-account grant refused)",
      );
    }
    await tx.insert(authPrincipalPermissionSetGrants).values({
      principalId: input.targetPrincipalId,
      permissionSetId: input.permissionSetId,
    });
    await recordAuditEvent(tx, {
      actorPrincipalId: input.actorPrincipalId,
      targetPrincipalId: input.targetPrincipalId,
      action: authAuditEventActionValues.granted,
      permissionSetId: input.permissionSetId,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
  });
}

export async function revokePermissionSet(
  db: ItotoriDatabase,
  input: RevokePermissionSetInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(authPrincipalPermissionSetGrants)
      .where(
        and(
          eq(authPrincipalPermissionSetGrants.principalId, input.targetPrincipalId),
          eq(authPrincipalPermissionSetGrants.permissionSetId, input.permissionSetId),
        ),
      )
      .returning({ principalId: authPrincipalPermissionSetGrants.principalId });
    if (deleted.length === 0) {
      throw new ItotoriPrincipalRepositoryError(
        `permission set ${input.permissionSetId} is not granted to principal ` +
          `${input.targetPrincipalId}; nothing to revoke`,
      );
    }
    await recordAuditEvent(tx, {
      actorPrincipalId: input.actorPrincipalId,
      targetPrincipalId: input.targetPrincipalId,
      action: authAuditEventActionValues.revoked,
      permissionSetId: input.permissionSetId,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
  });
}

export async function grantDirectPermission(
  db: ItotoriDatabase,
  input: GrantDirectPermissionInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(authPrincipalPermissionGrants).values({
      principalId: input.targetPrincipalId,
      permission: input.permission,
    });
    await recordAuditEvent(tx, {
      actorPrincipalId: input.actorPrincipalId,
      targetPrincipalId: input.targetPrincipalId,
      action: authAuditEventActionValues.granted,
      permission: input.permission,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
  });
}

export async function mapProviderClaimToDirectPermission(
  db: ItotoriDatabase,
  input: MapProviderClaimToDirectPermissionInput,
): Promise<void> {
  if (input.claimValue.trim().length === 0) {
    throw new ItotoriPrincipalRepositoryError("provider claim value must be non-empty");
  }
  await db.insert(authProviderClaimPermissionMappings).values({
    provider: input.provider,
    claimKind: input.claimKind,
    claimValue: input.claimValue,
    permission: input.permission,
    createdByPrincipalId: input.actorPrincipalId,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });
}

export async function revokeDirectPermission(
  db: ItotoriDatabase,
  input: RevokeDirectPermissionInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(authPrincipalPermissionGrants)
      .where(
        and(
          eq(authPrincipalPermissionGrants.principalId, input.targetPrincipalId),
          eq(authPrincipalPermissionGrants.permission, input.permission),
        ),
      )
      .returning({ principalId: authPrincipalPermissionGrants.principalId });
    if (deleted.length === 0) {
      throw new ItotoriPrincipalRepositoryError(
        `direct permission ${input.permission} is not granted to principal ` +
          `${input.targetPrincipalId}; nothing to revoke`,
      );
    }
    await recordAuditEvent(tx, {
      actorPrincipalId: input.actorPrincipalId,
      targetPrincipalId: input.targetPrincipalId,
      action: authAuditEventActionValues.revoked,
      permission: input.permission,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
  });
}

export async function resolvePrincipalPermissions(
  db: ItotoriDatabase,
  principalId: string,
): Promise<Permission[]> {
  const permissions = await resolvePrincipalEffectivePermissions(db, principalId);
  return [...permissions].sort();
}

async function principalAccountIds(
  tx: PrincipalTransaction,
  principalId: string,
): Promise<Set<string>> {
  const principalRows = await tx
    .select({ principalKind: authPrincipals.principalKind })
    .from(authPrincipals)
    .where(eq(authPrincipals.principalId, principalId))
    .limit(1);
  const kind = principalRows[0]?.principalKind;
  if (kind === undefined) {
    throw new ItotoriPrincipalRepositoryError(`principal ${principalId} does not exist`);
  }
  if (kind === "service_principal") {
    const rows = await tx
      .select({ accountId: authServicePrincipals.accountId })
      .from(authServicePrincipals)
      .where(eq(authServicePrincipals.principalId, principalId));
    return new Set(rows.map((row) => row.accountId));
  }
  const rows = await tx
    .select({ accountId: authAccountMemberships.accountId })
    .from(authAccountMemberships)
    .innerJoin(authUsers, eq(authUsers.userId, authAccountMemberships.userId))
    .where(eq(authUsers.principalId, principalId));
  return new Set(rows.map((row) => row.accountId));
}

async function recordAuditEvent(
  tx: PrincipalTransaction,
  input: {
    actorPrincipalId: string;
    targetPrincipalId: string;
    action: (typeof authAuditEventActionValues)[keyof typeof authAuditEventActionValues];
    permission?: Permission;
    permissionSetId?: string;
    reason?: string;
    requestId?: string;
  },
): Promise<void> {
  await tx.insert(authAuditEvents).values({
    authAuditEventId: `auth-audit-${randomUUID()}`,
    actorPrincipalId: input.actorPrincipalId,
    targetPrincipalId: input.targetPrincipalId,
    action: input.action,
    ...(input.permission !== undefined ? { permission: input.permission } : {}),
    ...(input.permissionSetId !== undefined ? { permissionSetId: input.permissionSetId } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });
}
