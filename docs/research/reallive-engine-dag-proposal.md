# RealLive Engine Port — DAG Decomposition Proposal

> Replaces the single UTSUSHI-146 ("RealLive runtime port — VFS handoff, Scene/SEEN replay,
> headless render sink, deterministic clock/input, snapshot primitives") with 22 honest
> sub-nodes anchored in observable Sweetie HD bytes.
>
> Companion to [`reallive-engine.md`](./reallive-engine.md) — every acceptance criterion
> below references either a specific Sweetie HD byte range or an explicit synthetic
> fixture under `crates/kaifuu-reallive/tests/fixtures/`.
>
> Path discipline:
>
> - `$GAME/` ≡ `/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版/`
> - Node ids are placeholders (`UTSUSHI-146a` … `UTSUSHI-146v`); the orchestrator assigns
>   real ids when ingesting.
>
> Substrate-readiness column:
>
> - **substrate-ready** — UTSUSHI-120 facade suffices; no substrate change required.
> - **substrate-gap** — the substrate honesty subagent should verify the named gap before
>   this node is scheduled.

## Approach

The decomposition is layered. Foundation nodes (bytecode loader, header parser,
gameexe parser) gate the VM nodes (expression evaluator, variable banks, dispatcher)
which gate the RLOperation-family nodes which gate the subsystem nodes (graphics
object stack, text system, sound system, save system) which gate the end-to-end
replay node.

A new crate `utsushi-reallive` lives alongside `kaifuu-reallive`. `kaifuu-reallive`
keeps its current synthetic-fixture parser-boundary role (KAIFUU-172/173/174 are
already complete and serve the inventory pipeline). `utsushi-reallive` owns the
real-bytes engine port.

Replacement-aware: the existing UTSUSHI-146 acceptance criterion ("rlvm referenced
only as research anchor, never invoked as a binary") propagates onto every node
below.

## Node decomposition

### Foundation layer

#### UTSUSHI-146a — utsushi-reallive crate skeleton + facade dependency

- **Substrate-readiness:** substrate-ready.
- **Title:** Create the `utsushi-reallive` crate (pure-Rust, GPL-incompatible-free)
  importing only the UTSUSHI-120 substrate facade and `kaifuu-reallive` for
  inventory cross-reference; no rlvm / siglus_rs / xclannad source.
- **Acceptance criteria:**
  - `cargo new --lib crates/utsushi-reallive` shape with `forbid(unsafe_code)`,
    deny(missing_debug_implementations).
  - Depends on `utsushi-core` only via `utsushi_core::substrate::*` imports.
  - Depends on `kaifuu-reallive` only for `SceneId` / `InventoryReport` types.
  - Crate-level doc declares "research anchor: rlvm" provenance with the same
    clean-room boundary statement that `kaifuu-reallive` carries.
  - `EnginePortAdapter` impl stub returning `Unimplemented` for every lifecycle
    stage.
- **Synthetic fixture acceptable.**
- **Dependencies:** UTSUSHI-120 (complete), KAIFUU-174 (complete).
- **Verification:** `cargo test -p utsushi-reallive scaffold`, `cargo doc -p utsushi-reallive --no-deps`.
- **Audit focus:** rlvm header / source leakage; facade bypass via
  `utsushi_core::vfs::*` direct import; placeholder `Ok(())` returns that hide
  unimplemented stages.

---

#### UTSUSHI-146b — Real Seen.txt directory parser

- **Substrate-readiness:** substrate-ready.
- **Title:** Implement the 10,000-slot directory format of `Seen.txt` (not the
  count-plus-table envelope `kaifuu-reallive` recognises) — produce a
  `RealSceneIndex` exposing `(scene_id, byte_offset, byte_len)` for every
  non-zero slot.
- **Acceptance criteria:**
  - Against `$GAME/REALLIVEDATA/Seen.txt` (3,876,496 bytes): parser returns
    **exactly 198 non-zero scenes**, with `scene_id=1` at `byte_offset=0x13880,
byte_len=0x5fa` and `scene_id=9999` at `byte_offset=0x20423e,
byte_len=0xb42`. The scene-id range is verified to be 1..=9999 inclusive
    with the documented gaps.
  - Zeroed slots emit no entry (not a diagnostic; the format reserves slots).
  - A truncated archive (declared offset+size exceeds file length) emits
    `utsushi.reallive.truncated_scene` Fatal.
  - Does **not** call `kaifuu-reallive::parse_archive` — that function targets
    the synthetic envelope shape.
- **Must verify against Sweetie HD byte 0x00000000..0x00013880 (the directory)
  and byte 0x00013880..0x00013e7a (scene 1 payload).**
- **Dependencies:** UTSUSHI-146a.
- **Verification:** `cargo test -p utsushi-reallive scene_index_sweetie_hd_198_scenes`,
  `cargo test -p utsushi-reallive scene_index_first_last_offsets`.
- **Audit focus:** thin-wrapper cheat — reusing `kaifuu-reallive::parse_archive`
  internally; off-by-one slot indexing (slot 0 is reserved); silent acceptance
  of overlap between slot N and slot N+1.

---

#### UTSUSHI-146c — Scene header parser

- **Substrate-readiness:** substrate-ready.
- **Title:** Decode the 0x1d0-byte scene header documented by RLDEV / rlvm
  scenario.cc into a typed `SceneHeader { compiler_version, kidoku_offset,
kidoku_count, dramatis_offset, dramatis_count, bytecode_offset,
bytecode_uncompressed_size, bytecode_compressed_size, entrypoint_table,
savepoint_message, savepoint_selcom, savepoint_seentop, z_minus_one,
z_minus_two }`.
- **Acceptance criteria:**
  - For Sweetie HD scene #0001 (file offset 0x13880, scene-blob offset 0):
    `compiler_version=110002`, `kidoku_offset=464`, `kidoku_count=1`,
    `bytecode_offset=468`, `bytecode_uncompressed_size=1660`,
    `bytecode_compressed_size=1062`, entrypoint_table starts at 0x34 with the
    `0x06` lattice. (Documented in `docs/research/reallive-engine.md` § D.)
  - Header fields are all u32 LE.
  - Out-of-profile compiler-version values (anything not in {10002, 110002,
    1110002}) emit `utsushi.reallive.unknown_compiler_version` Warning and the
    header still parses.
- **Must verify against Sweetie HD scene-blob bytes 0x13880..0x13a50 (first
  464 bytes of the scene-1 blob).**
- **Dependencies:** UTSUSHI-146b.
- **Verification:** `cargo test -p utsushi-reallive scene1_header_matches_sweetie_hd`.
- **Audit focus:** any field whose offset can't be cited from rlvm's
  `scenario.cc` header constructor (P) or the Sweetie HD bytes (V) — speculative
  fields are out.

---

#### UTSUSHI-146d — AVG32 LZ + XOR scene decompressor

- **Substrate-readiness:** substrate-ready.
- **Title:** Implement the AVG32 byte-by-byte XOR (256-byte mask) plus the
  LZSS sliding-window decompressor that turns a scene's
  `bytecode_compressed_size` bytes into `bytecode_uncompressed_size` bytes.
  Also implement the second-level XOR pass for compiler-version `110002`.
- **Acceptance criteria:**
  - Decompressing Sweetie HD scene #0001's 1062 compressed bytes (file offset
    0x13a54..0x13e7a) produces exactly **1660** uncompressed bytes.
  - The first byte of the uncompressed stream is in the documented
    BytecodeElement opener set `{0x00, 0x0a, 0x21, 0x23, 0x24, 0x2c, 0x40}` or
    a printable Shift-JIS lead byte (`0x81`-`0x9F` / `0xE0`-`0xFC`). If it is
    not, the test fails (an immediate "XOR-2 key is wrong" canary).
  - A round-trip suite recompresses + decompresses 8 synthetic streams covering
    pure literals, pure back-references, 1-byte distance, max-distance
    (4096-byte window), max-length runs (17 bytes), mixed.
  - Sukara-title XOR-2 key handling: if the key is unknown for Sweetie HD,
    the node ships with `xor_2_key = None` and emits
    `utsushi.reallive.xor2_key_unknown` Warning — the node does **not** silently
    skip the second pass and pretend success. Resolution of the actual key
    happens in UTSUSHI-146t (research-only).
- **Must verify against Sweetie HD scene-1 compressed payload at
  $GAME/REALLIVEDATA/Seen.txt byte 0x13a54..0x13e7a.**
- **Dependencies:** UTSUSHI-146c.
- **Verification:**
  `cargo test -p utsushi-reallive scene1_decompress_yields_1660_bytes`,
  `cargo test -p utsushi-reallive lz_roundtrip_synthetic_cases`.
- **Audit focus:** the 256-byte mask must be re-derived (it's a public byte
  string; re-typing from RLDEV docs is fine, but copying from
  `rlvm/src/libreallive/compression.cc` is not — the constants must be
  attributed). The LZSS window pointer arithmetic is a classic place to copy
  a C expression verbatim; tests must catch wrong distance-encoding.

---

#### UTSUSHI-146e — Bytecode element stream decoder

- **Substrate-readiness:** substrate-ready.
- **Title:** Implement the lead-byte switch (`0x00`/`0x2C` comma,
  `0x0A`/`0x21`/`0x40` meta, `0x24` expression, `0x23` command, default
  textout) on the decompressed scene bytes. Produce a `Vec<BytecodeElement>`
  with each element carrying its scene-blob byte range.
- **Acceptance criteria:**
  - Decoding Sweetie HD scene #0001's 1660 uncompressed bytes produces a
    bounded element stream (target: ≤ 200 elements, ≥ 50 elements based on
    the 1660-byte size and typical RealLive density). The first element is
    either an entrypoint MetaElement (`0x21`) or a kidoku MetaElement
    (`0x40`).
  - The element-stream byte ranges partition the 1660 uncompressed bytes
    completely (same partition guarantee as the existing parser-boundary
    contract in KAIFUU-173).
  - The first `CommandElement` decoded must have `command[0]=0x23` and
    expose `module_type` (byte 1), `module_id` (byte 2), `opcode` (u16 LE
    at bytes 3-4), `arg_count` (byte 5), `overload` (byte 6).
  - Selection-element option markers (`0x30`-`0x34`) are recognised and
    distinguished from default textout.
- **Must verify against Sweetie HD scene #0001 decompressed bytes 0..1660
  (requires UTSUSHI-146d to land first).**
- **Dependencies:** UTSUSHI-146d.
- **Verification:** `cargo test -p utsushi-reallive scene1_element_stream_partition`,
  `cargo test -p utsushi-reallive scene1_first_command_header_decodes`.
- **Audit focus:** "default branch" textout swallowing meta-marker bytes;
  forgetting that `0x00` and `0x2C` are both comma; treating `0x40` as
  arithmetic instead of meta.

---

#### UTSUSHI-146f — Expression evaluator

- **Substrate-readiness:** substrate-ready.
- **Title:** Implement the RealLive expression byte-stream reader:
  arithmetic 0x02-0x09, comparison 0x28-0x2D, logical 0x3C/0x3D, compound
  assignment 0x14-0x24, `0xFF` int-literal, `0xC8` store-register,
  `$<bank>[<idx_expr>]` memory reference, `(`/`)` grouping, `,` separator.
- **Acceptance criteria:**
  - Round-trip 50 synthetic expressions covering each operator at least
    once; serialised bytes round-trip through the parser.
  - Evaluate `$\x0B[0]+5` (intB[0] + 5) against a variable bank where
    intB[0]=10 → 15. Specific operator/bank cases: - `\xFF\x01\x00\x00\x00 \x06 \xFF\x02\x00\x00\x00` (1 + 2) → 3. - `\xFF\x05\x00\x00\x00 \x29 \xFF\x05\x00\x00\x00` (5 < 5) → 0. - `$\x0B[\xFF\x00\x00\x00\x00] \x14 \xFF\x07\x00\x00\x00` (`intB[0] =
7`) → updates intB[0] to 7.
  - Operators outside the documented byte set emit
    `utsushi.reallive.unknown_expression_operator` Warning and the
    expression returns its partial result.
- **Synthetic fixture acceptable** — does not require real Sweetie HD bytes
  to verify (real expressions exercised once UTSUSHI-146g lands).
- **Dependencies:** UTSUSHI-146e.
- **Verification:** `cargo test -p utsushi-reallive expression_synthetic_50_cases`,
  `cargo test -p utsushi-reallive expression_real_sweetie_hd_first_command_args` (gated on UTSUSHI-146g).
- **Audit focus:** sign extension of `i32 LE` constants; precedence
  ordering (RealLive expressions are flat / fully-parenthesised so there
  is no precedence; tests should fail loudly if a node tries to add C-style
  precedence); store-register read vs write distinction.

---

#### UTSUSHI-146g — Variable banks + store register

- **Substrate-readiness:** substrate-ready.
- **Title:** Define typed banks `intA`-`intZ` (13 letters per RLDEV; rlvm
  caps each at 2,000), `strS`/`strM`/`strK`, and a u32 store register.
  Expose `get(bank, idx) -> Value`, `set(bank, idx, value)`, and a
  `Snapshot` / `Restore` impl wired to the substrate
  `Inspectable`/`Restorable` traits so VM state snapshots flow through
  UTSUSHI-023 unchanged.
- **Acceptance criteria:**
  - `intA[0] = 42; snapshot; intA[0] = 99; restore; assert intA[0] == 42`
    round-trips through `SnapshotStore`.
  - `Snapshot` JSON for an empty machine is < 1 KB (no per-bank
    zero-fill); only set indices appear.
  - Out-of-range writes (e.g. `intA[2000]`) emit
    `utsushi.reallive.bank_index_out_of_range` Warning and clamp.
  - String banks store as Shift-JIS bytes verbatim — not lossy UTF-8 round
    trip.
- **Synthetic fixture acceptable.**
- **Dependencies:** UTSUSHI-146a (substrate facade access).
- **Verification:** `cargo test -p utsushi-reallive variable_banks_snapshot_restore`,
  `cargo test -p utsushi-reallive variable_banks_shift_jis_roundtrip`.
- **Audit focus:** treating `intC` as identical to `intA` (the banks are
  semantically distinct in scripts); snapshot key format leaking
  banks-by-position rather than banks-by-name.

---

### Gameexe layer

#### UTSUSHI-146h — Structured Gameexe.ini parser

- **Substrate-readiness:** substrate-ready.
- **Title:** Replace the line-classifier in `kaifuu-reallive::gameexe`
  (parser-boundary inventory only) with a structured Shift-JIS parser
  producing a `Gameexe` tree that supports `get_str`,
  `get_int_array`, `get_tuple3`, and dotted-path lookup
  (`get("SYSCOM.005.000")`).
- **Acceptance criteria:**
  - Against `$GAME/REALLIVEDATA/Gameexe.ini` (1,345 lines):
    - `gameexe.get_int("SEEN_START") == 1` (verified: `#SEEN_START=0001`).
    - `gameexe.get_str("CAPTION") == "オシオキSweetie＋Sweets!! HD Edition　"`.
    - `gameexe.get_tuple3("FOLDNAME.G00") == ("G00", 0, "G00.PAK")`
      (verified: `#FOLDNAME.G00 = "G00" =  0   : "G00.PAK"`).
    - `gameexe.get_int_array("SCREENSIZE_MOD") == [999, 1280, 720]`.
    - `gameexe.get_int_pair("CANCELCALL") == (9999, 10)`.
    - `gameexe.get_int_array("MOUSEACTIONCALL.000.AREA") == [1232, 0, 1279, 719]`.
    - `gameexe.get_int_array("WINDOW_ATTR") == [100, 100, 160, 200, 0]`.
    - `gameexe.list_namespace("SYSCOM").len() >= 32` (32 system commands
      observed).
    - `gameexe.list_namespace("NAMAE").len() == 11` (11 speaker mappings
      observed).
  - The parser handles the `=` / `:` mixed separator (FOLDNAME line) and
    parenthesised value lists (`(1,016, -1)` in NAMAE lines).
  - Shift-JIS encoding is preserved on output; round-trip is exact for
    keys the parser recognises.
- **Must verify against Sweetie HD `$GAME/REALLIVEDATA/Gameexe.ini`.**
- **Dependencies:** UTSUSHI-146a.
- **Verification:** `cargo test -p utsushi-reallive gameexe_sweetie_hd_known_values`,
  `cargo test -p utsushi-reallive gameexe_dotted_path_lookup`.
- **Audit focus:** Lossy UTF-8 conversion silently dropping high-byte
  characters; reusing `kaifuu-reallive`'s inventory classifier under the
  hood instead of parsing structure; failing to model the
  `KEY = "..." = N : "..."` triple shape.

---

### VM execution layer

#### UTSUSHI-146i — Bytecode VM (fetch / decode / dispatch / advance)

- **Substrate-readiness:** **substrate-gap (longop scheduler snapshot — see
  reallive-engine.md § K).** Substrate honesty subagent must verify
  `SnapshotStore` can serialise a paused longop.
- **Title:** Implement `Vm { scene, pc, stack, banks, store_reg,
longop_queue }` with fetch/decode/dispatch/advance loop. Dispatch hooks
  call into per-module RLOperation tables (separate nodes below).
- **Acceptance criteria:**
  - Stepping the VM on a synthetic scene `goto +0` infinite loop with a
    `max_steps=100` terminator produces a deterministic
    `out_of_budget` outcome (no panic).
  - A `gosub` followed by `ret` returns the pc to the post-`gosub` byte.
  - A `farcall` (cross-scene) followed by `rtl` returns to the calling
    scene at the post-`farcall` byte.
  - Longop yields (synthetic `pause` longop) suspend the VM; the next
    `step` call resumes from the paused state, and a snapshot taken at
    the suspend point restores into the same longop with the same
    private state.
  - End-to-end: stepping Sweetie HD scene #0001 emits at least one
    `CommandElement` dispatch (the first command of the prologue)
    before hitting an `Unimplemented` opcode boundary — proves the
    VM can drive a real scene up to the opcode coverage frontier.
- **Must verify against Sweetie HD scene #0001 once UTSUSHI-146d/e land.**
- **Dependencies:** UTSUSHI-146e, UTSUSHI-146f, UTSUSHI-146g.
- **Verification:** `cargo test -p utsushi-reallive vm_synthetic_goto_loop`,
  `cargo test -p utsushi-reallive vm_gosub_ret_returns`,
  `cargo test -p utsushi-reallive vm_steps_scene1_until_unimplemented`.
- **Audit focus:** longop scheduler being a placeholder enum that never
  fires; `step` advancing the pc by a constant instead of by the
  element's byte length; gosub/ret stack mishandling on cross-scene
  jumps.

---

#### UTSUSHI-146j — Text / messaging RLOperation family

- **Substrate-readiness:** substrate-ready.
- **Title:** Implement the text/messaging opcodes (module_msg equivalent):
  `text` (textout element), `pause`, `par`, `br`, `page`, `msgHide`,
  `msgHideAll`, `msgClear`, `FontColor`, `FontSize`, `TextWindow`,
  `FastText`, `NormalText`, `FaceOpen`, `FaceClose`. Target: ~15 opcodes
  of the ~35 in rlvm's module_msg.
- **Acceptance criteria:**
  - Each implemented opcode emits exactly one `TextLine` /
    `TextSurfaceEvent` through the substrate `TextSurfaceSink`, with the
    speaker name (from `intA` / `intB` per RealLive convention) and
    Shift-JIS-decoded body.
  - A synthetic scene `[textout "こんにちは"] [pause]` produces one
    `TextLine { speaker: "", body: "こんにちは" }` followed by an idle
    state until the next input event.
  - The decoded text matches the Shift-JIS round-trip exactly (no UTF-8
    drift).
  - Unimplemented opcodes in this module emit
    `utsushi.reallive.unimplemented_opcode` Warning carrying
    `module_type`, `module_id`, `opcode` — and the VM advances past them
    without aborting.
- **Synthetic fixture acceptable for opcodes other than `text` + `pause`;
  `text` + `pause` must verify against the first textout in Sweetie HD
  scene #0001 once UTSUSHI-146d/e/i land.**
- **Dependencies:** UTSUSHI-146i.
- **Verification:** `cargo test -p utsushi-reallive msg_text_emits_textline`,
  `cargo test -p utsushi-reallive msg_pause_yields_until_input`,
  `cargo test -p utsushi-reallive msg_scene1_first_textout_matches_shift_jis_decoded`.
- **Audit focus:** TextLine emission shape (must use existing facade
  type, not a new one); decoded body being lossy; speaker name not
  resolved through `NAMAE` table.

---

#### UTSUSHI-146k — Control-flow RLOperation family

- **Substrate-readiness:** substrate-ready.
- **Title:** `goto`, `goto_if`, `goto_unless`, `goto_on`, `goto_case`,
  `gosub`, `gosub_if`, `gosub_unless`, `gosub_on`, `gosub_with`, `ret`,
  `ret_with`, `rtl`, `rtl_with`, `jump`, `farcall`, `farcall_with`.
  Target: 17 of rlvm's 22.
- **Acceptance criteria:**
  - `goto_if($intA[0] == 1, label)`: with `intA[0]=1`, pc advances to
    label; with `intA[0]=0`, pc advances to next element.
  - `goto_on($intA[0], [l0, l1, l2, l3])`: with `intA[0]=2`, pc advances
    to `l2`.
  - `goto_case($intA[0], [(1, l1), (5, l5)])`: with `intA[0]=5`, pc
    advances to `l5`; with `intA[0]=99`, pc advances past the
    `goto_case` (default sink).
  - `gosub_with(label, $intA[0])`: pushes a stack frame whose parameter
    slot 0 = current intA[0]; the called scene's expressions can read
    that parameter; `ret_with(...)` propagates the return value back
    into the caller's store register.
  - `farcall(scene_id, entrypoint)`: cross-scene jump with proper
    stack-frame push for `rtl` return; targets must be valid scene
    entries in the `RealSceneIndex`.
  - System-call entry into Sweetie HD scene 9999 via the
    `CANCELCALL=9999,10` route works once UTSUSHI-146n (system-call
    dispatch) is in place; this node just exposes `farcall` for
    UTSUSHI-146n to call.
- **Synthetic fixture acceptable for the abstract cases; the
  `farcall(9999, 10)` test path must verify against Sweetie HD's actual
  scene 9999 entry layout once decompression lands.**
- **Dependencies:** UTSUSHI-146i.
- **Verification:**
  `cargo test -p utsushi-reallive ctl_goto_if_branches`,
  `cargo test -p utsushi-reallive ctl_gosub_with_parameter_passing`,
  `cargo test -p utsushi-reallive ctl_farcall_scene9999_entrypoint10`.
- **Audit focus:** off-by-one on entrypoint-table indexing; missing
  parameter-stack cleanup on `ret_with`; treating `goto_case` default as
  a fatal instead of a fallthrough.

---

#### UTSUSHI-146l — Choice (`select` / `select_s` / `select_w`) family

- **Substrate-readiness:** **substrate-gap (longop scheduler — same as
  UTSUSHI-146i).**
- **Title:** Implement `select`, `select_s`, `select_w`, `select_objbtn`.
  The choice mechanism is a longop: it suspends the VM, emits one
  `TextLine` per option (annotated as a choice), waits for an
  `InputEvent::ChoiceMade(ChoiceIndex)`, then resumes by writing the
  index into the store register.
- **Acceptance criteria:**
  - A synthetic scene with `select_s ["a", "b", "c"]` emits 3 `TextLine`
    events of `kind = Choice` (existing substrate type), then suspends.
  - Feeding `ChoiceIndex(1)` resumes; store register reads as 1; pc
    advances past the choice element.
  - Sweetie HD's first `select`/`select_s` in scene #0001 (location TBD —
    will be the first 0x23-opener element with module_id matching
    sel-module dispatch in the real bytecode) decodes its choice
    strings correctly. (If scene #0001 doesn't have a choice, this node's
    real-bytes test targets the first scene that does — discoverable once
    UTSUSHI-146d/e land.)
  - Choice strings honour `SELBTN.NNN.*` styling values from Gameexe.
- **Must verify against the first `select`-bearing scene in Sweetie HD
  Seen.txt.**
- **Dependencies:** UTSUSHI-146i, UTSUSHI-146h, UTSUSHI-146j.
- **Verification:** `cargo test -p utsushi-reallive choice_select_s_emits_three_options`,
  `cargo test -p utsushi-reallive choice_resume_writes_store_reg`.
- **Audit focus:** longop coupling — the longop must use the substrate
  scheduler (whatever UTSUSHI-146i settles on), not a private wait loop.

---

#### UTSUSHI-146m — String / memory / arithmetic RLOperation families

- **Substrate-readiness:** substrate-ready.
- **Title:** Implement string ops (`strcpy`, `strcat`, `strlen`,
  `Uppercase`, `Lowercase`, `itoa`, `atoi`, `strout`, `intout`, `strpos`,
  `strlpos`, `hantozen`, `zentohan`), memory ops (`setarray`, `setrng`,
  `cpyrng`, `setarray_stepped`, `setrng_stepped`, `cpyvars`, `sum`,
  `sums`), system arithmetic (`rnd`, `pcnt`, `abs`, `power`, `sin`, `cos`,
  `min`, `max`, `constrain`). Target: ~24 of the ~70 across rlvm's
  module_str + module_mem + module_sys arithmetic subset.
- **Acceptance criteria:**
  - Each op: input/output table with at least 3 cases including a
    boundary (empty string, zero-size range, max u16 index).
  - `rnd` is deterministic when the substrate `LogicalClock` is fixed;
    snapshot/restore of the rng state round-trips through
    `SnapshotStore`.
  - Shift-JIS handling: `Uppercase("ＡＢＣ")` returns `"ＡＢＣ"` (already
    upper); `hantozen("abc")` returns `"ａｂｃ"` (full-width); these are
    the documented half/full conversions per RLDEV.
- **Synthetic fixture acceptable.**
- **Dependencies:** UTSUSHI-146g.
- **Verification:** `cargo test -p utsushi-reallive str_ops_table`,
  `cargo test -p utsushi-reallive mem_setarray_stepped_table`,
  `cargo test -p utsushi-reallive sys_rnd_deterministic_under_logical_clock`.
- **Audit focus:** `rnd` reading from the OS rng instead of substrate
  clock-seeded rng; encoding conversions silently dropping half-width
  katakana.

---

### Subsystem layer

#### UTSUSHI-146n — System-call dispatch wired to Gameexe

- **Substrate-readiness:** substrate-ready.
- **Title:** Wire the eight Gameexe-declared system-call routes
  (`CANCELCALL`, `SYSTEMCALL_SAVE`/`LOAD`/`SYSTEM`,
  `MOUSEACTIONCALL.000`, `LOADCALL`, `EXAFTERCALL`, `WBCALL.000`-`007`)
  into the VM event loop. Each route is a `farcall(scene_id,
entrypoint)` from UTSUSHI-146k triggered by the matching substrate
  `InputEvent` kind.
- **Acceptance criteria:**
  - Boot with Sweetie HD's `Gameexe.ini` loaded; the dispatcher reports
    8 known routes with the documented (scene_id, entrypoint) pairs from
    `docs/research/reallive-engine.md` § H.
  - `MOUSEACTIONCALL.000.AREA=1232,0,1279,719`: a pointer-move event
    with `(x=1250, y=300)` triggers the route; a pointer-move with
    `(x=100, y=100)` does not.
  - `CANCELCALL_MOD=0` disables the cancel route entirely (mods
    interpreted per RLDEV).
  - Routes call into UTSUSHI-146k's `farcall` — no private dispatch
    path.
- **Must verify against Sweetie HD `Gameexe.ini` lines 14-28 (the
  documented routes).**
- **Dependencies:** UTSUSHI-146h, UTSUSHI-146k.
- **Verification:** `cargo test -p utsushi-reallive syscall_routes_match_sweetie_hd`,
  `cargo test -p utsushi-reallive mouseactioncall_hot_region_dispatches`.
- **Audit focus:** routes that say "TODO" in unit tests but pretend to
  pass; failing to wire `_MOD` flags.

---

#### UTSUSHI-146o — Graphics object stack (headless)

- **Substrate-readiness:** **substrate-gap (multi-artifact-per-tick emit
  cadence — see reallive-engine.md § K).** Substrate honesty subagent
  must verify `FrameArtifactSink` permits more than one artifact per
  logical clock tick if a single scene emits text + sprite changes in
  the same `pause`-boundary.
- **Title:** Implement the rlvm `GraphicsSystem` equivalent: a stack of
  ~256 graphics objects (foreground + background planes), each with
  `(position, scale, alpha, colour_tone, image_ref, layer_order)` state,
  plus a render-pass that walks the stack and rasterises a per-frame
  `FrameArtifact` into the substrate artifact store.
- **Acceptance criteria:**
  - Allocating 256 objects, setting positions, calling render →
    deterministic PNG bytes (same input → same output bytes including
    PNG metadata).
  - Two render passes with the same state produce byte-identical PNGs.
  - The render pass observes the `SCREENSIZE_MOD=999,1280,720` Gameexe
    value and emits a 1280x720 buffer.
  - A "wipe" object (full-screen colour) renders to a solid-colour PNG
    matching the documented colour byte order.
  - The frame artifact carries `frame_index`, `evidence_tier=E1`, and an
    `artifact_id` resolving to a PNG blob.
- **Synthetic fixture acceptable** for the stack mechanics; the render
  pass against a real g00 sprite requires UTSUSHI-146q to land first and
  is gated as a follow-up test.
- **Dependencies:** UTSUSHI-146a, UTSUSHI-146h.
- **Verification:** `cargo test -p utsushi-reallive graphics_object_stack_256_objects`,
  `cargo test -p utsushi-reallive render_wipe_solid_colour_deterministic_png`.
- **Audit focus:** non-deterministic PNG output (timestamp metadata); the
  artifact store being a stub `Vec` that doesn't actually retain bytes.

---

#### UTSUSHI-146p — Graphics RLOperation family

- **Substrate-readiness:** substrate-ready (assumes UTSUSHI-146o
  resolves the multi-artifact-per-tick gap).
- **Title:** Implement the rlvm module*grp + module_obj_management +
  module_obj_fg_bg subset: `allocDC`, `wipe`, `shake`, `load`/`open`/
  `openBg`, `copy`/`fill`/`invert`/`mono`/`colour`/`light`, `fade`,
  `stretchBlit`/`zoom`, `objAlloc`/`objFree`/`objInit`/`objCopy`,
  per-object setters `objSetPos`, `objSetAlpha`, `objSetScale`,
  `objSetLayer`, `objShow`/`objHide`. Target: ~25 opcodes of the ~150
  across rlvm's module_grp + module_obj*\*.
- **Acceptance criteria:**
  - Each opcode produces an observable mutation of UTSUSHI-146o's
    graphics object stack visible via a `state_snapshot` API.
  - `openBg("BG01A1")` reads `$GAME/REALLIVEDATA/g00/BG01A1.g00` via the
    substrate VFS and registers it as the bg plane background; the next
    render emits a 1280x720 PNG whose top-left pixel matches the
    documented bg colour (after g00 type-0 decode lands in UTSUSHI-146q).
  - `fade(target_alpha, ms)` schedules a longop that mutates the bg
    plane's alpha over `ms / clock_tick_period` ticks.
- **Must verify against Sweetie HD's real `BG01A1.g00` once UTSUSHI-146q
  is available; gated as a follow-up test until then.**
- **Dependencies:** UTSUSHI-146o, UTSUSHI-146q.
- **Verification:** `cargo test -p utsushi-reallive grp_openbg_bg01a1_registers_bg_plane`.
- **Audit focus:** opcodes that mutate state but never produce a
  visible effect (graphics-object stack updates that don't render);
  layer-ordering that ignores `objSetLayer`.

---

#### UTSUSHI-146q — g00 image decoder (types 0/1/2)

- **Substrate-readiness:** substrate-ready.
- **Title:** Decode the three g00 sub-formats: type 0 (raw 24-bpp BGR),
  type 1 (8-bpp paletted + LZSS), type 2 (24-bpp + region list + LZSS).
  Output is a `(width, height, pixels_rgba: Vec<u8>, regions: Vec<G00Region>)`.
- **Acceptance criteria:**
  - For Sweetie HD's `$GAME/REALLIVEDATA/g00/BACK.g00` (type 0): decoded
    width is non-zero, decoded `pixels_rgba.len()` matches
    `width * height * 4`, and the first pixel matches the documented BGR
    byte order from the file header.
  - A directory-wide histogram pass reports the lead-byte distribution
    across all 2,450 `.g00` files (counts of type 0 / 1 / 2 / unknown).
    The acceptance criterion requires types 0, 1, and 2 are each
    decoded for at least one Sweetie HD file (if the corpus contains
    that type) — emit `utsushi.reallive.g00_no_type_N_in_corpus` for
    types not present.
  - Type 2 decoded files expose a `regions: Vec<G00Region { rect, name? }>`
    list usable by `objLoadRegion` in UTSUSHI-146p.
- **Must verify against Sweetie HD `$GAME/REALLIVEDATA/g00/BACK.g00` and
  `BG01A1.g00`; full-corpus histogram against all 2,450 files.**
- **Dependencies:** UTSUSHI-146a.
- **Verification:** `cargo test -p utsushi-reallive g00_type0_back_decodes`,
  `cargo test -p utsushi-reallive g00_corpus_histogram_sweetie_hd_2450_files`.
- **Audit focus:** treating "BGR" as "RGB" silently; LZSS distance
  encoding regression that decodes a few bytes and then garbage; region
  table off-by-one against type 2 sub-bitmap counts.

---

#### UTSUSHI-146r — Audio system: NWA + OVK decoders + AudioEvent emitter

- **Substrate-readiness:** **substrate-gap (sub-sample addressing in
  AudioEvent payload — see reallive-engine.md § K).** Substrate honesty
  subagent must verify `AudioEvent` can carry
  `(archive_id, sample_id)` metadata in the VoicePlay variant.
- **Title:** Implement NWA decoder (raw PCM + run-length variants), OVK
  decoder (16-byte header entries + Ogg Vorbis sample passthrough), and
  RLOperations `bgmPlay`, `bgmStop`, `bgmFadeOut`, `koePlay`, `koeStop`,
  `wavPlay`, `wavStop`, `playSe`. Target: ~15 of rlvm's ~60 across
  module_bgm + module_koe + module_pcm + module_se.
- **Acceptance criteria:**
  - NWA: against `$GAME/REALLIVEDATA/bgm/ASA.nwa` (18,317,046 bytes,
    raw 16-bit PCM), decoder returns 33,818,820 sample frames at
    44,100 Hz, 16-bit, 2-channel.
  - OVK: against `$GAME/REALLIVEDATA/koe/z0001.ovk`, decoder returns
    2 entries with `(sample_num=46, length=36)` and `(sample_num=52,
length=183,476)`. The first sample's raw bytes start with `OggS`
    magic.
  - `koePlay($intA[0]=46)` resolves through the speaker table to `z0001.ovk
sample 46` and emits `AudioEvent { kind: VoicePlay, archive_id:
"z0001", sample_id: 46, evidence_tier: E1 }`.
  - `bgmPlay("ASA")` resolves through `Gameexe FOLDNAME.BGM` to
    `$GAME/REALLIVEDATA/bgm/ASA.nwa` and emits
    `AudioEvent { kind: BgmStart, asset_id: "bgm/ASA", evidence_tier: E1 }`.
  - No actual sample mixing required; the decoder just verifies header
    decode and emits metadata.
- **Must verify against Sweetie HD `ASA.nwa`, `z0001.ovk`, `CHIME.nwa`.**
- **Dependencies:** UTSUSHI-146h, UTSUSHI-146i.
- **Verification:** `cargo test -p utsushi-reallive nwa_asa_decodes_33M_frames`,
  `cargo test -p utsushi-reallive ovk_z0001_two_entries`,
  `cargo test -p utsushi-reallive koe_play_resolves_through_namae_table`.
- **Audit focus:** treating NWA as raw bytes (i.e. skipping the offset
  table); OVK entry size as anything other than 16 bytes; AudioEvent
  payload missing voice-archive metadata.

---

#### UTSUSHI-146s — Save / load (AVG-derived format)

- **Substrate-readiness:** substrate-ready.
- **Title:** Implement read + write of `REALLIVE.sav` (per-slot system
  save), `save999.sav` (global save), `read.sav` (per-line read flags).
  Format follows the AVG32-derived `SAVE_FORMAT=3` Gameexe declaration.
- **Acceptance criteria:**
  - Reading `$GAME/SAVEDATA/REALLIVE.sav` produces a
    `SystemSave { magic: "AVG_SYSTEM_SAVE", slots: [...] }` with the
    declared file-size (24,876) cross-checked against the `2C 61 00 00`
    leading u32.
  - Reading `$GAME/SAVEDATA/save999.sav` produces a
    `GlobalSave { magic: "AVG_GLOBAL_SAVE", ... }`.
  - Reading `$GAME/SAVEDATA/read.sav` produces a `ReadFlags { title:
"オシオキSweetie＋Sweets!! HD Edition\u{8140}", ... }` (the
    Shift-JIS title decodes round-trip).
  - Writing a freshly-snapshotted save produces byte-identical output
    to a known synthetic fixture (round-trip).
  - The substrate `SnapshotStore` is used as the in-memory backing for
    save state; on-disk write is a separate serialiser.
- **Must verify against Sweetie HD `$GAME/SAVEDATA/*.sav` files (read
  only — no writes to the read-only mount).**
- **Dependencies:** UTSUSHI-146g, UTSUSHI-146h.
- **Verification:** `cargo test -p utsushi-reallive save_reads_avg_system_save`,
  `cargo test -p utsushi-reallive save_reads_avg_global_save`,
  `cargo test -p utsushi-reallive save_read_flags_decodes_title`.
- **Audit focus:** writing to the read-only research mount (must be
  banned at the test layer); endianness flips between read and write;
  silently truncating slots.

---

### Game-state-machine + replay layer

#### UTSUSHI-146t — Sukara title XOR-2 key resolution (research-only)

- **Substrate-readiness:** substrate-ready (no substrate work — this is
  a research node).
- **Title:** Determine whether Sweetie HD's compiler-version-110002
  bytecode uses the AVG32 second-level XOR pass, and if so, recover the
  key. This is a **research** node — no code changes if the key turns
  out to be off; one constant + documentation if it's recoverable.
- **Acceptance criteria:**
  - A bench tool (under `crates/utsushi-reallive/benches/`) decompresses
    Sweetie HD scene #0001 with **no** XOR-2 pass and reports byte
    statistics of the first 64 bytes (entropy, lead-byte distribution
    against the documented `{0x00, 0x0a, 0x21, 0x23, 0x24, 0x2c, 0x40}`
    - Shift-JIS leads).
  - If the entropy is structured (key off), the node ships with
    `xor_2_key = None` for the Sukara title family and
    `docs/research/reallive-engine.md` is updated to record the finding.
  - If the entropy is random (key on), the node ships with a known-bytes
    attack (RealLive scenes always start with a MetaElement opener byte
    `0x21` or `0x40` at offset 0 of the bytecode) and either recovers
    the key or documents the recovery path for a follow-up node.
  - Either outcome is acceptable; what is **not** acceptable is shipping
    UTSUSHI-146d with a hardcoded "Key 09" guess and pretending it's
    Sukara's.
- **Must verify against Sweetie HD scene #0001 decompressed payload.**
- **Dependencies:** UTSUSHI-146d.
- **Verification:** `cargo bench -p utsushi-reallive sukara_xor2_entropy_scan`.
- **Audit focus:** silent acceptance of garbage decompressed bytes;
  using a Visual-Arts title key on a Sukara title.

---

#### UTSUSHI-146u — End-to-end Sweetie HD scene-1 text-replay smoke

- **Substrate-readiness:** substrate-ready (assumes 146i / 146o
  substrate-gap items are resolved).
- **Title:** Drive Sweetie HD scene #0001 through the VM until either
  (a) the first `pause` opcode fires producing a `TextLine` capture
  through the substrate `TextSurfaceSink`, or (b) an unimplemented
  opcode trips a documented diagnostic.
- **Acceptance criteria:**
  - Running `utsushi-reallive::replay_scene(seen_path, 1)` against
    `$GAME/REALLIVEDATA/Seen.txt` produces a `ReplayLog` with at least
    one `TextLine` event whose body is non-empty Shift-JIS text.
  - The replay is byte-deterministic: two runs produce identical
    `ReplayLog` JSON.
  - The same replay can be snapshotted at any tick boundary and restored
    to identical state.
  - Unimplemented opcodes emit Warnings (not Fatals) so the run reaches
    "first textual output" before any unknown stops it.
- **Must verify against Sweetie HD `Seen.txt` scene #0001 end-to-end.**
- **Dependencies:** UTSUSHI-146d through UTSUSHI-146t (everything).
- **Verification:** `cargo test -p utsushi-reallive replay_scene1_emits_textline`,
  `cargo test -p utsushi-reallive replay_scene1_byte_deterministic`,
  `cargo test -p utsushi-reallive replay_scene1_snapshot_restore_identity`.
- **Audit focus:** the test passing because the VM happens to halt on a
  Warning before producing any output; "deterministic" actually being
  flaky and hidden by retry; snapshot-restore being a no-op.

---

#### UTSUSHI-146v — Cross-engine substrate conformance + Siglus lineage notes

- **Substrate-readiness:** substrate-ready (UTSUSHI-147 already declares
  the cross-engine conformance fixture target).
- **Title:** Tie the RealLive port into UTSUSHI-147's cross-engine
  conformance fixture. Document which sub-nodes of UTSUSHI-146 will be
  reusable when the Siglus port lands (the AVG32 → RealLive → Siglus
  lineage Visual Arts documents).
- **Acceptance criteria:**
  - UTSUSHI-146a-u's facade usage is confirmed identical to a Siglus
    minimal-port scaffold (only `utsushi_core::substrate::*` imports;
    no engine-specific facade exceptions).
  - Lineage notes in `docs/research/reallive-engine.md` (new appendix)
    document:
    - **Reusable across engines:** expression encoding (Siglus uses the
      same bank model), variable banks (Siglus uses 26 letters not 13
      but the trait carries), AVG32 LZ + XOR (Siglus inherits the same
      compression algorithm), Gameexe-style config (Siglus uses
      `Resource.txt` but the dotted-path tree generalises), the headless
      sink pipeline, the snapshot/restore contract.
    - **RealLive-only:** rlvm-specific opcode catalogue, OVK voice
      archives (Siglus uses different containers), specific module
      identifiers.
  - Any UTSUSHI-146 node whose acceptance criterion would break under a
    Siglus reuse claim emits a documented "engine-specific boundary"
    note instead of pretending portability.
- **Synthetic fixture acceptable** (this is a documentation +
  conformance-pin node).
- **Dependencies:** UTSUSHI-146u, UTSUSHI-147 (declared but planned).
- **Verification:** `cargo test -p utsushi-siglus --test cross_engine_substrate_alignment`,
  `just check`. (UTSUSHI-147 promoted the inline scaffold into the
  `utsushi-siglus` sibling crate; the cross-engine fixture lives there
  now.)
- **Audit focus:** "reusable" claims that haven't been proven against a
  Siglus prototype; lineage notes that just repeat marketing instead of
  documenting actual code reuse points.

---

## Cross-cutting acceptance and audit

Across every node above:

- **No rlvm code is copied or mechanically translated.** Acceptance tests
  observe Sweetie HD byte input → typed output; any byte-pattern that can
  only be cited from rlvm source must be re-derived and the test must
  fail loudly if the constant is wrong.
- **No GPL-licensed crate is depended on.** `utsushi-reallive`'s
  `Cargo.toml` declares license MIT-OR-Apache-2.0; CI gates the
  dependency tree.
- **No `Command::new`, no Wine, no helper subprocess.** Every test runs
  as a pure-Rust function over `&[u8]` (mirroring `kaifuu-reallive`'s
  posture).
- **Every diagnostic is semantic and stable.** Codes follow
  `utsushi.reallive.<surface>.<reason>`; the codes are listed in a
  `docs/utsushi-reallive-diagnostics.md` doc updated as nodes land.

## Summary

| Layer        | Nodes                                                  | Count  | Substrate-gap nodes       |
| ------------ | ------------------------------------------------------ | ------ | ------------------------- |
| Foundation   | 146a, 146b, 146c, 146d, 146e, 146f, 146g               | 7      | —                         |
| Gameexe      | 146h                                                   | 1      | —                         |
| VM execution | 146i, 146j, 146k, 146l, 146m                           | 5      | 146i, 146l                |
| Subsystems   | 146n, 146o, 146p, 146q, 146r, 146s                     | 6      | 146o, 146r                |
| Game state   | 146t (research), 146u (e2e), 146v (cross-engine notes) | 3      | —                         |
| **Total**    |                                                        | **22** | **4 substrate-gap nodes** |

### Substrate-gap claims (substrate honesty subagent verification points)

1. **UTSUSHI-146i / UTSUSHI-146l:** can `SnapshotStore` serialise a paused
   longop, including its private state? Or must longop state live in named
   `StatePath` slots?
2. **UTSUSHI-146o:** does `FrameArtifactSink` permit multiple artifacts per
   logical clock tick (for the text + sprite-change-in-same-pause case)?
3. **UTSUSHI-146r:** does `AudioEventKind::VoicePlay` permit
   `(archive_id, sample_id)` metadata in the payload, given the
   forbidden-key filter at `crates/utsushi-core/src/sink/audio.rs:245-260`?
4. (Implicit) **UTSUSHI-146o:** the artifact store backing
   `FrameArtifact::artifact_ref` — is it a runner concern or a substrate
   concern? If the engine port has to bring its own artifact-store
   implementation, that's not a gap; if the substrate is expected to
   provide one, the gap needs to be filled.

### Replacement plan for the current UTSUSHI-146

When the orchestrator ingests this proposal, UTSUSHI-146's status should
move to **superseded**; its acceptance criteria are absorbed into 146u
(the end-to-end smoke). UTSUSHI-147 ("Cross-engine substrate
conformance fixture") keeps its dependency on UTSUSHI-146u (the
end-to-end node), not on every 146x sub-node.
