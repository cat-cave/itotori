import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ITOTORI_PRODUCT_VERSION } from "@itotori/localization-bridge-schema";
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { withTemporarySecretFile } from "./env/temporary-secret-file.js";
import { runInitCommand, type InitCommandDeps } from "./init-command.js";
import { initializeHostLifecycle, verifyHostLifecycleReadiness } from "./install-lifecycle.js";
import type { ItotoriCliDependencies } from "./cli-handler-contracts.js";

export async function runInitHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const initDeps: InitCommandDeps = dependencies.initDeps ?? constructDefaultInitDeps(dependencies);
  await runInitCommand(args, initDeps);
}

function constructDefaultInitDeps(dependencies: ItotoriCliDependencies): InitCommandDeps {
  void dependencies;
  return {
    env: process.env,
    existsPath: (path) => existsSync(path),
    writeText: (path, contents, mode) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, { mode: mode ?? 0o600 });
      if (mode !== undefined) chmodSync(path, mode);
    },
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    log: (message) => process.stdout.write(`${message}\n`),
    defaultDatabaseUrl: () => defaultLocalDatabaseUrl(process.env),
    provisionDatabase: async (databaseUrl) => provisionLocalPostgresContainer(databaseUrl),
    preflightHostLifecycle: (input) => {
      verifyHostLifecycleReadiness(input);
    },
    initializeHostLifecycle,
    currentReleasePayloadPath: resolveInstalledPackagePayloadPath,
    currentReleaseVersion: () => ITOTORI_PRODUCT_VERSION,
    migrateDatabaseForHostLifecycle: async () => await dependencies.migrateDatabase(),
  };
}

/**
 * The bundled CLI runs through a tiny `bin/itotori.js` launcher. Retaining
 * `process.argv[1]` would copy that launcher alone, leaving its `dist/` import
 * behind. Resolve the full installed package rooted around this bundled module
 * instead, so every retained release remains runnable through `current/bin`.
 */
export function resolveInstalledPackagePayloadPath(moduleUrl = import.meta.url): string {
  let bundlePath: string;
  try {
    bundlePath = fileURLToPath(moduleUrl);
  } catch {
    throw new Error("itotori init cannot identify its installed package payload");
  }
  const distDirectory = dirname(bundlePath);
  const packageRoot = dirname(distDirectory);
  const requiredPaths = [
    bundlePath,
    join(packageRoot, "package.json"),
    join(packageRoot, "bin", "itotori.js"),
    join(packageRoot, "migrations"),
  ];
  if (
    basename(distDirectory) !== "dist" ||
    basename(bundlePath) !== "cli.js" ||
    !requiredPaths.every(existsSync)
  ) {
    throw new Error(
      "itotori init cannot identify a complete installed package payload; pass --release-payload <directory>",
    );
  }
  return realpathSync(packageRoot);
}

function defaultLocalDatabaseUrl(env: Record<string, string | undefined>): string {
  const port = env.ITOTORI_DB_HOST_PORT ?? String(deriveLocalDatabasePort(env));
  return `postgres://itotori:itotori@127.0.0.1:${port}/itotori`;
}

function deriveLocalDatabasePort(env: Record<string, string | undefined>): number {
  const base = parsePort(env.ITOTORI_DB_HOST_PORT_BASE ?? "56000", "ITOTORI_DB_HOST_PORT_BASE");
  const span = parsePort(env.ITOTORI_DB_HOST_PORT_SPAN ?? "2000", "ITOTORI_DB_HOST_PORT_SPAN");
  if (base + span - 1 > 65535) {
    throw new Error("ITOTORI_DB_HOST_PORT_SPAN must keep the derived port range within 1..65535");
  }
  return base + (stableNumber(resolveWorktreeRoot(env)) % span);
}

function resolveWorktreeRoot(env: Record<string, string | undefined>): string {
  if (env.ITOTORI_DB_WORKTREE_ROOT !== undefined && env.ITOTORI_DB_WORKTREE_ROOT.length > 0) {
    return env.ITOTORI_DB_WORKTREE_ROOT;
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top.length > 0) return top;
  } catch {
    // Installed packages and non-git directories use the current directory.
  }
  return process.cwd();
}

function stableNumber(root: string): number {
  return Number.parseInt(
    createHash("sha256").update(realRoot(root)).digest("hex").slice(0, 12),
    16,
  );
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function parsePort(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer TCP port between 1 and 65535`);
  }
  return port;
}

function provisionLocalPostgresContainer(databaseUrl: string): { ok: boolean; message: string } {
  const runtime = firstRunnableCommand(["docker", "podman"]);
  if (runtime === undefined) {
    return {
      ok: false,
      message:
        "Could not auto-start local Postgres because Docker/Podman is unavailable. " +
        "Install Docker/Podman, set DATABASE_URL for a system Postgres, or set ITOTORI_POSTGRES_BIN_DIR.",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return {
      ok: false,
      message: "Could not auto-start local Postgres because DATABASE_URL is invalid.",
    };
  }
  const port = parsed.port || "5432";
  const user = decodeURIComponent(parsed.username || "itotori");
  const password = decodeURIComponent(parsed.password || "itotori");
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, "") || "itotori");
  const containerName = `itotori-postgres-${port}-${safeContainerSuffix(
    basename(resolveWorktreeRoot(process.env)),
  )}`;
  const start = spawnSync(runtime, ["start", containerName], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (start.status === 0) {
    return waitForLocalPostgresReady(runtime, containerName, user, database, {
      readyMessage: `Started existing local Postgres container ${containerName}; Postgres is ready for migrations.`,
      timeoutMessage: `Started existing local Postgres container ${containerName}, but Postgres did not become ready for migrations.`,
    });
  }
  let envContents: string;
  try {
    envContents = postgresContainerEnvironmentContents({ user, password, database });
  } catch (error) {
    return {
      ok: false,
      message: `Could not auto-start local Postgres because DATABASE_URL contains an unsupported credential value: ${errorMessage(error)}`,
    };
  }
  const run = withTemporarySecretFile(
    {
      contents: envContents,
      directoryPrefix: "itotori-postgres-env-",
      fileName: "postgres.env",
    },
    (envFilePath) =>
      spawnSync(
        runtime,
        [
          "run",
          "--detach",
          "--name",
          containerName,
          "--env-file",
          envFilePath,
          "-p",
          `127.0.0.1:${port}:5432`,
          "postgres:18",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
  );
  if (run.status === 0) {
    return waitForLocalPostgresReady(runtime, containerName, user, database, {
      readyMessage: `Started local Postgres container ${containerName}; Postgres is ready for migrations.`,
      timeoutMessage: `Started local Postgres container ${containerName}, but Postgres did not become ready for migrations.`,
    });
  }
  const detail = (run.stderr || run.stdout || "unknown container runtime error").trim();
  return { ok: false, message: `Could not auto-start local Postgres with ${runtime}: ${detail}` };
}

function postgresContainerEnvironmentContents(input: {
  user: string;
  password: string;
  database: string;
}): string {
  return [
    envFileLine("POSTGRES_USER", input.user),
    envFileLine("POSTGRES_PASSWORD", input.password),
    envFileLine("POSTGRES_DB", input.database),
    "",
  ].join("\n");
}

function envFileLine(name: string, value: string): string {
  if (value.includes("\r") || value.includes("\n") || value.includes(String.fromCharCode(0))) {
    throw new Error(`${name} may not contain newline or NUL characters`);
  }
  return `${name}=${value}`;
}

const LOCAL_POSTGRES_READY_TIMEOUT_MS = 30_000;

function waitForLocalPostgresReady(
  runtime: string,
  containerName: string,
  user: string,
  database: string,
  messages: { readyMessage: string; timeoutMessage: string },
): { ok: boolean; message: string } {
  const deadline = Date.now() + LOCAL_POSTGRES_READY_TIMEOUT_MS;
  let lastDetail = "readiness query did not succeed";
  do {
    const ready = spawnSync(
      runtime,
      [
        "exec",
        containerName,
        "sh",
        "-c",
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$1" -d "$2" -v ON_ERROR_STOP=1 -Atqc "select 1"',
        "itotori-postgres-ready",
        user,
        database,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (ready.status === 0) return { ok: true, message: messages.readyMessage };
    lastDetail = (ready.stderr || ready.stdout || lastDetail).trim();
    sleepSync(250);
  } while (Date.now() < deadline);
  return { ok: false, message: `${messages.timeoutMessage} Last readiness check: ${lastDetail}` };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstRunnableCommand(commands: string[]): string | undefined {
  for (const command of commands) {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0) return command;
  }
  return undefined;
}

function safeContainerSuffix(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/gu, "-")
    .replace(/^[^a-z0-9]+/u, "");
  return safe.length > 0 ? safe : "local";
}
