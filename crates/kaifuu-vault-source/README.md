# kaifuu-vault-source

Read-only itotori vault-source `localCorpus` adapter. Implements the
contract in `docs/itotori-vault-source-adapter.md` and the plan in
`.plan/KAIFUU-176.md`.

## What it does

- Opens `<vault-root>/catalog.db` read-only (rusqlite `mode=ro`).
- Discovers candidate releases via the catalog
  (`works`, `releases`, `artifacts.release_id`, `release_artifacts`,
  `identifiers`, `v_current_facts`, `v_facts_needs_review`).
- Resolves artifacts BY-ID via the content store
  `artifacts/by-id/<canonical_id>/<canonical_id>.7z`. The path is
  reconstructed from the catalog's stable `artifacts.canonical_id` and
  cross-checked against `artifacts.vault_path`. There is NO archive-level
  sha256/size identity or integrity coupling: a content hash is brittle
  identity (any folder/metadata change mints a new hash). Byte-fidelity is a
  per-game-file concern (e.g. the extracted `Seen.txt` sha256), never the
  archive/repack hash.
- Extracts archives in pure Rust via `sevenz-rust2`, rejecting unsafe
  entries (parent-dir, absolute path, drive prefix, `_vault/` collisions)
  **before any byte is written** to scratch, and verifying the extraction is
  complete (a silently-skipped codec folder is surfaced as a typed
  `ExtractionFailed`, never a partial tree).
- Reads the embedded by-id `_vault/metadata.json` (the vault-curation
  _canonical_ document) under the `<canonical_id>/` wrapper and cross-checks
  its identity (`canonical_id`, work `identifiers`) against the catalog,
  surfacing softer disagreements (languages, engine) as `CrossCheckFinding`
  records (never writes to `catalog.db`).

## What it does not do

- Write to the vault. Ever.
- Touch `artifacts/by-name/`.
- Manage cryptographic keys or anything under `.kaifuu/secrets.local/`.
- Mutate the itotori catalog or any other database.
- Launch the game, probe it at runtime, or evaluate runtime behaviour.

See _Out of Scope_ in the contract for the authoritative list.

## Owner / support boundary

Owner: itotori orchestrator (this crate is a downstream consumer of the
vault-curation project's `catalog.db` schema; vault-curation owns
`schema.sql` and `embedded-metadata.schema.json`).

Support boundary: this crate stops at the
`<scratch_root>/<game-id>/<run-id>/extracted/` directory. Anything
downstream (Kaifuu engine adapters, Itotori runs, key recovery) is owned
by other crates.

## Fixture ids

The synthetic-vault fixture under
`tests/fixtures/synthetic-vault/` is built from `seed.sql` via
`build.rs`. Tests build their own per-test vaults via
`tests/common/mod.rs`; the synthetic by-id archives are constructed
in-test via `sevenz-rust2`'s `ArchiveWriter`, each wrapped under a
`<canonical_id>/` directory (mirroring the real by-id repack layout) and
placed at `artifacts/by-id/<canonical_id>/<canonical_id>.7z`. Fixture
archives:

| id                     | description                                         |
| ---------------------- | --------------------------------------------------- |
| `good_primary`         | primary archive with valid `_vault/metadata.json`   |
| `subpath_winmac`       | one archive with `Win/` and `Mac/` subtrees         |
| `good_patch`           | `role=patch` archive bound to the same release      |
| `embedded_id_mismatch` | embedded work identifiers disjoint from the catalog |
| `path_traversal`       | archive containing `../escape.txt`                  |
| `missing_metadata`     | archive without `_vault/metadata.json`              |

The live by-id resolution proof against the real read-only `/archive/vault`
is `tests/live_vault_by_id_test.rs` (`#[ignore]`, run with
`ITOTORI_VAULT_ROOT=/archive/vault`): it resolves Oshioki Sweetie HD and
Kanon by-id and checks the extracted `Seen.txt` per-file sha256.

## Semantic error codes

Every typed error variant carries a stable semantic code suitable for
telemetry, findings sinks, and operator dashboards:

- `kaifuu.vault.root_missing`
- `kaifuu.vault.root_incomplete`
- `kaifuu.vault.catalog_open_failed`
- `kaifuu.vault.catalog_schema_unsupported`
- `kaifuu.vault.release_not_resolved`
- `kaifuu.vault.artifact_missing`
- `kaifuu.vault.extraction_failed`
- `kaifuu.vault.extraction_unsafe_path`
- `kaifuu.vault.embedded_metadata_missing`
- `kaifuu.vault.embedded_metadata_invalid`
- `kaifuu.vault.catalog_embedded_mismatch`
- `kaifuu.vault.scratch_unwritable`

## Catalog schema support

The adapter reads the vault's `catalog.db` and pins the catalog
`schema_version.version` values it has been verified against in
`SUPPORTED_SCHEMA_VERSIONS` (`src/error.rs`). The verified set is
**`{1, 3}`**:

- **v1** — the schema the synthetic test fixtures
  (`tests/fixtures/synthetic-vault/seed.sql`) are built on.
- **v3** — the live read-only `/archive/vault/catalog.db`.

**v2 is intentionally excluded.** No v2 catalog exists to verify the
adapter's queries against, and the project forbids blind widening. A v3
open is proven by the env-gated test
`tests/live_vault_open_test.rs` (`#[ignore]`, run with
`ITOTORI_VAULT_ROOT=/archive/vault`), and live by-id resolution by
`tests/live_vault_by_id_test.rs`.

The synthetic v1 fixture carries the by-id columns the resolver reads
(`artifacts.release_id`, `artifacts.canonical_id`, `artifacts.vault_path`,
`artifacts.canonical_sha256`, `artifacts.state`) so resolution is exercised
uniformly against both v1 and v3.

### v1 → v3 diff for the columns this adapter reads

The adapter touches a fixed set of tables/columns; every one of them
exists and is type-compatible in both v1 and v3. v3 adds many new
columns and tables that the adapter does not read. The behaviourally
significant adapter-read changes are the widened `release_languages`
primary key and the by-id linkage (`artifacts.release_id` direct column
plus the `artifacts.canonical_id` / `vault_path` by-id store keys):

| Table / view (columns the adapter reads)                                                                               | v1 → v3 status                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version` (`version`)                                                                                           | unchanged                                                                                                                                                                                                                                             |
| `works` (`id`, `canonical_title`)                                                                                      | unchanged (other columns added, not read)                                                                                                                                                                                                             |
| `work_titles` (`work_id`, `lang`, `title`)                                                                             | unchanged                                                                                                                                                                                                                                             |
| `producers` / `producer_identifiers` (`producer_id`, `source`, `kind`, `value`)                                        | unchanged                                                                                                                                                                                                                                             |
| `work_producers` (`work_id`, `producer_id`)                                                                            | unchanged                                                                                                                                                                                                                                             |
| `identifiers` (`work_id`, `source`, `kind`, `value`)                                                                   | unchanged                                                                                                                                                                                                                                             |
| `releases` (`id`, `work_id`, `edition_name`, `release_date`, `store`)                                                  | read columns unchanged; v3 adds ~17 new columns (incl. `engine`, `version`, `dl_count`, …) the adapter does not read                                                                                                                                  |
| `release_platforms` (`release_id`, `platform`)                                                                         | unchanged (PK still `(release_id, platform)`)                                                                                                                                                                                                         |
| `release_languages` (`release_id`, `language_code`)                                                                    | **PK widened** from `(release_id, language_code)` to include `kind` and `source`; v3 adds `kind`, `is_mtl`, `evidence_path`, `source`. A `(release_id, language_code)` pair can now span multiple rows, so the language query uses `SELECT DISTINCT`. |
| `artifacts` (`id`, `release_id`, `canonical_id`, `vault_path`, `original_sha256`, `artifact_kind`, `canonical_sha256`) | by-id resolution reads `canonical_id` (stable id / by-id store key), `vault_path` (cross-checked), `release_id` (direct artifact→release link), plus `original_sha256` / `canonical_sha256` as informational provenance only (never verified).        |
| `release_artifacts` (`release_id`, `artifact_id`, `role`, `subpath`)                                                   | unchanged; consulted (union'd with `artifacts.release_id`) for supplementary roles                                                                                                                                                                    |
| `facts` (`entity_type`, `entity_id`, `field`, `value`) + views `v_current_facts`, `v_facts_needs_review`               | unchanged                                                                                                                                                                                                                                             |

## Local validation commands

```
cargo test -p kaifuu-vault-source
cargo clippy -p kaifuu-vault-source --all-targets -- -D warnings
cargo fmt --check
```

## Dependency versions of note

- `rusqlite` 0.40 (with `bundled` feature for a pure-Rust SQLite build).
- `sha2` 0.10 (per-game-file hashing in the live by-id proof).
- `sevenz-rust2` 0.21 (`util` + `compress` features; default-features
  disabled to keep the dependency surface tight). Picked because it is
  pure Rust, lets the adapter reject path-traversal entries before any
  byte is written, and has no shell-out dependency. Note: it cannot fully
  decode every codec combination found in the wild (e.g. some
  Delta+BCJ2 multi-coder folders); the adapter surfaces such an incomplete
  extraction as a typed `ExtractionFailed` rather than a partial tree.
- `thiserror` 2.
- `uuid` 1 (`v7` feature; uuid v7 for run-id generation).
- `dirs` 6 (cross-OS path resolution).
- `tempfile` 3 (dev-dep only).

## Operator notes

### Scratch retention

The adapter does not garbage-collect scratch. Under
`RetentionPolicy::KeepExtractedForGame` repeated runs against the same
release reuse the on-disk extraction; the per-game subtree can grow over
time. Operators should monitor `<scratch-root>` size and clean stale
games on whatever cadence their host requires.

### Cross-OS paths

- Linux default vault root: `/archive/vault/`.
- macOS default vault root: `~/Library/Application Support/itotori/vault/`.
- Windows default vault root: `%LOCALAPPDATA%\itotori\vault\`.

Scratch defaults follow the same pattern:

- Linux: `/scratch/itotori/`.
- macOS: `~/Library/Caches/itotori/`.
- Windows: `%LOCALAPPDATA%\itotori\scratch\`.

Both can be overridden via `ITOTORI_VAULT_ROOT` and
`ITOTORI_SCRATCH_ROOT` environment variables (highest precedence) or
via the [`VaultConfig`]/[`ScratchConfig`] override fields (mid
precedence).

### Read-only behaviour

The adapter never writes to the vault root, period. Tests in
`tests/extraction_test.rs::does_not_write_any_file_under_vault_root_during_a_materialize_call`
snapshot every `(path, mtime)` under the vault root before and after a
materialize call and assert the snapshots are identical.
