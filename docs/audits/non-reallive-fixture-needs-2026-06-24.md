# Non-RealLive Fixture-Readiness Map — RPG Maker MV/MZ and Plain XP3 + KAG

Date: 2026-06-24. Scope: the two non-RealLive engines named as
claimed-alpha in
[`docs/alpha-localization-project-readiness.md`](../alpha-localization-project-readiness.md)
§2. RealLive readiness is covered in
[`docs/audits/alpha-scope-honesty.md`](alpha-scope-honesty.md) §B.1.

This document maps **what code, fixtures, and DAG nodes exist today,
what real-game fixtures would prove the alpha vertical, and which DAG
nodes the maintainer should consider opening** so the user can match
owned archives to specific gaps. It is not a redefinition of alpha —
that is the job of `alpha-scope-honesty.md` §D. This document asks:
given a redefined alpha that proves architecture before runtime, which
real-game bytes would actually exercise each engine's
parser/patchback/runtime path?

Fixture rules below follow
[`docs/kaifuu-fixture-policy.md`](../kaifuu-fixture-policy.md): public
CI fixtures must carry an SPDX-declared redistributable license;
owned-but-unredistributable corpora live under
`fixtures/private-local/` and may appear in reports only as aggregate
counts and hashes.

---

## 1. RPG Maker MV/MZ

### 1.1 What code exists today

No dedicated `kaifuu-rpgmaker` crate yet. RPG Maker work is split
between `kaifuu-core` (surface logic) and `kaifuu-cli` (operator
subcommand):

- `crates/kaifuu-core/src/lib.rs`:1604–1670 — encrypted-suffix
  detector row (`row_id: "rpg-maker-mv-mz-encrypted-assets"`,
  `ArchiveEngineFamily::RpgMakerMvMz`). Counts `.rpgmvp/.rpgmvm/.rpgmvo`
  (MV) and `.png_/.m4a_/.ogg_` (MZ), plain `.png/.m4a/.ogg`, and
  unknown `.rpgmvu/.webp_`.
- `crates/kaifuu-core/src/lib.rs`:1672–1713 — `RpgMakerSuffixProfile`
  table mapping each suffix to `CryptoTransform::RpgMakerAssetXor`
  and `AssetKind`.
- `crates/kaifuu-core/src/lib.rs`:1874–2050 —
  `validate_rpg_maker_mv_mz_fixture_key` and its
  `Request`/`Report`/`Record`/`Diagnostic`/`DiagnosticCode` types.
  Reads `data/System.json`, finds the declared `encryptionKey`,
  XOR-decrypts the first 16 bytes of an image, reports
  `MissingSystemJson` / `BadKey` / `UnsupportedSurface`.
- `crates/kaifuu-cli/src/main.rs`:232–278 —
  `kaifuu rpg-maker validate-fixture-key` subcommand emitting a
  redacted report.

Everything else listed in
`alpha-localization-project-readiness.md`:145 for MV/MZ is **not
implemented**:

- JSON-text adapter (`KAIFUU-007`/`108`/`109`/`110`/`111`/`112`,
  all planned).
- Encrypted media decrypt/replace (`KAIFUU-115`/`116`/`117`, all
  planned).
- Port-runtime crate (no `utsushi-rpgmaker-*`;
  `UTSUSHI-031`/`032`/`033`/`102`/`119`/`134`/`065`, all planned).
- The browser launch contract (`UTSUSHI-050`/`148`) is complete but
  carries no MV/MZ-aware payload yet.

### 1.2 What works vs what is stubbed

| Capability                                                   | State                | Evidence                                                              |
| ------------------------------------------------------------ | -------------------- | --------------------------------------------------------------------- |
| Detect MV/MZ project by encrypted-asset suffix counts        | **working**          | `KAIFUU-113` complete; fixture `kaifuu-rpg-maker-encrypted-suffixes`. |
| Validate `System.json.encryptionKey` against an image header | **working**          | `KAIFUU-114` complete; `validate_rpg_maker_mv_mz_fixture_key`.        |
| MV/MZ readiness record + public fixture generator            | **planned**          | `KAIFUU-108`.                                                         |
| Map / common-event text extract + trivial patch              | **planned**          | `KAIFUU-109`.                                                         |
| Database / System / Terms / UI vocab extract + patch         | **planned**          | `KAIFUU-110`.                                                         |
| Plugin-profiled text boundary diagnostics                    | **planned**          | `KAIFUU-111`.                                                         |
| JSON full-surface golden round-trip                          | **planned**          | `KAIFUU-112`.                                                         |
| Encrypted image / audio decrypt + re-encrypt                 | **planned**          | `KAIFUU-115` / `KAIFUU-116`. Crypto enum named, not invoked.          |
| Encrypted asset replacement patch + verify                   | **planned**          | `KAIFUU-117`.                                                         |
| Browser launch contract (Chromium / NW.js)                   | **working contract** | `UTSUSHI-050`/`148`. Launches; no MV/MZ payload.                      |
| Instrumented runtime smoke / observation                     | **planned**          | `UTSUSHI-006`/`031`/`032`/`033`/`102`.                                |
| Patched-output runtime proof                                 | **planned**          | `UTSUSHI-119`.                                                        |
| Screenshot capture / embedded playback demo                  | **planned**          | `UTSUSHI-065` / `UTSUSHI-134`.                                        |

**Honest summary:** today the toolchain can _identify_ a MV/MZ project
folder and _verify_ a user-supplied key against one image header. It
cannot extract one line of dialogue, replace one asset byte, or render
one MV/MZ scene.

### 1.3 Public/redistributable fixtures already shipped

- `fixtures/public/kaifuu-rpg-maker-encrypted-suffixes/` — 13 files
  (~600 bytes total), CC0-1.0, hand-authored placeholder bodies that
  exercise the suffix detector and unknown-variant diagnostics.
  Manifest:
  `fixtures/public/kaifuu-rpg-maker-encrypted-suffixes.manifest.json`.
- No public JSON-text fixture (`Map*.json`, `CommonEvents.json`,
  `System.json` terms, `Actors.json`, `plugins.js`). `KAIFUU-108`
  would add the first one but is planned.

### 1.4 What real-game fixtures would prove the alpha vertical

Three profiles. Each can be satisfied from different
freely-redistributable titles without touching commercial backlog.

- **Profile A — small freely-licensed MV/MZ with plain `data/*.json`.**
  Drives `KAIFUU-108`/`109`/`110`. Wants ≥1 `Map*.json` containing a
  `Show Text` chain + `Show Choices`, a non-empty `CommonEvents.json`,
  and populated `System.json` terms/vocab. ~100 KB–5 MB suffices.
  Candidates worth investigating: _One Night, Hot Springs_ (npckc,
  2018, MV) — author has historically been research-friendly, verify
  license per release; itch.io entries tagged "RPG Maker MV/MZ"
  - "free" + "source available" or CC-BY; LD JAM entries with
    permissive READMEs. Avoid Kadokawa's bundled sample project unless
    the editor EULA explicitly grants redistribution.
- **Profile B — freely-licensed MV/MZ using the editor's default
  _Encrypt Assets_ option.** Drives `KAIFUU-115`/`116`/`117`. Wants
  `System.json` with non-empty `encryptionKey` and
  `hasEncryptedImages`/`hasEncryptedAudio` true, ≥1
  `.rpgmvp`/`.png_` and ≥1 `.rpgmvo`/`.m4a_` whose plaintext the user
  may re-derive. Rare combination in the wild — search itch.io for MV
  - free + presence of `www/data/System.json` declaring encryption +
    CC/free license. Synthetic public fixtures from the
    `fixtures/generate-kaifuu-encrypted-public-fixtures.mjs` pattern can
    substitute when no candidate is licensable.
- **Profile C — freely-licensed MV/MZ using a popularly-documented
  plugin** (YEP_MessageCore, Galv_MessageBackground, SRD_HUDMaker)
  with plugin-owned text in `plugins.js`'s `parameters`. Drives
  `KAIFUU-111`.
- **Profile D — owned MV/MZ for the private-local lane.** Strengthens
  the redacted readiness report; not vendored; any size and any genre
  is fine since reports surface only aggregate counts.

### 1.5 Concrete request list — RPG Maker MV/MZ

Sorted by leverage. No request requires copying private/paid bytes
into the public tree.

- **R-MV-1.** Any freely-redistributable MV/MZ game whose license
  permits redistribution of `data/*.json`, `data/System.json`, and a
  `Map*.json` containing `Show Text` + `Show Choices`. _One Night, Hot
  Springs_; itch.io "RPG Maker MV/MZ" + "free" + permissive license;
  LD JAM submissions with explicit `LICENSE` clauses.
- **R-MV-2.** Freely-redistributable MV/MZ game using the editor's
  default _Encrypt Assets_, with ≥1 `.rpgmvp`/`.png_` and ≥1
  `.rpgmvo`/`.m4a_`. Author's license must permit re-encryption
  derivatives.
- **R-MV-3.** Freely-redistributable MV/MZ game using a publicly-
  documented plugin with ≥1 plugin-owned text parameter.
- **R-MV-4.** Any owned MV/MZ game for the private-local lane.
  Genre/age rating immaterial — reports surface only aggregate counts.

### 1.6 DAG nodes that should exist (proposed)

The DAG already covers the JSON-text adapter (`KAIFUU-108`–`112`),
encrypted media (`KAIFUU-115`–`117`), and runtime port nodes
(`UTSUSHI-031`/`032`/`033`/`102`/`119`/`134`/`065`). The honest gap is
the **fixture-bridging and crate-scaffold** layer between owned
real-game bytes and those nodes' acceptance criteria.

- **KAIFUU-200** — MV/MZ public-licensed real-game fixture intake.
  Imports one freely-redistributable MV/MZ project (profile A) into
  `fixtures/public/`, captures license SPDX, emits manifest.
  Depends on `KAIFUU-108`. AC: extraction surface counts match
  pre-declared totals; SPDX in manifest verbatim.
- **KAIFUU-201** — MV/MZ private-local owned-game readiness lane.
  Wraps an owned project under `fixtures/private-local/`, produces a
  redacted readiness summary (counts, hashes, suffix histogram,
  helper requirements). Depends on `KAIFUU-036`. AC: redaction test
  forbids any project filename or key bytes in the output.
- **KAIFUU-202** — MV/MZ encrypted-asset real-bytes decrypt smoke.
  Runs `KAIFUU-115`/`116` against profile B's fixture and asserts a
  byte-equal round-trip against the author-provided plaintext.
  Depends on `KAIFUU-115`, `KAIFUU-116`, and `KAIFUU-200`.
- **UTSUSHI-200** — `utsushi-rpgmaker-mv-mz` crate scaffold. Wires a
  `RpgMakerMvMzEnginePort` through the substrate facade conformance
  manifest and emits a clean-room attestation for the browser/NW.js
  path. Zero opcode handlers — analogous to the proposed `146a` in
  `alpha-scope-honesty.md` §C.3. Depends on substrate extensions
  M.1–M.3 from `substrate-honesty.md` §M. AC: registers via
  `ConformanceManifest`; substrate conformance tests pass; no
  Show-Text/choice handler exists yet.
- **UTSUSHI-201** — MV/MZ browser launch fixture replay. Drives the
  Chromium launch contract against `KAIFUU-200`'s fixture and emits
  an E1 trace recording text + choice events. Depends on
  `UTSUSHI-200`, `UTSUSHI-031`/`032`/`033`, `KAIFUU-200`. AC: trace
  contains ≥1 `Show Text` event id matching the `KAIFUU-109` bridge
  unit id.

### 1.7 What "alpha-vertical-complete" looks like

Acceptance bundle (no eng-month estimates):

1. `kaifuu detect` against the real fixture returns `detected: true`
   with `engine_family: rpg_maker_mv_mz` (works today).
2. `kaifuu rpg-maker validate-fixture-key` returns `status: passed`
   against ≥1 image (works today).
3. `kaifuu extract` produces a bridge bundle with ≥5 `Show Text`
   units, ≥1 `Show Choices`, ≥1 `CommonEvent` command, ≥1 database
   string, and ≥1 `System.terms` field, all referencing
   `KAIFUU-108` fixture profile ids.
4. `kaifuu patch` produces JSON that round-trips byte-identically for
   unrelated fields (per `KAIFUU-109` AC).
5. `kaifuu verify` returns v0.2 `PatchResult` `status: passed`; the
   `.kaifuu` delta apply produces byte-equal output.
6. (Encrypted-media slice — separate gate.) A new
   `kaifuu rpg-maker decrypt-image` (via `KAIFUU-115`) round-trips
   one `.rpgmvp` / `.png_` byte-equal over the declared header.
7. `utsushi run` (per `UTSUSHI-201`) produces an E1 trace whose body
   matches the patched bridge unit content; trace metadata declares
   `engine_family: rpg_maker_mv_mz` and `runtime: browser-chromium`
   or `nwjs`.
8. The MV/MZ row in the `ALPHA-CHECK-004` capability matrix declares
   `capability=patch` for JSON text and `capability=readiness` (or
   `=patch` after step 6) for encrypted media.
9. `support_boundary` wording matches
   `crates/kaifuu-core/src/lib.rs`:1668 verbatim.

Steps 1–2 are demonstrable today. Steps 3–5 require `KAIFUU-108`–`112`.
Step 6 requires `KAIFUU-115`–`117`. Step 7 requires `UTSUSHI-200`
(plus `UTSUSHI-031`/`032`/`033`/`102`/`119`) and substrate extensions
M.1–M.3.

---

## 2. Plain XP3 + KAG plaintext (KiriKiri null-key)

### 2.1 What code exists today

No dedicated `kaifuu-xp3` or `kaifuu-kag` crate. Surface logic lives in
`kaifuu-core` and the detector adapter lives in `kaifuu-engine-fixture`:

- `crates/kaifuu-core/src/lib.rs`:1331–1418 — `detect_kirikiri_xp3`
  counts `.xp3` extensions and `XP3` headers
  (`b"XP3\r\n \n\x1a\x8b\x67\x01"`) plus synthetic
  encrypted/compressed/unknown markers. Returns row id
  `"kirikiri-xp3"` with detected variant ∈
  `{xp3-archive, xp3-encrypted-archive, xp3-compressed-archive,
xp3-unknown-container}`.
- `crates/kaifuu-engine-fixture/src/lib.rs`:50 —
  `XP3_DETECTOR_ADAPTER_ID = "kaifuu.kirikiri_xp3"` (detect-only).
- `crates/kaifuu-core/src/lib.rs`:155 — `XP3_PLAIN_MAGIC`.
- `crates/kaifuu-core/src/lib.rs`:14744–14997 — `PlainXp3Inventory`,
  `PlainXp3Entry`, `PlainXp3InventoryError`, internal
  `PlainXp3Segment`/`PlainXp3FileChunk`, and
  `read_plain_xp3_inventory(bytes: &[u8])`. Walks the chunked
  `File { info, segm, adlr }` index, supports raw + zlib index
  encoding, returns `UnsupportedEncrypted` on marker presence.
- `crates/kaifuu-core/src/lib.rs`:17039 — test-only synthetic builder
  `plain_xp3_fixture(...)`; not a public writer.

Everything else listed in
`alpha-localization-project-readiness.md`:147 is **not implemented**:

- Deterministic writer / rebuild (`KAIFUU-098`, planned).
- Reader+writer smoke CLI (`KAIFUU-071`, planned).
- KAG plaintext reference adapter (`KAIFUU-009`, planned). No
  tokenizer, no AST, no patch writer.
- Port-runtime (`UTSUSHI-037`/`038`/`039`, all planned). No
  `utsushi-kirikiri-xp3` / `utsushi-kag` crate.

### 2.2 What works vs what is stubbed

| Capability                                                                      | State               | Evidence                                                                |
| ------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------- |
| Detect a plain XP3 container by extension + magic                               | **working**         | `detect_kirikiri_xp3`; unit tests at `lib.rs`:17104+.                   |
| Distinguish plain / encrypted / compressed / unknown XP3 via marker counts      | **working**         | Synthetic markers (`XP3-CRYPT`, `XP3-HELPER-REQUIRED`, etc.).           |
| Read a plain XP3 index (`info`/`segm`/`adlr` chunks; raw + zlib index encoding) | **working**         | `read_plain_xp3_inventory`; KAIFUU-097 complete.                        |
| Inventory carries path, payload offset, raw size, compressed flag, adler32      | **working**         | `PlainXp3Entry`.                                                        |
| Build / rebuild a plain XP3 from inventory + payloads                           | **test-only**       | Internal helper at `lib.rs`:17039. No public API. `KAIFUU-098` planned. |
| `kaifuu xp3 smoke` reader+writer round-trip command                             | **not implemented** | `KAIFUU-071` planned.                                                   |
| KAG `.ks` tokenizer / AST                                                       | **not implemented** | `KAIFUU-009` planned.                                                   |
| KAG dialogue/choice/label/jump/variable/comment/common-tag extract              | **not implemented** | `KAIFUU-009` planned.                                                   |
| KAG patch writer with control-code-preserving edits                             | **not implemented** | `KAIFUU-009` planned.                                                   |
| KAG plaintext parser replay skeleton (Utsushi)                                  | **not implemented** | `UTSUSHI-037` planned.                                                  |
| KAG macro + storage subset                                                      | **not implemented** | `UTSUSHI-038` planned.                                                  |
| KiriKiri XP3 VFS handoff smoke                                                  | **not implemented** | `UTSUSHI-039` planned.                                                  |

**Honest summary:** today the toolchain can _identify_ an XP3 as plain
vs encrypted and _list_ entries inside a plain XP3. It cannot rebuild
an XP3, parse one line of KAG, replace one byte inside a `.ks`, or
render any KiriKiri/KAG scene.

### 2.3 Public/redistributable fixtures already shipped

- `fixtures/public/kaifuu-encrypted-matrix/` — synthetic XP3 archives
  with marker payloads (`XP3-CRYPT`, `XP3-COMPRESSED`,
  `XP3-HELPER-REQUIRED`, `XP3-UNKNOWN-VARIANT`) and stub key/profile
  metadata. CC0-1.0. Generator:
  `fixtures/generate-kaifuu-encrypted-public-fixtures.mjs`.
- Internal `plain_xp3_fixture` test helper exercises plain-XP3 read.
- No public KAG `.ks` corpus. No public real-XP3 archive.

### 2.4 What real-game fixtures would prove the alpha vertical

- **Profile A — plain (non-encrypted) XP3 containing KAG `.ks` files
  under a freely-redistributable license.** Drives `KAIFUU-097`
  (already working) + `KAIFUU-098` + `KAIFUU-009`. Wants one
  `data.xp3` (or similar) with the plain `XP3` magic, an index in raw
  or zlib encoding, and ≥1 `scenario/*.ks` inside. Candidates:
  KiriKiri / KiriKiri Z tech-demo archives (W.Dee's BSD-licensed
  source tree historically shipped sample archives — verify each
  archive's license); Fuwanovel / VNDB free-tier KiriKiri releases
  with declared permissive licenses; author-permitted small KAG
  tutorial games with explicit `redistribution OK` READMEs.
- **Profile B — plain XP3 whose KAG uses a wide range of standard
  tags** (`[r]`, `[l]`, `[p]`, `[cm]`, `[ct]`, `[wait]`, `[jump]`,
  `[call]`, `[return]`, `[if]`, `[endif]`, `[macro]`, `[endmacro]`,
  `[eval]`, `[image]`, `[playbgm]`) — drives `UTSUSHI-038`.
- **Profile C — plain XP3 with a non-trivial scenario tree** (cross-
  jumps in `scenario/*.ks`, UI strings in `system/*.ks`, an asset
  directory) — drives `UTSUSHI-039`. 1–10 MB is plenty.
- **Profile D — owned KiriKiri/KAG game (any variant) for the
  private-local lane.** Strengthens the readiness report; not
  vendored.

Hand-authored CC0 KAG fixtures (the synthetic public corpus proposed
as `KAIFUU-203` below) remain the primary alpha gate; real-game
fixtures are the strengthening layer.

### 2.5 Concrete request list — Plain XP3 + KAG

- **R-XP3-1.** Any freely-redistributable plain (non-encrypted) XP3
  archive whose author's license permits redistribution. Investigate
  KiriKiri / KiriKiri Z sample archives, author-permitted free KAG
  tutorial games, and Fuwanovel/VNDB free-tier KiriKiri releases.
- **R-XP3-2.** Small (~1–5 MB) plain XP3 whose KAG scenarios use
  ≥6 of the common tags listed under profile B. Same legal posture
  as R-XP3-1.
- **R-XP3-3.** Any owned KiriKiri/KAG game (encrypted or plaintext)
  for the private-local lane. Encrypted titles feed the future
  encrypted-XP3 work (`KAIFUU-100`/`101`/`054`/`057`/`144`/`171`),
  not the plain-XP3+KAG vertical.
- **R-XP3-4.** Any KAG `.ks` plaintext scenario file the user owns
  or can author. Hand-authored CC0 dialogue is acceptable; owned-but-
  unredistributable scenarios still inform tag-coverage analysis
  under the private-local lane.

### 2.6 DAG nodes that should exist (proposed)

The DAG already covers `KAIFUU-098` / `KAIFUU-009` / `KAIFUU-071` and
`UTSUSHI-037`/`038`/`039`. The honest gap is the **public-corpus and
fixture-bridging** layer.

- **KAIFUU-203** — Public synthetic KAG `.ks` corpus. Hand-authored
  CC0 `.ks` files covering dialogue/choices/labels/jumps/variables/
  comments and the profile-B tag inventory. Depends on `KAIFUU-009`.
  AC: ≥6 distinct KAG tags; CC0 in manifest; deterministic hashes.
- **KAIFUU-204** — Public licensed real-game plain-XP3 intake.
  Imports one redistributable plain XP3 (profile A); ships an
  `xp3-archive`/`kag-scenario` redaction manifest. Depends on
  `KAIFUU-097`, `KAIFUU-203`. AC: archive parses through
  `read_plain_xp3_inventory` with 0 errors; KAG tag inventory inside
  the archive intersects the public corpus's tag list above a
  documented coverage ratio.
- **KAIFUU-205** — Plain XP3 real-bytes round-trip smoke. Composes
  `KAIFUU-098` writer + `KAIFUU-097` reader against `KAIFUU-204`'s
  fixture and asserts byte-equal round-trip. Depends on
  `KAIFUU-098`, `KAIFUU-204`. AC: byte-equal repackage of declared
  entries; size/adler32/path preserved.
- **KAIFUU-206** — Private-local KAG/XP3 owned-game readiness lane.
  Owned game under `fixtures/private-local/`; redacted readiness
  summary. Depends on `KAIFUU-036`. AC: redaction test forbids any
  filename, KAG body, or key material in the output.
- **UTSUSHI-202** — `utsushi-kirikiri-xp3` crate scaffold. Wires a
  `KirikiriXp3EnginePort` through the substrate facade conformance
  manifest; clean-room attestation for the KAG plaintext path. Zero
  opcode handlers. Depends on substrate extensions M.1–M.3. AC:
  registers via `ConformanceManifest`; substrate conformance tests
  pass; no KAG opcode handler exists.
- **UTSUSHI-203** — KAG plaintext fixture replay against the
  synthetic corpus. Drives `UTSUSHI-037`/`038` against `KAIFUU-203`
  and emits an E0/E1 trace of text + jump events. Depends on
  `UTSUSHI-202`, `UTSUSHI-037`, `UTSUSHI-038`, `KAIFUU-009`,
  `KAIFUU-203`. AC: trace contains ≥1 text event id and ≥1 label-jump
  event id matching `KAIFUU-009` bridge unit ids.

### 2.7 What "alpha-vertical-complete" looks like

Acceptance bundle (no eng-month estimates):

1. `kaifuu detect` against the real plain XP3 returns
   `detected: true` with `engine_family: kirikiri_xp3`, variant
   `xp3-archive`, no encrypted/compressed/unknown markers
   (works today).
2. `kaifuu xp3 inventory` returns a `PlainXp3Inventory` with ≥3
   entries, each carrying a non-empty path and the correct
   `compressed` flag (works today).
3. `kaifuu xp3 smoke` round-trips the archive byte-equal for declared
   entries (needs `KAIFUU-098` + `KAIFUU-205`).
4. `kaifuu extract` against the KAG corpus produces a bridge bundle
   with ≥5 distinct dialogue units, ≥1 `Show Choices`-equivalent,
   ≥1 label, ≥1 jump, and the profile-B standard tags as protected
   spans (needs `KAIFUU-009`).
5. `kaifuu patch` produces an XP3 whose dialogue body bytes change
   for declared bridge units while every other byte (untouched
   `info`/`segm`/`adlr` chunks, recomputed adler32 for touched
   entries) is consistent with the deterministic writer (needs
   `KAIFUU-098` + `KAIFUU-009`).
6. `kaifuu verify` returns v0.2 `PatchResult` `status: passed`; the
   `.kaifuu` delta apply produces byte-equal output.
7. `utsushi run` (per `UTSUSHI-203`) produces an E0/E1 trace whose
   text-event body matches the patched bridge unit content; trace
   metadata declares `engine_family: kirikiri_xp3` and
   `runtime: kag-plaintext-interpreter`.
8. The plain-XP3 row in the `ALPHA-CHECK-004` capability matrix
   declares `capability=patch` for KAG plaintext and
   `capability=readiness` for encrypted XP3 variants.
9. `support_boundary` wording matches
   `crates/kaifuu-core/src/lib.rs`:1416 verbatim.

Steps 1–2 are demonstrable today. Steps 3, 5, 6 require
`KAIFUU-098`+`009`+`071`+`205`. Step 4 also requires
`KAIFUU-009`+`203`. Step 7 requires `UTSUSHI-202` (plus
`UTSUSHI-037`/`038`/`039`) and substrate extensions M.1–M.3.

---

## 3. Cross-engine appendix

### 3.1 Proposed DAG node summary

| Proposed id   | Engine    | Purpose                                               |
| ------------- | --------- | ----------------------------------------------------- |
| `KAIFUU-200`  | MV/MZ     | Public-licensed real-game MV/MZ fixture intake        |
| `KAIFUU-201`  | MV/MZ     | Private-local owned-game readiness lane               |
| `KAIFUU-202`  | MV/MZ     | Encrypted-asset real-bytes decrypt smoke              |
| `UTSUSHI-200` | MV/MZ     | `utsushi-rpgmaker-mv-mz` crate scaffold + conformance |
| `UTSUSHI-201` | MV/MZ     | MV/MZ browser launch fixture replay → E1 trace        |
| `KAIFUU-203`  | XP3 + KAG | Public synthetic KAG `.ks` corpus                     |
| `KAIFUU-204`  | XP3 + KAG | Public licensed real-game plain-XP3 fixture intake    |
| `KAIFUU-205`  | XP3 + KAG | Plain XP3 real-bytes round-trip smoke                 |
| `KAIFUU-206`  | XP3 + KAG | Private-local KAG/XP3 owned-game readiness lane       |
| `UTSUSHI-202` | XP3 + KAG | `utsushi-kirikiri-xp3` crate scaffold + conformance   |
| `UTSUSHI-203` | XP3 + KAG | KAG plaintext fixture replay → E0/E1 trace            |

All proposed ids are free per `roadmap/spec-dag.json` at time of
writing (max existing `KAIFUU-187`, max existing `UTSUSHI-176`).

### 3.2 What this audit does not propose

- No new RPG Maker VX Ace / RGSS3 vertical
  (`KAIFUU-055`/`143` cover readiness; alpha does not claim VX Ace
  patchback).
- No encrypted XP3 vertical
  (`KAIFUU-100`/`101`/`054`/`057`/`171`/`144` cover that staircase;
  alpha's encrypted-XP3 lane is the synthetic fixture).
- No TyranoScript intake (`KAIFUU-016` is continuous-tier).
- No changes to the RealLive vertical
  (`alpha-scope-honesty.md` §F covers that).

### 3.3 Open questions for the maintainer

- Which R-MV-1 / R-XP3-1 candidates does the user actually own or
  have authoritative licensing access to? Short list drives
  `KAIFUU-200` / `KAIFUU-204` intake priority.
- Is the maintainer willing to declare R-MV-2 (encrypted MV/MZ public
  fixture) as a separate alpha gate, or does a synthetic
  encrypted-MV/MZ fixture suffice? Answer toggles whether
  `KAIFUU-202` is alpha-tier or continuous-tier.
- Will the maintainer accept the redefined alpha
  (`alpha-scope-honesty.md` §D) for these engines? If not, the
  `UTSUSHI-031`/`032`/`033`/`102`/`119` (MV/MZ) and
  `UTSUSHI-037`/`038`/`039` (KAG) chains stay alpha-tier and the
  fixture requests above become hard blockers instead of
  strengthening evidence.

---

## Bottom line

For **RPG Maker MV/MZ**, the toolchain today does detection +
fixture-key validation only; everything else from
`alpha-localization-project-readiness.md`:145 is planned. Useful
real-game fixtures split into plain-JSON / encrypted-media / plugin-
text profiles; the highest-leverage ask is a freely-redistributable
MV/MZ project matching profile A.

For **Plain XP3 + KAG plaintext**, the toolchain today does detection

- plain-XP3 inventory only. A public synthetic KAG corpus
  (`KAIFUU-203` proposed) is the first gate; a freely-redistributable
  plain XP3 with KAG scenarios is the strengthening layer, ideally a
  KiriKiri tech demo or an author-permitted indie release.

The DAG already carries the deep nodes
(`KAIFUU-108`–`117` for MV/MZ JSON; `KAIFUU-098`/`009`/`071` for KAG;
`UTSUSHI-031`–`033`/`037`–`039`/`065`/`102`/`119`/`134`). The
fixture-bridging layer between owned real-game bytes and those nodes'
acceptance criteria is missing. The eleven proposals
(`KAIFUU-200`–`206`, `UTSUSHI-200`–`203`) close that gap without
inventing new engine support claims and without spending
the user's time on unrealistic acquisitions.
