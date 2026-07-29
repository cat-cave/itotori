import { permissionValues } from "../src/authorization.js";

import { deniedActor } from "./authorization-matrix.test.constants.js";
import type { RepositoryPermissionGateCase } from "./authorization-matrix.test.helpers.js";

export function repositoryGate(
  input: Omit<RepositoryPermissionGateCase, "requiredPermission" | "denialFixture">,
): RepositoryPermissionGateCase {
  return {
    ...input,
    requiredPermission: permissionValues[input.permissionKey],
    denialFixture: `missing permission actor ${deniedActor.userId}`,
  };
}
