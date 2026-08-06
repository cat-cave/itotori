#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultComposeEnvPath = ".tmp/itotori-db/compose.env";
const defaultPortBase = 56000;
const defaultPortSpan = 2000;

if (import.meta.url === pathToMainUrl(process.argv[1])) {
  if (process.argv.includes("--print-database-url")) {
    // Explicit ambient DATABASE_URL wins for CI/operator consumers; otherwise
    // the worktree-declared URL. Lifecycle `require-database-url` never uses
    // ambient state and checks the stack is up.
    process.stdout.write(`${resolveDatabaseUrl(process.env)}\n`);
  } else if (process.argv.includes("--print-worktree-database-url")) {
    process.stdout.write(`${resolveWorktreeDatabaseUrl(process.env)}\n`);
  } else if (process.argv.includes("--print-compose-env-path")) {
    process.stdout.write(`${resolveComposeEnvPath(process.env)}\n`);
  } else if (process.argv.includes("--write-worktree")) {
    await writeWorktreeComposeEnv(process.env);
  } else {
    // Default write path is the worktree declaration — ambient DATABASE_URL
    // must not redirect this worktree onto another (or dead) host port.
    await writeWorktreeComposeEnv(process.env);
  }
}

/** Write the compose env file for this worktree's declared product database. */
export async function writeWorktreeComposeEnv(env = process.env) {
  const outputPath = resolveComposeEnvPath(env);
  const values = worktreeComposeEnvValues(env);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderComposeEnvFile(values));
  console.log(`wrote ${outputPath} for ${values.COMPOSE_PROJECT_NAME}`);
  return outputPath;
}

// Render the full `KEY=value\n` env file. Each value is encoded so Compose's
// dotenv interpolation gives back the credential byte-for-byte (see
// encodeEnvFileValue). Exported for round-trip testing.
export function renderComposeEnvFile(values) {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${encodeEnvFileValue(value, key)}`)
    .join("\n")}\n`;
}

/**
 * Compose env for the local worktree product-database stack.
 *
 * Deliberately ignores ambient DATABASE_URL: that value is how worktrees used
 * to collide on a shared/stale host port and then fail with ECONNREFUSED.
 * Credentials may still be overridden via ITOTORI_DB_USER/PASSWORD/NAME.
 */
export function worktreeComposeEnvValues(env = process.env) {
  const root = resolveWorktreeRoot(env);
  const databaseUrl = resolveWorktreeDatabaseUrl(env);
  const parsed = new URL(databaseUrl);
  const projectName = env.COMPOSE_PROJECT_NAME || `itotori-${path.basename(root).toLowerCase()}`;
  const safeProjectName = projectName
    .replace(/[^a-z0-9_-]/gi, "-")
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, "itotori-");
  const databaseName = parsed.pathname.replace(/^\//, "") || "itotori";

  return {
    COMPOSE_PROJECT_NAME: safeProjectName,
    ITOTORI_DB_HOST_PORT: env.ITOTORI_DB_HOST_PORT || parsed.port || "5432",
    ITOTORI_DB_USER: env.ITOTORI_DB_USER || decodeURIComponent(parsed.username || "itotori"),
    ITOTORI_DB_PASSWORD:
      env.ITOTORI_DB_PASSWORD || decodeURIComponent(parsed.password || "itotori"),
    ITOTORI_DB_NAME: env.ITOTORI_DB_NAME || decodeURIComponent(databaseName),
    ITOTORI_DB_WORKTREE_ROOT: root,
  };
}

/**
 * Compose env values. When DATABASE_URL is set (tests, explicit credential
 * round-trips), parse credentials from it. Host-port for the *declared*
 * worktree stack still comes from worktreeComposeEnvValues — callers that
 * need ambient DATABASE_URL for the full map pass it without a worktree root
 * only in tests.
 */
export function composeEnvValues(env = process.env) {
  if (!env.DATABASE_URL) return worktreeComposeEnvValues(env);

  const databaseUrl = env.DATABASE_URL;
  const parsed = new URL(databaseUrl);
  const root = resolveWorktreeRoot(env);
  const projectName = env.COMPOSE_PROJECT_NAME || `itotori-${path.basename(root).toLowerCase()}`;
  const safeProjectName = projectName
    .replace(/[^a-z0-9_-]/gi, "-")
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, "itotori-");
  const databaseName = parsed.pathname.replace(/^\//, "") || "itotori";

  return {
    COMPOSE_PROJECT_NAME: safeProjectName,
    // Port from the explicit URL only when the caller is not writing a
    // worktree stack (lifecycle uses worktreeComposeEnvValues instead).
    ITOTORI_DB_HOST_PORT: env.ITOTORI_DB_HOST_PORT || parsed.port || "5432",
    ITOTORI_DB_USER: decodeURIComponent(parsed.username || "itotori"),
    ITOTORI_DB_PASSWORD: decodeURIComponent(parsed.password || "itotori"),
    ITOTORI_DB_NAME: decodeURIComponent(databaseName),
    ITOTORI_DB_WORKTREE_ROOT: root,
  };
}

// Resolve the connection string. An explicit DATABASE_URL (CI, an operator)
// wins; otherwise derive a per-worktree URL whose host port is stable for this
// checkout but distinct from other worktrees.
export function resolveDatabaseUrl(env = process.env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  return resolveWorktreeDatabaseUrl(env);
}

/**
 * Worktree-declared DATABASE_URL. Never reads ambient DATABASE_URL — that is
 * the ambient-state bug (a port whose container is gone).
 *
 * Port resolution order:
 *   1. explicit ITOTORI_DB_HOST_PORT in env (allocator / operator override)
 *   2. ITOTORI_DB_HOST_PORT from this worktree's compose env file when the
 *      file's ITOTORI_DB_WORKTREE_ROOT matches (claimed preferred+N after a
 *      collision probe on last successful `db-up`)
 *   3. deriveHostPort(worktree) — preferred deterministic port when free
 */
export function resolveWorktreeDatabaseUrl(env = process.env) {
  const root = resolveWorktreeRoot(env);
  const port =
    env.ITOTORI_DB_HOST_PORT ||
    claimedHostPortForRoot(root, env) ||
    String(deriveHostPort(root, env));
  const user = env.ITOTORI_DB_USER || "itotori";
  const password = env.ITOTORI_DB_PASSWORD || "itotori";
  const name = env.ITOTORI_DB_NAME || "itotori";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(name)}`;
}

export function resolveComposeEnvPath(env = process.env) {
  return env.ITOTORI_DB_COMPOSE_ENV_PATH || defaultComposeEnvPath;
}

/**
 * Read the claimed host port from compose.env only when that file belongs to
 * `root`. A foreign or stale compose env must not redirect another worktree.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function claimedHostPortForRoot(root, env = process.env) {
  const values = readComposeEnvFile(resolveComposeEnvPath(env));
  if (!values?.ITOTORI_DB_HOST_PORT) return undefined;
  const fileRoot = values.ITOTORI_DB_WORKTREE_ROOT;
  if (!fileRoot) return undefined;
  if (realRoot(fileRoot) !== realRoot(root)) return undefined;
  return values.ITOTORI_DB_HOST_PORT;
}

/**
 * Read ITOTORI_DB_HOST_PORT from the worktree compose env file, if present.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function readDeclaredHostPort(env = process.env) {
  return claimedHostPortForRoot(resolveWorktreeRoot(env), env);
}

/**
 * Parse a compose env file produced by renderComposeEnvFile.
 * @param {string} filePath
 * @returns {Record<string, string> | null}
 */
export function readComposeEnvFile(filePath) {
  if (!existsSync(filePath)) return null;
  /** @type {Record<string, string>} */
  const values = {};
  for (const rawLine of readFileSync(filePath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    const encoded = line.slice(eq + 1);
    values[key] =
      encoded.startsWith("'") && encoded.endsWith("'") && encoded.length >= 2
        ? decodeComposeEnvFileValue(encoded)
        : encoded;
  }
  return values;
}

// Map a canonical worktree root to a stable host port, mirroring the
// CARGO_TARGET_DIR scheme in AGENTS.md (sha256 of the canonical root path).
export function deriveHostPort(root, env = process.env) {
  const { base, span } = portRange(env);
  return base + (stableNumber(root) % span);
}

/** @returns {{ base: number, span: number }} */
export function portRange(env = process.env) {
  const base = parsePort(
    env.ITOTORI_DB_HOST_PORT_BASE || String(defaultPortBase),
    "ITOTORI_DB_HOST_PORT_BASE",
  );
  const span = parseSpan(env.ITOTORI_DB_HOST_PORT_SPAN || String(defaultPortSpan), base);
  return { base, span };
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

// Dollar-safe compose env-file value encoder (UNIV-022).
//
// `docker compose --env-file` runs each value through compose-go's dotenv
// interpolation. In an UNQUOTED or DOUBLE-QUOTED value, `$VAR` / `${VAR}` are
// expanded and only `$$` survives as a literal `$` — so a DB credential
// containing a bare `$` (e.g. `p$4ssw0rd`) is MANGLED (`$4ssw0rd` expands to
// empty). The previous `JSON.stringify` encoder emitted a double-quoted value
// and did NOT escape `$`, so any `$` in a decoded DATABASE_URL credential was
// silently corrupted before Postgres ever saw it.
//
// compose-go dotenv, by contrast, treats a SINGLE-QUOTED value's CONTENT as a
// raw literal: no variable expansion and no backslash unescaping. So we
// single-quote every value, which preserves `$`, double quotes, spaces, braces,
// and interior backslashes byte-for-byte.
//
// There is ONE subtlety, and it is why this encoder is not a blanket "backslash
// is always safe": compose-go's dotenv terminator scan (the loop that hunts for
// the CLOSING quote) treats `\` as escaping the FOLLOWING byte for BOTH quote
// styles, even though the single-quote CONTENT is otherwise raw. A value ending
// in an ODD run of backslashes therefore has its last backslash escape the
// closing quote, so compose-go never finds the terminator and mis-parses the
// value as unterminated. An EVEN trailing run pairs up harmlessly and the
// closing quote stays free. So we REJECT — with a semantic diagnostic naming
// the offending character — the bytes a single-quoted value provably cannot
// round-trip: a single quote, a newline/CR, and a value ending in an odd run of
// backslashes. Credentials generally never contain those, so the reject path is
// a guard, not a routine outcome.
export function encodeEnvFileValue(value, name = "value") {
  const str = String(value);
  const newline = str.match(/[\r\n]/u);
  if (newline) {
    const char = newline[0] === "\n" ? "newline (\\n)" : "carriage return (\\r)";
    throw new Error(
      `cannot encode ${name} into a compose env file: value contains a ${char}, ` +
        `which a single-quoted compose env-file value cannot carry`,
    );
  }
  if (str.includes("'")) {
    throw new Error(
      `cannot encode ${name} into a compose env file: value contains a single quote ('), ` +
        `which cannot be represented in a single-quoted compose env-file value ` +
        `(compose-go dotenv has no in-quote escape for it)`,
    );
  }
  const trailingBackslashes = str.match(/\\+$/u);
  if (trailingBackslashes && trailingBackslashes[0].length % 2 === 1) {
    throw new Error(
      `cannot encode ${name} into a compose env file: value ends in an odd run of ` +
        `backslashes (\\), whose final backslash escapes the closing quote in ` +
        `compose-go's dotenv terminator scan and leaves the value unterminated`,
    );
  }
  return `'${str}'`;
}

// Reference decoder modelling compose-go's dotenv single-quote parsing. It does
// NOT simply strip the surrounding quotes: it reproduces compose-go's TERMINATOR
// SCAN, in which `\` escapes the following byte (including the closing quote).
// A value whose trailing backslash run is odd escapes its own closing quote,
// leaving the value UNTERMINATED — this decoder must surface that mis-parse so
// the round-trip test would EXPOSE an encoder that emitted such a value, rather
// than hide it behind a naive strip-the-quotes model. Encoding a value and
// decoding the result must reproduce the input byte-for-byte. Exported so the
// round-trip test can prove the model without requiring a compose binary.
export function decodeComposeEnvFileValue(encoded) {
  if (encoded.length < 2 || encoded[0] !== "'") {
    throw new Error(`not a single-quoted compose env-file value: ${encoded}`);
  }
  let i = 1;
  while (i < encoded.length) {
    const ch = encoded[i];
    if (ch === "\\") {
      // A backslash escapes the next byte; neither can terminate the value.
      i += 2;
      continue;
    }
    if (ch === "'") {
      if (i !== encoded.length - 1) {
        throw new Error(
          `trailing bytes after the closing quote in a compose env-file value: ${encoded}`,
        );
      }
      return encoded.slice(1, i);
    }
    i += 1;
  }
  throw new Error(
    `unterminated single-quoted compose env-file value ` +
      `(a trailing backslash escaped the closing quote): ${encoded}`,
  );
}

function pathToMainUrl(value) {
  if (!value) return null;
  return pathToFileURL(path.resolve(value)).href;
}
