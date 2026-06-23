# KAIFUU-174 Implementation Plan — RealLive AVG32-variant text inventory adapter

| Field    | Value                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node id  | KAIFUU-174                                                                                                                                                  |
| Title    | RealLive AVG32-variant text inventory adapter                                                                                                               |
| Branch   | `spec/kaifuu-174`                                                                                                                                           |
| Worktree | `/scratch/worktrees/itotori-spec-kaifuu-174`                                                                                                                |
| Author   | orchestrator (planner)                                                                                                                                      |
| Date     | 2026-06-23                                                                                                                                                  |
| Status   | planning — implementation worker not yet dispatched                                                                                                         |
| Depends  | KAIFUU-014 (bridge schema / secret-ref boundary), KAIFUU-052 (layered text access pipeline), KAIFUU-172 (RealLive detector), KAIFUU-173 (Scene/SEEN parser) |
| Unblocks | UTSUSHI-146 (native RealLive runtime port), ALPHA-006 (vault-vertical Sweetie HD slice)                                                                     |

This plan is **planning only**. No Rust feature code is included; illustrative
sketches use `// pseudo-code` comments. The implementation worker must follow
`docs/kaifuu-engine-playbook.md`, `docs/kaifuu-patch-safety.md`,
`docs/kaifuu-fixture-policy.md`, `docs/testing-standard.md`, and the clean-room
provenance / no-shell-out rules already established by KAIFUU-172 and KAIFUU-173.

---

## 1. Crate placement decision

**Decision: extend `crates/kaifuu-reallive`** with two new sibling modules
(`inventory.rs` and `patchback.rs`) plus a thin `encoding.rs` codec module.
The KAIFUU-174 `EngineAdapter` impl lives in `crates/kaifuu-engine-fixture`
alongside `RealLiveProfileDetectorAdapter`, registered via
`register_default_adapters` (or the equivalent registry hook).

Rationale, weighed against introducing a separate
`crates/kaifuu-reallive-inventory/` crate:

- KAIFUU-173 already chose a per-module split inside `kaifuu-reallive`
  (`archive.rs`, `ast.rs`, `diagnostics.rs`, `opcodes.rs`, `parser.rs`,
  `strings.rs`). KAIFUU-174 adds (a) Shift-JIS decode of `StringSlot.raw_bytes`,
  (b) protected-span detection over those decoded bytes, (c) projection of the
  AST + decoded slots into the bridge schema, and (d) patch-back that writes
  modified bytes through the original archive envelope. All four touch the same
  AST and the same envelope shape KAIFUU-173 ratified; splitting them across a
  new crate boundary would add a public surface (and a Cargo dep) for what is a
  single read/decode/re-encode pipeline.
- The `EngineAdapter` impl belongs in `kaifuu-engine-fixture` for three
  reasons: (1) `RealLiveProfileDetectorAdapter` is already registered there and
  owns `inspect`/profile generation — KAIFUU-174 reuses that filesystem-scan
  output instead of re-walking the directory; (2) registry symmetry with
  `Xp3ProfileDetectorAdapter` and `SiglusProfileDetectorAdapter`; (3) the
  capability-shape boilerplate (`AdapterCapabilities`,
  `LayeredAccessCapabilityContract`, semantic-error wiring) is voluminous and
  already lives next to the detector code. The adapter calls into
  `kaifuu-reallive::inventory` and `kaifuu-reallive::patchback` for the actual
  decode/re-encode work; the adapter file contains no parser logic.
- The DAG verification surface (`cargo test -p kaifuu-reallive`,
  `cargo test -p kaifuu-engine-fixture`, `cargo test -p kaifuu-core`) maps
  cleanly: parser/codec/patch-back unit tests land in `kaifuu-reallive`; the
  adapter end-to-end + registry tests land in `kaifuu-engine-fixture`; bridge
  contract tests stay in `kaifuu-core`.
- Cross-OS / no-shell-out posture is preserved: `kaifuu-reallive` stays a pure
  function over `&[u8]` plus a thin writer that returns `Vec<u8>`; no I/O lives
  inside the new modules. The adapter performs filesystem reads/writes inside
  `kaifuu-engine-fixture` using the same temp-output / atomic-rename patterns
  as Siglus/XP3 detectors.

### 1.1 Workspace and Cargo changes

- `crates/kaifuu-reallive/Cargo.toml` gains an `encoding_rs` dep (added as a
  workspace dep first; see §1.2). `kaifuu-reallive` stays library-only.
- `crates/kaifuu-engine-fixture/Cargo.toml` gains a path dep on
  `kaifuu-reallive` (it does not have one today — KAIFUU-173 left the parser
  unwired from the registry).
- No change to `members` in the root `Cargo.toml` (both crates already exist).

### 1.2 Encoding crate decision

**Decision: add `encoding_rs = "0.8"` to the workspace and use it from
`kaifuu-reallive::encoding`.**

Rationale:

- `kaifuu_core::offset_map` ships a hand-rolled Shift-JIS encoder that covers
  only a small documented preflight table (ASCII, half-width katakana, plus a
  hand-curated common-case hiragana/katakana/kanji set). It is documented as a
  **preflight** helper; the same module's `encode_string` returns
  `Err("character U+XXXX is not representable by the supported Shift-JIS
preflight table")` for any character outside that table. Driving an inventory
  adapter that has to round-trip arbitrary Scene/SEEN bytes through that table
  is out-of-scope for a real-shape RealLive title and will produce false
  failures on common kanji.
- `encoding_rs` is the same crate the Rust ecosystem uses for Shift-JIS
  (WHATWG Encoding Standard semantics, MIT/Apache-2.0). It supports the
  documented half-width katakana + JIS X 0208 escapes that RealLive Scene/SEEN
  text uses.
- The clean-room posture is preserved: `encoding_rs` implements WHATWG's
  Shift-JIS, not a copy of rlvm or RLDEV. No RealLive expression is being
  pulled in.
- Alternative: extending the `kaifuu_core` preflight table is a non-starter at
  this slice; that table exists only as a static-preflight oracle for
  byte-budget checks, not as a real codec.

### 1.3 What this slice does NOT change

- The KAIFUU-173 parser AST is consumed read-only. No backwards-incompatible
  AST changes; only **additive** fields if absolutely needed (and only with a
  schema-version bump documented in `ast.rs`).
- `kaifuu_core` public surface: no new variants or fields on
  `BridgeUnit`/`BridgeBundle`/`ProtectedSpan`/`EncodedStringSlot`. KAIFUU-174
  consumes them as-is. If a new `ContainerTransform::RealLiveSeen` /
  `CodecTransform::RealLiveBytecode` / `PatchBackTransform::RecompileBytecode`
  variant is needed (the last already exists), the implementation worker
  reaches for the existing enum variants first; new variants are only added
  with an explicit `kaifuu_core` test update justified in the PR body.

---

## 2. Module boundaries and file layout

```text
crates/kaifuu-reallive/
  Cargo.toml                # adds encoding_rs workspace dep
  src/
    lib.rs                  # re-exports + crate-level provenance comment
    archive.rs              # unchanged from KAIFUU-173
    ast.rs                  # unchanged from KAIFUU-173 (schema 0.1.0)
    diagnostics.rs          # unchanged from KAIFUU-173
    opcodes.rs              # unchanged from KAIFUU-173
    parser.rs               # unchanged from KAIFUU-173
    strings.rs              # unchanged from KAIFUU-173
    encoding.rs             # NEW — Shift-JIS decode/encode wrappers + lossy-
                            #         decode diagnostic shape, control-byte
                            #         iterator (cuts a string slot at control
                            #         code boundaries without decoding them)
    protected_spans.rs      # NEW — protected-span detector over Shift-JIS-
                            #         decoded text; catalogue in §6
    inventory.rs            # NEW — pure walk over a parsed SceneIndex+Scene
                            #         AST producing a BridgeUnit list, plus
                            #         a parallel Vec<EncodedStringSlot> and
                            #         an AssetReferenceInventory list. No
                            #         I/O.
    gameexe.rs              # NEW — Shift-JIS Gameexe.ini line walker; emits
                            #         BridgeUnit per quoted-string value
                            #         documented as user-visible.
    patchback.rs            # NEW — given (original archive bytes, parsed
                            #         SceneIndex, parsed per-scene AST, list
                            #         of (slot_id -> replacement_bytes)) ->
                            #         Result<Vec<u8>, PatchBackError>. No I/O.
  tests/
    fixtures/               # extends KAIFUU-173 fixture set; see §11
      bridge-inventory-001/
        SEEN.TXT
        Gameexe.ini
        expected/
          bridge.json
          asset-refs.json
          warnings.json
      protected-spans-001/
        SEEN.TXT
        expected/
          bridge.json
      patchback-identity-001/
        SEEN.TXT
        expected/
          (no goldens — assertion is identity round-trip)
      patchback-length-preserving-001/
        SEEN.TXT
        patch/
          patch-export.json
        expected/
          patched.SEEN.TXT
      patchback-overflow-001/
        SEEN.TXT
        patch/
          patch-export.json
        expected/
          diagnostics.json
      unsupported-text-shape-001/
        SEEN.TXT
        expected/
          diagnostics.json
    smoke.rs                # unchanged from KAIFUU-173 (still passes)
    inventory.rs            # NEW — bridge inventory + protected-span tests
    patchback.rs            # NEW — patch-back identity + length-preserving +
                            #         overflow tests

crates/kaifuu-engine-fixture/
  src/lib.rs                # ADD: RealLiveInventoryAdapter (or fold into
                            #   RealLiveProfileDetectorAdapter — see §3.1)
                            #   wires the kaifuu-reallive pipeline through
                            #   EngineAdapter::list_assets / asset_inventory /
                            #   extract / patch_preflight / patch / verify.
  Cargo.toml                # ADD path dep on kaifuu-reallive.
```

### 2.1 Public API surface added in `kaifuu-reallive`

```rust
// crates/kaifuu-reallive/src/lib.rs — additive re-exports.

pub use encoding::{
    decode_shift_jis_slot, encode_shift_jis_slot,
    ShiftJisDecode, ShiftJisDecodeDiagnostic, ShiftJisEncodeError,
};
pub use gameexe::{
    GameexeInventoryEntry, parse_gameexe_inventory, GameexeIniDiagnostic,
};
pub use inventory::{
    AssetReference, AssetReferenceInventory, AssetReferenceKind,
    InventoryReport, InventoryWarning, InventoryWarningCode,
    build_scene_inventory,
};
pub use patchback::{
    apply_patches, PatchBackError, PatchBackErrorCode, PatchBackPlan,
    SlotEdit, SlotEditLengthPolicy,
};
pub use protected_spans::{
    ProtectedSpanKind, RealLiveProtectedSpan, detect_protected_spans,
};

// Pseudo-signatures (worker chooses final shape; ergonomics are non-binding).

pub fn build_scene_inventory(
    archive_bytes: &[u8],
    scene_index: &SceneIndex,
    scenes: &[Scene],
) -> InventoryReport;

pub fn apply_patches(
    archive_bytes: &[u8],
    scene_index: &SceneIndex,
    scenes: &[Scene],
    edits: &[SlotEdit],
) -> Result<Vec<u8>, PatchBackError>;
```

### 2.2 What this slice does NOT export

- No `EngineAdapter` trait impl in `kaifuu-reallive` — the impl lives in
  `kaifuu-engine-fixture` so registry assembly stays in one place.
- No CLI subcommand. The existing `kaifuu-cli extract` / `kaifuu-cli patch` /
  `kaifuu-cli asset-inventory` subcommands dispatch through the registry and
  pick up the new adapter automatically; no CLI flag changes are required.
  Test coverage: §11 includes a `kaifuu-cli` integration smoke that exercises
  the dispatch path against the `bridge-inventory-001` fixture.
- No I/O inside `kaifuu-reallive`. The adapter owns
  `fs::read`/`tempfile`/atomic-rename writes.
- No new variants on `kaifuu_core` enums unless the implementation worker
  documents the reason in the PR body. The default is to reuse
  `ContainerTransform::Archive` + `CodecTransform::BytecodeDecompile` +
  `PatchBackTransform::RecompileBytecode` for the Scene/SEEN surface and
  `ContainerTransform::LooseFile` + `CodecTransform::ShiftJisText` +
  `PatchBackTransform::ReplaceFile` for the Gameexe.ini surface.

---

## 3. Adapter implementation

### 3.1 Adapter registration

**Decision: extend the existing `RealLiveProfileDetectorAdapter` struct** in
`crates/kaifuu-engine-fixture/src/lib.rs` so the same adapter id
(`kaifuu.engine.reallive.detector` — keep stable from KAIFUU-172) covers
detect + inventory + extract + patch + verify. Rationale:

- The KAIFUU-172 adapter id has been ratified in the detector readiness
  record and in `fixtures/public/reallive-detector/*.manifest.json` fixture
  metadata. Introducing a second adapter id (e.g.
  `kaifuu.engine.reallive.inventory`) would split detection from inventory in
  the registry surface — CLI users who run `detect` then `extract` against the
  same `game_dir` should see one adapter, not two.
- The Xp3 + Siglus adapters follow the same pattern: one struct, one id, all
  trait methods on one impl block. KAIFUU-174 keeps the symmetry.
- Practical: `RealLiveProfileDetectorAdapter::inspect(game_dir)` already
  collects the SEEN.TXT / Gameexe.ini / SEEN.GAN evidence; the new
  trait methods reuse it instead of rescanning.

Rename / boundary update:

- The struct stays `RealLiveProfileDetectorAdapter` (rename deferred — the
  CLI artifacts and the readiness record carry the name today; rename is a
  cosmetic follow-up that risks breaking pinned `adapter_id` strings in
  artifacts).
- The adapter's `name()` is updated from "Kaifuu RealLive detector profile
  fixture adapter" to "Kaifuu RealLive Scene/SEEN inventory adapter" so the
  CLI / capability report reflects the expanded surface. `id()` is
  **unchanged**.

### 3.2 Trait-method wiring

The seven `EngineAdapter` methods are wired as follows (cross-checked against
the existing impl at `crates/kaifuu-engine-fixture/src/lib.rs:3933-4214`):

| Method            | KAIFUU-172 status      | KAIFUU-174 change                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | unchanged              | unchanged                                                                                                                                                                                                                                                                                                                                                        |
| `name`            | detector phrasing      | updated to reflect inventory + patch-back surface (§3.1)                                                                                                                                                                                                                                                                                                         |
| `capabilities`    | identify+inventory     | extract, patching, container_access, codec_access, patch_back, asset_text_patching → flip from `Unsupported` to `Supported` (Scene/SEEN + Gameexe surfaces) or `Limited` (asset_inventory broadens to include `.g00`/`.koe`/`.ovk` refs but does NOT claim asset extraction). Runtime VM, EncryptedInput, KeyProfile, DeltaPatching stay `Unsupported`. See §3.3 |
| `detect`          | KAIFUU-172 detector    | unchanged (still uses `inspect`)                                                                                                                                                                                                                                                                                                                                 |
| `profile`         | KAIFUU-172 profile     | minor update: profile.assets gains SEEN.TXT as `AssetKind::Script` with `text_surfaces = [Dialogue, SpeakerName, ChoiceLabel]`; Gameexe.ini gains as `AssetKind::Metadata` with `text_surfaces = [UiLabel, MetadataText]`                                                                                                                                        |
| `list_assets`     | KAIFUU-172 stub        | populates the same per-asset profiles                                                                                                                                                                                                                                                                                                                            |
| `asset_inventory` | KAIFUU-172 stub        | gains `AssetInventorySurface` entries for the Scene/SEEN dialogue/speaker/choice surfaces and the Gameexe.ini metadata surface; cites `.g00`/`.koe`/`.ovk` asset refs from the inventory walk                                                                                                                                                                    |
| `extract`         | returns parser failure | walks SEEN.TXT via `parse_archive` + `parse_scene` (KAIFUU-173 surface), runs `inventory::build_scene_inventory`, runs `parse_gameexe_inventory`, projects into a `BridgeBundle` (see §4)                                                                                                                                                                        |
| `patch_preflight` | always unsupported     | runs `EncodedStringSlot::preflight` against every `EncodedStringSlot` derived from the inventory, returning the preflight report inside `PatchResult`                                                                                                                                                                                                            |
| `patch`           | always unsupported     | reads SEEN.TXT bytes, builds the `SlotEdit` list from the `PatchExport`, calls `patchback::apply_patches`, writes the patched SEEN.TXT atomically into `output_dir`. Gameexe.ini edits route through the loose-file Shift-JIS writer.                                                                                                                            |
| `verify`          | always failed          | re-runs `parse_archive` + `parse_scene` against the patched bytes, asserts the AST shape matches modulo edited slot bytes, returns `OperationStatus::Success` when the round-trip closes                                                                                                                                                                         |

### 3.3 Capability declarations

The implementation worker updates `capabilities()` to match the inventory +
patch-back surface. Concrete deltas vs the KAIFUU-172 capability list:

- `Capability::Extraction` → `Supported`
- `Capability::Patching` → `Supported` (length-preserving only; see §7.2)
- `Capability::Verification` → `Supported`
- `Capability::AssetListing` → unchanged (`Supported`)
- `Capability::AssetInventory` → unchanged (`Supported`) — surface list grows
- `Capability::ContainerAccess` → `Supported` (SEEN.TXT envelope)
- `Capability::CodecAccess` → `Supported` (Shift-JIS via `encoding_rs`)
- `Capability::PatchBack` → `Supported` (length-preserving only)
- `Capability::AssetTextPatching` → `Limited` (Scene/SEEN dialogue +
  speaker + choice slots only; image-overlaid text inside `.g00` is NOT in
  scope — see §13 "out of scope")
- `Capability::RuntimeVm` → `Unsupported` (UTSUSHI-146)
- `Capability::EncryptedInput` → `Unsupported`
- `Capability::KeyProfile` → `Unsupported` for the alpha-vertical title set;
  the readiness record will reopen this if encrypted RealLive variants are
  added later
- `Capability::DeltaPatching` → `Unsupported`
- `Capability::NonTextSurfaceExtraction` → `Unsupported`
- `Capability::CryptoAccess` → `Unsupported` (no `.koe`/`.ovk` voice
  obfuscation work here)
- `Capability::LineParityPatching` → `Limited` (Scene/SEEN bytecode
  patch-back is per-slot, not per-line; the KAIFUU-052 line-parity contract
  applies to per-text-line surfaces and is not claimed)

`LayeredAccessCapabilityContract` updates:

- `identify`: unchanged from KAIFUU-172.
- `inventory`: `supported_containers = [LooseFile, Archive]`,
  `supported_codecs = [ShiftJisText, BytecodeDecompile]`,
  `supported_surfaces = [Identity, ArchiveEntry, BinaryOffset]`.
- `extract`: `Supported`,
  `required_capabilities = [Extraction]`,
  `supported_containers = [LooseFile, Archive]`,
  `supported_crypto = [NullKey]`,
  `supported_codecs = [ShiftJisText, BytecodeDecompile]`,
  `supported_patch_back = [Identity, ReplaceFile, RecompileBytecode]`.
- `patch`: `Supported`,
  `required_capabilities = [Patching, PatchBack]`, same transform set.

### 3.4 Layered pipeline registration

KAIFUU-174 wires the RealLive surface into the KAIFUU-052 layered text access
pipeline by emitting a `LayeredAccessProfile` from the adapter's `profile`
method. The two surfaces:

1. **Scene/SEEN dialogue surface** (per `AssetKind::Script`):
   - `text_surface`: `TextSurface::Dialogue`
   - `surface_transform`: `SurfaceTransform::BinaryOffset` (slot ids encode
     `(scene_id, byte_offset, slot_index)`)
   - `container`: `ContainerTransform::Archive` (SEEN.TXT envelope)
   - `crypto`: `CryptoTransform::NullKey` (alpha-vertical posture)
   - `codec`: `CodecTransform::BytecodeDecompile` (parser produces AST) +
     downstream `CodecTransform::ShiftJisText` for the string-slot bytes
     (per-surface profile records the leaf codec; `BytecodeDecompile` is the
     coarse-grained container-level stage)
   - `patch_back`: `PatchBackTransform::RecompileBytecode`
2. **Gameexe.ini metadata surface** (per `AssetKind::Metadata`):
   - `text_surface`: `TextSurface::MetadataText`
   - `surface_transform`: `SurfaceTransform::Identity`
   - `container`: `ContainerTransform::LooseFile`
   - `crypto`: `CryptoTransform::NullKey`
   - `codec`: `CodecTransform::ShiftJisText`
   - `patch_back`: `PatchBackTransform::ReplaceFile`

`LayeredTextSurfaceAccess::plaintext_identity` is **not** appropriate (the
Scene surface is bytecode, not plaintext); the implementation worker builds
each `LayeredTextSurfaceAccess` explicitly with the values above.

---

## 4. Bridge-schema extraction

The KAIFUU-173 parser produces `SceneIndex` + per-scene `Scene` (with
`Vec<StringSlot>` whose `raw_bytes_hex` carries verbatim bytes and
`encoding = SourceEncoding::Binary`). KAIFUU-174 walks that output and emits
`kaifuu_core::BridgeBundle`.

### 4.1 BridgeUnit projection rule

Per `StringSlot` in each scene's `strings` vector:

| Field                        | Source                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BridgeUnit.bridge_unit_id`  | UUIDv7 generated by the adapter at extract time (matches the existing `BridgeBundle` shape; not stable across runs by design — `source_unit_key` is the stable id)                |
| `BridgeUnit.source_unit_key` | `StringSlot.slot_id.as_str()` — verbatim KAIFUU-173 id (e.g. `reallive:scene-0000:str-off-0000001a-idx00`). Format-pinned by a test in `kaifuu-reallive/tests/inventory.rs` (§11) |
| `BridgeUnit.occurrence_id`   | `format!("{source_unit_key}#occ-{slot_index_within_scene:04}")` — stable position-derived id                                                                                      |
| `BridgeUnit.source_hash`     | `sha256(raw_bytes)` of the Shift-JIS bytes (not the decoded text), upper-hex                                                                                                      |
| `BridgeUnit.source_locale`   | `"ja-JP"` (RealLive Scene/SEEN is Japanese; locale string is locked, audited by a test)                                                                                           |
| `BridgeUnit.source_text`     | Shift-JIS decoded string (see §5)                                                                                                                                                 |
| `BridgeUnit.speaker`         | the previous `SetSpeaker` opcode's StringSlot decoded text, if any; otherwise `""` (and a `kaifuu.reallive.inventory.unattributed_dialogue` warning if the slot is `Dialogue`)    |
| `BridgeUnit.text_surface`    | mapped from `StringSlotRole`: `Dialogue→"dialogue"`, `SpeakerName→"speaker_name"`, `Choice→"choice_label"`, `AssetReference→"metadata_text"`, `Unknown→"dialogue"` (with warning) |
| `BridgeUnit.protected_spans` | output of `protected_spans::detect_protected_spans` against `source_text` (§6); each span carries `(kind, raw, start, end, preserve_mode)` per `ProtectedSpan::new`               |
| `BridgeUnit.patch_ref`       | constructed via the existing `PatchRef` shape used by Siglus/XP3 (source file path relative to game_dir, slot id, byte range)                                                     |

The bridge bundle's `bridge_id` is a UUIDv7; `source_bundle_hash` is
`sha256(archive_bytes)`. `source_locale = "ja-JP"`. `extractor_name =
"kaifuu-reallive"`, `extractor_version` matches the crate version.

### 4.2 Gameexe.ini BridgeUnits

`gameexe::parse_gameexe_inventory` walks Shift-JIS-decoded lines and emits a
`BridgeUnit` per quoted-string value of documented user-visible keys
(`#TITLE`, `#REGNAME` display variant, `#WINTITLE`, etc.). The bridge id rule:

```
gameexe:line-{line_number:04}:key-{key_name}:off-{byte_offset:08x}
```

Lines whose values are not user-visible (`#GAMEEXE_VERSION`, key paths,
opcode numerics) are emitted as `AssetReference` (`StringSlotRole`-equivalent)
entries on the `AssetReferenceInventory`, not as `BridgeUnit`s. The
inclusion-criteria table is in §4.4.

### 4.3 Asset-reference capture

The inventory walk also emits an `AssetReferenceInventory`:

```rust
// Pseudo-shape; final field names are non-binding.
pub struct AssetReference {
    pub reference_id: String,         // stable, position-derived
    pub kind: AssetReferenceKind,     // Image, VoiceArchive, BgImage, etc.
    pub raw_path: String,             // verbatim path as recorded in the
                                       //   StringSlot bytes (relative)
    pub source_unit_key: String,       // the StringSlot slot_id where it
                                       //   appears
    pub byte_offset: u64,              // within scene blob
}
```

`AssetReferenceKind` covers `.g00` (`Image`), `.koe`/`.ovk`/`.nwk`
(`VoiceArchive`), and `.gan`/`.pdt` (`Unknown` until per-game evidence
extends the catalogue). The catalogue is **bounded**: unknown extensions
fall through with a `kaifuu.reallive.inventory.unknown_asset_extension`
warning, never silently dropped.

Asset refs are emitted from two sources:

1. `StringSlot.semantic_role == AssetReference` (e.g. `SetSpeaker` operand
   that the heuristic flagged as a filename — see §4.5 for the heuristic).
2. Gameexe.ini key values that match a documented asset-path key prefix
   (e.g. `#G00`, `#KOE`, `#NWK`).

### 4.4 User-visible Gameexe.ini key inclusion table

The implementation worker hard-codes this table; expansion follows
evidence-first per-key inclusion (each new key needs a paired fixture line):

| Key                | Treatment                                                | Rationale                                                       |
| ------------------ | -------------------------------------------------------- | --------------------------------------------------------------- |
| `#WINTITLE`        | BridgeUnit (`text_surface = "metadata_text"`)            | Window title is user-visible at runtime; translatable.          |
| `#TITLE`           | BridgeUnit                                               | Game title metadata.                                            |
| `#REGNAME`         | AssetReference (preserve verbatim; **do not translate**) | Registry key name — translating breaks save compatibility.      |
| `#GAMEEXE_VERSION` | AssetReference (preserve verbatim)                       | Version stamp, not user text.                                   |
| `#G00*`            | AssetReference (`AssetReferenceKind::Image`)             | Image path reference.                                           |
| `#KOE*`            | AssetReference (`AssetReferenceKind::VoiceArchive`)      | Voice archive path.                                             |
| `#SEEN*`           | AssetReference                                           | Scene table reference.                                          |
| `#NWK*`            | AssetReference                                           | Voice index reference.                                          |
| (anything else)    | Warning: `kaifuu.reallive.inventory.unknown_gameexe_key` | No silent skip; warning surfaces in `InventoryReport.warnings`. |

### 4.5 Asset-reference heuristic on StringSlot bytes

When a Scene/SEEN `StringSlot` carries an ASCII byte run that ends in
`.g00`/`.koe`/`.ovk`/`.nwk` (case-insensitive) and contains no Shift-JIS
multi-byte runs, it is reclassified from its parser-default role to
`StringSlotRole::AssetReference` and **also** emitted on the
`AssetReferenceInventory` (cross-referenced via the slot's `source_unit_key`).
The reclassification is recorded as a structured note on the inventory
report (no warning — this is the documented behavior).

---

## 5. Encoding decode (Shift-JIS)

### 5.1 Decode policy

- `kaifuu-reallive::encoding::decode_shift_jis_slot(bytes: &[u8]) -> ShiftJisDecode`
  returns:
  ```rust
  pub struct ShiftJisDecode {
      pub text: String,                          // decoded Unicode text
      pub had_replacement: bool,                 // U+FFFD substituted
      pub diagnostics: Vec<ShiftJisDecodeDiagnostic>, // per-byte position
  }
  ```
- The decoder uses `encoding_rs::SHIFT_JIS.decode_without_bom_handling`. A
  byte sequence that cannot decode emits a
  `kaifuu.reallive.shift_jis_decode_failure` Warning carrying the byte range;
  the text falls back to U+FFFD. The original bytes are preserved in
  `StringSlot.raw_bytes_hex` so patch-back can still round-trip the slot
  identity-style.
- The decoder treats control bytes (`<0x20`) **before** translating to text:
  it splits the slot bytes around control runs so the protected-span detector
  sees runs of decoded Unicode separated by raw control sequences. The
  rationale: RealLive control codes are not valid Shift-JIS and must not be
  fed through the codec.

### 5.2 Control-byte slicing

A `StringSlot` whose bytes are
`<text bytes><control byte><argument bytes><text bytes>` is split into:
`[ TextRun, ControlSpan, TextRun ]`. The `ControlSpan` is preserved
byte-for-byte (no decode), gets a `ProtectedSpan` entry in the resulting
`BridgeUnit`, and **its raw bytes round-trip verbatim** through patch-back.

### 5.3 Encode policy (used by patch-back)

- `encode_shift_jis_slot(text: &str) -> Result<Vec<u8>, ShiftJisEncodeError>`
  uses `encoding_rs::SHIFT_JIS.encode` and returns `Err` when the encoder
  reports `had_unmappable_characters`. The byte position of the first
  unmappable character is recorded in the error.
- The patch-back planner (§7) re-injects control bytes between encoded text
  runs in their original positions.

### 5.4 Encoding edge cases addressed at this slice

- Half-width katakana (`U+FF61..U+FF9F`) — handled by `encoding_rs`.
- JIS X 0208 kanji — handled by `encoding_rs`.
- JIS escape sequences (`ESC $ B`, `ESC ( B`) — RealLive does **not** use
  these; if encountered, decode falls back via `encoding_rs` semantics and
  the failure surfaces as a warning. This is a documented limitation; not a
  blocker.
- Embedded NUL bytes — preserved as control bytes (slice boundary).

---

## 6. Protected-span catalog (RealLive control codes)

Provenance: derived from **public format archaeology** (Haeleth's RLDEV
documentation, `https://dev.haeleth.net/rldev.shtml`, and the publicly-
archived RLDEV docs). Each control code is named with a stable
`ProtectedSpanKind` variant; the kind serializes as a snake_case string used
verbatim as `ProtectedSpan.kind`. Bytes inside a control span are preserved
verbatim through patch-back.

### 6.1 Bounded protected-span catalogue

| Stable kind                | RealLive byte / shape                                                 | Public-doc citation                      | Preserve mode    |
| -------------------------- | --------------------------------------------------------------------- | ---------------------------------------- | ---------------- |
| `color_code`               | `0x1f <color_index_byte>`                                             | RLDEV "Inline color directive"           | `exact`          |
| `ruby_open` / `ruby_close` | `0x0d <base_text> 0x0a <ruby_text> 0x09` (RLDEV-documented form)      | RLDEV "Ruby annotation"                  | `transform`      |
| `name_placeholder`         | `\{<digits>\}` (ASCII brace-digit-brace) — substitutes character name | RLDEV "Named character placeholder"      | `map`            |
| `choice_token`             | `0x02 <choice_index_byte>` (within `Choice` opcode string operand)    | RLDEV "Choice option preamble"           | `exact`          |
| `text_size_directive`      | `0x1e <size_byte>`                                                    | RLDEV "Font size escape"                 | `exact`          |
| `wait_directive`           | `0x10 <frames_byte>`                                                  | RLDEV "Inline wait directive"            | `exact`          |
| `clear_text_box`           | `0x0c`                                                                | RLDEV "Page break / clear text box"      | `exact`          |
| `line_break`               | `0x0a` (not inside ruby)                                              | Universal across RLDEV-style scripts     | `exact`          |
| `variable_placeholder`     | `\\<varname>` (ASCII backslash + identifier)                          | RLDEV "Inline variable reference"        | `map`            |
| `unknown_control`          | any other byte `<0x20` not in the above list                          | _no claim_ — emit warning, preserve byte | `exact` (+ warn) |

`unknown_control` is the **explicit no-silent-skip** policy: every byte
`<0x20` either matches one of the named kinds above or is recorded as
`unknown_control` with a paired
`kaifuu.reallive.protected_span.unknown_control` warning. The byte is
never dropped from the BridgeUnit's protected-span list and never erased
from the patch-back round-trip.

### 6.2 Catalogue evidence rule

The implementation worker MUST treat the table above as the **bounded**
catalogue. Adding a new kind requires:

1. A paired synthetic-fixture line that exercises the new byte/shape, and
2. A public-docs citation in the readiness-record addendum.

The auditor rejects a PR that expands the catalogue without a paired
fixture.

### 6.3 Mapping into `ProtectedSpan`

```rust
// pseudo-mapping; the worker uses ProtectedSpan::control_markup or
// ProtectedSpan::variable_placeholder as appropriate.

let span = match protected_span_kind {
    ProtectedSpanKind::ColorCode { index } =>
        ProtectedSpan::control_markup(raw_hex, start, end,
            "color_code", vec![format!("{:02x}", index)]),
    ProtectedSpanKind::Ruby { base, ruby } =>
        ProtectedSpan::control_markup(raw_hex, start, end,
            "ruby", vec![base, ruby]),
    ProtectedSpanKind::NamePlaceholder { index } =>
        ProtectedSpan::variable_placeholder(raw_hex, start, end,
            format!("name_{index}")),
    ProtectedSpanKind::VariablePlaceholder { name } =>
        ProtectedSpan::variable_placeholder(raw_hex, start, end, name),
    // ...etc per the catalogue
};
```

`ProtectedSpan.start`/`end` are byte offsets **within the decoded
`source_text` string** (per `kaifuu_core::ProtectedSpan` contract — see
`source_slice_for_span` in `crates/kaifuu-core/src/lib.rs`). This is the
load-bearing detail: the bridge schema's protected-span offsets refer to
the decoded text, not the raw bytes.

---

## 7. Patch-back

### 7.1 Algorithm

`patchback::apply_patches(archive_bytes, scene_index, scenes, edits) ->
Result<Vec<u8>, PatchBackError>`:

1. Copy `archive_bytes` to `output: Vec<u8>` (the writer mutates in place).
2. Group `edits: &[SlotEdit]` by `scene_id`.
3. For each affected scene, build a `SceneRewrite`:
   a. Walk the scene's `instructions` in `byte_offset` order.
   b. For each `Instruction.operands` containing a `String { slot_ref }`,
   check whether `slot_ref.slot_id` is in the edit map. If yes, mark the
   operand's byte range for replacement.
   c. Re-emit the scene bytes:
   - Copy opcode opener (`0x23`), opcode byte, operand-count byte
     verbatim.
   - For each operand: emit the tag byte; for `String` operands either
     copy verbatim or substitute the re-encoded bytes (with new 2-byte
     LE length prefix); for `Int`/`Label` copy verbatim.
4. Each `SlotEdit` has a `length_policy: SlotEditLengthPolicy`:
   - `LengthPreserving` — encoded bytes plus control-span preserved bytes
     must equal `slot.byte_len` exactly. If not, emit
     `kaifuu.reallive.patchback_overflow` Fatal.
   - `FixedBudget { max_bytes }` — encoded bytes ≤ `max_bytes`; pad to
     `max_bytes` with zero bytes appended after the encoded string and
     **before** the next operand's tag byte. **Decision: not implemented at
     this slice.** Reserved for a future node when offset-table rewriting is
     justified (see §13 out-of-scope).
5. After all per-scene rewrites:
   a. If any scene's total byte length changed, rewrite the SEEN.TXT entry
   table: for each scene `i`, update `entries[i].byte_offset` to the new
   offset and `entries[i].byte_len` to the new length. **Per §7.2, this
   only happens when at least one edit ran with a non-`LengthPreserving`
   policy, which at this slice is unreachable; the path is implemented
   and tested for completeness but always returns the
   `kaifuu.reallive.patchback_offset_overflow` Fatal until
   length-changing policies ship.**
   b. Concatenate `[ count u32 ][ entry table ][ scene 0 bytes ][ scene 1 bytes ]...`
   into the new archive.
6. Round-trip self-check: re-run `parse_archive` + `parse_scene` against
   the new archive. If the parser emits any new Fatal diagnostics, return
   `PatchBackError::ParserRegression` carrying the new diagnostics. This is
   the **patch-back integrity gate** — patch-back is never trusted on its
   own output without a re-parse.

### 7.2 Length-change handling (decision)

**Decision: KAIFUU-174 implements `LengthPreserving` only.** Edits that
change the encoded byte count produce a
`kaifuu.reallive.patchback_offset_overflow` Fatal. The path is the strictest
of the three options the assignment named:

- **Fixed-byte-budget rejection (chosen)** — the simplest correct shape:
  patch-back never shifts a scene byte boundary, never rewrites the offset
  table, never desynchronizes a label/jump target inside another instruction
  (which the parser at this slice does not resolve, so a shifted byte
  boundary could silently break runtime execution that UTSUSHI-146 will add
  later).
- **Offset-table rewrite** — defers to a future node. Requires (a)
  validating no other on-disk artifact (Gameexe.ini, save data, voice
  archives) embeds absolute scene offsets, (b) handling jump opcodes whose
  byte ranges shift with scene length, and (c) per-game evidence at
  ALPHA-006 confirming the rewrite does not break runtime. None of those
  validations exist yet.
- **In-place truncation/padding** — lossy, rejected on principle.

The `SlotEditLengthPolicy::FixedBudget { max_bytes }` variant is wired
through the API (for forward-compatibility) but the patch-back planner
returns a `kaifuu.reallive.patchback_unsupported_length_policy` Fatal until
a future node enables it. This keeps the trait surface stable.

### 7.3 Patch-back integrity tests

- Identity transformation (no text changes): `apply_patches` with an empty
  edit list MUST return bytes equal to `archive_bytes` (byte-for-byte). This
  is asserted by `patchback-identity-001` (§11.3).
- Identity transformation with all slots edited to their existing decoded
  text: MUST return bytes equal to `archive_bytes`. This catches encode/
  decode round-trip drift.
- Length-preserving translation: edited slot whose new encoded bytes equal
  `slot.byte_len` — patched archive parses cleanly, edited slot decodes to
  the new text, all other slots / instructions / opcodes / asset refs are
  byte-identical to the source.
- Length-overflow rejection: edited slot whose new encoded bytes exceed
  `slot.byte_len` → `patchback_overflow` Fatal, no bytes written.

### 7.4 Non-text byte invariants

The patch-back planner asserts and tests:

- The SEEN.TXT scene-count `u32` is unchanged.
- The per-scene entry table is unchanged byte-for-byte when no length-
  changing policy is used.
- Each scene's instructions (opcode opener byte, opcode byte, operand-count
  byte, operand tag bytes, `Int` operand bytes, `Label` operand bytes,
  unrecognized-instruction byte runs) are unchanged byte-for-byte.
- Each scene's protected-span control bytes are unchanged byte-for-byte.

These invariants are asserted by per-test byte-range diff helpers in
`tests/patchback.rs` (see §11.4).

---

## 8. Layered pipeline registration (KAIFUU-052)

KAIFUU-174 emits per-asset `LayeredTextSurfaceAccess` records as part of
`GameProfile.layered_access_profile` (the existing field; see
`crates/kaifuu-core/src/lib.rs:560` `LayeredAccessProfile`). The mapping is
the one in §3.4 for each surface (`Scene/SEEN dialogue` vs `Gameexe.ini
metadata`).

`AdapterCapabilities.access_contract` mirrors §3.3 with `extract`/`patch`
flipped from `Unsupported` to `Supported`. The `support_boundary` string is
updated to:

> "Scene/SEEN dialogue/speaker/choice + Gameexe.ini user-visible value
> patch-back via byte-position-stable slot ids. Length-preserving only;
> length-changing edits emit `kaifuu.reallive.patchback_offset_overflow`."

No new `ContainerTransform`/`CodecTransform`/`PatchBackTransform` variants
are introduced. Existing variants suffice
(`Archive`, `BytecodeDecompile`, `RecompileBytecode`, `ShiftJisText`,
`ReplaceFile`).

---

## 9. Semantic error catalogue

`kaifuu-reallive` already owns the `kaifuu.reallive.*` parser-local namespace
(KAIFUU-173). KAIFUU-174 extends it.

### 9.1 New parser-local codes

| Code (stable string)                                  | Severity | Where emitted                                                                                                  | Maps to `kaifuu_core::SemanticErrorCode`                              |
| ----------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `kaifuu.reallive.shift_jis_decode_failure`            | Warning  | `encoding::decode_shift_jis_slot`                                                                              | (recoverable — inventory only)                                        |
| `kaifuu.reallive.unsupported_text_shape`              | Warning  | `inventory::build_scene_inventory` (e.g. zero-length string slot tagged Dialogue, or unknown `StringSlotRole`) | `UnsupportedLayeredTransform`                                         |
| `kaifuu.reallive.protected_span.unknown_control`      | Warning  | `protected_spans::detect_protected_spans` (control byte not in §6.1)                                           | (recoverable — inventory only)                                        |
| `kaifuu.reallive.inventory.unattributed_dialogue`     | Warning  | `inventory::build_scene_inventory` (Dialogue slot without preceding SetSpeaker)                                | (recoverable)                                                         |
| `kaifuu.reallive.inventory.unknown_asset_extension`   | Warning  | `inventory::build_scene_inventory` (AssetReference slot with unknown extension)                                | (recoverable)                                                         |
| `kaifuu.reallive.inventory.unknown_gameexe_key`       | Warning  | `gameexe::parse_gameexe_inventory` (non-catalogue key)                                                         | (recoverable)                                                         |
| `kaifuu.reallive.patchback_offset_overflow`           | Fatal    | `patchback::apply_patches` (encoded bytes exceed slot byte budget)                                             | `UnsupportedLayeredTransform`                                         |
| `kaifuu.reallive.patchback_shift_jis_encode_failure`  | Fatal    | `patchback::apply_patches` (encoder hit `had_unmappable_characters`)                                           | `UnsupportedLayeredTransform`                                         |
| `kaifuu.reallive.patchback_unsupported_length_policy` | Fatal    | `patchback::apply_patches` (caller asked for `FixedBudget`)                                                    | `UnsupportedLayeredTransform`                                         |
| `kaifuu.reallive.patchback_parser_regression`         | Fatal    | `patchback::apply_patches` (re-parse self-check failed)                                                        | `UnsupportedLayeredTransform`                                         |
| `kaifuu.reallive.patchback_unknown_slot_id`           | Fatal    | `patchback::apply_patches` (edit references a slot id not present in the parsed AST)                           | `UnsupportedLayeredTransform`                                         |
| `kaifuu.reallive.patchback_stale_source_hash`         | Fatal    | adapter `patch` (PatchExport source_hash != archive bytes hash)                                                | `UnsupportedLayeredTransform` (KAIFUU-014-style stale-hash rejection) |
| `kaifuu.reallive.patchback_protected_span_lost`       | Fatal    | `patchback::apply_patches` (edited text has fewer protected spans than the source)                             | `UnsupportedLayeredTransform`                                         |

The mapping into `kaifuu_core::SemanticErrorCode` is exposed via an extension
of `diagnostics::semantic_error_code_for_parser_diagnostic` (KAIFUU-173
helper) into a `semantic_error_code_for_inventory_diagnostic` /
`semantic_error_code_for_patchback_diagnostic` pair so the adapter boundary
hard-codes the contract.

### 9.2 Adapter-level errors (KAIFUU-172 surface)

These continue to be emitted by the detector path unchanged:

- `kaifuu.unknown_engine_variant`
- `kaifuu.ambiguous_engine_variant`
- `kaifuu.unsupported_engine_variant`
- `kaifuu.unsupported_layered_transform`
- `kaifuu.missing_capability.container`
- `kaifuu.missing_capability.patch_back`

---

## 10. Bridge contract confirmation against KAIFUU-014

KAIFUU-014 dependency check (referenced from KAIFUU-173 §7 with KAIFUU-174
deltas):

| Requirement                                                                                                    | KAIFUU-174 handling                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profiles reference required keys through secret refs and never store raw key material.                         | KAIFUU-174 does no key handling; `KeyRequirement::not_required` for the alpha-vertical title set. Encrypted RealLive variants remain a separate node.                                       |
| Adapters declare required key material, archive parameters, and validation proofs with stable semantic errors. | The adapter declares `keyRequirements: []` (none); `archiveParameters` carries the SEEN.TXT envelope shape; semantic errors per §9.                                                         |
| Pure extraction and patching consume resolved keys without owning key discovery.                               | No key plumbing.                                                                                                                                                                            |
| Linux/macOS/Windows extraction and patching remain possible when supported formats are supplied.               | Pure Rust; no helper; tested on Linux/macOS via CI matrix.                                                                                                                                  |
| Redaction tests prove keys, local paths, helper dumps, and decrypted private text are not emitted.             | The adapter's `BridgeBundle` carries Shift-JIS decoded Japanese text, which is fixture-derived synthetic at this slice. Real-game text is ALPHA-006 territory and routed through redaction. |
| Stale-source-hash detection rejects edits against modified source bytes.                                       | `kaifuu.reallive.patchback_stale_source_hash` Fatal in §9.1; asserted by a fixture test that mutates the source bytes between extract and patch.                                            |

`BridgeUnit.source_unit_key` stability is the load-bearing KAIFUU-014
guarantee. KAIFUU-174 inherits the KAIFUU-173 stable id format
(`reallive:scene-NNNN:str-off-XXXXXXXX-idxNN`) verbatim and asserts it in
`tests/inventory.rs::source_unit_key_format_pinned_for_bridge_contract`.

---

## 11. Test plan (per `docs/testing-standard.md`)

Tests live in three crates: `kaifuu-reallive/tests/` (unit/integration for the
parser-adjacent surface), `kaifuu-engine-fixture/tests/` and inline tests
(adapter-level), and `kaifuu-core/tests/` indirectly via existing
contract tests (no new files in `kaifuu-core`).

Test naming follows `docs/testing-standard.md` §3 — falsifiable behavior
names, no `works`/`handles_data` placeholders.

### 11.1 Fixture set (extends KAIFUU-173)

All new fixtures are **synthetic, CC0-1.0**, authored from public format
archaeology. No retail bytes, no `/archive/vault/` access.

- `bridge-inventory-001/` — one Scene+SEEN+Gameexe set with ruby tags, color
  codes, named-character placeholders, choice tokens, asset refs (`.g00`,
  `.koe`), Dialogue+SetSpeaker+Choice opcodes. Golden artifacts: `bridge.json`
  (full BridgeBundle), `asset-refs.json` (AssetReferenceInventory),
  `warnings.json` (empty warning list at the bridge boundary).
- `protected-spans-001/` — Dialogue StringSlot exercising every kind in §6.1
  (color, ruby, name placeholder, variable placeholder, wait, clear, line
  break, size directive, unknown control). Golden: `bridge.json` with the
  matching protected-span list.
- `patchback-identity-001/` — same bytes as `bridge-inventory-001`. Asserts
  byte-for-byte equality on round-trip with empty edit list.
- `patchback-length-preserving-001/` — a Dialogue slot replaced with a new
  Shift-JIS text run whose encoded length matches the source slot's byte
  length. Golden: `patched.SEEN.TXT`.
- `patchback-overflow-001/` — a Dialogue slot replaced with text whose
  encoded length exceeds the source slot's byte length. Golden:
  `diagnostics.json` with the `kaifuu.reallive.patchback_offset_overflow`
  Fatal.
- `unsupported-text-shape-001/` — a Scene with an `Unknown`-role StringSlot
  carrying non-Shift-JIS bytes. Golden: `diagnostics.json` with the
  `kaifuu.reallive.unsupported_text_shape` Warning.

### 11.2 Required test names (falsifiable, behavior-first)

```rust
// crates/kaifuu-reallive/tests/inventory.rs

#[test]
fn extracts_bridge_units_with_kaifuu_173_stable_slot_ids_as_source_unit_keys()

#[test]
fn source_unit_key_format_pinned_for_bridge_contract()

#[test]
fn projects_dialogue_speaker_choice_string_slots_into_text_surface_strings()

#[test]
fn decodes_shift_jis_text_into_bridge_unit_source_text_for_documented_fixture_bytes()

#[test]
fn detects_color_ruby_name_choice_wait_clear_size_linebreak_control_spans_in_dialogue_slot()

#[test]
fn emits_kaifuu_reallive_protected_span_unknown_control_warning_for_unlisted_control_byte()

#[test]
fn captures_g00_and_koe_asset_references_from_string_slots_and_gameexe_ini()

#[test]
fn emits_kaifuu_reallive_inventory_unknown_gameexe_key_warning_for_non_catalogue_key()

#[test]
fn emits_kaifuu_reallive_unsupported_text_shape_warning_for_unknown_role_string_slot()

#[test]
fn produces_byte_identical_bridge_json_across_runs_for_inventory_fixture()
// stability oracle for the inventory output

// crates/kaifuu-reallive/tests/patchback.rs

#[test]
fn round_trips_archive_byte_for_byte_with_empty_edit_list()

#[test]
fn round_trips_archive_byte_for_byte_when_every_slot_is_edited_to_its_existing_decoded_text()

#[test]
fn writes_length_preserving_translated_text_into_dialogue_slot_without_corrupting_scene_table()

#[test]
fn preserves_color_ruby_name_choice_control_bytes_through_length_preserving_patchback()

#[test]
fn rejects_length_changing_edit_with_kaifuu_reallive_patchback_offset_overflow_fatal()

#[test]
fn rejects_fixed_budget_length_policy_with_kaifuu_reallive_patchback_unsupported_length_policy_fatal()

#[test]
fn rejects_unknown_slot_id_with_kaifuu_reallive_patchback_unknown_slot_id_fatal()

#[test]
fn rejects_stale_source_hash_with_kaifuu_reallive_patchback_stale_source_hash_fatal()

#[test]
fn rejects_encode_failure_with_kaifuu_reallive_patchback_shift_jis_encode_failure_fatal()

#[test]
fn rejects_protected_span_loss_with_kaifuu_reallive_patchback_protected_span_lost_fatal()

#[test]
fn rejects_self_inflicted_parser_regression_with_kaifuu_reallive_patchback_parser_regression_fatal()
// fuzz-style: inject a deliberately broken re-emit and verify the gate fires

// crates/kaifuu-engine-fixture/src/lib.rs (inline tests, matching the Siglus/XP3 pattern)

#[test]
fn reallive_adapter_extract_emits_bridge_bundle_with_scene_dialogue_units()

#[test]
fn reallive_adapter_patch_round_trips_unchanged_archive_byte_for_byte()

#[test]
fn reallive_adapter_patch_round_trips_length_preserving_translation()

#[test]
fn reallive_adapter_patch_rejects_length_overflow_with_unsupported_layered_transform_semantic_error()

#[test]
fn reallive_adapter_capabilities_report_supported_extract_patch_verify_for_kaifuu_174()

#[test]
fn reallive_adapter_layered_access_profile_describes_scene_and_gameexe_surfaces()

// crates/kaifuu-cli/tests/ (integration smoke — file new or extend)

#[test]
fn cli_extract_dispatches_to_reallive_adapter_for_reallive_seen_txt_fixture()

#[test]
fn cli_patch_round_trips_identity_for_reallive_seen_txt_fixture()
```

### 11.3 Acceptance assertions vs DAG criteria

| DAG criterion                                                                                                                    | Asserted by                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The adapter inventories Scene/SEEN/Gameexe text slots, protected markup, and asset references for AVG32-variant RealLive titles. | `extracts_bridge_units_*`, `projects_dialogue_*`, `captures_g00_and_koe_asset_references_*`                                                               |
| Extraction lands in the bridge schema with stable identifiers and protected-span markup.                                         | `source_unit_key_format_pinned_for_bridge_contract`, `detects_color_ruby_name_choice_wait_clear_size_linebreak_control_spans_in_dialogue_slot`            |
| Patch-back round-trips through the layered access pipeline without corrupting non-text bytes.                                    | `round_trips_archive_byte_for_byte_with_empty_edit_list`, `writes_length_preserving_*`, `preserves_color_ruby_name_choice_control_bytes_through_*`        |
| The adapter is engine-generic across AVG32-variant RealLive titles, not specialized to one game.                                 | `cli_extract_dispatches_to_reallive_adapter_for_reallive_seen_txt_fixture` runs across multiple synthetic Scene/SEEN/Gameexe sets with no per-game logic. |

### 11.4 auditFocus defenses

| auditFocus item                                             | Defense                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter specialized to one game rather than engine-generic. | The adapter consumes only the AST surface KAIFUU-173 provides; no game-specific branching is allowed (auditor rejects any string match against a game title, registry key, or fixture name). Cross-fixture tests in §11.2 prove the same code path drives every fixture set. |
| Patch-back corrupting non-text bytes.                       | `preserves_color_ruby_name_choice_control_bytes_through_length_preserving_patchback` + the self-check re-parse gate (`patchback_parser_regression`). The identity round-trip (§7.3) catches drift before any translation work.                                               |
| Protected markup lost or misclassified.                     | `detects_color_ruby_name_choice_wait_clear_size_linebreak_control_spans_in_dialogue_slot` exercises every catalogue entry; the `patchback_protected_span_lost` Fatal catches loss at patch time.                                                                             |
| Bridge identifiers unstable across runs.                    | `produces_byte_identical_bridge_json_across_runs_for_inventory_fixture` (3-iteration stability oracle) plus `source_unit_key_format_pinned_for_bridge_contract`.                                                                                                             |

### 11.5 Not tested at KAIFUU-174

- Real-game (Sweetie HD) parsing — ALPHA-006 territory.
- Length-changing patch-back — deferred per §7.2.
- VM execution semantics — UTSUSHI-146.
- Encrypted SEEN.TXT — future encrypted-RealLive node.
- `.g00` image-overlay text patching — separate concern; KAIFUU-174 inventories
  the asset ref but does not edit image bytes.
- `.koe`/`.ovk` voice extraction or patching.

---

## 12. Verification commands

DAG-declared commands plus the playbook supplements:

```sh
cargo fmt --check
cargo test -p kaifuu-core
cargo test -p kaifuu-reallive
cargo test -p kaifuu-engine-fixture
cargo test -p kaifuu-cli
cargo clippy -p kaifuu-reallive --all-targets -- -D warnings
cargo clippy -p kaifuu-engine-fixture --all-targets -- -D warnings
just check
just test
just fixtures-validate
just ci-kaifuu
```

Plus the manual CLI loop against the new fixture:

```sh
cargo run -p kaifuu-cli -- detect crates/kaifuu-reallive/tests/fixtures/bridge-inventory-001 \
  --output .tmp/reallive/detect.json
cargo run -p kaifuu-cli -- profile init crates/kaifuu-reallive/tests/fixtures/bridge-inventory-001 \
  --output .tmp/reallive/profile.json
cargo run -p kaifuu-cli -- asset-inventory crates/kaifuu-reallive/tests/fixtures/bridge-inventory-001 \
  --output .tmp/reallive/asset-inventory.json
cargo run -p kaifuu-cli -- extract crates/kaifuu-reallive/tests/fixtures/bridge-inventory-001 \
  --output .tmp/reallive/bridge.json
cargo run -p kaifuu-cli -- golden crates/kaifuu-reallive/tests/fixtures/bridge-inventory-001 \
  --translated-patch .tmp/reallive/patch-export.translated.json \
  --translated-source-bridge .tmp/reallive/bridge.json \
  --work-dir .tmp/reallive/golden-work \
  --output .tmp/reallive/round-trip.json
cargo run -p kaifuu-cli -- patch crates/kaifuu-reallive/tests/fixtures/bridge-inventory-001 \
  --patch .tmp/reallive/patch-export.json --output .tmp/reallive/patched
cargo run -p kaifuu-cli -- verify .tmp/reallive/patched --output .tmp/reallive/verify.json
```

Notes:

- `cargo test -p kaifuu-reallive` is load-bearing for the codec / inventory /
  patchback unit tests.
- `cargo test -p kaifuu-engine-fixture` covers the adapter trait impl plus
  the registry integration.
- `cargo test -p kaifuu-cli` covers the dispatch path (the existing CLI
  resolves through `register_default_adapters`; the new surface is exercised
  by an integration smoke that runs `extract` + `patch` end-to-end).
- `cargo test -p kaifuu-core` is required by the playbook even though
  KAIFUU-174 does not modify the core surface — protects against incidental
  regressions in `BridgeBundle` / `ProtectedSpan` / `EncodedStringSlot`.
- `just fixtures-validate` is required because new public fixture-style
  entries may be added depending on the §13 promotion decision; at this
  slice the fixtures stay crate-local (§11.1) and the command is a no-op,
  but the playbook lists it as a guardrail.

---

## 13. Risks and unknowns

| Risk                                                                                                                                                                                                                                                    | Mitigation / disposition                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Length-changing patch-back unimplemented at this slice.** Translations frequently expand or contract text in Japanese→English projects; refusing all length changes blocks practical use.                                                             | Disclosed and explicit (§7.2). The adapter returns `kaifuu.reallive.patchback_offset_overflow` Fatal with a remediation message pointing at the future node. Localization workflows that need length-changing edits route through that node when ALPHA-006 evidence justifies it.        |
| **Real-game Sweetie HD will surface protected-span shapes not in the §6 catalogue.**                                                                                                                                                                    | Expected. `protected_span.unknown_control` warning preserves the byte run and ships the BridgeUnit anyway. ALPHA-006 expands the catalogue with paired evidence per byte/shape.                                                                                                          |
| **Encoding edge cases (half-width katakana, JIS escape sequences, embedded NUL).**                                                                                                                                                                      | Half-width katakana + JIS X 0208: covered by `encoding_rs`. JIS escape sequences: not used by RealLive per public docs; if encountered, decode falls back via encoding_rs semantics and emits a warning. Embedded NUL: preserved as control-byte slice boundary.                         |
| **`encoding_rs` workspace dep adds compile-time weight.**                                                                                                                                                                                               | `encoding_rs` is a leaf dep with no transitive surprises. Build-time impact is negligible relative to the size of `kaifuu-core`. License: MIT/Apache-2.0 — compatible.                                                                                                                   |
| **Asset-reference heuristic (§4.5) may misclassify a non-asset ASCII run as an asset path.**                                                                                                                                                            | The heuristic is anchored on documented extensions (`.g00`, `.koe`, `.ovk`, `.nwk`). False positives surface as warnings, not errors; the BridgeUnit retains its original role as a comment field. Catalogue expansion is evidence-first.                                                |
| **Bridge identifier stability under future scene-edit operations (carried over from KAIFUU-173 §5.4).** Length-preserving edits at this slice do not move byte offsets; future length-changing edits would shift subsequent slot ids in the same scene. | Stale-source-hash detection (`kaifuu.reallive.patchback_stale_source_hash` Fatal in §9.1) rejects patches written against an edited source. The "logical id that survives edits" mechanism stays deferred until length-changing patch-back ships.                                        |
| **Speaker attribution heuristic** (Dialogue slot inherits the prior `SetSpeaker` slot's text) misattributes when scenes use `SetSpeaker(0x00)` to clear the speaker.                                                                                    | The heuristic emits `kaifuu.reallive.inventory.unattributed_dialogue` Warning when no `SetSpeaker` precedes a Dialogue slot and treats `SetSpeaker` with an empty string as a clear. Real-game refinement is ALPHA-006 territory.                                                        |
| **Worker accidentally consults rlvm during implementation and forgets to log it.**                                                                                                                                                                      | Same posture as KAIFUU-172/173: either no rlvm reads, or readiness-record entry plus checklist tick. Auditor rejects unchecked reads.                                                                                                                                                    |
| **Public-fixture promotion of the new fixtures**: KAIFUU-174 keeps the inventory + patchback fixtures crate-local, like KAIFUU-173. If `kaifuu-cli` integration tests load them, the `fixtures/public/manifest.schema.json` promotion happens here.     | Decision: keep crate-local at this slice. The `kaifuu-cli` integration tests under §11.2 load them via `crates/kaifuu-reallive/tests/fixtures/...` paths, not through the public-fixture manifest. Promotion happens when ALPHA-006 needs them shared with a vertical-slice integration. |

---

## 14. Out of scope

Explicitly excluded from KAIFUU-174 (each item maps to a downstream node):

- **Length-changing patch-back.** Offset-table rewrite, scene-byte-boundary
  shifting, and jump-target recalculation are deferred. The
  `SlotEditLengthPolicy::FixedBudget` path is wired through the API but
  always returns `kaifuu.reallive.patchback_unsupported_length_policy` Fatal.
- **UTSUSHI-146 — native RealLive runtime port.** Opcode execution
  semantics, jump resolution, scene-graph linking, expression evaluation,
  Save/Load state, GAN animation playback.
- **Encrypted SEEN.TXT.** Separate node; requires a key-profile boundary
  review under KAIFUU-014.
- **`.g00` image-overlay text patching.** Image-bytes inventory only;
  patching image text is a separate node.
- **`.koe` / `.nwk` / `.ovk` voice archive parsing or patching** —
  KAIFUU-064 / future node.
- **Full Gameexe.ini coverage** — only the §4.4 documented user-visible keys
  are inventoried; other keys emit warnings.
- **Full opcode coverage** — KAIFUU-173's bounded catalogue is consumed
  as-is. Unrecognized opcodes still ship `Unrecognized` AST nodes with
  warnings; KAIFUU-174 does not expand the catalogue.
- **KAIFUU-070 — Siglus known-key smoke.** Different engine.
- **Real-game (Sweetie HD) bytes** — exercised at ALPHA-006, not here.
- **Public-fixture-manifest promotion** of the new fixtures — crate-local at
  this slice (see §13).
- **Logical-id layer / offset-map** for patch-back-stability across
  length-changing edits — deferred until length-changing patch-back ships.

---

## 15. Implementation worker scoping

**One worker.**

Rationale:

- The scope is internally cohesive: the parser AST → bridge schema → patch-
  back pipeline is one read/decode/re-encode loop. Splitting between two
  workers would introduce coordination overhead on the inventory/patchback
  shared types (`SlotEdit`, `InventoryReport`).
- The clean-room provenance discipline (§17) is easier to enforce with a
  single owner.
- The bounded scope (length-preserving only, fixed protected-span catalogue,
  fixed Gameexe key catalogue) is a one-PR slice. The playbook's per-game
  evidence-first rule explicitly discourages over-allocating workers.
- The Siglus and XP3 adapters are each one worker by the same logic; the
  RealLive inventory adapter follows that pattern.

If the worker discovers during implementation that the `AssetReferenceKind`
catalogue, the protected-span catalogue, or the Gameexe key catalogue needs
expansion beyond the §4.4/§6.1 tables, the worker should **stop and
escalate** with a plan addendum rather than silently expand scope.

### 15.1 Suggested implementation order

1. Add `encoding_rs` to the workspace; add the `kaifuu-reallive` path dep to
   `kaifuu-engine-fixture/Cargo.toml`.
2. Implement `crates/kaifuu-reallive/src/encoding.rs` (decode/encode +
   control-byte slicing) plus unit tests.
3. Implement `crates/kaifuu-reallive/src/protected_spans.rs` per §6 plus
   unit tests covering each catalogue entry.
4. Author `bridge-inventory-001/` fixture bytes; commit with placeholder
   goldens.
5. Implement `crates/kaifuu-reallive/src/inventory.rs` (Scene/SEEN walk
   producing `InventoryReport`) plus tests in `tests/inventory.rs`.
6. Implement `crates/kaifuu-reallive/src/gameexe.rs` (Gameexe.ini walk).
7. Implement `crates/kaifuu-reallive/src/patchback.rs` (length-preserving
   only) plus tests in `tests/patchback.rs`. Author the fixtures
   `patchback-identity-001`, `patchback-length-preserving-001`,
   `patchback-overflow-001`.
8. Extend `RealLiveProfileDetectorAdapter` in
   `crates/kaifuu-engine-fixture/src/lib.rs` with the new trait-method
   bodies. Update `capabilities()` per §3.3. Add inline tests.
9. Add `kaifuu-cli` integration smoke under
   `crates/kaifuu-cli/tests/` for `extract` + `patch` + `verify`.
10. Update `docs/kaifuu-adapters/reallive.md` with the KAIFUU-174 addendum
    (covering: crate placement, encoding decision, length-preserving
    posture, semantic codes, capability deltas, rlvm clean-room checklist
    repeat).
11. Run the §12 verification commands; record outputs in the PR body.

---

## 16. Bridge contract sanity flow

The high-level dataflow expected of the implementation worker, in one
diagram, so the contract is unambiguous:

```text
                 +--------------------+
                 | SEEN.TXT bytes     |
                 | Gameexe.ini bytes  |
                 +--------------------+
                          |
            (KAIFUU-172) detect
                          |
            (KAIFUU-173) parse_archive(SEEN.TXT) -> SceneIndex
                         parse_scene(blob, i) -> Scene + diagnostics
                          |
       (KAIFUU-174) inventory::build_scene_inventory(...)
                    encoding::decode_shift_jis_slot per StringSlot
                    protected_spans::detect_protected_spans per slot
                    gameexe::parse_gameexe_inventory
                          |
                          v
                 +--------------------+
                 | InventoryReport    |
                 |   bridge_units     | --> kaifuu_core::BridgeBundle
                 |   asset_refs       | --> kaifuu_core::AssetInventory
                 |   warnings         | --> AdapterWarning list
                 +--------------------+
                          |
            adapter.extract -> ExtractionResult { bridge: BridgeBundle, .. }
                          |
                 (translator edits BridgeUnits)
                          |
            adapter.patch -> reads PatchExport,
                             reads original archive bytes,
                             builds Vec<SlotEdit>,
                             patchback::apply_patches(...),
                             writes patched SEEN.TXT atomically into output_dir
                          |
            adapter.verify -> re-runs parse_archive + parse_scene
                              against the patched output,
                              asserts edited slots decode to new text and
                              all other bytes are byte-identical to source
```

---

## 17. Clean-room provenance

### 17.1 Crate-level provenance comment

The KAIFUU-173 `crates/kaifuu-reallive/src/lib.rs` provenance block is
**extended** (not replaced) with a KAIFUU-174 paragraph documenting:

- Shift-JIS decoding uses `encoding_rs` (WHATWG-spec implementation, not a
  copy of rlvm or RLDEV).
- Protected-span catalogue is derived from public RLDEV documentation.
- Patch-back is length-preserving only; offset-table rewriting and
  jump-target recalculation are not implemented.
- No `Command::new`, no helper, no I/O inside `kaifuu-reallive`.

The same paragraph appears as the module preamble at the top of
`encoding.rs`, `protected_spans.rs`, `inventory.rs`, `gameexe.rs`, and
`patchback.rs`.

### 17.2 Readiness record update

`docs/kaifuu-adapters/reallive.md` gains a third top-level section,
`## KAIFUU-174 text inventory adapter addendum`, below the existing
KAIFUU-173 addendum. Contents:

- Roadmap node: KAIFUU-174.
- Crate or module: `kaifuu-reallive` (inventory + patchback modules) +
  `kaifuu-engine-fixture` (`RealLiveProfileDetectorAdapter` trait impl
  extended).
- Initial support boundary: Scene/SEEN dialogue/speaker/choice +
  Gameexe.ini user-visible value text inventory and length-preserving
  patch-back.
- Unsupported or gated boundary: length-changing patch-back, encrypted
  SEEN.TXT, `.g00` image-overlay text, `.koe`/`.ovk` voice extraction,
  RealLive VM replay.
- Public fixture ids: `bridge-inventory-001`, `protected-spans-001`,
  `patchback-identity-001`, `patchback-length-preserving-001`,
  `patchback-overflow-001`, `unsupported-text-shape-001` (crate-local at
  this slice).
- Fixture license: synthetic, CC0-1.0.
- Supported encodings: Shift-JIS (via `encoding_rs`).
- Text surfaces: Dialogue, SpeakerName, ChoiceLabel, MetadataText
  (Gameexe.ini).
- Patch modes: length-preserving slot replacement only.
- Asset inventory surfaces: top-level files (carry forward from KAIFUU-172)
  plus per-StringSlot asset refs and per-Gameexe-key asset refs.
- Semantic capability errors: §9.1 catalogue.
- Reference implementations and docs:
  - Haeleth's RLDEV site → `behavior-only-clean-room`.
  - rlvm → `behavior-only-clean-room`; not linked, not derived.
  - `encoding_rs` → permissive Cargo dep (WHATWG-spec Shift-JIS).
- Parser spike status: completed under KAIFUU-173.
- Local validation commands: §12 above.
- Known gaps: length-changing patch-back, UTSUSHI-146 runtime port,
  encrypted RealLive, `.koe`/`.ovk` voice work, `.g00` image-overlay text.

The rlvm clean-room worker checklist gains a third pass for KAIFUU-174,
mirroring the KAIFUU-172/173 templates verbatim (six checkboxes plus the
"future worker reads rlvm" hand-off marker).

---

## 18. Cross-references

- `docs/subprojects-kaifuu.md` — adapter trait, no-shell-out rule, layered
  pipeline.
- `docs/kaifuu-engine-playbook.md` — readiness record template, round-trip
  test gates, semantic error rules, helper boundaries.
- `docs/kaifuu-fixture-policy.md` — public-fixture layering, license
  review.
- `docs/kaifuu-patch-safety.md` — encoding, atomic output, path traversal,
  rollback, partial-write safety rules.
- `docs/testing-standard.md` — falsifiable test names, fixture layering,
  golden-fixture policy.
- `docs/kaifuu-adapters/reallive.md` — KAIFUU-172 + KAIFUU-173 readiness
  records; KAIFUU-174 addendum is appended.
- `crates/kaifuu-core/src/lib.rs` — `BridgeBundle`, `BridgeUnit`,
  `ProtectedSpan`, `EngineAdapter`, `SemanticErrorCode`,
  `LayeredAccessProfile`, `LayeredTextSurfaceAccess`,
  `LayeredAccessCapabilityContract`.
- `crates/kaifuu-core/src/offset_map.rs` — `EncodedStringSlot`,
  `EncodedStringSlotLayout`, `EncodedStringSlotProtectedSpan`,
  `ByteSpan`, `SourceEncoding`, `encode_shift_jis` preflight table.
- `crates/kaifuu-reallive/src/{archive,parser,ast,strings,opcodes,diagnostics}.rs`
  — KAIFUU-173 parser surface consumed by KAIFUU-174.
- `crates/kaifuu-engine-fixture/src/lib.rs:3286-4338` — KAIFUU-172
  RealLive detector adapter; KAIFUU-174 extends it in place.
- `.plan/KAIFUU-172.md`, `.plan/KAIFUU-173.md` — prior plans; this plan
  inherits their sectioning and clean-room posture.
- Roadmap DAG nodes: KAIFUU-014, KAIFUU-052, KAIFUU-070, KAIFUU-172,
  KAIFUU-173, UTSUSHI-146, ALPHA-006.
