import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDbSettings, dbPortCandidates, reserveDbPort, selectLanes } from "./qd-full-ci.mjs";

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
  assert.equal(settings.ownsComposeEnvPath, false);
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
  const calls = readJustCalls(fixture);
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

  const composeEnvPath = path.join(fixture.repoRoot, calls[0].env.ITOTORI_DB_COMPOSE_ENV_PATH);
  assert.equal(existsSync(composeEnvPath), false);
});

test("qd full CI deletes generated compose env files after successful CI", () => {
  const fixture = createWrapperFixture();
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: fixture.repoRoot,
    env: createWrapperEnv(fixture),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
  const calls = readJustCalls(fixture);
  assert.deepEqual(
    calls.map((call) => call.args.join(" ")),
    ["db-up", "db-wait", "ci", "db-down"],
  );

  const composeEnvPath = path.join(fixture.repoRoot, calls[0].env.ITOTORI_DB_COMPOSE_ENV_PATH);
  assert.equal(existsSync(composeEnvPath), false);
  assert.equal(readFileSync(fixture.composeEnvAuditPath, "utf8").includes("itotori:itotori"), true);
});

test("qd full CI honors an explicit compose env path override in wrapper subprocesses", () => {
  const fixture = createWrapperFixture();
  const composeEnvPath = path.join(fixture.dir, "custom-wrapper.env");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: fixture.repoRoot,
    env: createWrapperEnv(fixture, {
      ITOTORI_DB_COMPOSE_ENV_PATH: composeEnvPath,
    }),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
  const calls = readJustCalls(fixture);
  assert.deepEqual(
    calls.map((call) => call.args.join(" ")),
    ["db-up", "db-wait", "ci", "db-down"],
  );
  for (const call of calls) {
    assert.equal(call.env.ITOTORI_DB_COMPOSE_ENV_PATH, composeEnvPath);
  }
  assert.equal(existsSync(composeEnvPath), true);
  assert.equal(readFileSync(composeEnvPath, "utf8").includes("itotori:itotori"), true);
});

// ---------------------------------------------------------------------------
// DIRECT-TO-MAIN affected-base default: when HEAD == the resolved base (main),
// selectLanes defaults the diff to this commit's own changes (HEAD~1...HEAD)
// instead of conservatively re-running the full `ci` on an empty merge-base diff.
// These exercise REAL temporary git repositories.
// ---------------------------------------------------------------------------

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${[result.stdout, result.stderr].filter(Boolean).join("\n")}`,
  );
  return (result.stdout ?? "").trim();
}

// Build a temp repo whose default branch is `main`, applying `commits` in order.
// Each commit is { files: { "relative/path": "contents" } }. Returns the repo root
// plus the ordered commit shas (shas[0] is the first/root commit).
function makeGitRepo(commits) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qd-affected-git-"));
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["config", "user.email", "ci@itotori.test"]);
  runGit(root, ["config", "user.name", "Itotori CI"]);
  runGit(root, ["config", "commit.gpgsign", "false"]);

  const shas = [];
  for (const commit of commits) {
    for (const [relPath, contents] of Object.entries(commit.files)) {
      const abs = path.join(root, relPath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    }
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-q", "-m", commit.message ?? "commit"]);
    shas.push(runGit(root, ["rev-parse", "HEAD"]));
  }
  return { root, shas };
}

// A minimal workspace manifest so affectedCiLanes -> buildCrateFamilyDependents can
// read Cargo.toml (empty members => no crate families) for fine-grained selections.
const EMPTY_WORKSPACE_CARGO = '[workspace]\nresolver = "2"\nmembers = [\n]\n';

test("selectLanes direct-to-main: HEAD==main itotori-only commit selects the fast ci-itotori lane (not full ci)", () => {
  const { root } = makeGitRepo([
    { files: { "Cargo.toml": EMPTY_WORKSPACE_CARGO, "README.md": "base\n" } },
    { files: { "apps/itotori/src/server.ts": "export const x = 1;\n" } },
  ]);

  // HEAD == main, so the merge-base diff is empty; the HEAD~1 default must kick in
  // and scope to this commit's own change (apps/itotori -> ci-itotori).
  const lanes = selectLanes(root, {}, ["node", "qd-full-ci"]);
  assert.ok(lanes.includes("ci-itotori"), `expected ci-itotori, got ${JSON.stringify(lanes)}`);
  assert.ok(!lanes.includes("ci"), "must NOT escalate to the full ci gate on HEAD==main");
});

test("selectLanes direct-to-main: HEAD==main docs-only commit selects only [check]", () => {
  const { root } = makeGitRepo([
    { files: { "README.md": "base\n" } },
    { files: { "docs/notes.md": "docs change\n" } },
  ]);

  assert.deepEqual(selectLanes(root, {}, ["node", "qd-full-ci"]), ["check"]);
});

test("selectLanes: explicit ITOTORI_QD_AFFECTED_BASE override is honored (not re-pointed at HEAD~1)", () => {
  const { root, shas } = makeGitRepo([
    { files: { "Cargo.toml": EMPTY_WORKSPACE_CARGO, "README.md": "base\n" } },
    { files: { "apps/itotori/src/server.ts": "export const x = 1;\n" } },
    { files: { "docs/notes.md": "docs change\n" } },
  ]);

  // HEAD~1 (the docs commit) alone would select only [check]; pointing the base at
  // the root commit must include the itotori change from the middle commit.
  const lanes = selectLanes(root, { ITOTORI_QD_AFFECTED_BASE: shas[0] }, ["node", "qd-full-ci"]);
  assert.ok(lanes.includes("ci-itotori"), `expected ci-itotori, got ${JSON.stringify(lanes)}`);
});

test("selectLanes: --all and ITOTORI_QD_FULL_CI_ALL=1 force the full ci gate", () => {
  const { root } = makeGitRepo([
    { files: { "apps/itotori/src/server.ts": "export const x = 1;\n" } },
  ]);
  assert.deepEqual(selectLanes(root, {}, ["node", "qd-full-ci", "--all"]), ["ci"]);
  assert.deepEqual(selectLanes(root, { ITOTORI_QD_FULL_CI_ALL: "1" }, ["node", "qd-full-ci"]), [
    "ci",
  ]);
});

test("selectLanes conservative fallback: HEAD==main merge commit runs the full ci gate", () => {
  const { root } = makeGitRepo([{ files: { "README.md": "base\n" } }]);
  runGit(root, ["checkout", "-q", "-b", "feature"]);
  mkdirSync(path.join(root, "apps/itotori/src"), { recursive: true });
  writeFileSync(path.join(root, "apps/itotori/src/server.ts"), "export const y = 2;\n");
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", "feature work"]);
  runGit(root, ["checkout", "-q", "main"]);
  // A true merge commit (2 parents) on HEAD==main.
  runGit(root, ["merge", "--no-ff", "-q", "-m", "merge feature", "feature"]);
  assert.equal(runGit(root, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(/\s+/).length, 3);

  assert.deepEqual(selectLanes(root, {}, ["node", "qd-full-ci"]), ["ci"]);
});

test("selectLanes conservative fallback: a root commit with no HEAD~1 runs the full ci gate", () => {
  const { root } = makeGitRepo([
    { files: { "apps/itotori/src/server.ts": "export const x = 1;\n" } },
  ]);
  // Single root commit: HEAD==main and there is no HEAD~1 -> conservative full gate.
  assert.deepEqual(selectLanes(root, {}, ["node", "qd-full-ci"]), ["ci"]);
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
    JUST_FAKE_COMPOSE_ENV_AUDIT: fixture.composeEnvAuditPath,
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
  const composeEnvAuditPath = path.join(dir, "compose-env-audit.log");
  const fakeJustPath = path.join(binDir, "just");

  mkdirSync(path.join(repoRoot, ".qd"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    fakeJustPath,
    `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
appendFileSync(process.env.JUST_FAKE_LOG, \`\${JSON.stringify({
  args,
  env: {
    COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME,
    DATABASE_URL: process.env.DATABASE_URL,
    ITOTORI_DB_COMPOSE_ENV_PATH: process.env.ITOTORI_DB_COMPOSE_ENV_PATH,
  },
})}\\n\`);
if (args[0] === "db-up") {
  mkdirSync(path.dirname(process.env.ITOTORI_DB_COMPOSE_ENV_PATH), { recursive: true });
  const content = \`DATABASE_URL=\${process.env.DATABASE_URL}\\n\`;
  writeFileSync(process.env.ITOTORI_DB_COMPOSE_ENV_PATH, content);
  writeFileSync(process.env.JUST_FAKE_COMPOSE_ENV_AUDIT, content);
}
if (args[0] === "ci" && process.env.JUST_FAKE_FAIL_CI) process.exit(42);
`,
  );
  chmodSync(fakeJustPath, 0o755);

  return { binDir, composeEnvAuditPath, dir, lockDir, logPath, repoRoot };
}

function readJustCalls(fixture) {
  return readFileSync(fixture.logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
