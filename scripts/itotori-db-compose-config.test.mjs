import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { composeEnvValues, deriveHostPort, resolveDatabaseUrl } from "./itotori-db-compose-env.mjs";

const compose = readFileSync("docker-compose.yml", "utf8");
const justfile = readFileSync("justfile", "utf8");
const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
const alphaProofWorkflow = readFileSync(".github/workflows/alpha-proof.yml", "utf8");
const flake = readFileSync("flake.nix", "utf8");
const catalogReplayGate = readFileSync("scripts/catalog-replay-db-gate.mjs", "utf8");
const styleGuideGate = readFileSync("scripts/style-guide-fixture-flow-db-gate.mjs", "utf8");

// Two roots that exercise both the same-basename-different-parent collision the
// CARGO_TARGET_DIR scheme guards against and a plain distinct worktree.
const rootA = "/scratch/worktrees/itotori-db-compose-alpha";
const rootB = "/scratch/worktrees/itotori-db-compose-beta";
const rootC = "/home/someone-else/itotori-db-compose-alpha";

test("db host port is derived per-worktree (distinct roots -> distinct ports)", () => {
  const portA = deriveHostPort(rootA);
  const portB = deriveHostPort(rootB);
  const portC = deriveHostPort(rootC);

  assert.notEqual(portA, portB, "distinct worktree roots must not share a host port");
  assert.notEqual(
    portA,
    portC,
    "same basename under a different parent must not share a host port",
  );
});

test("db host port derivation is deterministic per canonical root", () => {
  assert.equal(deriveHostPort(rootA), deriveHostPort(rootA));
  assert.equal(deriveHostPort(rootB), deriveHostPort(rootB));
});

test("derived host port stays inside the configured ephemeral range", () => {
  for (const root of [rootA, rootB, rootC, process.cwd()]) {
    const port = deriveHostPort(root);
    assert.ok(port >= 56000 && port < 58000, `port ${port} out of range for ${root}`);
  }
});

test("port base/span are overridable and keep the derivation in range", () => {
  const env = { ITOTORI_DB_HOST_PORT_BASE: "61000", ITOTORI_DB_HOST_PORT_SPAN: "100" };
  const port = deriveHostPort(rootA, env);
  assert.ok(port >= 61000 && port < 61100, `overridden port ${port} out of range`);
  assert.throws(() => deriveHostPort(rootA, { ITOTORI_DB_HOST_PORT_BASE: "70000" }));
});

test("explicit DATABASE_URL wins; otherwise the per-worktree port is used", () => {
  const explicit = "postgres://itotori:itotori@127.0.0.1:55433/itotori";
  assert.equal(resolveDatabaseUrl({ DATABASE_URL: explicit }), explicit);

  const derived = resolveDatabaseUrl({ ITOTORI_DB_WORKTREE_ROOT: rootA });
  const derivedPort = String(deriveHostPort(rootA));
  assert.equal(new URL(derived).port, derivedPort);

  // The compose env file publishes that same derived host port.
  const values = composeEnvValues({ ITOTORI_DB_WORKTREE_ROOT: rootA });
  assert.equal(values.ITOTORI_DB_HOST_PORT, derivedPort);
});

test("distinct worktree roots derive distinct default DATABASE_URLs (no shared DB)", () => {
  const urlA = resolveDatabaseUrl({ ITOTORI_DB_WORKTREE_ROOT: rootA });
  const urlB = resolveDatabaseUrl({ ITOTORI_DB_WORKTREE_ROOT: rootB });
  const urlC = resolveDatabaseUrl({ ITOTORI_DB_WORKTREE_ROOT: rootC });

  // Different default DATABASE_URLs are what stop one worktree's `db-reset`
  // from truncating another worktree's DB.
  assert.notEqual(urlA, urlB, "distinct worktree roots must not share a default DATABASE_URL");
  assert.notEqual(
    urlA,
    urlC,
    "same basename under a different parent must not share a default DATABASE_URL",
  );
});

test("justfile has NO shared fixed default host port; connect recipes derive per-worktree", () => {
  // The top-level DATABASE_URL export must fall back to EMPTY, never a shared
  // fixed host port. A hardcoded default here masks the per-worktree derivation
  // and lets two worktrees collide / truncate each other on `just db-up`/`db-reset`.
  assert.match(
    justfile,
    /export DATABASE_URL := env_var_or_default\('DATABASE_URL', ''\)\n/u,
    "DATABASE_URL default must be empty (per-worktree derivation happens in recipes)",
  );
  assert.doesNotMatch(
    justfile,
    /export DATABASE_URL := env_var_or_default\('DATABASE_URL', 'postgres:/u,
    "justfile must not hardcode a shared fixed DATABASE_URL default",
  );

  // db-migrate / db-reset (the recipes that CONNECT) must derive the
  // per-worktree URL from the compose-env script when DATABASE_URL is unset,
  // so they target the same per-worktree Postgres that `db-up` brought up.
  const dbMigrate = justfile.match(/^db-migrate: db-cli-build\n(?<body>(?:    .+\n)+)/mu);
  assert.notEqual(dbMigrate, null);
  assert.match(
    dbMigrate.groups.body,
    /DATABASE_URL="\$\(node scripts\/itotori-db-compose-env\.mjs --print-database-url\)" node apps\/itotori\/dist\/cli\.js db-migrate/u,
  );

  const dbReset = justfile.match(/^db-reset: db-migrate\n(?<body>(?:    .+\n)+)/mu);
  assert.notEqual(dbReset, null);
  assert.match(
    dbReset.groups.body,
    /DATABASE_URL="\$\(node scripts\/itotori-db-compose-env\.mjs --print-database-url\)" node apps\/itotori\/dist\/cli\.js db-reset/u,
  );
});

test("db-strict remediation hints derive per-worktree (no shared fixed host port)", () => {
  for (const [name, gate] of [
    ["catalog-replay", catalogReplayGate],
    ["style-guide-fixture-flow", styleGuideGate],
  ]) {
    assert.doesNotMatch(
      gate,
      /127\.0\.0\.1:55433/u,
      `${name} remediation must not suggest a shared fixed host port`,
    );
    assert.match(
      gate,
      /DATABASE_URL="\$\(node scripts\/itotori-db-compose-env\.mjs --print-database-url\)"/u,
      `${name} remediation must derive the per-worktree DATABASE_URL`,
    );
  }
});

test("devshell derives DATABASE_URL per worktree without a hardcoded shared port", () => {
  assert.match(flake, /scripts\/itotori-db-compose-env\.mjs" --print-database-url/u);
  assert.match(flake, /ITOTORI_DB_WORKTREE_ROOT="\$worktree_root"/u);
  // The per-worktree path must not pin the legacy fixed host port.
  assert.doesNotMatch(flake, /55433|55444/u);
});

test("local compose applies durable runtime Postgres connection tuning", () => {
  assert.match(compose, /command:\n(?:      .+\n)*      - postgres\n/u);
  assert.match(compose, /      - max_connections=400\n/u);
  assert.match(compose, /      - shared_buffers=512MB\n/u);
  assert.match(compose, /4x Postgres' default max_connections/u);
});

test("the DB-backed CI workflow uses the local db compose path for Postgres parity", () => {
  // ALPHA-009: only DB-backed workflows are asserted here. The alpha-proof
  // integration workflow is public-fixture-only and deterministic — it does
  // NOT start Postgres — so it is intentionally excluded from this matrix.
  for (const [name, workflow] of [["ci", ciWorkflow]]) {
    assert.doesNotMatch(workflow, /^\s+services:\n\s+postgres:/mu, `${name} uses a GH service`);
    assert.match(workflow, /- run: just db-up\n/u, `${name} starts the compose db`);
    assert.match(workflow, /- run: just db-wait\n/u, `${name} waits for the compose db`);
    assert.match(
      workflow,
      /- run: just db-down\n\s+if: always\(\)\n/u,
      `${name} tears down the compose db`,
    );
  }
});

test("the alpha-proof integration workflow is public-fixture-only (no Postgres)", () => {
  // ALPHA-009: the alpha proof gate must not depend on a database, live
  // credentials, or private corpora; it runs the deterministic public-fixture
  // vertical via `just alpha-proof`.
  assert.doesNotMatch(alphaProofWorkflow, /just db-up|just db-wait|just db-down/u);
  assert.doesNotMatch(alphaProofWorkflow, /DATABASE_URL/u);
  assert.match(alphaProofWorkflow, /- run: just alpha-proof\n/u);
});

test("db recipes use explicit compose env files without project-global .env leakage", () => {
  assert.match(justfile, /export COMPOSE_DISABLE_ENV_FILE := '1'\n/u);
  assert.match(
    justfile,
    /export ITOTORI_DB_COMPOSE_ENV_PATH := env_var_or_default\('ITOTORI_DB_COMPOSE_ENV_PATH', '\.tmp\/itotori-db\/compose\.env'\)/u,
  );
  assert.doesNotMatch(justfile, /docker compose(?! --env-file "\$ITOTORI_DB_COMPOSE_ENV_PATH")/u);
});

test("local qd CI uses the DB-owning full-CI wrapper", () => {
  assert.match(justfile, /^qd-full-ci:\n    node scripts\/qd-full-ci\.mjs/mu);

  const qdImport = justfile.match(/^qd-import:\n(?<body>(?:    .+\n)+)/mu);
  assert.notEqual(qdImport, null);
  assert.match(qdImport.groups.body, /    qd import --from roadmap\/spec-dag\.json\n/u);
  assert.doesNotMatch(qdImport.groups.body, /\.\/bin\/qd/u);
  assert.doesNotMatch(qdImport.groups.body, /\.qd\/qd\.db/u);
  assert.doesNotMatch(qdImport.groups.body, /qd config set/u);

  const qdConfig = readFileSync(".qd/config.toml", "utf8");
  assert.match(qdConfig, /check_command = "nix develop --command bash -lc 'just check'"/u);
  assert.match(qdConfig, /ci_command = "nix develop --command bash -lc 'just qd-full-ci'"/u);
});
