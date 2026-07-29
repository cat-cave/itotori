import { describe, expect, it } from "vitest";
import { permissionValues } from "../src/authorization.js";
import {
  repositoryPermissionGateMatrix,
  authManagementOperations,
  principalRepositorySelfReadOperations,
  authManagementOperationPermissionKeys,
} from "./authorization-matrix.test.core.js";
import {
  sourcePermissionGates,
  principalRepositoryPublicMethods,
} from "./authorization-matrix.test.helpers.js";

describe("auth-management operation matrix (auth-007)", () => {
  const authManagementMatrixEntries = repositoryPermissionGateMatrix.filter(
    (entry) => entry.repository === "ItotoriPrincipalRepository",
  );

  const principalSourceGates = sourcePermissionGates().filter(
    (gate) => gate.sourceFile === "principal-repository.ts",
  );

  it("registers every ItotoriPrincipalRepository public method as an auth-management operation", () => {
    expect([...authManagementOperations, ...principalRepositorySelfReadOperations].sort()).toEqual(
      principalRepositoryPublicMethods(),
    );
    const matrixMutations = authManagementMatrixEntries.map((entry) => entry.mutation).sort();
    expect(matrixMutations).toEqual([...authManagementOperations].sort());
  });

  it.each(authManagementOperations)(
    "gates ItotoriPrincipalRepository.%s on its expected auth permission with success and denial fixtures",
    (operation) => {
      const entry = authManagementMatrixEntries.find((e) => e.mutation === operation);
      expect(
        entry,
        `ItotoriPrincipalRepository.${operation} must be registered in the authorization matrix`,
      ).toBeDefined();
      if (entry === undefined) {
        return;
      }
      const expectedPermissionKey = authManagementOperationPermissionKeys[operation];
      expect(
        entry.permissionKey,
        `ItotoriPrincipalRepository.${operation} must be gated on ${expectedPermissionKey}`,
      ).toBe(expectedPermissionKey);
      expect(
        entry.requiredPermission,
        `ItotoriPrincipalRepository.${operation} must require permission ${permissionValues[expectedPermissionKey]}`,
      ).toBe(permissionValues[expectedPermissionKey]);
      expect(
        entry.successFixture,
        `ItotoriPrincipalRepository.${operation} must reference a success fixture`,
      ).toMatch(/coverage$/);
      expect(
        entry.denialFixture,
        `ItotoriPrincipalRepository.${operation} must reference a denial fixture`,
      ).toMatch(/missing permission actor/);
    },
  );

  it.each(authManagementOperations)(
    "calls requirePermission with the expected permission in source for ItotoriPrincipalRepository.%s",
    (operation) => {
      const gate = principalSourceGates.find((g) => g.mutation === operation);
      expect(
        gate,
        `ItotoriPrincipalRepository.${operation} must call requirePermission in principal-repository.ts`,
      ).toBeDefined();
      if (gate === undefined) {
        return;
      }
      const expectedPermissionKey = authManagementOperationPermissionKeys[operation];
      expect(
        gate.permissionKey,
        `ItotoriPrincipalRepository.${operation} source gate must be ${expectedPermissionKey}`,
      ).toBe(expectedPermissionKey);
    },
  );
});
