import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { describe, expect, it } from "vitest";
import { AuthorizationError, localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import {
  DEFAULT_TRANSLATION_SCOPE,
  ItotoriTranslationScopeSettingsRepository,
  ItotoriTranslationScopeSettingsRepositoryError,
} from "../src/repositories/translation-scope-settings-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("ItotoriTranslationScopeSettingsRepository", () => {
  it("defaults to dialogue-only when no scope has been saved for a branch", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const repository = new ItotoriTranslationScopeSettingsRepository(context.db);

      const loaded = await repository.loadSettings(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
      });
      expect(loaded.scope).toBe(DEFAULT_TRANSLATION_SCOPE);
      expect(loaded.scope).toBe("dialogue-only");

      const resolved = await repository.resolveScope("project-test", "locale-en-us");
      expect(resolved).toBeUndefined();
    } finally {
      await context.close();
    }
  });

  it("persists a cumulative-tier scope and resolveScope reads the SAME persisted value", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const repository = new ItotoriTranslationScopeSettingsRepository(context.db);

      const saved = await repository.saveSettings(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        scope: "dialogue-choices-ui",
      });
      expect(saved.scope).toBe("dialogue-choices-ui");

      const loaded = await repository.loadSettings(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
      });
      expect(loaded.scope).toBe("dialogue-choices-ui");

      // This is the exact read path the kept `localize` command uses to
      // resolve the DB-backed default when a run request omits
      // `--output-scope` — proving the persisted value is what the
      // localize command reads.
      const resolved = await repository.resolveScope("project-test", "locale-en-us");
      expect(resolved).toBe("dialogue-choices-ui");

      // Re-saving (upsert) overwrites rather than duplicating the row.
      const resaved = await repository.saveSettings(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        scope: "all",
      });
      expect(resaved.scope).toBe("all");
      expect(await repository.resolveScope("project-test", "locale-en-us")).toBe("all");
    } finally {
      await context.close();
    }
  });

  it("rejects an unknown scope token", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const repository = new ItotoriTranslationScopeSettingsRepository(context.db);

      await expect(
        repository.saveSettings(localActor, {
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          // @ts-expect-error deliberate invalid scope token for the refuse-loud test
          scope: "images-only",
        }),
      ).rejects.toBeInstanceOf(ItotoriTranslationScopeSettingsRepositoryError);
    } finally {
      await context.close();
    }
  });

  it("denies writes without draft.write", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repository = new ItotoriTranslationScopeSettingsRepository(context.db);
      const actor = { userId: "user-without-required-permission" };

      await expect(
        repository.saveSettings(actor, {
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          scope: "all",
        }),
      ).rejects.toMatchObject(new AuthorizationError(actor, "draft.write"));
    } finally {
      await context.close();
    }
  });
});

function projectFixture(): ItotoriProjectRecord {
  return {
    projectId: "project-test",
    engineFamily: "synthetic_fixture",
    sourceRoot: "/workspace/source",
    buildRoot: "/workspace/build",
    extractProfile: { adapter: "fixture" },
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: {},
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-test",
      sourceBundleHash: "hash-test",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: "bridge-unit-test",
          sourceUnitKey: "hello.scene.001.line.001",
          occurrenceId: "occurrence-1",
          sourceHash: "source-hash",
          sourceLocale: "ja-JP",
          sourceText: "Hello, {player}.",
          textSurface: "dialogue",
          protectedSpans: [
            { kind: "placeholder", raw: "{player}", start: 7, end: 15, preserveMode: "exact" },
          ],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "hello.scene.001.line.001",
          },
        },
      ],
    },
  };
}
