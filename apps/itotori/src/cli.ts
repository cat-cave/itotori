#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runItotoriCliCommand, type JsonFileStore } from "./cli-handlers.js";
import { readOwnedJsonFile, writeJsonFile, writeTextFile } from "./cli-json-file-store.js";
import {
  migrateItotoriDatabase,
  resetItotoriDatabase,
  withDatabaseItotoriServices,
} from "./services/database-services.js";

const args = process.argv.slice(2);

export async function main(cliArgs = args): Promise<void> {
  await runItotoriCliCommand(cliArgs, {
    io: nodeJsonFileStore,
    migrateDatabase: migrateItotoriDatabase,
    resetDatabase: resetItotoriDatabase,
    withServices: (callback) => withDatabaseItotoriServices({}, callback),
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
