# KAIFUU-173 Implementation Plan — RealLive Scene/SEEN parser-boundary smoke

| Field    | Value                                                              |
| -------- | ------------------------------------------------------------------ |
| Node id  | KAIFUU-173                                                         |
| Title    | RealLive Scene/SEEN parser-boundary smoke                          |
| Branch   | `spec/kaifuu-173`                                                  |
| Worktree | `/scratch/worktrees/itotori-spec-kaifuu-173`                       |
| Author   | orchestrator (planner)                                             |
| Date     | 2026-06-23                                                         |
| Status   | planning — implementation worker not yet dispatched                |
| Depends  | KAIFUU-172 (detector), KAIFUU-014 (key/profile boundary), KAIFUU-052 (layered text access pipeline) |
| Unblocks | KAIFUU-174 (text inventory adapter), UTSUSHI-146 (runtime port)    |

This plan is **planning only**. No Rust feature code is included; illustrative
sketches use `// pseudo-code` comments. The implementation worker must follow
`docs/kaifuu-engine-playbook.md`, `docs/kaifuu-fixture-policy.md`, and the
clean-room provenance / no-shell-out rules already established by KAIFUU-172.

---

## 1. Crate placement decision

**Decision: introduce a new `crates/kaifuu-reallive` workspace member.**

Rationale, weighed against the KAIFUU-172 choice to stay inside
`kaifuu-engine-fixture`:

- KAIFUU-172 (detector) was a small per-adapter filesystem scan plus a matrix
  row. It legitimately fit alongside `SiglusProfileDetectorAdapter` (an
  existing detector struct in the same file). The shared
  `kaifuu-engine-fixture/src/lib.rs` is already ~6.9k LOC; adding a Scene/SEEN
  bytecode parser would push that single-file pattern past its useful size.
- KAIFUU-173 is the first **parser** in the workspace that decodes engine
  bytecode rather than scanning filesystem signatures. The parser introduces a
  new AST type set (`Scene`, `Instruction`, `Operand`, `StringSlot`),
  table-of-contents decoding, and a meaningful opcode catalogue. Mixing those
  into `kaifuu-engine-fixture` would conflate "registry of detector adapters
  with profile/inventory glue" with "engine-specific decoder library".
- The DAG node's declared verification command is `cargo test -p
  kaifuu-reallive`. The dependent KAIFUU-174 (text inventory adapter) and
  UTSUSHI-146 (native runtime port) will both consume the parser surface, and
  both should be able to depend on a self-contained `kaifuu-reallive` crate
  without pulling in the entire fixture-detector tree.
- The detector readiness record at
  `docs/kaifuu-adapters/reallive.md:6` already names this exact split:
  "A dedicated `kaifuu-reallive` crate is deferred to KAIFUU-173/174 once the
  parser/extractor lands." This plan executes that deferred decision.
- Cross-OS / no-shell-out posture is preserved: the new crate has the same
  zero-helper, zero-`Command::new` posture as `kaifuu-core`.

The new crate is **library-only** at this slice. It does NOT register an
`EngineAdapter` (that's KAIFUU-174's text-inventory adapter scope); it
exposes a `parse_scene(bytes: &[u8]) -> ParseOutcome` style entry point and
the AST types. The detector adapter in `kaifuu-engine-fixture` stays exactly
where it is; KAIFUU-173 does not modify it.

`crates/kaifuu-core` continues to own the shared semantic codes,
`EncodedStringSlot` layout, and bridge-schema types. `kaifuu-reallive`
depends on `kaifuu-core` (and only `kaifuu-core` + `serde` + `serde_json` +
`thiserror`); it does NOT depend on `kaifuu-engine-fixture`.

### 1.1 Workspace changes

- Add `crates/kaifuu-reallive` to the `members` array in the root
  `Cargo.toml`.
- New `crates/kaifuu-reallive/Cargo.toml`:

  ```toml
  [package]
  name = "kaifuu-reallive"
  version = "0.0.0"
  edition.workspace = true
  license.workspace = true
  repository.workspace = true
  description = "Pure-Rust RealLive Scene/SEEN parser-boundary smoke. Clean-room, behavior-only; rlvm not linked, not derived."

  [dependencies]
  kaifuu-core = { path = "../kaifuu-core" }
  serde.workspace = true
  serde_json.workspace = true
  thiserror.workspace = true
  ```

- Update `roadmap/spec-dag.json` only if the DAG validator requires the
  crate to be named under a coverage map; otherwise no change is needed
  (the existing `cargo test -p kaifuu-reallive` verification line already
  anticipates the crate).

---

## 2. Module boundaries and file layout

```
crates/kaifuu-reallive/
  Cargo.toml
  src/
    lib.rs               # public API surface, re-exports, crate-level
                         #   clean-room provenance doc-comment, parse_scene()
                         #   entry point
    archive.rs           # SEEN.TXT archive envelope (count + offset/size
                         #   table) decoder; produces SceneIndex with stable
                         #   per-scene IDs derived from index position
    parser.rs            # bytecode parser FSM: walks scene bytes, dispatches
                         #   per-instruction operand decode, emits Instruction
                         #   stream + diagnostics
    ast.rs               # Scene, Instruction, Operand, StringSlot,
                         #   ParseOutcome, ParseDiagnostic types
    opcodes.rs           # named opcode catalogue (bounded set covering the
                         #   synthetic fixture + the documented common-case
                         #   cushion) plus operand-shape descriptors
    strings.rs           # string-slot extraction + stable slot-id derivation;
                         #   bridges to kaifuu_core::EncodedStringSlot
    diagnostics.rs       # ParseDiagnostic envelope + mapping to
                         #   kaifuu_core::SemanticErrorCode
  tests/
    fixtures/
      smoke-scene-001/
        SEEN.TXT         # synthetic single-scene SEEN archive (1 scene entry)
        expected/
          ast.json       # golden AST (semantic JSON, schema-versioned)
          string-slots.json
          diagnostics.json
      truncated-scene-001/
        SEEN.TXT
        expected/
          diagnostics.json
      unknown-opcode-001/
        SEEN.TXT
        expected/
          ast.json
          diagnostics.json
    smoke.rs             # falsifiable end-to-end tests (see §9)
```

### 2.1 Public API surface (crate root)

```rust
// Pseudo-signatures only; the implementation worker chooses the exact shape
// that keeps the AST types ergonomic for KAIFUU-174.

pub use ast::{
    Scene, SceneIndex, SceneEntry, Instruction, InstructionKind, Operand,
    StringSlot, StringSlotId, ParseOutcome, ParseDiagnostic,
};
pub use diagnostics::ParseDiagnosticCode;

pub fn parse_archive(bytes: &[u8]) -> Result<SceneIndex, ParseDiagnostic>;
pub fn parse_scene(scene_bytes: &[u8], scene_offset: u64) -> ParseOutcome;
```

`scene_offset` is the byte offset of the scene blob within the parent SEEN.TXT
archive; it is the load-bearing input for the stable string-slot id derivation
(see §5.3).

### 2.2 What this crate does NOT export

- No `EngineAdapter` impl — that lives in KAIFUU-174's text-inventory adapter
  crate (or in `kaifuu-engine-fixture`, depending on where KAIFUU-174 lands).
- No patch writer.
- No VM, no scene-graph linker, no jump resolver, no expression evaluator.
- No I/O (no `std::fs`, no `Command::new`, no helper hooks). Callers read
  bytes; the parser is a pure function.

---

## 3. Scene-format catalog and provenance

The parser implements a deliberately narrow envelope: the synthetic fixture's
single-scene SEEN.TXT, plus a documented opcode cushion (see §6). Format
facts cited below come from **public format archaeology**. rlvm is read only
as a research anchor; no expression is copied (see §11 clean-room
provenance).

### 3.1 SEEN.TXT envelope

| Fact                                                                                                                                                                  | Source / derivation status                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Little-endian `u32` scene count at offset 0.                                                                                                                          | **Public docs**: Haeleth's RLDEV site (`https://dev.haeleth.net/rldev.shtml`) plus the publicly-archived RLDEV format reference; matches the envelope check already in `crates/kaifuu-engine-fixture/src/lib.rs:4276` (`reallive_seen_txt_envelope_ok`).                                                                                                                                                                              |
| Per-scene table entry: `u32 offset` + `u32 size`, both little-endian.                                                                                                 | **Public docs** (RLDEV format notes); the detector's envelope check at `crates/kaifuu-engine-fixture/src/lib.rs:4296-4298` already uses 8 bytes per entry as the floor. KAIFUU-173 ratifies the exact `(offset, size)` interpretation only against the synthetic fixture and a small cushion; real-game corroboration is ALPHA-006's job. |
| Scene blob payload starts at `entry.offset` (absolute, from start of SEEN.TXT).                                                                                       | **Public docs** + **observable behavior** on the synthetic fixture.                                                                                                                                                                                                                                                                                                                                                              |
| Scene blob may begin with a small per-scene header before bytecode. **Out of scope for KAIFUU-173**; the smoke parses bytecode starting at `entry.offset` directly.   | The presence of a per-scene header is documented but variable; KAIFUU-173 stays at the boundary by treating `entry.offset` as the bytecode start for the synthetic fixture. The smoke does **not** claim correct parsing of all real-world per-scene-header variants — `kaifuu.unknown_engine_variant` is emitted when a real game shows an unexpected header shape (see §8). |

### 3.2 Bytecode instruction encoding (RLDEV-style)

| Fact                                                                                                                                       | Source / derivation status                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instructions are byte-delimited, length-prefixed with a recognisable opener byte (commonly `0x23` `'#'` for instructions and `0x22` `'"'` for inline string literals in some RLDEV documentation, but the precise byte map varies by build).               | **Public docs** with **observable behavior** confirmation. The synthetic fixture uses a deliberately small opener-byte set; the named opcode catalogue (§6) is built bottom-up from the synthetic bytes plus a cushion of "common-case" opcodes that are universally documented in RLDEV.   |
| Operands follow a typed sequence determined by the opcode: integers (variable-width), strings (length-prefixed), and references to scene-internal labels.                                                                                                  | **Public docs**. KAIFUU-173 implements **only the operand shapes the synthetic fixture exercises**, plus the named-opcode cushion in §6. Unhandled operand shapes are reported as `kaifuu.reallive.unrecognized_instruction` semantic diagnostics (see §8).                                  |
| String literals embedded inline in the bytecode carry a length prefix and an encoding hint that the parser preserves verbatim. The synthetic fixture uses ASCII; real-game Shift-JIS handling is a KAIFUU-174 / KAIFUU-052 codec-stage concern, not a KAIFUU-173 parse step. | **Public docs** + **synthetic fixture**. The parser produces raw byte slices for string slots and stamps the slot with an `encoding: SourceEncoding` derived from the surrounding context (see §5).                                                                                              |

### 3.3 Per-fact derivation summary

Every fact above is annotated with one of:

- **public docs**: derived from Haeleth's RLDEV site or the publicly-archived
  RLDEV format documentation. Independent re-derivation against the
  synthetic fixture confirms each fact before it appears in code.
- **observable behavior**: derived from synthetic-fixture round-trip behavior
  authored in this repository. No retail bytes are inspected.
- **not derived / out of scope**: the per-scene header variability, the full
  opcode map, the expression evaluator semantics, and the Shift-JIS codec
  stage are out of scope.

Citations and license decisions are recorded in §11 and re-asserted at the
top of `crates/kaifuu-reallive/src/lib.rs`.

---

## 4. AST shape

```rust
// AST types — pseudo-code; final field layout chosen by the implementer.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneIndex {
    pub schema_version: String,        // "0.1.0"
    pub source_archive_byte_len: u64,
    pub entries: Vec<SceneEntry>,      // stable order = archive order
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneEntry {
    pub scene_id: SceneId,             // stable id, derived from index position
    pub archive_index: u32,            // ordinal position (0-based)
    pub byte_offset: u64,              // absolute offset in SEEN.TXT
    pub byte_len: u64,
}

// SceneId is a typed wrapper (newtype) over a string so callers cannot
// accidentally substitute a free-form String.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SceneId(String);             // format: "scene-{archive_index:04}"

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scene {
    pub schema_version: String,        // "0.1.0"
    pub scene_id: SceneId,
    pub instructions: Vec<Instruction>,
    pub strings: Vec<StringSlot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instruction {
    pub instruction_id: InstructionId, // stable per-scene id (see §5.3)
    pub byte_offset: u64,              // offset within the scene blob
    pub byte_len: u64,
    pub kind: InstructionKind,
    pub operands: Vec<Operand>,
    pub string_slot_refs: Vec<StringSlotRef>,  // FK into Scene.strings
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum InstructionKind {
    Named { opcode: NamedOpcode },
    Unrecognized { raw_opener_byte: u8 },  // emitted only paired with a
                                            // semantic diagnostic; see §8
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NamedOpcode {
    // See §6 for the full bounded catalogue.
    TextDisplay,
    SetSpeaker,
    Choice,
    SetVar,
    Jump,
    Return,
    ClearScreen,
    Pause,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Operand {
    Int { value: i32, byte_offset: u64, byte_len: u64 },
    String { slot_ref: StringSlotRef },
    Label { name: String, byte_offset: u64, byte_len: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StringSlot {
    pub slot_id: StringSlotId,                       // see §5.3
    pub byte_offset_within_scene: u64,
    pub byte_len: u64,
    pub encoding: SourceEncoding,                     // from kaifuu_core
    pub raw_bytes_hex: String,                        // verbatim, no decode
    pub semantic_role: StringSlotRole,                // Dialogue, Choice,
                                                      //   SpeakerName, Asset,
                                                      //   Unknown
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum StringSlotRole {
    Dialogue,
    SpeakerName,
    Choice,
    AssetReference,
    Unknown,
}
```

`StringSlotId` and `InstructionId` are newtype-wrapped strings; their format
rules are defined in §5.3.

### 4.1 ParseOutcome envelope

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseOutcome {
    pub schema_version: String,                 // "0.1.0"
    pub scene: Option<Scene>,                   // None when fatal diagnostics
    pub diagnostics: Vec<ParseDiagnostic>,
    pub status: ParseStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ParseStatus {
    Ok,                 // no diagnostics
    OkWithWarnings,     // unrecognized-instruction diagnostics; AST still emitted
    Failed,             // scene-boundary / envelope diagnostics; AST omitted
}
```

The split between `OkWithWarnings` and `Failed` is the load-bearing
guarantee: an unrecognized instruction (recoverable) leaves the rest of the
AST intact and emits a semantic diagnostic next to the instruction. A
truncated scene or invalid envelope produces `Failed` with no partial AST.
Neither path silently skips.

---

## 5. String-slot identifiers and bridge integration

### 5.1 Why this matters

The DAG node's third acceptance criterion requires stable string-slot
identifiers usable by the bridge schema. The first auditFocus item flags
"string-slot identifiers unstable across runs" as a reject condition.

### 5.2 Bridge contract under KAIFUU-014 / KAIFUU-052

KAIFUU-014 ratified the key-profile / secret-ref boundary (no raw key bytes
in any artifact). KAIFUU-052 ratified the per-surface layered access pipeline
(`identify → unpack → decrypt → decode/decompile → normalize → patch back`).
The parser output sits at the **decode/decompile** stage of a RealLive
text-bearing surface.

The bridge consumer is `kaifuu_core::BridgeUnit`
(`crates/kaifuu-core/src/lib.rs:11896`). Its `source_unit_key` field is the
stable key that survives across re-extractions; it is also the join key when
KAIFUU-174 emits an extraction report. The string-slot id is the value that
flows into `source_unit_key`.

`kaifuu_core::EncodedStringSlot`
(`crates/kaifuu-core/src/offset_map.rs:254`) carries the byte-range,
encoding, and layout that KAIFUU-174 will need for patch-back; KAIFUU-173
uses the **same `slot_id` string** in `EncodedStringSlot.slot_id` and in
`StringSlot.slot_id` so the boundary between parse and patch-back is a
single identifier.

### 5.3 Stable id derivation rule

Identifiers are derived **deterministically from byte position only**, never
from execution order, parse order, or a counter:

```
StringSlotId  = "reallive:scene-{archive_index:04}:str-off-{slot_byte_offset_within_scene:08x}-idx{slot_index_within_instruction:02}"
InstructionId = "reallive:scene-{archive_index:04}:ins-off-{instr_byte_offset_within_scene:08x}"
SceneId       = "reallive:scene-{archive_index:04}"
```

Properties:

- **Stable across runs**: identical input bytes always produce identical
  ids, regardless of CPU, OS, parallelism, or RNG state.
- **Stable across irrelevant edits**: re-running the parser after an
  unrelated edit to a *different* scene in the same SEEN.TXT leaves this
  scene's slot ids unchanged (the derivation does not depend on global
  archive layout beyond the per-scene index).
- **Position-derived, not name-derived**: ids do not depend on opcode
  recognition or on the named-opcode catalogue. An unrecognized
  instruction still gets a stable `InstructionId` (and a paired
  semantic diagnostic).
- **Auditable**: the `slot_byte_offset_within_scene` is itself a field on
  `StringSlot`, so the id is independently verifiable from the AST.

### 5.4 Stability under future scene-edit operations

This is called out explicitly as a risk in §12. Once KAIFUU-174 introduces
patch-back, edits that **change the byte size** of an earlier slot in the
same scene will shift `byte_offset_within_scene` for later slots. The
mitigation: the bridge contract under KAIFUU-014 requires `source_hash` on
every `BridgeUnit`, and stale-hash detection (already enforced by
`kaifuu-core`) rejects a patch that would invalidate previously-assigned
ids. KAIFUU-173 does not introduce a "logical id that survives edits"
mechanism; it provides a **physical-position id** that the patch-back
pipeline at KAIFUU-174 maps to a logical id with a separate offset-map
table. The decision is documented in §12 as a deferred risk.

### 5.5 Flow into the bridge schema

KAIFUU-173 does **not** emit `BridgeBundle` or `BridgeUnit` directly — that
remains KAIFUU-174's responsibility. KAIFUU-173 emits AST types that
KAIFUU-174 will project into the bridge:

```
StringSlot.slot_id              -> BridgeUnit.source_unit_key
StringSlot.byte_offset_within_scene
                                -> EncodedStringSlot.byte_range.start
StringSlot.byte_len             -> EncodedStringSlot.byte_range.len
StringSlot.encoding             -> EncodedStringSlot.encoding
StringSlot.raw_bytes_hex        -> source for sha256 / source_hash
StringSlot.semantic_role        -> BridgeUnit.text_surface (mapped)
```

This mapping is documented as an integration note in `lib.rs`; a test in
`kaifuu-reallive/tests/smoke.rs` asserts the slot-id format precisely so
KAIFUU-174 can hard-code the contract.

---

## 6. Opcode coverage (bounded)

The smoke recognizes a small, named, justifiable opcode set. The hard rule:
**every opcode is named, never an opaque byte range**. Unrecognized opcodes
are not silently skipped — they emit a semantic diagnostic and an
`InstructionKind::Unrecognized` AST node (see §8).

### 6.1 Inclusion criteria

An opcode is included when **both** of the following hold:

1. It is exercised by the synthetic fixture (smoke-scene-001), OR it is in
   the documented "common-case cushion" — a small set of opcodes that
   every RealLive text-display scene uses universally (the documented
   common-case set, per Haeleth's RLDEV documentation).
2. Its operand shape is documented in publicly-archived format notes (no
   reverse-engineering from retail bytes).

### 6.2 Initial named-opcode catalogue

The names are RLDEV-style descriptive labels; the byte-value mapping is
derived from the synthetic fixture plus the documented common-case set.

| Named opcode    | Purpose                                                                 | Synthetic fixture exercises? | Cushion (documented universal case)? |
| --------------- | ----------------------------------------------------------------------- | ---------------------------- | ------------------------------------ |
| `TextDisplay`   | Display a dialogue text string                                          | yes                          | yes                                  |
| `SetSpeaker`    | Set the active speaker name string                                      | yes                          | yes                                  |
| `Choice`        | Present a choice option (one string slot per option)                    | yes                          | yes                                  |
| `SetVar`        | Assign a small integer to a numeric variable                            | no                           | yes                                  |
| `Jump`          | Jump to a named label within the same scene                             | no                           | yes                                  |
| `Return`        | Return from a scene-internal sub-section                                | no                           | yes                                  |
| `ClearScreen`   | Clear the text window                                                   | no                           | yes                                  |
| `Pause`         | Pause for keypress                                                      | yes                          | yes                                  |

The catalogue is intentionally short. Extraction of "all 200+ RealLive
opcodes" is **not** in this scope; that is KAIFUU-174's text-inventory
adapter scope and later UTSUSHI-146's VM port scope.

### 6.3 What "named" means

`InstructionKind::Named { opcode }` carries the typed `NamedOpcode` variant
above. The serialized AST emits the string form (e.g. `"text_display"`),
not a raw byte. Tests assert the string form, not the byte mapping.

### 6.4 What the cushion is NOT

The cushion is **not** "every opcode rlvm or RLDEV documents". It is
restricted to the universally-documented common-case set above. Each new
opcode added later must satisfy the inclusion criteria (§6.1) and add a
matching synthetic-fixture test case. This forces incremental, evidence-led
expansion rather than a wholesale opcode-table port.

---

## 7. Bridge schema integration confirmation against KAIFUU-014

KAIFUU-014's contract demands:

| Requirement                                                                                                   | KAIFUU-173 handling                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Profiles reference required keys through secret refs and never store raw key material.                        | KAIFUU-173 does no key handling. The detector at KAIFUU-172 already declared `KeyRequirement::not_required` for the alpha vertical. |
| Adapters declare required key material, archive parameters, and validation proofs with stable semantic errors. | KAIFUU-173 is a library, not an adapter; it returns parser diagnostics (§8). KAIFUU-174 inherits any future key declarations.       |
| Pure extraction and patching consume resolved keys without owning key discovery.                              | Parser takes raw bytes — no key plumbing.                                                                                            |
| Linux/macOS extraction and patching remain possible when supported formats and required keys are supplied.    | Parser is platform-neutral pure Rust; no helper.                                                                                     |
| Redaction tests prove keys, local paths, helper dumps, and decrypted private text are not emitted.            | No private content reaches the AST; the synthetic fixture is the only input for KAIFUU-173 tests.                                  |

KAIFUU-052's layered text access pipeline:

| Stage                       | KAIFUU-173 contribution                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Locate surface              | Already covered by KAIFUU-172's detector.                                                                                                                                                          |
| Unpack container            | KAIFUU-173's `parse_archive` decodes the SEEN.TXT envelope and emits a `SceneIndex`. This is the unpack-container layer for the SEEN.TXT-as-archive surface.                                       |
| Decrypt                     | Identity / null-key for the alpha vertical. KAIFUU-173 does not introduce any crypto stage.                                                                                                        |
| Decode / decompile          | KAIFUU-173's `parse_scene` is the decompile layer; it emits the AST plus `StringSlot`s.                                                                                                            |
| Normalize text              | **Out of scope** — Shift-JIS decoding and protected-span normalization are KAIFUU-174's. The parser exposes raw bytes plus an `encoding` hint.                                                     |
| Patch back                  | **Out of scope** — KAIFUU-174.                                                                                                                                                                    |

KAIFUU-052's enums (`ContainerTransform`, `CryptoTransform`, `CodecTransform`,
`PatchBackTransform`) are referenced through `kaifuu_core` but
KAIFUU-173 does **not** add new variants. KAIFUU-174 introduces
`ContainerTransform::RealLiveSeen` (or similar) when the text-inventory
adapter formally exposes the surface; KAIFUU-173 stays library-only.

---

## 8. Semantic diagnostic catalog

The parser emits structured `ParseDiagnostic` envelopes. Every diagnostic
carries a `code` field that is a stable string.

### 8.1 Diagnostic envelope

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseDiagnostic {
    pub code: ParseDiagnosticCode,           // stable enum, serde-string
    pub severity: DiagnosticSeverity,         // Fatal | Warning
    pub byte_offset: u64,                     // offset within the scene blob
                                              //   (or within the archive for
                                              //   envelope diagnostics)
    pub byte_len: Option<u64>,                // covered byte run if known
    pub raw_bytes_hex: Option<String>,        // up to first 16 bytes, hex,
                                              //   for debugging
    pub message: String,                      // human-readable detail
                                              //   (no path, no encoded text)
    pub remediation: Option<String>,
}
```

### 8.2 Diagnostic codes

| Code (stable string)                        | Severity | Meaning                                                                                                                                                                                                           |
| ------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kaifuu.reallive.invalid_archive_envelope`  | Fatal    | SEEN.TXT envelope failed structural validation (scene count zero, count above the documented sanity ceiling, offset/size table runs past file length). Maps to `kaifuu_core::SemanticErrorCode::UnknownEngineVariant` at the adapter boundary. |
| `kaifuu.reallive.truncated_scene`           | Fatal    | Scene entry's `offset + size` runs past the archive bytes; the scene blob cannot be parsed.                                                                                                                       |
| `kaifuu.reallive.truncated_instruction`     | Fatal    | An instruction's operand run goes past the scene blob's end before completing.                                                                                                                                    |
| `kaifuu.reallive.unrecognized_instruction`  | Warning  | The opener byte does not match any opcode in the named catalogue (§6.2). The parser still records the instruction byte range as `InstructionKind::Unrecognized` and continues from the next opcode boundary.       |
| `kaifuu.reallive.unrecognized_operand_shape`| Warning  | Opcode is named, but the operand shape diverges from the catalogue. The instruction is recorded with the operand bytes verbatim; the diagnostic flags it for KAIFUU-174 follow-up.                                  |
| `kaifuu.reallive.invalid_string_slot`       | Warning  | A string-slot length prefix runs past the instruction's byte range. The slot is recorded with `byte_len = 0` and a diagnostic is emitted.                                                                          |
| `kaifuu.reallive.out_of_profile_input`      | Fatal    | First bytes of SEEN.TXT do not match the expected envelope shape (e.g. caller passed a non-RealLive file). Maps to `kaifuu_core::SemanticErrorCode::UnsupportedEngineVariant` at the adapter boundary.            |

### 8.3 No silent skips

This is the load-bearing posture for the third auditFocus item ("Parser-
boundary failures hidden as silent skips"):

- The parser never returns an empty `Vec<Instruction>` and `Ok` without a
  diagnostic. Every byte run that does not produce an `Instruction` either
  produces a diagnostic OR is past the documented end-of-scene marker.
- Unrecognized opener bytes produce both a diagnostic AND an
  `Unrecognized` instruction (which carries the opener byte). The byte
  range is **never** dropped from the AST.
- The synthetic fixture's smoke test asserts that the AST + diagnostics
  partition the scene-blob byte range completely (see §9.4 test
  `partitions_scene_bytes_completely_into_instructions_and_diagnostics`).

### 8.4 Mapping to `kaifuu_core` semantic codes

`ParseDiagnosticCode` is a parser-local code namespace
(`kaifuu.reallive.*`). It is **distinct from** `kaifuu_core::SemanticErrorCode`
because the parser is a library, not an adapter, and is callable from
multiple call sites with different error-routing needs.

KAIFUU-174 (the adapter that will call into this crate) is responsible for
mapping parser diagnostics into `kaifuu_core::SemanticErrorCode` at the
adapter boundary. The mapping rules are documented in `diagnostics.rs` as
constants and re-asserted in this crate's tests:

| Parser diagnostic                            | Adapter `SemanticErrorCode` (KAIFUU-174 boundary)                  |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `kaifuu.reallive.invalid_archive_envelope`   | `kaifuu.unknown_engine_variant`                                    |
| `kaifuu.reallive.truncated_scene`            | `kaifuu.unknown_engine_variant`                                    |
| `kaifuu.reallive.truncated_instruction`      | `kaifuu.unsupported_layered_transform` (codec stage)               |
| `kaifuu.reallive.unrecognized_instruction`   | (recoverable — no adapter-level error; surfaces in inventory only) |
| `kaifuu.reallive.unrecognized_operand_shape` | (recoverable)                                                      |
| `kaifuu.reallive.invalid_string_slot`        | `kaifuu.unsupported_layered_transform` (codec stage)               |
| `kaifuu.reallive.out_of_profile_input`       | `kaifuu.unsupported_engine_variant`                                |

These mappings exist as `pub const` strings so KAIFUU-174 hard-codes the
contract.

---

## 9. Test plan

Tests live in `crates/kaifuu-reallive/tests/smoke.rs` and use synthetic
fixtures under `crates/kaifuu-reallive/tests/fixtures/`. Test naming follows
`docs/testing-standard.md` — falsifiable behavior names, no
`works`/`handles_data` placeholders.

### 9.1 Fixture set

Three temp-and-committed fixtures, all synthetic, all under
`crates/kaifuu-reallive/tests/fixtures/`:

- `smoke-scene-001/SEEN.TXT` — single-scene SEEN.TXT envelope (1 entry in
  the table; small bytecode payload exercising `TextDisplay`,
  `SetSpeaker`, `Choice`, and `Pause`). Authored by the implementation
  worker; redistributable; **synthetic, contains no copyrighted RealLive
  bytes**.
- `truncated-scene-001/SEEN.TXT` — envelope claims one scene but the
  payload runs short.
- `unknown-opcode-001/SEEN.TXT` — one scene whose bytecode contains a
  recognized instruction followed by an unrecognized opener byte
  followed by a recoverable recognized instruction.

Each fixture has an `expected/` sibling directory with golden artifacts:

- `expected/ast.json` (when an AST is expected)
- `expected/string-slots.json` (when slots are expected)
- `expected/diagnostics.json` (always present)

Golden artifacts are **semantic JSON**, not snapshot dumps. Tests assert
field-by-field (see §9.4), then optionally check the byte-for-byte JSON
golden as a regression guard.

### 9.2 Public-fixture manifest

A new entry is added to `fixtures/public/manifest.schema.json` coverage by
adding a `crates/kaifuu-reallive/tests/fixtures/` manifest. **OR**: per the
testing-standard fixture-layering policy
(`docs/testing-standard.md:97-110`), crate-local synthetic fixtures inside a
crate's `tests/fixtures/` directory may stay outside the
`fixtures/public/` manifest pipeline. Decision: **keep these fixtures
crate-local**, since they are KAIFUU-173-internal smoke artifacts and never
loaded by other crates.

Rationale: the KAIFUU-172 detector fixtures live under `fixtures/public/`
because they are loaded both by the `kaifuu-engine-fixture` tests **and** by
the `kaifuu-cli` integration tests. The parser-boundary smoke fixtures are
loaded only by the parser tests; the public-fixture manifest is not
expected.

If a future node (KAIFUU-174) re-uses these bytes as a corroborating bridge
fixture, that node promotes them to `fixtures/public/`.

### 9.3 Required test names (falsifiable, behavior-first)

```
// crates/kaifuu-reallive/tests/smoke.rs

#[test]
fn parses_smoke_scene_001_into_structured_ast_with_named_opcodes()

#[test]
fn extracts_stable_string_slot_ids_derived_from_byte_offset()

#[test]
fn rejects_truncated_scene_with_kaifuu_reallive_truncated_scene_diagnostic()

#[test]
fn emits_kaifuu_reallive_unrecognized_instruction_warning_without_dropping_byte_range()

#[test]
fn partitions_scene_bytes_completely_into_instructions_and_diagnostics()

#[test]
fn rejects_out_of_profile_input_with_kaifuu_reallive_out_of_profile_input()

#[test]
fn string_slot_id_format_matches_documented_bridge_contract()

#[test]
fn ast_serializes_named_opcode_strings_not_opaque_byte_values()

#[test]
fn parses_identical_bytes_to_identical_ast_across_runs()  // stability oracle
```

### 9.4 Acceptance assertions

| DAG criterion                                                                                                | Asserted by                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One fixture-safe RealLive scene parses end-to-end and emits a structured AST                                 | `parses_smoke_scene_001_into_structured_ast_with_named_opcodes`                                                                                                                                                                                                                                                       |
| RLDEV-style instructions are recognized with named opcodes (not opaque byte ranges)                          | `ast_serializes_named_opcode_strings_not_opaque_byte_values` (asserts e.g. `"text_display"` appears in the serialized AST and no `byteValue:` raw bytes)                                                                                                                                                                |
| String slots are extracted with stable identifiers usable by the bridge schema                               | `extracts_stable_string_slot_ids_derived_from_byte_offset` + `string_slot_id_format_matches_documented_bridge_contract`                                                                                                                                                                                                |
| Unrecognized instructions and out-of-profile inputs emit semantic diagnostics rather than silent skips       | `emits_kaifuu_reallive_unrecognized_instruction_warning_without_dropping_byte_range`, `rejects_out_of_profile_input_with_kaifuu_reallive_out_of_profile_input`, `partitions_scene_bytes_completely_into_instructions_and_diagnostics`                                                                                  |

### 9.5 Stability oracle

`parses_identical_bytes_to_identical_ast_across_runs` is a 3-iteration
loop that parses the smoke fixture, serializes the AST + slots +
diagnostics, and asserts byte-identical JSON across iterations. This is
the audit defense for "string-slot identifiers unstable across runs"
(auditFocus #2).

### 9.6 What is NOT tested at KAIFUU-173

- Real-game (Sweetie HD) parsing — ALPHA-006 territory.
- Bridge bundle production — KAIFUU-174.
- Patch-back round-trip — KAIFUU-174.
- VM execution semantics — UTSUSHI-146.
- Encrypted SEEN.TXT — future encrypted-RealLive node.
- Shift-JIS decoding — KAIFUU-174 codec stage.

---

## 10. Verification commands

DAG-declared commands plus the supplements required by the playbook:

```sh
cargo fmt --check
cargo test -p kaifuu-core
cargo test -p kaifuu-reallive
cargo clippy -p kaifuu-reallive -- -D warnings
just check
```

Notes:

- `cargo test -p kaifuu-reallive` is the load-bearing parser test command;
  it runs the smoke + the two negative fixtures plus the stability oracle.
- `cargo test -p kaifuu-core` is required by the DAG node and protects
  against any incidental impact from re-exporting `EncodedStringSlot` /
  `SemanticErrorCode` constants. KAIFUU-173 does NOT modify
  `kaifuu-core`'s public surface; the test invocation exists as a
  guardrail.
- `just check` is required because the workspace `Cargo.toml` `members` list
  changes when the new crate is added; the workspace-level check ensures
  no other crate regresses (and that `cargo fmt` / `cargo check` pass for
  the new crate).
- No `cargo run -p kaifuu-cli` invocation is required at KAIFUU-173 (the
  parser library is not wired into the CLI in this slice). KAIFUU-174 owns
  the CLI surface for inventory.

---

## 11. Clean-room provenance

### 11.1 Crate-level provenance comment

The implementation worker prepends this exact block to
`crates/kaifuu-reallive/src/lib.rs` (the wording mirrors the existing
`crates/kaifuu-engine-fixture/src/lib.rs:1-19` block so the audit posture
is identical):

```rust
//! Pure-Rust RealLive Scene/SEEN parser-boundary smoke (KAIFUU-173).
//!
//! Clean-room provenance:
//! - All RealLive format observations are derived from publicly archived
//!   format documentation (Haeleth's RLDEV site,
//!   `https://dev.haeleth.net/rldev.shtml`) plus the synthetic fixtures
//!   under `crates/kaifuu-reallive/tests/fixtures/`. No source expression
//!   is copied from RLDEV or rlvm.
//! - rlvm (`https://github.com/eglaysher/rlvm`) is a research anchor only.
//!   Its license is GPLv3+ and is incompatible with itotori's distribution
//!   posture if linked or derived. This crate does NOT depend on rlvm,
//!   does NOT include rlvm headers, does NOT copy rlvm's structure
//!   layouts, and does NOT mechanically translate rlvm code into Rust.
//!   If a hypothesis about RealLive's format was confirmed by reading
//!   rlvm, the hypothesis is re-derived and re-tested against the
//!   synthetic fixture bytes before being encoded here.
//! - The KAIFUU-173 parser is identify+decode only at the smoke scope.
//!   Patch-back, runtime execution, jump resolution, scene-graph linking,
//!   Shift-JIS codec, encrypted SEEN.TXT, and full opcode coverage are
//!   out of scope (see KAIFUU-174 and UTSUSHI-146).
//! - No `Command::new`, no Wine, no Windows helper, no remote helper.
//!   The parser is a pure function over `&[u8]`.
```

The same block is referenced (not duplicated) at the top of every other
module in the crate. The `Cargo.toml`'s `description` field also re-states
the clean-room posture so it appears in `cargo metadata`.

### 11.2 Readiness record update

`docs/kaifuu-adapters/reallive.md` is extended with a new top-level section
**below** the existing KAIFUU-172 record (the file's current sectioning is
flat; we add a new `## KAIFUU-173 parser-boundary smoke addendum` heading
without rewriting the KAIFUU-172 section).

The addendum covers:

- Roadmap node: KAIFUU-173.
- Crate or module: `kaifuu-reallive` (new).
- Initial support boundary (parser scope): smoke — single fixture-safe
  scene + bounded named-opcode catalogue.
- Unsupported or gated boundary: real-game variability beyond synthetic
  fixture, Shift-JIS decode, encrypted SEEN.TXT, patch-back, VM execution.
- Public fixture ids: `smoke-scene-001`, `truncated-scene-001`,
  `unknown-opcode-001` (crate-local, not promoted to
  `fixtures/public/manifest.schema.json`).
- Fixture license: synthetic, CC0-1.0.
- Reference implementations and docs:
  - Haeleth's RLDEV site → `behavior-only-clean-room`.
  - rlvm → `behavior-only-clean-room`; **not linked, not derived**.
- Parser spike status: completed under KAIFUU-173; spike outcome rolled
  directly into the smoke fixtures (no separate spike artifact).
- Local validation commands: §10 above.
- Known gaps: KAIFUU-174 (text inventory, Shift-JIS, patch-back),
  UTSUSHI-146 (VM execution), future encrypted-RealLive node.

The rlvm clean-room worker checklist at the end of
`docs/kaifuu-adapters/reallive.md` gains a second pass for KAIFUU-173:

- [ ] No `git submodule`, no Cargo dep, no vendored `rlvm` / RLDEV code in
      `crates/kaifuu-reallive`.
- [ ] No copied opcode tables, lookup constants, or struct layouts in
      `crates/kaifuu-reallive`. Catalogue derived from public docs +
      synthetic fixture.
- [ ] Crate-level provenance comment present at the top of
      `crates/kaifuu-reallive/src/lib.rs`.
- [ ] No `Command::new`, no foreign tool invocation, no helper boundary in
      this crate.
- [ ] Tests pass on a host with no rlvm installed.
- [ ] Synthetic fixtures under `crates/kaifuu-reallive/tests/fixtures/`
      contain no copyrighted RealLive bytes (every byte is authored from
      public docs).

The implementation worker leaves these checkboxes unchecked initially and
checks them off as the implementation lands.

---

## 12. Risks and unknowns

| Risk                                                                                                                                                                                                                                          | Mitigation / disposition                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Parser scope creep** — the worker is tempted to expand the named-opcode catalogue beyond §6 to "make tests easier".                                                                                                                          | Plan locks the catalogue to the §6 table. Any addition requires an inclusion-criteria justification (§6.1) and a matching synthetic-fixture test case. Auditor rejects PRs that expand the catalogue without that paired fixture.                                                                                              |
| **Opcode-coverage gaps surface on real-game inputs (ALPHA-006)** — Sweetie HD likely uses opcodes outside the §6 cushion.                                                                                                                      | This is **expected and not a regression**. Unrecognized opcodes emit `kaifuu.reallive.unrecognized_instruction` warnings; the AST still parses. ALPHA-006 vertical work expands the catalogue with a paired fixture per opcode (still per-game evidence-first). KAIFUU-173 ships a parser-boundary smoke, not a complete parser.   |
| **String-slot stability under future scene-edit operations** — once KAIFUU-174 introduces patch-back, byte-position-derived ids will shift when an earlier slot in the same scene resizes.                                                     | Disclosed risk. KAIFUU-173 deliberately uses byte-position ids; the offset-map / logical-id layer is KAIFUU-174's. The bridge contract enforces stale-hash detection (already in `kaifuu-core`); a patch attempt against a stale source hash fails before write. The risk is documented in §5.4 and surfaces as a follow-up node. |
| **Per-scene header variability** — real-game SEEN.TXT scene blobs may carry per-scene headers that the synthetic fixture omits.                                                                                                                | The smoke treats `entry.offset` as bytecode start (§3.1 row 4). Real-game discovery is ALPHA-006 territory. When evidence surfaces, a separate node adds per-scene header decoding; until then, unexpected headers emit `kaifuu.reallive.invalid_archive_envelope` Fatal.                                                       |
| **Operand-shape variability for named opcodes** — a real-game `TextDisplay` may carry an unexpected operand shape.                                                                                                                              | Covered by `kaifuu.reallive.unrecognized_operand_shape` (Warning). AST is still emitted with verbatim operand bytes; KAIFUU-174 deduces what to do with them.                                                                                                                                                                  |
| **Endianness assumption** — RealLive is little-endian (Windows-native). The parser assumes LE throughout.                                                                                                                                       | Documented assumption; the synthetic fixture is LE. No big-endian RealLive variants are documented.                                                                                                                                                                                                                                |
| **JSON golden brittleness** — semantic JSON goldens may need updates when field ordering or schema changes.                                                                                                                                     | Goldens are reviewed under the testing-standard golden policy (`docs/testing-standard.md:112-131`). Each update gets a justification in the PR body. Field-by-field assertions run **before** the JSON comparison so the failure mode is informative.                                                                              |
| **Worker accidentally consults rlvm during implementation and forgets to log it** — the rlvm clean-room checklist's "if a future worker reads rlvm" item is left unchecked in KAIFUU-172.                                                       | Plan requires the worker to either (a) not consult rlvm at all, or (b) check the box and log the file path + confirmed hypothesis in the readiness-record addendum. Auditor rejects if rlvm was consulted but the box stays unchecked.                                                                                            |

---

## 13. Out of scope

Explicitly excluded from KAIFUU-173 (each item maps to a downstream node):

- **KAIFUU-174 — text inventory adapter**: bridge bundle production,
  `EncodedStringSlot` emission as adapter output, `EngineAdapter` impl,
  asset-inventory surfaces, Shift-JIS decoding, protected-span detection,
  patch-back writer, CLI inventory subcommand.
- **UTSUSHI-146 — native RealLive runtime port**: opcode execution
  semantics, jump resolution, scene-graph linking, expression evaluation,
  Save/Load state, GAN animation playback.
- **Full opcode coverage**: extraction of all 200+ documented RealLive
  opcodes. KAIFUU-173 ships the §6 bounded cushion.
- **Encrypted SEEN.TXT**: future encrypted-RealLive variants are a separate
  node and require a key-profile boundary review under KAIFUU-014.
- **`.koe` / `.nwk` / `.ovk` voice archive parsing**: KAIFUU-174 / KAIFUU-064
  territory; not touched here.
- **`.g00` image format parsing or rebuild**: future node; not touched.
- **Gameexe.ini parsing**: identifier-level matches happen in the
  KAIFUU-172 detector; full Shift-JIS parsing belongs to KAIFUU-174.
- **CLI surface changes**: `cargo run -p kaifuu-cli` is not extended at
  KAIFUU-173.
- **Public-fixture-manifest promotion of the smoke fixtures**: crate-local
  for KAIFUU-173 (see §9.2).

---

## 14. Implementation worker scoping

**One worker.**

Rationale:

- The scope is internally cohesive: a parser library with a tight type set
  (AST, Operand, StringSlot), a small named-opcode catalogue, and a
  three-fixture test set. Splitting the work between two workers would
  introduce coordination overhead in the AST type design that exceeds the
  work itself.
- The clean-room provenance discipline (§11) is easier to enforce with a
  single owner — both the crate-level provenance comment and the
  readiness-record addendum need a single point of accountability.
- The bounded scope (§6 named-opcode catalogue, single fixture-safe scene
  + two negatives) is a one-PR slice; the playbook's per-game
  evidence-first rule explicitly discourages over-allocating workers.

If the worker discovers during implementation that the AST type design
genuinely needs two iterations (e.g. an `Operand` shape that does not fit
the `kaifuu_core::EncodedStringSlot` boundary cleanly), the worker should
**stop and escalate** rather than split. The escalation produces a new
plan addendum; it does not silently expand scope.

### 14.1 Suggested implementation order

1. Add `crates/kaifuu-reallive` to the workspace; land the crate-level
   provenance comment as the first commit; verify `cargo check -p
   kaifuu-reallive` succeeds.
2. Author the synthetic `smoke-scene-001` SEEN.TXT bytes; commit the
   fixture with `expected/ast.json` (initially empty placeholder) and
   `expected/string-slots.json` (initially empty placeholder).
3. Implement `archive.rs` (SEEN.TXT envelope decoder); land
   `parse_archive` + golden `SceneIndex` test.
4. Implement `ast.rs` + `opcodes.rs` + `strings.rs` types.
5. Implement `parser.rs` for the §6 catalogue; land the
   `parses_smoke_scene_001_into_structured_ast_with_named_opcodes` test.
6. Implement `diagnostics.rs` + the negative fixtures
   (`truncated-scene-001`, `unknown-opcode-001`).
7. Land the stability oracle test
   (`parses_identical_bytes_to_identical_ast_across_runs`).
8. Update `docs/kaifuu-adapters/reallive.md` with the KAIFUU-173 addendum
   and tick the rlvm clean-room checklist boxes.
9. Run the §10 verification commands; record outputs in the PR body.

---

## 15. Cross-references

- `docs/subprojects-kaifuu.md` — adapter trait, no-shell-out rule.
- `docs/kaifuu-engine-playbook.md` — readiness record template, fixture
  rules.
- `docs/kaifuu-fixture-policy.md` — public-fixture layering, license
  review, semantic capability errors.
- `docs/testing-standard.md` — falsifiable test names, fixture layering,
  golden-fixture policy.
- `docs/kaifuu-adapters/reallive.md` — KAIFUU-172 readiness record;
  KAIFUU-173 addendum is appended.
- `crates/kaifuu-core/src/lib.rs` — `BridgeUnit`, `SemanticErrorCode`,
  `EngineAdapter` trait.
- `crates/kaifuu-core/src/offset_map.rs` — `EncodedStringSlot`,
  `EncodedStringSlotLayout`, `EncodedStringSlotProtectedSpan`,
  `ByteSpan`.
- `crates/kaifuu-engine-fixture/src/lib.rs:3286-4338` — KAIFUU-172
  RealLive detector; reference for clean-room comment shape and
  fixture-helper pattern. KAIFUU-173 does NOT modify this code.
- `.plan/KAIFUU-172.md` — prior plan; this plan mirrors its sectioning and
  cross-checks the inherited boundary.
- Roadmap DAG nodes: KAIFUU-014, KAIFUU-052, KAIFUU-172, KAIFUU-174,
  UTSUSHI-146.
