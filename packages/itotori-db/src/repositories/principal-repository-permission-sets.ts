import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Permission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  authPermissionSetAuditActionValues,
  authPermissionSetAuditEvents,
  authPermissionSetPermissions,
  authPermissionSets,
  authPrincipalPermissionSetGrants,
} from "../schema.js";
import { ItotoriPrincipalRepositoryError } from "./principal-repository-types.js";
import type {
  AddPermissionToSetInput,
  CreatePermissionSetInput,
  DeletePermissionSetInput,
  PermissionSetRecord,
  RemovePermissionFromSetInput,
  RenamePermissionSetInput,
} from "./principal-repository-types.js";

type PrincipalTransaction = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];

export async function listAccountPermissionSets(
  db: ItotoriDatabase,
  accountId: string,
): Promise<PermissionSetRecord[]> {
  const sets = await db
    .select({
      permissionSetId: authPermissionSets.permissionSetId,
      accountId: authPermissionSets.accountId,
      name: authPermissionSets.name,
    })
    .from(authPermissionSets)
    .where(eq(authPermissionSets.accountId, accountId));
  const records: PermissionSetRecord[] = [];
  for (const set of sets) {
    const permissions = await db
      .select({ permission: authPermissionSetPermissions.permission })
      .from(authPermissionSetPermissions)
      .where(eq(authPermissionSetPermissions.permissionSetId, set.permissionSetId));
    records.push({
      permissionSetId: set.permissionSetId,
      accountId: set.accountId,
      name: set.name,
      permissions: permissions.map((row) => row.permission).sort(),
    });
  }
  return records.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.permissionSetId.localeCompare(right.permissionSetId),
  );
}

export async function loadPermissionSetAccountId(
  db: ItotoriDatabase,
  permissionSetId: string,
): Promise<string> {
  const rows = await db
    .select({ accountId: authPermissionSets.accountId })
    .from(authPermissionSets)
    .where(eq(authPermissionSets.permissionSetId, permissionSetId))
    .limit(1);
  const accountId = rows[0]?.accountId;
  if (accountId === undefined) {
    throw new ItotoriPrincipalRepositoryError(`permission set ${permissionSetId} does not exist`);
  }
  return accountId;
}

export async function createPermissionSet(
  db: ItotoriDatabase,
  input: CreatePermissionSetInput,
): Promise<PermissionSetRecord> {
  const permissions = [...new Set(input.permissions)];
  return db.transaction(async (tx) => {
    await tx.insert(authPermissionSets).values({
      permissionSetId: input.permissionSetId,
      accountId: input.accountId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
    if (permissions.length > 0) {
      await tx
        .insert(authPermissionSetPermissions)
        .values(
          permissions.map((permission) => ({ permissionSetId: input.permissionSetId, permission })),
        );
    }
    await recordSetAuditEvent(tx, {
      actorPrincipalId: input.actorPrincipalId,
      permissionSetId: input.permissionSetId,
      setName: input.name,
      action: authPermissionSetAuditActionValues.created,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    return {
      permissionSetId: input.permissionSetId,
      accountId: input.accountId,
      name: input.name,
      permissions,
    };
  });
}

export async function addPermissionToSet(
  db: ItotoriDatabase,
  input: AddPermissionToSetInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const set = await requirePermissionSet(tx, input.permissionSetId);
    await tx
      .insert(authPermissionSetPermissions)
      .values({ permissionSetId: input.permissionSetId, permission: input.permission })
      .onConflictDoNothing();
    await touchPermissionSet(tx, input.permissionSetId);
    await recordSetAuditEvent(tx, {
      actorPrincipalId: input.actorPrincipalId,
      permissionSetId: input.permissionSetId,
      setName: set.name,
      action: authPermissionSetAuditActionValues.permissionAdded,
      permission: input.permission,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
  });
}

export async function removePermissionFromSet(
  db: ItotoriDatabase,
  input: RemovePermissionFromSetInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const set = await requirePermissionSet(tx, input.permissionSetId);
    await tx
      .delete(authPermissionSetPermissions)
      .where(
        and(
          eq(authPermissionSetPermissions.permissionSetId, input.permissionSetId),
          eq(authPermissionSetPermissions.permission, input.permission),
        ),
      );
    await touchPermissionSet(tx, input.permissionSetId);
    await recordSetAuditEvent(tx, {
      actorPrincipalId: input.actorPrincipalId,
      permissionSetId: input.permissionSetId,
      setName: set.name,
      action: authPermissionSetAuditActionValues.permissionRemoved,
      permission: input.permission,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
  });
}

export async function renamePermissionSet(
  db: ItotoriDatabase,
  input: RenamePermissionSetInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    await requirePermissionSet(tx, input.permissionSetId);
    await tx
      .update(authPermissionSets)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(authPermissionSets.permissionSetId, input.permissionSetId));
    await recordSetAuditEvent(tx, {
      actorPrincipalId: input.actorPrincipalId,
      permissionSetId: input.permissionSetId,
      setName: input.name,
      action: authPermissionSetAuditActionValues.renamed,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
  });
}

export async function deletePermissionSet(
  db: ItotoriDatabase,
  input: DeletePermissionSetInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const set = await requirePermissionSet(tx, input.permissionSetId);
    const grants = await tx
      .select({ principalId: authPrincipalPermissionSetGrants.principalId })
      .from(authPrincipalPermissionSetGrants)
      .where(eq(authPrincipalPermissionSetGrants.permissionSetId, input.permissionSetId));
    if (grants.length > 0) {
      throw new ItotoriPrincipalRepositoryError(
        `permission set ${input.permissionSetId} is still granted to ${grants.length} ` +
          "principal(s); revoke the grants before deleting so no principal loses " +
          "authorization silently",
      );
    }
    await tx
      .delete(authPermissionSets)
      .where(eq(authPermissionSets.permissionSetId, input.permissionSetId));
    await recordSetAuditEvent(tx, {
      actorPrincipalId: input.actorPrincipalId,
      permissionSetId: input.permissionSetId,
      setName: set.name,
      action: authPermissionSetAuditActionValues.deleted,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
  });
}

async function requirePermissionSet(
  tx: PrincipalTransaction,
  permissionSetId: string,
): Promise<{ name: string }> {
  const rows = await tx
    .select({ name: authPermissionSets.name })
    .from(authPermissionSets)
    .where(eq(authPermissionSets.permissionSetId, permissionSetId))
    .limit(1);
  const set = rows[0];
  if (set === undefined) {
    throw new ItotoriPrincipalRepositoryError(`permission set ${permissionSetId} does not exist`);
  }
  return set;
}

async function touchPermissionSet(
  tx: PrincipalTransaction,
  permissionSetId: string,
): Promise<void> {
  await tx
    .update(authPermissionSets)
    .set({ updatedAt: new Date() })
    .where(eq(authPermissionSets.permissionSetId, permissionSetId));
}

async function recordSetAuditEvent(
  tx: PrincipalTransaction,
  input: {
    actorPrincipalId: string;
    permissionSetId: string;
    setName: string;
    action: (typeof authPermissionSetAuditActionValues)[keyof typeof authPermissionSetAuditActionValues];
    permission?: Permission;
    reason?: string;
    requestId?: string;
  },
): Promise<void> {
  await tx.insert(authPermissionSetAuditEvents).values({
    authPermissionSetAuditEventId: `auth-permission-set-audit-${randomUUID()}`,
    actorPrincipalId: input.actorPrincipalId,
    permissionSetId: input.permissionSetId,
    setName: input.setName,
    action: input.action,
    ...(input.permission !== undefined ? { permission: input.permission } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });
}
