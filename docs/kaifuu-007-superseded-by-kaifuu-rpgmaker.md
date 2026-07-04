# KAIFUU-007 (RPG Maker MV/MZ adapter integration shell) — superseded verification

`KAIFUU-007` ("RPG Maker MV/MZ adapter integration shell", `roadmap/spec-dag.json`
line 3043, status=ready, milestone=beta) is an integration node: it asks for a
shell that composes the MV/MZ readiness record, the JSON-text surfaces
(map/common-event, database/system/terms), and plugin-profile diagnostics, with
encrypted media held out of scope and unsupported plugin text kept as a semantic
diagnostic.

That integration shell already exists and is gated: it is `crates/kaifuu-rpgmaker`
(the KAIFUU-108/109/110/111 surface slices plus the **KAIFUU-112 full-surface
integration** in `src/integration.rs`), backed by the `MvMzReadinessRecord` in
`crates/kaifuu-core/src/mv_mz_readiness.rs`. This note maps each KAIFUU-007
acceptance criterion to the concrete code and test that satisfies it.

Verdict: **superseded** by `crates/kaifuu-rpgmaker` (`KAIFUU-108/109/110/111/112`)
plus `crates/kaifuu-core/src/mv_mz_readiness.rs`. No gap. All four criteria are
fully met by merged, passing code — the DAG should not show this as ready work.

## Verification commands (all green)

- `cargo test -p kaifuu-rpgmaker` — 56 unit + 40 integration tests pass
  (3 real-bytes tests `ignored`, gated on `ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ`).
- `cargo test -p kaifuu-core mv_mz_readiness` — 14 readiness-record tests pass.

## Criterion-by-criterion mapping

### 1. "The integration composes readiness records, map/common-event JSON, database/system/terms JSON, and plugin-profile diagnostics"

**Met.**

- Readiness record: `MvMzReadinessRecord::canonical()`
  (`crates/kaifuu-core/src/mv_mz_readiness.rs:416`) composes all six JSON-text
  surfaces plus the KAIFUU-109..112 consumer fixture profiles
  (`MvMzFixtureProfile::canonical`, line 317). Test:
  `canonical_record_validates_and_covers_all_roles`
  (`mv_mz_readiness.rs:776`).
- Integration shell: `extract_full_surface`
  (`crates/kaifuu-rpgmaker/src/integration.rs:431`) walks a game `www` tree and
  composes the five `www/data/*.json` surfaces (via `extract_game_dir`) with the
  `www/js/plugins.js` plugin-profile surface (via `extract_plugins_file`), plus a
  per-role coverage census (`build_coverage`, line 457) and the honest capability
  tuple. Test: `extraction_covers_all_six_surfaces`
  (`tests/k112_full_surface.rs:135`) and
  `extraction_manifest_is_deterministic_and_covers_all_surfaces` (line 192).
- Map/common-event JSON: `src/map_common_event.rs`; tests
  `tests/k109_map_common_event.rs` (8 tests).
- Database/system/terms JSON: `src/database_terms.rs`; tests
  `tests/k110_database_terms.rs` (12 tests).
- Plugin-profile diagnostics: `src/plugin_profile.rs`; tests
  `tests/k111_plugin_profile.rs` (9 tests).

### 2. "Encrypted image, audio, and media replacement diagnostics are excluded from this node and remain owned by encrypted asset specs"

**Met.**

- The capability tuple explicitly declines encrypted media and plugin-JS logic:
  `MvMzCapabilityTuple::honest` `out_of_scope` = `SCOPE_ENCRYPTED_MEDIA` +
  `SCOPE_PLUGIN_JS_LOGIC` (`src/integration.rs:151`); `violations()`
  (line 183) mechanically rejects any drift (overclaim or dropped decline).
- The patch path never reads or writes `www/img` / `www/audio`; it records those
  bytes as byte-identical (`MEDIA_SUBTREES`, line 64; `collect_media`, line 774).
  Tests: `capability_tuple_is_honest_and_limited`
  (`tests/k112_full_surface.rs:409`),
  `trivial_patch_round_trips_all_surfaces_with_media_untouched` (line 239, proves
  a staged `*.rpgmvp` asset stays byte-identical on disk), plus the in-module
  guards `tuple_rejects_media_overclaim` and `tuple_rejects_dropped_media_declaration`
  (`src/integration.rs:838`, `:862`).
- Ownership stays with the encrypted-asset specs: the readiness record marks every
  `encrypted_media_diagnostics` entry non-extractable and non-patchable
  (`encrypted_media_diagnostics_are_all_unsupported`, `mv_mz_readiness.rs:808`;
  `validate_rejects_extractable_or_patchable_encrypted_media`, line 831); the real
  encrypted image/audio work lives in
  `crates/kaifuu-core/src/mv_mz_encrypted_image.rs` and `mv_mz_encrypted_audio.rs`.

### 3. "Golden fixtures name the exact MV/MZ JSON surfaces covered by the adapter"

**Met.**

- The committed synthetic golden tree `tests/fixtures/k112/www/` names each
  surface file explicitly: `data/Map001.json`, `data/CommonEvents.json`,
  `data/{Actors,Items,Skills,States,Troops}.json`, `data/System.json`, and
  `js/plugins.js`. The test asserts the exact file-to-role wiring
  (`extraction_covers_all_six_surfaces`, `tests/k112_full_surface.rs:162-181`:
  `Map001.json` -> Maps, `CommonEvents.json` -> CommonEvents, `System.json` ->
  System + Terms, `Actors.json`/`Items.json` -> Database, `plugins.js` ->
  PluginProfileDiagnostics), and each role's `surface_id` is byte-checked
  against `MvMzSurfaceRole::surface_id`.
- Per-slice golden fixtures also name their surfaces: `tests/fixtures/k109`,
  `tests/fixtures/k110`, `tests/fixtures/k111`.

### 4. "Unsupported plugin-owned text remains a semantic diagnostic rather than a broad MV/MZ support claim"

**Met.**

- An unprofiled plugin with string params (`QuestLog` in the golden `plugins.js`)
  yields exactly one structured `UnsupportedPluginProfile` diagnostic and extracts
  **no** text — never a per-string sweep, never silent, never a crash. Test:
  `unsupported_plugin_text_reports_profile_and_surface_diagnostic`
  (`tests/k112_full_surface.rs:354`). An empty (text-free) profile suppresses the
  diagnostic; a recognized-but-non-text `356` plugin command surfaces as a
  structural `PluginCommandText` finding.
- Plugin JavaScript logic is explicitly declined (`SCOPE_PLUGIN_JS_LOGIC`,
  `src/integration.rs:120`, `:158`); only declared plugin-parameter text literals
  are ever touched. The capability tuple's ceiling is `Patch` over exactly the two
  text scopes, so there is no broad MV/MZ support claim.

## Note on KAIFUU-007's stated verification

KAIFUU-007's own `verification` field lists `cargo test -p kaifuu-core` plus
"Adapter golden tests" and "Manual fixture patch smoke". Those are satisfied by
`cargo test -p kaifuu-core mv_mz_readiness` (readiness record) and
`cargo test -p kaifuu-rpgmaker` (adapter golden tests + the trivial full-surface
patch round-trip in `tests/k112_full_surface.rs`), respectively. The adapter crate
did not exist as a separate name when KAIFUU-007 was written; the delivered work
is `crates/kaifuu-rpgmaker` (`KAIFUU-108/109/110/111/112`).
