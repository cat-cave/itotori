import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDbSettings, dbPortCandidates, reserveDbPort } from "./qd-full-ci.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(scriptDir, "qd-full-ci.mjs");

test("derives worktree-specific local db settings", () => {
  const firstRoot = "/scratch/worktrees/itotori-node-a";
  const secondRoot = "/scratch/worktrees/itotori-node-b";

  assert.notEqual(dbPortCandidates(firstRoot)[0], dbPortCandidates(secondRoot)[0]);

  const first = buildDbSettings(firstRoot, dbPortCandidates(firstRoot)[0], {
    DATABASE_URL: "postgres://user:pass@example.com:15432/project",
  });
  const second = buildDbSettings(secondRoot, dbPortCandidates(secondRoot)[0], {
    DATABASE_URL: "postgres://user:pass@example.com:15432/project",
  });

  assert.notEqual(first.databaseUrl, second.databaseUrl);
  assert.match(first.databaseUrl, /^postgres:\/\/user:pass@127\.0\.0\.1:\d+\/project$/u);
  assert.notEqual(first.composeProjectName, second.composeProjectName);
  assert.notEqual(first.composeEnvPath, second.composeEnvPath);
});

test("ignores the justfile default compose env path for qd full CI", () => {
  const root = "/scratch/worktrees/itotori-node-default-env";
  const settings = buildDbSettings(root, 61234, {
    ITOTORI_DB_COMPOSE_ENV_PATH: ".tmp/itotori-db/compose.env",
  });

  assert.match(settings.composeEnvPath, /^\.tmp\/itotori-db\/qd-full-ci-[a-f0-9]{10}-61234\.env$/u);
});

test("honors a non-default compose env path override for qd full CI", () => {
  const settings = buildDbSettings("/scratch/worktrees/itotori-node-custom-env", 61235, {
    ITOTORI_DB_COMPOSE_ENV_PATH: ".tmp/itotori-db/custom-compose.env",
  });

  assert.equal(settings.composeEnvPath, ".tmp/itotori-db/custom-compose.env");
});

test("port reservation fails early with a clear diagnostic when the range is unavailable", async () => {
  const lockDir = mkdtempSync(path.join(os.tmpdir(), "itotori-port-locks-"));
  const occupiedLock = path.join(lockDir, "61111.lock");
  mkdirSync(occupiedLock);
  writeFileSync(
    path.join(occupiedLock, "owner.json"),
    `${JSON.stringify({ pid: process.pid, port: 61111, root: "/tmp/other-worktree" })}\n`,
  );

  await assert.rejects(
    reserveDbPort("/tmp/itotori-port-collision", {
      ITOTORI_QD_DB_PORT_BASE: "61111",
      ITOTORI_QD_DB_PORT_SPAN: "1",
      ITOTORI_QD_DB_LOCK_DIR: lockDir,
      ITOTORI_QD_DB_SKIP_PORT_PROBE: "1",
    }),
    /could not reserve a local Postgres host port[\s\S]*61111: reserved by another qd full-CI run/u,
  );
});

test("qd full CI tears down the compose stack when CI fails", () => {
  const fixture = createWrapperFixture();
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: fixture.repoRoot,
    env: createWrapperEnv(fixture, {
      JUST_FAKE_FAIL_CI: "1",
    }),
    encoding: "utf8",
  });

  assert.equal(result.status, 42, [result.stdout, result.stderr].filter(Boolean).join("\n"));
  const calls = readFileSync(fixture.logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((call) => call.args.join(" ")),
    ["db-up", "db-wait", "ci", "db-down"],
  );
  for (const call of calls) {
    assert.match(
      call.env.DATABASE_URL,
      /^postgres:\/\/itotori:itotori@127\.0\.0\.1:6120\d\/itotori$/u,
    );
    assert.match(call.env.COMPOSE_PROJECT_NAME, /^itotori-qdfullci-repo-[a-f0-9]{10}-6120\d$/u);
    assert.match(
      call.env.ITOTORI_DB_COMPOSE_ENV_PATH,
      /^\.tmp\/itotori-db\/qd-full-ci-[a-f0-9]{10}-6120\d\.env$/u,
    );
  }
});

test("qd full CI honors an explicit compose env path override in wrapper subprocesses", () => {
  const fixture = createWrapperFixture();
  const composeEnvPath = ".tmp/itotori-db/custom-wrapper.env";
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: fixture.repoRoot,
    env: createWrapperEnv(fixture, {
      ITOTORI_DB_COMPOSE_ENV_PATH: composeEnvPath,
    }),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
  const calls = readFileSync(fixture.logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((call) => call.args.join(" ")),
    ["db-up", "db-wait", "ci", "db-down"],
  );
  for (const call of calls) {
    assert.equal(call.env.ITOTORI_DB_COMPOSE_ENV_PATH, composeEnvPath);
  }
});

const qdWrapperEnvKeys = [
  "COMPOSE_DISABLE_ENV_FILE",
  "COMPOSE_PROJECT_NAME",
  "DATABASE_URL",
  "ITOTORI_DB_COMPOSE_ENV_PATH",
  "ITOTORI_QD_DB_LOCK_DIR",
  "ITOTORI_QD_DB_PORT",
  "ITOTORI_QD_DB_PORT_BASE",
  "ITOTORI_QD_DB_PORT_SPAN",
  "ITOTORI_QD_DB_SKIP_PORT_PROBE",
  "ITOTORI_QD_FULL_CI",
];

function createWrapperEnv(fixture, overrides = {}) {
  const env = { ...process.env };
  for (const key of qdWrapperEnvKeys) delete env[key];

  return {
    ...env,
    PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:55433/itotori",
    ITOTORI_QD_DB_PORT_BASE: "61200",
    ITOTORI_QD_DB_PORT_SPAN: "10",
    ITOTORI_QD_DB_LOCK_DIR: fixture.lockDir,
    ITOTORI_QD_DB_SKIP_PORT_PROBE: "1",
    JUST_FAKE_LOG: fixture.logPath,
    ...overrides,
  };
}

function createWrapperFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qd-full-ci-"));
  const repoRoot = path.join(dir, "repo");
  const binDir = path.join(dir, "bin");
  const lockDir = path.join(dir, "locks");
  const logPath = path.join(dir, "just.log");
  const fakeJustPath = path.join(binDir, "just");

  mkdirSync(path.join(repoRoot, ".qd"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    fakeJustPath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.JUST_FAKE_LOG, \`\${JSON.stringify({
  args,
  env: {
    COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME,
    DATABASE_URL: process.env.DATABASE_URL,
    ITOTORI_DB_COMPOSE_ENV_PATH: process.env.ITOTORI_DB_COMPOSE_ENV_PATH,
  },
})}\\n\`);
if (args[0] === "ci" && process.env.JUST_FAKE_FAIL_CI) process.exit(42);
`,
  );
  chmodSync(fakeJustPath, 0o755);

  return { binDir, lockDir, logPath, repoRoot };
}
