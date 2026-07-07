import { and, eq, inArray } from "drizzle-orm";
import type { ItotoriDatabase } from "./connection.js";
import {
  authPermissionSetPermissions,
  authPermissionSets,
  authPrincipalPermissionGrants,
  authPrincipalPermissionSetGrants,
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

export type AuthorizationActor = {
  userId: string;
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
 */
export async function resolvePrincipalEffectivePermissions(
  db: ItotoriDatabase,
  principalId: string,
): Promise<Set<Permission>> {
  const directRows = await db
    .select({ permission: authPrincipalPermissionGrants.permission })
    .from(authPrincipalPermissionGrants)
    .where(eq(authPrincipalPermissionGrants.principalId, principalId));

  const setIdRows = await db
    .select({ permissionSetId: authPrincipalPermissionSetGrants.permissionSetId })
    .from(authPrincipalPermissionSetGrants)
    .where(eq(authPrincipalPermissionSetGrants.principalId, principalId));
  const setIds = setIdRows.map((row) => row.permissionSetId);

  const setPermissionRows =
    setIds.length === 0
      ? []
      : await db
          .select({ permission: authPermissionSetPermissions.permission })
          .from(authPermissionSetPermissions)
          .where(inArray(authPermissionSetPermissions.permissionSetId, setIds));

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
 * Authorize `actor` for `permission` or throw. The actor's effective
 * permissions are the union of TWO grant sources, and a permission is
 * authorized iff at least one of them contains it:
 *
 *   1. The legacy single-user direct-grant table
 *      (`itotori_user_permission_grants`, keyed by `userId`) — how the bootstrap
 *      local user is granted; this path stays authoritative and unchanged.
 *   2. The multi-user principal layer: the actor's `userId` is mapped to its
 *      principal (`itotori_auth_users`), whose effective permissions (direct
 *      grants + expanded permission-set grants) are resolved by
 *      `resolvePrincipalEffectivePermissions`.
 *
 * Authorization is ALWAYS an exact-match against a persisted grant row. There is
 * no code path where an external-provider role / group / claim grants a
 * permission: an OIDC/SAML identity (`itotori_auth_external_identities`) only
 * links a provider subject to a `userId`; it carries no permissions. Absent a
 * grant row (legacy, direct, or via a granted permission set) the claim
 * authorizes nothing and this throws.
 */
export async function requirePermission(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  permission: Permission,
): Promise<void> {
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

  const principalRows = await db
    .select({ principalId: authUsers.principalId })
    .from(authUsers)
    .where(eq(authUsers.userId, actor.userId))
    .limit(1);
  const principalId = principalRows[0]?.principalId;
  if (principalId !== undefined) {
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
