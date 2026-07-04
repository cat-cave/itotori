# KiriKiri KAG `.ks` Plaintext Adapter — Readiness Record

- Adapter id: `kaifuu.kirikiri-kag`
- Crate: `kaifuu-kirikiri`
- Roadmap node: KAIFUU-009 (KiriKiri KAG plaintext reference adapter — the
  null-container special case).
- Engine family: KiriKiri / KAG (KiriKiri Adventure Game system).

## Honest scope: plaintext KAG `.ks` ≠ commercial KiriKiri (encrypted XP3)

**This adapter is the KiriKiri _null-container_ special case and MUST NOT be
presented as commercial-KiriKiri coverage.**

KiriKiri ships its assets — including the KAG scenario scripts — inside `.xp3`
archives. **Commercial** KiriKiri titles almost always ship those archives
_encrypted_ (a per-title cipher / `.tpm`-style filter). Reading a commercial
title's scripts therefore requires:

1. the **XP3 container layer** (index parse, segment/compression handling), and
2. **per-title key material** to decrypt the archive.

Both of those are a **separate** capability, tracked by the KiriKiri/XP3
packed-engine readiness profile
(`kaifuu_core::packed_engine_readiness::EngineFamily::KirikiriXp3`,
`kaifuu_core::xp3_capability_profile`), whose synthetic marks already model
`encrypted` / `missing_key` / `helper_required`. Nothing in this crate reads,
decrypts, or unpacks an XP3 archive.

`kaifuu-kirikiri` handles the opposite, **null-container** end of the spectrum:
a `.ks` file that is _already plaintext on disk_ — an unencrypted / `plain` XP3
whose members were already extracted, an author's development tree, or a
fan-distributed plaintext script. Supporting it proves the KAG _dialect_
(tags, commands, speaker convention) and byte-preserving patchback — it does
**not** prove any commercial title is readable end-to-end. That claim is gated
on the encrypted-XP3 work.

## What the adapter does (real, this node)

- **KAG `.ks` parser** (`parse::parse_ks` / `parse_ks_with_encoding`). Line
  dialect handled by column-0 classification:
  - `;` comment line → structure (no text).
  - `*name|caption` label line → structure.
  - `@wait time=1000` / `@ch storage="…"` line command → structure; the command
    name is recorded as a `LineCommand` finding (no-silent-skip visibility).
  - `#name` speaker line → speaker; `#voice/display` splits a voice-file id
    (structure) from the translatable display name; bare `#` resets the speaker.
  - message/text line → maximal runs of dialogue text between inline `[tag …]`
    tags; `[[` is the KAG literal-`[` escape and stays inside the run;
    whitespace-only runs are treated as structure.
- **Encoding-aware byte scanning** (UTF-8 + Shift-JIS). A Shift-JIS trailing
  byte equal to an ASCII delimiter (`[`=0x5B, `]`=0x5D, `@`=0x40, all inside the
  Shift-JIS trailing-byte range) is skipped as part of its multibyte character
  and never mistaken for a tag/command marker.
- **Speaker extraction** — each `dialogue` unit records the active speaker
  display name from the most recent `#name` line.
- **Stable extraction units** — each `KsUnit` keys on
  `kirikiri-kag:<file>#L<line>#seg<segment>#<role>`, carries an exact
  `[start_byte, end_byte)` span, decoded `source_text`, and a deterministic
  `bridge_unit_id` (shared SHA-256 → UUID7-shaped scheme).
- **Byte-preserving patch writer** (`patch::apply_patch`) — replaces only the
  translatable spans (re-encoding the translation into the source encoding),
  splicing all other bytes verbatim. Guards: unknown-unit, newline-in-run,
  stale-source (span no longer matches recorded text), overlapping spans,
  unrepresentable-in-encoding — all hard errors.
- **Verification** (`patch::verify_byte_preserving`) — re-parses source and
  patched output and proves (a) the ordered unit-key set is unchanged (no
  dropped/added unit) and (b) the non-text structural byte stream is
  byte-identical (no tag/command/comment/label touched).

## Fixtures

Synthetic, authored, CC0 — `crates/kaifuu-kirikiri/fixtures/dialogue_basic.ks`
(UTF-8) plus an in-test Shift-JIS trailing-byte-hazard corpus built in-process.
No retail KiriKiri bytes. Tests in `crates/kaifuu-kirikiri/tests/kag_roundtrip.rs`.

## Explicitly out of scope (separate nodes)

- XP3 container parse / decompression.
- Encrypted-XP3 key material and per-title ciphers.
- KAG macro (`[macro]`/`[endmacro]`) expansion, `[iscript]`…`[endscript]`
  TJS blocks, and translating `@`-command / inline-tag attribute values — all
  preserved as structure here.
