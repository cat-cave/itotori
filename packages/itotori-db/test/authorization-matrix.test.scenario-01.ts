import { describe, expect, it } from "vitest";
import { repositoryPermissionGateMatrix } from "./authorization-matrix.test.core.js";
import {
  sourcePermissionGates,
  sourcePermissionGatesFromSource,
  expectRepositoryPermissionGateMatrixMatches,
  sourceGateKey,
} from "./authorization-matrix.test.helpers.js";
import { permissionGateMatrixExpected } from "./authorization-matrix.test.expected.js";

describe("repository permission gate matrix", () => {
  it("names each permission-gated repository/API-adjacent mutation with fixtures", () => {
    expect(
      repositoryPermissionGateMatrix.map(
        ({ repository, mutation, requiredPermission, successFixture, denialFixture }) => ({
          mutation: `${repository}.${mutation}`,
          requiredPermission,
          successFixture,
          denialFixture,
        }),
      ),
    ).toEqual(permissionGateMatrixExpected);
  });

  it("matches every repository source permission gate", () => {
    expectRepositoryPermissionGateMatrixMatches(
      repositoryPermissionGateMatrix,
      sourcePermissionGates(),
    );
  });

  it("finds gates in re-exported, delegated, and mixin repository modules", () => {
    expect(sourcePermissionGates()).toEqual(
      expect.arrayContaining([
        {
          repository: "ItotoriAuthMemberManagementRepository",
          sourceFile: "auth-member-management-repository.ts",
          mutation: "acceptInvitation",
          permissionKey: "authMembersManage",
        },
        {
          repository: "ItotoriCatalogCrawlerRepository",
          sourceFile: "catalog-crawler-repository.ts",
          mutation: "commitStepImport",
          permissionKey: "catalogWrite",
        },
        {
          repository: "ItotoriEventQueueRepository",
          sourceFile: "event-queue-repository.ts",
          mutation: "appendOutboxEvent",
          permissionKey: "queueManage",
        },
        {
          repository: "ItotoriProjectRepository",
          sourceFile: "project-repository.ts",
          mutation: "saveDrafts",
          permissionKey: "draftWrite",
        },
        {
          repository: "ItotoriCatalogRepository",
          sourceFile: "catalog-repository.ts",
          mutation: "upsertWork",
          permissionKey: "catalogWrite",
        },
      ]),
    );
  });

  it("fails matrix coverage when a repository aliases requirePermission for an unregistered gate", () => {
    const sourceGates = sourcePermissionGatesFromSource(
      "probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";

        class ItotoriProbeRepository {
          async unregisteredMutation(actor) {
            const checkPermission = requirePermission;
            await checkPermission(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );

    expect(sourceGates.map(sourceGateKey)).toEqual([
      "ItotoriProbeRepository:probe-repository.ts:unregisteredMutation:draftWrite",
    ]);
    expect(() => expectRepositoryPermissionGateMatrixMatches([], sourceGates)).toThrow(
      /probe-repository\.ts:unregisteredMutation:draftWrite/u,
    );
    expect(() => expectRepositoryPermissionGateMatrixMatches([], sourceGates)).toThrow(
      /repository ItotoriProbeRepository method unregisteredMutation/u,
    );
  });

  it("discovers optional-chained requirePermission calls the same as plain ones (P1)", () => {
    // Babel uses OptionalCallExpression for `requirePermission?.(…)`; source
    // gate discovery must not drop those calls.
    const plainGates = sourcePermissionGatesFromSource(
      "optional-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";

        class ItotoriOptionalProbeRepository {
          async plainMutation(actor) {
            await requirePermission(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );
    const optionalGates = sourcePermissionGatesFromSource(
      "optional-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";

        class ItotoriOptionalProbeRepository {
          async plainMutation(actor) {
            await requirePermission?.(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );

    expect(optionalGates.map(sourceGateKey)).toEqual(plainGates.map(sourceGateKey));
    expect(optionalGates.map(sourceGateKey)).toEqual([
      "ItotoriOptionalProbeRepository:optional-probe-repository.ts:plainMutation:draftWrite",
    ]);
  });

  it("discovers destructured / array / default / computed requirePermission aliases (P1 matrix)", () => {
    const expected = [
      "ItotoriAliasProbeRepository:alias-probe-repository.ts:destructuredMutation:draftWrite",
    ];

    const destructured = sourcePermissionGatesFromSource(
      "alias-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";
        const authorization = { requirePermission };

        class ItotoriAliasProbeRepository {
          async destructuredMutation(actor) {
            const { requirePermission: check } = authorization;
            await check(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );
    expect(destructured.map(sourceGateKey)).toEqual(expected);

    const arrayAliased = sourcePermissionGatesFromSource(
      "alias-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";

        class ItotoriAliasProbeRepository {
          async destructuredMutation(actor) {
            const [check] = [requirePermission];
            await check(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );
    expect(arrayAliased.map(sourceGateKey)).toEqual(expected);

    const defaulted = sourcePermissionGatesFromSource(
      "alias-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";
        const authorization = { requirePermission };

        class ItotoriAliasProbeRepository {
          async destructuredMutation(actor) {
            const { requirePermission: check = requirePermission } = authorization;
            await check(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );
    expect(defaulted.map(sourceGateKey)).toEqual(expected);

    const computed = sourcePermissionGatesFromSource(
      "alias-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";
        const authorization = { requirePermission };

        class ItotoriAliasProbeRepository {
          async destructuredMutation(actor) {
            await authorization?.["requirePermission"]?.(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );
    expect(computed.map(sourceGateKey)).toEqual(expected);

    const computedPermissionKey = sourcePermissionGatesFromSource(
      "alias-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";

        class ItotoriAliasProbeRepository {
          async destructuredMutation(actor) {
            await requirePermission(this.db, actor, permissionValues?.["draftWrite"]);
          }
        }
      `,
    );
    expect(computedPermissionKey.map(sourceGateKey)).toEqual(expected);
  });

  it("distinguishes two repositories that share a method name and permission key by repository identity (SHARED-029)", () => {
    // Two repository classes in one source file both gate a method with the
    // same name on the same permission. Repository identity must keep the two
    // gates as distinct source-alignment keys so neither can mask the other.
    const sourceGates = sourcePermissionGatesFromSource(
      "shared-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";

        class ItotoriProbeRepositoryA {
          async sharedMutation(actor) {
            await requirePermission(this.db, actor, permissionValues.draftWrite);
          }
        }

        class ItotoriProbeRepositoryB {
          async sharedMutation(actor) {
            await requirePermission(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );

    expect(sourceGates.map(sourceGateKey)).toEqual([
      "ItotoriProbeRepositoryA:shared-probe-repository.ts:sharedMutation:draftWrite",
      "ItotoriProbeRepositoryB:shared-probe-repository.ts:sharedMutation:draftWrite",
    ]);

    // Registering both repositories' gates aligns with the source gates.
    expect(() =>
      expectRepositoryPermissionGateMatrixMatches(
        [
          {
            repository: "ItotoriProbeRepositoryA",
            sourceFile: "shared-probe-repository.ts",
            mutation: "sharedMutation",
            permissionKey: "draftWrite" as PermissionKey,
          },
          {
            repository: "ItotoriProbeRepositoryB",
            sourceFile: "shared-probe-repository.ts",
            mutation: "sharedMutation",
            permissionKey: "draftWrite" as PermissionKey,
          },
        ],
        sourceGates,
      ),
    ).not.toThrow();

    // A matrix that registers only one repository's gate fails: the collision
    // is caught and the diagnostic names the missing repository identity.
    const partialMatrix = [
      {
        repository: "ItotoriProbeRepositoryA",
        sourceFile: "shared-probe-repository.ts",
        mutation: "sharedMutation",
        permissionKey: "draftWrite" as PermissionKey,
      },
    ];
    expect(() => expectRepositoryPermissionGateMatrixMatches(partialMatrix, sourceGates)).toThrow(
      /repository ItotoriProbeRepositoryB method sharedMutation/u,
    );
  });
});
