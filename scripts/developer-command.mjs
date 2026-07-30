#!/usr/bin/env node
/**
 * The implementation behind the six supported `just` delegates.
 *
 * Recipes are deliberately not used as a command registry.  A service, check
 * scope, test selector, or CI lane is data passed to one stable entry point.
 */
import { spawnSync } from "node:child_process";

const [delegate, selector = "", ...args] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`developer-command: ${message}\n`);
  process.exit(2);
}

function run(command, commandArgs = [], options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, commandArgs = []) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout.trim();
}

function shell(script) {
  run("bash", ["-eu", "-o", "pipefail", "-c", script]);
}

function oneOf(kind, value, values) {
  if (!values.includes(value))
    fail(`unknown ${kind} "${value}"; expected one of: ${values.join(", ")}`);
}

function check(scope, forwarded) {
  const scopes = ["all", "meta", "ts", "rust", "fixtures", "affected"];
  oneOf("check scope", scope, scopes);
  if (scope === "fixtures")
    return run("pnpm", ["exec", "node", "fixtures/validate-public-manifests.mjs", ...forwarded]);
  if (scope === "affected") return run("node", ["scripts/affected.mjs", ...forwarded]);
  if (scope === "ts") return shell("pnpm exec vp check\npnpm exec vp run ts:typecheck");
  if (scope === "rust")
    return shell(
      "cargo fmt --check\ncargo check --workspace\ncargo clippy --workspace --all-targets --all-features -- -D warnings\ncargo deny check",
    );
  if (scope === "meta")
    return shell(`
node --test scripts/itotori-db-compose-config.test.mjs
node --test scripts/developer-command.test.mjs
node --test scripts/env-registry-guard.test.mjs
node scripts/env-registry-guard.mjs
node --test scripts/developer-command-db.test.mjs
node --test scripts/justfile-surface.test.mjs
node --test scripts/itotori-db-wait.test.mjs
node --test scripts/permission-denial-db-gate.test.mjs
node --test scripts/catalog-replay-db-gate.test.mjs
node --test scripts/affected.test.mjs
node --test scripts/native-deps.test.mjs
node --test scripts/itotori-installable-package.test.mjs
node --test scripts/validate-tracked-artifact-hygiene.test.mjs
node scripts/validate-tracked-artifact-hygiene.mjs --mode check
node --test scripts/stale-residue-guard.test.mjs
node scripts/stale-residue-guard.mjs --mode check
node --test scripts/audit-behavior-roadmap.test.mjs
node scripts/audit-behavior-roadmap.mjs
node --test scripts/audit-behavior-catalog.test.mjs
node scripts/audit-behavior-catalog.mjs
node --test scripts/audit-no-hardcoded-cost.test.mjs
node scripts/audit-no-hardcoded-cost.mjs
node --test scripts/audit-strictness.test.mjs
node scripts/audit-strictness.mjs
node --test scripts/classify-test-seams.test.mjs
node --test scripts/test-collection-guard.test.mjs
node --test scripts/audit-no-hardcoded-roles.test.mjs
node scripts/audit-no-hardcoded-roles.mjs
node --test scripts/audit-no-direct-provider-invoke.test.mjs
node scripts/audit-no-direct-provider-invoke.mjs
node --test scripts/audit-privacy-retention-egress.test.mjs
node scripts/audit-privacy-retention-egress.mjs
node --test scripts/audit-no-node-ids.test.mjs
node scripts/audit-no-node-ids.mjs
node --test scripts/audit-no-game-names.test.mjs
node scripts/audit-no-game-names.mjs
node --test scripts/audit-ci-input-pins.test.mjs
node scripts/audit-ci-input-pins.mjs
node --test scripts/validate-no-specific-game-references.test.mjs
node scripts/validate-no-specific-game-references.mjs
node --test scripts/file-line-cap-guard.test.mjs
node scripts/file-line-cap-guard.mjs
node --test scripts/audit-app-css-contract.test.mjs
node scripts/audit-app-css-contract.mjs
node --test scripts/audit-deletion-ledger.test.mjs
node scripts/audit-deletion-ledger.mjs
node --test scripts/audit-no-legacy-llm-residue.test.mjs
node scripts/audit-no-legacy-llm-residue.mjs
node --test scripts/audit-llm-layer-imports.test.mjs
node scripts/audit-llm-layer-imports.mjs
node --test scripts/assert-tanstack-openrouter-pin.test.mjs
node scripts/assert-tanstack-openrouter-pin.mjs
node --test scripts/audit-llm-loc-budget.test.mjs
node scripts/audit-llm-loc-budget.mjs
node --test scripts/ci/assert-renderer-contract.test.mjs
node --test scripts/ci/public-lane-coverage.test.mjs
node scripts/ci/public-lane-coverage.mjs --check
node --test scripts/ci/private-real-byte-proof.test.mjs
pnpm --filter @itotori/db exec vitest run test/migrations-parity.test.ts --exclude '**/.direnv/**'
node --test scripts/generate-engine-capability-matrix.test.mjs
node scripts/generate-engine-capability-matrix.mjs --check
node --test scripts/synthetic-coverage-manifest.test.mjs
node scripts/synthetic-coverage-manifest.mjs --check
node --test scripts/mutation-differential.test.mjs
node --test scripts/coverage-parity.test.mjs
node scripts/coverage-parity.mjs
pnpm exec node fixtures/validate-public-manifests.mjs
node --test fixtures/generate-kaifuu-encrypted-public-fixtures.test.mjs
node scripts/verify-toolchain-policy.mjs
node scripts/verify-deny-strict.mjs
`);
  return shell(
    `node scripts/developer-command.mjs check meta\nnode scripts/developer-command.mjs check ts\nnode scripts/developer-command.mjs check rust`,
  );
}

function softpalRealBytesCommand() {
  return `
cargo test -p kaifuu-softpal -- --ignored
cargo test -p utsushi-softpal --test softpal_runtime_real_corpus --test softpal_dialogue_execution_analysis_real_corpus -- --ignored
`;
}

function test(selector, forwarded) {
  const selectors = [
    "all",
    "browser",
    "real-bytes",
    "real-bytes-oracle",
    "real-bytes-oracle-drift",
    "db",
    "permission-denial-db",
    "catalog-replay-db",
    "contract",
    "mutation-property",
    "mutation-differential",
    "alpha",
    "hello-replay",
    "hello-replay-validate",
    "ratio",
    "dlsite-demand",
  ];
  oneOf("test selector", selector, selectors);
  if (selector === "all") return shell("pnpm exec vp run ts:test\ncargo test --workspace");
  if (selector === "browser")
    return shell(`
bin="\${PLAYWRIGHT_CHROMIUM_BIN:-\${UTSUSHI_BROWSER_BIN:-}}"
test -n "$bin" && test -x "$bin"
pnpm --filter @itotori/app e2e
pnpm --filter @itotori/runtime-web-review e2e
`);
  if (selector === "real-bytes")
    return shell(
      `node scripts/real-bytes-lane.mjs
pnpm exec vp run ts:build
pnpm --filter @itotori/app exec vitest run test/rpgmaker-production-real-bytes.test.ts --exclude '**/.direnv/**'
pnpm --filter @itotori/app exec vitest run test/patchback-produce-build.test.ts --exclude '**/.direnv/**'
cargo test -p kaifuu-core --test xp3_real_bytes_roundtrip
cargo test -p kaifuu-reallive -p utsushi-reallive -p utsushi-siglus -p kaifuu-siglus -p kaifuu-cli -p utsushi-cli -p kaifuu-rpgmaker -p kaifuu-engine-fixture -p kaifuu-nexas -- --ignored
cargo test -p utsushi-core --test composite_asset_package_real_bytes
cargo test -p kaifuu-vault-source --test live_vault_open_test --test live_vault_by_id_test --test live_vault_siglus_test -- --ignored
${softpalRealBytesCommand()}`,
    );
  if (selector === "real-bytes-oracle")
    return run("node", ["scripts/real-bytes-oracle.mjs", ...forwarded]);
  if (selector === "real-bytes-oracle-drift")
    return run("node", ["scripts/real-bytes-oracle.mjs", "--drift-only", ...forwarded]);
  if (selector === "db")
    return shell(
      "rm -f .tmp/itotori-db/no-database-skipped.json\npnpm --filter @itotori/db test:db\nnode scripts/assert-db-tests-not-skipped.mjs",
    );
  if (selector === "permission-denial-db")
    return run("node", ["scripts/permission-denial-db-gate.mjs", ...forwarded]);
  if (selector === "catalog-replay-db")
    return run("node", ["scripts/catalog-replay-db-gate.mjs", ...forwarded]);
  if (selector === "contract")
    return shell(
      "pnpm --filter @itotori/localization-bridge-schema test\ncargo test -p kaifuu-core shared_contract_fixture_suite",
    );
  if (selector === "mutation-property")
    return shell(
      "pnpm exec vitest run packages/localization-bridge-schema/test/schema.test.ts\ncargo test -p kaifuu-core property",
    );
  if (selector === "mutation-differential")
    return run("node", ["scripts/mutation-differential.mjs", ...forwarded]);
  if (selector === "alpha")
    return run("corepack", [
      "pnpm",
      "--dir",
      "apps/itotori",
      "exec",
      "vitest",
      "run",
      "test/composition-reachability.test.ts",
      "--exclude",
      "**/.direnv/**",
      ...forwarded,
    ]);
  if (selector === "hello-replay")
    return run("cargo", [
      "test",
      "-p",
      "utsushi-reallive",
      "--test",
      "replay_scene_synthetic",
      "--",
      "--nocapture",
      ...forwarded,
    ]);
  if (selector === "hello-replay-validate")
    return shell(
      "cargo test -p utsushi-cli --bins replay_validate -- --nocapture\ncargo run -p utsushi-cli -- replay-validate --help",
    );
  if (selector === "ratio") return run("node", ["scripts/classify-test-seams.mjs", ...forwarded]);
  return run("pnpm", [
    "exec",
    "vitest",
    "run",
    "apps/itotori/test/dlsite-demand.test.ts",
    "--exclude",
    "**/.direnv/**",
    ...forwarded,
  ]);
}

function ci(lane, forwarded) {
  const lanes = [
    "public",
    "tier0",
    "tier0-meta",
    "tier0-ts",
    "tier0-rust",
    "tier0-manifest",
    "tier1-ts-public-1of2",
    "tier1-ts-public-2of2",
    "tier1-rust-1of3",
    "tier1-rust-2of3",
    "tier1-rust-3of3",
    "tier1-db",
    "tier1-browser",
    "tier1-mutation",
    "private-real-bytes",
  ];
  oneOf("CI lane", lane, lanes);
  if (lane === "public")
    return shell(
      "node scripts/developer-command.mjs check all\nnode scripts/developer-command.mjs dev build\nnode scripts/developer-command.mjs dev db-migrate\nnode scripts/developer-command.mjs test all\nnode scripts/developer-command.mjs test mutation-differential",
    );
  if (lane === "tier0")
    return shell(
      "node scripts/developer-command.mjs ci tier0-meta\nnode scripts/developer-command.mjs ci tier0-ts\nnode scripts/developer-command.mjs ci tier0-rust\nnode scripts/developer-command.mjs ci tier0-manifest",
    );
  if (lane === "tier0-meta") return check("meta", forwarded);
  if (lane === "tier0-ts") return check("ts", forwarded);
  if (lane === "tier0-rust") return check("rust", forwarded);
  if (lane === "tier0-manifest")
    return shell(
      "if [ -f scripts/ci/lane-manifest-gate.mjs ]; then node scripts/ci/lane-manifest-gate.mjs; else echo 'manifest gate pending'; fi",
    );
  if (lane === "tier1-ts-public-1of2")
    return shell(
      "pnpm exec vp run ts:build\npnpm --filter @itotori/localization-bridge-schema test\npnpm --filter @itotori/runtime-web-review test\npnpm --filter @itotori/ds test:dom\npnpm --filter @itotori/app exec vitest run --shard=1/2 --exclude '**/.direnv/**'",
    );
  if (lane === "tier1-ts-public-2of2")
    return shell(
      "pnpm exec vp run ts:build\npnpm --filter @itotori/db test\npnpm --filter @itotori/app exec vitest run --shard=2/2 --exclude '**/.direnv/**'",
    );
  const rustPartition = /^tier1-rust-([1-3])of3$/u.exec(lane)?.[1];
  if (rustPartition !== undefined)
    return run("cargo", [
      "nextest",
      "run",
      "--workspace",
      "--partition",
      `hash:${rustPartition}/3`,
      ...forwarded,
    ]);
  if (lane === "tier1-db")
    return shell(
      "pnpm exec vp run ts:build\nnode apps/itotori/dist/cli.js db-migrate\nnode apps/itotori/dist/cli.js db-reset\npnpm --filter @itotori/db test:db\nnode scripts/assert-db-tests-not-skipped.mjs\npnpm --filter @itotori/app exec vitest run --exclude '**/.direnv/**'",
    );
  if (lane === "tier1-browser")
    return shell(
      "node scripts/ci/assert-renderer-contract.mjs\nnode scripts/developer-command.mjs test browser\npnpm --filter @itotori/ds visual:test",
    );
  if (lane === "tier1-mutation") return test("mutation-differential", forwarded);
  return run("node", ["scripts/ci/private-real-byte-proof.mjs", "--preflight", ...forwarded]);
}

function runScaleHarness(profile, forwarded) {
  const databaseUrl = capture("node", [
    "scripts/itotori-db-compose-env.mjs",
    "--print-database-url",
  ]);
  run("node", ["scripts/developer-command.mjs", "dev", "db-up"]);
  run("node", ["scripts/developer-command.mjs", "dev", "db-wait"]);
  run("pnpm", ["exec", "vp", "run", "ts:build"]);
  run("node", ["scripts/itotori-scale-harness.mjs", "--profile", profile, ...forwarded], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

switch (delegate) {
  case "worktree-setup":
    if (selector) fail("worktree-setup takes no selector");
    run("pnpm", ["install", "--frozen-lockfile", "--offline"]);
    break;
  case "dev":
    oneOf("development service", selector, [
      "app",
      "dashboard",
      "install",
      "build",
      "package",
      "package-pack",
      "scale-smoke",
      "scale-large",
      "audit-findings-seed",
      "upgrade",
      "db-up",
      "db-down",
      "db-wait",
      "db-migrate",
      "db-reset",
    ]);
    if (selector === "app") run("pnpm", ["--filter", "@itotori/app", "dev", ...args]);
    else if (selector === "dashboard") run("node", ["apps/itotori/dist/server.js", ...args]);
    else if (selector === "install") run("pnpm", ["install", ...args]);
    else if (selector === "build") shell("pnpm exec vp run ts:build\ncargo build --workspace");
    else if (selector === "package") run("node", ["packages/itotori-cli/build.mjs", ...args]);
    else if (selector === "package-pack")
      shell("node packages/itotori-cli/build.mjs\ncd packages/itotori-cli && npm pack");
    else if (selector === "scale-smoke" || selector === "scale-large")
      runScaleHarness(selector.slice(6), args);
    else if (selector === "audit-findings-seed")
      shell("pnpm --filter @itotori/app build\nnode apps/itotori/dist/audit-findings/seed-cli.js");
    else if (selector === "db-up")
      shell(
        'compose_env_path="$(node scripts/itotori-db-compose-env.mjs --print-compose-env-path)"\nnode scripts/itotori-db-compose-env.mjs\ndocker compose --env-file "$compose_env_path" up -d postgres',
      );
    else if (selector === "db-down")
      shell(
        'compose_env_path="$(node scripts/itotori-db-compose-env.mjs --print-compose-env-path)"\nnode scripts/itotori-db-compose-env.mjs\ndocker compose --env-file "$compose_env_path" down',
      );
    else if (selector === "db-wait")
      shell(
        'compose_env_path="$(node scripts/itotori-db-compose-env.mjs --print-compose-env-path)"\nnode scripts/itotori-db-compose-env.mjs\nnode scripts/itotori-db-wait.mjs --compose-env-path "$compose_env_path"',
      );
    else if (selector === "db-migrate")
      shell(
        'pnpm exec vp run ts:build\nDATABASE_URL="$(node scripts/itotori-db-compose-env.mjs --print-database-url)" node apps/itotori/dist/cli.js db-migrate',
      );
    else if (selector === "db-reset")
      shell(
        'pnpm exec vp run ts:build\nDATABASE_URL="$(node scripts/itotori-db-compose-env.mjs --print-database-url)" node apps/itotori/dist/cli.js db-reset',
      );
    else
      shell(
        "corepack enable\nnode scripts/update-node-version.mjs\ncorepack use pnpm@latest\nnode scripts/sync-pnpm-engine.mjs\npnpm update --latest --recursive\nrustup update stable\ncargo update\nnode scripts/verify-toolchain-policy.mjs",
      );
    break;
  case "doctor":
    oneOf("doctor profile", selector, ["core", "render", "full", "provision"]);
    run("node", [
      "scripts/native-deps.mjs",
      selector === "provision" ? "provision" : "doctor",
      ...(selector === "provision" ? args : ["--profile", selector, ...args]),
    ]);
    break;
  case "check":
    check(selector, args);
    break;
  case "test":
    test(selector, args);
    break;
  case "ci":
    ci(selector, args);
    break;
  default:
    fail(`unknown delegate "${delegate}"; run just --summary`);
}
