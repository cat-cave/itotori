#!/usr/bin/env node
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { databaseRunnerNodeTestFiles } from "./test-file-manifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = path.join(repoRoot, "packages/itotori-db");
const skipReportPath = path.join(repoRoot, ".tmp/itotori-db/no-database-skipped.json");
const packageName = "@itotori/db";
const requiredEnv = "DATABASE_URL";
const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const requireDatabase = rawArgs.includes("--require-database");
const portable = rawArgs.includes("--portable");
const vitestArgs = rawArgs.filter((arg) => arg !== "--require-database" && arg !== "--portable");

if (portable === requireDatabase) {
  throw new Error("choose exactly one runner mode: --portable or --require-database");
}

runRequiredCommand(
  process.execPath,
  ["--test", path.join(packageRoot, databaseRunnerNodeTestFiles[0])],
  "permission verifier regression tests",
);

runRequiredCommand(
  process.execPath,
  ["--test", path.join(packageRoot, databaseRunnerNodeTestFiles[1])],
  "event queue index alignment regression tests",
);

runRequiredCommand(
  process.execPath,
  [path.join(packageRoot, "scripts/verify-permission-constraints.mjs")],
  "permission verifier",
);

runRequiredCommand(
  process.execPath,
  [path.join(packageRoot, "scripts/verify-event-queue-index-alignment.mjs")],
  "event queue index alignment verifier",
);

if (portable) {
  console.log(`${packageName}: portable verifier tests passed; DB suites belong to ci-tier1-db`);
  process.exit(0);
}

if (!process.env[requiredEnv]?.trim()) {
  console.error(`${packageName} DB tests require ${requiredEnv}; run just test db`);
  process.exit(1);
}

await rm(skipReportPath, { force: true });

const child = spawn("vitest", ["run", ...vitestArgs], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function runRequiredCommand(command, args, label) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`${label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
