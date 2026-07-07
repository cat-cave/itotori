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
// AND read here is gated on the `auth.admin` permission (administering the auth
// layer is itself a privileged action), enforced through `requirePermission`
// against the existing single-user substrate — which stays intact.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  type AuthorizationActor,
  type Permission,
  permissionValues,
  requirePermission,
  resolvePrincipalEffectivePermissions,
} from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  type AuthPrincipalKind,
  authAccounts,
  authAuditEvents,
  authPermissionSetPermissions,
  authPermissionSets,
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
  permissionSetId: string;
  accountId: string;
  name: string;
  description?: string;
  permissions: readonly Permission[];
};

export type PermissionSetRecord = {
  permissionSetId: string;
  accountId: string;
  name: string;
  permissions: Permission[];
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

export interface ItotoriPrincipalRepositoryPort {
  createAccount(actor: AuthorizationActor, input: CreateAccountInput): Promise<AccountRecord>;
  createPrincipal(actor: AuthorizationActor, input: CreatePrincipalInput): Promise<PrincipalRecord>;
  createPermissionSet(
    actor: AuthorizationActor,
    input: CreatePermissionSetInput,
  ): Promise<PermissionSetRecord>;
  grantPermissionSet(actor: AuthorizationActor, input: GrantPermissionSetInput): Promise<void>;
  grantDirectPermission(
    actor: AuthorizationActor,
    input: GrantDirectPermissionInput,
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
    await requirePermission(this.db, actor, permissionValues.authAdmin);
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
      return {
        permissionSetId: input.permissionSetId,
        accountId: input.accountId,
        name: input.name,
        permissions,
      };
    });
  }

  async grantPermissionSet(
    actor: AuthorizationActor,
    input: GrantPermissionSetInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authAdmin);
    await this.db.transaction(async (tx) => {
      await tx.insert(authPrincipalPermissionSetGrants).values({
        principalId: input.targetPrincipalId,
        permissionSetId: input.permissionSetId,
      });
      await tx.insert(authAuditEvents).values({
        authAuditEventId: `auth-audit-${randomUUID()}`,
        actorPrincipalId: input.actorPrincipalId,
        targetPrincipalId: input.targetPrincipalId,
        action: "granted",
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
    await requirePermission(this.db, actor, permissionValues.authAdmin);
    await this.db.transaction(async (tx) => {
      await tx.insert(authPrincipalPermissionGrants).values({
        principalId: input.targetPrincipalId,
        permission: input.permission,
      });
      await tx.insert(authAuditEvents).values({
        authAuditEventId: `auth-audit-${randomUUID()}`,
        actorPrincipalId: input.actorPrincipalId,
        targetPrincipalId: input.targetPrincipalId,
        action: "granted",
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
   * This gated read enforces `auth.admin` and then delegates the union to the
   * single authoritative resolver, `resolvePrincipalEffectivePermissions` — the
   * SAME primitive `requirePermission` consults — so there is exactly one
   * resolver of effective permissions in the codebase.
   */
  async resolvePrincipalPermissions(
    actor: AuthorizationActor,
    principalId: string,
  ): Promise<Permission[]> {
    await requirePermission(this.db, actor, permissionValues.authAdmin);
    const permissions = await resolvePrincipalEffectivePermissions(this.db, principalId);
    return [...permissions].sort();
  }
}
