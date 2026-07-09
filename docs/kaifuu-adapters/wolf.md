# Wolf RPG Editor Text-Table Adapter — Readiness Record

- Adapter id: `kaifuu-wolf-text-table-adapter` (the bounded adapter that
  drives the KAIFUU-073 encrypted-archive substrate with a synthetic
  text-table codec; the _detection-matrix row_ is `wolf-rpg-editor-archives`
  in [`kaifuu-detection-matrix.md`](../kaifuu-detection-matrix.md) and is a
  triage surface only — a matrix match is NOT an adapter support claim).
- Source module: `crates/kaifuu-core/src/wolf_adapter.rs` (KAIFUU-012).
- Roadmap node: KAIFUU-012 (Wolf RPG Editor adapter — bounded synthetic
  composition). Detection-matrix row: KAIFUU-034 (`wolf-rpg-editor-archives`).
- Owner: kaifuu engine-adapters track.
- Engine family: Wolf RPG Editor (WOLF / DXArchive containers; the adapter
  drives the synthetic encrypted-substrate form, NOT commercial Wolf/DXArchive
  on-disk shape).

## What this adapter is — and what it is not

This adapter is a **bounded synthetic composition**: it reuses the
KAIFUU-073 encrypted-archive substrate (the same container + fixture-only XOR
crypto that the `wolf_encrypted_smoke` node already proves), adds a
**Shift-JIS text-table codec** on top, and patches configured text cells
back through repack + re-encryption. It is NOT commercial Wolf/DXArchive
coverage — it is the "cite KAIFUU-073 smoke evidence before broad support
claims" gate made mechanical, and every adapter run cites
`WOLF_ENCRYPTED_SMOKE_CAPABILITY_ID` as the smoke-evidence anchor.

The honest scope:

- **Container + crypto (layer 1+2)** — REUSED, never reimplemented. The
  KAIFUU-073 substrate (`pack_encrypted_archive` / `decrypt_archive_members`)
  packs + unpacks the encrypted container; the fixture-only XOR key is
  resolved BY REF through `WolfEncryptedFixtureSecretResolver`; the raw key
  lives only inside the zeroize-on-drop `WolfEncryptedArchiveKey` and is
  NEVER serialized in any emitted report.
- **Codec (layer 3)** — added here. The Wolf text-table codec is a
  binary Shift-JIS string-table layout: `magic | name_len | record_count |
field_count | blob_len | name(shift_jis) | cells[record*field]{offset(u32),
len(u32)} | string_blob(shift_jis)`. Patching a cell to a different byte
  length rewrites every downstream `(offset, len)` — a real binary-layout
  change, not a length-preserving splice.
- **Patch-back (layer 4)** — applied through `WolfAdapterTransformLegs`
  with `patch_back = RepackArchive`. The patched tables are re-encoded,
  repacked, and re-encrypted through the same container+crypto layer.

## The non-bypassable gate (detector + helper boundary)

The adapter never runs extract/patch without first clearing BOTH halves of
the gate, and the gate is non-bypassable — a `key_resolved` outcome carried
by a failed-or-finding-bearing helper boundary is REFUSED with a
`kaifuu.key_validation_failed` semantic diagnostic, never waved through:

1. **KAIFUU-120 protection detector** — `run_wolf_protection_detector` must
   classify the container's protection signal as `Protected` (a concrete
   static-key requirement). Anything else (`Plain`, `HelperRequired`,
   `Unknown`) is refused with the matching semantic diagnostic.
2. **KAIFUU-121 helper boundary** — `run_wolf_helper_boundary` must report
   `KeyResolved` AND its own evidence must be trustworthy (boundary
   `status == Passed`, zero findings). The gate consumes all three (outcome
   - boundary status + finding count) — a failed or finding-bearing
     boundary can never be bypassed by its derived outcome alone.

The gate refuses, emits a `WolfAdapterCapabilityDiagnostic` carrying the
honest `WolfCapabilityTuple` (never claims extract/patch for an unsupported
variant), and short-circuits the round-trip — no extract, no patch, no key
material hash, no source/rebuilt archive hashes.

## Pipeline composition

The adapter drives every leg of the layered access pipeline:

| Layer      | Transform token                                             | Sourced from                                                       |
| ---------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Container  | `WolfArchive`                                               | KAIFUU-073 substrate (`pack_encrypted_archive`)                    |
| Crypto     | `FixedKey` (`XorFixture` crypto profile)                    | KAIFUU-073 substrate (`WolfEncryptedArchiveKey`)                   |
| Codec      | `ShiftJisText`                                              | THIS adapter (`encode_wolf_text_table` / `decode_wolf_text_table`) |
| Surface    | `TableRecord` (record/field text cells)                     | THIS adapter                                                       |
| Patch-back | `RepackArchive`                                             | THIS adapter (re-encode + repack + re-encrypt)                     |
| Helper     | (not claimed — static key resolved by ref)                  | —                                                                  |
| Runtime    | (not claimed — Wolf runtime replay is `utsushi-wolf` scope) | —                                                                  |

The claimed-support tuple for a cleared gate is
`{identify: supported, inventory: supported, extract: supported,
patch: supported, helper: unsupported (static key resolved by ref),
runtime: unsupported (utsushi-wolf node)}`. For any refused gate, the
honest floor (from the detector's derived tuple) is reported — extract and
patch are NEVER claimed on an unsupported variant.

## Per-table patch reports

The adapter emits a deterministic `WolfAdapterTablePatchReport` per patched
table:

- `source_member_hash` / `patched_member_hash` — sha256 of the decrypted
  member bytes (never the text). Hashes ALWAYS differ when patches
  applied.
- `source_member_byte_len` / `patched_member_byte_len` — byte lengths of
  the decrypted member.
- `layout_changed` — TRUE iff the `(offset, len)` string-table index
  differs after repack. A same-length in-place edit leaves the index
  untouched and `layout_changed` is honestly FALSE, even though the member
  bytes differ (which the hash pair proves). This is the "String table
  reconstruction" audit focus — it proves EXACTLY the offset-table rewrite
  it claims.
- `patched_text_verified` — TRUE iff every patched cell decoded to its
  requested text after the round-trip.
- `unchanged_tables_verified` — the number of untouched tables verified
  byte-identical after repack (the byte-identical invariant the fixture's
  `MenuStrings` table exercises).

## Rejection / diagnostic codes

The adapter refuses with a typed semantic capability diagnostic in the
following postures (each carries the honest `claimed_support` tuple, never
claiming extract/patch for an unsupported variant):

| Posture                                        | Semantic code                                                                           | When emitted                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Unknown` protection variant                   | `kaifuu.unsupported_variant.encrypted`                                                  | Unrecognized protection signal — cannot extract or patch                                       |
| `Plain` (unencrypted) container                | `kaifuu.unsupported_layered_transform`                                                  | Out of scope for this encrypted text-table adapter                                             |
| `HelperRequired` (Wolf "Pro" dynamic-key)      | `kaifuu.helper_required`                                                                | A per-game dynamic-key container is not supported by this static-key adapter                   |
| Missing `helperBoundary` on `Protected`        | `kaifuu.missing_key_profile`                                                            | A protected container needs a keyRef-bound helper-boundary profile; none supplied              |
| `KeyMissing` outcome                           | `kaifuu.missing_key_material`                                                           | The static key is not present in the local key store                                           |
| `HelperRequired` / `HelperUnavailable` outcome | `kaifuu.helper_required`                                                                | Key is behind an unrun dynamic-key helper                                                      |
| Failed/finding-bearing helper boundary         | `kaifuu.key_validation_failed`                                                          | Boundary evidence itself failed its own KAIFUU-121 validation — gate NOT bypassable by outcome |
| Wrong `engineFamily`                           | `kaifuu.unknown_engine_variant`                                                         | Engine family is not `wolf`                                                                    |
| Detector status not Passed                     | `kaifuu.unknown_engine_variant`                                                         | Container's protection detector evidence failed its own validation                             |
| Patch coordinate out of range                  | `kaifuu.wolf.adapter.patch_target_missing` (typed `WolfAdapterError`, not a diagnostic) | `(record_index, field_index)` exceeds the table                                                |

## Redaction / key discipline (the report emits nothing dangerous)

The adapter is the most aggressive redaction gate in the kaifuu surface:

- **No raw key material.** The report's stable-JSON form is asserted at
  runtime to NOT contain the resolved key bytes (`key.appears_in(json) →
refuse`); the source/rebuilt archive hashes and the key-material hash are
  safe sha256 forms; the resolved key bytes are zeroized on drop inside the
  resolver.
- **No decoded table text.** The report carries counts, byte lengths,
  coordinates, and sha256 hashes only — never the decoded cell text.
- **No local paths.** Every free-text field is run through
  `redact_for_log_or_report`; ids containing `/home/…` or `/scratch/…` are
  rewritten to `[REDACTED:…]`.
- **No private game titles.** Source-node id, fixture id, and table names
  are redacted for report.
- **Ref-only key.** The emitted report carries the
  `WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF` (the local scheme ref) and the
  key-material `sha256`; the raw key bytes never appear.

## Evidence is synthetic, redacted, ref-only

- Fixtures carry NO retail bytes and NO raw key material — pure data
  (`WolfTextTableAdapterFixture::synthetic()` and
  `fixtures/kaifuu/wolf/adapter.text-table.json`).
- The disk fixture ships three tables (`CharacterDB` + `SystemStrings` +
  `MenuStrings`); two are patched, one (`MenuStrings`) is left untouched so
  the byte-identical invariant is genuinely exercised.
- Every byte is reproduced by the in-crate synthetic builder; the on-disk
  JSON is an audit aid, not a copy of real Wolf bytes.
- Engine-general: the runner has no per-game branch — a different
  table-set + patch request (e.g. an `ItemDB` swap) is data-driven and
  round-trips identically.

## Fixture surface

- Public fixture id: `wolf-text-table-adapter-synthetic`
  (`fixtures/kaifuu/wolf/adapter.text-table.json`).
- Synthetic, authored, CC0 — no retail Wolf bytes, no corpus-vault access.
- Reproduced by `WolfTextTableAdapterFixture::synthetic()` in
  `crates/kaifuu-core/src/wolf_adapter.rs`.
- The adapter loads the fixture via
  `run_wolf_text_table_adapter_from_path(<path>)` and the regression test
  `fixture_loads_from_disk_and_round_trips` asserts the disk-fixture
  round-trip is byte-equivalent to the in-crate builder round-trip.

## Local validation commands

```sh
cargo test -p kaifuu-core -- wolf_adapter
cargo test -p kaifuu-core
cargo fmt --check
cargo clippy -p kaifuu-core --all-targets -- -D warnings
just check
```

## CI validation commands

Same as local, gated by `just check` / `just ci-kaifuu`.

## Known gaps (P2/P3 follow-ups)

- The adapter is a bounded synthetic composition over the KAIFUU-073
  substrate. Commercial Wolf/DXArchive on-disk shape (real `.wolf` headers,
  real encryption keys, real byte-quirks beyond the fixture-only XOR) is
  NOT covered — `HelperRequired` (Wolf "Pro" per-game dynamic-key
  containers) is explicitly refused.
- The codec covers text-table members only; voice / image / event-script
  members of a real Wolf archive are out of scope.
- Runtime replay is `utsushi-wolf` scope, not this adapter. The claimed-
  support tuple is honest: helper + runtime are explicitly unsupported on
  this node.
- A real-archive extractor (the next Wolf node) would need to replace the
  synthetic container builder with a real `.wolf` parser and would need a
  real key-profile boundary review — separate node.

## Honest support boundary (verbatim from the adapter)

> The Kaifuu Wolf RPG Editor adapter is a bounded SYNTHETIC composition: it
> drives the KAIFUU-073 encrypted-archive container+crypto substrate (key
> resolved by local SecretRef, raw key zeroized, never emitted), adds a
> Shift-JIS text-table codec (binary string-table layout), and patches
> configured text cells back through repack. Support is GATED by the
> KAIFUU-120 protection detector (must be `protected`) and the KAIFUU-121
> helper boundary (must be `key_resolved`); any other posture is an
> unsupported variant that emits a semantic capability diagnostic with the
> claimed-support tuple. It is not commercial Wolf/DXArchive coverage and
> emits no raw keys, decoded table text, local paths, or retail bytes.
