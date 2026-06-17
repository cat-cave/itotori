import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runItotoriCliCommand, type JsonFileStore } from "./cli-handlers.js";
import {
  migrateItotoriDatabase,
  withDatabaseItotoriServices,
} from "./services/database-services.js";

const args = process.argv.slice(2);

export async function main(cliArgs = args): Promise<void> {
  await runItotoriCliCommand(cliArgs, {
    io: nodeJsonFileStore,
    migrateDatabase: migrateItotoriDatabase,
    withServices: (callback) => withDatabaseItotoriServices({}, callback),
  });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const nodeJsonFileStore: JsonFileStore = { readJson, writeJson };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
