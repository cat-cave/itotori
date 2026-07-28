#!/usr/bin/env node
import { spawn } from "node:child_process";

const healthFormat =
  "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing-healthcheck{{end}}";

if (import.meta.main) {
  await waitForPostgres({ composeEnvPath: requiredComposeEnvPath(process.argv.slice(2)) });
}

function requiredComposeEnvPath(args) {
  const index = args.indexOf("--compose-env-path");
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("usage: node scripts/itotori-db-wait.mjs --compose-env-path <path>");
  }
  return value;
}

/**
 * Wait for the health check declared in docker-compose.yml instead of asking
 * `docker compose exec` to relay pg_isready's exit status. The Podman Compose
 * provider can return status 4 from that relay after pg_isready has printed
 * "accepting connections"; the container's health state is the authoritative
 * readiness signal and is directly inspectable through the container runtime.
 */
export async function waitForPostgres({
  composeEnvPath,
  maxAttempts = 60,
  retryDelayMs = 1000,
  run = runDocker,
  sleep = delay,
  log = console.log,
  error = console.error,
} = {}) {
  if (!composeEnvPath) {
    throw new Error("Postgres readiness failed: ITOTORI_DB_COMPOSE_ENV_PATH is empty");
  }

  let lastFailure = "Postgres container was not inspected";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const container = await run(["compose", "--env-file", composeEnvPath, "ps", "-q"]);
    const containerIds = container.stdout.split(/\s+/u).filter(Boolean);
    const [containerId] = containerIds;
    if (container.status !== 0) {
      lastFailure = commandFailure("docker compose ps -q", container);
    } else if (containerIds.length === 0) {
      lastFailure = "docker compose ps -q returned no Postgres container id";
    } else if (containerIds.length !== 1) {
      lastFailure = `docker compose ps -q returned ${containerIds.length} container ids; expected 1 Postgres container`;
    } else {
      const health = await run(["inspect", "--format", healthFormat, containerId]);
      const healthState = health.stdout.trim();
      if (health.status !== 0) {
        lastFailure = commandFailure(`docker inspect health for ${containerId}`, health);
      } else if (healthState === "healthy") {
        log(`Postgres is healthy (container ${containerId})`);
        return;
      } else {
        lastFailure = `Postgres container ${containerId} health is ${healthState || "empty"}`;
      }
    }

    error(`Postgres readiness attempt ${attempt}/${maxAttempts}: ${lastFailure}`);
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }

  throw new Error(`Postgres readiness failed after ${maxAttempts} attempts: ${lastFailure}`);
}

function commandFailure(command, result) {
  const detail = result.stderr.trim() || result.stdout.trim() || "no command output";
  return `${command} exited ${result.status}: ${detail}`;
}

function runDocker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
