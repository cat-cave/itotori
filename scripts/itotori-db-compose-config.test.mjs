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
const permissionDenialGate = readFileSync("scripts/permission-denial-db-gate.mjs", "utf8");
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
    ["permission-denial", permissionDenialGate],
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

test("local compose passes generated credentials through its managed env file", () => {
  assert.match(compose, /^    env_file:\n      - \$\{ITOTORI_DB_COMPOSE_ENV_PATH\}\n/mu);
  assert.doesNotMatch(compose, /^    environment:/mu);
  assert.doesNotMatch(compose, /ITOTORI_DB_(?:USER|PASSWORD|NAME)/u);
  assert.doesNotMatch(compose, /^      POSTGRES_(?:USER|PASSWORD|DB):/mu);
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

test("CI provisions lockfile-pinned Playwright Chromium before running the full gate", () => {
  const dependencyInstall = ciWorkflow.indexOf("pnpm install --frozen-lockfile");
  const chromiumInstall = ciWorkflow.indexOf(
    "pnpm --filter @itotori/ds exec playwright install chromium",
  );
  const chromiumPath = ciWorkflow.indexOf("chromium.executablePath()");
  const fullGate = ciWorkflow.indexOf("just ci");

  assert.ok(dependencyInstall >= 0, "CI installs locked Node dependencies");
  assert.ok(
    chromiumInstall > dependencyInstall,
    "Chromium install follows the locked dependency install",
  );
  assert.ok(chromiumPath > chromiumInstall, "CI resolves Chromium through the Playwright API");
  assert.ok(fullGate > chromiumPath, "both browser consumers are configured before the full gate");
  assert.match(
    ciWorkflow,
    /test -x "\$chromium_bin"/u,
    "CI refuses a missing Playwright executable",
  );
  assert.match(
    ciWorkflow,
    /PLAYWRIGHT_CHROMIUM_BIN=\$chromium_bin/u,
    "the Playwright consumer receives the resolved executable",
  );
  assert.match(
    ciWorkflow,
    /UTSUSHI_BROWSER_BIN=\$chromium_bin/u,
    "the Utsushi consumer receives the resolved executable",
  );
  assert.match(ciWorkflow, />> "\$GITHUB_ENV"/u, "browser paths persist to later CI steps");
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
  "even-trailing-run\\\\", // EVEN trailing backslash run — pairs up, quote stays free
  "back\\\\slash\\\\", // interior + even trailing backslashes
  "trailing#hash and =equals",
  "itotori", // the public no-secret default
  "", // empty credential
];

test("encodeEnvFileValue round-trips $/quotes/spaces/backslashes through the compose model", () => {
  for (const credential of preservedCredentials) {
    const encoded = encodeEnvFileValue(credential, "POSTGRES_PASSWORD");
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
    () => encodeEnvFileValue("pa'ss", "POSTGRES_PASSWORD"),
    /POSTGRES_PASSWORD.*single quote \('\)/u,
    "a single quote must be rejected with a diagnostic naming the offending char",
  );
  assert.throws(
    () => encodeEnvFileValue("line1\nline2", "POSTGRES_PASSWORD"),
    /POSTGRES_PASSWORD.*newline \(\\n\)/u,
    "a newline must be rejected with a diagnostic naming the offending char",
  );
  assert.throws(
    () => encodeEnvFileValue("has\rcr", "POSTGRES_DB"),
    /POSTGRES_DB.*carriage return \(\\r\)/u,
  );
});

test("encodeEnvFileValue rejects a value ending in an ODD backslash run (escapes the closing quote)", () => {
  // A single trailing backslash: its backslash escapes the closing quote in
  // compose-go's terminator scan, leaving the value unterminated.
  assert.throws(
    () => encodeEnvFileValue("secret\\", "POSTGRES_PASSWORD"),
    /POSTGRES_PASSWORD.*odd run of backslashes.*unterminated/su,
    "an odd trailing backslash run must be rejected with a diagnostic naming the char",
  );
  // Three trailing backslashes is still odd -> still rejected.
  assert.throws(
    () => encodeEnvFileValue("pw\\\\\\", "POSTGRES_PASSWORD"),
    /POSTGRES_PASSWORD.*odd run of backslashes/u,
  );
  // A value that is ONLY an odd backslash run is rejected too.
  assert.throws(() => encodeEnvFileValue("\\", "POSTGRES_PASSWORD"), /odd run of backslashes/u);

  // An EVEN trailing run pairs up harmlessly and must round-trip, not be rejected.
  const even = "pw\\\\"; // pw + two backslashes
  assert.equal(decodeComposeEnvFileValue(encodeEnvFileValue(even, "POSTGRES_PASSWORD")), even);
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
  assert.equal(values.POSTGRES_USER, "us$er");
  assert.equal(values.POSTGRES_PASSWORD, "p$4ss$");
  assert.equal(values.POSTGRES_DB, "it$db");
  assert.deepEqual(Object.keys(values), [
    "COMPOSE_PROJECT_NAME",
    "ITOTORI_DB_HOST_PORT",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
  ]);

  const rendered = renderComposeEnvFile(values);
  assert.doesNotMatch(rendered, /^ITOTORI_DB_(?:USER|PASSWORD|NAME)=/mu);
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
    COMPOSE_PROJECT_NAME: "itotori",
    DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:56000/itotori",
  });
  const rendered = renderComposeEnvFile(values);
  assert.equal(
    rendered,
    [
      "COMPOSE_PROJECT_NAME='itotori'",
      "ITOTORI_DB_HOST_PORT='56000'",
      "POSTGRES_USER='itotori'",
      "POSTGRES_PASSWORD='itotori'",
      "POSTGRES_DB='itotori'",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(rendered, /^ITOTORI_DB_(?:USER|PASSWORD|NAME)=/mu);
  for (const [key, value] of Object.entries(values)) {
    const line = rendered.split("\n").find((l) => l.startsWith(`${key}=`));
    assert.equal(decodeComposeEnvFileValue(line.slice(key.length + 1)), String(value));
  }
});

// This proves interpolation at the container boundary. `docker compose config`
// is not evidence: it reports a composed model, not the environment inherited
// by the `postgres` container. Every sentinel is public and is compared only by
// a fixed SHA-256 value inside the container, so no credential is emitted.
test("Docker Compose runtime preserves generated dollar-bearing credentials", (t) => {
  let composeVersion;
  try {
    composeVersion = execFileSync("docker", ["compose", "version"], { encoding: "utf8" });
  } catch {
    t.skip("no Docker Compose CLI available");
    return;
  }
  if (/podman/iu.test(composeVersion)) {
    t.skip("Docker command delegates Compose parsing to Podman Compose");
    return;
  }

  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    t.skip("Docker daemon unavailable");
    return;
  }
  try {
    execFileSync("docker", ["image", "inspect", "postgres:18"], { stdio: "ignore" });
  } catch {
    t.skip("postgres:18 image unavailable");
    return;
  }

  const dir = mkdtempSync(path.join(tmpdir(), "univ022-compose-"));
  const envPath = path.join(dir, "gen.env");
  const baseValues = composeEnvValues({
    DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:56000/itotori",
    COMPOSE_PROJECT_NAME: `univ022-${process.pid}-${path.basename(dir)}`,
  });
  const projectName = baseValues.COMPOSE_PROJECT_NAME;
  const composeEnvironment = {
    ...process.env,
    COMPOSE_PROJECT_NAME: projectName,
    ITOTORI_DB_COMPOSE_ENV_PATH: envPath,
    UNIV022_SHOULD_NOT_EXPAND: "host-value-must-not-replace-the-literal",
  };
  const runtimeSentinels = [
    ["p$4ssw0rd", "e65a53742fd64af5b1ea85ee5eb15f1a4109c1694211b96b17baf094a17e544c"],
    ["a$$b", "6af6151534adb8c18aa8d3ac1cdf703a03993265763da0b20abfe1478097cfdd"],
    [
      "pre${UNIV022_SHOULD_NOT_EXPAND}post",
      "5c786e8664c67cb35854321e23571a65c6c0561e6f18a61921b15772c7664eec",
    ],
  ];
  let cleanupError;
  try {
    for (const [credential, expectedHash] of runtimeSentinels) {
      // The unique project name limits the finally cleanup to this test's
      // one-off containers; it cannot target a developer's normal DB project.
      const values = {
        ...baseValues,
        POSTGRES_PASSWORD: credential,
      };
      writeFileSync(envPath, renderComposeEnvFile(values));
      execFileSync(
        "docker",
        [
          "compose",
          "--env-file",
          envPath,
          "run",
          "--rm",
          "--no-deps",
          "-T",
          "--entrypoint",
          "sh",
          "postgres",
          "-ec",
          `actual="$(printf %s "$POSTGRES_PASSWORD" | sha256sum | cut -d ' ' -f 1)"; test "$actual" = "${expectedHash}"`,
        ],
        { env: composeEnvironment, stdio: "ignore" },
      );
    }
  } finally {
    try {
      execFileSync("docker", ["compose", "--env-file", envPath, "down", "--remove-orphans"], {
        env: composeEnvironment,
        stdio: "ignore",
      });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupError;
});
