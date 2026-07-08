# KAIFUU-176 — Itotori Vault-Source localCorpus Adapter — Implementation Plan

| Field              | Value                                                                             |
| ------------------ | --------------------------------------------------------------------------------- |
| DAG node           | `KAIFUU-176`                                                                      |
| Title              | Itotori vault-source localCorpus adapter                                          |
| Branch             | `spec/kaifuu-176`                                                                 |
| Worktree           | `/scratch/worktrees/itotori-spec-kaifuu-176`                                      |
| Plan author        | planning worker (orchestrator-spawned)                                            |
| Plan date          | 2026-06-23                                                                        |
| Contract of record | [`docs/itotori-vault-source-adapter.md`](../docs/itotori-vault-source-adapter.md) |
| Output file        | `.plan/KAIFUU-176.md` (this file)                                                 |

Citations of the form _(Contract: §Section)_ refer to the heading in
`docs/itotori-vault-source-adapter.md`. The plan is deliberately terse: contract
prose is the source of truth; this plan only fixes structure.

---

## 1. Crate Placement

**Decision:** introduce a new workspace crate `crates/kaifuu-vault-source/`.

Rationale, surveyed against current layout (`crates/kaifuu-core`,
`crates/kaifuu-delta`, `crates/kaifuu-engine-fixture`, `crates/kaifuu-cli`,
`crates/utsushi-*`):

- `kaifuu-core` today is engine-adapter contract + capability/profile/bridge
  logic + offset/string-relocation code (≈22.5 kLOC `lib.rs`, plus 6.2 kLOC
  `contracts.rs`). It currently has **only** `serde` + `serde_json` as
  dependencies. Adding `rusqlite` + a sha256 + a 7z extractor here would expand
  its dep surface substantially and pull SQLite into every downstream user of
  the existing engine-adapter contract. That is the wrong direction.
- The vault-source adapter is **not** an `EngineAdapter`. It feeds Kaifuu and
  Itotori a directory; it does not detect/extract/patch/verify. So it should
  not live in the `EngineAdapter`-shaped crates.
- Existing pattern: per-engine functionality is its own crate
  (`kaifuu-engine-fixture`). Mirroring that, the vault source is a sibling
  crate `kaifuu-vault-source`.

Workspace `Cargo.toml` (`/scratch/worktrees/itotori-spec-kaifuu-176/Cargo.toml`)
gains the new member; `workspace.dependencies` adds `rusqlite`, `sha2`,
`sevenz-rust2`, `jsonschema` (see §6 and §7 for extractor and validator
decisions).

`kaifuu-core` is **not** modified by this slice except possibly to receive
a `pub const SEMANTIC_VAULT_*` constant block if the orchestrator later
prefers central semantic-code definition; the initial slice keeps them inside
the new crate to avoid coupling.

---

## 2. Module Boundaries

```
crates/kaifuu-vault-source/
  Cargo.toml
  src/
    lib.rs            // re-exports; module wiring; high-level VaultSource type
    config.rs         // cross-OS path resolution; ITOTORI_VAULT_ROOT / SCRATCH; retention enum
    catalog.rs        // rusqlite mode=ro open; schema_version probe; query types
    discovery.rs      // claim shape; SQL for works/producers/releases/v_current_facts
    resolution.rs     // release-id -> artifact rows; by-sha path layout; size+sha verify
    extraction.rs     // 7z stream + path-traversal rejection + per-run scratch layout
    metadata.rs       // _vault/metadata.json parse, JSON-Schema validate, cross-check
    findings.rs       // v_facts_needs_review-shaped finding records (in-memory only)
    source.rs         // localCorpus source trait impl + adapter registration glue
    error.rs          // typed VaultSourceError enum (one variant per Failure Mode row)
    paths.rs          // game-id derivation (vndb v / dlsite rj/vj/bj / egs / slug+rel)
    retention.rs      // retention-policy state machine; per-run + per-game cleanup
  tests/
    fixtures/
      synthetic-vault/
        catalog.db                          // built at test-time via build.rs from .sql seed
        seed.sql                            // committed; deterministic INSERTs
        artifacts/by-sha/<aa>/<bb>/<hash>.7z // small synthetic archives
        embedded-metadata.schema.json       // copy of upstream contract (versioned)
    discovery_test.rs
    resolution_test.rs
    extraction_test.rs
    metadata_test.rs
    contract_failure_modes_test.rs
```

### Public surface (contract-level sketch)

```rust
// lib.rs
pub use config::{VaultConfig, RetentionPolicy, ScratchConfig, GameIdSource};
pub use error::VaultSourceError;
pub use discovery::{ClaimQuery, ReleaseCandidate};
pub use resolution::{ResolvedArtifact, ArtifactSelection};
pub use extraction::{ExtractedTree, ScratchPaths};
pub use metadata::{EmbeddedMetadata, CrossCheckOutcome, CrossCheckFinding};
pub use source::{LocalCorpusSource, VaultSource, MaterializeResult};

pub struct VaultSource { /* holds VaultConfig; opens read-only catalog per call */ }

impl LocalCorpusSource for VaultSource {
    fn discover(&self, claim: &ClaimQuery)
        -> Result<Vec<ReleaseCandidate>, VaultSourceError>;
    fn materialize(&self, candidate: &ReleaseCandidate, opts: MaterializeOptions)
        -> Result<MaterializeResult, VaultSourceError>;
    fn release(&self, materialized: MaterializeResult)
        -> Result<(), VaultSourceError>; // honours RetentionPolicy
    fn capabilities(&self) -> LocalCorpusCapabilityReport;
}

pub struct MaterializeResult {
    pub game_id: String,
    pub run_id: String,
    pub extracted_root: PathBuf,         // <scratch>/<game-id>/<run-id>/extracted/
    pub subpath_root: Option<PathBuf>,   // <extracted_root>/<subpath> when applicable
    pub embedded: EmbeddedMetadata,
    pub findings: Vec<CrossCheckFinding>,
    pub artifact_sha256: String,
    pub release_id: i64,
}
```

`LocalCorpusSource` is introduced **here** as a new trait (no Rust-side
`localCorpus` registry exists today; the existing localCorpus surface is
TypeScript/DB-only, see `packages/itotori-db/src/schema.ts:153` and the
catalog source columns). See §8 for registration.

---

## 3. Catalog Query Layer

Open: `rusqlite::Connection::open_with_flags` using URI
`file:<vault-root>/catalog.db?mode=ro&immutable=0` with `OPEN_READ_ONLY |
OPEN_URI`. No `PRAGMA` writes; _(Contract: §Read-only Contract)_.

Probe step (run once per `VaultSource::open`):

```sql
SELECT MAX(version) FROM schema_version;
```

If the row is absent or `> SUPPORTED_SCHEMA_VERSION` (initial: `1`, matching
`/archive/vault/schema.sql:19`), raise `CatalogSchemaUnsupported`.

### Discovery queries (`discovery.rs`)

`ClaimQuery` is a tagged enum mirroring the contract's allowed entry vectors
_(Contract: §Discovery)_:

```rust
enum ClaimQuery {
    ByExternalId   { source: String, kind: String, value: String }, // identifiers
    ByWorkTitle    { language: Option<String>, title: String },     // work_titles + works.canonical_title
    ByProducer     { producer_external_id: ExternalId },            // producer_identifiers join
    ByEngineClaim  { engine: String, engine_version: Option<String> }, // v_current_facts
    ByReleaseId    { release_id: i64 },                             // direct
    ByArtifactSha  { sha256: String },                              // catalog-bypass mode (flag)
}
```

Representative SQL (parameter-bound; no string interpolation):

```sql
-- Discovery: claimed-engine releases
SELECT r.id, r.work_id, r.edition_name, r.release_date, r.store
FROM releases r
JOIN works w ON w.id = r.work_id
JOIN v_current_facts vcf
  ON vcf.entity_type = 'release'
 AND vcf.entity_id   = r.id
 AND vcf.field       = 'engine'
WHERE vcf.value = :engine;

-- Discovery: by external id
SELECT r.id, r.work_id
FROM identifiers i
JOIN releases r ON r.work_id = i.work_id
WHERE i.source = :source AND i.kind = :kind AND i.value = :value;

-- Per-candidate: engine-version, review-flag, languages/platforms
SELECT field, value FROM v_current_facts
WHERE entity_type = 'release' AND entity_id = :release_id
  AND field IN ('engine','engine_version');

SELECT 1 FROM v_facts_needs_review
WHERE entity_type = 'release' AND entity_id = :release_id
  AND field = 'engine' LIMIT 1;

SELECT language_code FROM release_languages WHERE release_id = :release_id;
SELECT platform     FROM release_platforms WHERE release_id = :release_id;
SELECT source, kind, value FROM identifiers WHERE work_id = :work_id;
```

### Resolution queries (`resolution.rs`)

```sql
SELECT ra.role, ra.subpath, a.id, a.sha256, a.size_bytes,
       a.original_sha256, a.artifact_kind, a.vault_path
FROM release_artifacts ra
JOIN artifacts a ON a.id = ra.artifact_id
WHERE ra.release_id = :release_id
ORDER BY CASE ra.role
           WHEN 'primary' THEN 0 WHEN 'bundle_member' THEN 1
           WHEN 'volume_part' THEN 2 WHEN 'patch' THEN 3
           WHEN 'translation' THEN 4 WHEN 'dlc' THEN 5
           WHEN 'crack' THEN 6 WHEN 'docs' THEN 7
         END;
```

`ArtifactSelection { primary_only, include_roles: HashSet<Role> }` controls
which rows are returned to the caller _(Contract: §Resolution)_. `vault_path`
is read but **never used to construct the on-disk path**; it is informational.

Every connection is opened per discovery call and dropped at the end; no
cross-run cache _(Contract: §Discovery — "does not cache the catalog")_.

---

## 4. Resolver

For each selected artifact:

1. Construct path purely from `sha256`:
   `<vault-root>/artifacts/by-sha/<sha[0:2]>/<sha[2:4]>/<sha>.7z`
2. `fs::symlink_metadata` (not `metadata`) → must be a regular file. Reject
   symlinks → `ArtifactMissing`.
3. Compare `metadata.len()` with `artifacts.size_bytes`. Mismatch →
   `ArtifactSizeMismatch { expected, actual, path, sha256 }` _before_ opening
   for read.
4. Stream the file through `sha2::Sha256` in fixed-size chunks (e.g. 1 MiB).
   Final digest must equal `artifacts.sha256`. Mismatch →
   `ArtifactHashMismatch { expected, actual, path }`.
5. `by-name/` is never consulted, listed, or stat-ed _(Contract: §Resolution)_.

Resolver returns a `ResolvedArtifact { id, role, subpath, sha256, size_bytes,
on_disk_path, original_sha256 }`.

---

## 5. Extractor

### Scratch layout

`<scratch_root>/<game_id>/<run_id>/extracted/` per _(Contract: §Extraction,
§Scratch and Secret Custody)_.

- `<scratch_root>` resolved by `ScratchConfig` (§7).
- `<game_id>` derived deterministically (`paths.rs`):
  1. VNDB `v`-id (`identifiers.source='vndb' AND kind='v'`).
  2. DLsite `RJ/VJ/BJ` (`identifiers.source='dlsite' AND kind IN ('rj','vj','bj')`).
  3. EGS `id` (`identifiers.source='egs' AND kind='id'`).
  4. `slug(works.canonical_title) + "-r" + release_id`.
- `<run_id>` = uuidv7 (call into `uuid` crate via workspace dep, or accept
  a caller-supplied id; default to internally generated for adapter callers).

### Extraction tool — **decision**

**Use `sevenz-rust2` (pure Rust crate, MIT/Apache-2.0).**

Rationale (resolves the policy question called out in the prompt):

- The workspace has **no existing 7z handling** (`grep` on `crates/`,
  `Cargo.toml`, and `Cargo.lock` returns no 7z dep). There is therefore no
  prior pattern to align with.
- `docs/subprojects-kaifuu.md` codifies _no shell-outs_ — but explicitly
  scopes that to _foreign localization tools_ (GARbro/KrkrExtract/etc.). A
  generic system `7z` binary is a different category, the contract names
  `7z x` as the default extractor _(Contract: §Extraction)_, and operationally
  shelling to `7z` would be acceptable.
- However: a Rust crate is preferable because (a) it removes the system
  dependency (cross-OS portability, the contract's third operating commitment),
  (b) it lets us reject path-traversal entries **before any file write** in
  pure Rust without parsing `7z` stderr, and (c) it lets us drive
  size/streaming and cancellation semantics directly. The adapter remains
  pure-Rust like the rest of Kaifuu.
- `sevenz-rust2` is the active fork of `sevenz-rust`; both have been
  reviewed for license/maturity. The plan picks `sevenz-rust2` as primary
  with the implementation worker authorized to swap to `sevenz-rust` if
  license/audit review prefers it.

The orchestrator should explicitly confirm this choice before the
implementation worker lands code; the alternative (shell out to `7z`) is
documented in §13 as a contingency.

### Pre-write safety

`extraction.rs` iterates archive entries and, for each entry path, enforces
all of the following before any byte is written _(Contract: §Extraction)_:

- Normalise the entry path using `Path::components` rejecting
  `Component::ParentDir` and `Component::RootDir` and `Component::Prefix`
  outright → `ExtractionUnsafePath { entry, reason: "parent-dir" | ... }`.
- Reject absolute paths and Windows drive prefixes.
- Reject any entry whose canonicalised target is not strictly under
  `<extracted_root>`.
- Reject entries inside `_vault/` whose basename is not `metadata.json`
  (or a future schema-permitted sibling; the schema lists none today).
- Reject 7z entries that would create a symlink target outside the root.

On any rejection, the partial extraction directory is removed and
`ExtractionUnsafePath` is returned. The `<run-id>/` directory is also removed
on truncated/decompression failure; `ExtractionFailed { source, archive_path,
bytes_written }` is returned. No partial extraction is ever surfaced to the
caller _(Contract: §Extraction — "Partial extractions are not used")_.

### Retry semantics

The adapter does not auto-retry. Callers can retry by calling `materialize`
again with the same `RetentionPolicy`; under `keep-extracted-for-game`,
re-extraction is triggered iff the on-disk archive sha256 mismatches the
cached previous hash file (`<scratch>/<game-id>/.last-artifact-sha256`).
Otherwise the existing `extracted/` is reused as-is _(Contract: §Scratch and
Secret Custody — "still verifies the artifact sha256 each run")_.

---

## 6. Embedded-Metadata Cross-Check

`_vault/metadata.json` is the **first** file read post-extraction _(Contract:
§Extraction → §Cross-checking via Embedded Metadata)_.

### Validation

- Parse via `serde_json`. Missing → `EmbeddedMetadataMissing { extracted_root,
artifact_sha256 }`.
- Validate against
  `<vault-root>/embedded-metadata.schema.json` using `jsonschema` crate
  (draft 2020-12). Schema is loaded once per `VaultSource` and cached in
  memory (the schema file is read at vault-validation time alongside
  `catalog.db`/`artifacts/by-sha/`). Failure →
  `EmbeddedMetadataInvalid { errors: Vec<String>, schema_version }`.

### Field-by-field cross-check

For the artifact selected:

| Embedded field                                                           | Catalog field                                    | Default disposition on mismatch                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `vault_artifact.original_sha256`                                         | `artifacts.original_sha256` (when both non-null) | Finding                                                                        |
| `releases[].work.identifiers` (any ∈ catalog `identifiers` for the work) | `identifiers` table                              | **Error** `CatalogEmbeddedMismatch` (work identity) when intersection is empty |
| `releases[].platforms`                                                   | `release_platforms`                              | Finding (catalog wins)                                                         |
| `releases[].languages`                                                   | `release_languages`                              | Finding (catalog wins)                                                         |
| `releases[].role`                                                        | `release_artifacts.role`                         | Finding                                                                        |

The default tolerance is exactly the contract default _(Contract: §Cross-checking
via Embedded Metadata — "default threshold rejects mismatched work identity and
accepts everything else with a finding")_. A future tolerance struct
(`CrossCheckTolerance`) is sketched but `Default` yields the contract default.

### Finding shape

`findings.rs` emits `CrossCheckFinding`:

```rust
pub struct CrossCheckFinding {
    pub entity_type: String,    // "work" | "release" | "artifact"
    pub entity_id: i64,
    pub field: String,          // e.g. "languages", "platforms", "role", "original_sha256"
    pub catalog_value: serde_json::Value,
    pub embedded_value: serde_json::Value,
    pub source: &'static str,   // "vault:embedded"
    pub evidence: &'static str, // "direct_observation"
}
```

Shape mirrors a `v_facts_needs_review` row _(Contract: §Cross-checking via
Embedded Metadata)_. The adapter **never writes to `catalog.db`** — findings
are returned in `MaterializeResult.findings` for the caller (Kaifuu or the
itotori findings sink) to route to vault-curation.

### Catalog-bypass mode

When `ClaimQuery::ByArtifactSha` is used, discovery is skipped, the artifact
is resolved purely by sha (still via `by-sha/`), extracted, and the embedded
metadata is parsed without cross-check. The result carries a
`materialization_kind: CatalogBypass` flag and a finding noting that catalog
resolution was bypassed _(Contract: §Cross-checking via Embedded Metadata —
"this is allowed but always flagged")_.

---

## 7. `localCorpus` Source Registration

Today the `localCorpus` concept exists in two places:

- TypeScript / DB layer: `packages/itotori-db/src/schema.ts:153` defines
  `localCorpus: "local_corpus"`; multiple migrations
  (`packages/itotori-db/migrations/0008..0017_*.sql`) declare it as a
  `catalogSource` enum value.
- The Rust `EngineAdapter` trait does **not** expose a localCorpus surface.

There is no existing Rust-side trait that "a thing Kaifuu can read game bytes
from" plugs into. This crate introduces it:

```rust
// kaifuu-vault-source::source
pub trait LocalCorpusSource: Send + Sync {
    fn source_id(&self) -> &'static str;          // "vault"
    fn discover(&self, claim: &ClaimQuery)
        -> Result<Vec<ReleaseCandidate>, VaultSourceError>;
    fn materialize(&self, candidate: &ReleaseCandidate, opts: MaterializeOptions)
        -> Result<MaterializeResult, VaultSourceError>;
    fn release(&self, materialized: MaterializeResult)
        -> Result<(), VaultSourceError>;
    fn capabilities(&self) -> LocalCorpusCapabilityReport;
}

pub struct LocalCorpusRegistry { /* Vec<Box<dyn LocalCorpusSource>> */ }
```

`VaultSource: LocalCorpusSource` is the only initial implementor. The
registry is callable from both:

- `kaifuu-cli` (a new subcommand or a flag on existing commands —
  out of scope here; tracked as a follow-up node), and
- itotori run paths once they integrate (the spec-dag note
  "consumable by Kaifuu and Itotori runs" is satisfied by exposing the
  trait as a public Rust API; downstream wiring is a separate node).

Bridge to the TypeScript `catalogSource: "local_corpus"` is **not** done in
this slice: the adapter does not write to `catalog.db` or to the itotori
DB. The mapping happens when a future catalog-source-adapter consumes
`MaterializeResult` and inserts rows with `catalogSource = local_corpus`.

### Capability report

```rust
pub struct LocalCorpusCapabilityReport {
    pub source_id: &'static str,                   // "vault"
    pub vault_root: PathBuf,                       // canonicalised
    pub schema_version: u32,
    pub supported_artifact_roles: Vec<String>,     // primary, bundle_member, ...
    pub retention_policy_default: RetentionPolicy,
    pub read_only: bool,                           // always true
    pub findings_sink_required: bool,              // true
}
```

This mirrors the existing `CapabilityReport` ergonomics in `kaifuu-core` but
does **not** depend on `kaifuu-core` to keep the dep direction clean (the
shapes overlap only conceptually).

### Cross-OS path resolution (`config.rs`)

Resolution order _(Contract: §Cross-OS Path Resolution)_:

1. `ITOTORI_VAULT_ROOT` env var.
2. A `VaultConfig::vault_root_override` field (callers wire user config in).
3. Platform default:
   - `cfg!(target_os = "linux")` → `/archive/vault/`
   - `cfg!(target_os = "macos")` → `dirs::data_dir().join("itotori/vault")`
     (≈ `~/Library/Application Support/itotori/vault/`).
   - `cfg!(target_os = "windows")` → `dirs::data_local_dir().join("itotori\\vault")`
     (≈ `%LOCALAPPDATA%\itotori\vault\`).

`ScratchConfig` follows the same shape (`ITOTORI_SCRATCH_ROOT`,
`scratch_root_override`, defaults `/scratch/itotori/`,
`~/Library/Caches/itotori/`, `%LOCALAPPDATA%\itotori\scratch\`).

Validation at startup: assert `catalog.db` is a regular file and
`artifacts/by-sha/` is a directory under the canonicalised root. Failure →
`VaultRootMissing` (root absent or not a dir) or `VaultRootIncomplete`
(root present but missing required children) — the contract distinguishes
these two cases.

---

## 8. Secrets Boundary

The vault-source adapter has **no** read/write relationship with the secret
store. `.kaifuu/secrets.local/<game-id>/` is mode 0600, gitignored, owned
by the running user — these properties belong to whichever Kaifuu component
needs keys, not to this adapter.

This crate explicitly:

- Does not read `.kaifuu/secrets.local/`.
- Does not write to `.kaifuu/secrets.local/`.
- Does not place any secret near `<vault-root>` or `<scratch-root>`.
- Does not log secret values; secret-bearing fact rows from `facts`/
  `v_current_facts` are not in the queries above and would be surfaced only
  if the caller explicitly opts in via a future `ClaimQuery` extension
  (out of scope for this slice).

The intent is to make the adapter's non-relationship with secrets auditable
and to keep the contract bullet _(Contract: §Scratch and Secret Custody)_
provably satisfied by inspection of this crate's source.

---

## 9. Failure-Mode Mapping

`error.rs` defines `VaultSourceError`, one variant per row in the
_(Contract: §Failure Modes)_ table. Every variant carries enough context
for an operator to act without re-running discovery.

```rust
#[derive(Debug, thiserror::Error)]
pub enum VaultSourceError {
    #[error("vault root missing: {path:?}")]
    VaultRootMissing { path: PathBuf },

    #[error("vault root incomplete: {path:?} missing {missing}")]
    VaultRootIncomplete { path: PathBuf, missing: &'static str },

    #[error("catalog.db could not be opened read-only: {path:?}: {source}")]
    CatalogOpenFailed { path: PathBuf, #[source] source: rusqlite::Error },

    #[error("catalog schema unsupported: observed={observed:?}, supported={supported}")]
    CatalogSchemaUnsupported { observed: Option<u32>, supported: u32 },

    #[error("no release resolved for claim {claim_summary}")]
    ReleaseNotResolved { claim_summary: String },

    #[error("artifact missing on disk: {path:?} sha256={sha256}")]
    ArtifactMissing { path: PathBuf, sha256: String, release_id: i64, artifact_id: i64 },

    #[error("artifact size mismatch at {path:?}: expected={expected} actual={actual}")]
    ArtifactSizeMismatch { path: PathBuf, sha256: String, expected: u64, actual: u64 },

    #[error("artifact hash mismatch at {path:?}: expected={expected} actual={actual}")]
    ArtifactHashMismatch { path: PathBuf, expected: String, actual: String },

    #[error("extraction failed for {archive_path:?}: {reason}")]
    ExtractionFailed { archive_path: PathBuf, reason: String, bytes_written: u64 },

    #[error("unsafe archive entry rejected: {entry:?} reason={reason}")]
    ExtractionUnsafePath { archive_path: PathBuf, entry: String, reason: &'static str },

    #[error("_vault/metadata.json missing under {extracted_root:?}")]
    EmbeddedMetadataMissing { extracted_root: PathBuf, artifact_sha256: String },

    #[error("_vault/metadata.json failed schema validation")]
    EmbeddedMetadataInvalid {
        extracted_root: PathBuf,
        schema_version: String,
        errors: Vec<String>,
    },

    #[error("catalog/embedded disagreement on {field} for {entity_type}:{entity_id}")]
    CatalogEmbeddedMismatch {
        entity_type: String,
        entity_id: i64,
        field: String,
        catalog_value: serde_json::Value,
        embedded_value: serde_json::Value,
    },

    #[error("scratch root unwritable: {path:?}: {source}")]
    ScratchUnwritable { path: PathBuf, #[source] source: io::Error },
}
```

These map 1:1 to the contract's Failure Modes table. There are no fallback
codepaths; every recoverable disagreement that the contract permits is
returned as a `CrossCheckFinding`, **not** as an error variant _(Contract:
§Failure Modes — "every failure is a typed semantic error. The adapter
never falls back silently to a degraded mode")_.

Semantic-code naming follows the `kaifuu.*` shape used throughout
`kaifuu-core` (`pub const SEMANTIC_VAULT_*`). Initial code prefixes:
`kaifuu.vault.root_missing`, `kaifuu.vault.root_incomplete`,
`kaifuu.vault.catalog_open_failed`, `kaifuu.vault.catalog_schema_unsupported`,
`kaifuu.vault.release_not_resolved`, `kaifuu.vault.artifact_missing`,
`kaifuu.vault.artifact_size_mismatch`, `kaifuu.vault.artifact_hash_mismatch`,
`kaifuu.vault.extraction_failed`, `kaifuu.vault.extraction_unsafe_path`,
`kaifuu.vault.embedded_metadata_missing`,
`kaifuu.vault.embedded_metadata_invalid`,
`kaifuu.vault.catalog_embedded_mismatch`, `kaifuu.vault.scratch_unwritable`.

---

## 10. Test Plan

All tests use behaviour-claim names per `docs/dev/testing-standard.md` §Behavior
Naming. Each test name is a falsifiable claim.

### Unit-level (per-module `#[cfg(test)] mod tests`)

`config.rs`:

- `resolves_vault_root_from_env_when_ITOTORI_VAULT_ROOT_is_set`
- `falls_back_to_linux_default_when_no_env_or_override_present` (cfg-gated)
- `rejects_resolved_root_when_catalog_db_or_by_sha_subdir_is_absent`

`paths.rs`:

- `derives_stable_game_id_from_vndb_id_when_present`
- `falls_back_to_dlsite_rj_code_when_vndb_absent`
- `falls_back_to_egs_id_then_to_canonical_title_slug_with_release_id`
- `produces_identical_game_id_across_two_independent_calls_for_the_same_release`

`resolution.rs`:

- `computes_by_sha_path_from_sha256_using_first_two_pairs_as_subdirs`
- `rejects_artifact_whose_on_disk_size_differs_from_catalog_size`
- `rejects_artifact_whose_streamed_sha256_differs_from_catalog_sha256`
- `never_reads_from_artifacts_by_name_subtree` (asserts no syscall touches `by-name/` — exercised via a fixture where `by-name/` contains a wrong-hashed copy of the same file)

`extraction.rs`:

- `rejects_archive_entry_containing_parent_dir_segment_before_writing_anything`
- `rejects_archive_entry_with_absolute_path`
- `rejects_archive_entry_with_windows_drive_prefix`
- `rejects_symlink_entry_whose_target_escapes_the_extraction_root`
- `removes_per_run_extraction_directory_on_extraction_failure`
- `rejects_files_inside_underscore_vault_other_than_metadata_json`

`retention.rs`:

- `keep_none_deletes_run_dir_on_success_and_on_failure`
- `keep_on_failure_preserves_run_dir_on_failure_and_deletes_on_success`
- `keep_all_never_deletes_run_dir`
- `keep_extracted_for_game_reuses_existing_extracted_tree_when_artifact_sha_matches`
- `keep_extracted_for_game_reextracts_when_artifact_sha_changes`

`error.rs`:

- `every_failure_mode_row_maps_to_exactly_one_variant` (compile-time + a
  table-driven test verifying the contract enum has the expected variant
  count and names).

### Integration-level (`tests/`)

A synthetic vault fixture is built deterministically under
`crates/kaifuu-vault-source/tests/fixtures/synthetic-vault/`:

- `catalog.db` is **generated at test build time** from a committed `seed.sql`
  via a `build.rs` step (so the binary file is reproducible and the seed
  inputs are reviewable). Schema is the upstream `/archive/vault/schema.sql`
  copied/vendored into the fixture tree, version-pinned.
- Three synthetic 7z archives under `artifacts/by-sha/<aa>/<bb>/<hash>.7z`:
  1. **Good primary**: contains `_vault/metadata.json` matching the catalog
     plus a small `game/` tree.
  2. **Subpath-bearing**: contains `_vault/metadata.json` plus `Win/` and
     `Mac/` subtrees, with `release_artifacts.subpath = 'Win'`.
  3. **Good patch**: role=`patch`, primary already present.
- Three corrupted variants: 4. **Hash-mismatch**: archive bytes do not hash to `artifacts.sha256`. 5. **Embedded-id-mismatch**: `_vault/metadata.json` lists `vndb v9999`
  while the catalog `identifiers` row says `v1234`. 6. **Path-traversal**: contains an entry named `../escape.txt`. 7. **Missing-metadata**: archive has no `_vault/metadata.json`.

Integration tests:

- `discovers_release_for_engine_claim_via_v_current_facts`
- `discovers_release_for_external_vndb_id`
- `discovers_release_for_dlsite_rj_code`
- `selects_primary_role_by_default_and_includes_patch_role_on_request`
- `extracts_subpath_artifact_and_returns_subpath_root_under_extracted_root`
- `materialize_returns_findings_for_platform_mismatch_without_raising_error`
- `materialize_raises_CatalogEmbeddedMismatch_for_disjoint_work_identifiers`
- `materialize_raises_ArtifactHashMismatch_for_hash_mismatch_fixture`
- `materialize_raises_ExtractionUnsafePath_for_path_traversal_fixture`
- `materialize_raises_EmbeddedMetadataMissing_when_metadata_absent`
- `catalog_bypass_mode_materializes_by_sha_and_emits_bypass_finding`
- `does_not_write_any_file_under_vault_root_during_a_materialize_call`
  (asserted via a per-test recursive snapshot of mtimes under `<vault-root>`
  before and after `materialize`).

### Negative tests

- `vault_root_missing_when_configured_path_does_not_exist`
- `vault_root_incomplete_when_artifacts_by_sha_subdir_is_absent`
- `catalog_open_failed_when_catalog_db_is_a_directory`
- `catalog_schema_unsupported_when_schema_version_row_is_absent`
- `catalog_schema_unsupported_when_schema_version_exceeds_supported`
- `scratch_unwritable_when_scratch_root_parent_is_read_only`

### Cross-check coverage

- Default tolerance: identifier-disjoint → error; everything else → finding.
- A future raised-tolerance test asserts that platforms/languages mismatches
  can be raised to errors when `CrossCheckTolerance::strict()` is used; this
  is included in the slice so the tolerance struct is exercised.

### Test runtime

All tests use temp dirs (`tempfile::tempdir`) for scratch roots, never the
real `/scratch/itotori/`. The synthetic vault fixture is regenerated per test
run; no shared mutable state. Public CI runs without `/archive/vault/`
present _(testing standard §Fixture Layers — "CI must pass when the
directory is absent")_.

---

## 11. Verification Commands

The DAG node declares:

```
cargo test -p kaifuu-core
pnpm exec vp run ts:test
Manual: Itotori vault-source localCorpus adapter contract review
```

Because the implementation lands in a new crate `kaifuu-vault-source`, the
verification surface extends:

```
cargo test -p kaifuu-vault-source     # primary unit + integration tests
cargo test -p kaifuu-core             # unchanged; catches accidental regressions
cargo fmt --check
cargo clippy -p kaifuu-vault-source -- -D warnings
pnpm exec vp run ts:test              # unchanged; no TS surface changes
just check                            # workspace gate
```

The workspace `Cargo.toml` is updated to add the crate as a member, which
`cargo check`/`just check` will exercise automatically.

The manual contract review step remains as declared in the DAG node and is
the orchestrator's responsibility to mark complete.

---

## 12. Risks and Unknowns

1. **Extraction-tool choice (`sevenz-rust2` vs system `7z`).** Decision in
   §5; orchestrator should confirm. If `sevenz-rust2` cannot handle a real
   vault artifact (e.g. a 7z format variant the crate does not support),
   fallback is a sandboxed system-`7z` invocation governed by a _new_ policy
   note — that is a meaningful policy change and should be a follow-up
   spec node, not silent fallback.
2. **Catalog-schema drift.** The vault-curation project owns `schema.sql`
   and may advance the version. The adapter pins `SUPPORTED_SCHEMA_VERSION`
   and raises `CatalogSchemaUnsupported` rather than guessing. A follow-up
   node should establish a compat-handshake doc between vault-curation and
   itotori, e.g. a `docs/itotori-vault-source-adapter.md` appendix listing
   supported schema versions and what each version added.
3. **`v_current_facts` view performance on hot paths.** The view does a
   window function over all of `facts`. On a vault with many fact rows this
   may be slow per discovery call. Mitigation: discovery queries always
   include an `entity_type`/`entity_id` filter, so SQLite can use the
   `idx_facts_entity` index for the underlying scan. If real-world latency
   is a problem, materialised resolution facts in a future
   vault-curation-owned helper table is the right answer (still owned by
   vault-curation, never by itotori).
4. **Scratch disk pressure under `keep-extracted-for-game`.** A keep-policy
   that retains extracted trees across runs can fill `/scratch/itotori/`.
   The adapter does not garbage-collect; documentation in the crate README
   directs the operator. A future quota/eviction node is reasonable but
   out of scope.
5. **`jsonschema` crate maturity for draft 2020-12.** The contract's
   embedded-metadata schema uses 2020-12 syntax (`$defs`, `const`). The
   chosen Rust validator must support it. `jsonschema` crate v0.18+ does.
   If the audited candidate is too strict (e.g. on `additionalProperties`
   inside `oneOf`), the implementation worker must record the validator
   version in the readiness record.
6. **Cross-OS scratch defaults under non-trevor users.** `dirs::data_dir()`
   returns `None` on hosts with no home directory; the adapter must treat
   that as `ScratchUnwritable` rather than panicking.
7. **`MaterializeOptions` finalisation.** This slice picks the minimum
   needed: `RetentionPolicy`, `ArtifactSelection`, `CrossCheckTolerance`,
   `run_id: Option<String>`. The orchestrator may want to add fields (e.g.
   `caller_run_label`); the plan should be considered minimum-not-final.
8. **No Linux-side `7z` system binary present in CI.** Confirms preference
   for the Rust-crate path; if implementation backs into a shell-out, CI
   will need a 7zip apt step. Avoidable by sticking with the Rust crate.

---

## 13. Out-of-Scope Reminders

This adapter does **not**:

- Import metadata into the itotori catalog. That is catalog-source-adapter
  territory; tracked by `itotori-catalog-source-adapter-contract.md`.
- Mutate `/archive/vault/` under any circumstance, including under any
  retention policy.
- Manage cryptographic keys, `.kaifuu/secrets.local/`, or any secret store.
- Launch the game, instrument it, capture screenshots, or evaluate runtime
  behaviour. That is Utsushi's domain.
- Shell out to vault-curation's `vault` CLI at runtime. The CLI may be
  cited in docs as a sibling tool only.
- Provide a shared cross-machine cache. Scratch is per-host, per-user,
  per-run.
- Register itself as a Kaifuu `EngineAdapter`. It is a `LocalCorpusSource`,
  a different surface.
- Provide a contingency "skip on missing vault root" path. Vault-root
  failure is `VaultRootMissing`, full stop.

---

## 14. Implementation Worker Scoping

**Recommendation: one worker scope.**

The slice is internally cohesive: catalog → resolver → extractor →
metadata cross-check → source registration are all gated on the same
fixture infrastructure and the same typed-error surface. Splitting risks
the second worker landing without a real consumer of the first worker's
output, which makes the cross-check tests duplicate fixtures.

If the orchestrator nevertheless wants a split (e.g. to bring two workers
online in parallel), the natural hand-off boundary is:

- **Worker A — "vault read pipe"**: `config.rs`, `error.rs`, `catalog.rs`,
  `discovery.rs`, `resolution.rs`, `paths.rs`. Deliverable: a
  `ResolvedArtifact` that the test suite can assert is byte-identical to
  a fixture. No extraction, no metadata.
- **Worker B — "extract + cross-check + register"**: `extraction.rs`,
  `metadata.rs`, `findings.rs`, `retention.rs`, `source.rs`. Consumes
  `ResolvedArtifact` produced by Worker A.

Hand-off contract (worker A → B): the `ResolvedArtifact` struct shape in
§4, the `VaultSourceError` enum as defined in §9, the workspace
`Cargo.toml` change, and the synthetic-vault fixture catalog (Worker A
commits the `seed.sql` + a build.rs; Worker B adds the synthetic 7z
archives and the negative variants).

If the orchestrator picks a single worker, the synthetic-fixture work
ships in the same PR as the implementation.

---

## Appendix A — File-by-file readiness for first commit by the implementation worker

Documentation worker / planning worker has already created
`crates/kaifuu-vault-source/` placeholder? **No.** The implementation worker
creates it. This planning slice produces only `.plan/KAIFUU-176.md`.

Implementation worker's first commit should:

1. Create `crates/kaifuu-vault-source/{Cargo.toml,src/lib.rs}` as a skeleton
   that compiles (empty trait stubs, error enum).
2. Add the crate to `Cargo.toml` `[workspace].members`.
3. Add `rusqlite`, `sha2`, `sevenz-rust2`, `jsonschema`, `thiserror`,
   `tempfile` (dev), `uuid`, `dirs` to `[workspace.dependencies]` (re-using
   workspace-level pinning).
4. Commit, then iterate per the module plan.

The readiness record (per `docs/kaifuu-engine-playbook.md` template) is
_not required_ for this slice because the vault source is not an
`EngineAdapter` — but a short `crates/kaifuu-vault-source/README.md` with
the relevant subset (owner, support boundary, fixture ids, semantic error
codes, local validation commands) is recommended and should land in the
same PR.

— end of plan —
