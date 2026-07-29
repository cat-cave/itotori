export { deniedActor } from "./authorization-matrix.test.constants.js";
import type { ItotoriPrincipalRepositoryPort } from "../src/repositories/principal-repository.js";
import { repositoryPermissionGateMatrixPart1 } from "./authorization-matrix.test.matrix-01.js";
import { repositoryPermissionGateMatrixPart2 } from "./authorization-matrix.test.matrix-02.js";
import { repositoryPermissionGateMatrixPart3 } from "./authorization-matrix.test.matrix-03.js";

export const repositoryPermissionGateMatrix = [
  ...repositoryPermissionGateMatrixPart1,
  ...repositoryPermissionGateMatrixPart2,
  ...repositoryPermissionGateMatrixPart3,
];

export const authManagementOperations = [
  "createAccount",
  "createPrincipal",
  "createPermissionSet",
  "addPermissionToSet",
  "removePermissionFromSet",
  "renamePermissionSet",
  "deletePermissionSet",
  "grantPermissionSet",
  "revokePermissionSet",
  "grantDirectPermission",
  "mapProviderClaimToDirectPermission",
  "revokeDirectPermission",
  "loadPrincipal",
  "resolvePrincipalPermissions",
] as const satisfies readonly (keyof ItotoriPrincipalRepositoryPort)[];

export const principalRepositorySelfReadOperations = [
  "loadActorIdentity",
] as const satisfies readonly (keyof ItotoriPrincipalRepositoryPort)[];

export const authManagementOperationPermissionKeys = {
  createAccount: "authAdmin",
  createPrincipal: "authAdmin",
  createPermissionSet: "authPermissionsManage",
  addPermissionToSet: "authPermissionsManage",
  removePermissionFromSet: "authPermissionsManage",
  renamePermissionSet: "authPermissionsManage",
  deletePermissionSet: "authPermissionsManage",
  grantPermissionSet: "authPermissionsManage",
  revokePermissionSet: "authPermissionsManage",
  grantDirectPermission: "authPermissionsManage",
  mapProviderClaimToDirectPermission: "authAdmin",
  revokeDirectPermission: "authPermissionsManage",
  loadPrincipal: "authAdmin",
  resolvePrincipalPermissions: "authPermissionsManage",
} as const satisfies Record<(typeof authManagementOperations)[number], PermissionKey>;
