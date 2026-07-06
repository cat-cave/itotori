import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  composeEnvValues,
  decodeComposeEnvFileValue,
  deriveHostPort,
  encodeEnvFileValue,
  renderComposeEnvFile,
  resolveDatabaseUrl,
} from "./itotori-db-compose-env.mjs";

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

// ---------------------------------------------------------------------------
// UNIV-022: dollar-safe compose env-file encoding. Compose interpolates
// env-file values, so a `$` in a decoded DATABASE_URL credential must survive
// that interpolation byte-for-byte (or be rejected with a semantic diagnostic).
// ---------------------------------------------------------------------------

// Bytes a compose credential can contain that Compose interpolation would
// otherwise mangle (`$`, `${...}`) or that other encoders would corrupt.
const preservedCredentials = [
  "p$4ssw0rd", // bare $ — would expand to `p` under compose interpolation
  "a$$b", // literal $$ — would collapse under interpolation
  "pre${HOME}post", // ${...} braces — would expand to the HOME value
  'has "double" quotes',
  "has spaces and\ttab",
  "back\\slash\\path",
  "trailing#hash and =equals",
  "itotori", // the public no-secret default
  "", // empty credential
];

test("encodeEnvFileValue round-trips $/quotes/spaces/backslashes through the compose model", () => {
  for (const credential of preservedCredentials) {
    const encoded = encodeEnvFileValue(credential, "ITOTORI_DB_PASSWORD");
    assert.equal(
      decodeComposeEnvFileValue(encoded),
      credential,
      `credential ${JSON.stringify(credential)} must survive encode -> compose parse unchanged`,
    );
    // Single-quoted output is a raw literal under compose-go dotenv: it must
    // not open the door to interpolation ($ stays bare, never doubled/dropped).
    assert.equal(encoded, `'${credential}'`);
  }
});

test("encodeEnvFileValue rejects bytes a single-quoted value cannot carry, naming the char", () => {
  assert.throws(
    () => encodeEnvFileValue("pa'ss", "ITOTORI_DB_PASSWORD"),
    /ITOTORI_DB_PASSWORD.*single quote \('\)/u,
    "a single quote must be rejected with a diagnostic naming the offending char",
  );
  assert.throws(
    () => encodeEnvFileValue("line1\nline2", "ITOTORI_DB_PASSWORD"),
    /ITOTORI_DB_PASSWORD.*newline \(\\n\)/u,
    "a newline must be rejected with a diagnostic naming the offending char",
  );
  assert.throws(
    () => encodeEnvFileValue("has\rcr", "ITOTORI_DB_NAME"),
    /ITOTORI_DB_NAME.*carriage return \(\\r\)/u,
  );
});

test("a $-bearing DATABASE_URL credential survives the full compose-env render", () => {
  // A password with a literal `$` (percent-encoded in the URL userinfo).
  const url = "postgres://us%24er:p%244ss%24@127.0.0.1:56000/it%24db";
  const values = composeEnvValues({ DATABASE_URL: url });
  assert.equal(values.ITOTORI_DB_USER, "us$er");
  assert.equal(values.ITOTORI_DB_PASSWORD, "p$4ss$");
  assert.equal(values.ITOTORI_DB_NAME, "it$db");

  const rendered = renderComposeEnvFile(values);
  for (const [key, value] of Object.entries(values)) {
    const line = rendered.split("\n").find((l) => l.startsWith(`${key}=`));
    assert.notEqual(line, undefined, `rendered env must contain ${key}`);
    assert.equal(
      decodeComposeEnvFileValue(line.slice(key.length + 1)),
      String(value),
      `${key} must round-trip through encode -> compose parse`,
    );
  }
});

test("public no-secret defaults render and round-trip unchanged", () => {
  const values = composeEnvValues({
    DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:56000/itotori",
  });
  const rendered = renderComposeEnvFile(values);
  assert.match(rendered, /ITOTORI_DB_USER='itotori'\n/u);
  assert.match(rendered, /ITOTORI_DB_PASSWORD='itotori'\n/u);
  assert.match(rendered, /ITOTORI_DB_NAME='itotori'\n/u);
  for (const [key, value] of Object.entries(values)) {
    const line = rendered.split("\n").find((l) => l.startsWith(`${key}=`));
    assert.equal(decodeComposeEnvFileValue(line.slice(key.length + 1)), String(value));
  }
});

// Real compose-config proof: write a minimal compose file + generated env file
// with a `$`-bearing password and confirm `docker compose config` reports the
// credential unchanged. Skipped when no compose CLI is present (e.g. minimal CI
// images); the encoder-model tests above still prove preservation.
test("docker compose config preserves a $-bearing generated credential", (t) => {
  let composeCli = null;
  for (const [cmd, args] of [
    ["docker", ["compose"]],
    ["podman-compose", []],
  ]) {
    try {
      execFileSync(cmd, [...args, "version"], { stdio: "ignore" });
      composeCli = [cmd, args];
      break;
    } catch {
      // try the next CLI
    }
  }
  if (!composeCli) {
    t.skip("no docker/podman compose CLI available");
    return;
  }

  const dir = mkdtempSync(path.join(tmpdir(), "univ022-compose-"));
  writeFileSync(
    path.join(dir, "docker-compose.yml"),
    [
      "services:",
      "  postgres:",
      "    image: postgres:18",
      "    environment:",
      "      POSTGRES_PASSWORD: ${ITOTORI_DB_PASSWORD:-itotori}",
      "",
    ].join("\n"),
  );

  // Representative UNIV-022 credentials: a bare `$` (which the previous
  // double-quoted encoder let Compose interpolate away), a literal `$$`, plus
  // spaces/quotes/backslashes. `${DEFINED_VAR}` is deliberately excluded here:
  // compose-go keeps it literal inside single quotes, but the podman-compose
  // provider expands it against the OS env — a tool divergence, not an encoder
  // fault — so the brace-ref preservation is asserted by the compose-model
  // round-trip tests above (which follow compose-go semantics), not this one.
  const [cmd, baseArgs] = composeCli;
  for (const credential of ["p$4ssw0rd", "a$$b", "sp ace$x", 'q"q$y', "back\\slash$z"]) {
    const values = composeEnvValues({
      DATABASE_URL: `postgres://itotori:${encodeURIComponent(credential)}@127.0.0.1:56000/itotori`,
    });
    writeFileSync(path.join(dir, "gen.env"), renderComposeEnvFile(values));
    const out = execFileSync(cmd, [...baseArgs, "--env-file", "gen.env", "config"], {
      cwd: dir,
      encoding: "utf8",
    });
    const parsed = out.split("\n").find((l) => /POSTGRES_PASSWORD:/u.test(l));
    assert.notEqual(parsed, undefined, "compose config must report POSTGRES_PASSWORD");
    assert.ok(
      parsed.includes(credential),
      `compose config must preserve ${JSON.stringify(credential)}; got: ${parsed.trim()}`,
    );
  }
});
