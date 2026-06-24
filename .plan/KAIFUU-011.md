# KAIFUU-011 — Binary patcher composed smoke command — Implementation Plan

| Field           | Value                                        |
| --------------- | -------------------------------------------- |
| DAG node        | `KAIFUU-011`                                 |
| Title           | Binary patcher composed smoke command         |
| Branch          | `spec/kaifuu-011`                            |
| Worktree        | `/scratch/worktrees/itotori-spec-kaifuu-011` |
| Plan author     | planning worker (orchestrator)               |
| Plan date       | 2026-06-23                                   |
| Output file     | `.plan/KAIFUU-011.md` (this file)            |
| Plan-only slice | No feature code lands from this plan.        |

---

## 0. Evidence Map (what already exists, what must change)

| Surface | State today | Change demanded by KAIFUU-011 |
| ------- | ----------- | ------------------------------ |
| `crates/kaifuu-cli/src/main.rs` (`run_with_args_and_registry`) | Dispatches a fixed set of subcommands (`detect`, `extract`, `patch`, `verify`, `apply-patch`, `validate-fixture-key`, …). `patch` calls the registry's `patch_preflight` + `patch` and writes a `patch-result.json`. There is no end-to-end composed smoke command. | Add a new `binary-patch-smoke` subcommand that drives KAIFUU-084's `PatchTransaction` over a synthetic fixture and emits a `PatchResult v0.2` JSON. The smoke command exercises preflight + stage + verify + promote in one transaction and supports an injected failure mode for the rollback path. |
| `crates/kaifuu-core/src/patch_transaction.rs` (KAIFUU-084) | Provides `PatchTransaction`, `PatchTransactionConfig`, `PatchTransactionOutcome` (`patch_result_v02: serde_json::Value` + `legacy_patch_result`). Length-preserving identity-only relocation. Emits the v0.2 contract via `build_patch_result_v02`. | KAIFUU-011 is the **first** consumer. The smoke command constructs the config, drives the state machine, and persists the v0.2 outcome. No change to `patch_transaction.rs`. |
| `crates/kaifuu-reallive/src/patchback.rs` (KAIFUU-174) | `apply_patches(archive_bytes, scene_index, scenes, edits) -> Result<Vec<u8>, PatchBackError>`. In-memory transform. `PatchBackErrorCode` mapping to v0.2 `PatchFailureCategoryV02` is documented in KAIFUU-010 §6 / KAIFUU-084 §6. | KAIFUU-011 is the **first** consumer of the mapping. The smoke command runs `apply_patches` against a synthetic SEEN.TXT fixture, computes `expected_output_hash`, and threads the result through the transaction harness. On injected failure, the smoke maps `PatchBackErrorCode` to the v0.2 category via the mapping table and emits a `PatchResult v0.2 Fail`. |
| `packages/localization-bridge-schema/src/index.ts` `assertPatchResultV02` (KAIFUU-010) | Validates v0.2 shape: structured failures, failure-category enum, partial-write accounting, output-hash rollup. | The smoke command's emitted JSON must pass `assertPatchResultV02` (TS-side validator) and `validate_patch_result_v02` (Rust-side validator). The Rust validator is the in-binary check; the TS validator runs as a Node-side fixture test. |
| `crates/kaifuu-engine-fixture/src/lib.rs` (reference adapter) | Fixture engine exposing `patch_preflight` / `patch` / `verify`. Used as the test consumer for KAIFUU-084 happy-path. | The smoke command uses the **kaifuu-reallive synthetic fixture** (not the engine-fixture adapter) because the audit demands the smoke composes the RealLive patchback path. The engine-fixture adapter remains the unit-test sandbox for `patch_transaction.rs`; the smoke is the integration consumer for RealLive. |
| Test fixtures | KAIFUU-173 ships `crates/kaifuu-reallive/tests/fixtures/patchback-length-preserving-001/` (SEEN.TXT, `patch/patch-export.json`, `expected/patched.SEEN.TXT`) and KAIFUU-174 ships `patchback-overflow-001/` (overflow diagnostics). | KAIFUU-011 reuses the existing patchback fixtures and additionally commits **one new composed smoke fixture** at `crates/kaifuu-cli/tests/fixtures/binary-patch-smoke/` containing `SEEN.TXT` (12 bytes), `patch/patch-export.json`, and `expected/patch-result.json`. The fixture is intentionally tiny to keep the smoke deterministic and Linux/macOS byte-equal. |
| `apps/itotori/test/ingest-patch-result.test.ts` (KAIFUU-010 §5.5) | Itotori ingestion path validates the v0.2 shape. | Out of scope — KAIFUU-011 emits the shape; ingestion is downstream. The smoke does NOT call the Itotori path. |

The plan that follows is strictly bounded by these rows.

---

## 1. Module placement

**Decision: extend `crates/kaifuu-cli/`** with the new subcommand
plus a focused submodule. No new workspace member.

```
crates/kaifuu-cli/
  Cargo.toml                     # ADD path deps on kaifuu-reallive,
                                 #   kaifuu-core (already), serde_json
                                 #   (already via kaifuu-core re-export).
                                 #   serde_json is a transitive dep;
                                 #   no new direct dep.
  src/
    main.rs                      # dispatch arm `"binary-patch-smoke"`
                                 #   + helper `run_binary_patch_smoke`
    binary_patch_smoke.rs        # NEW — composed smoke entry point.
                                 #   Orchestrates apply_patches +
                                 #   PatchTransaction + result write.
  tests/
    fixtures/
      binary-patch-smoke/
        positive/
          SEEN.TXT                 # 12-byte synthetic length-preserving fixture
          patch/
            patch-export.json      # one SlotEdit, length-preserving
          expected/
            patch-result.json      # v0.2 Passed shape (golden compare)
        preflight-fail/
          SEEN.TXT                 # same 12-byte fixture
          patch/
            patch-export.json      # SlotEdit length > byte budget OR wrong source hash
          expected/
            patch-result.json      # v0.2 Failed shape; category =
                                   #   patch_write_failed (byte_budget) or
                                   #   source_incompatible
        verify-fail/
          SEEN.TXT                 # same fixture
          patch/
            patch-export.json      # injected expected_output_hash mismatch
          expected/
            patch-result.json      # v0.2 Failed shape; category =
                                   #   output_hash_mismatch; rollback diagnostic
    binary_patch_smoke.rs        # NEW — integration tests
```

Justification:

- `kaifuu-cli` already owns CLI dispatch and `PatchExport` reading
  (`read_json` / `write_json`). The smoke command adds one arm and
  one helper module — no cross-crate API change.
- The smoke command is intentionally a CLI subcommand (not a unit
  test inside `kaifuu-core`) because the headline audit defense is
  that the smoke "composes the patcher end-to-end" — exposing it as
  a CLI command makes the composition reproducible by hand and by
  CI.
- The composed smoke does NOT extend `EngineAdapter`. Engine-port
  adoption of `PatchTransaction` (RealLive's `patch` impl) is a
  follow-up; KAIFUU-011 is the consumer-level smoke that proves the
  three slices compose.
- `Cargo.toml`: `kaifuu-cli` does not have a direct dep on
  `kaifuu-reallive` today. Add one (path dep). No third-party dep
  change.

---

## 2. Public CLI surface

### 2.1 Subcommand shape

```
kaifuu binary-patch-smoke \
  --fixture <fixture-dir> \
  --output  <output-dir> \
  [--inject-failure <mode>] \
  [--run-id <run-id>]
```

Arguments:

- `--fixture <fixture-dir>` (required): a directory matching the
  layout under `tests/fixtures/binary-patch-smoke/positive/`
  (`SEEN.TXT` + `patch/patch-export.json`). Absolute path.
- `--output <output-dir>` (required): a directory the harness owns.
  The smoke writes `output/SEEN.TXT` (the patched bytes) and
  `output/patch-result.json` (the v0.2 contract artifact). The
  harness creates a `.staging/` subdirectory there (per KAIFUU-084
  §5).
- `--inject-failure <mode>` (optional, test-only): one of `none`
  (default), `preflight-byte-budget`, `preflight-source-hash`, or
  `verify-hash-mismatch`. When omitted, the smoke runs the
  positive path.
- `--run-id <run-id>` (optional): defaults to a deterministic
  `binary-patch-smoke-0001` so reruns of the same fixture produce
  identical outputs. Used in the staging filename.

Exit codes:

- `0` — positive run; `patch-result.json` has `status: "passed"`.
- `1` — injected failure surfaced as a v0.2 `failed` outcome (the
  smoke command still writes `patch-result.json` and returns 1 so
  CI can distinguish "ran" vs "didn't run").
- `2` — preflight rejected fixture before any state machine
  transitions (malformed `patch-export.json`, missing `SEEN.TXT`,
  etc.).

### 2.2 No new flags on existing subcommands

`patch`, `extract`, `verify` remain unchanged. The smoke command is
additive; existing flows are untouched.

---

## 3. Composed flow (`run_binary_patch_smoke`)

The flow in `binary_patch_smoke.rs` composes the three slices in
the order their audit defenses require:

```
Step 1: Read fixture
  ├── Load patch_export.json (PatchExport v0.1 shape — existing).
  └── Read SEEN.TXT bytes.

Step 2: Run kaifuu-reallive (KAIFUU-174)
  ├── parse_archive(SEEN.TXT bytes) → SceneIndex
  ├── parse_scene per index entry → Vec<Scene>
  ├── Build Vec<SlotEdit> from PatchExport entries (1:1 mapping;
  │     the smoke fixture's patch_export.json mirrors what a real
  │     Itotori export would emit).
  └── apply_patches(archive_bytes, scene_index, scenes, &edits)
        → Result<Vec<u8>, PatchBackError>

  On PatchBackError:
    Map PatchBackErrorCode -> PatchFailureCategoryV02 via the
    KAIFUU-010 §6 / KAIFUU-084 §6 table (Step 5 emit).

Step 3: Apply --inject-failure (test seam)
  ├── preflight-byte-budget: artificially set byte_budget = 1.
  ├── preflight-source-hash: artificially poison
  │     expected_source_hash to a deterministic wrong value.
  ├── verify-hash-mismatch: flip one byte in the patched buffer
  │     before passing to stage(), so verify hashes mismatch.
  └── none: pass through.

Step 4: Drive PatchTransaction (KAIFUU-084)
  Construct PatchTransactionConfig with:
    adapter_id            = "kaifuu-reallive"
    patch_export_id       = patch_export.patch_export_id
    bridge_unit_id        = patch_export.entries[0].bridge_unit_id
    asset_id              = patch_export.entries[0].asset_id
    output_path           = <output>/SEEN.TXT
    expected_source_hash  = sha256:<sha256(SEEN.TXT bytes)>
    expected_output_hash  = sha256:<sha256(apply_patches result)>
    byte_budget           = apply_patches result.len() as u64
    expected_payload_len  = apply_patches result.len() as u64
    required_transforms   = ["bytecode_decompile",
                              "shift_jis_text",
                              "recompile_bytecode"]
    adapter_capabilities  = synthesized via
                              kaifuu_engine_fixture::reallive_capabilities()
                              (or a thin equivalent built locally if the
                              engine-fixture export is not available;
                              the worker picks the available constructor)
    command               = "patch.write_string_slot"
    run_id                = --run-id flag default
                              "binary-patch-smoke-0001"

  Pre-create <output>/SEEN.TXT by copying the source SEEN.TXT bytes
  (the harness reads this back as the "source bytes" during
  preflight).

  Drive the state machine:
    1. transaction.run_preflight()
    2. if Idle/Preflight -> ok: transaction.stage(&patched_bytes)
    3. transaction.verify()
    4. transaction.promote()
  After each step, if state is *Failed/Cancelled, break and call
  transaction.into_outcome().

Step 5: Emit PatchResult v0.2
  ├── outcome = transaction.into_outcome()
  ├── If Step 2 produced a PatchBackError (i.e. the smoke never
  │   reached Step 4), build a v0.2 Fail JSON directly from the
  │   mapping table (failures[0].category resolved, diagnosticCode
  │   from PatchBackErrorCode, partialWrite disposition =
  │   "rolled_back" because no bytes were written).
  ├── Else use outcome.patch_result_v02 verbatim.
  ├── Validate via contracts::validate_patch_result_v02(&value)
  │   (debug_assertions catches drift; release also re-runs the
  │   validator and exits 2 if it disagrees — defends against a
  │   contract regression).
  └── Write <output>/patch-result.json via write_json (sorted-key
      deterministic emission).
```

The composition is one synchronous function with no I/O outside
the `<output>` directory. No threads, no async, no network.

### 3.1 PatchBackError mapping

The mapping table is materialised as a private function
`map_patchback_error_to_v02_failure(error: &PatchBackError) ->
serde_json::Value` in `binary_patch_smoke.rs`. The mapping is the
KAIFUU-010 §6 / KAIFUU-084 §6 table verbatim:

| `PatchBackErrorCode`      | v0.2 `category`            | `diagnosticCode`                                      |
| ------------------------- | -------------------------- | ----------------------------------------------------- |
| `OffsetOverflow`          | `patch_write_failed`       | `kaifuu.reallive.patchback_offset_overflow`           |
| `ShiftJisEncodeFailure`   | `patch_write_failed`       | `kaifuu.reallive.patchback_shift_jis_encode_failure`  |
| `UnsupportedLengthPolicy` | `adapter_unsupported`      | `kaifuu.reallive.patchback_unsupported_length_policy` |
| `ParserRegression`        | `patch_write_failed`       | `kaifuu.reallive.patchback_parser_regression`         |
| `UnknownSlotId`           | `asset_missing`            | `kaifuu.reallive.patchback_unknown_slot_id`           |
| `StaleSourceHash`         | `source_incompatible`      | `kaifuu.reallive.patchback_stale_source_hash`         |
| `ProtectedSpanLost`       | `protected_span_violation` | `kaifuu.reallive.patchback_protected_span_lost`       |

A unit test in `binary_patch_smoke.rs` (`#[cfg(test)] mod tests`)
asserts every `PatchBackErrorCode` variant has a mapping (exhaustive
`match` over the enum).

---

## 4. Synthetic fixture content

### 4.1 `positive/`

- `SEEN.TXT`: 12 bytes, a minimal RealLive Scene/SEEN envelope with
  one string slot containing `b"Hello"`. The exact byte layout
  follows KAIFUU-173's archive shape — the worker builds the
  fixture by emitting a minimal valid Scene through the existing
  `kaifuu-reallive` writer (or by hand-rolling a 12-byte header
  + one slot, since KAIFUU-173 already ships hand-rolled tiny
  Scene fixtures in `bridge-inventory-001`).
- `patch/patch-export.json`: a `PatchExport` v0.1 record with one
  entry mapping `slot-0` → `b"Hi!!!"` (5 bytes — same length as
  `Hello`). Includes `patch_export_id`, the matching
  `asset_id` / `bridge_unit_id`, and a stable
  `provenance.exported_at` label (`"binary-patch-smoke-fixture"`).
- `expected/patch-result.json`: the v0.2 `passed` shape with:
  - `schemaVersion: "0.2"` (matches `BRIDGE_SCHEMA_VERSION_V02`).
  - `status: "passed"`.
  - `adapterId: "kaifuu-reallive"`.
  - `touchedAssets: [{ assetId, outputHash, byteSize: 12 }]`.
  - `outputHash: <rollup over touchedAssets>` per KAIFUU-010 §3.3.
  - `failures: []`, no `failureCategories`, no `partialWrite`.
  - `patchResultId` is a deterministic uuid7 derived from
    `(asset_id, run_id, "promoted")` — KAIFUU-084 §7 already
    documents this convention. The fixture commits the literal
    value so the golden compare is byte-exact.

### 4.2 `preflight-fail/`

Identical inputs as `positive/`. `--inject-failure
preflight-byte-budget` triggers the byte-budget rejection:
`patch-result.json` carries `status: "failed"`, one failure with
`category: "patch_write_failed"` and `diagnosticCode:
"kaifuu.patch_transaction.byte_budget_exceeded"`,
`partialWrite.disposition: "rolled_back"`, `writtenAssetIds: []`,
`attemptedAssetIds: [asset_id]`, `skippedAssetIds: [asset_id]`.

A sibling `preflight-source-hash/` (under the same parent) is
optional — the worker may include it if budget allows; the
verification matrix in §5 lists three required modes and one
optional.

### 4.3 `verify-fail/`

Identical inputs. `--inject-failure verify-hash-mismatch` mutates
the staged buffer's last byte before calling
`transaction.stage(&patched_bytes)`. The hash mismatch trips
`verify()` → state `VerifyFailed`. `patch-result.json` carries:
- `status: "failed"`.
- `failures[0].category: "output_hash_mismatch"`.
- `failures[0].diagnosticCode:
  "kaifuu.patch_result.output_hash_drift"`.
- `partialWrite.disposition: "rolled_back"`.
- `partialWrite.rollbackDiagnosticCode:
  "kaifuu.patch_transaction.staged_verify_rolled_back"`.
- Output file `<output>/SEEN.TXT` exists and equals the **source**
  bytes (rollback preserves the original).
- Staging file `<output>/.staging/<asset>-<run>.tmp` is absent
  (rollback deleted it).

### 4.4 Determinism rules

- Every byte in committed fixtures is ASCII or low-range CP932 to
  avoid locale-dependent serializer drift.
- `apply_patches` output bytes are deterministic given the input
  (KAIFUU-174 is a pure function).
- `patch-result.json` round-trips through `serde_json` with
  sorted-key emission via `kaifuu_core::write_json`. The golden
  compare uses byte equality (not semantic equality), matching the
  KAIFUU-084 §8.1 posture.
- The `patchResultId` uuid7 is deterministic (KAIFUU-084 §7
  `deterministic_id`), so reruns produce the same value.
- `generatedAt` / `created_at` style fields are NOT emitted by the
  v0.2 contract (the schema has no such field on PatchResult); the
  golden compare is therefore time-independent.

---

## 5. Test plan

### 5.1 Integration tests
(`crates/kaifuu-cli/tests/binary_patch_smoke.rs`)

Each test runs the CLI in-process (via `run_with_args_and_registry`
or a thin equivalent) and golden-compares the emitted
`patch-result.json` against the committed expected file.

1. `positive_smoke_produces_passed_v02_with_output_hash()`
   - Runs `binary-patch-smoke --fixture
positive/ --output <tempdir>`.
   - Asserts exit code 0.
   - Asserts `<tempdir>/SEEN.TXT` byte-equals the
     `apply_patches` result.
   - Asserts `<tempdir>/patch-result.json` byte-equals
     `positive/expected/patch-result.json`.
   - Asserts the v0.2 JSON validates against
     `contracts::validate_patch_result_v02`.

2. `preflight_byte_budget_failure_produces_v02_failed_with_category()`
   - Runs `binary-patch-smoke --fixture positive/ --output <tempdir>
--inject-failure preflight-byte-budget`.
   - Asserts exit code 1.
   - Asserts no `<tempdir>/SEEN.TXT` write occurred OR the file
     equals the source bytes (no patched bytes were promoted).
   - Asserts `<tempdir>/patch-result.json` has `status: "failed"`,
     `failures[0].category == "patch_write_failed"`,
     `failures[0].diagnosticCode` ends in
     `"byte_budget_exceeded"`.
   - Golden-compares against
     `preflight-fail/expected/patch-result.json`.
   - Asserts the JSON validates against
     `validate_patch_result_v02`.

3. `verify_hash_mismatch_rolls_back_and_emits_v02_failed()`
   - Runs `binary-patch-smoke --fixture positive/ --output <tempdir>
--inject-failure verify-hash-mismatch`.
   - Asserts exit code 1.
   - Asserts `<tempdir>/SEEN.TXT` equals the **source** bytes
     (rollback preserved the original).
   - Asserts `<tempdir>/.staging` directory contains no `.tmp` file
     (rollback cleaned up).
   - Asserts `failures[0].category == "output_hash_mismatch"`,
     `failures[0].diagnosticCode == "kaifuu.patch_result.output_hash_drift"`,
     `partialWrite.disposition == "rolled_back"`,
     `partialWrite.rollbackDiagnosticCode ==
"kaifuu.patch_transaction.staged_verify_rolled_back"`.
   - Golden-compares against
     `verify-fail/expected/patch-result.json`.
   - Asserts the JSON validates against
     `validate_patch_result_v02`.

4. `positive_smoke_byte_stable_across_two_runs()`
   - Runs the positive smoke twice with the same fixture + run-id
     into different tempdirs.
   - Asserts both `patch-result.json` files are byte-equal.
   - This is the determinism gate; catches any accidental
     non-deterministic emission (timestamps, hashmap iteration,
     etc.).

5. `patchback_error_mapping_table_is_exhaustive()`
   - Unit-level test (in `binary_patch_smoke.rs` `#[cfg(test)] mod
tests`). Constructs every `PatchBackErrorCode` variant via
     synthetic `PatchBackError` instances, calls
     `map_patchback_error_to_v02_failure`, asserts the returned
     `category` is in `PATCH_FAILURE_CATEGORIES_V02` and
     `diagnosticCode` matches the table.
   - Uses an exhaustive `match` over `PatchBackErrorCode` so a
     future variant addition fails compilation here loudly.

### 5.2 TS-side validation test
(`packages/localization-bridge-schema/test/binary-patch-smoke.test.ts`)

- Loads `positive/expected/patch-result.json` and asserts
  `assertPatchResultV02(...)` passes cleanly.
- Loads `preflight-fail/expected/patch-result.json` and
  `verify-fail/expected/patch-result.json` and asserts they ALSO
  pass `assertPatchResultV02` (failed-status reports are still
  valid v0.2 documents).
- Asserts each fixture has the expected
  `failureCategories` shape derived from `failures[*].category`.

This proves the smoke command's emitted JSON survives both the
Rust and the TS validators.

### 5.3 Verification matrix

| Mode                       | Exit | `status`            | Output bytes      | Staging       |
| -------------------------- | ---- | ------------------- | ----------------- | ------------- |
| positive                   | 0    | `passed`            | patched           | clean         |
| preflight-byte-budget      | 1    | `failed`            | source-preserved  | not created   |
| preflight-source-hash *opt*| 1    | `failed`            | source-preserved  | not created   |
| verify-hash-mismatch       | 1    | `failed`            | source-preserved  | cleaned up    |

`preflight-source-hash` is optional — the worker may add it for
parity with the KAIFUU-084 §8.3 unit test. The hard requirement is
the three rows marked above.

---

## 6. PatchExport input shape

The smoke command consumes a `PatchExport` v0.1 record (the
existing shape `kaifuu_core::PatchExport` uses). The fixture's
`patch/patch-export.json` includes:

```json
{
  "schemaVersion": "0.1",
  "patchExportId": "019ed011-0000-7000-8000-000000000001",
  "exportedAt": "binary-patch-smoke-fixture",
  "adapterId": "kaifuu-reallive",
  "entries": [
    {
      "patchExportEntryId": "019ed011-0000-7000-8000-000000000002",
      "assetId": "019ed011-0000-7000-8000-000000000010",
      "bridgeUnitId": "019ed011-0000-7000-8000-000000000020",
      "slotId": "scene-0000:str-off-00000010-idx00",
      "sourceHash": "sha256:<32-hex>",
      "patchedBytes": "Hi!!!"
    }
  ]
}
```

No new fields on `PatchExport`; the smoke uses the existing shape
verbatim. This avoids any schema-version coupling between
KAIFUU-011 and the v0.2 patch export effort that lives in a
separate node.

---

## 7. Engine-fixture adapter is NOT the smoke consumer

KAIFUU-084 §6 / §8 used the engine-fixture adapter as the unit
test consumer. KAIFUU-011 deliberately picks `kaifuu-reallive` as
the smoke consumer:

- The audit-focus item "smoke skips real patching" is structurally
  defeated when the smoke runs `apply_patches` — the real RealLive
  patchback function — over a real Scene/SEEN envelope.
- The audit-focus item "PatchResult shape drift" is defended by the
  Rust + TS v0.2 validators (§5.1 + §5.2).
- The audit-focus item "transaction state not exercised" is
  defended by the verify-fail test, which forces the harness from
  `Staged` through `VerifyFailed` and asserts the rollback contract
  end-to-end.

The engine-fixture adapter remains the lower-level unit-test
sandbox; the binary-patcher smoke is the integration consumer.

---

## 8. Semantic codes referenced

This slice adds **zero** new semantic codes. The smoke command
re-uses existing constants:

- `kaifuu.reallive.patchback_*` (KAIFUU-174's `PatchBackErrorCode`
  diagnostics).
- `kaifuu.patch_transaction.*` (KAIFUU-084's harness codes).
- `kaifuu.patch_result.*` (KAIFUU-010's v0.2 contract codes).

The smoke is purely a consumer; no new vocabulary lands.

---

## 9. Verification commands

```bash
cargo test -p kaifuu-cli binary_patch_smoke          # §5.1
cargo test -p kaifuu-cli                              # full crate
cargo test -p kaifuu-core                             # no regression
cargo test -p kaifuu-reallive                         # no regression
pnpm exec vp run ts:test -- packages/localization-bridge-schema   # §5.2
just check                                            # lint + types
just test                                             # full sweep
```

The smoke command is also reachable by hand:

```
cargo run -p kaifuu-cli -- binary-patch-smoke \
  --fixture crates/kaifuu-cli/tests/fixtures/binary-patch-smoke/positive \
  --output /tmp/kaifuu-smoke
diff <(jq -S . /tmp/kaifuu-smoke/patch-result.json) \
     <(jq -S . crates/kaifuu-cli/tests/fixtures/binary-patch-smoke/positive/expected/patch-result.json)
```

---

## 10. Risks

1. **Hash determinism across platforms.** SEEN.TXT bytes are
   byte-literal ASCII; `apply_patches` output bytes are
   deterministic; sha256 is deterministic. Risk: a future
   `apply_patches` change rotates the output hash. Mitigation:
   the golden compare is byte-equality, so any drift fails CI
   loudly; updating the fixture is a known maintenance cost (the
   KAIFUU-084 §11.5 risk register already records the same
   concern).
2. **`patchResultId` determinism.** KAIFUU-084 §7 commits to
   deterministic uuid7 generation. Risk: a refactor of
   `deterministic_id` changes the value. Mitigation: the golden
   fixture commits the literal uuid; any drift fails the
   byte-compare. The KAIFUU-084 plan reserves this generator as
   non-public, so external changes are bounded.
3. **PatchBackError mapping table drift.** The mapping is
   manually maintained in three places (KAIFUU-010 §6, KAIFUU-084
   §6, this slice's `map_patchback_error_to_v02_failure`).
   Mitigation: the exhaustive-match test (§5.1 case 5) ensures
   future variants of `PatchBackErrorCode` fail compilation here
   until the mapping is updated; reviewers must keep the three
   call sites in sync.
4. **Engine-fixture vs RealLive divergence.** KAIFUU-084's unit
   tests use the engine-fixture adapter; this slice uses
   RealLive. Risk: a RealLive-specific bug surfaces only in the
   smoke. That is the intended behavior — the smoke is the first
   real consumer; bugs surfaced here are KAIFUU-174 follow-ups,
   not KAIFUU-011 blockers (the smoke records the bug as a v0.2
   `Failed` result with a category; the test asserts the harness
   handles the case, not that RealLive is bug-free).
5. **Atomic-rename portability.** KAIFUU-084 §11.1 documents
   POSIX guarantees. Risk: Windows CI flakes. Mitigation: same
   as KAIFUU-084 — Linux CI today, documented elsewhere.
6. **Test-only `--inject-failure` flag.** Concern: a production
   build exposes a test seam. Mitigation: the flag is documented
   as test-only in `--help`; the helper module is `#[cfg(any(test,
   feature = "test-injection"))]` gated, with the CLI dispatch
   arm only compiling the flag handling when the feature is on.
   The integration tests enable the feature; production builds do
   not. (Alternative: gate the flag on a `KAIFUU_SMOKE_INJECT=1`
   env var so the flag exists but is ignored without the env;
   the worker picks the lower-friction implementation.)
7. **v0.2 contract regression at runtime.** Step 5 re-runs
   `validate_patch_result_v02` in both debug and release builds
   so a contract bug in `build_patch_result_v02` fails the smoke
   loudly rather than corrupting the artifact silently. Cost: a
   millisecond per smoke invocation; benefit: catches drift the
   debug-only assertion misses.

---

## 11. Out of scope

- **RealLive `EngineAdapter::patch` adoption of the harness.** The
  smoke is a CLI consumer; the trait-method migration is a
  follow-up.
- **Itotori `ingest-patch-result` integration.** KAIFUU-010 §5
  handles ingestion; the smoke does not call the Itotori path.
- **Non-RealLive engine smokes** (Xp3, Siglus). One smoke covers
  the audit-focus claim; engine-specific smokes are future nodes.
- **Live game fixtures.** The smoke is synthetic-only by design.
- **Length-changing patches.** KAIFUU-084 §3.1 step 4 rejects
  non-identity relocation; the smoke fixture is length-preserving.
- **Concurrency stress.** One transaction at a time; the smoke
  uses a deterministic `run_id` so reruns don't collide.
- **Cross-platform CI.** Linux only.
- **Performance benchmarks.** The smoke is correctness-only.
- **`PatchExport` v0.2.** This slice consumes v0.1 input.

---

## 12. Worker scoping

**One worker, single Rust slice with a small TS test addendum.**

| Slice            | Surfaces                                                                                                                                                                                                                                                                                                              | Effort |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **A (Rust CLI)** | `crates/kaifuu-cli/src/main.rs` (one new dispatch arm), `crates/kaifuu-cli/src/binary_patch_smoke.rs` (new module, ~300 LOC), `crates/kaifuu-cli/Cargo.toml` (path dep on `kaifuu-reallive`), `crates/kaifuu-cli/tests/binary_patch_smoke.rs` (~200 LOC), 3 fixture directories (~1 KB total), engine-fixture-style capability constructor reuse. | ~1 day |
| **B (TS test)**  | `packages/localization-bridge-schema/test/binary-patch-smoke.test.ts` (~60 LOC) that loads the three fixtures and validates them via `assertPatchResultV02`.                                                                                                                                                          | ~½ day |

**Recommendation: one worker** runs A → B in sequence. The slice
boundary is the v0.2 JSON contract; A produces the JSON, B
validates it. Splitting would force B to mock a JSON that A
hasn't committed yet.

If parallelism is forced, A must merge before B starts.

---

## 13. Process

1. Implement `binary_patch_smoke.rs` per §3.
2. Add the CLI dispatch arm in `main.rs` per §2.
3. Add the path dep on `kaifuu-reallive` in `kaifuu-cli/Cargo.toml`.
4. Commit the three fixture directories per §4.
5. Write the Rust integration tests per §5.1.
6. Write the TS validation test per §5.2.
7. Run §9 verification commands top-to-bottom.
8. Commit per repo conventions (one `feat(KAIFUU-011):` commit
   for the Rust side, one `test(KAIFUU-011):` commit for the TS
   side, plus a fixture-only commit if reviewers prefer that
   shape).

End of plan.
