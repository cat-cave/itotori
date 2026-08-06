// @itotori-meta-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  composeEnvValues,
  decodeComposeEnvFileValue,
  deriveHostPort,
  encodeEnvFileValue,
  renderComposeEnvFile,
  resolveDatabaseUrl,
  resolveWorktreeDatabaseUrl,
  worktreeComposeEnvValues,
} from "./itotori-db-compose-env.mjs";

const compose = readFileSync("docker-compose.yml", "utf8");

const commandScript = readFileSync("scripts/developer-command.mjs", "utf8");
const tier1Workflow = readFileSync(".github/workflows/_tier1.yml", "utf8");
const flake = readFileSync("flake.nix", "utf8");
const permissionDenialGate = readFileSync("scripts/permission-denial-db-gate.mjs", "utf8");
const catalogReplayGate = readFileSync("scripts/catalog-replay-db-gate.mjs", "utf8");

/** Extract a top-level job block (`  jobId:`) from a GitHub Actions workflow YAML. */
function extractWorkflowJob(workflow, jobId) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  assert.notEqual(start, -1, `workflow must define job ${jobId}`);
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Next job key at the same indent under `jobs:`, or a new top-level key.
    if (/^  [A-Za-z0-9_-]+:\s*$/u.test(line) || /^[A-Za-z0-9_-]+:/u.test(line)) {
      break;
    }
    body.push(line);
  }
  return `${body.join("\n")}\n`;
}

const tier1PostgresJob = extractWorkflowJob(tier1Workflow, "db");
const tier1AlphaJob = extractWorkflowJob(tier1Workflow, "alpha");

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

test("explicit DATABASE_URL wins for resolveDatabaseUrl; worktree URL ignores ambient", () => {
  const explicit = "postgres://itotori:itotori@127.0.0.1:55433/itotori";
  assert.equal(resolveDatabaseUrl({ DATABASE_URL: explicit }), explicit);

  const derived = resolveDatabaseUrl({ ITOTORI_DB_WORKTREE_ROOT: rootA });
  const derivedPort = String(deriveHostPort(rootA));
  assert.equal(new URL(derived).port, derivedPort);

  // Ambient DATABASE_URL must not redirect the worktree-declared URL.
  const worktree = resolveWorktreeDatabaseUrl({
    ITOTORI_DB_WORKTREE_ROOT: rootA,
    DATABASE_URL: explicit,
  });
  assert.equal(new URL(worktree).port, derivedPort);

  // The worktree compose env file publishes that same derived host port.
  const values = worktreeComposeEnvValues({ ITOTORI_DB_WORKTREE_ROOT: rootA });
  assert.equal(values.ITOTORI_DB_HOST_PORT, derivedPort);
  assert.equal(values.ITOTORI_DB_WORKTREE_ROOT, rootA);
});

test("worktree URL prefers an explicit ITOTORI_DB_HOST_PORT over the derived preferred port", () => {
  // After a collision probe the lifecycle pins the claimed port via env /
  // compose.env; resolve must surface that claimed port, not re-hash preferred.
  const claimed = resolveWorktreeDatabaseUrl({
    ITOTORI_DB_WORKTREE_ROOT: rootA,
    ITOTORI_DB_HOST_PORT: "57999",
  });
  assert.equal(new URL(claimed).port, "57999");
  assert.notEqual(new URL(claimed).port, String(deriveHostPort(rootA)));
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

test("the DB development selectors have no shared host port and derive their URL per worktree", () => {
  assert.doesNotMatch(
    commandScript,
    /postgres:\/\/[^\n]*:55433/u,
    "command implementation must not hardcode a shared fixed DATABASE_URL default",
  );

  // db-migrate / db-reset (the selectors that CONNECT) must require the
  // declared worktree lifecycle URL so they target the same Postgres that
  // `db-up` brought up — never ambient shell DATABASE_URL.
  assert.match(
    commandScript,
    /DATABASE_URL=\\?"\$\(node scripts\/itotori-db-lifecycle\.mjs require-database-url\)\\?" node apps\/itotori\/dist\/cli\.js db-migrate/u,
  );

  assert.match(
    commandScript,
    /DATABASE_URL=\\?"\$\(node scripts\/itotori-db-lifecycle\.mjs require-database-url\)\\?" node apps\/itotori\/dist\/cli\.js db-reset/u,
  );

  assert.match(commandScript, /itotori-db-lifecycle\.mjs", "up"/u);
  assert.match(commandScript, /itotori-db-lifecycle\.mjs", "down"/u);
  assert.match(commandScript, /itotori-db-lifecycle\.mjs", "sweep"/u);
});

test("db-strict remediation hints derive per-worktree (no shared fixed host port)", () => {
  for (const [name, gate] of [
    ["permission-denial", permissionDenialGate],
    ["catalog-replay", catalogReplayGate],
  ]) {
    assert.doesNotMatch(
      gate,
      /127\.0\.0\.1:55433/u,
      `${name} remediation must not suggest a shared fixed host port`,
    );
    assert.match(
      gate,
      /DATABASE_URL="\$\(node scripts\/itotori-db-lifecycle\.mjs require-database-url\)"/u,
      `${name} remediation must derive the per-worktree DATABASE_URL from the lifecycle`,
    );
  }
});

test("devshell declares the worktree root without ambiently exporting DATABASE_URL", () => {
  // Ambient DATABASE_URL whose container is down is the ECONNREFUSED bug.
  // The shell exports only the worktree root; lifecycle up/require own the URL.
  assert.match(flake, /export ITOTORI_DB_WORKTREE_ROOT="\$worktree_root"/u);
  assert.doesNotMatch(
    flake,
    /export DATABASE_URL=/u,
    "devshell must not ambiently export DATABASE_URL",
  );
  // The per-worktree path must not pin the legacy fixed host port.
  assert.doesNotMatch(flake, /55433|55444/u);
});

test("local compose applies durable runtime Postgres connection tuning", () => {
  assert.match(compose, /command:\n(?:      .+\n)*      - postgres\n/u);
  assert.match(compose, /      - max_connections=400\n/u);
  assert.match(compose, /      - shared_buffers=512MB\n/u);
  assert.match(compose, /4x Postgres' default max_connections/u);
});

test("the DB-backed CI workflow provisions Postgres via a health-checked GH service", () => {
  // ALPHA-009: only DB-backed jobs are asserted here. The alpha-proof job is
  // public-fixture-only and deterministic — it does NOT start Postgres — so it
  // is intentionally excluded (see the job-scoped alpha-proof test below).
  //
  // The hosted PR lane provisions Postgres as a GitHub `services:` container
  // (postgres:18, health-checked) rather than starting docker-compose in-job.
  // A service container is up and ready before any step runs, so the DB-backed
  // suites execute against a real database instead of racing a compose bring-up.
  // docker-compose.yml stays the LOCAL developer path (see the tuning test
  // above); the runner no longer depends on the compose interpolation impl.
  //
  // Atomic CI swap: the DB-backed surface is `_tier1.yml`'s `db` job
  // (Tier 1 / postgres), not the retired top-level `ci.yml`.
  for (const [name, job] of [["tier1/postgres", tier1PostgresJob]]) {
    assert.match(
      job,
      /^\s+services:\n\s+postgres:\n\s+image: postgres:18@sha256:[0-9a-f]{64}\s+# postgres:18\n/mu,
      `${name} must provision a SHA-256-pinned Postgres 18 GH service container`,
    );
    assert.match(
      job,
      /--health-cmd "pg_isready/u,
      `${name} service must health-check Postgres before steps run`,
    );
    // GH service publishes container port 5432 on the runner (not the local
    // compose default 55433). Align the URL to what `_tier1.yml` wires.
    assert.match(
      job,
      /DATABASE_URL: postgres:\/\/itotori:itotori@127\.0\.0\.1:5432\/itotori/u,
      `${name} must wire DATABASE_URL to the service`,
    );
    // The DB-owned durable restart/memo proofs drive the real Kaifuu and
    // Utsushi seams. Consume the release binaries built by the native job,
    // rather than relying on a hidden local cargo fallback in CI.
    assert.match(job, /needs: \[native\]/u, `${name} must wait for the native CLI artifact`);
    assert.match(
      job,
      /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/u,
      `${name} must download the native CLI artifact`,
    );
    assert.match(
      job,
      /name: native-\$\{\{ github\.sha \}\}-linux-x64\n\s+path: \.ci\/bin/u,
      `${name} must use the matching native artifact`,
    );
    assert.match(job, /ITOTORI_KAIFUU_BIN=\$PWD\/\.ci\/bin\/kaifuu-cli/u);
    assert.match(job, /ITOTORI_UTSUSHI_BIN=\$PWD\/\.ci\/bin\/utsushi-cli/u);
    // The runner no longer starts/tears down the local compose stack.
    assert.doesNotMatch(
      job,
      /just db-up|just db-wait|just db-down/u,
      `${name} must not drive local docker-compose on the hosted runner`,
    );
  }
});

test("the alpha-proof integration workflow is public-fixture-only (no Postgres)", () => {
  // ALPHA-009: the alpha proof gate must not depend on a database, live
  // credentials, or private corpora. After the atomic CI swap, alpha-proof is a
  // job inside `_tier1.yml` (not a standalone workflow). The workflow file as a
  // whole DOES contain DATABASE_URL (postgres job), so assertions are
  // job-scoped to the alpha job only.
  assert.doesNotMatch(
    tier1AlphaJob,
    /^\s+services:\n/mu,
    "alpha-proof job must not provision GH service containers",
  );
  assert.doesNotMatch(tier1AlphaJob, /just db-up|just db-wait|just db-down/u);
  assert.doesNotMatch(tier1AlphaJob, /DATABASE_URL/u);
  // The CI job invokes the canonical alpha test selector directly.
  assert.match(tier1AlphaJob, /run: just test alpha\n/u);
});

test("DB development selectors use explicit compose env files without project-global .env leakage", () => {
  // Lifecycle owns compose --env-file invocation; developer-command only
  // delegates. The wait path still materializes the worktree compose env file.
  const lifecycle = readFileSync("scripts/itotori-db-lifecycle.mjs", "utf8");
  assert.match(lifecycle, /compose", "--env-file"/u);
  assert.match(commandScript, /itotori-db-lifecycle\.mjs/u);
  assert.doesNotMatch(commandScript, /ITOTORI_DB_COMPOSE_ENV_PATH/u);
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
  "even-trailing-run\\\\", // EVEN trailing backslash run — pairs up, quote stays free
  "back\\\\slash\\\\", // interior + even trailing backslashes
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

test("encodeEnvFileValue rejects a value ending in an ODD backslash run (escapes the closing quote)", () => {
  // A single trailing backslash: its backslash escapes the closing quote in
  // compose-go's terminator scan, leaving the value unterminated.
  assert.throws(
    () => encodeEnvFileValue("secret\\", "ITOTORI_DB_PASSWORD"),
    /ITOTORI_DB_PASSWORD.*odd run of backslashes.*unterminated/su,
    "an odd trailing backslash run must be rejected with a diagnostic naming the char",
  );
  // Three trailing backslashes is still odd -> still rejected.
  assert.throws(
    () => encodeEnvFileValue("pw\\\\\\", "ITOTORI_DB_PASSWORD"),
    /ITOTORI_DB_PASSWORD.*odd run of backslashes/u,
  );
  // A value that is ONLY an odd backslash run is rejected too.
  assert.throws(() => encodeEnvFileValue("\\", "ITOTORI_DB_PASSWORD"), /odd run of backslashes/u);

  // An EVEN trailing run pairs up harmlessly and must round-trip, not be rejected.
  const even = "pw\\\\"; // pw + two backslashes
  assert.equal(decodeComposeEnvFileValue(encodeEnvFileValue(even, "ITOTORI_DB_PASSWORD")), even);
});

test("decodeComposeEnvFileValue models compose-go's escape-during-terminator scan", () => {
  // Interior backslashes never touch the terminator: the value round-trips.
  assert.equal(decodeComposeEnvFileValue("'back\\slash\\path'"), "back\\slash\\path");
  // An EVEN trailing run leaves the closing quote free: terminator found.
  assert.equal(decodeComposeEnvFileValue("'pw\\\\'"), "pw\\\\");
  // An ODD trailing run escapes the closing quote: compose-go sees NO terminator,
  // so the reference decoder must report the value as UNTERMINATED (mis-parse),
  // not silently strip the quotes. This is the exposure the naive decoder hid.
  assert.throws(() => decodeComposeEnvFileValue("'pass\\'"), /unterminated/u);
  assert.throws(() => decodeComposeEnvFileValue("'\\'"), /unterminated/u);
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
