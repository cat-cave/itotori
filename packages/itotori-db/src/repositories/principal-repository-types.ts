import type { AuthorizationActor, Permission } from "../authorization.js";
import type { AuthProviderClaimKind, AuthPrincipalKind } from "../schema.js";

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

export type ActorIdentityAccountRecord = {
  membershipId: string;
  accountId: string;
  accountSlug: string;
  accountName: string;
  permissionSetIds: string[];
  createdAt: Date;
};

export type ActorIdentityRecord = {
  /**
   * Authorization actor presented to the app. In local compatibility mode this
   * remains `local-user`, even though the multi-user account rows are carried
   * by the separate `local-operator` principal.
   */
  actorUserId: string;
  /** User id whose multi-user identity rows were resolved, if any. */
  userId: string;
  principalId: string | null;
  email: string | null;
  displayName: string;
  accounts: ActorIdentityAccountRecord[];
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

export type AddPermissionToSetInput = {
  actorPrincipalId: string;
  permissionSetId: string;
  permission: Permission;
  reason?: string;
  requestId?: string;
};

export type RemovePermissionFromSetInput = {
  actorPrincipalId: string;
  permissionSetId: string;
  permission: Permission;
  reason?: string;
  requestId?: string;
};

export type RenamePermissionSetInput = {
  actorPrincipalId: string;
  permissionSetId: string;
  name: string;
  reason?: string;
  requestId?: string;
};

export type DeletePermissionSetInput = {
  actorPrincipalId: string;
  permissionSetId: string;
  reason?: string;
  requestId?: string;
};

export type GrantPermissionSetInput = {
  actorPrincipalId: string;
  targetPrincipalId: string;
  permissionSetId: string;
  reason?: string;
  requestId?: string;
};

export type GrantDirectPermissionInput = {
  actorPrincipalId: string;
  targetPrincipalId: string;
  permission: Permission;
  reason?: string;
  requestId?: string;
};

export type MapProviderClaimToDirectPermissionInput = {
  actorPrincipalId: string;
  provider: string;
  claimKind: AuthProviderClaimKind;
  claimValue: string;
  permission: Permission;
  reason?: string;
  requestId?: string;
};

export type RevokePermissionSetInput = {
  actorPrincipalId: string;
  targetPrincipalId: string;
  permissionSetId: string;
  reason?: string;
  requestId?: string;
};

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
  loadActorIdentity(actor: AuthorizationActor): Promise<ActorIdentityRecord>;
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
