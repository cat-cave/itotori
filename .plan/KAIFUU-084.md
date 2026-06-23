# KAIFUU-084 — Binary patch rollback and no-write preflight harness — Implementation Plan

| Field           | Value                                                |
| --------------- | ---------------------------------------------------- |
| DAG node        | `KAIFUU-084`                                         |
| Title           | Binary patch rollback and no-write preflight harness |
| Branch          | `spec/kaifuu-084`                                    |
| Worktree        | `/scratch/worktrees/itotori-spec-kaifuu-084`         |
| Plan author     | planning worker (orchestrator-spawned)               |
| Plan date       | 2026-06-23                                           |
| Output file     | `.plan/KAIFUU-084.md` (this file)                    |
| Plan-only slice | No feature code lands from this plan.                |

---

## 0. Evidence Map

| Surface                                                                                                           | State today                                                                                                                                                                                                                                                                                                    | KAIFUU-084 change                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/kaifuu-core/src/lib.rs` `EngineAdapter::patch_preflight` (line 162) and `EngineAdapter::patch` (line 165) | Two-stage hook exists: `patch_preflight` defaults to `PatchResult::preflight_pass(...)` and `patch` does the writes. No shared harness enforces "preflight first / no irreversible write on fail." Each adapter is on its own honor system.                                                                    | Add a shared engine-neutral transaction harness in a new submodule `patch_transaction` that drives both stages, runs all five preflight checks, then stages-verifies-promotes, with deterministic rollback. The trait surface is **unchanged**; adapters opt into the harness by calling it from inside `patch`. |
| `crates/kaifuu-core/src/lib.rs` `PatchResult` (line 13281)                                                        | v0.1 in-Rust shape with `schema_version`, `patch_result_id`, `patch_export_id`, `status` (`Passed`/`Failed`), `output_hash`, `failures: Vec<AdapterFailure>`. **Not** v0.2; v0.2 is the JSON contract validated in `contracts.rs`.                                                                             | The harness emits a v0.2-shaped JSON `serde_json::Value` alongside the existing `PatchResult` (which legacy callers keep using). v0.2 emission is the canonical KAIFUU-010 contract. No in-Rust struct renaming — the harness produces JSON validated by `validate_patch_result_v02`.                            |
| `crates/kaifuu-core/src/contracts.rs` `PATCH_FAILURE_CATEGORIES_V02` (line 71)                                    | Six categories: `source_incompatible`, `patch_write_failed`, `protected_span_violation`, `asset_missing`, `adapter_unsupported`, `output_hash_mismatch`.                                                                                                                                                       | Harness chooses category per failure point — table in §3.4.                                                                                                                                                                                                                                                      |
| `crates/kaifuu-core/src/contracts.rs` `PATCH_PARTIAL_WRITE_DISPOSITIONS_V02` (line 80)                            | `rolled_back`, `cleaned_up`, `retained_partial`.                                                                                                                                                                                                                                                               | Harness disposition: every harness failure emits `partialWrite` with `disposition: "rolled_back"` (preflight, verify, promote) or `cleaned_up` (cancellation). `retained_partial` is **never** emitted by this harness — it stays available for adapter-specific paths that bypass the harness.                  |
| `crates/kaifuu-reallive/src/patchback.rs` `apply_patches` (line 137)                                              | Length-preserving in-memory transform: takes `archive_bytes: &[u8]`, returns `Result<Vec<u8>, PatchBackError>`. Does the byte transform but does not write to disk; no staging, no rollback (in-memory only). Failure modes already emit typed `PatchBackErrorCode` values (mapping table from KAIFUU-010 §6). | KAIFUU-084 does **not** rewrite `apply_patches`. It exposes a `PatchTransaction` API that a caller (KAIFUU-011 or RealLive `patch` impl) wraps around `apply_patches`. The harness handles the write-to-disk, staging, and rollback; `apply_patches` stays in-memory and engine-specific.                        |
| `crates/kaifuu-engine-fixture/src/lib.rs`                                                                         | Reference adapter (single-file). Has its own `patch` flow that writes a synthesized output, currently without staged-write isolation.                                                                                                                                                                          | The harness is a `pub` module on `kaifuu-core`; fixture adapter is the **first integration test consumer** (positive happy path + simulated rename failure).                                                                                                                                                     |
| `docs/subprojects-kaifuu.md`, `docs/testing-standard.md`                                                          | Document v0.2 patch result and golden flow.                                                                                                                                                                                                                                                                    | Append a short subsection in `docs/subprojects-kaifuu.md` describing the transaction state machine, staging path, and rollback rules so future engines find the harness via docs. `docs/testing-standard.md` unchanged.                                                                                          |

The plan below is bounded by these rows.

---

## 1. Module Placement

New submodule `crates/kaifuu-core/src/patch_transaction.rs`, declared from `lib.rs`:

```rust
pub mod patch_transaction;
pub use patch_transaction::{
    PatchTransaction, PatchTransactionConfig, PatchTransactionOutcome,
    PreflightCheck, PreflightReport, StagedPatchPayload, TransactionState,
    TransactionFailureCategory, TransactionDiagnostic,
};
```

Why a sibling module, not part of `lib.rs`:

- `lib.rs` is already 23 k lines; adding the harness inline would make code review impossible.
- The harness uses `std::fs` and `std::path::Path` extensively. Keeping it in one file means future cross-platform tweaks (Windows atomic rename) are one PR.
- `contracts.rs` validates JSON; `patch_transaction.rs` **emits** JSON. They are sibling modules, not nested.

`Cargo.toml` dependency additions: none for production code. Tests use `tempfile.workspace = true` (already in workspace; add to `[dev-dependencies]` of `kaifuu-core`).

---

## 2. Public API surface

### 2.1 `PatchTransaction`

```rust
/// Engine-neutral binary patch transaction harness.
///
/// Drives preflight → stage → verify → promote with deterministic
/// rollback. The harness never modifies the final output path until
/// every preflight check passes and the staged bytes verify.
pub struct PatchTransaction<'a> {
    config: PatchTransactionConfig<'a>,
    state: TransactionState,
    staged_path: Option<PathBuf>,
    diagnostics: Vec<TransactionDiagnostic>,
}
```

### 2.2 `PatchTransactionConfig`

```rust
pub struct PatchTransactionConfig<'a> {
    /// Engine adapter id, e.g. "kaifuu-reallive".
    pub adapter_id: &'a str,
    /// Patch export id (uuid7) — propagates into the v0.2 PatchResult.
    pub patch_export_id: &'a str,
    /// Bridge unit id for the asset being patched.
    pub bridge_unit_id: &'a str,
    /// Asset id (uuid7).
    pub asset_id: &'a str,
    /// Final destination for the patched bytes.
    pub output_path: &'a Path,
    /// Expected sha256 of the **source** bytes at the same path (pre-patch).
    pub expected_source_hash: &'a str,
    /// Expected sha256 of the **output** bytes after the patch. Computed
    /// from the patch plan by the caller (e.g. via `apply_patches` over
    /// the source bytes in memory).
    pub expected_output_hash: &'a str,
    /// Per-asset write budget in bytes. Staged bytes that exceed this are
    /// rejected at preflight.
    pub byte_budget: u64,
    /// Adapter-declared layered transforms required for this patch.
    /// The harness asserts every entry is present in
    /// `adapter_capabilities.access_contract.surfaces[*].transforms[*].transform_id`.
    pub required_transforms: &'a [&'a str],
    /// Adapter capabilities, looked up against `required_transforms`.
    pub adapter_capabilities: &'a AdapterCapabilities,
    /// Semantic command name, e.g. "patch.write_string_slot".
    pub command: &'a str,
    /// Run id — included in the staging filename to allow concurrent runs.
    pub run_id: &'a str,
}
```

### 2.3 `TransactionState`

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionState {
    Idle,
    Preflight,
    Staged,
    Verified,
    Promoted,
    PreflightFailed,
    VerifyFailed,
    PromoteFailed,
    Cancelled,
}
```

State invariants (enforced by `PatchTransaction` methods, asserted in tests):

- `Idle → Preflight` via `run_preflight(...)`.
- `Preflight → Staged` via `stage(...)`. Requires `state == Preflight && diagnostics.iter().all(|d| d.severity != Fatal)`.
- `Staged → Verified` via `verify(...)`.
- `Verified → Promoted` via `promote(...)`.
- Any failed step: `state` transitions to the corresponding `*Failed` and the harness automatically rolls back (delete staging file if present). After a failure or `cancel(...)`, the only legal subsequent call is `into_outcome()`.
- `cancel(...)` is legal from any state. From `Idle` or `Preflight` it is a no-op. From `Staged` or `Verified` it deletes staging and transitions to `Cancelled`. Disposition is `cleaned_up` (vs. `rolled_back` for active failure).
- Re-entering a method after the state machine has left `Idle..=Verified` returns `Err(PatchTransactionError::StateMachineMisuse)`.

### 2.4 `PatchTransactionOutcome`

```rust
pub struct PatchTransactionOutcome {
    pub final_state: TransactionState,
    /// v0.2 PatchResult as JSON, ready to ship via
    /// `validate_patch_result_v02`. The harness guarantees this passes
    /// validation.
    pub patch_result_v02: serde_json::Value,
    /// The legacy in-Rust struct so existing callers keep compiling.
    pub legacy_patch_result: PatchResult,
}
```

The harness **always** emits both shapes. Callers that don't care about the legacy shape ignore `legacy_patch_result`.

---

## 3. Transaction state machine — detailed flow

### 3.1 Preflight (`run_preflight`)

Runs all five checks even when an early check fails — accumulates every blocker so the caller sees the full list. Order is fixed (for determinism):

1. **Transform support** — every entry in `required_transforms` must appear in `adapter_capabilities.access_contract` with `status: "supported"`. Fail → `TransactionFailureCategory::AdapterUnsupported`, diagnostic code `kaifuu.unsupported_layered_transform` (constant already in `lib.rs` line 84).
2. **Byte budget** — `expected_output_hash` is computed by the caller from a buffer; the harness re-receives `expected_payload_len: u64` either from the config or via `stage(payload)` (`payload.len() as u64`). At preflight the harness checks `expected_payload_len <= byte_budget`. To get `expected_payload_len` at preflight time (before any bytes are written), the harness asks the caller for it via an additional `expected_payload_len: u64` field on `PatchTransactionConfig` (clarifies §2.2 — add this field). Fail → `PatchWriteFailed`, code `kaifuu.patch_transaction.byte_budget_exceeded`.
3. **Source hash** — open `output_path` (the source is read from the final path; the harness treats the existing file at `output_path` as the source bytes). Read fully into memory, sha256, compare to `expected_source_hash`. **Missing file** → `AssetMissing`, code `kaifuu.patch_transaction.source_missing`. **Mismatch** → `SourceIncompatible`, code `kaifuu.patch_result.source_incompatible`.
4. **Relocation** — for KAIFUU-084 the harness enforces **identity relocation only**: `expected_payload_len == source_bytes.len()`. If the lengths differ the harness rejects with `AdapterUnsupported`, code `kaifuu.patch_transaction.relocation_unsupported`. Offset-table rewrite is out of scope (§13).
5. **Output hash precomputed** — the harness asserts `expected_output_hash` matches the SHA-256 format `^sha256:[0-9a-f]{64}$` (uses the same regex as `contracts.rs::assert_hash_value`). Fail → `OutputHashMismatch`, code `kaifuu.patch_transaction.expected_output_hash_malformed`. This protects against a caller passing a non-canonical hash.

If **any** preflight check fails, the harness:

- Does **not** create or modify any file on disk.
- Transitions state to `PreflightFailed`.
- Builds `patch_result_v02` with `status: "failed"`, `failures: [...]` (one per blocker), `failureCategories` deduplicated, `partialWrite: { attemptedAssetIds: [asset_id], writtenAssetIds: [], skippedAssetIds: [asset_id], disposition: "rolled_back", rollbackDiagnosticCode: <first failure's diagnosticCode> }`.

### 3.2 Stage (`stage(payload: &[u8])`)

Pre-condition: `state == Preflight` and zero preflight diagnostics.

Steps:

1. Compute staging path: `output_path.parent().join(".staging").join(format!("{}-{}.tmp", asset_id, run_id))`. Create the parent `.staging` directory with `fs::create_dir_all` (idempotent). Permissions inherit from parent.
2. Write `payload` to staging file via `OpenOptions::new().write(true).create_new(true).open(staged_path)` followed by `write_all(payload)` and `sync_all()`. **Reject** if the file already exists (`ErrorKind::AlreadyExists`) → `PromoteFailed` state, category `PatchWriteFailed`, code `kaifuu.patch_transaction.staged_collision`. The `create_new` flag prevents two concurrent runs with the same `run_id` from corrupting each other.
3. On any I/O failure: delete the staging file (best-effort `fs::remove_file` ignoring `NotFound`), transition to `PromoteFailed` (semantically: we did try a write), build `patch_result_v02` with `failures[*].category: "patch_write_failed"`, `partialWrite.disposition: "rolled_back"`.
4. On success: transition to `Staged`, record `staged_path`.

**Critical:** the harness never writes to `output_path` in this step. The original output file is untouched until promotion.

### 3.3 Verify (`verify()`)

Pre-condition: `state == Staged`.

Steps:

1. Read staged bytes back: `fs::read(staged_path)`.
2. Compute sha256 (uses existing `sha256_hash_bytes`), prefixed with `sha256:`. Compare to `expected_output_hash`.
3. **Mismatch** → roll back: delete staging file; transition to `VerifyFailed`; build `patch_result_v02` with one failure of category `OutputHashMismatch`, code `kaifuu.patch_result.output_hash_drift`, `partialWrite.disposition: "rolled_back"`, `rollbackDiagnosticCode: "kaifuu.patch_transaction.staged_verify_rolled_back"`.
4. **Read I/O failure** → roll back similarly; category `PatchWriteFailed`, code `kaifuu.patch_transaction.staged_read_failed`.
5. **Match** → transition to `Verified`.

### 3.4 Promote (`promote()`)

Pre-condition: `state == Verified`.

Steps:

1. Atomic rename: `fs::rename(staged_path, output_path)`. POSIX guarantees this is atomic on the same filesystem. Cross-filesystem moves error; the harness documents the precondition that `.staging` is a sibling directory under `output_path.parent()` (same filesystem by construction).
2. **Rename failure** → roll back: delete staging file; the **original output path is preserved** because rename only swaps atomically on success. Transition to `PromoteFailed`. Build `patch_result_v02` with one failure of category `PatchWriteFailed`, code `kaifuu.patch_transaction.promote_failed`, `partialWrite.disposition: "rolled_back"`, `rollbackDiagnosticCode: "kaifuu.patch_transaction.promote_rolled_back"`.
3. **Success** → transition to `Promoted`. Build `patch_result_v02` with:
   - `status: "passed"`
   - `touchedAssets: [{ assetId: <asset_id>, outputHash: <expected_output_hash>, byteSize: <expected_payload_len> }]`
   - `outputHash: <rollup>` where rollup is `compute_rollup(touchedAssets)` per KAIFUU-010 §3.3 (single asset means `rollup = sha256(format!("{assetId}\n{outputHash}\n"))`).
   - `failures: []`
   - No `failureCategories`, no `partialWrite`.

### 3.5 Cancel (`cancel()`)

- From `Idle` / `Preflight`: no-op (no files exist yet).
- From `Staged` / `Verified`: delete staging file; transition to `Cancelled`. `patch_result_v02` with one failure of category `PatchWriteFailed`, code `kaifuu.patch_transaction.cancelled`, `partialWrite.disposition: "cleaned_up"`, `rollbackDiagnosticCode: "kaifuu.patch_transaction.cancelled"`.
- From `Promoted`: returns `Err(PatchTransactionError::StateMachineMisuse)` — the patch already succeeded; the caller cannot "un-cancel" a successful promotion.

### 3.6 Failure-category mapping table

Single source of truth for which v0.2 category each harness failure carries:

| Failure point                    | `TransactionFailureCategory` | v0.2 `category`        | `diagnosticCode`                                          |
| -------------------------------- | ---------------------------- | ---------------------- | --------------------------------------------------------- |
| Transform support                | `AdapterUnsupported`         | `adapter_unsupported`  | `kaifuu.unsupported_layered_transform`                    |
| Byte budget                      | `PatchWriteFailed`           | `patch_write_failed`   | `kaifuu.patch_transaction.byte_budget_exceeded`           |
| Source file missing              | `AssetMissing`               | `asset_missing`        | `kaifuu.patch_transaction.source_missing`                 |
| Source hash mismatch             | `SourceIncompatible`         | `source_incompatible`  | `kaifuu.patch_result.source_incompatible`                 |
| Relocation (non-identity length) | `AdapterUnsupported`         | `adapter_unsupported`  | `kaifuu.patch_transaction.relocation_unsupported`         |
| Expected-output-hash malformed   | `OutputHashMismatch`         | `output_hash_mismatch` | `kaifuu.patch_transaction.expected_output_hash_malformed` |
| Stage write I/O fail             | `PatchWriteFailed`           | `patch_write_failed`   | `kaifuu.patch_transaction.staged_write_failed`            |
| Staged collision                 | `PatchWriteFailed`           | `patch_write_failed`   | `kaifuu.patch_transaction.staged_collision`               |
| Staged read fail                 | `PatchWriteFailed`           | `patch_write_failed`   | `kaifuu.patch_transaction.staged_read_failed`             |
| Verify hash mismatch             | `OutputHashMismatch`         | `output_hash_mismatch` | `kaifuu.patch_result.output_hash_drift`                   |
| Promote rename fail              | `PatchWriteFailed`           | `patch_write_failed`   | `kaifuu.patch_transaction.promote_failed`                 |
| Cancelled                        | `PatchWriteFailed`           | `patch_write_failed`   | `kaifuu.patch_transaction.cancelled`                      |

(Cancelled uses `patch_write_failed` because the only allowed v0.2 categories are the six in `PATCH_FAILURE_CATEGORIES_V02`. No new category is introduced.)

---

## 4. Semantic codes (new constants in `lib.rs`)

Append to the existing `SEMANTIC_*` block (around line 84). Each constant has both a name and a string value matching the table in §3.6:

```rust
pub const SEMANTIC_PATCH_TRANSACTION_BYTE_BUDGET_EXCEEDED: &str =
    "kaifuu.patch_transaction.byte_budget_exceeded";
pub const SEMANTIC_PATCH_TRANSACTION_SOURCE_MISSING: &str =
    "kaifuu.patch_transaction.source_missing";
pub const SEMANTIC_PATCH_TRANSACTION_RELOCATION_UNSUPPORTED: &str =
    "kaifuu.patch_transaction.relocation_unsupported";
pub const SEMANTIC_PATCH_TRANSACTION_EXPECTED_OUTPUT_HASH_MALFORMED: &str =
    "kaifuu.patch_transaction.expected_output_hash_malformed";
pub const SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED: &str =
    "kaifuu.patch_transaction.staged_write_failed";
pub const SEMANTIC_PATCH_TRANSACTION_STAGED_COLLISION: &str =
    "kaifuu.patch_transaction.staged_collision";
pub const SEMANTIC_PATCH_TRANSACTION_STAGED_READ_FAILED: &str =
    "kaifuu.patch_transaction.staged_read_failed";
pub const SEMANTIC_PATCH_TRANSACTION_PROMOTE_FAILED: &str =
    "kaifuu.patch_transaction.promote_failed";
pub const SEMANTIC_PATCH_TRANSACTION_STAGED_VERIFY_ROLLED_BACK: &str =
    "kaifuu.patch_transaction.staged_verify_rolled_back";
pub const SEMANTIC_PATCH_TRANSACTION_PROMOTE_ROLLED_BACK: &str =
    "kaifuu.patch_transaction.promote_rolled_back";
pub const SEMANTIC_PATCH_TRANSACTION_CANCELLED: &str =
    "kaifuu.patch_transaction.cancelled";
```

Existing constants reused (no duplicates):

- `SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM` (line 84)
- `SEMANTIC_PATCH_RESULT_SOURCE_INCOMPATIBLE` (line 102)
- `SEMANTIC_PATCH_RESULT_OUTPUT_HASH_DRIFT` (line 101)

---

## 5. Staging directory layout

```
<output_dir>/                                # e.g. game install dir
├── SEEN.TXT                                 # final output path (untouched until promote)
└── .staging/                                # created by harness
    └── <asset_id>-<run_id>.tmp              # exclusive-create staging file
```

Rules:

- The `.staging` directory is created on first stage and **not** cleaned up by the harness. Its lifetime is one transaction; subsequent transactions reuse it. Clean-up across runs is the caller's responsibility (e.g. `just clean` target or app-startup sweep).
- `<asset_id>-<run_id>` uniqueness guarantees no two concurrent transactions for the same asset clash. The `create_new` flag is the strict enforcer.
- The harness does **not** descend into parent directories of `output_path`; the `.staging` directory is created at `output_path.parent()`. The caller pre-creates the output dir.

Crash-resilience: a process crash between stage and promote leaves a `.tmp` file in `.staging`. The original output file is untouched. The next run with the same `(asset_id, run_id)` would hit `staged_collision`; with a fresh `run_id` it would proceed. A documented **out-of-band cleanup** (e.g. `kaifuu-cli clean-staging`) is mentioned in §13 as out of scope for this slice but called out so the harness contract is honest.

---

## 6. Integration with KAIFUU-174 (RealLive patch-back)

KAIFUU-084 does **not** migrate `patchback.rs`. It exposes the harness API so RealLive can adopt incrementally. The exact integration contract:

1. RealLive's `EngineAdapter::patch` impl (currently emits the v0.1 `PatchResult` via the in-Rust struct) gains a parallel code path that:
   - Calls `apply_patches(archive_bytes, scene_index, scenes, &edits)` to compute the patched bytes in memory (existing API, no change).
   - Constructs a `PatchTransactionConfig` with:
     - `expected_source_hash`: sha256 of `archive_bytes`.
     - `expected_output_hash`: sha256 of the `apply_patches` return value.
     - `expected_payload_len`: `apply_patches.len() as u64`.
     - `byte_budget`: equal to `expected_payload_len` (RealLive is length-preserving today, so the budget is exactly the source length).
     - `required_transforms`: derived from the engine's existing layered-access contract.
   - Runs `transaction.run_preflight()` → `transaction.stage(&patched_bytes)` → `transaction.verify()` → `transaction.promote()`.
   - Returns the resulting `PatchTransactionOutcome.legacy_patch_result` to keep the trait signature stable, and additionally exposes the v0.2 JSON via a new sibling method on the adapter (out of scope for this slice — KAIFUU-011 wires it).
2. `PatchBackErrorCode` → `TransactionFailureCategory` mapping is the KAIFUU-010 §6 table verbatim. RealLive maps any pre-write `PatchBackError` to a preflight diagnostic (preventing any staged write); post-write errors are surfaced via `verify` (verify catches `apply_patches` regressions because the staged bytes are re-hashed).

3. RealLive does **not** need to construct staging paths itself. The harness owns the `.staging` directory.

The plan does **not** modify `crates/kaifuu-reallive/src/patchback.rs` in this slice. The integration is shipped under KAIFUU-011.

---

## 7. PatchResult v0.2 emission shape

Every harness outcome emits a `serde_json::Value` matching the v0.2 contract. Construction lives in a private helper `build_patch_result_v02(...)` that:

- Generates `patchResultId` deterministically: `uuid7::deterministic(asset_id, run_id, state)` using the existing `deterministic_id` helper convention (matches `PatchResult::preflight_pass` line 14232). The exact uuid7 generation is the same approach as the rest of the codebase to keep contract-test goldens stable.
- Fills:
  - `schemaVersion: BRIDGE_SCHEMA_VERSION_V02`
  - `patchResultId`, `patchExportId`, `adapterId`
  - `status` based on `final_state`
  - `failures: [...]` from accumulated `TransactionDiagnostic`s. Each `PatchFailureV02` carries the harness diagnosticCode, the configured `assetId`, `bridgeUnitId`, `adapterId`, and `command`.
  - `failureCategories` deduplicated from `failures[*].category`.
  - `touchedAssets` on success.
  - `outputHash` on success (rollup over `touchedAssets`).
  - `partialWrite` on every non-success state.
- Validates itself via `contracts::validate_patch_result_v02(&value)` in a debug-only assertion (`#[cfg(debug_assertions)]`). This guarantees we never ship a JSON that fails the contract validator.

Each emitted JSON is round-tripped through `validate_patch_result_v02` in §10 tests.

---

## 8. Tests

File: `crates/kaifuu-core/src/patch_transaction.rs` `#[cfg(test)] mod tests`. Each test uses `tempfile::TempDir` for isolation. All tests run with `cargo test -p kaifuu-core patch_transaction`.

### 8.1 Positive — happy path

```rust
fn patches_then_verifies_a_length_preserving_payload()
```

- Pre-create `output_path` with synthesized source bytes (32 bytes, e.g. `b"AAAA...A"`).
- Compute `expected_output_hash` from a known target payload.
- Run the full state machine: `run_preflight` → `stage(target_payload)` → `verify` → `promote`.
- Assert `final_state == Promoted`.
- Assert `output_path` contains `target_payload` (read-back check).
- Assert no `.staging/<asset>-<run>.tmp` remains.
- Assert `patch_result_v02["status"] == "passed"`.
- Assert `validate_patch_result_v02(&outcome.patch_result_v02).is_ok()`.
- Assert `touchedAssets` has exactly one entry whose `outputHash` matches `expected_output_hash`.

### 8.2 Preflight: byte budget exceeded

```rust
fn rejects_payload_that_exceeds_byte_budget_before_any_write()
```

- `byte_budget = 16`, `expected_payload_len = 32`.
- Call `run_preflight`.
- Assert `final_state == PreflightFailed`.
- Assert no `.staging` directory was created (path does not exist).
- Assert `output_path` untouched (read-back equals original).
- Assert `patch_result_v02["status"] == "failed"`.
- Assert `failures[0]["category"] == "patch_write_failed"`, `diagnosticCode` ends in `byte_budget_exceeded`.
- Assert `partialWrite.disposition == "rolled_back"`, `partialWrite.writtenAssetIds == []`.

### 8.3 Preflight: source hash mismatch

```rust
fn rejects_when_source_bytes_drifted_from_expected_hash()
```

- Source bytes do not hash to `expected_source_hash`.
- Assert `failures[0]["category"] == "source_incompatible"`.

### 8.4 Preflight: missing source file

```rust
fn rejects_when_source_file_missing()
```

- `output_path` does not exist.
- Assert `category == "asset_missing"`.

### 8.5 Preflight: unsupported transform

```rust
fn rejects_when_required_transform_is_not_declared_by_the_adapter()
```

- `required_transforms = &["non_existent_transform"]`.
- Adapter capabilities contain no matching transform.
- Assert `category == "adapter_unsupported"`.

### 8.6 Preflight: relocation (non-identity length)

```rust
fn rejects_non_length_preserving_relocation()
```

- `expected_payload_len != source_bytes.len()`.
- Assert `category == "adapter_unsupported"`, `diagnosticCode` ends in `relocation_unsupported`.

### 8.7 Verify: staged hash mismatch

```rust
fn rolls_back_staged_payload_when_verify_hash_mismatches()
```

- Stage a payload whose actual sha256 differs from `expected_output_hash` (e.g. flip a byte before calling `stage`).
- Run `verify()`.
- Assert `final_state == VerifyFailed`.
- Assert staging file is deleted (`!staged_path.exists()`).
- Assert `output_path` still contains the **original** source bytes.
- Assert `failures[0]["category"] == "output_hash_mismatch"`.

### 8.8 Promote: simulated rename failure

```rust
fn rolls_back_when_promote_rename_fails()
```

- Inject a rename failure. Cross-platform method: create the output path as a **read-only directory** (not a file), so `fs::rename(staging, output_path)` fails. (Falls back to: replace `output_path` with a directory before `promote()`.)
- Assert `final_state == PromoteFailed`.
- Assert staging file is deleted.
- Assert `failures[0]["category"] == "patch_write_failed"`, `diagnosticCode` ends in `promote_failed`.

### 8.9 Cancellation

```rust
fn cancels_after_stage_and_cleans_up_staging()
```

- After `stage()`, call `cancel()`.
- Assert `final_state == Cancelled`.
- Assert staging file removed; output untouched.
- Assert `partialWrite.disposition == "cleaned_up"`.

### 8.10 State-machine misuse

```rust
fn rejects_double_promote_with_state_machine_misuse_error()
```

- After `promote()` returns Ok, call `promote()` again.
- Assert `Err(PatchTransactionError::StateMachineMisuse)`.

### 8.11 v0.2 round-trip

```rust
fn every_outcome_passes_validate_patch_result_v02()
```

Parameterized over 8.1–8.9 (excluding the misuse test, which doesn't reach `into_outcome`). For each, `contracts::validate_patch_result_v02(&outcome.patch_result_v02)` must return `Ok(())`.

### 8.12 Concurrency collision

```rust
fn rejects_a_second_stage_when_the_same_run_id_is_already_staged()
```

- Pre-create the staging path file out-of-band.
- Call `stage(payload)`.
- Assert `final_state == PromoteFailed`, `diagnosticCode` ends in `staged_collision`.

---

## 9. Documentation updates

`docs/subprojects-kaifuu.md`: append a subsection under the v0.2 patch-result section titled "Patch transaction harness (KAIFUU-084)" that:

- Lists the five preflight checks in order.
- Describes the `<output_dir>/.staging/<asset>-<run>.tmp` layout.
- States the engine-neutrality contract and the planned KAIFUU-011 wiring point.
- Cites the failure-category mapping table from §3.6.

`docs/testing-standard.md`: **no change**. The harness adds tests within the existing rules.

---

## 10. Verification commands

Run in the worktree:

```bash
cargo test -p kaifuu-core patch_transaction    # §8 (focused)
cargo test -p kaifuu-core                      # full kaifuu-core, including contracts
cargo test -p kaifuu-reallive                  # no regression — KAIFUU-174 patchback unchanged
just check                                     # lint + types + cargo check
just test                                      # full sweep
```

`just contract-validate` is invoked by `just check` (no separate call). No new `just` target.

---

## 11. Risks

1. **Cross-platform atomic rename.** POSIX guarantees `rename` is atomic on the same filesystem. Windows `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` is atomic on NTFS but not all filesystems. CI today is Linux; the plan documents the precondition (`.staging` is a sibling under `output_path.parent()` → same filesystem) so a future Windows CI port does not surprise us. The harness uses `fs::rename` (Rust's std wraps `MoveFileExW` on Windows with `MOVEFILE_REPLACE_EXISTING`), so the behavior is the closest available portable approximation.
2. **Staging cleanup on crash.** A crash between stage and promote leaves `.staging/<asset>-<run>.tmp`. This is **not** silent partial success — the original output is untouched and no `PatchResult` was emitted. But the file does linger on disk. Mitigation: KAIFUU-084 documents the issue and reserves the `kaifuu-cli clean-staging` sweep as a follow-up (§13). The `staged_collision` rejection in §3.2 is the safety net.
3. **Integration friction with KAIFUU-174.** The RealLive patchback today returns `Result<Vec<u8>, PatchBackError>` from an in-memory transform. Wrapping it in the harness requires the caller (KAIFUU-011) to compute `expected_output_hash` ahead of `stage`, which means running `apply_patches` first and hashing the result. This is the natural shape — KAIFUU-011 owns it — but it does mean the harness is a thin layer, not a generator. The plan explicitly does not pre-empt KAIFUU-011's API choices.
4. **Length-preserving constraint.** §3.1 step 4 rejects any non-identity length. This is a deliberate KAIFUU-084 limitation aligned with KAIFUU-174 §7.2. Adapters that need length-changing patches must layer offset-table rewriting on top **before** calling the harness (i.e. they hand the harness already-relocated bytes whose total length equals the source length). Documented in `docs/subprojects-kaifuu.md` per §9.
5. **Debug-assertion validator round-trip.** §7's `#[cfg(debug_assertions)]` self-check could regress at runtime under `--release` if a code path emits a JSON the validator rejects. Mitigation: §8.11 runs the validator in all test builds (which use debug profile by default; the assertion fires).
6. **Determinism of `patchResultId`.** Using `deterministic_id(asset_id, run_id, state_label)` keeps goldens stable but couples test fixtures to the harness internals. Mitigation: keep the generator inside `patch_transaction.rs` and never expose it publicly; tests assert v0.2 contract validity, not the exact uuid.
7. **`partialWrite` semantics.** Failed preflight → "no bytes written," but the harness still emits `partialWrite` with `writtenAssetIds: []`, `attemptedAssetIds: [asset_id]`, `skippedAssetIds: [asset_id]`. This is the cleanest mapping onto the existing v0.2 schema (it has no `not_attempted` disposition). If reviewers prefer omitting `partialWrite` on pre-write failures, that's a one-line tweak — but the schema already allows the present form, and it preserves a uniform shape across all failure paths.

---

## 12. Out of scope

- **KAIFUU-011** (Binary patcher composed smoke). KAIFUU-084 exposes the harness; KAIFUU-011 wires it into a CLI smoke command.
- **ALPHA-006** vertical (real-game patching).
- **Full RealLive patchback migration.** RealLive may adopt the harness incrementally; KAIFUU-084 does not touch `patchback.rs`.
- **Offset-table rewriting / non-identity relocation.** Reserved for a future node once per-game evidence justifies it. The harness rejects it explicitly (§3.1 step 4).
- **Cross-process staging sweep.** A `kaifuu-cli clean-staging` command is a separate node.
- **Windows-specific rename semantics.** Documented as a risk (§11.1) but not fixed here. Linux CI is the only gate today.
- **The `retained_partial` disposition.** Available in the v0.2 schema but the harness never emits it — it would represent silent partial success, which the harness contract forbids.
- **Non-binary patches.** The harness is exclusively for binary file-replacement patches. Text-only flows have their own boundary.

---

## 13. Worker scoping

**One worker, single Rust slice.** The harness lives in one new file (`patch_transaction.rs`), adds ~12 semantic constants to `lib.rs`, and one documentation subsection. Estimated effort: ~1 day.

| Slice        | Surfaces                                                                                                                                                                                                                                                  | Effort |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **A (Rust)** | `crates/kaifuu-core/src/patch_transaction.rs` (new), `crates/kaifuu-core/src/lib.rs` (semantic constants + `pub mod patch_transaction;`), `crates/kaifuu-core/Cargo.toml` (`[dev-dependencies] tempfile`), `docs/subprojects-kaifuu.md` (one subsection). | ~1 day |

No TS-side change. No Itotori-side change. No RealLive change. The harness is engine-neutral and consumer-free in this slice; KAIFUU-011 is the first consumer.

---

## 14. Process

1. Implement `patch_transaction.rs` with the public API in §2 and state machine in §3.
2. Add semantic constants from §4 to `lib.rs`.
3. Wire `pub mod patch_transaction;` and the re-exports in §1.
4. Add `tempfile` to `kaifuu-core` `[dev-dependencies]`.
5. Write tests §8 in the same file under `#[cfg(test)] mod tests`.
6. Run §10 verification commands top-to-bottom.
7. Update `docs/subprojects-kaifuu.md` per §9.
8. Commit per repo conventions (one `feat(KAIFUU-084):` commit).

End of plan.
