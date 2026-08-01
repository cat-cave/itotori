import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // Deterministic recorder artifacts (the relevant capability bridge-linked jump
    // target replay logs) are byte-pinned to the output of
    // `deterministic_json_bytes`. Letting the formatter rewrite them
    // would silently break the byte-equality determinism gate.
    //
    // The ALPHA-004 engine capability matrix artifact is byte-pinned to the
    // output of `scripts/generate-engine-capability-matrix.mjs` (its `--check`
    // staleness gate compares exact bytes); the formatter must not rewrite it.
    //
    // The the relevant capability RPG Maker MV/MZ `plugins.js` data fixtures embed a
    // `$plugins` array the extractor parses as STRICT JSON (quoted keys).
    // Formatting them as JavaScript would unquote the object keys and break
    // the strict-JSON parse, so they must stay strict-JSON-parseable.
    //
    // The the relevant capability MV/MZ live-observation fixture is load-bearing at the
    // byte level: its dialogue/choice plaintext lives ONLY in the inline
    // base64 runtime payload, and the live-trace probe tests assert (a) those
    // strings are ABSENT from the static file and (b) a real JS runtime
    // base64-decodes the payload to build the observation island. Reformatting
    // the inline `<script>`/base64 block changes the runtime page such that
    // headless Chromium's `--dump-dom` trace fails (browser_trace_observes_
    // live_dom_text_and_choice_events exits non-zero), so the fixture must be
    // preserved byte-for-byte.
    ignorePatterns: [
      "crates/utsushi-fixture/tests/fixtures/jump_targets/replay_logs/**",
      // the relevant capability MV/MZ screenshot-evidence golden is byte-compared against
      // `serde_json::to_string_pretty` output by
      // `fixture_report_matches_committed_golden_bytes`; letting the formatter
      // rewrite it would break that byte-equality gate.
      "crates/utsushi-fixture/tests/fixtures/mvmz_screenshot_evidence/evidence.golden.json",
      // the relevant capability MV/MZ review-package manifest golden is byte-compared
      // against `serde_json::to_string_pretty` output by
      // `manifest_matches_committed_golden_bytes`; the formatter must not
      // rewrite it.
      "crates/utsushi-fixture/tests/fixtures/mvmz_review_package/manifest.golden.json",
      // the relevant capability branch-coverage export goldens are byte-compared against
      // `serde_json::to_string_pretty` (JSON) and the Markdown renderer output
      // by `json_export_matches_committed_golden_bytes` /
      // `markdown_export_matches_committed_golden_bytes`; the formatter must not
      // rewrite them out from under the byte-compare.
      "crates/utsushi-core/tests/fixtures/conformance/branch_coverage/export.golden.json",
      "crates/utsushi-core/tests/fixtures/conformance/branch_coverage/export.golden.md",
      // the relevant capability XP3 private-local summary fixtures are byte-compared against
      // the renderer's `serde_json::to_string_pretty` output by
      // `public_summary_reproduces_from_synthetic_inputs` /
      // `json_fixtures_match_synthetic_builders`; the formatter must not rewrite
      // them out from under the byte-compare.
      "fixtures/kaifuu/kirikiri/xp3-private-local/**",
      "apps/itotori/src/engine-capability/**",
      // fe-api-openapi-emit: the OpenAPI + JSON-Schema API contract is byte-pinned
      // to the emitter's `JSON.stringify(sortJsonDeep(...), null, 2)` output
      // (`src/api-contract.ts`); the determinism + drift tests compare exact bytes
      // and the HTTP contract harness validates real responses against it, so the
      // formatter must not rewrite it out from under the byte-compare.
      "apps/itotori/openapi.json",
      "apps/itotori/api-jsonschema.json",
      "fixtures/synthetic/**",
      "crates/kaifuu-rpgmaker/tests/fixtures/**",
      // the relevant capability TyranoScript `.ks` scenario fixture is load-bearing at the
      // byte level: the identity round-trip test asserts extract → re-pack is
      // byte-identical, so the formatter must not rewrite it. (Biome does not
      // format `.ks`, but pin it alongside the other byte-golden corpora.)
      "crates/kaifuu-tyrano/fixtures/**",
      "fixtures/kaifuu/repro-bundle/**",
      "crates/utsushi-fixture/tests/fixtures/mvmz_observation/**",
      // the relevant capability MV/MZ runtime-observation proof artifacts: the real
      // launched-Chromium E1 trace + screenshot evidence + deterministic proof
      // verdict are byte-compared against the pipeline output by
      // `committed_real_launch_evidence_reproduces_the_e1_proof` and the
      // real-browser gate; the formatter must not rewrite them.
      "crates/utsushi-fixture/tests/fixtures/mvmz_runtime_proof/**",
      // the relevant capability MV/MZ PATCHED-output runtime-observation proof artifacts:
      // the real launched-Chromium E1 patched trace, the Kaifuu PatchResult, the
      // alpha proof, and the deterministic patched verdict golden are compared
      // against the pipeline output by
      // `committed_patched_trace_reproduces_the_e1_proof` and the real-browser
      // gate. The patched fixture's inline base64 payload carries the ONLY copy
      // of the observed translation, so the formatter must not rewrite it.
      "crates/utsushi-fixture/tests/fixtures/mvmz_patched_observation/**",
      "crates/utsushi-fixture/tests/fixtures/mvmz_patched_runtime_proof/**",
      // the relevant capability MV/MZ embedded playback demo bundle golden is byte-compared
      // against `serde_json::to_string_pretty` output by
      // `demo_bundle_matches_committed_golden_bytes`, and the runtime-web-review
      // playback surface renders it data-only; the formatter must not rewrite it.
      "crates/utsushi-fixture/tests/fixtures/mvmz_demo_bundle/**",
      // the relevant capability KAG command-trace golden is byte-compared against the
      // `trace-kag` subcommand's deterministic (sorted-key) output by
      // `cli_emits_committed_golden_trace`; the formatter must not rewrite it.
      // The `.ks` fixture beside it is a byte-level KAG scenario source whose
      // line offsets are load-bearing (they appear verbatim in bridge-unit
      // keys), so it is pinned too.
      "fixtures/public/kag-plaintext/**",
      // the relevant capability asset-OCR public fixture: `title-card.text-regions.golden.json`
      // is byte-compared against the `asset-ocr` command's `stable_json` output by
      // `asset_ocr_public_fixture_matches_committed_golden`; the formatter must not
      // rewrite it. (The sibling `title-card.png` is a binary grayscale fixture.)
      "fixtures/public/ocr-ui/**",
      // the relevant capability: the Kaifuu encrypted-matrix public fixtures + their manifest
      // are byte-golden artifacts OWNED by
      // `fixtures/generate-kaifuu-encrypted-public-fixtures.mjs`. The generator
      // emits `JSON.stringify(value, null, 2)` and records each file's exact
      // sha256/bytes in the manifest, and `fixtures/validate-public-manifests.mjs`
      // fails on any drift. Letting the formatter collapse arrays would rewrite the
      // committed bytes out from under those recorded hashes, so regeneration
      // (`node fixtures/generate-kaifuu-encrypted-public-fixtures.mjs`) would no
      // longer be byte-idempotent. Pin the generated tree + manifest so the
      // generator stays the single source of truth (incl. the the relevant capability Siglus
      // parser-boundary smoke expected output it now preserves).
      "fixtures/public/kaifuu-encrypted-matrix/**",
      "fixtures/public/kaifuu-encrypted-matrix.manifest.json",
      // the relevant capability: the hand-authored CC0 KAG `.ks` corpus is byte-level
      // load-bearing (line/byte offsets appear in kaifuu-kirikiri bridge-unit
      // keys), and its manifest is emitted by
      // `fixtures/generate-kaifuu-kag-synthetic-corpus.mjs` as
      // `JSON.stringify(value, null, 2)` with each file's recorded sha256/bytes.
      // The `--check` regeneration and `fixtures/validate-public-manifests.mjs`
      // fail on any drift, so the formatter must not rewrite either.
      "fixtures/public/kaifuu-kag-synthetic-corpus/**",
      "fixtures/public/kaifuu-kag-synthetic-corpus.manifest.json",
      // the relevant capability: this metadata-only real-game XP3 manifest is emitted by
      // `fixtures/generate-kaifuu-xp3-plain-profile-a.mjs` with
      // `JSON.stringify(value, null, 2)`. Its deterministic `--check` proves
      // the reviewed redacted hashes/counts/tag aggregate have not drifted, so
      // the formatter must leave its generated bytes alone.
      "fixtures/public/kaifuu-xp3-plain-profile-a.manifest.json",
      // The `kaifuu detect` detection-report goldens (and their sibling
      // hand-authored fixture bytes) are byte-hashed in their manifests and
      // verified by `fixtures/validate-public-manifests.mjs`. The reports are
      // emitted by the detect CLI's serializer; letting the formatter reflow
      // them (e.g. when a new detector row like `kaifuu.nexas` grows the block)
      // would rewrite the committed bytes out from under the recorded
      // sha256/bytes. Pin the trees + manifests so the detect CLI stays the
      // single source of truth.
      "fixtures/public/reallive-detector/**",
      "fixtures/public/reallive-detector.manifest.json",
      "fixtures/public/kaifuu-rpg-maker-encrypted-suffixes/**",
      "fixtures/public/kaifuu-rpg-maker-encrypted-suffixes.manifest.json",
      // The lean-code ratchet whitelists are machine-generated lockfile-style
      // artifacts OWNED by the CI guards `scripts/audit-no-node-ids.mjs` and
      // `scripts/file-line-cap-guard.mjs`, which emit them as
      // `JSON.stringify(value, null, 2)`. Letting the formatter collapse the
      // arrays would rewrite the committed bytes, so every `--update` would
      // clash with the formatter. Pin them so the guards stay the single source
      // of truth (the shrink-only ratchet is byte-stable across regenerations).
      "scripts/lint/node-id-whitelist.json",
      "scripts/lint/file-line-cap-whitelist.json",
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
        command:
          "vp run -r typecheck && tsc -p suite/behavior/tsconfig.json --noEmit && tsc -p suite/behavior/tsconfig.product.json --noEmit && tsc -p suite/behavior/tsconfig.failure-product.json --noEmit",
        dependsOn: ["schema:check"],
      },
      "ts:test": {
        command: "vp run -r test",
        dependsOn: [
          "schema:check",
          "test:collection",
          "behavior:test",
          "private-input-contract:test",
        ],
      },
      "test:collection": {
        command: "node scripts/test-collection-guard.mjs && node scripts/ci/lane-manifest-gate.mjs",
        dependsOn: ["ts:build"],
      },
      "behavior:test": {
        command: "node scripts/ci/run-behavior-proof.mjs",
        cache: false,
        dependsOn: ["ts:build"],
      },
      "private-input-contract:test": {
        command:
          "node --test suite/scripts/kaifuu-private-local-triage/run.test.mjs suite/scripts/siglus-private-local-validation-renderer/render.test.mjs suite/scripts/kaifuu-key-hunt/key-hunt.test.mjs suite/scripts/kaifuu-encrypted-readiness-integration/run.test.mjs",
        cache: false,
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
      "rust:check": {
        command: "cargo check --workspace",
      },
      "rust:test": {
        command: "cargo test --workspace",
      },
      // the relevant capability: private-local encrypted corpus triage. A FIRST-CLASS LOCAL
      // workflow that is intentionally ABSENT from per-gate CI — no `just
      // check`/`ci` lane and no affected.mjs selection runs it.
      // Missing or empty private input fails with a content-free diagnostic and
      // no output. With an operator manifest it emits the safe aggregate
      // readiness report. Never reads raw keys/bytes, never shells out.
      "kaifuu:private-local-triage": {
        command: "node suite/scripts/kaifuu-private-local-triage/run.mjs",
        cache: false,
      },
      // the relevant capability: deterministic unit + integration tests (absent-input
      // failure + redacted aggregate + secret-leak rejection + schema validation).
      // Hermetic; no private corpora.
      "kaifuu:private-local-triage-test": {
        command: "node --test suite/scripts/kaifuu-private-local-triage/run.test.mjs",
        cache: false,
      },
      // the relevant capability: Siglus private-local redacted VALIDATION SUMMARY renderer.
      // Like the relevant capability this is a FIRST-CLASS LOCAL workflow that is
      // intentionally ABSENT from per-gate CI — no `just check`/`ci` lane and
      // no affected.mjs selection runs it. Missing or empty private input fails
      // with a content-free diagnostic and no output; with an operator validation
      // manifest it emits the safe aggregate validation summary
      // (capability-level / helper-outcome / status / failure bins + counts).
      // Never reads raw keys/Scene.pck bytes/decrypted text, never shells out.
      "siglus:private-local-validation-render": {
        command: "node suite/scripts/siglus-private-local-validation-renderer/run.mjs",
        cache: false,
      },
      // the relevant capability: deterministic unit + integration tests (absent-input
      // failure + redacted aggregate + per-category secret-leak rejection + schema
      // validation). Hermetic; no private corpora.
      "siglus:private-local-validation-render-test": {
        command:
          "node --test suite/scripts/siglus-private-local-validation-renderer/render.test.mjs",
        cache: false,
      },
      // the relevant capability: private-local key-hunting run workflow. Like the relevant capability and
      // the relevant capability this is a FIRST-CLASS LOCAL workflow, intentionally ABSENT
      // from per-gate CI — no `just check`/`ci` lane and no affected.mjs /
      // CI selection runs it. It PLANS the applicable helper attempts
      // per detected engine + capability (Siglus known-key / XP3 / MV-MZ / Wolf /
      // RGSS3 — plan, never brute-force), then aggregates operator-recorded
      // per-attempt outcomes into a redacted report. A CONFIRMED key is recorded ONLY as
      // a local-secret: ref + a sha256: proof hash; the report surfaces only the
      // key-profile id + proof hash. Missing or empty private input fails with a
      // content-free diagnostic and no output. Never reads raw keys/bytes, never shells out.
      "kaifuu:key-hunt": {
        command: "node suite/scripts/kaifuu-key-hunt/run.mjs",
        cache: false,
      },
      // the relevant capability: deterministic unit + integration tests (five outcome
      // categories + attempt planner by engine/capability + key-validation
      // ref-only schema + secret-leak rejection + absent-input failure + schema
      // validation). Hermetic; no private corpora, no Wine/Windows, no network.
      "kaifuu:key-hunt-test": {
        command: "node --test suite/scripts/kaifuu-key-hunt/key-hunt.test.mjs",
        cache: false,
      },
      // the relevant capability: alpha encrypted-readiness evidence INTEGRATION. Composes the
      // already-generated encrypted-readiness evidence of the prerequisite
      // slices (the relevant capability packed-engine readiness surface + the relevant capability
      // alpha-encrypted readiness evidence) into an alpha-readiness composed
      // -evidence artifact by content HASH — it never re-owns a prerequisite
      // slice. Like the relevant capability/067/094 it is a FIRST-CLASS LOCAL workflow,
      // intentionally ABSENT from per-gate CI. Missing or empty private input
      // fails with a content-free diagnostic and no output; with an operator
      // manifest it emits the safe aggregate report. A missing or tampered prerequisite is a
      // semantic diagnostic (status failed), never a hidden success. Never reads
      // raw keys/bytes, never shells out.
      "kaifuu:encrypted-readiness": {
        command: "node suite/scripts/kaifuu-encrypted-readiness-integration/run.mjs",
        cache: false,
      },
      // the relevant capability: deterministic unit + integration tests (absent-input
      // failure + prerequisite composition + boundary regression on a
      // tampered or missing prerequisite + secret-leak rejection +
      // schema validation). Hermetic; no private corpora.
      "kaifuu:encrypted-readiness-test": {
        command: "node --test suite/scripts/kaifuu-encrypted-readiness-integration/run.test.mjs",
        cache: false,
      },
    },
  },
});
