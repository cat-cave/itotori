# kaifuu-vault-source

Read-only itotori vault-source `localCorpus` adapter. Implements the
contract in `docs/itotori-vault-source-adapter.md` and the plan in
`.plan/KAIFUU-176.md`.

## What it does

- Opens `<vault-root>/catalog.db` read-only (rusqlite `mode=ro`).
- Discovers candidate releases via the catalog
  (`works`, `releases`, `release_artifacts`, `identifiers`,
  `v_current_facts`, `v_facts_needs_review`).
- Resolves artifacts via `artifacts/by-sha/<aa>/<bb>/<hash>.7z`, verifying
  size and streamed sha256 before any caller-visible state changes.
- Extracts archives in pure Rust via `sevenz-rust2`, rejecting unsafe
  entries (parent-dir, absolute path, drive prefix, `_vault/` collisions)
  **before any byte is written** to scratch.
- Reads and validates `_vault/metadata.json` against the vault's
  `embedded-metadata.schema.json` (draft 2020-12, via the `jsonschema`
  crate).
- Cross-checks selected fields against the catalog and surfaces
  disagreements as `CrossCheckFinding` records (never writes to
  `catalog.db`).

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
`tests/common/mod.rs`; the seven synthetic archives are constructed
in-test via `sevenz-rust2`'s `ArchiveWriter`. Fixture archives:

| id                     | description                                       |
| ---------------------- | ------------------------------------------------- |
| `good_primary`         | primary archive with valid `_vault/metadata.json` |
| `subpath_winmac`       | one archive with `Win/` and `Mac/` subtrees       |
| `good_patch`           | `role=patch` archive bound to the same release    |
| `hash_mismatch`        | archive bytes that don't match the catalog sha    |
| `embedded_id_mismatch` | embedded ids disjoint from the catalog            |
| `path_traversal`       | archive containing `../escape.txt`                |
| `missing_metadata`     | archive without `_vault/metadata.json`            |

## Semantic error codes

Every typed error variant carries a stable semantic code suitable for
telemetry, findings sinks, and operator dashboards:

- `kaifuu.vault.root_missing`
- `kaifuu.vault.root_incomplete`
- `kaifuu.vault.catalog_open_failed`
- `kaifuu.vault.catalog_schema_unsupported`
- `kaifuu.vault.release_not_resolved`
- `kaifuu.vault.artifact_missing`
- `kaifuu.vault.artifact_size_mismatch`
- `kaifuu.vault.artifact_hash_mismatch`
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
`ITOTORI_VAULT_ROOT=/archive/vault`).

### v1 → v3 diff for the columns this adapter reads

The adapter touches a fixed set of tables/columns; every one of them
exists and is type-compatible in both v1 and v3. v3 adds many new
columns and tables that the adapter does not read. The only adapter-read
change of behavioural significance is the widened `release_languages`
primary key:

| Table / view (columns the adapter reads)                                                                 | v1 → v3 status                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version` (`version`)                                                                             | unchanged                                                                                                                                                                                                                                             |
| `works` (`id`, `canonical_title`)                                                                        | unchanged (other columns added, not read)                                                                                                                                                                                                             |
| `work_titles` (`work_id`, `lang`, `title`)                                                               | unchanged                                                                                                                                                                                                                                             |
| `producers` / `producer_identifiers` (`producer_id`, `source`, `kind`, `value`)                          | unchanged                                                                                                                                                                                                                                             |
| `work_producers` (`work_id`, `producer_id`)                                                              | unchanged                                                                                                                                                                                                                                             |
| `identifiers` (`work_id`, `source`, `kind`, `value`)                                                     | unchanged                                                                                                                                                                                                                                             |
| `releases` (`id`, `work_id`, `edition_name`, `release_date`, `store`)                                    | read columns unchanged; v3 adds ~17 new columns (incl. `engine`, `version`, `dl_count`, …) the adapter does not read                                                                                                                                  |
| `release_platforms` (`release_id`, `platform`)                                                           | unchanged (PK still `(release_id, platform)`)                                                                                                                                                                                                         |
| `release_languages` (`release_id`, `language_code`)                                                      | **PK widened** from `(release_id, language_code)` to include `kind` and `source`; v3 adds `kind`, `is_mtl`, `evidence_path`, `source`. A `(release_id, language_code)` pair can now span multiple rows, so the language query uses `SELECT DISTINCT`. |
| `artifacts` (`id`, `sha256`, `size_bytes`, `original_sha256`, `artifact_kind`, `vault_path`)             | read columns unchanged; `sha256` still effectively unique; v3 adds `release_id`, `canonical_sha256`, `canonical_id`, `containers_json`, `state` (not read)                                                                                            |
| `release_artifacts` (`release_id`, `artifact_id`, `role`, `subpath`)                                     | unchanged                                                                                                                                                                                                                                             |
| `facts` (`entity_type`, `entity_id`, `field`, `value`) + views `v_current_facts`, `v_facts_needs_review` | unchanged                                                                                                                                                                                                                                             |

## Local validation commands

```
cargo test -p kaifuu-vault-source
cargo clippy -p kaifuu-vault-source --all-targets -- -D warnings
cargo fmt --check
```

## Dependency versions of note

- `rusqlite` 0.40 (with `bundled` feature for a pure-Rust SQLite build).
- `sha2` 0.10.
- `sevenz-rust2` 0.21 (`util` + `compress` features; default-features
  disabled to keep the dependency surface tight). Picked because it is
  pure Rust, lets the adapter reject path-traversal entries before any
  byte is written, and has no shell-out dependency.
- `jsonschema` 0.46 (default-features disabled to drop the HTTP / TLS
  surface). Supports draft 2020-12 per the contract's
  `embedded-metadata.schema.json` `$schema` URI.
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
