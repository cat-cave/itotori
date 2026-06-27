# RealLive Sweetie HD — Scene Bytecode Encryption Mechanism (Identified)

> Companion to `docs/research/reallive-engine.md` §D. Resolves the top open
> question listed there ("Sukara title XOR-2 key" — open question #1 in
> §K.Top open questions). Read-only investigation against the real bytes at
> `/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/Seen.txt`.
>
> Provenance discipline (same as the parent doc): every claim is **[V]**
> verified against Sweetie HD bytes, **[P]** taken from a public source (rlvm
> GitHub), or **[U]** unknown. The probe binary and embedded constant table
> are restated in our own words from rlvm's BSD-licensed
> `src/libreallive/compression.cc` (Peter Jolly, 2006). No rlvm source is
> vendored.

## 1. Bottom line

**Outcome A.** Sweetie HD's RealLive scene bytecode for compiler version
`110002` uses **only the first-level AVG32 LZSS + 256-byte XOR transform**
documented in rlvm `compression.cc::Decompress`. **No second-level (per-game)
XOR is applied.** Despite rlvm's `scenario.cc::Header` constructor setting
`use_xor_2_ = true` whenever `compiler_version == 110002` and then refusing
to read the script without a published 16-byte Sukara key, the actual
Sweetie HD scene-1 bytes decompress cleanly with `Decompress(..., key=NULL)`:
the resulting 1660-byte stream begins `0a 02 00 0a 03 00 21 00 00 …`, which
parses as a clean BytecodeElement sequence
(`MetaLine(2), MetaLine(3), MetaEntrypoint(0), MetaLine(4..10),
Command(type=1, id=5, opcode=120, argc=0), …`), and 51.3 % of the bytes in
the decompressed stream are valid BytecodeElement opener bytes. Two
independent self-consistency checks land cleanly: the compressed-stream
8-byte preamble XOR'd with `mask[0..8]` produces the LE u32 pair
`(0x426=1062, 0x67c=1660)`, which exactly matches the
`bytecode_compressed_size` / `bytecode_uncompressed_size` fields from the
plaintext scene header.

Put differently: **the rlvm "use_xor_2 for 110002" branch is overly
pessimistic for the Sukara-branch HD remasters**. The Sukara-branch use of
compiler 110002 in Sweetie HD does the LZSS+AVG32-XOR pass and then stops.
The decompressor in our Pure-Rust port should treat the second-level XOR as
optional (i.e. `xor_2_pass: Option<...>`), default `None` for Sukara-branch
titles, and rely on the documented Key/VisualArts 16-byte tables only for
those publishers.

## 2. Inputs probed

| Field                     | Value                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Seen.txt path             | `/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/Seen.txt`                       |
| Seen.txt size             | 3,876,496 bytes                                                                                                                |
| Probe harness             | `crates/kaifuu-reallive/examples/probe_scene_1_encryption.rs` (release build, run under `direnv exec . cargo run --release …`) |
| Scene-1 directory entry   | `slot[1]` at file offset 8: `(offset=0x13880, size=0x5fa)`                                                                     |
| Scene-1 blob              | file offsets `0x13880..0x13e7a`, 1530 bytes total                                                                              |
| Plaintext scene header    | blob offsets `0..0x1d0` (464 bytes), `header_size=0x1d0`, `compiler_version=110002`                                            |
| Compressed bytecode start | blob offset `0x1d4` (= header field `bytecode_offset`)                                                                         |
| Compressed bytecode size  | 1062 bytes (= header field `bytecode_compressed_size`)                                                                         |
| Uncompressed size         | 1660 bytes (= header field `bytecode_uncompressed_size`)                                                                       |
| Compressed payload file   | offsets `0x13a54..0x13e7a`                                                                                                     |

**Raw bytes used as evidence (verbatim from the read-only mount):**

```
compressed[0..32] (raw, blob offsets 0x1d4..0x1f4):
  ad e1 5d c3 dd e6 30 44 ff 8f c2 74 03 5c 5e 12
  c0 f1 eb e5 59 53 8b 40 cc 85 c6 85 14 8c bf cc

compressed[0..8] preamble ^ AVG32_XOR_MASK[0..8]:
  26 04 00 00 7c 06 00 00
  -> u32 LE pair: (0x426 = 1062, 0x67c = 1660)
  -> exactly matches bytecode_compressed_size and
     bytecode_uncompressed_size from the plaintext scene header.
     This is a deterministic round-trip — the preamble carries
     the size pair, XOR'd against the same fixed mask.

decompressed[0..64] (after LZSS + AVG32 mask, NO second-level XOR):
  0a 02 00 0a 03 00 21 00 00 0a 04 00 0a 05 00 0a
  06 00 0a 07 00 0a 08 00 0a 09 00 0a 0a 00 23 01
  05 78 00 00 00 00 24 06 5b 24 ff fb 01 00 00 5d
  5c 1e 24 c8 0a 0b 00 0a 0c 00 0a 0d 00 0a 0e 00
```

## 3. Method

1. **Read Seen.txt bytes** and derive the scene-1 blob via the 10,000-slot
   directory at file offset 0. Slot 1 → `(offset=0x13880, size=0x5fa)`. [V —
   matches `reallive-engine.md` §C.]
2. **Parse the plaintext scene header** at blob offsets `0..0x1d0` per rlvm
   `scenario.cc::Header`. Confirmed `compiler_version=110002`,
   `bytecode_offset=0x1d4`, `bytecode_compressed_size=1062`,
   `bytecode_uncompressed_size=1660`. [V]
3. **Embed the AVG32 256-byte XOR mask** as a Rust constant `AVG32_XOR_MASK`,
   restated in our own words from rlvm `compression.cc::xor_mask[256]` (BSD
   2006, Peter Jolly). [P, no source vendored — the array is the same fixed
   constant used by every RealLive title.]
4. **Run rlvm-shape LZSS+XOR decompression** restated in our own words from
   `compression.cc::Decompress`:
   - Skip 8-byte preamble in input (`src += 8`).
   - 9-bit flag-byte cycle (`bit = 1; bit <<= 1; if (bit == 256) reload`).
   - Flag bit `1` → literal byte XOR'd with `mask[mask_idx++ & 0xff]`.
   - Flag bit `0` → two bytes (each XOR'd) → u16 LE `count`, back-distance
     = `count >> 4`, run-length = `(count & 0x0f) + 2`.
   - No second-level XOR pass. [P, restated.]
5. **Produced 1660 bytes of output** with no decompression error.
6. **Checked dst[0] against the BytecodeElement opener set** from
   `bytecode.cc::BytecodeElement::Read`: `{0x00, 0x0A, 0x21, 0x23, 0x24,
0x2C, 0x40}` plus Shift-JIS lead bytes `0x81..=0x9F` / `0xE0..=0xFC`.
   `dst[0] = 0x0A` (MetaLine opener) → **match**. [V]
7. **Computed Shannon entropy and byte histogram** as a corroboration: the
   stream's bytes are dominated by structural markers (`0x00`, `0x0A`,
   `0xFF`, `0x24`, `0x23`), entropy 5.30 bits/byte — well below 8.0
   (encrypted) and consistent with a structured bytecode stream. [V]
8. **Walked the first 16 elements naively** to verify the stream parses as
   real BytecodeElements: see §4.2.

The probe source is `crates/kaifuu-reallive/examples/probe_scene_1_encryption.rs`.
Run with `direnv exec . cargo run --release --example probe_scene_1_encryption`.
Optional `ITOTORI_REAL_GAME_ROOT` env var overrides the input path.

## 4. Evidence

### 4.1 Two-step self-consistency check on the preamble

The 8-byte preamble at the start of the compressed stream is _not_ skipped
randomly. rlvm's `Decompress` skips it (`src += 8`), but inspection of those
8 bytes XOR'd against `AVG32_XOR_MASK[0..8]` yields:

```
raw   : ad e1 5d c3 dd e6 30 44
mask  : 8b e5 5d c3 a1 e0 30 44
XOR'd : 26 04 00 00 7c 06 00 00
        = u32 LE (0x426, 0x67c)
        = (1062, 1660)
        = (bytecode_compressed_size, bytecode_uncompressed_size)
```

These are exactly the two sizes also stored in plaintext at scene header
offsets `0x28` (compressed) and `0x24` (uncompressed). This is a redundant
encoding — the size pair is present both inside the encrypted stream (as
the preamble XOR'd against the fixed mask) and outside it (as plaintext
header fields). The match confirms the first-level XOR mask, mask-index
cycle, and 8-byte preamble shape are correctly modelled. [V]

### 4.2 First 16 elements of the decompressed stream

Walking the 1660-byte decompressed output naively as a BytecodeElement
sequence yields (the walk only models structural elements, not full
argument lists):

```
[ 0] @0x0000 MetaLine line=2
[ 1] @0x0003 MetaLine line=3
[ 2] @0x0006 MetaEntrypoint idx=0
[ 3] @0x0009 MetaLine line=4
[ 4] @0x000c MetaLine line=5
[ 5] @0x000f MetaLine line=6
[ 6] @0x0012 MetaLine line=7
[ 7] @0x0015 MetaLine line=8
[ 8] @0x0018 MetaLine line=9
[ 9] @0x001b MetaLine line=10
[10] @0x001e Command type=1 id=5 opcode=120 argc=0 overload=0
[11] @0x0026 byte=0x24 (textout / expression — naive walk stops here)
…
```

- Sequential `MetaLine` markers with monotonically increasing line numbers
  (2..10) — consistent with a script preamble in source line order. [V]
- A `MetaEntrypoint(idx=0)` between line 3 and line 4 — consistent with the
  `Z` debug entrypoint of `0x00000003` we already read out of the scene
  header at offset `0x30` (which RLDEV calls `z_minus_two`).
- A `Command` with `module_type=1`, `module_id=5`, `opcode=120`. Module
  `1.005` is `module_msg`'s message-control submodule in rlvm. Opcode 120 in
  that module is consistent with an early-scene message-setup call.
- Followed by an expression-element (`$ = 0x24`) introducing the first
  argument list — also consistent with the documented expression encoding
  at the start of an opcode operand block.

These are real, parseable elements, not random bytes. [V]

### 4.3 Statistical corroboration

| Metric                                 | Value           | Interpretation                                                                                                              |
| -------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `decompress` outcome                   | OK, 1660 bytes  | Matches `bytecode_uncompressed_size`.                                                                                       |
| Shannon entropy over all 1660 bytes    | 5.296 bits/byte | Structured, well below 8.0; random-data baseline ≈ 7.9–8.0.                                                                 |
| Shannon entropy over first 256 bytes   | 3.947 bits/byte | First quarter is even more structured (MetaLine run).                                                                       |
| `0x00` frequency                       | 26.87 % (446)   | NUL byte is both the high-byte of `MetaLine` markers and trailing-argument padding.                                         |
| `0x0a` frequency                       | 8.80 % (146)    | `MetaLine` opener — consistent with ≥146 source-line markers.                                                               |
| `0xff` frequency                       | 5.84 % (97)     | `\xFF` introduces 32-bit signed integer literals in the expression encoding (rlvm `expression.cc`); appears 97 times.       |
| `0x24` frequency                       | 5.42 % (90)     | `$` = ExpressionElement opener.                                                                                             |
| `0x23` frequency                       | 2.17 % (36)     | `#` = CommandElement opener.                                                                                                |
| Opener-byte appearances (whole stream) | 51.3 % (852)    | More than half of all bytes are valid BytecodeElement openers — overwhelming evidence the stream is plaintext bytecode. [V] |
| dst[0] vs documented opener set        | 0x0A (MetaLine) | **Direct match.** Outcome A confirmed without needing any second-level XOR.                                                 |

If the second-level XOR were on, the stream would either fail to
decompress, would have ~uniform byte frequency (entropy ≈ 8.0), or would
have dst[0] outside the opener set — all three checks reject the
"second-level XOR is needed" hypothesis. [V]

### 4.4 Recovered second-level XOR mask (for the record)

Outcome A means there is no recovered second-level mask. We explicitly
note: a constant-byte XOR over the full 1660 bytes was not searched for,
because the **structural evidence** above (matching size pair in preamble,
opener-byte dst[0], 51.3 % opener-byte share, MetaLine sequence parses
cleanly) already pins down outcome A. If a constant-byte XOR were applied
later, the byte histogram would be a shifted version of the same shape —
but dst[0]=0x0A is itself an opener, so the shift would have to be 0
(identity), which is outcome A.

## 5. Concrete DAG nodes to create from this finding

The orchestrator should mint these as fresh nodes. Numerics (`-N`) are
placeholders.

### 5.1 `KAIFUU-NEW-N1` — RealLive AVG32 LZSS+XOR decompressor, real-bytes round-trip

- **Title:** "kaifuu-reallive: AVG32 LZSS + 256-byte XOR decompressor (Sukara
  branch, second-level XOR disabled)"
- **Summary:** Land `crates/kaifuu-reallive/src/compression.rs` (or
  equivalent name) with a `decompress_scene` function restated in our own
  words from rlvm `compression.cc::Decompress`. The function accepts
  `(compressed: &[u8], dst_len: usize, xor_2_pass: Option<&Xor2Pass>)`
  where `Xor2Pass` carries `(offset, length, key: [u8; 16])` slices. Default
  `xor_2_pass = None` for Sukara-branch titles. Embed the documented 256-byte
  AVG32 mask as a `const`.
- **Acceptance criteria (real-bytes assertions):**
  1. Given Sweetie HD's `Seen.txt` at `$ITOTORI_REAL_GAME_ROOT`, the
     decompressor invoked on scene 1's compressed payload
     (file offsets `0x13a54..0x13e7a`, 1062 bytes) with `xor_2_pass = None`
     produces exactly 1660 bytes. [Sweetie HD ground truth: matches
     `bytecode_uncompressed_size` field.]
  2. The first 16 bytes of that output are
     `0a 02 00 0a 03 00 21 00 00 0a 04 00 0a 05 00 0a` — exact byte equality.
  3. The first byte (`0x0A`) matches a documented BytecodeElement opener.
  4. Over the full 1660-byte output, at least 50 % of bytes are valid
     BytecodeElement openers (`{0x00, 0x0A, 0x21, 0x23, 0x24, 0x2C, 0x40}`
     plus Shift-JIS lead bytes `0x81..=0x9F` / `0xE0..=0xFC`). Real-bytes
     measured value is 51.3 %.
  5. The 8-byte preamble at the start of the compressed input, XOR'd against
     `AVG32_XOR_MASK[0..8]`, yields `(0x426, 0x67c)` as a `u32 LE` pair —
     proving the mask and preamble shape are correctly modelled.
- **Test gating:** `ITOTORI_REAL_GAME_ROOT` env var; if unset, the
  test is skipped (matching the gating pattern in
  `crates/kaifuu-reallive/tests/`).
- **Rationale:** cited from this doc (§4) and rlvm
  `compression.cc::Decompress` shape (P).

### 5.2 `KAIFUU-NEW-N2` — Scene header parser, real-bytes assertion

- **Title:** "kaifuu-reallive: scene header parser (10,000-slot directory +
  `0x1d0` header struct), real-bytes round-trip"
- **Summary:** Replace the existing `parse_archive`'s count-plus-table
  envelope with the 10,000-slot directory + `0x1d0` header layout
  documented in `reallive-engine.md` §C–§D. Materialise the typed `Header`
  struct (compiler*version, kidoku_offset/count, bytecode_offset/size pair,
  z_minus_one/two debug entrypoints, savepoint*\* settings).
- **Acceptance criteria (real-bytes assertions):**
  1. Given Sweetie HD's `Seen.txt`, the parsed directory contains exactly
     198 used slots out of 10,000.
  2. Slot 1 → `(offset=0x13880, size=0x5fa)` exact byte equality.
  3. Slot 1's parsed `Header` reports `compiler_version=110002`,
     `header_size=0x1d0`, `kidoku_offset=0x1d0`, `kidoku_count=1`,
     `bytecode_offset=0x1d4`, `bytecode_uncompressed_size=1660`,
     `bytecode_compressed_size=1062`, `dramatis_personae_count=0`,
     `z_minus_one=0`, `z_minus_two=3`.
  4. Header carries `use_xor_2 = false` for Sukara-branch
     `compiler_version=110002` (defaulting against rlvm's pessimistic
     `use_xor_2 = true` choice; see §1 of this doc).
- **Test gating:** `ITOTORI_REAL_GAME_ROOT` env var.

### 5.3 `KAIFUU-NEW-N3` — BytecodeElement decoder, real-bytes structural walk

- **Title:** "kaifuu-reallive: BytecodeElement decoder, opener-byte switch +
  8-byte command header, real-bytes structural walk over scene 1"
- **Summary:** Land the `BytecodeElement::Read`-equivalent decoder that
  cases on `{0x00, 0x0A, 0x21, 0x23, 0x24, 0x2C, 0x40}` plus Shift-JIS lead
  bytes, with a `CommandElement` 8-byte header walker
  (`module_type, module_id, opcode_u16le, argc, overload, reserved`). Does
  NOT yet implement expression-piece evaluation — that's a follow-up.
- **Acceptance criteria (real-bytes assertions):**
  1. Decoding the first 16 elements of decompressed Sweetie HD scene 1
     yields exactly the sequence in §4.2 of this doc:
     `MetaLine(2), MetaLine(3), MetaEntrypoint(0), MetaLine(4..10),
Command(type=1, id=5, opcode=120, argc=0, overload=0), $`.
  2. Element 10 (the Command at byte offset `0x001e`) is decoded as a
     `CommandElement` with the exact field tuple above.
  3. Walking the entire 1660-byte stream produces no
     `unrecognised-opener-byte` errors.
- **Test gating:** `ITOTORI_REAL_GAME_ROOT` env var.

### 5.4 `KAIFUU-NEW-N4` — Drop overly-pessimistic `use_xor_2` branch for Sukara

- **Title:** "kaifuu-reallive::header: treat `compiler_version=110002` as
  `use_xor_2=false` by default; rlvm-style `use_xor_2=true` is opt-in via
  publisher table"
- **Summary:** Document the Sukara vs Key/Visual Arts publisher distinction
  in `kaifuu-reallive::header`. Cite this doc as the source. Add a small
  publisher-table that maps `(regname_prefix, compiler_version) →
Option<XorKeySchedule>`. Sukara branch (`regname` containing
  `KEY\Sweetie\HD Edition` or similar — TBD from `Gameexe.ini`
  `#REGNAME`) defaults to `None`.
- **Acceptance criterion:**
  1. The default schedule for Sweetie HD's regname returns `None`; the
     decompressor invoked with that schedule produces a valid bytecode
     stream as in §5.1.
- **Test gating:** unit test that does not require the real bytes, plus
  an integration test that does (`ITOTORI_REAL_GAME_ROOT`).

### 5.5 (Out-of-scope; do not mint as a research node)

Outcome A means we explicitly do **not** propose:

- A "source a second Sukara-branch title to compare entropy" sourcing
  request — outcome A is decisive on this title's bytes alone. Sourcing a
  second Sukara-branch title is independently useful for opcode-coverage
  histograms (already noted in `reallive-engine.md` §K open question #3),
  but it is not a prerequisite for landing the four nodes above.
- A "study which Sukara titles use which compiler version" research node —
  this doc has identified the mechanism for the title we own bytes for; if
  a future title fails the §5.1 round-trip, that's a fresh investigation
  triggered by that title's bytes, not a deferred research item.

## 6. Cross-reference index

Sweetie HD evidence (V):

- `$GAME/REALLIVEDATA/Seen.txt` byte ranges `0..16`, `0x13880..0x13a54`
  (scene-1 plaintext header), `0x13a54..0x13e7a` (scene-1 compressed
  bytecode payload), as listed in §2 above.

Public sources (P) — fetched from rlvm GitHub via `gh api` during this
investigation, structure restated in our own words, no source vendored:

- `eglaysher/rlvm` `src/libreallive/compression.cc` — `xor_mask[256]`
  constant table; `Decompress` LZSS+XOR algorithm; published per-game
  `XorKey` tables for Key/Visual Arts titles (Little Busters, Clannad,
  Snow, Kud Wafter). Sukara is **not** in the published table — confirmed
  by reading the full file.
- `eglaysher/rlvm` `src/libreallive/scenario.cc` — `Header` constructor's
  `use_xor_2_` decision tree based on `compiler_version`; `Script`
  constructor's call into `Decompress`.
- `eglaysher/rlvm` `src/libreallive/bytecode.cc` — `BytecodeElement::Read`
  opener-byte switch on `{0, ',', '\n', '@', '!', '$', '#', default}`.

Existing itotori code (current-tree references; this finding does not
modify any of them, just informs the next set of DAG nodes):

- `crates/kaifuu-reallive/src/lib.rs:38-99` — synthetic-fixture parser
  surface; explicitly narrower than real RealLive bytecode (label retained).
- `crates/kaifuu-reallive/src/archive.rs:66-104` — count-plus-table envelope
  parser; will be replaced by §5.2's 10,000-slot directory parser.
- `crates/kaifuu-reallive/examples/probe_scene_1_encryption.rs` (new) —
  this investigation's harness; left in the tree for later regressions
  against fresh Sukara-branch titles.
- `docs/research/reallive-engine.md` §D, §K open question #1 — resolved
  here.
