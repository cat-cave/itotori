import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { describe, expect, it } from "vitest";
import { AuthorizationError, localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriLocalizationPassRunConfigRepository,
  ItotoriLocalizationPassRunConfigRepositoryError,
} from "../src/repositories/localization-pass-run-config-repository.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("ItotoriLocalizationPassRunConfigRepository", () => {
  it("persists one operator-local config per project/locale branch and resolves it for the live driver", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const repository = new ItotoriLocalizationPassRunConfigRepository(context.db);
      const input = {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        configPath: "/operator/runs/project.localize.json",
        dataRoot: "/operator/game",
        pairPolicyPath: "/operator/policies/pair-policy.json",
        modelId: "deepseek/deepseek-v4-flash",
        providerId: "fireworks",
        runDir: "/operator/runs/project-pass",
      };

      const saved = await repository.saveRunConfig(localActor, input);
      expect(saved).toMatchObject(input);
      expect(saved.updatedAt).toBeInstanceOf(Date);
      expect(
        await repository.resolveRunConfig(input.projectId, input.localeBranchId),
      ).toMatchObject(input);

      const resaved = await repository.saveRunConfig(localActor, {
        ...input,
        modelId: "model-v2",
        providerId: "provider-v2",
      });
      expect(resaved.modelId).toBe("model-v2");
      expect(resaved.providerId).toBe("provider-v2");
    } finally {
      await context.close();
    }
  });

  it("returns no config for an unregistered branch and rejects an unknown branch on save", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repository = new ItotoriLocalizationPassRunConfigRepository(context.db);
      expect(await repository.resolveRunConfig("project-test", "locale-en-us")).toBeNull();
      await expect(
        repository.saveRunConfig(localActor, {
          ...runConfigInput(),
          localeBranchId: "missing-branch",
        }),
      ).rejects.toBeInstanceOf(ItotoriLocalizationPassRunConfigRepositoryError);
    } finally {
      await context.close();
    }
  });

  it("denies registration without draft.write", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repository = new ItotoriLocalizationPassRunConfigRepository(context.db);
      const actor = { userId: "user-without-required-permission" };
      await expect(repository.saveRunConfig(actor, runConfigInput())).rejects.toMatchObject(
        new AuthorizationError(actor, "draft.write"),
      );
    } finally {
      await context.close();
    }
  });
});

function runConfigInput() {
  return {
    projectId: "project-test",
    engineFamily: "synthetic_fixture",
    sourceRoot: "/workspace/source",
    buildRoot: "/workspace/build",
    extractProfile: { adapter: "fixture" },
    localeBranchId: "locale-en-us",
    configPath: "/operator/runs/project.localize.json",
    dataRoot: "/operator/game",
    pairPolicyPath: "/operator/policies/pair-policy.json",
    modelId: "model-v1",
    providerId: "provider-v1",
    runDir: "/operator/runs/project-pass",
  };
}

function projectFixture(): ItotoriProjectRecord {
  return {
    projectId: "project-test",
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
