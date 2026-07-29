import { and, eq } from "drizzle-orm";
import type { ItotoriDatabase } from "./connection.js";
import {
  authExternalIdentities,
  authProviderClaimKindValues,
  authUsers,
  userPermissionGrants,
  users,
} from "./schema.js";

// Source of truth for permission values. SQL migration constraints must be
// updated to match these constants; see docs/permissions.md.
import {
  allPermissions,
  type AuthorizationActor,
  AuthorizationError,
  type ExternalIdentityProviderClaim,
  localUserDisplayName,
  localUserId,
  type Permission,
  permissionValues,
  ProviderClaimQuarantineError,
} from "./authorization-01.js";
import { isActiveSession, resolvePrincipalEffectivePermissions } from "./authorization-02.js";

export function normalizeProviderClaims(
  claims: readonly ExternalIdentityProviderClaim[],
): ExternalIdentityProviderClaim[] {
  const allowedKinds = new Set<string>(Object.values(authProviderClaimKindValues));
  const seen = new Set<string>();
  const normalized: ExternalIdentityProviderClaim[] = [];
  for (const claim of claims) {
    if (!allowedKinds.has(claim.kind)) {
      throw new ProviderClaimQuarantineError(`unsupported provider claim kind ${claim.kind}`);
    }
    if (claim.value.trim().length === 0) {
      throw new ProviderClaimQuarantineError("provider claim value must be non-empty");
    }
    const key = providerClaimKey(claim);
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(claim);
    }
  }
  return normalized;
}

export function providerClaimKey(claim: ExternalIdentityProviderClaim): string {
  return `${claim.kind}\0${claim.value}`;
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
    description: "Read-only project-context and catalog access.",
    permissions: [permissionValues.queueRead, permissionValues.catalogRead],
  },
  {
    key: "contributor",
    name: "Contributor",
    description: "Contribute drafts, feedback, style-guide changes, and catalog context.",
    permissions: [
      permissionValues.draftWrite,
      permissionValues.feedbackImport,
      permissionValues.styleGuideApprove,
      permissionValues.catalogRead,
    ],
  },
  {
    key: "director",
    name: "Director",
    description:
      "Broad localization authority: import, draft, approve, and export, plus catalog curation.",
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
