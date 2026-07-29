import type { ItotoriDatabase } from "./connection.js";
import {
  authAccountMemberships,
  authAccounts,
  authPermissionSetPermissions,
  authPermissionSets,
  authPrincipalPermissionSetGrants,
  authPrincipals,
  authUsers,
} from "./schema.js";

// Source of truth for permission values. SQL migration constraints must be
// updated to match these constants; see docs/permissions.md.
import {
  allPermissions,
  type AuthorizationActor,
  defaultLocalAccountId,
  defaultLocalAccountName,
  defaultLocalAccountSlug,
  defaultPermissionSetId,
  localOperatorAllPermissionsSetDescription,
  localOperatorAllPermissionsSetId,
  localOperatorAllPermissionsSetName,
  localOperatorDisplayName,
  localOperatorMembershipId,
  localOperatorPrincipalId,
  localOperatorUserId,
} from "./authorization-01.js";
import { defaultPermissionSetSeeds } from "./authorization-03.js";

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
