# KAIFUU-173 / KAIFUU-188 parser-boundary smoke fixtures

Synthetic-only. Every byte is authored from public RealLive format
archaeology (Haeleth's RLDEV documentation) and the documented in-crate
bytecode shape (see `crates/kaifuu-reallive/src/lib.rs`). No retail bytes,
no opcode tables copied from rlvm or RLDEV.

All envelopes use the real 10,000-slot fixed-offset-table shape
(KAIFUU-188): 80,000 bytes of `(u32_le offset, u32_le length)` pairs at
file offset 0, with the single scene populated at slot 1
(`reallive:scene-0001`). The scene payload sits at file offset
`0x0001_3880`, mirroring Sweetie HD's first-scene layout. These are
**synthetic envelope-shape smokes** that exercise the parser's behavior on
authored bytes — the real-bytes anchor lives in
`tests/parse_archive_real_bytes.rs`.

License: CC0-1.0.

Fixture set:

KAIFUU-173 parser fixtures:

- `smoke-scene-001/SEEN.TXT` — single-scene archive exercising
  `TextDisplay`, `SetSpeaker`, `Choice`, `Pause`.
- `truncated-scene-001/SEEN.TXT` — envelope claims one scene whose payload
  runs past the archive.
- `unknown-opcode-001/SEEN.TXT` — one scene whose bytecode contains a
  recognized instruction, then an unrecognized opener byte, then another
  recognized instruction. Asserts the warning + Unrecognized AST node
  pairing and the partition invariant.

KAIFUU-174 inventory + patchback fixtures:

- `bridge-inventory-001/SEEN.TXT` + `Gameexe.ini` — single-scene archive
  with SetSpeaker / TextDisplay / Choice plus an asset-reference dialogue
  slot pointing at `bg/sample.g00`. Asserts bridge-unit projection,
  asset-reference capture, speaker attribution, and Gameexe.ini key
  classification.
- `protected-spans-001/SEEN.TXT` — single-scene archive with one
  dialogue slot exercising every nine catalogued control-code shapes
  plus an unknown-control byte. Asserts the catalogue coverage and the
  `protected_span.unknown_control` warning.
- `patchback-identity-001/SEEN.TXT` — same bytes as
  `bridge-inventory-001`. Identity round-trip with empty edit list.
- `patchback-length-preserving-001/SEEN.TXT` — same bytes; exercised
  with a length-preserving slot translation that must leave the scene
  table byte-identical.
- `patchback-overflow-001/SEEN.TXT` — same bytes; exercised with a
  length-changing edit that must be rejected with
  `kaifuu.reallive.patchback_offset_overflow` Fatal.
  The same byte runs are produced by builder helpers in
  `tests/smoke.rs` (see the `synthetic` module) so the fixtures can be
  regenerated. The on-disk bytes are committed for hermetic CI; the tests
  assert builder output matches the on-disk bytes. Run
  `cargo run -p kaifuu-reallive --example regenerate_fixtures` after
  changing a builder.

KAIFUU FIX-1 binary-patch-smoke fixture (kaifuu-cli):

- `crates/kaifuu-cli/src/binary_patch_smoke.rs::build_synthetic_seen_txt`
  — a **regenerable, in-code** synthetic Seen.txt (no on-disk bytes). It
  replaces the deleted pre-KAIFUU-191 `0x23 ('#') opener + named opcode
  byte + operand-count` shape with the real post-KAIFUU-191 byte shape:
  the 80,000-byte 10,000-slot fixed-offset directory (slot 1 populated,
  payload at `0x0001_3880`), a documented Meta prologue (MetaLine /
  MetaEntrypoint / MetaKidoku), and real 8-byte `CommandElement` headers
  (`0x23`, module_type, module_id, opcode_u16_le, argc, overload,
  reserved) plus a bracketed `( arg , arg )` `select` argument list. The
  scene exercises four string roles — Textout (inline Shift-JIS dialogue
  `"あい"`), TextDisplay (module_msg), SetSpeaker (module_msg opcode 3 →
  CharacterTextDisplay), and Choice (module_sel) — and decodes through the
  current parser with **0 unknown opcodes**
  (`synthetic_seen_txt_decodes_four_roles_with_zero_unknown_opcodes`).
  The body is the *decompressed* scene bytecode the parser consumes; the
  unit tests prove it round-trips byte-identically through the real AVG32
  LZSS + XOR framing (`compress_avg32_literal` / `decompress_avg32`), the
  layer a real Seen.txt adds on top.

Provenance / non-copyright: **synthetic, authored from scratch** from
public RealLive format archaeology (Haeleth's RLDEV documentation;
rlvm `bytecode.{h,cc}` / `module_*.cc` names as research anchors only —
not linked or vendored). No verbatim retail bytecode or text is copied;
only numeric offsets / counts (10,000 slots, 80,000-byte directory,
`0x0001_3880` first-scene offset, 8-byte AVG32 preamble, `0x1d0` scene
header) reference real Sweetie HD anchors. License: CC0-1.0.
