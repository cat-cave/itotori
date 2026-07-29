import { and, eq, isNull } from "drizzle-orm";
import type { ItotoriDatabase } from "./connection.js";
import {
  type AuthPrincipalKind,
  type AuthProviderClaimKind,
  authAccountMemberships,
  authAccounts,
  authServicePrincipals,
  authUsers,
} from "./schema.js";

// Source of truth for permission values. SQL migration constraints must be
// updated to match these constants; see docs/permissions.md.
export const permissionValues = {
  projectImport: "project.import",
  draftWrite: "draft.write",
  patchExport: "patch.export",
  runtimeIngest: "runtime.ingest",
  feedbackImport: "feedback.import",
  queueManage: "queue.manage",
  queueRead: "queue.read",
  contentRead: "content.read",
  catalogRead: "catalog.read",
  catalogWrite: "catalog.write",
  auditWrite: "audit.write",
  styleGuideApprove: "style_guide.approve",
  authAdmin: "auth.admin",
  authSsoManage: "auth.sso.manage",
  authMembersManage: "auth.members.manage",
  authSessionsManage: "auth.sessions.manage",
  authPermissionsManage: "auth.permissions.manage",
  systemReset: "system.reset",
} as const;

export type Permission = (typeof permissionValues)[keyof typeof permissionValues];

export const allPermissions = [
  permissionValues.projectImport,
  permissionValues.draftWrite,
  permissionValues.patchExport,
  permissionValues.runtimeIngest,
  permissionValues.feedbackImport,
  permissionValues.queueManage,
  permissionValues.queueRead,
  permissionValues.contentRead,
  permissionValues.catalogRead,
  permissionValues.catalogWrite,
  permissionValues.auditWrite,
  permissionValues.styleGuideApprove,
  permissionValues.authAdmin,
  permissionValues.authSsoManage,
  permissionValues.authMembersManage,
  permissionValues.authSessionsManage,
  permissionValues.authPermissionsManage,
  permissionValues.systemReset,
] as const satisfies readonly Permission[];

export const localUserId = "local-user";
export const localUserDisplayName = "Local user";

/**
 * Raw userIds reserved for the legacy single-user substrate that MUST NOT be
 * re-registered as multi-user principals (`itotori_auth_users.user_id`).
 *
 * `itotori_user_permission_grants.user_id` (legacy, where the bootstrap
 * `local-user` holds every permission) and `itotori_auth_users.user_id` share
 * one raw-string namespace. If a principal could be created with the bootstrap
 * userId, an external identity linked to it would inherit the bootstrap
 * all-permissions grant through the legacy path. Reserving the bootstrap ids —
 * enforced by a DB CHECK on `itotori_auth_users` (migration 0061) and by
 * `createPrincipal` — makes that collision impossible at the source. See
 * `requirePermission` for the complementary provider-backed legacy-skip rule.
 */
export const reservedAuthUserIds = [localUserId] as const;

/** Whether `userId` is reserved for the legacy substrate (see above). */
export function isReservedAuthUserId(userId: string): boolean {
  return (reservedAuthUserIds as readonly string[]).includes(userId);
}

/**
 * The default local ACCOUNT + operator PRINCIPAL that represent the single
 * operator of a local install in the multi-user model (auth-003).
 *
 * The legacy `local-user` (above) keeps its every-permission direct grant in
 * `itotori_user_permission_grants` and stays a legacy-grant actor; it is
 * deliberately NOT registered in `itotori_auth_users` (reserved by migration
 * 0061). The multi-user REPRESENTATION of the same operator is a distinct
 * principal whose `userId` (`localOperatorUserId`) is intentionally different
 * from — and never collides with — the reserved `local-user`, so registering it
 * cannot trip the 0061 reservation. The operator resolves ALL permissions
 * through an editable, account-scoped ALL-permissions set granted to it, NOT
 * through the legacy table.
 */
export const defaultLocalAccountId = "account-local";
export const defaultLocalAccountSlug = "local";
export const defaultLocalAccountName = "Local workspace";

/**
 * The multi-user principal representation of the local operator. `userId` is
 * NON-reserved (distinct from `localUserId`) so it is a valid `auth_users` row.
 */
export const localOperatorUserId = "local-operator";
export const localOperatorPrincipalId = "principal-local-operator";
export const localOperatorDisplayName = "Local operator";
export const localOperatorMembershipId = "membership-local-operator";

/**
 * The account-scoped seed key for the editable ALL-permissions set granted to
 * the default operator principal. It is an ORDINARY permission set (an admin can
 * rename it, add/remove permissions, or delete it via the gated CRUD); the name
 * is a label and nothing branches on it. Unlike the least-privilege
 * `defaultPermissionSetSeeds`, this set intentionally carries every permission —
 * it is the multi-user equivalent of the legacy `local-user` all-grant.
 */
export const localOperatorAllPermissionsSetKey = "operator-all";
export const localOperatorAllPermissionsSetName = "Local operator (all permissions)";
export const localOperatorAllPermissionsSetDescription =
  "All-permissions bundle for the default local operator principal (editable).";

export function defaultPermissionSetId(accountId: string, key: string): string {
  return `permission-set-${accountId}-${key}`;
}

/** The permission-set id the operator's all-permissions bundle materializes to. */
export function localOperatorAllPermissionsSetId(): string {
  return defaultPermissionSetId(defaultLocalAccountId, localOperatorAllPermissionsSetKey);
}

export type AuthorizationActor = {
  userId: string;
  /**
   * Optional opaque session id. When present, authorization enforces the
   * ACTIVE-SUBJECT session boundary: the session must belong to the resolved
   * principal and be neither revoked nor expired. Legacy / local-user callers
   * carry no session and are unaffected.
   */
  sessionId?: string;
};

export class AuthorizationError extends Error {
  constructor(
    readonly actor: AuthorizationActor,
    readonly permission: Permission,
  ) {
    super(`user ${actor.userId} is missing permission ${permission}`);
    this.name = "AuthorizationError";
  }
}

export class ProviderClaimQuarantineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderClaimQuarantineError";
  }
}

export type ExternalIdentityProviderClaim = {
  kind: AuthProviderClaimKind;
  value: string;
};

/**
 * The principal's ACTIVE account context: the ids of the accounts it belongs to
 * whose own `disabled_at IS NULL`. A human user belongs via
 * `itotori_auth_account_memberships` (a user may belong to several accounts); a
 * service principal belongs to exactly one account (`service_principals.account_id`)
 * and only while its own `disabled_at IS NULL`. A disabled account is excluded,
 * so a permission set owned by a disabled account contributes nothing.
 */
export async function resolveActiveAccountContext(
  db: ItotoriDatabase,
  principalId: string,
  principalKind: AuthPrincipalKind,
): Promise<Set<string>> {
  if (principalKind === "service_principal") {
    const rows = await db
      .select({ accountId: authServicePrincipals.accountId })
      .from(authServicePrincipals)
      .innerJoin(authAccounts, eq(authAccounts.accountId, authServicePrincipals.accountId))
      .where(
        and(
          eq(authServicePrincipals.principalId, principalId),
          isNull(authServicePrincipals.disabledAt),
          isNull(authAccounts.disabledAt),
        ),
      );
    return new Set(rows.map((row) => row.accountId));
  }
  const rows = await db
    .select({ accountId: authAccountMemberships.accountId })
    .from(authAccountMemberships)
    .innerJoin(authUsers, eq(authUsers.userId, authAccountMemberships.userId))
    .innerJoin(authAccounts, eq(authAccounts.accountId, authAccountMemberships.accountId))
    .where(and(eq(authUsers.principalId, principalId), isNull(authAccounts.disabledAt)));
  return new Set(rows.map((row) => row.accountId));
}

/**
 * The single authoritative resolver of a principal's EFFECTIVE permissions: the
 * deduplicated union of its direct permission grants
 * (`itotori_auth_principal_permission_grants`) and the permissions of every
 * permission-set granted to it (`itotori_auth_principal_permission_set_grants`
 * expanded through `itotori_auth_permission_set_permissions`).
 *
 * This is UNGATED on purpose: it IS the primitive `requirePermission` consults
 * to make an authorization decision, so gating it on a permission would be
 * circular. Every gated read of a principal's permissions (e.g. the auth-admin
 * `resolvePrincipalPermissions` repository method) enforces its own permission
 * check and then delegates the actual union to this function, keeping ONE
 * resolver of record. A "permission set" is the only thing a role may be — a
 * data bundle of permission rows — and it resolves here to concrete
 * permissions; nothing branches on a role string.
 *
 * TWO security boundaries are enforced here so they hold for EVERY caller of the
 * resolver of record:
 *
 *   ACTIVE-SUBJECT BOUNDARY — a disabled principal
 *   (`itotori_auth_principals.disabled_at`) authorizes NOTHING. A service
 *   principal whose own `disabled_at` is set, or whose sole owning account is
 *   disabled, is fully inert. (The session leg of this boundary lives in
 *   `requirePermission`, since a session is an actor credential, not a property
 *   of the principal's grants.)
 *
 *   ACCOUNT-SCOPE BOUNDARY (cross-account escalation fix) — a permission set is
 *   account-scoped; a granted set contributes its permissions ONLY when the
 *   set's owning account is in the principal's ACTIVE account context. A set
 *   from ANOTHER account authorizes NOTHING even if a grant row exists, so a
 *   cross-account grant can never escalate privilege. Direct permission grants
 *   are not account-scoped and count for any active principal.
 */
