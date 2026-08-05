#!/usr/bin/env node
/**
 * Declared product-database lifecycle for a worktree.
 *
 *   up      — idempotent bring-up; prints the DATABASE_URL the product will use
 *   down    — tear down this worktree's compose stack
 *   sweep   — remove product-db containers whose worktree directory is gone
 *   require-database-url — print the derived URL only when the stack is up;
 *                          otherwise fail with a typed, actionable error
 *
 * DATABASE_URL is derived from the worktree declaration (stable host port),
 * never from ambient shell state. A recorded port that outlives its container
 * is exactly the failure this lifecycle exists to prevent.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  resolveComposeEnvPath,
  resolveWorktreeDatabaseUrl,
  resolveWorktreeRoot,
  writeWorktreeComposeEnv,
} from "./itotori-db-compose-env.mjs";
import { waitForPostgres } from "./itotori-db-wait.mjs";

const PRODUCT_DB_LABEL = "com.itotori.product-db";
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_WORKDIR_LABEL = "com.docker.compose.project.working_dir";
const COMPOSE_CONFIG_LABEL = "com.docker.compose.project.config_files";
const WORKTREE_ROOT_LABEL = "com.itotori.worktree-root";
const REMEDIATION = "just dev db-up";

/** Typed failure when the product needs a database and this worktree's is down. */
export class ProductDatabaseNotRunningError extends Error {
  /**
   * @param {string} worktreeRoot
   */
  constructor(worktreeRoot) {
    super(
      `product database is not running for worktree ${worktreeRoot}. ` +
        `Start it with \`${REMEDIATION}\` (idempotent), then re-run.`,
    );
    this.name = "ProductDatabaseNotRunningError";
    /** @type {"product-database-not-running"} */
    this.code = "product-database-not-running";
    /** @type {string} */
    this.remediation = REMEDIATION;
    /** @type {string} */
    this.worktreeRoot = worktreeRoot;
  }
}

if (import.meta.url === pathToMainUrl(process.argv[1])) {
  const command = process.argv[2] ?? "";
  try {
    await main(command, process.argv.slice(3), process.env);
  } catch (error) {
    if (error instanceof ProductDatabaseNotRunningError) {
      process.stderr.write(`${error.message}\n`);
      process.stderr.write(`error.code=${error.code}\n`);
      process.stderr.write(`error.remediation=${error.remediation}\n`);
      process.exit(3);
    }
    process.stderr.write(
      `itotori-db-lifecycle: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

/**
 * @param {string} command
 * @param {string[]} _args
 * @param {NodeJS.ProcessEnv} env
 */
export async function main(command, _args = [], env = process.env) {
  switch (command) {
    case "up":
      return await up(env);
    case "down":
      return await down(env);
    case "sweep":
      return sweep(env);
    case "require-database-url":
      process.stdout.write(`${requireDatabaseUrl(env)}\n`);
      return;
    case "print-database-url":
      // Always the worktree-declared URL (never ambient DATABASE_URL).
      process.stdout.write(`${resolveWorktreeDatabaseUrl(env)}\n`);
      return;
    default:
      throw new Error(
        "usage: node scripts/itotori-db-lifecycle.mjs <up|down|sweep|require-database-url|print-database-url>",
      );
  }
}

/** Idempotent bring-up. Reuses an already-running stack; never duplicates. */
export async function up(env = process.env) {
  const root = resolveWorktreeRoot(env);
  const composeEnvPath = await writeWorktreeComposeEnv(env);
  const databaseUrl = resolveWorktreeDatabaseUrl(env);
  const compose = runDocker(["compose", "--env-file", composeEnvPath, "up", "-d", "postgres"], env);
  if (compose.status !== 0) {
    throw new Error(
      `docker compose up failed for worktree ${root}: ${
        compose.stderr.trim() || compose.stdout.trim() || `exit ${compose.status}`
      }`,
    );
  }
  await waitForPostgres({ composeEnvPath });
  process.stdout.write(`product database up for ${root}\n`);
  process.stdout.write(`DATABASE_URL=${databaseUrl}\n`);
  return { databaseUrl, worktreeRoot: root, composeEnvPath };
}

/** Tear down this worktree's compose stack. */
export async function down(env = process.env) {
  const root = resolveWorktreeRoot(env);
  const composeEnvPath = await writeWorktreeComposeEnv(env);
  const result = runDocker(["compose", "--env-file", composeEnvPath, "down"], env);
  if (result.status !== 0) {
    throw new Error(
      `docker compose down failed for worktree ${root}: ${
        result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
      }`,
    );
  }
  process.stdout.write(`product database down for ${root}\n`);
  return { worktreeRoot: root, composeEnvPath };
}

/**
 * Remove product-database containers whose worktree directory no longer exists.
 * Live worktrees (directory present) are left alone, including locally-created
 * branches with no remote.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{
 *   listContainers?: (env: NodeJS.ProcessEnv) => Array<{id: string, name: string, worktreeRoot: string}>,
 *   removeContainer?: (id: string, env: NodeJS.ProcessEnv) => void,
 *   directoryExists?: (path: string) => boolean,
 *   log?: (line: string) => void,
 * }} [options]
 */
export function sweep(env = process.env, options = {}) {
  const list = options.listContainers ?? listProductDatabaseContainers;
  const remove = options.removeContainer ?? removeContainer;
  const exists = options.directoryExists ?? ((p) => existsSync(p));
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));

  const containers = list(env);
  const removed = [];
  const kept = [];
  for (const container of containers) {
    const worktreeRoot = container.worktreeRoot;
    if (!worktreeRoot) {
      // Unlabeled / non-worktree product-adjacent containers are not managed here.
      kept.push(container);
      continue;
    }
    if (exists(worktreeRoot)) {
      kept.push(container);
      continue;
    }
    remove(container.id, env);
    removed.push(container);
    log(
      `swept orphan product database container ${container.name || container.id} ` +
        `(worktree gone: ${worktreeRoot})`,
    );
  }
  log(
    `db-sweep: removed ${removed.length} orphan(s); kept ${kept.length} live worktree database(s)`,
  );
  return { removed, kept };
}

/**
 * Resolve the DATABASE_URL the product will use for this worktree.
 * Fails typed when the declared stack is not up — never returns a stale ambient URL.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ isUp?: () => boolean }} [options]
 */
export function requireDatabaseUrl(env = process.env, options = {}) {
  const root = resolveWorktreeRoot(env);
  const databaseUrl = resolveWorktreeDatabaseUrl(env);
  const isUp = options.isUp ?? (() => isWorktreeDatabaseUp(env));
  if (!isUp()) {
    throw new ProductDatabaseNotRunningError(root);
  }
  return databaseUrl;
}

export function isWorktreeDatabaseUp(env = process.env) {
  const composeEnvPath = resolveComposeEnvPath(env);
  if (!existsSync(composeEnvPath)) return false;
  const ps = runDocker(["compose", "--env-file", composeEnvPath, "ps", "-q"], env);
  if (ps.status !== 0) return false;
  const ids = ps.stdout.split(/\s+/u).filter(Boolean);
  if (ids.length !== 1) return false;
  const health = runDocker(
    [
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
      ids[0],
    ],
    env,
  );
  if (health.status !== 0) return false;
  const state = health.stdout.trim();
  return state === "healthy" || state === "running";
}

export function listProductDatabaseContainers(env = process.env) {
  // Prefer the product-db label; fall back to compose service=postgres so older
  // stacks started before the label still participate in sweep.
  const ids = new Set();
  for (const filter of [`label=${PRODUCT_DB_LABEL}=1`, `label=${COMPOSE_SERVICE_LABEL}=postgres`]) {
    const listed = runDocker(["ps", "-a", "--filter", filter, "--format", "{{.ID}}"], env);
    if (listed.status !== 0) {
      throw new Error(
        `docker ps failed while listing product databases: ${
          listed.stderr.trim() || listed.stdout.trim() || `exit ${listed.status}`
        }`,
      );
    }
    for (const id of listed.stdout.split(/\s+/u).filter(Boolean)) ids.add(id);
  }

  const containers = [];
  for (const id of ids) {
    const inspected = runDocker(
      [
        "inspect",
        "--format",
        [
          "{{.Id}}",
          "{{.Name}}",
          `{{index .Config.Labels "${COMPOSE_PROJECT_LABEL}"}}`,
          `{{index .Config.Labels "${COMPOSE_WORKDIR_LABEL}"}}`,
          `{{index .Config.Labels "${COMPOSE_CONFIG_LABEL}"}}`,
          `{{index .Config.Labels "${WORKTREE_ROOT_LABEL}"}}`,
          `{{index .Config.Labels "${PRODUCT_DB_LABEL}"}}`,
          `{{index .Config.Labels "${COMPOSE_SERVICE_LABEL}"}}`,
        ].join("\t"),
        id,
      ],
      env,
    );
    if (inspected.status !== 0) continue;
    const line = inspected.stdout.trim();
    if (!line) continue;
    const [fullId, name, project, workdir, configFiles, labeledRoot, productDb, service] =
      line.split("\t");
    if (!isProductDatabaseContainer({ project, configFiles, productDb, service, workdir })) {
      continue;
    }
    const worktreeRoot = labeledRoot && labeledRoot !== "<no value>" ? labeledRoot : workdir || "";
    const normalizedRoot =
      worktreeRoot && worktreeRoot !== "<no value>" ? path.resolve(worktreeRoot) : "";
    containers.push({
      id: fullId,
      name: (name || "").replace(/^\//u, ""),
      project: project && project !== "<no value>" ? project : "",
      worktreeRoot: normalizedRoot,
    });
  }
  return containers;
}

/**
 * @param {{
 *   project: string | undefined,
 *   configFiles: string | undefined,
 *   productDb: string | undefined,
 *   service: string | undefined,
 *   workdir: string | undefined,
 * }} labels
 */
export function isProductDatabaseContainer({ project, configFiles, productDb, service, workdir }) {
  if (productDb === "1") return true;
  // Heuristic for stacks started before the product-db label existed:
  // compose postgres service, itotori project name, and a worktree working_dir.
  if (service !== "postgres") return false;
  if (!project || project === "<no value>" || !project.startsWith("itotori-")) return false;
  if (!configFiles || configFiles === "<no value>") return false;
  if (!configFiles.includes("docker-compose.yml")) return false;
  if (!workdir || workdir === "<no value>") return false;
  return true;
}

function removeContainer(id, env = process.env) {
  const result = runDocker(["rm", "-fv", id], env);
  if (result.status !== 0) {
    throw new Error(
      `failed to remove orphan container ${id}: ${
        result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
      }`,
    );
  }
}

function runDocker(args, env = process.env) {
  const result = spawnSync("docker", args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return {
      status: 1,
      stdout: "",
      stderr: result.error.message,
    };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function pathToMainUrl(value) {
  if (!value) return null;
  return pathToFileURL(path.resolve(value)).href;
}
