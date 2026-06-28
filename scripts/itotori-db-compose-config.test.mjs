import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const compose = readFileSync("docker-compose.yml", "utf8");
const justfile = readFileSync("justfile", "utf8");
const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
const helloWorkflow = readFileSync(".github/workflows/hello.yml", "utf8");

test("local compose applies durable runtime Postgres connection tuning", () => {
  assert.match(compose, /command:\n(?:      .+\n)*      - postgres\n/u);
  assert.match(compose, /      - max_connections=400\n/u);
  assert.match(compose, /      - shared_buffers=512MB\n/u);
  assert.match(compose, /4x Postgres' default max_connections/u);
});

test("GitHub workflows use the local db compose path for Postgres parity", () => {
  for (const [name, workflow] of [
    ["ci", ciWorkflow],
    ["hello", helloWorkflow],
  ]) {
    assert.doesNotMatch(workflow, /^\s+services:\n\s+postgres:/mu, `${name} uses a GH service`);
    assert.match(workflow, /- run: just db-up\n/u, `${name} starts the compose db`);
    assert.match(workflow, /- run: just db-wait\n/u, `${name} waits for the compose db`);
    assert.match(workflow, /- run: just db-down\n\s+if: always\(\)\n/u, `${name} tears down the compose db`);
  }
});

test("db recipes disable implicit .env loading", () => {
  assert.match(justfile, /export COMPOSE_DISABLE_ENV_FILE := '1'\n/u);
  assert.doesNotMatch(justfile, /docker compose(?! --env-file \.tmp\/itotori-db\/compose\.env)/u);
});
