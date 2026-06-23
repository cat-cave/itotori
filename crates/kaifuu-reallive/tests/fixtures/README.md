# KAIFUU-173 parser-boundary smoke fixtures

Synthetic-only. Every byte is authored from public RealLive format
archaeology (Haeleth's RLDEV documentation) and the documented in-crate
bytecode shape (see `crates/kaifuu-reallive/src/lib.rs`). No retail bytes,
no opcode tables copied from rlvm or RLDEV.

License: CC0-1.0.

Fixture set:

- `smoke-scene-001/SEEN.TXT` — single-scene archive exercising
  `TextDisplay`, `SetSpeaker`, `Choice`, `Pause`.
- `truncated-scene-001/SEEN.TXT` — envelope claims one scene whose payload
  runs past the archive.
- `unknown-opcode-001/SEEN.TXT` — one scene whose bytecode contains a
  recognized instruction, then an unrecognized opener byte, then another
  recognized instruction. Asserts the warning + Unrecognized AST node
  pairing and the partition invariant.

The same byte runs are produced by builder helpers in
`tests/smoke.rs` (see the `synthetic` module) so the fixtures can be
regenerated. The on-disk bytes are committed for hermetic CI; the tests
assert builder output matches the on-disk bytes.
