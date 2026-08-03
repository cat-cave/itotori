#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runItotoriCliCommand, type JsonFileStore } from "./cli-handlers.js";
import { assertDeploymentStartupContext } from "./config/deployment-config-file.js";
import { requireDatabaseUrl } from "./deployment-required-input.js";
import { readOwnedJsonFile, writeJsonFile, writeTextFile } from "./cli-json-file-store.js";

const args = process.argv.slice(2);

export async function main(cliArgs = args): Promise<void> {
  await runItotoriCliCommand(cliArgs, {
    io: nodeJsonFileStore,
    migrateDatabase: async (startup) => {
      if (startup !== undefined) assertDeploymentStartupContext(startup);
      const databaseUrl = requireDatabaseUrl();
      const { migrateItotoriDatabase } = await import("./services/database-services.js");
      await migrateItotoriDatabase(databaseUrl);
    },
    resetDatabase: async (startup) => {
      if (startup !== undefined) assertDeploymentStartupContext(startup);
      const databaseUrl = requireDatabaseUrl();
      const { resetItotoriDatabase } = await import("./services/database-services.js");
      await resetItotoriDatabase(databaseUrl);
    },
    withServices: async (callback) => {
      const { withDatabaseItotoriServices } = await import("./services/database-services.js");
      return await withDatabaseItotoriServices({}, callback);
    },
  });
}

const nodeJsonFileStore: JsonFileStore = {
  readJson: readOwnedJsonFile,
  writeJson: writeJsonFile,
  writeText: writeTextFile,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
