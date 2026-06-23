# KAIFUU-010 — Patch result and verification v0.2 — Implementation Plan

| Field           | Value                                        |
| --------------- | -------------------------------------------- |
| DAG node        | `KAIFUU-010`                                 |
| Title           | Patch result and verification v0.2           |
| Branch          | `spec/kaifuu-010`                            |
| Worktree        | `/scratch/worktrees/itotori-spec-kaifuu-010` |
| Plan author     | planning worker (orchestrator-spawned)       |
| Plan date       | 2026-06-23                                   |
| Output file     | `.plan/KAIFUU-010.md` (this file)            |
| Plan-only slice | No feature code lands from this plan.        |

---

## 0. Evidence Map (what already exists, what must change)

| Surface                                                                                           | State today                                                                                                                                                                                                                                                                                                                                       | Change demanded by KAIFUU-010                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `packages/localization-bridge-schema/src/index.ts` `PatchResultV02` (lines 1582–1590)              | Has `schemaVersion`, `patchResultId`, `patchExportId`, `status` (`passed`/`failed`/`incompatible_source`), optional `outputHash`, `failures: string[]`, optional `sourceCompatibility`. Failures are loose strings. No category enum, no asset/bridge-unit/adapter cite, no partial-write accounting, no `touchedAssets`.                            | Tighten schema: structured failure objects, typed `failureCategories` summary, partial-write accounting, `touchedAssets`, `outputHash` required on `passed`. Keep `sourceCompatibility` story intact (already wired).            |
| `packages/localization-bridge-schema/src/index.ts` `assertPatchResultV02` (lines 2486–2524)        | Validates current loose shape. Calls `assertStringArray(result.failures)`. No category cross-checks. Passing report has no required `outputHash` enforcement.                                                                                                                                                                                       | Replace loose `failures` assertion with structured-failure assertion. Add `failureCategories`/`touchedAssets`/`partialWrite` validation. Enforce category-status invariants. Enforce `outputHash` on `passed`.                  |
| `crates/kaifuu-core/src/contracts.rs` `validate_patch_result_v02` (lines 895–959)                  | Mirrors the loose TS shape. Calls `assert_string_array(failures)`. Same gap.                                                                                                                                                                                                                                                                       | Mirror new TS rules 1:1 in Rust, including category enum, structured-failure required fields, partial-write accounting, `outputHash` required on `passed`.                                                                      |
| `crates/kaifuu-reallive/src/patchback.rs` `PatchBackError` (lines 53–122)                          | RealLive patch consumer with its own typed error codes (`kaifuu.reallive.patchback_*`). Does **not** today emit a shared `PatchResult` — it just bubbles `Result<Vec<u8>, PatchBackError>`.                                                                                                                                                         | RealLive must learn how to translate these into the shared `PatchFailureCategoryV02` enum. KAIFUU-010 does **not** rewrite the patchback engine; it only specifies the mapping table the future emitter will use (see §6).      |
| `apps/itotori/src/cli-handlers.ts` (lines 120–129) and `services/project-workflow.ts` (lines 220–299) | `export-patch` writes a `PatchExport` (v0.1). `ingest-runtime` writes runtime reports and synthesizes a `patchResultId` from the runtime report. No CLI command ingests a `PatchResult` artifact from disk; no v0.2 schema validation hits an Itotori boundary today.                                                                              | Add a new `ingest-patch-result` CLI command + `ProjectWorkflow.ingestPatchResult()` boundary. Schema-validate input via `assertPatchResultV02`. Reject missing-category / mismatched-export-id / output-hash-drift semantically. |
| `fixtures/hello-game/expected/patch-result-v0.2.fr-FR.json`                                       | Already present with `status: "passed"`, `outputHash`, empty `failures`, full `sourceCompatibility`. **No `touchedAssets`, no `failureCategories`, no `partialWrite` block.**                                                                                                                                                                       | Regenerate to add the new v0.2 fields. Hashes must stay stable across CI platforms (see §10 risks).                                                                                                                              |
| `packages/localization-bridge-schema/test/examples/invalid/patch-result-v0.2-incompatible-status.json` | Single negative fixture present (mismatched `status: "failed"` for incompatible source).                                                                                                                                                                                                                                                          | Add **three** more negatives mandated by DAG. Update the existing one to the new structured-failure shape if needed.                                                                                                             |

The plan that follows is strictly bounded by these rows. Each schema rule below is the **why** for one or more of these surfaces.

---

## 1. TS Schema (`packages/localization-bridge-schema/src/index.ts`)

### 1.1 New const tuples (placed adjacent to `PATCH_RESULT_STATUSES_V02`)

```ts
export const PATCH_FAILURE_CATEGORIES_V02 = [
  "source_incompatible",
  "patch_write_failed",
  "protected_span_violation",
  "asset_missing",
  "adapter_unsupported",
  "output_hash_mismatch",
] as const;
export type PatchFailureCategoryV02 = (typeof PATCH_FAILURE_CATEGORIES_V02)[number];

export const PATCH_PARTIAL_WRITE_DISPOSITIONS_V02 = [
  "rolled_back",
  "cleaned_up",
  "retained_partial",
] as const;
export type PatchPartialWriteDispositionV02 =
  (typeof PATCH_PARTIAL_WRITE_DISPOSITIONS_V02)[number];
```

`retained_partial` is **not** silent partial success: it is an explicit, opt-in disposition that downstream Itotori ingestion treats as a P0 finding (see §5.3). The disposition enum keeps the contract truthful when an adapter physically cannot roll back (e.g. mid-write `.exe` corruption on Windows). The acceptance criterion "no silent partial success" is satisfied by requiring **one of** the three values whenever `partialWrite` is present.

`PATCH_INCOMPATIBILITY_REASONS_V02` (lines 568–574 in the existing file) already exists and is reused as-is for the `sourceCompatibility` path. The acceptance criterion that incompatible reports cite reasons from this tuple is already enforced via `UnitSourceCompatibilityV02.reason` (line 1567) — the plan keeps that wiring.

### 1.2 New interfaces

```ts
export type PatchFailureV02 = {
  failureId: Uuid7;
  category: PatchFailureCategoryV02;
  diagnosticCode: string;        // e.g. "kaifuu.reallive.patchback_protected_span_lost"
  cause: string;                 // human-readable, single sentence
  assetId: Uuid7;                // every failure cites an asset
  bridgeUnitId: Uuid7;           // every failure cites a bridge unit
  adapterId: string;             // engine adapter id, e.g. "kaifuu-reallive"
  command: string;               // semantic command name, e.g. "patch.write_string_slot"
  patchExportEntryId?: Uuid7;    // optional precise pointer when known
  sourceLocation?: SourceLocationV02; // reuse existing v0.2 type
};

export type PatchPartialWriteAccountingV02 = {
  attemptedAssetIds: Uuid7[];
  writtenAssetIds: Uuid7[];
  skippedAssetIds: Uuid7[];
  disposition: PatchPartialWriteDispositionV02;
  rollbackDiagnosticCode?: string; // required when disposition !== "retained_partial"
};

export type PatchTouchedAssetV02 = {
  assetId: Uuid7;
  outputHash: string;            // per-asset hash of the patched bytes
  byteSize: number;
};
```

### 1.3 Replacement `PatchResultV02`

```ts
export type PatchResultV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  patchResultId: Uuid7;
  patchExportId: Uuid7;
  adapterId: string;             // top-level adapter id (engine that produced the result)
  status: PatchResultStatusV02;  // "passed" | "failed" | "incompatible_source"
  outputHash?: string;           // required when status === "passed"
  touchedAssets?: PatchTouchedAssetV02[]; // required when status === "passed"
  failures: PatchFailureV02[];   // structured, not strings
  failureCategories?: PatchFailureCategoryV02[]; // required when status !== "passed"
  partialWrite?: PatchPartialWriteAccountingV02;
  sourceCompatibility?: PatchSourceCompatibilityReportV02;
};
```

Notes on cross-field invariants (all enforced in §1.4):

- `status === "passed"` ⇒ `outputHash` present, `touchedAssets.length >= 1`, `failures.length === 0`, `failureCategories` absent, `partialWrite` absent.
- `status === "failed"` ⇒ `failures.length >= 1`, `failureCategories` present and equal to the deduplicated set of `failures[*].category`, `outputHash` absent, `touchedAssets` absent.
- `status === "incompatible_source"` ⇒ `sourceCompatibility` present with `status: "incompatible"`, `failureCategories` includes `"source_incompatible"`, every `failures[*].category === "source_incompatible"`.
- If `partialWrite` present, then `status !== "passed"`, every `failures[*].assetId` is in `partialWrite.attemptedAssetIds`, and `attemptedAssetIds` is the disjoint union of `writtenAssetIds` and `skippedAssetIds`.
- `partialWrite.disposition === "retained_partial"` ⇒ no `rollbackDiagnosticCode`; otherwise `rollbackDiagnosticCode` is required.

### 1.4 Replacement `assertPatchResultV02`

The current validator at line 2486 is rewritten to:

1. Pre-existing checks: schemaVersion, patchResultId, patchExportId, status, sourceCompatibility wiring (lines 2494–2523) remain.
2. Add `assertString(result.adapterId, "PatchResultV02.adapterId")` with `assertNonEmptyString`.
3. Replace `assertStringArray(result.failures, ...)` with a new helper:
   ```ts
   function assertPatchFailuresV02(value: unknown, label: string): PatchFailureV02[];
   ```
   which iterates and per-entry asserts: `failureId` (uuid7), `category` ∈ `PATCH_FAILURE_CATEGORIES_V02`, `diagnosticCode` non-empty, `cause` non-empty, `assetId` uuid7, `bridgeUnitId` uuid7, `adapterId` non-empty, `command` non-empty, optional `patchExportEntryId` uuid7, optional `sourceLocation` via existing `assertSourceLocationV02`.
4. Add `assertOptionalEnumArray(result.failureCategories, PATCH_FAILURE_CATEGORIES_V02, "PatchResultV02.failureCategories")`.
5. Add `assertOptionalPatchPartialWriteAccountingV02(result.partialWrite, ...)` and `assertOptionalPatchTouchedAssetArrayV02(result.touchedAssets, ...)`.
6. Enforce all invariants from §1.3:
   - `passed` ⇒ require `outputHash`, `touchedAssets.length >= 1`, `failures.length === 0`, no `failureCategories`, no `partialWrite`. Error code in message: `kaifuu.patch_result.passed_requires_output_hash`, etc.
   - `failed`/`incompatible_source` ⇒ require `failures.length >= 1`, require `failureCategories`, require `failureCategories` equals dedup of `failures[*].category` (label `kaifuu.patch_result.missing_failure_category` when shorter, `kaifuu.patch_result.unknown_failure_category` when extra).
   - `incompatible_source` ⇒ every `failures[*].category === "source_incompatible"` (label `kaifuu.patch_result.incompatible_source_category_required`).
   - `partialWrite.attemptedAssetIds = writtenAssetIds ∪ skippedAssetIds`, disjoint; `failures[*].assetId ⊆ attemptedAssetIds`; disposition vs. `rollbackDiagnosticCode` rule.

### 1.5 Exports

Append to the existing `export * from "./style-guide-conversation.js"` block layout pattern: every new const tuple, every new type, every new asserter must appear in the file's top-level export surface. No new sub-module — these belong inside `index.ts` next to the existing v0.2 patch types (around line 1568). Wire them into `assertContractFixtureV02` (around line 2900) so `"patch-result-v0.2"` already-existing dispatch picks them up automatically.

### 1.6 v0.1 alias (migration)

Keep the existing `PatchResult` type (line 89) untouched. Add a deprecation comment:

```ts
/**
 * @deprecated Use `PatchResultV02`. v0.1 callers will be migrated under
 *   KAIFUU-010 §7 then removed once ALPHA-006 closes.
 */
export type PatchResultV01 = PatchResult;
```

No runtime behavior change for v0.1 consumers in this slice. See §7.

---

## 2. Rust Contract (`crates/kaifuu-core/src/contracts.rs`)

### 2.1 New constant arrays

Adjacent to existing patch-status arrays:

```rust
pub const PATCH_FAILURE_CATEGORIES_V02: &[&str] = &[
    "source_incompatible",
    "patch_write_failed",
    "protected_span_violation",
    "asset_missing",
    "adapter_unsupported",
    "output_hash_mismatch",
];

pub const PATCH_PARTIAL_WRITE_DISPOSITIONS_V02: &[&str] = &[
    "rolled_back",
    "cleaned_up",
    "retained_partial",
];
```

### 2.2 Rewrite `validate_patch_result_v02` (line 895)

The existing function is rewritten to mirror §1.4 1:1. Helper functions added:

- `validate_patch_failure_v02(value, label) -> BridgeContractResult<String>` — returns the category. Required fields: `failureId` (uuid7), `category` (enum), `diagnosticCode` (non-empty), `cause` (non-empty), `assetId` (uuid7), `bridgeUnitId` (uuid7), `adapterId` (non-empty), `command` (non-empty). Optional: `patchExportEntryId` (uuid7), `sourceLocation` (via existing helper).
- `validate_patch_partial_write_accounting_v02(value, label) -> BridgeContractResult<()>` — enforces disjointness + disposition/rollback rule.
- `validate_patch_touched_asset_v02(value, label)`.

Top-level validator collects categories from `failures`, then cross-checks:

```rust
if status == "passed" {
    require_field(result, "outputHash", "PatchResultV02.outputHash")?;
    require_non_empty_array(result, "touchedAssets", "PatchResultV02.touchedAssets")?;
    if !failures.is_empty() { return error("PatchResultV02.passed_must_have_no_failures"); }
    if result.get("failureCategories").is_some() { return error("PatchResultV02.passed_must_omit_failure_categories"); }
    if result.get("partialWrite").is_some() { return error("PatchResultV02.passed_must_omit_partial_write"); }
}
if status == "failed" || status == "incompatible_source" {
    if failures.is_empty() { return error("PatchResultV02.non_passed_requires_failures"); }
    let declared = required_string_array(result, "failureCategories", "PatchResultV02.failureCategories")?;
    let observed = dedup_sorted(collected_categories);
    if dedup_sorted(declared) != observed {
        return error("kaifuu.patch_result.missing_failure_category: failureCategories must equal dedup(failures[*].category)");
    }
}
if status == "incompatible_source" {
    if collected_categories.iter().any(|c| c != "source_incompatible") {
        return error("kaifuu.patch_result.incompatible_source_category_required");
    }
}
```

### 2.3 Public surface

Both helper validators are `pub fn` (mirroring the existing `pub fn validate_patch_export_v02` style). `validate_patch_source_compatibility_v02` (currently `fn` at line 2005) is **promoted to `pub fn`** so external callers (Itotori-side Rust adapters, future engines) can re-use it without re-implementing.

### 2.4 Dispatcher

Line 183 (`"patch-result-v0.2" => validate_patch_result_v02(value)`) already exists. No change.

### 2.5 Semantic code constants (in `lib.rs`)

Add to the existing `pub const SEMANTIC_*` block (`lib.rs` lines 34+):

```rust
pub const SEMANTIC_PATCH_RESULT_MISSING_FAILURE_CATEGORY: &str =
    "kaifuu.patch_result.missing_failure_category";
pub const SEMANTIC_PATCH_RESULT_MISMATCHED_EXPORT_ID: &str =
    "kaifuu.patch_result.mismatched_export_id";
pub const SEMANTIC_PATCH_RESULT_OUTPUT_HASH_DRIFT: &str =
    "kaifuu.patch_result.output_hash_drift";
pub const SEMANTIC_PATCH_RESULT_SOURCE_INCOMPATIBLE: &str =
    "kaifuu.patch_result.source_incompatible";
pub const SEMANTIC_PATCH_RESULT_SILENT_PARTIAL_WRITE: &str =
    "kaifuu.patch_result.silent_partial_write";
pub const SEMANTIC_PATCH_RESULT_PASSED_REQUIRES_OUTPUT_HASH: &str =
    "kaifuu.patch_result.passed_requires_output_hash";
pub const SEMANTIC_PATCH_RESULT_PASSED_REQUIRES_TOUCHED_ASSETS: &str =
    "kaifuu.patch_result.passed_requires_touched_assets";
pub const SEMANTIC_PATCH_RESULT_INCOMPATIBLE_SOURCE_CATEGORY_REQUIRED: &str =
    "kaifuu.patch_result.incompatible_source_category_required";
```

The Rust validator strings above use these constants verbatim so error messages are greppable both ways (Rust → TS → docs).

---

## 3. Negative Fixtures (`packages/localization-bridge-schema/test/examples/invalid/`)

Four fixtures total — one new for each acceptance rejection path. Each fixture is a self-contained, otherwise-valid JSON that violates exactly one rule, so the test asserts the **specific** error message.

### 3.1 `patch-result-v0.2-incompatible-status.json` (already exists — update only)

Current file uses string `failures: ["source_hash_mismatch"]`. Update to the new structured shape so it still trips only the `status` rule (already mismatched). Minimal diff:

```json
"failures": [
  {
    "failureId": "019ed001-0000-7000-8000-00000000f960",
    "category": "source_incompatible",
    "diagnosticCode": "kaifuu.patch_result.source_incompatible",
    "cause": "source bundle hash drifted; re-extract before re-applying",
    "assetId": "019ed001-0000-7000-8000-000000000800",
    "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
    "adapterId": "kaifuu-reallive",
    "command": "patch.write_string_slot"
  }
],
"failureCategories": ["source_incompatible"],
"adapterId": "kaifuu-reallive"
```

Expected error substring: `PatchResultV02.status must be incompatible_source when sourceCompatibility.status is incompatible`.

### 3.2 `patch-result-v0.2-missing-failure-category.json` (new)

`status: "failed"`, one `failures[0]` with `category: "patch_write_failed"`, but **omits the top-level `failureCategories`** field.

Expected error substring: `kaifuu.patch_result.missing_failure_category` (Rust + TS share the literal).

### 3.3 `patch-result-v0.2-output-hash-mismatch.json` (new)

`status: "passed"`, `outputHash: "sha256:..."`, `touchedAssets: [{ outputHash: "sha256:DIFFERENT...", ... }]`. The per-asset hash does not roll up to the top-level hash. The TS asserter and Rust validator compute the rollup `sha256(touchedAssets[].outputHash joined newline-LF)` and reject when it differs from `outputHash`.

Expected error substring: `kaifuu.patch_result.output_hash_drift`.

**Note:** the rollup rule is part of this slice. Spec: `outputHash = sha256( touchedAssets sorted by assetId, joined as `${assetId}\n${outputHash}\n` UTF-8 ).` Document in `docs/subprojects-kaifuu.md` under the v0.2 patch result section.

### 3.4 `patch-result-v0.2-partial-write.json` (new)

`status: "failed"`, `failures.length = 1` citing `assetId: A1`, `partialWrite.attemptedAssetIds: [A1, A2]`, `writtenAssetIds: [A1]`, `skippedAssetIds: []`. Disjoint-union rule fails because `A2 ∉ writtenAssetIds ∪ skippedAssetIds`.

Expected error substring: `PatchResultV02.partialWrite.attemptedAssetIds must equal disjoint union of writtenAssetIds and skippedAssetIds` (single message; tag `kaifuu.patch_result.silent_partial_write`).

A second variant covered only by Rust test (no fixture) trips the disposition rule: `disposition: "rolled_back"` with no `rollbackDiagnosticCode`. Encoded as an inline JSON literal in the Rust test, not a separate fixture (keeps fixture count at 4 mandated).

---

## 4. hello-game generated report

### 4.1 File: `fixtures/hello-game/expected/patch-result-v0.2.fr-FR.json`

Regenerate (do not hand-edit the JSON above the source-of-truth generator). Add:

- Top-level `adapterId: "kaifuu-reallive"`.
- `touchedAssets`: one entry per `compatibleUnits[*]`'s asset (11 entries today). Each entry: `assetId`, `outputHash` (sha256 of the synthesized patched bytes for that asset), `byteSize`.
- Top-level `outputHash`: the rollup from §3.3 over `touchedAssets`.
- No `failures`, no `failureCategories`, no `partialWrite` (it's the success path).
- Existing `sourceCompatibility` block is **unchanged** (still proves the contract round-trips on the happy path).

### 4.2 Generator location

The generator that produces this fixture lives in `packages/localization-bridge-schema/src/synthetic-large-project.ts` or a sibling under hello-game tooling — the implementer must run `just hello` (or the underlying `pnpm` task) and the rebuilt fixture must commit clean. The actual generator code change is part of the slice but its filename is to be determined by the implementer based on the existing hello-game build wiring; the contract is: the JSON above is regenerated, not hand-rolled.

### 4.3 Determinism

Synthetic asset bytes must be deterministic across Linux/macOS so the per-asset `outputHash` does not drift between contributors. The generator uses byte-literal `b"..."` payloads, **not** locale-formatted strings. Hash algorithm: `sha256` (no choice — already mandated by `HASH_ALGORITHMS` line 546).

---

## 5. Itotori Ingestion

### 5.1 New CLI command

`apps/itotori/src/cli-handlers.ts` gains:

```ts
case "ingest-patch-result":
  await runIngestPatchResult(args, dependencies);
  break;
```

with `runIngestPatchResult` taking `--project <path>`, `--patch-result <path>`, `--output <path>`. The handler reads the JSON, calls `assertPatchResultV02`, then invokes `services.projectWorkflow.ingestPatchResult(project, patchResult)`.

### 5.2 New service method on `ItotoriProjectWorkflowPort`

In `apps/itotori/src/services/project-workflow.ts`:

```ts
ingestPatchResult(
  project: ProjectState,
  patchResult: PatchResultV02,
): Promise<{
  project: ProjectState;
  result: {
    patchResultId: string;
    patchExportId: string;
    status: PatchResultStatusV02;
    diagnostics: PatchResultIngestionDiagnostic[];
  };
}>;
```

`PatchResultIngestionDiagnostic` shape:

```ts
type PatchResultIngestionDiagnostic = {
  code: string;       // one of the kaifuu.patch_result.* constants from §2.5
  message: string;
  pointer?: string;   // JSON-Pointer into the input
};
```

### 5.3 Mandatory rejection paths

The implementation enforces three boundary checks **in addition to** the schema asserter (the asserter catches structural failures; the boundary catches cross-artifact failures):

1. **Missing failure category** — already caught by `assertPatchResultV02`. The boundary re-raises it as `code: "kaifuu.patch_result.missing_failure_category"` so the diagnostic stream is uniform.
2. **Mismatched patch export id** — `patchResult.patchExportId !== project.patchExport.patchExportId` ⇒ throw with `code: "kaifuu.patch_result.mismatched_export_id"`. This is a project-level cross-check the schema cannot do alone.
3. **Output-hash drift** — when `status === "passed"`, recompute the rollup from `touchedAssets` (§3.3 formula) and compare against `outputHash`. The schema asserter already does this; the boundary additionally compares against the project's recorded `patchExport.expectedOutputHash` if present (future-field; if absent, skip), and against any previously-ingested PatchResult for the same `patchExportId`. Drift ⇒ `code: "kaifuu.patch_result.output_hash_drift"`.
4. **Silent partial-write guard** — `status === "passed"` with `partialWrite` present, or `status === "failed"` with `partialWrite.disposition === "retained_partial"` without a referenced finding ⇒ raise a P0 finding via `recordFinding` with `code: "kaifuu.patch_result.silent_partial_write"`. (Strictly: `retained_partial` is allowed only when accompanied by an open finding referencing this patch result.)

Each rejection produces a `DeterministicPreExportQaError`-shaped exception so the CLI exit code is consistent with existing export-patch behavior.

### 5.4 Persistence

Mirror existing `savePatchExport` style: add `repository.savePatchResult(actor, project, patchResult, diagnostics)` and a dashboard view update analogous to runtime-report ingestion (see `saveRuntimeReport` lines 281–286). Schema migration for the underlying DB (in `@itotori/db`) is **deferred** — KAIFUU-010 only requires an in-memory ingest path with diagnostics. The DB persistence is recorded as a follow-up in §13 (it does not block ALPHA-006's patching vertical, which only needs the ingest-and-diagnose loop).

### 5.5 Tests (new file `apps/itotori/test/ingest-patch-result.test.ts`)

Test cases (one per rejection path + one positive):

- Positive: hello-game v0.2 passed report ⇒ no diagnostics, project state updated.
- Missing failure category: feed `patch-result-v0.2-missing-failure-category.json` ⇒ schema-stage rejection, code `kaifuu.patch_result.missing_failure_category`.
- Mismatched export id: a hand-built valid v0.2 report whose `patchExportId` ≠ project's ⇒ boundary-stage rejection.
- Output-hash drift: feed `patch-result-v0.2-output-hash-mismatch.json` ⇒ schema-stage rejection.
- Silent partial write: feed `patch-result-v0.2-partial-write.json` plus a variant with `retained_partial` and no finding ⇒ recorded as P0 finding.

---

## 6. Engine-Side Mapping (KAIFUU-174 RealLive)

KAIFUU-010 does **not** rewrite the RealLive patchback emitter. It specifies the mapping table that the future emitter (or a thin adapter layer in `kaifuu-reallive` or `kaifuu-cli`) will use to translate `PatchBackError` into the shared `PatchFailureV02`:

| `PatchBackErrorCode`         | `PatchFailureCategoryV02`     | `diagnosticCode` (verbatim from `patchback.rs` lines 54–63) |
| ---------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `OffsetOverflow`             | `patch_write_failed`          | `kaifuu.reallive.patchback_offset_overflow`                 |
| `ShiftJisEncodeFailure`      | `patch_write_failed`          | `kaifuu.reallive.patchback_shift_jis_encode_failure`        |
| `UnsupportedLengthPolicy`    | `adapter_unsupported`         | `kaifuu.reallive.patchback_unsupported_length_policy`       |
| `ParserRegression`           | `patch_write_failed`          | `kaifuu.reallive.patchback_parser_regression`               |
| `UnknownSlotId`              | `asset_missing`               | `kaifuu.reallive.patchback_unknown_slot_id`                 |
| `StaleSourceHash`            | `source_incompatible`         | `kaifuu.reallive.patchback_stale_source_hash`               |
| `ProtectedSpanLost`          | `protected_span_violation`    | `kaifuu.reallive.patchback_protected_span_lost`             |

The mapping table is the **only** RealLive-side artifact this slice produces (as Rust `const` or `match`). The `assetId`/`bridgeUnitId`/`adapterId: "kaifuu-reallive"`/`command` fields are filled by the caller that wraps `apply_patches` — KAIFUU-010 does not pick that caller; KAIFUU-011 (binary patcher composed smoke) is the natural consumer.

---

## 7. Migration

### 7.1 v0.1 → v0.2 path

1. **Phase A (this slice):** v0.2 ships. v0.1 type `PatchResult` (line 89) stays as a deprecated alias `PatchResultV01`. Existing v0.1 consumers compile unchanged.
2. **Phase B (KAIFUU-011 + ALPHA-006 work):** v0.1 producers (none today in the worktree; verified via `grep -rn "PatchResult[^V]" apps/itotori/src crates/`) are migrated. The hello-game golden v0.1-shaped artifact remains in fixtures only for round-trip parity tests.
3. **Phase C (post-ALPHA-006):** v0.1 type and `PatchResult` export are removed. This deletion is **out of scope** for KAIFUU-010 (see §12).

### 7.2 Cross-call adapters

No `PatchResultV01 → PatchResultV02` converter is shipped: the v0.1 shape lacks the per-failure cite fields, so a converter would have to invent unknowable data and would violate "no silent partial success." Producers must emit v0.2 natively.

---

## 8. Semantic Codes (single source of truth)

All semantic codes used across this slice are listed below. Each appears in either §2.5 (Rust constants) or as the `code` string in §5.3 (Itotori diagnostics). The TS schema messages embed these strings verbatim so cross-language search returns the same hits.

| Code                                                            | Surface                                | When raised                                                  |
| --------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `kaifuu.patch_result.missing_failure_category`                  | TS asserter, Rust validator, Itotori   | `failureCategories` missing or shorter than dedup(failures). |
| `kaifuu.patch_result.unknown_failure_category`                  | TS asserter, Rust validator            | `failureCategories` contains a value not in dedup(failures). |
| `kaifuu.patch_result.mismatched_export_id`                      | Itotori boundary                       | Result's `patchExportId` ≠ project's recorded export id.     |
| `kaifuu.patch_result.output_hash_drift`                         | TS asserter, Rust validator, Itotori   | Rollup of `touchedAssets[].outputHash` ≠ `outputHash`.       |
| `kaifuu.patch_result.passed_requires_output_hash`               | TS, Rust                               | `status: "passed"` but `outputHash` missing.                 |
| `kaifuu.patch_result.passed_requires_touched_assets`            | TS, Rust                               | `status: "passed"` but `touchedAssets` empty or missing.     |
| `kaifuu.patch_result.passed_must_have_no_failures`              | TS, Rust                               | `status: "passed"` with non-empty `failures`.                |
| `kaifuu.patch_result.passed_must_omit_failure_categories`       | TS, Rust                               | `status: "passed"` with `failureCategories` present.         |
| `kaifuu.patch_result.passed_must_omit_partial_write`            | TS, Rust                               | `status: "passed"` with `partialWrite` present.              |
| `kaifuu.patch_result.non_passed_requires_failures`              | TS, Rust                               | `status: "failed"` or `incompatible_source` with no failures. |
| `kaifuu.patch_result.incompatible_source_category_required`     | TS, Rust                               | Any non-`source_incompatible` failure on `incompatible_source` status. |
| `kaifuu.patch_result.silent_partial_write`                      | TS, Rust, Itotori                      | `attemptedAssetIds` ≠ `writtenAssetIds ∪ skippedAssetIds`, or `retained_partial` without finding. |
| `kaifuu.patch_result.rollback_diagnostic_required`              | TS, Rust                               | Disposition ∈ `{rolled_back, cleaned_up}` without `rollbackDiagnosticCode`. |
| `kaifuu.patch_result.source_incompatible`                       | Engine adapter (RealLive mapping)      | Used as `diagnosticCode` when wrapping a `StaleSourceHash`.  |

---

## 9. Test Plan

### 9.1 TS schema tests

File: `packages/localization-bridge-schema/test/contracts.test.ts` (existing). Add cases:

- 4 negative fixtures × 1 case each (each asserts the specific semantic substring).
- 1 positive: load `fixtures/hello-game/expected/patch-result-v0.2.fr-FR.json` and assert it passes `assertPatchResultV02` clean.
- Invariant edge cases (Rust-only by §3.4 partial-write second variant; TS catches the rest).
- Round-trip: `assertContractFixtureV02({ kind: "patch-result-v0.2", value: ... })` matches `assertPatchResultV02(value)` exactly (no double-error, no skipped check).

### 9.2 Rust contract tests

File: `crates/kaifuu-core/src/contracts.rs` `#[cfg(test)] mod tests` (existing block around line 2545+) and/or sibling `tests/contracts_patch_result_v02.rs`. Add:

- Each rejection in §8 produces an error whose message contains the semantic code.
- The 4 invalid fixture files are loaded and validated; assert each fails with the expected code (use `serde_json::from_str` against the JSON files via `include_str!`).
- Positive: the hello-game expected report loads and validates with no error.
- Round-trip: `validate_bridge_contract_fixture` for `"patch-result-v0.2"` dispatches correctly.

### 9.3 Itotori ingestion tests

File: `apps/itotori/test/ingest-patch-result.test.ts` (new). Cases listed in §5.5.

### 9.4 hello-game integration

The synthetic baseline pipeline already emits the expected file. After regeneration (§4), running `just hello` must produce a fixture that matches the committed `patch-result-v0.2.fr-FR.json` byte-for-byte. The check is a golden-compare assertion already wired for the other hello-game expected files.

### 9.5 Documentation

`docs/subprojects-kaifuu.md` v0.2 patch result section: append a short subsection citing the new categories and the output-hash rollup formula. `docs/subprojects-itotori.md` ingestion section: append the new `ingest-patch-result` command. `docs/testing-standard.md` is **not** modified (the standard already covers negative fixtures; this slice adds four more without changing the standard).

---

## 10. Verification Commands

Run in the worktree:

```bash
cargo test -p kaifuu-core contracts          # §9.2
pnpm exec vp run ts:test                     # §9.1, §9.3
just check                                   # lint + types
just hello                                   # synthetic baseline regenerates fixture; golden-compare passes
just test                                    # full sweep
```

The DAG also names `just contract-validate`; that target is run by `just check` (verified in justfile pre-existing wiring) and does not need a separate invocation.

---

## 11. Risks

1. **TS/Rust schema drift.** Two validators must be kept in lock-step. Mitigation: shared semantic-code constants (§2.5, §8) make divergence detectable via grep; tests in §9.1 and §9.2 share the same fixture set under `packages/localization-bridge-schema/test/examples/invalid/` (Rust uses `include_str!`).
2. **v0.1 migration breakage.** The plan keeps v0.1 as a deprecated alias; v0.2 is additive at the file level. The risk is a transitive `@itotori/localization-bridge-schema` consumer that imports `PatchResult` and expects the loose `failures: string[]`. Mitigation: `grep -rn "PatchResult[^V]" apps/ crates/` before merge; today the search returns only the existing schema file itself.
3. **Output-hash determinism across platforms.** Rollup formula in §3.3 is fixed UTF-8 + LF + sorted by `assetId`, but the **per-asset** hash for hello-game must come from byte-deterministic synthetic input (§4.3). Risk: a generator that uses `String::from_utf8` on locale-dependent input would yield different hashes on Windows runners. Mitigation: generator uses fixed byte arrays; CI test runs on Linux today, but the plan documents the constraint so future Windows CI does not surprise us.
4. **Partial-write rollback semantics.** `retained_partial` is the trap door for adapters that physically cannot roll back. It is **not** silent because §5.3 rule 4 requires a P0 finding. Risk: implementers forget the finding-required rule and ship a quietly-passing path. Mitigation: the test in §5.5 asserts the finding is recorded; the invariant is also enforceable in the schema (§1.3) but cannot be without a project-side cross-check, hence the Itotori boundary handles it.
5. **Hello-game fixture churn.** Any change to the synthetic source bytes will rotate every hash. Mitigation: regenerate-then-commit is the standard hello-game flow; this slice does not change source bytes, only adds derived fields. Risk is low.

---

## 12. Out of Scope

- `KAIFUU-011` (Binary patcher composed smoke command). Will *consume* the v0.2 emitter wired here.
- `UTSUSHI-146` runtime port. Runtime verification reports use a different schema (`RuntimeEvidenceReportV02`).
- `ALPHA-006` vertical itself.
- Persistence of patch results in `@itotori/db` (deferred per §5.4).
- Removal of v0.1 `PatchResult` type (Phase C in §7.1).
- v0.2 patch *export* changes — the existing v0.1 `exportPatch` path (`project-workflow.ts` line 220) remains untouched. v0.2 export is a separate node.
- Engine-side wrapper that actually emits `PatchResultV02` from `apply_patches` results in RealLive. KAIFUU-010 specifies the mapping table (§6); the wrapper lands in KAIFUU-011.

---

## 13. Worker Scoping

One worker, two-language span (TS + Rust + minimal Itotori TS).

| Slice           | Surfaces touched                                                                                                                                                                                       | Estimated effort |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **A** (TS only) | `packages/localization-bridge-schema/src/index.ts`, the 4 fixtures in `test/examples/invalid/`, contract tests.                                                                                          | ~½ day           |
| **B** (Rust + Itotori) | `crates/kaifuu-core/src/contracts.rs`, `crates/kaifuu-core/src/lib.rs` (semantic constants), `apps/itotori/src/cli-handlers.ts`, `apps/itotori/src/services/project-workflow.ts`, hello-game generator + fixture, ingestion tests. | ~1 day           |

**Recommendation: one worker** runs both slices in sequence (A → B). The contract change is cohesive: splitting would force B to mock A's schema export, and any drift between the two would re-emerge as a CI flake. The two-language span is a feature of this DAG node, not a reason to split.

If parallelism is forced (e.g. capacity), Slice A must merge before Slice B starts; B depends on A's exports.

---

## 14. Process

1. Implement Slice A; verify §9.1 passes.
2. Implement Slice B; verify §9.2, §9.3, §9.4 pass.
3. Run §10 commands top-to-bottom; all green.
4. Update `docs/subprojects-kaifuu.md` + `docs/subprojects-itotori.md` per §9.5.
5. Commit per the existing repo conventions (one feat commit per slice, plus a fixture-regeneration commit if §4 is rebuilt).

End of plan.
