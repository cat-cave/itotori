#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = path.join(repoRoot, "packages/itotori-db");
const skipReportPath = path.join(repoRoot, ".tmp/itotori-db/no-database-skipped.json");
const dbTestCommand = "pnpm --filter @itotori/db test";

runRequiredCommand(
  process.execPath,
  ["--test", path.join(packageRoot, "scripts/verify-permission-constraints.test.mjs")],
  "permission verifier regression tests",
);

runRequiredCommand(
  process.execPath,
  [path.join(packageRoot, "scripts/verify-permission-constraints.mjs")],
  "permission verifier",
);

if (!process.env.DATABASE_URL) {
  await mkdir(path.dirname(skipReportPath), { recursive: true });
  await writeFile(
    skipReportPath,
    `${JSON.stringify(
      {
        status: "skipped",
        reason: "DATABASE_URL unset",
        command: dbTestCommand,
        checkedEnv: ["DATABASE_URL"],
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log("itotori db tests skipped: DATABASE_URL unset");
  process.exit(0);
}

await rm(skipReportPath, { force: true });

const child = spawn("vitest", ["run", "--dir", "test"], {
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
