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
