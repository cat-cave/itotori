// @itotori-meta-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { waitForPostgres } from "./itotori-db-wait.mjs";

const commandSurface = readFileSync("scripts/developer-command.mjs", "utf8");

test("the db-wait development selector uses the health inspector instead of the compose-exec relay", () => {
  assert.match(commandSurface, /node scripts\/itotori-db-wait\.mjs/u);
  assert.doesNotMatch(commandSurface, /docker compose.*exec.*pg_isready/u);
});

test("Postgres readiness succeeds despite the compose-exec exit-4 relay bug", async () => {
  const calls = [];
  const messages = [];

  await waitForPostgres({
    composeEnvPath: ".tmp/itotori-db/compose.env",
    maxAttempts: 1,
    retryDelayMs: 0,
    log: (message) => messages.push(message),
    error: (message) => messages.push(message),
    run: async (args) => {
      calls.push(args);
      if (args[0] === "compose" && args.includes("ps")) {
        return { status: 0, stdout: "postgres-container\n", stderr: "" };
      }
      if (args[0] === "inspect") {
        return { status: 0, stdout: "healthy\n", stderr: "" };
      }
      // This is the observed false-failure path. The corrected implementation
      // must never call compose exec, because its status 4 is not trustworthy.
      if (args[0] === "compose" && args.includes("exec")) {
        return {
          status: 4,
          stdout: "/var/run/postgresql:5432 - accepting connections\n",
          stderr: "",
        };
      }
      throw new Error(`unexpected docker arguments: ${args.join(" ")}`);
    },
  });

  assert.deepEqual(calls, [
    ["compose", "--env-file", ".tmp/itotori-db/compose.env", "ps", "-q"],
    [
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing-healthcheck{{end}}",
      "postgres-container",
    ],
  ]);
  assert.deepEqual(messages, ["Postgres is healthy (container postgres-container)"]);
});

test("Postgres readiness names an unhealthy container and fails non-zero", async () => {
  await assert.rejects(
    waitForPostgres({
      composeEnvPath: ".tmp/itotori-db/compose.env",
      maxAttempts: 1,
      retryDelayMs: 0,
      log: () => {},
      error: () => {},
      run: async (args) => {
        if (args[0] === "compose") {
          return { status: 0, stdout: "postgres-container\n", stderr: "" };
        }
        return { status: 0, stdout: "unhealthy\n", stderr: "" };
      },
    }),
    /Postgres readiness failed after 1 attempts: Postgres container postgres-container health is unhealthy/u,
  );
});
