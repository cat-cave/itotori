#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { affectedCiLanes } from "./affected.mjs";

const defaultDatabaseUrl = "postgres://itotori:itotori@127.0.0.1:55433/itotori";
const defaultComposeEnvPath = path.join(".tmp", "itotori-db", "compose.env");
const defaultPortBase = 55433;
const defaultPortSpan = 2000;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

if (import.meta.url === pathToMainUrl(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

// qd-full-ci is the per-gate CI entrypoint. Per-gate CI is single-mode SYNTHETIC
// (fast, copyright-free): it runs the synthetic suites + the mutation-differential
// guardrail, NOT the ~30-45min real-bytes lane (that lane is periodic-only, via
// `just real-bytes-oracle`). Instead of always running the full `just ci`, it
// selects only the lanes a diff can affect:
//
//   * shared / foundational change (workspace Cargo.toml, justfile, scripts/,
//     .github/, root files) OR `--all` / ITOTORI_QD_FULL_CI_ALL=1 -> full `just ci`.
//   * apps/itotori-only / TS-only change -> ci-itotori (+ check); the rust
//     build/test and mutation-differential lanes are SKIPPED (apps/itotori has no
//     kaifuu/utsushi dependency).
//   * a crates/kaifuu-* or crates/utsushi-* change -> that family's rust gate +
//     mutation-differential, dependency-graph-expanded (utsushi depends on kaifuu,
//     so a kaifuu change also runs ci-utsushi). See affectedCiLanes() in affected.mjs.
//
// Lane selection is dependency-graph-correct and conservative (when in doubt a
// lane runs; nothing is permanently skipped — the full gate is always available
// via `just ci` / `just ci-full` / `node scripts/qd-full-ci.mjs --all`).
//
// The qd-managed disposable Postgres is only started for the full `ci` lane
// (which owns db-migrate/test); the fine-grained ci-itotori gate self-manages its
// own DB, so fine-grained runs skip the extra db-up/db-down.
async function main() {
  const root = findProjectRoot(process.cwd());
  const lanes = selectLanes(root, process.env);
  const needsManagedDb = lanes.includes("ci");
  console.log(
    `qd-full-ci affected-lane selection: ${lanes.join(" ") || "(none)"}` +
      (needsManagedDb ? "" : " [fine-grained; qd-managed Postgres skipped]"),
  );

  const reservation = await reserveDbPort(root, process.env);
  let status = 0;
  let teardown = null;
  try {
    const settings = buildDbSettings(root, reservation.port, process.env);
    const childEnv = {
      ...process.env,
      COMPOSE_DISABLE_ENV_FILE: "1",
      COMPOSE_PROJECT_NAME: settings.composeProjectName,
      DATABASE_URL: settings.databaseUrl,
      ITOTORI_DB_COMPOSE_ENV_PATH: settings.composeEnvPath,
      ITOTORI_QD_FULL_CI: "1",
    };
    let dbAttempted = false;
    let exiting = false;

    teardown = () => {
      let downStatus = 0;
      if (dbAttempted && !exiting) {
        exiting = true;
        try {
          downStatus = runJust(root, childEnv, ["db-down"]).status ?? 1;
        } finally {
          exiting = false;
        }
      }
      removeOwnedComposeEnv(root, settings);
      return downStatus;
    };

    installSignalHandlers(teardown);

    console.log(
      [
        "qd-full-ci using local disposable Postgres",
        `project=${settings.composeProjectName}`,
        `port=${reservation.port}`,
        `env=${settings.composeEnvPath}`,
      ].join(" "),
    );

    if (needsManagedDb) {
      dbAttempted = true;
      status = runJust(root, childEnv, ["db-up"]).status ?? 1;
      if (status === 0) status = runJust(root, childEnv, ["db-wait"]).status ?? 1;
    }
    for (const lane of lanes) {
      if (status !== 0) break;
      status = runJust(root, childEnv, [lane]).status ?? 1;
    }
  } finally {
    try {
      const downStatus = teardown ? teardown() : 0;
      if (downStatus !== 0) {
        console.error(`qd-full-ci db-down failed with status ${downStatus}`);
      }
      if (status === 0 && downStatus !== 0) status = downStatus;
    } finally {
      await reservation.release();
    }
  }

  process.exit(status);
}

function runJust(root, env, args) {
  const result = spawnSync("just", args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result;
}

// Choose the lanes to run for this gate. `--all` (or ITOTORI_QD_FULL_CI_ALL=1)
// forces the complete gate. Otherwise the diff vs the base branch (ITOTORI_QD_
// AFFECTED_BASE, default `main`) drives affected-lane selection. Any inability to
// determine the diff falls back to the full `ci` gate (conservative).
export function selectLanes(root, env = process.env, argv = process.argv) {
  if (argv.includes("--all") || env.ITOTORI_QD_FULL_CI_ALL === "1") return ["ci"];

  const changed = computeChangedPaths(root, env);
  if (changed === null) return ["ci"]; // cannot determine the diff -> full gate
  if (changed.size === 0) return ["ci"]; // no diff vs base -> full gate (conservative)

  const lanes = affectedCiLanes([...changed], { root });
  // Docs-only diffs affect no build lane; still run the fast base gate so a gate
  // run is never a zero-verification green.
  return lanes.length > 0 ? lanes : ["check"];
}

function gitOutput(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout;
}

function splitPathLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// Union of (a) commits on this branch since it diverged from the base branch,
// (b) unstaged/staged working-tree changes, and (c) untracked files. Returns null
// when the diff cannot be determined (not a git worktree, or every git query failed).
function computeChangedPaths(root, env) {
  if (!existsSync(path.join(root, ".git"))) return null;

  const base = env.ITOTORI_QD_AFFECTED_BASE || "main";
  const paths = new Set();
  let anySucceeded = false;

  const mergeBase = gitOutput(root, ["merge-base", "HEAD", base]);
  if (mergeBase) {
    const committed = gitOutput(root, ["diff", "--name-only", `${mergeBase.trim()}...HEAD`]);
    if (committed !== null) {
      anySucceeded = true;
      for (const line of splitPathLines(committed)) paths.add(line);
    }
  }

  const worktree = gitOutput(root, ["diff", "--name-only", "HEAD"]);
  if (worktree !== null) {
    anySucceeded = true;
    for (const line of splitPathLines(worktree)) paths.add(line);
  }

  const untracked = gitOutput(root, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked !== null) {
    anySucceeded = true;
    for (const line of splitPathLines(untracked)) paths.add(line);
  }

  return anySucceeded ? paths : null;
}

function installSignalHandlers(teardown) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      const status = teardown();
      process.exit(status === 0 ? signalExitCode(signal) : status);
    });
  }
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

export async function reserveDbPort(root, env = process.env) {
  const candidates = dbPortCandidates(root, env);
  const lockRoot = env.ITOTORI_QD_DB_LOCK_DIR || path.join(os.tmpdir(), "itotori-qd-db-ports");
  await mkdir(lockRoot, { recursive: true });

  const diagnostics = [];
  for (const port of candidates) {
    const lockPath = path.join(lockRoot, `${port}.lock`);
    const lock = await acquirePortLock(lockPath, port, root);
    if (!lock) {
      diagnostics.push(`${port}: reserved by another qd full-CI run`);
      continue;
    }

    if (env.ITOTORI_QD_DB_SKIP_PORT_PROBE === "1" || (await isPortAvailable(port))) {
      return { port, release: lock.release };
    }

    await lock.release();
    diagnostics.push(`${port}: already bound on 127.0.0.1`);
  }

  throw new Error(
    [
      "qd-full-ci could not reserve a local Postgres host port.",
      "Set ITOTORI_QD_DB_PORT or ITOTORI_QD_DB_PORT_BASE/ITOTORI_QD_DB_PORT_SPAN to an unused range.",
      ...diagnostics.map((line) => `  - ${line}`),
    ].join("\n"),
  );
}

async function acquirePortLock(lockPath, port, root) {
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!(await clearStaleLock(lockPath))) return null;
    await mkdir(lockPath);
  }

  const metadataPath = path.join(lockPath, "owner.json");
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        pid: process.pid,
        port,
        root,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  return {
    release: async () => {
      await rm(lockPath, { recursive: true, force: true });
    },
  };
}

async function clearStaleLock(lockPath) {
  let owner;
  try {
    owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    return false;
  }

  if (typeof owner.pid !== "number" || isProcessRunning(owner.pid)) return false;
  await rm(lockPath, { recursive: true, force: true });
  return true;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export function dbPortCandidates(root, env = process.env) {
  if (env.ITOTORI_QD_DB_PORT) {
    return [parsePort(env.ITOTORI_QD_DB_PORT, "ITOTORI_QD_DB_PORT")];
  }

  const base = parsePort(
    env.ITOTORI_QD_DB_PORT_BASE || String(defaultPortBase),
    "ITOTORI_QD_DB_PORT_BASE",
  );
  const span = parseSpan(env.ITOTORI_QD_DB_PORT_SPAN || String(defaultPortSpan), base);
  const firstOffset = stableNumber(root) % span;
  return Array.from({ length: span }, (_, index) => base + ((firstOffset + index) % span));
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer TCP port between 1 and 65535`);
  }
  return port;
}

function parseSpan(value, base) {
  const span = Number(value);
  if (!Number.isInteger(span) || span < 1 || base + span - 1 > 65535) {
    throw new Error("ITOTORI_QD_DB_PORT_SPAN must keep the derived port range within 1..65535");
  }
  return span;
}

export function buildDbSettings(root, port, env = process.env) {
  const databaseUrl = databaseUrlWithPort(env.DATABASE_URL || defaultDatabaseUrl, port);
  const rootHash = hashText(realRoot(root)).slice(0, 10);
  const rootSlug = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+/u, "");
  const composeProjectName = `itotori-qdfullci-${rootSlug || "worktree"}-${rootHash}-${port}`;
  return {
    composeEnvPath: qdComposeEnvPath(root, rootHash, port, env),
    ownsComposeEnvPath: ownsQdComposeEnvPath(root, env),
    composeProjectName,
    databaseUrl,
  };
}

function qdComposeEnvPath(root, rootHash, port, env) {
  const value = env.ITOTORI_DB_COMPOSE_ENV_PATH;
  if (value && !isDefaultComposeEnvPath(root, value)) return value;
  return path.join(".tmp", "itotori-db", `qd-full-ci-${rootHash}-${port}.env`);
}

function isDefaultComposeEnvPath(root, value) {
  return path.resolve(root, value) === path.resolve(root, defaultComposeEnvPath);
}

function ownsQdComposeEnvPath(root, env) {
  const value = env.ITOTORI_DB_COMPOSE_ENV_PATH;
  return !value || isDefaultComposeEnvPath(root, value);
}

function removeOwnedComposeEnv(root, settings) {
  if (!settings.ownsComposeEnvPath) return;
  rmSync(path.resolve(root, settings.composeEnvPath), { force: true });
}

function databaseUrlWithPort(value, port) {
  const parsed = new URL(value);
  parsed.protocol = "postgres:";
  parsed.hostname = "127.0.0.1";
  parsed.port = String(port);
  if (!parsed.username) parsed.username = "itotori";
  if (!parsed.password) parsed.password = "itotori";
  if (!parsed.pathname || parsed.pathname === "/") parsed.pathname = "/itotori";
  return parsed.toString();
}

function stableNumber(value) {
  return Number.parseInt(hashText(realRoot(value)).slice(0, 12), 16);
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function realRoot(root) {
  try {
    return realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

function findProjectRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, ".qd"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return repoRoot;
    current = parent;
  }
}

function pathToMainUrl(value) {
  if (!value) return null;
  return pathToFileURL(path.resolve(value)).href;
}
