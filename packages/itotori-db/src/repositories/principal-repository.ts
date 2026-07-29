// Public façade for the principal/account/permission-set identity layer.
//
// Permission checks remain here so this entrypoint continues to be the audited
// public boundary; persistence operations live in focused internal modules.

import {
  type AuthorizationActor,
  type Permission,
  permissionValues,
  requirePermission,
} from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  createAccount,
  createPrincipal,
  loadActorIdentity,
  loadPrincipal,
} from "./principal-repository-identities.js";
import {
  grantDirectPermission,
  grantPermissionSet,
  mapProviderClaimToDirectPermission,
  resolvePrincipalPermissions,
  revokeDirectPermission,
  revokePermissionSet,
} from "./principal-repository-permission-grants.js";
import {
  addPermissionToSet,
  createPermissionSet,
  deletePermissionSet,
  listAccountPermissionSets as listAccountPermissionSetsForAccount,
  loadPermissionSetAccountId as loadPermissionSetAccountIdForSet,
  removePermissionFromSet,
  renamePermissionSet,
} from "./principal-repository-permission-sets.js";
import type {
  AccountRecord,
  AddPermissionToSetInput,
  ActorIdentityRecord,
  CreateAccountInput,
  CreatePermissionSetInput,
  CreatePrincipalInput,
  DeletePermissionSetInput,
  GrantDirectPermissionInput,
  GrantPermissionSetInput,
  ItotoriPrincipalRepositoryPort,
  MapProviderClaimToDirectPermissionInput,
  PermissionSetRecord,
  PrincipalRecord,
  RemovePermissionFromSetInput,
  RenamePermissionSetInput,
  RevokeDirectPermissionInput,
  RevokePermissionSetInput,
} from "./principal-repository-types.js";

export { ItotoriPrincipalRepositoryError } from "./principal-repository-types.js";
export type {
  AccountRecord,
  AddPermissionToSetInput,
  ActorIdentityAccountRecord,
  ActorIdentityRecord,
  CreateAccountInput,
  CreatePermissionSetInput,
  CreatePrincipalInput,
  DeletePermissionSetInput,
  GrantDirectPermissionInput,
  GrantPermissionSetInput,
  ItotoriPrincipalRepositoryPort,
  MapProviderClaimToDirectPermissionInput,
  PermissionSetRecord,
  PrincipalRecord,
  RemovePermissionFromSetInput,
  RenamePermissionSetInput,
  RevokeDirectPermissionInput,
  RevokePermissionSetInput,
} from "./principal-repository-types.js";

export async function listAccountPermissionSets(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  accountId: string,
): Promise<PermissionSetRecord[]> {
  // @repository-permission-gate ItotoriPrincipalRepositoryExports.listAccountPermissionSets authPermissionsManage
  await requirePermission(db, actor, permissionValues.authPermissionsManage);
  return listAccountPermissionSetsForAccount(db, accountId);
}

export async function loadPermissionSetAccountId(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  permissionSetId: string,
): Promise<string> {
  // @repository-permission-gate ItotoriPrincipalRepositoryExports.loadPermissionSetAccountId authPermissionsManage
  await requirePermission(db, actor, permissionValues.authPermissionsManage);
  return loadPermissionSetAccountIdForSet(db, permissionSetId);
}

export class ItotoriPrincipalRepository implements ItotoriPrincipalRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async createAccount(
    actor: AuthorizationActor,
    input: CreateAccountInput,
  ): Promise<AccountRecord> {
    await requirePermission(this.db, actor, permissionValues.authAdmin);
    return createAccount(this.db, input);
  }

  async createPrincipal(
    actor: AuthorizationActor,
    input: CreatePrincipalInput,
  ): Promise<PrincipalRecord> {
    await requirePermission(this.db, actor, permissionValues.authAdmin);
    return createPrincipal(this.db, input);
  }

  async createPermissionSet(
    actor: AuthorizationActor,
    input: CreatePermissionSetInput,
  ): Promise<PermissionSetRecord> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    return createPermissionSet(this.db, input);
  }

  async addPermissionToSet(
    actor: AuthorizationActor,
    input: AddPermissionToSetInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    return addPermissionToSet(this.db, input);
  }

  async removePermissionFromSet(
    actor: AuthorizationActor,
    input: RemovePermissionFromSetInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    return removePermissionFromSet(this.db, input);
  }

  async renamePermissionSet(
    actor: AuthorizationActor,
    input: RenamePermissionSetInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    return renamePermissionSet(this.db, input);
  }

  async deletePermissionSet(
    actor: AuthorizationActor,
    input: DeletePermissionSetInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    return deletePermissionSet(this.db, input);
  }

  async grantPermissionSet(
    actor: AuthorizationActor,
    input: GrantPermissionSetInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    return grantPermissionSet(this.db, input);
  }

  async revokePermissionSet(
    actor: AuthorizationActor,
    input: RevokePermissionSetInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    return revokePermissionSet(this.db, input);
  }

  async grantDirectPermission(
    actor: AuthorizationActor,
    input: GrantDirectPermissionInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    return grantDirectPermission(this.db, input);
  }

  async mapProviderClaimToDirectPermission(
    actor: AuthorizationActor,
    input: MapProviderClaimToDirectPermissionInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authAdmin);
    return mapProviderClaimToDirectPermission(this.db, input);
  }

  async revokeDirectPermission(
    actor: AuthorizationActor,
    input: RevokeDirectPermissionInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    return revokeDirectPermission(this.db, input);
  }

  async loadPrincipal(
    actor: AuthorizationActor,
    principalId: string,
  ): Promise<PrincipalRecord | undefined> {
    await requirePermission(this.db, actor, permissionValues.authAdmin);
    return loadPrincipal(this.db, principalId);
  }

  async loadActorIdentity(actor: AuthorizationActor): Promise<ActorIdentityRecord> {
    return loadActorIdentity(this.db, actor.userId);
  }

  async resolvePrincipalPermissions(
    actor: AuthorizationActor,
    principalId: string,
  ): Promise<Permission[]> {
    await requirePermission(this.db, actor, permissionValues.authPermissionsManage);
    return resolvePrincipalPermissions(this.db, principalId);
  }
}

export const authPermissionsManagePermission =
  permissionValues.authPermissionsManage satisfies Permission;
