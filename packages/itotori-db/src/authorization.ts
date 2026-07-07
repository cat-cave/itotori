import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { ItotoriDatabase } from "./connection.js";
import {
  type AuthPrincipalKind,
  authAccountMemberships,
  authAccounts,
  authExternalIdentities,
  authPermissionSetPermissions,
  authPermissionSets,
  authPrincipalPermissionGrants,
  authPrincipalPermissionSetGrants,
  authPrincipals,
  authServicePrincipals,
  authSessions,
  authUsers,
  userPermissionGrants,
  users,
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
  catalogRead: "catalog.read",
  catalogWrite: "catalog.write",
  auditWrite: "audit.write",
  styleGuideApprove: "style_guide.approve",
  authAdmin: "auth.admin",
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
  permissionValues.catalogRead,
  permissionValues.catalogWrite,
  permissionValues.auditWrite,
  permissionValues.styleGuideApprove,
  permissionValues.authAdmin,
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

/**
 * The principal's ACTIVE account context: the ids of the accounts it belongs to
 * whose own `disabled_at IS NULL`. A human user belongs via
 * `itotori_auth_account_memberships` (a user may belong to several accounts); a
 * service principal belongs to exactly one account (`service_principals.account_id`)
 * and only while its own `disabled_at IS NULL`. A disabled account is excluded,
 * so a permission set owned by a disabled account contributes nothing.
 */
async function resolveActiveAccountContext(
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
export async function resolvePrincipalEffectivePermissions(
  db: ItotoriDatabase,
  principalId: string,
): Promise<Set<Permission>> {
  const principalRows = await db
    .select({
      principalKind: authPrincipals.principalKind,
      disabledAt: authPrincipals.disabledAt,
    })
    .from(authPrincipals)
    .where(eq(authPrincipals.principalId, principalId))
    .limit(1);
  const principal = principalRows[0];
  // A missing or disabled principal authorizes nothing.
  if (principal === undefined || principal.disabledAt !== null) {
    return new Set<Permission>();
  }

  const activeAccountIds = await resolveActiveAccountContext(
    db,
    principalId,
    principal.principalKind,
  );
  // A service principal belongs to exactly one account; an empty active-account
  // context means its own or its account's `disabled_at` is set, so it is inert.
  if (principal.principalKind === "service_principal" && activeAccountIds.size === 0) {
    return new Set<Permission>();
  }

  const directRows = await db
    .select({ permission: authPrincipalPermissionGrants.permission })
    .from(authPrincipalPermissionGrants)
    .where(eq(authPrincipalPermissionGrants.principalId, principalId));

  const setGrantRows = await db
    .select({
      permissionSetId: authPrincipalPermissionSetGrants.permissionSetId,
      accountId: authPermissionSets.accountId,
    })
    .from(authPrincipalPermissionSetGrants)
    .innerJoin(
      authPermissionSets,
      eq(authPermissionSets.permissionSetId, authPrincipalPermissionSetGrants.permissionSetId),
    )
    .where(eq(authPrincipalPermissionSetGrants.principalId, principalId));
  // Only sets whose owning account is in the principal's active account context.
  const eligibleSetIds = setGrantRows
    .filter((row) => activeAccountIds.has(row.accountId))
    .map((row) => row.permissionSetId);

  const setPermissionRows =
    eligibleSetIds.length === 0
      ? []
      : await db
          .select({ permission: authPermissionSetPermissions.permission })
          .from(authPermissionSetPermissions)
          .where(inArray(authPermissionSetPermissions.permissionSetId, eligibleSetIds));

  const permissions = new Set<Permission>();
  for (const row of directRows) {
    permissions.add(row.permission);
  }
  for (const row of setPermissionRows) {
    permissions.add(row.permission);
  }
  return permissions;
}

/**
 * Whether `sessionId` is a currently-usable session for `principalId`: it exists,
 * belongs to the principal, is not revoked (`revoked_at IS NULL`), and has not
 * expired (`expires_at > now()`).
 */
async function isActiveSession(
  db: ItotoriDatabase,
  sessionId: string,
  principalId: string,
): Promise<boolean> {
  const rows = await db
    .select({ sessionId: authSessions.sessionId })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.sessionId, sessionId),
        eq(authSessions.principalId, principalId),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Authorize `actor` for `permission` or throw. A permission is authorized iff a
 * persisted grant row (legacy, principal-direct, or via a granted permission
 * set) contains it AND the actor clears every security boundary below.
 *
 *   1. NAMESPACE BOUNDARY (userId-collision fix) — the legacy single-user
 *      direct-grant table (`itotori_user_permission_grants`, keyed by `userId`,
 *      where the bootstrap `local-user` holds every permission) is consulted
 *      ONLY for actors that are NOT backed by an external identity provider. An
 *      actor whose `userId` has an `itotori_auth_external_identities` link
 *      authorizes EXCLUSIVELY through its principal grants, so a provider-linked
 *      identity can never inherit a legacy/bootstrap grant that merely shares
 *      its raw userId. (The bootstrap ids are additionally reserved out of
 *      `itotori_auth_users` — see `reservedAuthUserIds` / migration 0061 — so
 *      the collision cannot be constructed in the first place.)
 *   2. The multi-user principal layer: the actor's `userId` is mapped to its
 *      principal (`itotori_auth_users`), whose effective permissions (direct
 *      grants + account-scoped, expanded permission-set grants) are resolved by
 *      `resolvePrincipalEffectivePermissions`.
 *   3. ACTIVE-SUBJECT BOUNDARY — a disabled principal / account / service
 *      principal authorizes nothing (enforced inside the resolver of record),
 *      and if the actor presents a `sessionId` it must belong to the principal
 *      and be neither revoked nor expired (enforced here). A revoked/expired
 *      session authorizes nothing even when the principal holds the permission.
 *
 * Authorization is ALWAYS an exact-match against a persisted grant row. An
 * OIDC/SAML identity only links a provider subject to a `userId`; it carries no
 * permissions of its own. Absent a qualifying grant this throws.
 */
export async function requirePermission(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  permission: Permission,
): Promise<void> {
  const principalRows = await db
    .select({ principalId: authUsers.principalId })
    .from(authUsers)
    .where(eq(authUsers.userId, actor.userId))
    .limit(1);
  const principalId = principalRows[0]?.principalId;

  // NAMESPACE BOUNDARY: skip the legacy table entirely for provider-backed
  // actors so a provider-linked userId can never inherit a bootstrap grant.
  const externalProviderBacked =
    principalId !== undefined &&
    (
      await db
        .select({ externalIdentityId: authExternalIdentities.externalIdentityId })
        .from(authExternalIdentities)
        .where(eq(authExternalIdentities.userId, actor.userId))
        .limit(1)
    ).length > 0;

  if (!externalProviderBacked) {
    const legacyGrant = await db
      .select({ permission: userPermissionGrants.permission })
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.userId, actor.userId),
          eq(userPermissionGrants.permission, permission),
        ),
      )
      .limit(1);
    if (legacyGrant.length > 0) {
      return;
    }
  }

  if (principalId !== undefined) {
    // ACTIVE-SUBJECT BOUNDARY (session leg): a presented session must be valid
    // for this principal, else deny outright.
    if (
      actor.sessionId !== undefined &&
      !(await isActiveSession(db, actor.sessionId, principalId))
    ) {
      throw new AuthorizationError(actor, permission);
    }
    const effective = await resolvePrincipalEffectivePermissions(db, principalId);
    if (effective.has(permission)) {
      return;
    }
  }

  throw new AuthorizationError(actor, permission);
}

export async function bootstrapLocalUser(db: ItotoriDatabase): Promise<AuthorizationActor> {
  await db
    .insert(users)
    .values({ userId: localUserId, displayName: localUserDisplayName })
    .onConflictDoNothing();

  for (const permission of allPermissions) {
    await db
      .insert(userPermissionGrants)
      .values({ userId: localUserId, permission })
      .onConflictDoNothing();
  }

  return { userId: localUserId };
}

/**
 * Least-privilege default permission sets, expressed as DATA.
 *
 * These are NOT roles and NOT code constants that authorization branches on.
 * Each entry is the seed content of a `permission_set` row: a `name` LABEL plus
 * the concrete `Permission` values that make up the bundle. `seedDefaultPermissionSets`
 * writes them as editable data rows for a given account; from then on they are
 * ordinary permission sets that admins can rename, add/remove permissions on, or
 * delete via the gated CRUD in `ItotoriPrincipalRepository`. A principal granted
 * one resolves to exactly the permissions listed here (via
 * `resolvePrincipalEffectivePermissions`) — nothing ever compares the `name`.
 *
 * The `key` is a stable, account-scoped id suffix (so the same seed in two
 * accounts gets distinct set ids); it is likewise a data label, never branched
 * on.
 */
export const defaultPermissionSetSeeds = [
  {
    key: "viewer",
    name: "Viewer",
    description: "Read-only reviewer-queue and catalog access.",
    permissions: [permissionValues.queueRead, permissionValues.catalogRead],
  },
  {
    key: "reviewer",
    name: "Reviewer",
    description: "Review drafts, manage the reviewer queue, and approve style guides.",
    permissions: [
      permissionValues.draftWrite,
      permissionValues.queueRead,
      permissionValues.queueManage,
      permissionValues.styleGuideApprove,
    ],
  },
  {
    key: "director",
    name: "Director",
    description:
      "Broad localization authority: import, draft, review, approve, and export, plus catalog curation.",
    permissions: [
      permissionValues.projectImport,
      permissionValues.draftWrite,
      permissionValues.patchExport,
      permissionValues.queueRead,
      permissionValues.queueManage,
      permissionValues.styleGuideApprove,
      permissionValues.catalogRead,
      permissionValues.catalogWrite,
    ],
  },
] as const satisfies readonly {
  key: string;
  name: string;
  description: string;
  permissions: readonly Permission[];
}[];

/** The account-scoped `permission_set_id` a seed materializes to. */
export function defaultPermissionSetId(accountId: string, key: string): string {
  return `permission-set-${accountId}-${key}`;
}

/**
 * Idempotently materialize the least-privilege `defaultPermissionSetSeeds` as
 * editable DATA rows for `accountId`. This is a bootstrap (like
 * `bootstrapLocalUser`), not a gated mutation: it seeds starter data an admin
 * then edits through the gated CRUD. The rows are ordinary permission sets — the
 * names are labels, resolution is purely by the seeded permissions.
 */
export async function seedDefaultPermissionSets(
  db: ItotoriDatabase,
  options: { accountId: string },
): Promise<void> {
  for (const seed of defaultPermissionSetSeeds) {
    const permissionSetId = defaultPermissionSetId(options.accountId, seed.key);
    await db
      .insert(authPermissionSets)
      .values({
        permissionSetId,
        accountId: options.accountId,
        name: seed.name,
        description: seed.description,
      })
      .onConflictDoNothing();
    for (const permission of seed.permissions) {
      await db
        .insert(authPermissionSetPermissions)
        .values({ permissionSetId, permission })
        .onConflictDoNothing();
    }
  }
}

/**
 * auth-003 — migrate the single local operator into the multi-user model.
 *
 * Idempotently materialize, as ordinary DATA rows, the multi-user REPRESENTATION
 * of the local operator:
 *
 *   - ONE default local account (`defaultLocalAccountId`);
 *   - ONE human-user PRINCIPAL under a NON-reserved userId
 *     (`localOperatorUserId`, distinct from the reserved `local-user`), linked
 *     to the account by a membership;
 *   - an editable, account-scoped ALL-permissions set granted to that principal.
 *
 * The operator principal then resolves EVERY permission through its granted set
 * (via `resolvePrincipalEffectivePermissions`), account-scope boundary included:
 * it belongs to the account, the set is owned by that account, so the grant is
 * eligible. Authorization is entirely through the principal/permission-set
 * layer; the operator does NOT rely on the legacy `itotori_user_permission_grants`
 * table.
 *
 * This is a BOOTSTRAP (like `bootstrapLocalUser` / `seedDefaultPermissionSets`),
 * not a gated mutation, and is fully idempotent (every insert is
 * `onConflictDoNothing`). It is INTENTIONALLY separate from `migrate()` /
 * `bootstrapLocalUser`: the plain migrate path seeds only the legacy substrate,
 * so tests that assert an empty multi-user layer after migration stay valid. The
 * application bootstrap (`withDatabaseItotoriServices`) runs this alongside
 * `bootstrapLocalUser` so the real operator runtime has both the legacy actor
 * and its multi-user principal.
 *
 * RECONCILIATION WITH THE 0061 RESERVATION: the reserved `local-user` is never
 * registered in `itotori_auth_users`; this creates a SEPARATE, non-colliding
 * `localOperatorUserId` principal instead. The reservation CHECK is untouched
 * and still rejects any attempt to register `local-user` as a principal.
 *
 * @returns the operator's multi-user authorization actor.
 */
export async function bootstrapDefaultAccountPrincipal(
  db: ItotoriDatabase,
): Promise<AuthorizationActor> {
  await db
    .insert(authAccounts)
    .values({
      accountId: defaultLocalAccountId,
      slug: defaultLocalAccountSlug,
      name: defaultLocalAccountName,
    })
    .onConflictDoNothing();

  await db
    .insert(authPrincipals)
    .values({ principalId: localOperatorPrincipalId, principalKind: "human_user" })
    .onConflictDoNothing();

  await db
    .insert(authUsers)
    .values({
      userId: localOperatorUserId,
      principalId: localOperatorPrincipalId,
      displayName: localOperatorDisplayName,
    })
    .onConflictDoNothing();

  await db
    .insert(authAccountMemberships)
    .values({
      membershipId: localOperatorMembershipId,
      accountId: defaultLocalAccountId,
      userId: localOperatorUserId,
    })
    .onConflictDoNothing();

  const permissionSetId = localOperatorAllPermissionsSetId();
  await db
    .insert(authPermissionSets)
    .values({
      permissionSetId,
      accountId: defaultLocalAccountId,
      name: localOperatorAllPermissionsSetName,
      description: localOperatorAllPermissionsSetDescription,
    })
    .onConflictDoNothing();
  for (const permission of allPermissions) {
    await db
      .insert(authPermissionSetPermissions)
      .values({ permissionSetId, permission })
      .onConflictDoNothing();
  }

  await db
    .insert(authPrincipalPermissionSetGrants)
    .values({ principalId: localOperatorPrincipalId, permissionSetId })
    .onConflictDoNothing();

  return { userId: localOperatorUserId };
}
