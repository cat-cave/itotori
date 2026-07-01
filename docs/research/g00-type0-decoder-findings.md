# g00 type-0 HD background decoder — reverse-engineering findings

READ-ONLY investigation for `reallive-g00-type0-hd-background-decoder-fix`.
Structural facts only (header field values, offsets, lengths, byte-category
counts, coherence metrics). No decoded pixel/art bytes are reproduced.

Target file:
`/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/g00/BACK.g00`
(the task's stated path `.../sweetie-hd/REALLIVEDATA/g00/BACK.g00` does not
exist; the real corpus is under `.../sweetie-hd/extracted/<title>/REALLIVEDATA/g00/`).
Decoder under test: `crates/utsushi-reallive/src/g00.rs` (UTSUSHI-216).

---

## 1. The current decoder's assumption + exact underrun mechanism

`decode_type0` (`g00.rs:649`) → `parse_lzss_section` (`g00.rs:861`) →
`lzss_decode_classic` (`g00.rs:960`).

The decoder assumes a **single** classic Okumura-style LZSS stream with:
- 8-bit flag byte, **LSB-first**;
- `bit == 0` ⇒ literal, `bit == 1` ⇒ back-reference (`g00.rs:995`,
  `let is_literal = (flag & 1) == 0;`) — note this is the **inverse** of the
  usual RealLive/AVG32 convention (literal-when-bit-set);
- back-reference token = **absolute** 12-bit ring position
  `pos = b1 | ((b2 & 0xf0) << 4)` and length `(b2 & 0x0f) + 3` (range 3..=18)
  (`g00.rs:1026-1027`);
- 4096-byte ring, cursor initialised to 4078 (`g00.rs:978`).

**Underrun mechanism (exact):** the input is NOT truncated and the header is
NOT mis-sized. The decoder receives the full 689 930-byte payload but
**misparses the bitstream** with the wrong LZSS variant. Under the wrong
control structure it consumes the entire payload while emitting only
1 565 597 of the declared 3 686 400 output bytes. When the payload is
exhausted, the last consumed flag bit is a back-reference bit with fewer than
2 operand bytes remaining, so the back-reference branch at **`g00.rs:1009-1022`**
returns the hard `G00DecodeError::UnexpectedEndOfStream { emitted: dst.len() }`.
That is the observed
`unexpected_end_of_stream: declared_uncompressed_size=3686400 emitted=1565597`.

This was reproduced **exactly** (byte-for-byte 1 565 597) with an independent
re-implementation of the `g00.rs` algorithm, confirming the mechanism is the
LZSS variant itself, not the header parse, not input truncation, and not a
region/segmentation misread.

Note the emitted count depends **only** on the control structure (flag order,
literal polarity, length encoding) — ring contents/offset math change *which*
bytes are emitted, not *how many*. So "reached `uncompressed_size`" is NOT a
correctness signal (see §4).

---

## 2. BACK.g00 header field values + implications

First 16 bytes (structural header, not art):
`00 00 05 d0 02 12 87 0a 00 00 40 38 00 01 c7 bf`

| field | offset | bytes | value | check |
|---|---|---|---|---|
| type | 0 | `00` | 0 (RawBgr) | — |
| width  | 1 (u16 LE) | `00 05` | 1280 | — |
| height | 3 (u16 LE) | `d0 02` | 720 | — |
| compressed_size   | 5 (u32 LE) | `12 87 0a 00` | 689 938 | **== file_len(689943) − 5** ✓ |
| uncompressed_size | 9 (u32 LE) | `40 38 00 01`(→`00 38 40 00`) | 3 686 400 | **== 1280·720·4** ✓ |

LZSS payload = bytes `[13 .. 5+compressed_size]` = `[13 .. 689943]` =
**689 930 bytes** = the entire remainder of the file (`compressed_size − 8`).

**Implications:**
- Every header field is correct and internally consistent. `compressed_size`
  is the section length from offset 5 to EOF (inclusive of its own 8-byte
  preamble); `uncompressed_size` is exactly the flat 32-bpp canvas size.
- The file is a **single LZSS stream**. There is no region table, no tile
  table, no per-strip length field between the header and the payload.
- The **multi-region / tiled / segmented type-0 hypothesis is DISPROVED**:
  the outer `compressed_size` spans the whole file and leaves no room for a
  sub-image table; the decoder's single-region assumption is correct.
- The 5.34× implied ratio (689 930 → 3 686 400) is plausible for an LZSS
  background but is beyond the reach of a max-run-18 2-byte token (see §4).

---

## 3. Decodable-vs-failing structural difference (there isn't one)

Corpus scan with the exact `g00.rs` type-0 algorithm.

Sweetie HD g00 (2450 files): type-0 = 2145, type-2 = 305.
Of the 2145 type-0 files, by *terminal outcome only*:
- 1434 reached `uncompressed_size` ("clean", `oc=0`);
- 367 stopped at a literal/flag boundary (soft `PayloadLengthMismatch`, `oc=1`);
- 344 stopped mid back-reference token (hard `UnexpectedEndOfStream`, `oc=2`).

Kanon G00 (classic RealLive, 640×480): type-0 = 307 (254 reach-us, 32 soft,
21 hard), type-2 = 655, other lead byte = 40.

Facts about the split:
- **All** failing files have `compressed_size == file_len − 5` and
  `uncompressed_size == width·height·4`. Headers are 100 % correct across HD
  (1280×720) and classic (640×480).
- The pass/fail terminal outcome is **not** a structural format dimension.
  It is purely whether the wrong algorithm happens to emit ≥ `uncompressed_size`
  garbage bytes before the payload runs out. Large and small files, HD and
  classic, land in all three buckets.
- **Kanon (unambiguously classic RealLive) fails identically.** The bug is the
  core LZSS variant, **not** anything HD-specific, and **not** size-conditional.

**Coherence check (the decisive one):** decoded output of the 1434 "clean"
Sweetie type-0 files, measured as mean absolute byte delta between vertically
adjacent rows (`|buf[i] − buf[i − width·4]|`):
- observed 75.3 – 79.3 for the sampled "clean" files;
- fully-random bytes ≈ 85; a coherent photographic background would be < ~15.

⇒ **Every type-0 decode today is incoherent noise, including the 1434 marked
"clean".** The corpus "clean/type0" count is a meaningless correctness signal;
0 / 2145 type-0 files decode correctly. The pinned test
`g00_type0_back_decodes` being RED is the honest state; the "green" corpus
count is an artifact of "reached size with garbage".

---

## 4. Concrete hypothesis for the real format

The format is a **single LZSS-family stream over the full 689 930-byte payload**
(confirmed §2), and `itotori`'s variant is wrong in **multiple** axes.
An exhaustive clean-room brute force was run over the standard 2-byte-token
LZSS family for BACK.g00 and Kanon AYU_01.g00 simultaneously:
- flag order MSB-first / LSB-first;
- literal-when-bit-set / literal-when-bit-clear;
- back-reference **absolute ring position** vs **relative back-distance into
  output** (zero-initialised history);
- offset/length bit partition (offset width 8..13, length = remainder),
  offset base +0/+1, min-run add 1..3;
- optional match-length extension (nibble == max ⇒ read extra length byte).

Key quantitative results:
- A max-run-18 2-byte token has a **hard output ceiling of 2 942 393 bytes**
  (79.8 % of 3 686 400) from BACK.g00's payload — mathematically it can never
  fill the canvas. So the classic 12-bit-offset / 4-bit-length token is
  **excluded**.
- With a length **extension** (nibble==0x0f ⇒ +extra byte) the best config
  reaches **3 422 497 / 3 686 400 (93 %)** on BACK.g00 consuming all input,
  but only 476 657 / 1 228 800 (39 %) on AYU_01 — so a naive extension is also
  not the exact rule.
- **No single config** in the entire swept family both (a) emits exactly
  `uncompressed_size` and (b) consumes the full payload for *both* files.
- The relative-into-output canonical form (`out[dst − ((c>>4)+1)]`,
  length `(c&0xf)+2`, literal-when-set) fails on BACK.g00's very first
  back-reference token (offset ≈ 497 with only 3 bytes emitted), so BACK.g00
  is also not the textbook xclannad/AVG32 relative LZSS as usually quoted.

**Hypothesis:** the real decoder is a RealLive/AVG32 g00 LZSS whose token
carries a **longer / extended match length** than the classic 3..18 (either a
wider length field, a 3-byte token, or a specific "max-nibble ⇒ read extended
length" rule), combined with the **standard** literal-when-bit-set polarity and
a specific offset base that `itotori` currently gets wrong. `itotori` is wrong
in at least three dimensions simultaneously: literal-bit polarity
(`bit==0` literal), offset semantics (absolute ring position), and the
match-length encoding (fixed 3..18, no extension). The precise bit layout could
not be pinned by brute force alone — it needs the authoritative reference.

---

## 5. Proposed fix direction + required output

Replace the body of `lzss_decode_classic` (`g00.rs:960`) — and the token/
polarity documentation in the module header (`g00.rs:65-91`) — with the
authoritative RealLive g00 decompressor once its exact bitstream is pinned
(see §6). Do **not** change the header parse (`parse_lzss_section`,
`decode_type0`) — those are correct.

The fixed decoder MUST, for BACK.g00:
- consume the full 689 930-byte payload;
- emit **exactly 3 686 400 bytes** (`= width·height·4`), with **no**
  `PayloadLengthMismatch` warning and no zero-padding via `pad_or_truncate`;
- produce a **coherent** image (vertical inter-row MAD ≪ 15, not ~77);
- then BGRA→RGBA reorder (`bgra_to_rgba_in_place`) as today.

Generalise the acceptance bar accordingly: the pinned test must assert
`emitted == width·height·4 AND warnings.is_empty() AND coherence` — because the
current "reached `uncompressed_size`" condition is satisfied by garbage (§3).
The fix must be validated on ≥2 type-0 files per game and on both a HD title
(Sweetie, 1280×720) and a classic title (Kanon, 640×480), since both currently
fail on the same code path.

---

## 6. Confidence + what needs interactive confirmation

**HIGH confidence:**
- The underrun is the LZSS variant, at `g00.rs:1009-1022`, not the header,
  not truncation, not segmentation (emitted=1 565 597 reproduced exactly).
- All type-0 headers are correct; `compressed_size = file_len − 5`,
  `uncompressed_size = w·h·4`.
- Single-stream, not multi-region/tiled (multi-region hypothesis disproved).
- The bug is the core algorithm, size-independent, and affects HD **and**
  classic RealLive identically; every current type-0 decode is noise, so the
  corpus "clean" count is not a correctness signal.

**MEDIUM-LOW confidence (open item):**
- The exact correct bitstream (flag order, literal polarity, offset
  absolute-vs-relative and its base, and especially the match-length /
  extended-length rule). Brute force over the standard 2-byte-token family did
  not yield a config that is exact-and-full-consumption on both test files,
  which means the real token has a detail outside that family (most likely an
  extended/longer match length).

**Needs interactive confirmation with Trevor:**
- Pin the exact algorithm against the rlvm/xclannad RealLive g00 reference
  (research anchor only — per `RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`, do NOT
  vendor/translate source into the repo), or against a known-good decoded
  reference image (e.g. GARbro output) used solely as a black-box oracle to
  select the bitstream parameters. Once the exact token rule is confirmed on
  one file, re-run the coherence + exact-size gate across the corpus.

---

## Appendix — reproducible measurements

- BACK.g00: file_len 689943; type 0; 1280×720; compressed_size 689938
  (= len−5); uncompressed_size 3 686 400 (= w·h·4); payload 689 930 B.
- `itotori` decode of BACK.g00: emitted 1 565 597 → `UnexpectedEndOfStream`.
- 2-byte max-run-18 token output ceiling from BACK.g00 payload: 2 942 393 B.
- Best extended-length full-consumption result: BACK.g00 3 422 497 / 3 686 400
  (93 %); AYU_01 476 657 / 1 228 800 (39 %) — not exact.
- Sweetie type-0 "clean" decode vertical-MAD sample: 75.3–79.3 (noise ≈ 85).
- Sweetie g00 2450: type0 2145 (reach-us 1434 / soft 367 / hard 344),
  type2 305.
- Kanon G00: type0 307 (reach-us 254 / soft 32 / hard 21), type2 655,
  other-lead-byte 40.
