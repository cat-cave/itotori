// auth-001-principal-schema — thin repository over the multi-user principal /
// account / permission-set identity layer (migration 0059).
//
// It round-trips a principal (human user or service principal), a permission-set
// grant, and a direct permission grant, and resolves a principal's EFFECTIVE
// permissions as the UNION of its direct grants and the permissions of every
// permission-set granted to it.
//
// GOVERNING INVARIANT (docs/permissions.md): access control is PERMISSION-based,
// never role-based. A "role" is ONLY a permission_set (a data bundle of
// permission rows). Nothing here branches authorization on a role; every
// resolved authorization decision is an exact-match permission. Every mutation
// Account/principal administration stays gated on `auth.admin`; permission
// editor operations (grant/revoke direct permissions, grant/revoke permission
// sets, and edit permission sets) are gated on the narrower
// `auth.permissions.manage` permission.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  type AuthorizationActor,
  isReservedAuthUserId,
  type Permission,
  permissionValues,
  requirePermission,
  resolvePrincipalEffectivePermissions,
} from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  type AuthProviderClaimKind,
  type AuthPrincipalKind,
  authAccountMemberships,
  authAccounts,
  authAuditEventActionValues,
  authAuditEvents,
  authPermissionSetAuditActionValues,
  authPermissionSetAuditEvents,
  authPermissionSetPermissions,
  authPermissionSets,
  authProviderClaimPermissionMappings,
  authPrincipalPermissionGrants,
  authPrincipalPermissionSetGrants,
  authPrincipals,
  authServicePrincipals,
  authUsers,
} from "../schema.js";

export type CreateAccountInput = {
  accountId: string;
  slug: string;
  name: string;
};

export type AccountRecord = {
  accountId: string;
  slug: string;
  name: string;
};

/** Create a principal as EITHER a human user OR a service principal. */
export type CreatePrincipalInput =
  | {
      kind: "human_user";
      principalId: string;
      userId: string;
      displayName: string;
      email?: string;
    }
  | {
      kind: "service_principal";
      principalId: string;
      servicePrincipalId: string;
      accountId: string;
      displayName: string;
    };

export type PrincipalRecord = {
  principalId: string;
  principalKind: AuthPrincipalKind;
  displayName: string;
};

export type CreatePermissionSetInput = {
  actorPrincipalId: string;
  permissionSetId: string;
  accountId: string;
  name: string;
  description?: string;
  permissions: readonly Permission[];
  reason?: string;
  requestId?: string;
};

export type PermissionSetRecord = {
  permissionSetId: string;
  accountId: string;
  name: string;
  permissions: Permission[];
};

/** Add a single permission to an existing set (edits the bundle's DATA). */
export type AddPermissionToSetInput = {
  actorPrincipalId: string;
  permissionSetId: string;
  permission: Permission;
  reason?: string;
  requestId?: string;
};

/** Remove a single permission from an existing set (edits the bundle's DATA). */
export type RemovePermissionFromSetInput = {
  actorPrincipalId: string;
  permissionSetId: string;
  permission: Permission;
  reason?: string;
  requestId?: string;
};

/** Rename a permission set. The name is a label; nothing branches on it. */
export type RenamePermissionSetInput = {
  actorPrincipalId: string;
  permissionSetId: string;
  name: string;
  reason?: string;
  requestId?: string;
};

/** Delete a permission set (blocked while granted; see `deletePermissionSet`). */
export type DeletePermissionSetInput = {
  actorPrincipalId: string;
  permissionSetId: string;
  reason?: string;
  requestId?: string;
};

/** Grant a permission set (the "role assignment") to a principal. */
export type GrantPermissionSetInput = {
  actorPrincipalId: string;
  targetPrincipalId: string;
  permissionSetId: string;
  reason?: string;
  requestId?: string;
};

/** Grant a single direct exact-permission override to a principal. */
export type GrantDirectPermissionInput = {
  actorPrincipalId: string;
  targetPrincipalId: string;
  permission: Permission;
  reason?: string;
  requestId?: string;
};

/** Admin mapping from a quarantined provider claim to an exact permission grant. */
export type MapProviderClaimToDirectPermissionInput = {
  actorPrincipalId: string;
  provider: string;
  claimKind: AuthProviderClaimKind;
  claimValue: string;
  permission: Permission;
  reason?: string;
  requestId?: string;
};

/** Revoke a previously-granted permission set (the "role unassignment"). */
export type RevokePermissionSetInput = {
  actorPrincipalId: string;
  targetPrincipalId: string;
  permissionSetId: string;
  reason?: string;
  requestId?: string;
};

/** Revoke a single direct exact-permission override from a principal. */
export type RevokeDirectPermissionInput = {
  actorPrincipalId: string;
  targetPrincipalId: string;
  permission: Permission;
  reason?: string;
  requestId?: string;
};

export interface ItotoriPrincipalRepositoryPort {
  createAccount(actor: AuthorizationActor, input: CreateAccountInput): Promise<AccountRecord>;
  createPrincipal(actor: AuthorizationActor, input: CreatePrincipalInput): Promise<PrincipalRecord>;
  createPermissionSet(
    actor: AuthorizationActor,
    input: CreatePermissionSetInput,
  ): Promise<PermissionSetRecord>;
  addPermissionToSet(actor: AuthorizationActor, input: AddPermissionToSetInput): Promise<void>;
  removePermissionFromSet(
    actor: AuthorizationActor,
    input: RemovePermissionFromSetInput,
  ): Promise<void>;
  renamePermissionSet(actor: AuthorizationActor, input: RenamePermissionSetInput): Promise<void>;
  deletePermissionSet(actor: AuthorizationActor, input: DeletePermissionSetInput): Promise<void>;
  grantPermissionSet(actor: AuthorizationActor, input: GrantPermissionSetInput): Promise<void>;
  revokePermissionSet(actor: AuthorizationActor, input: RevokePermissionSetInput): Promise<void>;
  grantDirectPermission(
    actor: AuthorizationActor,
    input: GrantDirectPermissionInput,
  ): Promise<void>;
  mapProviderClaimToDirectPermission(
    actor: AuthorizationActor,
    input: MapProviderClaimToDirectPermissionInput,
  ): Promise<void>;
  revokeDirectPermission(
    actor: AuthorizationActor,
    input: RevokeDirectPermissionInput,
  ): Promise<void>;
  loadPrincipal(
    actor: AuthorizationActor,
    principalId: string,
  ): Promise<PrincipalRecord | undefined>;
  resolvePrincipalPermissions(
    actor: AuthorizationActor,
    principalId: string,
  ): Promise<Permission[]>;
}

export class ItotoriPrincipalRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItotoriPrincipalRepositoryError";
  }
}

/** The transaction handle drizzle passes to `db.transaction(async (tx) => …)`. */
type PrincipalTransaction = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];

export class ItotoriPrincipalRepository implements ItotoriPrincipalRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async createAccount(
    actor: AuthorizationActor,
    input: CreateAccountInput,
  ): Promise<AccountRecord> {
    await requirePermission(this.db, actor, permissionValues.authAdmin);
    await this.db.insert(authAccounts).values({
      accountId: input.accountId,
      slug: input.slug,
      name: input.name,
    });
    return { accountId: input.accountId, slug: input.slug, name: input.name };
  }

  async createPrincipal(
    actor: AuthorizationActor,
    input: CreatePrincipalInput,
  ): Promise<PrincipalRecord> {
    await requirePermission(this.db, actor, permissionValues.authAdmin);
    // NAMESPACE BOUNDARY (P1): the bootstrap/legacy userIds are reserved and may
    // never be registered as a multi-user principal, so a provider-linked
    // identity can never be created under a legacy grantee's raw userId and
    // inherit its bootstrap grants. The DB CHECK (migration 0061) is the
    // authoritative guard; this gives a precise, early error.
    if (input.kind === "human_user" && isReservedAuthUserId(input.userId)) {
      throw new ItotoriPrincipalRepositoryError(
        `userId ${input.userId} is reserved for the legacy single-user substrate and ` +
          "cannot be registered as an auth principal",
      );
    }
    return this.db.transaction(async (tx) => {
      await tx.insert(authPrincipals).values({
        principalId: input.principalId,
        principalKind: input.kind,
      });
      if (input.kind === "human_user") {
        await tx.insert(authUsers).values({
          userId: input.userId,
          principalId: input.principalId,
          displayName: input.displayName,
          ...(input.email !== undefined ? { email: input.email } : {}),
        });
      } else {
        await tx.insert(authServicePrincipals).values({
          servicePrincipalId: input.servicePrincipalId,
          principalId: input.principalId,
          accountId: input.accountId,
          displayName: input.displayName,
        });
      }
      return {
        principalId: input.principalId,
        principalKind: input.kind,
        displayName: input.displayName,
      };
    });
  }

  async createPermissionSet(
    actor: AuthorizationActor,
    input: CreatePermissionSetInput,
  ): Promise<PermissionSetRecord> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    const permissions = [...new Set(input.permissions)];
    return this.db.transaction(async (tx) => {
      await tx.insert(authPermissionSets).values({
        permissionSetId: input.permissionSetId,
        accountId: input.accountId,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
      if (permissions.length > 0) {
        await tx.insert(authPermissionSetPermissions).values(
          permissions.map((permission) => ({
            permissionSetId: input.permissionSetId,
            permission,
          })),
        );
      }
      await this.recordSetAuditEvent(tx, {
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

  /**
   * Add one permission to an existing set. This EDITS the set's DATA: because
   * `resolvePrincipalEffectivePermissions` expands granted sets at check time,
   * every principal the set is granted to immediately GAINS this permission.
   */
  async addPermissionToSet(
    actor: AuthorizationActor,
    input: AddPermissionToSetInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    await this.db.transaction(async (tx) => {
      const set = await this.requirePermissionSet(tx, input.permissionSetId);
      await tx
        .insert(authPermissionSetPermissions)
        .values({ permissionSetId: input.permissionSetId, permission: input.permission })
        .onConflictDoNothing();
      await this.touchPermissionSet(tx, input.permissionSetId);
      await this.recordSetAuditEvent(tx, {
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

  /**
   * Remove one permission from an existing set. Every principal the set is
   * granted to immediately LOSES this permission (unless it also holds it via a
   * direct grant or another granted set — resolution is a union).
   */
  async removePermissionFromSet(
    actor: AuthorizationActor,
    input: RemovePermissionFromSetInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    await this.db.transaction(async (tx) => {
      const set = await this.requirePermissionSet(tx, input.permissionSetId);
      await tx
        .delete(authPermissionSetPermissions)
        .where(
          and(
            eq(authPermissionSetPermissions.permissionSetId, input.permissionSetId),
            eq(authPermissionSetPermissions.permission, input.permission),
          ),
        );
      await this.touchPermissionSet(tx, input.permissionSetId);
      await this.recordSetAuditEvent(tx, {
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

  /** Rename a permission set. The name is a label; authorization never reads it. */
  async renamePermissionSet(
    actor: AuthorizationActor,
    input: RenamePermissionSetInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    await this.db.transaction(async (tx) => {
      await this.requirePermissionSet(tx, input.permissionSetId);
      await tx
        .update(authPermissionSets)
        .set({ name: input.name, updatedAt: new Date() })
        .where(eq(authPermissionSets.permissionSetId, input.permissionSetId));
      await this.recordSetAuditEvent(tx, {
        actorPrincipalId: input.actorPrincipalId,
        permissionSetId: input.permissionSetId,
        setName: input.name,
        action: authPermissionSetAuditActionValues.renamed,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
    });
  }

  /**
   * Delete a permission set.
   *
   * DELETE-VS-GRANT SEMANTICS: deletion is BLOCKED while the set is still granted
   * to any principal. The schema cascades a set deletion to its
   * `principal_permission_set_grants`, which would SILENTLY strip authorization
   * from every principal that held the set with no explicit record of the loss.
   * Rather than cascade, we refuse (throwing `ItotoriPrincipalRepositoryError`)
   * and require the admin to revoke the grants first, making the authorization
   * change deliberate and individually auditable. Once no grants reference it,
   * deletion proceeds and is recorded as `set_deleted` in the retained audit
   * trail.
   */
  async deletePermissionSet(
    actor: AuthorizationActor,
    input: DeletePermissionSetInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    await this.db.transaction(async (tx) => {
      const set = await this.requirePermissionSet(tx, input.permissionSetId);
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
      await this.recordSetAuditEvent(tx, {
        actorPrincipalId: input.actorPrincipalId,
        permissionSetId: input.permissionSetId,
        setName: set.name,
        action: authPermissionSetAuditActionValues.deleted,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
    });
  }

  /**
   * Grant a permission set to a principal.
   *
   * ACCOUNT-SCOPE INVARIANT (P0, cross-account escalation fix): a permission set
   * is owned by exactly one account; it may be granted ONLY to a principal that
   * belongs to that same account (a human via `account_memberships`, a service
   * principal via its intrinsic `account_id`). Granting a set from account B to a
   * principal in account A would let that principal resolve account B's
   * permissions — a cross-account privilege escalation. We reject it
   * transactionally here, and the effective-permission resolver additionally
   * refuses to expand any cross-account set (defense in depth), so even a grant
   * row inserted out of band authorizes nothing.
   */
  async grantPermissionSet(
    actor: AuthorizationActor,
    input: GrantPermissionSetInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    await this.db.transaction(async (tx) => {
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
      const targetAccountIds = await this.principalAccountIds(tx, input.targetPrincipalId);
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
      await this.recordAuditEvent(tx, {
        actorPrincipalId: input.actorPrincipalId,
        targetPrincipalId: input.targetPrincipalId,
        action: authAuditEventActionValues.granted,
        permissionSetId: input.permissionSetId,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
    });
  }

  /**
   * Revoke a permission set previously granted to a principal — the "role
   * unassignment". This is a permission-management mutation in its own right (the
   * principal LOSES every permission the set contributed, unless it also holds it
   * via a direct grant or another granted set), so it writes a complete `revoked`
   * audit event. The grant must exist; revoking an absent grant throws rather than
   * recording a phantom revoke.
   */
  async revokePermissionSet(
    actor: AuthorizationActor,
    input: RevokePermissionSetInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    await this.db.transaction(async (tx) => {
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
      await this.recordAuditEvent(tx, {
        actorPrincipalId: input.actorPrincipalId,
        targetPrincipalId: input.targetPrincipalId,
        action: authAuditEventActionValues.revoked,
        permissionSetId: input.permissionSetId,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
    });
  }

  async grantDirectPermission(
    actor: AuthorizationActor,
    input: GrantDirectPermissionInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    await this.db.transaction(async (tx) => {
      await tx.insert(authPrincipalPermissionGrants).values({
        principalId: input.targetPrincipalId,
        permission: input.permission,
      });
      await this.recordAuditEvent(tx, {
        actorPrincipalId: input.actorPrincipalId,
        targetPrincipalId: input.targetPrincipalId,
        action: authAuditEventActionValues.granted,
        permission: input.permission,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
    });
  }

  /**
   * Map a quarantined external-provider claim to one exact permission.
   *
   * This does NOT make provider claims an authorization source. It creates an
   * admin-owned mapping that login reconciliation may materialize into ordinary
   * direct grant rows; `requirePermission` still authorizes only through the
   * existing grant resolver.
   */
  async mapProviderClaimToDirectPermission(
    actor: AuthorizationActor,
    input: MapProviderClaimToDirectPermissionInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authAdmin);
    if (input.claimValue.trim().length === 0) {
      throw new ItotoriPrincipalRepositoryError("provider claim value must be non-empty");
    }
    await this.db.insert(authProviderClaimPermissionMappings).values({
      provider: input.provider,
      claimKind: input.claimKind,
      claimValue: input.claimValue,
      permission: input.permission,
      createdByPrincipalId: input.actorPrincipalId,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
  }

  /**
   * Revoke a single direct permission override from a principal. The principal
   * loses this exact permission (unless it also resolves it via a granted set), so
   * the change is recorded as a complete `revoked` audit event. The direct grant
   * must exist; revoking an absent grant throws rather than recording a phantom
   * revoke.
   */
  async revokeDirectPermission(
    actor: AuthorizationActor,
    input: RevokeDirectPermissionInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    await this.db.transaction(async (tx) => {
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
      await this.recordAuditEvent(tx, {
        actorPrincipalId: input.actorPrincipalId,
        targetPrincipalId: input.targetPrincipalId,
        action: authAuditEventActionValues.revoked,
        permission: input.permission,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
    });
  }

  async loadPrincipal(
    actor: AuthorizationActor,
    principalId: string,
  ): Promise<PrincipalRecord | undefined> {
    await requirePermission(this.db, actor, permissionValues.authAdmin);
    const rows = await this.db
      .select({ principalKind: authPrincipals.principalKind })
      .from(authPrincipals)
      .where(eq(authPrincipals.principalId, principalId))
      .limit(1);
    const principal = rows[0];
    if (principal === undefined) {
      return undefined;
    }
    const displayName =
      principal.principalKind === "human_user"
        ? (
            await this.db
              .select({ displayName: authUsers.displayName })
              .from(authUsers)
              .where(eq(authUsers.principalId, principalId))
              .limit(1)
          )[0]?.displayName
        : (
            await this.db
              .select({ displayName: authServicePrincipals.displayName })
              .from(authServicePrincipals)
              .where(eq(authServicePrincipals.principalId, principalId))
              .limit(1)
          )[0]?.displayName;
    if (displayName === undefined) {
      throw new ItotoriPrincipalRepositoryError(
        `principal ${principalId} (${principal.principalKind}) has no subtype identity row`,
      );
    }
    return { principalId, principalKind: principal.principalKind, displayName };
  }

  /**
   * The principal's EFFECTIVE permissions: the deduplicated, sorted union of its
   * direct permission grants and the permissions of every permission-set granted
   * to it. This is how a permission-set ("role") resolves to concrete
   * permissions — the model never branches on a role string.
   *
   * This editor read enforces `auth.permissions.manage` and then delegates the
   * union to the single authoritative resolver, `resolvePrincipalEffectivePermissions`
   * — the SAME primitive `requirePermission` consults — so there is exactly one
   * resolver of effective permissions in the codebase.
   */
  async resolvePrincipalPermissions(
    actor: AuthorizationActor,
    principalId: string,
  ): Promise<Permission[]> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    const permissions = await resolvePrincipalEffectivePermissions(this.db, principalId);
    return [...permissions].sort();
  }

  /**
   * The accounts a principal belongs to: a service principal's single intrinsic
   * `account_id`, or a human user's `account_memberships`. Used to enforce the
   * grant-time same-account invariant. (Membership existence, not account-active
   * state, is checked at grant time; the resolver separately voids grants whose
   * account is disabled.)
   */
  private async principalAccountIds(
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

  /** Load a set's current row or throw — validates the target of an edit exists. */
  private async requirePermissionSet(
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

  /** Bump `updated_at` so an edited set reflects its last mutation time. */
  private async touchPermissionSet(
    tx: PrincipalTransaction,
    permissionSetId: string,
  ): Promise<void> {
    await tx
      .update(authPermissionSets)
      .set({ updatedAt: new Date() })
      .where(eq(authPermissionSets.permissionSetId, permissionSetId));
  }

  /**
   * Append one row to the principal grant/revoke audit trail
   * (`itotori_auth_audit_events`). Every permission-management mutation whose
   * subject is a TARGET PRINCIPAL (grant/revoke a direct permission or a
   * permission set) routes through here so the trail is uniformly complete:
   * actor, target, the permission/set delta, the `granted`/`revoked` action,
   * plus the caller-supplied reason and correlation request id.
   */
  private async recordAuditEvent(
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

  /** Append one row to the permission-set model audit trail. */
  private async recordSetAuditEvent(
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
}

export const authPermissionsManagePermission =
  permissionValues.authPermissionsManage satisfies Permission;
