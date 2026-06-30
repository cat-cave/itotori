import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // Deterministic recorder artifacts (UTSUSHI-062 bridge-linked jump
    // target replay logs) are byte-pinned to the output of
    // `deterministic_json_bytes`. Letting the formatter rewrite them
    // would silently break the byte-equality determinism gate.
    //
    // The ALPHA-004 engine capability matrix artifact is byte-pinned to the
    // output of `scripts/generate-engine-capability-matrix.mjs` (its `--check`
    // staleness gate compares exact bytes); the formatter must not rewrite it.
    ignorePatterns: [
      "crates/utsushi-fixture/tests/fixtures/jump_targets/replay_logs/**",
      "apps/itotori/src/engine-capability/**",
    ],
  },
  resolve: {
    alias: {
      "@itotori/db": fileURLToPath(new URL("./packages/itotori-db/src/index.ts", import.meta.url)),
      "@itotori/localization-bridge-schema": fileURLToPath(
        new URL("./packages/localization-bridge-schema/src/index.ts", import.meta.url),
      ),
    },
  },
  run: {
    tasks: {
      "schema:check": {
        command: "pnpm --filter @itotori/localization-bridge-schema test",
        env: ["NODE_ENV"],
      },
      "ts:typecheck": {
        command: "vp run -r typecheck",
        dependsOn: ["schema:check"],
      },
      "ts:test": {
        command: "vp run -r test",
        dependsOn: ["schema:check"],
      },
      "ts:build": {
        command: "vp run -r build",
        dependsOn: ["schema:check"],
      },
      "db:migrate:test": {
        command: "node apps/itotori/dist/cli.js db-migrate",
        dependsOn: ["ts:build"],
        cache: false,
      },
      "catalog:resolve-fixture": {
        command: "node apps/itotori/dist/cli.js catalog-resolve-fixture",
        dependsOn: ["ts:build"],
        cache: false,
      },
      "style-guide:provider-smoke": {
        command: "node apps/itotori/dist/style-guide-provider-smoke.js",
        dependsOn: ["ts:build"],
        cache: false,
      },
      "style-guide:fixture-flow": {
        command: "node apps/itotori/dist/cli.js style-guide-fixture-flow",
        dependsOn: ["db:migrate:test"],
        cache: false,
      },
      "itotori:agentic-loop-smoke": {
        // ITOTORI-222: end-to-end agentic-loop smoke command. The
        // default entry point relies on the FakeModelProvider baked
        // into the smoke command, so it does NOT need a Postgres
        // connection. CI invokes the deterministic fake provider per
        // stage to exercise the orchestrator from context through
        // final draft.
        command: "node apps/itotori/dist/cli.js agentic-loop-smoke",
        dependsOn: ["ts:build"],
        cache: false,
      },
      "itotori:review-queue-fixture": {
        command: "node apps/itotori/dist/cli.js review-queue-fixture",
        dependsOn: ["ts:build"],
        cache: false,
      },
      "style-guide:live-provider-smoke": {
        command: "node apps/itotori/dist/style-guide-provider-smoke.js --live",
        dependsOn: ["ts:build"],
        cache: false,
      },
      "rust:check": {
        command: "cargo check --workspace",
      },
      "rust:test": {
        command: "cargo test --workspace",
      },
      // ALPHA-007: public fixture vertical run. Composes the existing public
      // fixture artifacts across Itotori + Kaifuu + Utsushi + provider proof +
      // SHARED-025 manifest and produces a fresh ITOTORI-026 benchmark, then
      // emits a hash-addressed, schema-valid, linkage-proven manifest under
      // artifacts/alpha/public-fixture/. Public fixtures only; no DB, no creds.
      "alpha:public-fixture": {
        command: "node suite/scripts/alpha-public-fixture/run.mjs",
        dependsOn: ["ts:build"],
        cache: false,
      },
      // ALPHA-007: independent artifact-linkage validator. Re-proves linkage
      // from the emitted artifacts (schema + hash-addressing + cross-artifact
      // agreement) instead of trusting a success string.
      "alpha:public-fixture-validate": {
        command: "node suite/scripts/alpha-public-fixture/validate-linkage.mjs",
        dependsOn: ["alpha:public-fixture"],
        cache: false,
      },
      // ALPHA-007: deterministic unit + integration tests for the vertical.
      "alpha:public-fixture-test": {
        command:
          "node --test suite/scripts/alpha-public-fixture/run.test.mjs suite/scripts/alpha-public-fixture/linkage.test.mjs",
        cache: false,
      },
      // ITOTORI-095: run PUBLIC RECORDED inputs through one full Itotori
      // iteration (import -> draft -> QA -> reviewer action -> export ->
      // feedback import -> targeted rerun -> final result) and emit a
      // schema-valid, hash-addressed FixtureIterationResult artifact per
      // stage. Composes existing seams; recorded/public only, no creds, no DB.
      "itotori:fixture-iteration": {
        command: "node suite/scripts/itotori-fixture-iteration/run.mjs",
        cache: false,
      },
      // ITOTORI-095: deterministic unit + integration tests covering the full
      // iteration + per-stage schema-valid artifacts across all four recorded
      // paths (success, QA rejection, runtime feedback, rerun repair).
      "itotori:fixture-iteration-test": {
        command:
          "node --test suite/scripts/itotori-fixture-iteration/run.test.mjs suite/scripts/itotori-fixture-iteration/iteration.test.mjs",
        cache: false,
      },
      // ITOTORI-028: end-to-end draft iteration fixture command. COMPOSES the
      // ITOTORI-095 Itotori loop (import -> draft -> qa -> reviewer -> export ->
      // feedback -> rerun) with the Kaifuu patch result + Utsushi runtime
      // observation into ONE manifest-bound run, then emits a schema-valid,
      // hash-addressed FixtureIterationResult artifact per stage and a
      // SHARED-025 manifest that proves all nine stages belong to the same
      // fixture id + source revision. Composes existing seams; recorded/public
      // only, no creds, no DB.
      "itotori:iteration-fixture": {
        command: "node suite/scripts/itotori-iteration-fixture/run.mjs",
        cache: false,
      },
      // ITOTORI-028: deterministic unit + integration tests covering the full
      // cross-tool composition + per-stage schema-valid/hash-addressed
      // artifacts across all six recorded paths (success, QA rejection, runtime
      // feedback, patch failure, provider fallback, rerun repair).
      "itotori:iteration-fixture-test": {
        command:
          "node --test suite/scripts/itotori-iteration-fixture/run.test.mjs suite/scripts/itotori-iteration-fixture/iteration-fixture.test.mjs",
        cache: false,
      },
    },
  },
});
