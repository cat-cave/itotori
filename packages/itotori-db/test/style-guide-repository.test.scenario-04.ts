import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import { ItotoriStyleGuideRepository } from "../src/repositories/style-guide-repository.js";

import { styleGuides, styleGuideVersions, styleGuideVersionStatusValues } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

import { projectFixture, seedProject } from "./style-guide-repository.test.shared-01.js";

describe("ItotoriStyleGuideService", () => {
  describe("version reference integrity constraints", () => {
    // Postgres SQLSTATE for foreign_key_violation. drizzle wraps the driver
    // error (top-level message is "Failed query: ..."), so assert on the pg
    // error code carried on the cause chain rather than the message text.
    const foreignKeyViolationCode = "23503";

    function pgErrorCodeOf(error: unknown): string | undefined {
      let current: unknown = error;
      while (current !== undefined && current !== null) {
        if (typeof current === "object" && "code" in current) {
          const code = (current as { code?: unknown }).code;
          if (typeof code === "string") {
            return code;
          }
        }
        if (typeof current === "object" && "cause" in current) {
          current = (current as { cause?: unknown }).cause;
        } else {
          break;
        }
      }
      return undefined;
    }

    async function expectForeignKeyViolation(op: Promise<unknown>): Promise<void> {
      let caught: unknown;
      try {
        await op;
      } catch (error) {
        caught = error;
      }
      expect(caught, "expected a foreign-key violation but the statement succeeded").toBeDefined();
      expect(pgErrorCodeOf(caught)).toBe(foreignKeyViolationCode);
    }

    it("rejects a dangling latest_version_id pointer", async () => {
      const context = await isolatedMigratedContext();
      try {
        await seedProject(context.db);
        const repository = new ItotoriStyleGuideRepository(context.db);
        await repository.createVersion(localActor, {
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          styleGuideVersionId: "sgv-en-1",
          policy: { tone: "neutral" },
        });

        await expectForeignKeyViolation(
          context.db
            .update(styleGuides)
            .set({ latestVersionId: "sgv-does-not-exist" })
            .where(eq(styleGuides.localeBranchId, "locale-en-us")),
        );
      } finally {
        await context.close();
      }
    });

    it("rejects a dangling approved_version_id pointer", async () => {
      const context = await isolatedMigratedContext();
      try {
        await seedProject(context.db);
        const repository = new ItotoriStyleGuideRepository(context.db);
        await repository.createVersion(localActor, {
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          styleGuideVersionId: "sgv-en-1",
          policy: { tone: "neutral" },
        });

        await expectForeignKeyViolation(
          context.db
            .update(styleGuides)
            .set({ approvedVersionId: "sgv-does-not-exist" })
            .where(eq(styleGuides.localeBranchId, "locale-en-us")),
        );
      } finally {
        await context.close();
      }
    });

    it("rejects a dangling previous_version_id pointer", async () => {
      const context = await isolatedMigratedContext();
      try {
        await seedProject(context.db);
        const repository = new ItotoriStyleGuideRepository(context.db);
        await repository.createVersion(localActor, {
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          styleGuideVersionId: "sgv-en-1",
          policy: { tone: "neutral" },
        });

        await expectForeignKeyViolation(
          context.db
            .update(styleGuideVersions)
            .set({ previousVersionId: "sgv-does-not-exist" })
            .where(eq(styleGuideVersions.styleGuideVersionId, "sgv-en-1")),
        );
      } finally {
        await context.close();
      }
    });

    it("rejects a cross-locale-branch latest_version_id pointer", async () => {
      const context = await isolatedMigratedContext();
      try {
        await seedProject(context.db);
        const repository = new ItotoriStyleGuideRepository(context.db);
        // Version + guide in locale-en-us.
        await repository.createVersion(localActor, {
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          styleGuideVersionId: "sgv-en-1",
          policy: { tone: "neutral" },
        });
        // Version + guide in locale-fr-fr (same project, different branch).
        await repository.createVersion(localActor, {
          projectId: "project-test",
          localeBranchId: "locale-fr-fr",
          styleGuideVersionId: "sgv-fr-1",
          policy: { tone: "neutral" },
        });

        // Point the fr-fr guide's latest at the en-us version -> cross-branch.
        await expectForeignKeyViolation(
          context.db
            .update(styleGuides)
            .set({ latestVersionId: "sgv-en-1" })
            .where(eq(styleGuides.localeBranchId, "locale-fr-fr")),
        );
      } finally {
        await context.close();
      }
    });

    it("rejects a cross-locale-branch previous_version_id pointer", async () => {
      const context = await isolatedMigratedContext();
      try {
        await seedProject(context.db);
        const repository = new ItotoriStyleGuideRepository(context.db);
        await repository.createVersion(localActor, {
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          styleGuideVersionId: "sgv-en-1",
          policy: { tone: "neutral" },
        });
        await repository.createVersion(localActor, {
          projectId: "project-test",
          localeBranchId: "locale-fr-fr",
          styleGuideVersionId: "sgv-fr-1",
          policy: { tone: "neutral" },
        });

        // en-us version pointing its previous at the fr-fr version -> cross-branch.
        await expectForeignKeyViolation(
          context.db
            .update(styleGuideVersions)
            .set({ previousVersionId: "sgv-fr-1" })
            .where(eq(styleGuideVersions.styleGuideVersionId, "sgv-en-1")),
        );
      } finally {
        await context.close();
      }
    });

    it("rejects a cross-project latest_version_id pointer", async () => {
      const context = await isolatedMigratedContext();
      try {
        await seedProject(context.db);
        const projectRepo = new ItotoriProjectRepository(
          context.db,
          testProjectEngineFamilyRegistry,
        );
        // A second project with its OWN source bundle + locale-branch (a
        // distinct bridgeId/hash so it does not collide with project-test's).
        await projectRepo.importSourceBundle(
          localActor,
          projectFixture({
            projectId: "project-test-2",
            localeBranchId: "locale-de-de",
            targetLocale: "de-DE",
            drafts: { "bridge-unit-de": "Hallo, {player}." },
            bridge: {
              schemaVersion: "0.1.0",
              bridgeId: "bridge-test-2",
              sourceBundleHash: "hash-test-2",
              sourceLocale: "ja-JP",
              extractorName: "kaifuu-fixture",
              extractorVersion: "0.0.0",
              units: [
                {
                  bridgeUnitId: "bridge-unit-de",
                  sourceUnitKey: "hello.scene.001.line.001",
                  occurrenceId: "occurrence-1",
                  sourceHash: "source-hash-de",
                  sourceLocale: "ja-JP",
                  sourceText: "こんにちは、{player}。",
                  textSurface: "dialogue",
                  protectedSpans: [
                    {
                      kind: "placeholder",
                      raw: "{player}",
                      start: 18,
                      end: 26,
                      preserveMode: "exact",
                    },
                  ],
                  patchRef: {
                    assetId: "source-de.json",
                    writeMode: "replace",
                    sourceUnitKey: "hello.scene.001.line.001",
                  },
                },
              ],
            },
          }),
        );

        const repository = new ItotoriStyleGuideRepository(context.db);
        await repository.createVersion(localActor, {
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          styleGuideVersionId: "sgv-en-1",
          policy: { tone: "neutral" },
        });
        await repository.createVersion(localActor, {
          projectId: "project-test-2",
          localeBranchId: "locale-de-de",
          styleGuideVersionId: "sgv-de-1",
          policy: { tone: "neutral" },
        });

        // Point the en-us (project-test) guide's latest at a project-test-2 version.
        await expectForeignKeyViolation(
          context.db
            .update(styleGuides)
            .set({ latestVersionId: "sgv-de-1" })
            .where(eq(styleGuides.localeBranchId, "locale-en-us")),
        );
      } finally {
        await context.close();
      }
    });

    it("accepts valid in-scope latest / approved / previous references", async () => {
      const context = await isolatedMigratedContext();
      try {
        await seedProject(context.db);
        const repository = new ItotoriStyleGuideRepository(context.db);
        const v1 = await repository.createVersion(localActor, {
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          styleGuideVersionId: "sgv-en-1",
          policy: { tone: "neutral" },
        });
        const v2 = await repository.createVersion(localActor, {
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          styleGuideVersionId: "sgv-en-2",
          status: styleGuideVersionStatusValues.approved,
          policy: { tone: "warm" },
        });

        // The write path maintained valid pointers: v2.previous = v1, guide
        // latest = v2, approved = v2 -- all same project + locale-branch.
        expect(v2.version.previousVersionId).toBe("sgv-en-1");
        await expect(
          repository.getLatestVersionByLocaleBranchId("locale-en-us"),
        ).resolves.toMatchObject({ styleGuideVersionId: "sgv-en-2" });
        await expect(
          repository.getApprovedVersionByLocaleBranchId("locale-en-us"),
        ).resolves.toMatchObject({ styleGuideVersionId: "sgv-en-2" });

        // A redundant, in-scope re-point of latest to v1 is accepted (no false
        // rejection for a valid same-scope reference).
        await context.db
          .update(styleGuides)
          .set({ latestVersionId: "sgv-en-1" })
          .where(eq(styleGuides.localeBranchId, "locale-en-us"));
        await expect(
          repository.getLatestVersionByLocaleBranchId("locale-en-us"),
        ).resolves.toMatchObject({ styleGuideVersionId: "sgv-en-1" });

        // Clearing a pointer to NULL is accepted (nullable pointer).
        await context.db
          .update(styleGuideVersions)
          .set({ previousVersionId: null })
          .where(eq(styleGuideVersions.styleGuideVersionId, "sgv-en-2"));

        expect(v1.version.styleGuideVersionId).toBe("sgv-en-1");
      } finally {
        await context.close();
      }
    });
  });
});
