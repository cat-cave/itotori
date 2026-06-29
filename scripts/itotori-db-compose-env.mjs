#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultComposeEnvPath = ".tmp/itotori-db/compose.env";
// Per-worktree Postgres host port range. The base sits above qd-full-ci's
// reservation window (55433+) so a plain `just db-up` and a concurrent
// qd-full-ci run never fight for the same default port.
const defaultPortBase = 56000;
const defaultPortSpan = 2000;

if (import.meta.url === pathToMainUrl(process.argv[1])) {
  if (process.argv.includes("--print-database-url")) {
    process.stdout.write(`${resolveDatabaseUrl(process.env)}\n`);
  } else {
    await writeComposeEnv(process.env);
  }
}

async function writeComposeEnv(env) {
  const outputPath = env.ITOTORI_DB_COMPOSE_ENV_PATH || defaultComposeEnvPath;
  const values = composeEnvValues(env);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${escapeEnvFileValue(value)}`)
      .join("\n")}\n`,
  );
  console.log(`wrote ${outputPath} for ${values.COMPOSE_PROJECT_NAME}`);
}

export function composeEnvValues(env = process.env) {
  const databaseUrl = resolveDatabaseUrl(env);
  const parsed = new URL(databaseUrl);
  const projectName =
    env.COMPOSE_PROJECT_NAME || `itotori-${path.basename(process.cwd()).toLowerCase()}`;
  const safeProjectName = projectName
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^[^a-z0-9]+/, "itotori-");
  const databaseName = parsed.pathname.replace(/^\//, "") || "itotori";

  return {
    COMPOSE_PROJECT_NAME: safeProjectName,
    ITOTORI_DB_HOST_PORT: env.ITOTORI_DB_HOST_PORT || parsed.port || "5432",
    ITOTORI_DB_USER: decodeURIComponent(parsed.username || "itotori"),
    ITOTORI_DB_PASSWORD: decodeURIComponent(parsed.password || "itotori"),
    ITOTORI_DB_NAME: decodeURIComponent(databaseName),
  };
}

// Resolve the connection string. An explicit DATABASE_URL (CI, an operator, or
// the devshell hook) wins; otherwise derive a per-worktree URL whose host port
// is stable for this checkout but distinct from other worktrees.
export function resolveDatabaseUrl(env = process.env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const port = deriveHostPort(resolveWorktreeRoot(env), env);
  return `postgres://itotori:itotori@127.0.0.1:${port}/itotori`;
}

// Map a canonical worktree root to a stable host port, mirroring the
// CARGO_TARGET_DIR scheme in AGENTS.md (sha256 of the canonical root path).
export function deriveHostPort(root, env = process.env) {
  const base = parsePort(
    env.ITOTORI_DB_HOST_PORT_BASE || String(defaultPortBase),
    "ITOTORI_DB_HOST_PORT_BASE",
  );
  const span = parseSpan(env.ITOTORI_DB_HOST_PORT_SPAN || String(defaultPortSpan), base);
  return base + (stableNumber(root) % span);
}

export function resolveWorktreeRoot(env = process.env) {
  if (env.ITOTORI_DB_WORKTREE_ROOT) return env.ITOTORI_DB_WORKTREE_ROOT;
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) return top;
  } catch {
    // Not a git checkout (or git is unavailable); fall back to the cwd.
  }
  return process.cwd();
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
    throw new Error("ITOTORI_DB_HOST_PORT_SPAN must keep the derived port range within 1..65535");
  }
  return span;
}

function stableNumber(root) {
  return Number.parseInt(hashText(realRoot(root)).slice(0, 12), 16);
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

function escapeEnvFileValue(value) {
  return JSON.stringify(String(value).replace(/\r?\n/gu, ""));
}

function pathToMainUrl(value) {
  if (!value) return null;
  return pathToFileURL(path.resolve(value)).href;
}
