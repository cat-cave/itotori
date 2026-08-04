#!/usr/bin/env node
// Run every DB-owned app proof discovered from its adjacent declaration. This
// is collection ownership: the portable Vitest configuration excludes them.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DB_OWNED_APP_TEST_FILES } from "./db-owned-app-proofs.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function databaseAppVitestArguments() {
  return [
    "--filter",
    "@itotori/app",
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.db.config.ts",
    "--exclude",
    "**/.direnv/**",
    ...DB_OWNED_APP_TEST_FILES,
  ];
}

export function runDatabaseAppProofs(spawn = spawnSync, environment = process.env) {
  if (!environment.DATABASE_URL?.trim()) {
    throw new Error(
      "DB-owned app proofs require DATABASE_URL; missing input cannot pass this lane",
    );
  }
  const result = spawn("pnpm", databaseAppVitestArguments(), {
    cwd: repoRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runDatabaseAppProofs();
  } catch (error) {
    process.stderr.write(
      `DB-owned app proofs: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
