import { beforeAll, describe, expect, it } from "vitest";

import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { runItotoriCliCommand } from "../src/cli-handlers.js";
import { withDatabaseItotoriServices } from "../src/services/database-services.js";
import {
  commandArgs,
  commandDeps,
  bridge,
  hash,
  recordedRunState,
  revision,
  structure,
} from "./recorded-localize-run.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

postgresDescribe("localize CLI project-scope provisioning", () => {
  beforeAll(() => {
    process.env.ITOTORI_FIELD_CIPHER_KEY ??= Buffer.alloc(32, 11).toString("base64");
  });

  it("provisions an empty database through the shipped localize command before dispatch config", async () => {
    const context = await isolatedMigratedContext();
    const previousApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "";
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        const projectId = "cli-empty-project-scope";
        const localeBranchId = "cli-empty-project-scope-en";
        await expect(
          runItotoriCliCommand(
            commandArgs(projectId, "cli-empty-project-scope-run", localeBranchId),
            {
              io: {
                readJson: (path) => (path === "bridge.json" ? bridge : structure),
                writeJson: () => undefined,
              },
              migrateDatabase: async () => undefined,
              resetDatabase: async () => undefined,
              withServices: async (callback) => await callback(services),
            },
          ),
        ).rejects.toThrow("localize production configuration requires OPENROUTER_API_KEY");
        expect(await services.projectWorkflow.listLocaleBranchIdentities(projectId)).toEqual([
          expect.objectContaining({ localeBranchId, projectId, targetLocale: "en-US" }),
        ]);
      });
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousApiKey;
      await context.close();
    }
  }, 120_000);
  it("provisions an empty database through the shipped localize command before dispatch", async () => {
    const context = await isolatedMigratedContext();
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        const projectId = "cli-project-scope";
        const runId = "cli-project-scope-run";
        const localeBranchId = "cli-project-scope-en";
        const contextSnapshot = await services.projectWorkflow.putContext({
          sourceLanguage: "ja-JP",
          decode: revision("a"),
          sourceUnits: [{ unitId: "cli-project-scope-unit", sourceHash: hash("b") }],
          facts: [
            {
              factId: "unit:cli-project-scope-unit",
              playOrderIndex: 0,
              routeScope: { kind: "global" },
            },
          ],
          structure: revision("c"),
          routeGraph: revision("d"),
          glossary: revision("e"),
          style: revision("f"),
          revealHorizon: { kind: "complete" },
          humanCorrections: revision("0"),
          externalSources: null,
          contextScope: "whole-game",
        });
        const localizationSnapshot = await services.projectWorkflow.putLocalization({
          contextSnapshotId: contextSnapshot.snapshotId,
          targetLocale: "en-US",
          localeBranchId,
          acceptedBibleHead: null,
          acceptedTargetOutputHead: null,
        });
        const state = recordedRunState();
        const recorded = commandDeps(
          services,
          contextSnapshot.snapshotId,
          localizationSnapshot.snapshotId,
          state,
        );
        const writes = new Map<string, unknown>();

        await runItotoriCliCommand(commandArgs(projectId, runId, localeBranchId), {
          io: {
            readJson: (path) => recorded.io.readJson(path),
            writeJson: (path, value) => writes.set(path, value),
          },
          migrateDatabase: async () => undefined,
          resetDatabase: async () => undefined,
          withServices: async (callback) =>
            await callback({
              ...services,
              localizationSubstrate: { resolvePortSource: recorded.resolvePortSource },
            }),
        });

        expect(state.providerCallCount).toBeGreaterThan(0);
        expect(writes.size).toBe(0);
        expect(await services.projectWorkflow.listLocaleBranchIdentities(projectId)).toEqual([
          expect.objectContaining({
            localeBranchId,
            projectId,
            sourceLocale: "ja-JP",
            targetLocale: "en-US",
          }),
        ]);
        expect(await services.projectWorkflow.loadLiveReadModel(projectId, runId)).toMatchObject({
          run: { status: "completed" },
        });
      });
    } finally {
      await context.close();
    }
  }, 120_000);
});
