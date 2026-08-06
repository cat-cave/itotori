import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  AuthorizationError,
  type AuthorizationActor,
  type Permission,
  permissionValues,
  requirePermission,
} from "./authorization.js";
import type { ItotoriDatabase } from "./connection.js";
import {
  authAccounts,
  authPermissionSetPermissions,
  authPermissionSets,
  authPrincipalPermissionGrants,
} from "./schema.js";
import { loadActorIdentity } from "./repositories/principal-repository-identities.js";

/**
 * Require `permission` for operations scoped to a concrete account.
 *
 * Holds only when:
 * 1. the actor holds the permission at all (via `requirePermission`);
 * 2. the actor is an active member of `accountId`;
 * 3. the permission is either a direct principal grant (operator-style) or
 *    comes from a permission set owned by that same account.
 *
 * This is the cross-tenant chokepoint for membership, seat, and similar
 * account-scoped administration. A grant that only lives under account A never
 * authorizes actions against account B.
 */
export async function requirePermissionForAccount(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  permission: Permission,
  accountId: string,
): Promise<void> {
  await requirePermission(db, actor, permission);

  const identity = await loadActorIdentity(db, actor.userId);
  const targetAccount = identity.accounts.find((account) => account.accountId === accountId);
  if (targetAccount === undefined || !(await isAccountActive(db, accountId))) {
    throw new AuthorizationError(actor, permission);
  }

  if (
    identity.principalId !== null &&
    (await hasDirectPermission(db, identity.principalId, permission))
  ) {
    return;
  }
  if (await permissionSetsIncludePermission(db, targetAccount.permissionSetIds, permission)) {
    return;
  }
  throw new AuthorizationError(actor, permission);
}

export async function requireAuthMembersManageForAccount(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  accountId: string,
): Promise<void> {
  await requirePermissionForAccount(db, actor, permissionValues.authMembersManage, accountId);
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
        inArray(authPermissionSetPermissions.permissionSetId, [...permissionSetIds]),
        eq(authPermissionSetPermissions.permission, permission),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
