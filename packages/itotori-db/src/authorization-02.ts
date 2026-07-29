import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { ItotoriDatabase } from "./connection.js";
import {
  authExternalIdentityProviderClaims,
  authExternalIdentities,
  authPermissionSetPermissions,
  authPermissionSets,
  authProviderClaimPermissionMappings,
  authPrincipalPermissionGrants,
  authPrincipalPermissionSetGrants,
  authPrincipals,
  authSessions,
  authUsers,
} from "./schema.js";

// Source of truth for permission values. SQL migration constraints must be
// updated to match these constants; see docs/permissions.md.
import {
  type ExternalIdentityProviderClaim,
  type Permission,
  ProviderClaimQuarantineError,
  resolveActiveAccountContext,
} from "./authorization-01.js";
import { normalizeProviderClaims, providerClaimKey } from "./authorization-03.js";

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
export async function isActiveSession(
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
 * Record external IdP claims as quarantined, untrusted input.
 *
 * These rows are deliberately NOT read by `requirePermission` or
 * `resolvePrincipalEffectivePermissions`; recording a provider role/group/scope
 * cannot authorize anything by itself.
 */
export async function quarantineExternalIdentityProviderClaims(
  db: ItotoriDatabase,
  input: {
    externalIdentityId: string;
    claims: readonly ExternalIdentityProviderClaim[];
  },
): Promise<void> {
  const claims = normalizeProviderClaims(input.claims);
  if (claims.length === 0) {
    return;
  }
  await db
    .insert(authExternalIdentityProviderClaims)
    .values(
      claims.map((claim) => ({
        externalIdentityId: input.externalIdentityId,
        claimKind: claim.kind,
        claimValue: claim.value,
      })),
    )
    .onConflictDoUpdate({
      target: [
        authExternalIdentityProviderClaims.externalIdentityId,
        authExternalIdentityProviderClaims.claimKind,
        authExternalIdentityProviderClaims.claimValue,
      ],
      set: { lastSeenAt: new Date() },
    });
}

/**
 * Login reconciliation for provider claims.
 *
 * The function first quarantines the presented roles/groups/scopes. It then
 * checks for explicit admin-created claim mappings and materializes those
 * mappings as ordinary direct permission grant rows for the linked principal.
 * Provider claims themselves still confer no permission; the existing grant
 * resolver remains the only authorization path.
 *
 * @returns the direct permissions materialized from matching mappings.
 */
export async function applyMappedProviderClaimGrants(
  db: ItotoriDatabase,
  input: {
    externalIdentityId: string;
    claims: readonly ExternalIdentityProviderClaim[];
  },
): Promise<Permission[]> {
  const claims = normalizeProviderClaims(input.claims);
  const identityRows = await db
    .select({
      provider: authExternalIdentities.provider,
      principalId: authUsers.principalId,
    })
    .from(authExternalIdentities)
    .innerJoin(authUsers, eq(authUsers.userId, authExternalIdentities.userId))
    .where(eq(authExternalIdentities.externalIdentityId, input.externalIdentityId))
    .limit(1);
  const identity = identityRows[0];
  if (identity === undefined) {
    throw new ProviderClaimQuarantineError(
      `external identity ${input.externalIdentityId} does not exist`,
    );
  }

  await quarantineExternalIdentityProviderClaims(db, {
    externalIdentityId: input.externalIdentityId,
    claims,
  });
  if (claims.length === 0) {
    return [];
  }

  const claimKeys = new Set(claims.map(providerClaimKey));
  const candidateMappings = await db
    .select({
      claimKind: authProviderClaimPermissionMappings.claimKind,
      claimValue: authProviderClaimPermissionMappings.claimValue,
      permission: authProviderClaimPermissionMappings.permission,
    })
    .from(authProviderClaimPermissionMappings)
    .where(
      and(
        eq(authProviderClaimPermissionMappings.provider, identity.provider),
        inArray(
          authProviderClaimPermissionMappings.claimValue,
          claims.map((claim) => claim.value),
        ),
      ),
    );
  const mappedPermissions = [
    ...new Set(
      candidateMappings
        .filter((mapping) =>
          claimKeys.has(providerClaimKey({ kind: mapping.claimKind, value: mapping.claimValue })),
        )
        .map((mapping) => mapping.permission),
    ),
  ].sort();

  for (const permission of mappedPermissions) {
    await db
      .insert(authPrincipalPermissionGrants)
      .values({ principalId: identity.principalId, permission })
      .onConflictDoNothing();
  }
  return mappedPermissions;
}
