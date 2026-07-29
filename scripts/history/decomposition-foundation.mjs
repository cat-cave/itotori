// Node specifications for the foundation and Gameexe layers.

export const NODE_SPECS_FOUNDATION = [
  // ---- Foundation layer -------------------------------------------------
  {
    suffix: "a",
    title: "utsushi-reallive crate skeleton + facade dependency (RealLive port foundation)",
    summary:
      "Create the `utsushi-reallive` crate (pure-Rust, GPL-incompatible-free) importing only the capability_utsushi_120 substrate facade and `kaifuu-reallive` for inventory cross-reference; no rlvm / siglus_rs / xclannad source. Crate-level doc declares 'research anchor: rlvm' provenance with the same clean-room boundary statement that `kaifuu-reallive` carries.",
    deliverables: [
      "`utsushi-reallive` crate scaffold (`cargo new --lib crates/utsushi-reallive`) with `forbid(unsafe_code)` and `deny(missing_debug_implementations)`",
      "Dependency manifest importing only `utsushi_core::substrate::*` plus `kaifuu-reallive` for `SceneId` / `InventoryReport` types",
      "Crate-level doc with rlvm research-anchor + clean-room boundary statement",
      "`EnginePortAdapter` impl stub returning `Unimplemented` for every lifecycle stage",
      "License + dependency-tree CI gate (license MIT-OR-Apache-2.0; no GPL transitive deps)",
    ],
    acceptanceCriteria: [
      "`cargo new --lib crates/utsushi-reallive` shape with `forbid(unsafe_code)`, deny(missing_debug_implementations).",
      "Depends on `utsushi-core` only via `utsushi_core::substrate::*` imports.",
      "Depends on `kaifuu-reallive` only for `SceneId` / `InventoryReport` types.",
      "Crate-level doc declares 'research anchor: rlvm' provenance with the same clean-room boundary statement that `kaifuu-reallive` carries.",
      "`EnginePortAdapter` impl stub returning `Unimplemented` for every lifecycle stage.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive scaffold"],
      ["command", "cargo doc -p utsushi-reallive --no-deps"],
    ],
    auditFocus: [
      "rlvm header / source leakage",
      "Facade bypass via `utsushi_core::vfs::*` direct import",
      "Placeholder `Ok(())` returns that hide unimplemented stages",
    ],
    dependsOnProposal: [], // explicitly anchored: the relevant capability + the relevant capability.
    extraDeps: ["capability_utsushi_120", "capability_kaifuu_174"],
  },

  {
    suffix: "b",
    title: "Real Seen.txt 10,000-slot directory parser",
    summary:
      "Implement the 10,000-slot directory format of `Seen.txt` (not the count-plus-table envelope `kaifuu-reallive` recognises) — produce a `RealSceneIndex` exposing `(scene_id, byte_offset, byte_len)` for every non-zero slot. Verifies against Sweetie HD bytes 0x00000000..0x00013880 (the directory) and 0x00013880..0x00013e7a (scene 1 payload).",
    deliverables: [
      "`RealSceneIndex` struct exposing `(scene_id, byte_offset, byte_len)` per non-zero slot",
      "10,000-slot directory parser distinct from the `kaifuu-reallive` count-plus-table envelope",
      "Truncated-archive detection emitting `utsushi.reallive.truncated_scene` Fatal",
      "Sweetie HD verification: 198 non-zero scenes with documented first/last offsets",
      "Zeroed-slot handling: reserved slots emit no entry (not a diagnostic)",
    ],
    acceptanceCriteria: [
      "Against `$GAME/REALLIVEDATA/Seen.txt` (3,876,496 bytes): parser returns exactly 198 non-zero scenes, with `scene_id=1` at `byte_offset=0x13880, byte_len=0x5fa` and `scene_id=9999` at `byte_offset=0x20423e, byte_len=0xb42`. The scene-id range is verified to be 1..=9999 inclusive with the documented gaps.",
      "Zeroed slots emit no entry (not a diagnostic; the format reserves slots).",
      "A truncated archive (declared offset+size exceeds file length) emits `utsushi.reallive.truncated_scene` Fatal.",
      "Does not call `kaifuu-reallive::parse_archive` — that function targets the synthetic envelope shape.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive scene_index_sweetie_hd_198_scenes"],
      ["command", "cargo test -p utsushi-reallive scene_index_first_last_offsets"],
    ],
    auditFocus: [
      "Thin-wrapper cheat — reusing `kaifuu-reallive::parse_archive` internally",
      "Off-by-one slot indexing (slot 0 is reserved)",
      "Silent acceptance of overlap between slot N and slot N+1",
    ],
    dependsOnProposal: ["a"],
  },

  {
    suffix: "c",
    title: "Scene header parser (0x1d0-byte typed decoder)",
    summary:
      "Decode the 0x1d0-byte scene header documented by RLDEV / rlvm scenario.cc into a typed `SceneHeader { compiler_version, kidoku_offset, kidoku_count, dramatis_offset, dramatis_count, bytecode_offset, bytecode_uncompressed_size, bytecode_compressed_size, entrypoint_table, savepoint_message, savepoint_selcom, savepoint_seentop, z_minus_one, z_minus_two }`. Verifies against Sweetie HD scene-blob bytes 0x13880..0x13a50.",
    deliverables: [
      "Typed `SceneHeader` struct with all documented fields decoded u32 LE",
      "Sweetie HD scene #0001 round-trip pinning header field values",
      "Out-of-profile compiler-version Warning (`utsushi.reallive.unknown_compiler_version`) without halting",
      "Field-by-field provenance citation against rlvm `scenario.cc` constructor (P) or Sweetie HD bytes (V)",
    ],
    acceptanceCriteria: [
      "For Sweetie HD scene #0001 (file offset 0x13880, scene-blob offset 0): `compiler_version=110002`, `kidoku_offset=464`, `kidoku_count=1`, `bytecode_offset=468`, `bytecode_uncompressed_size=1660`, `bytecode_compressed_size=1062`, entrypoint_table starts at 0x34 with the `0x06` lattice. (Documented in `docs/research/reallive-engine.md` § D.)",
      "Header fields are all u32 LE.",
      "Out-of-profile compiler-version values (anything not in {10002, 110002, 1110002}) emit `utsushi.reallive.unknown_compiler_version` Warning and the header still parses.",
    ],
    verification: [["command", "cargo test -p utsushi-reallive scene1_header_matches_sweetie_hd"]],
    auditFocus: [
      "Any field whose offset can't be cited from rlvm's `scenario.cc` header constructor (P) or the Sweetie HD bytes (V) — speculative fields are out",
    ],
    dependsOnProposal: ["b"],
  },

  {
    suffix: "d",
    title: "AVG32 LZ + XOR scene decompressor",
    summary:
      "Implement the AVG32 byte-by-byte XOR (256-byte mask) plus the LZSS sliding-window decompressor that turns a scene's `bytecode_compressed_size` bytes into `bytecode_uncompressed_size` bytes. Also implement the second-level XOR pass for compiler-version `110002`. Verifies against Sweetie HD scene-1 compressed payload at byte 0x13a54..0x13e7a.",
    deliverables: [
      "AVG32 256-byte XOR mask (re-derived from RLDEV public docs, attributed in source)",
      "LZSS sliding-window decompressor (4096-byte window, max-length runs)",
      "Second-level XOR pass plumbing for compiler-version 110002 (`xor_2_key = None` shipped if unknown)",
      "Synthetic round-trip suite covering 8 stream shapes (literals, back-references, max-distance, max-length, mixed)",
      "`utsushi.reallive.xor2_key_unknown` Warning when key absent — never silent",
    ],
    acceptanceCriteria: [
      "Decompressing Sweetie HD scene #0001's 1062 compressed bytes (file offset 0x13a54..0x13e7a) produces exactly 1660 uncompressed bytes.",
      "The first byte of the uncompressed stream is in the documented BytecodeElement opener set `{0x00, 0x0a, 0x21, 0x23, 0x24, 0x2c, 0x40}` or a printable Shift-JIS lead byte (`0x81`-`0x9F` / `0xE0`-`0xFC`). If it is not, the test fails (an immediate 'XOR-2 key is wrong' canary).",
      "A round-trip suite recompresses + decompresses 8 synthetic streams covering pure literals, pure back-references, 1-byte distance, max-distance (4096-byte window), max-length runs (17 bytes), mixed.",
      "Sukara-title XOR-2 key handling: if the key is unknown for Sweetie HD, the node ships with `xor_2_key = None` and emits `utsushi.reallive.xor2_key_unknown` Warning — the node does not silently skip the second pass and pretend success. Resolution of the actual key happens in capability_utsushi_219 (research-only).",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive scene1_decompress_yields_1660_bytes"],
      ["command", "cargo test -p utsushi-reallive lz_roundtrip_synthetic_cases"],
    ],
    auditFocus: [
      "The 256-byte mask must be re-derived (it's a public byte string; re-typing from RLDEV docs is fine, but copying from `rlvm/src/libreallive/compression.cc` is not — the constants must be attributed)",
      "LZSS window pointer arithmetic copied verbatim from C without re-derivation",
      "Wrong distance-encoding silently producing garbage",
    ],
    dependsOnProposal: ["c"],
  },

  {
    suffix: "e",
    title: "Bytecode element stream decoder",
    summary:
      "Implement the lead-byte switch (`0x00`/`0x2C` comma, `0x0A`/`0x21`/`0x40` meta, `0x24` expression, `0x23` command, default textout) on the decompressed scene bytes. Produce a `Vec<BytecodeElement>` with each element carrying its scene-blob byte range. Verifies against Sweetie HD scene #0001 decompressed bytes 0..1660.",
    deliverables: [
      "Lead-byte dispatch over decompressed scene bytes producing `Vec<BytecodeElement>`",
      "Per-element scene-blob byte range partition (matching capability_kaifuu_173 parser-boundary contract)",
      "`CommandElement` header decode exposing `module_type`, `module_id`, `opcode (u16 LE)`, `arg_count`, `overload`",
      "Selection-element option marker recognition (`0x30`-`0x34`) distinct from default textout",
      "Sweetie HD scene #0001 partition test (≤200, ≥50 elements; first is `0x21` or `0x40` meta)",
    ],
    acceptanceCriteria: [
      "Decoding Sweetie HD scene #0001's 1660 uncompressed bytes produces a bounded element stream (target: ≤ 200 elements, ≥ 50 elements based on the 1660-byte size and typical RealLive density). The first element is either an entrypoint MetaElement (`0x21`) or a kidoku MetaElement (`0x40`).",
      "The element-stream byte ranges partition the 1660 uncompressed bytes completely (same partition guarantee as the existing parser-boundary contract in capability_kaifuu_173).",
      "The first `CommandElement` decoded must have `command[0]=0x23` and expose `module_type` (byte 1), `module_id` (byte 2), `opcode` (u16 LE at bytes 3-4), `arg_count` (byte 5), `overload` (byte 6).",
      "Selection-element option markers (`0x30`-`0x34`) are recognised and distinguished from default textout.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive scene1_element_stream_partition"],
      ["command", "cargo test -p utsushi-reallive scene1_first_command_header_decodes"],
    ],
    auditFocus: [
      "'Default branch' textout swallowing meta-marker bytes",
      "Forgetting that `0x00` and `0x2C` are both comma",
      "Treating `0x40` as arithmetic instead of meta",
    ],
    dependsOnProposal: ["d"],
  },

  {
    suffix: "f",
    title: "Expression evaluator (RealLive expression byte-stream)",
    summary:
      "Implement the RealLive expression byte-stream reader: arithmetic 0x02-0x09, comparison 0x28-0x2D, logical 0x3C/0x3D, compound assignment 0x14-0x24, `0xFF` int-literal, `0xC8` store-register, `$<bank>[<idx_expr>]` memory reference, `(`/`)` grouping, `,` separator. Synthetic fixtures cover the table; real Sweetie HD bytes exercised once the VM lands.",
    deliverables: [
      "Expression byte-stream reader covering arithmetic, comparison, logical, compound-assignment, literal, store-register, memory-ref, grouping, separator",
      "50-case synthetic round-trip suite spanning every operator",
      "Evaluator with variable-bank read/write through the substrate facade",
      "`utsushi.reallive.unknown_expression_operator` Warning emission for out-of-spec bytes",
      "Gated real-bytes test (`expression_real_sweetie_hd_first_command_args`) wired for capability_utsushi_208 follow-up",
    ],
    acceptanceCriteria: [
      "Round-trip 50 synthetic expressions covering each operator at least once; serialised bytes round-trip through the parser.",
      "Evaluate `$\\x0B[0]+5` (intB[0] + 5) against a variable bank where intB[0]=10 → 15. Specific operator/bank cases: `\\xFF\\x01\\x00\\x00\\x00 \\x06 \\xFF\\x02\\x00\\x00\\x00` (1 + 2) → 3; `\\xFF\\x05\\x00\\x00\\x00 \\x29 \\xFF\\x05\\x00\\x00\\x00` (5 < 5) → 0; `$\\x0B[\\xFF\\x00\\x00\\x00\\x00] \\x14 \\xFF\\x07\\x00\\x00\\x00` (intB[0] = 7) updates intB[0] to 7.",
      "Operators outside the documented byte set emit `utsushi.reallive.unknown_expression_operator` Warning and the expression returns its partial result.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive expression_synthetic_50_cases"],
      ["command", "cargo test -p utsushi-reallive expression_real_sweetie_hd_first_command_args"],
    ],
    auditFocus: [
      "Sign extension of `i32 LE` constants",
      "Adding C-style precedence to flat / fully-parenthesised RealLive expressions",
      "Store-register read vs write distinction silently confused",
    ],
    dependsOnProposal: ["e"],
  },

  {
    suffix: "g",
    title: "Variable banks + store register (typed `intA`..`intZ` / `strS`/`strM`/`strK`)",
    summary:
      "Define typed banks `intA`-`intZ` (13 letters per RLDEV; rlvm caps each at 2,000), `strS`/`strM`/`strK`, and a u32 store register. Expose `get(bank, idx) -> Value`, `set(bank, idx, value)`, and a `Snapshot` / `Restore` impl wired to the substrate `Inspectable`/`Restorable` traits so VM state snapshots flow through capability_utsushi_023 unchanged.",
    deliverables: [
      "Typed bank model (`intA`..`intZ`, `strS`, `strM`, `strK`) capped at 2,000 indices each",
      "u32 store register",
      "`Snapshot` / `Restore` impl wired through substrate `Inspectable`/`Restorable` traits",
      "Sparse snapshot JSON (<1KB for empty machine)",
      "Shift-JIS string-bank round-trip preserving bytes verbatim",
      "`utsushi.reallive.bank_index_out_of_range` Warning with clamp on overflow writes",
    ],
    acceptanceCriteria: [
      "`intA[0] = 42; snapshot; intA[0] = 99; restore; assert intA[0] == 42` round-trips through `SnapshotStore`.",
      "`Snapshot` JSON for an empty machine is < 1 KB (no per-bank zero-fill); only set indices appear.",
      "Out-of-range writes (e.g. `intA[2000]`) emit `utsushi.reallive.bank_index_out_of_range` Warning and clamp.",
      "String banks store as Shift-JIS bytes verbatim — not lossy UTF-8 round trip.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive variable_banks_snapshot_restore"],
      ["command", "cargo test -p utsushi-reallive variable_banks_shift_jis_roundtrip"],
    ],
    auditFocus: [
      "Treating `intC` as identical to `intA` (the banks are semantically distinct in scripts)",
      "Snapshot key format leaking banks-by-position rather than banks-by-name",
    ],
    dependsOnProposal: ["a"],
  },

  // ---- Gameexe layer ---------------------------------------------------
  {
    suffix: "h",
    title: "Structured Gameexe.ini parser (Shift-JIS, dotted-path)",
    summary:
      'Replace the line-classifier in `kaifuu-reallive::gameexe` (parser-boundary inventory only) with a structured Shift-JIS parser producing a `Gameexe` tree that supports `get_str`, `get_int_array`, `get_tuple3`, and dotted-path lookup (`get("SYSCOM.005.000")`). Verifies against Sweetie HD `$GAME/REALLIVEDATA/Gameexe.ini`.',
    deliverables: [
      "Structured `Gameexe` tree with `get_str`, `get_int`, `get_int_array`, `get_int_pair`, `get_tuple3`, and `list_namespace` accessors",
      "Dotted-path lookup (`SYSCOM.005.000`)",
      "Shift-JIS preservation on read and round-trip on output",
      "Mixed `=`/`:` separator handling (FOLDNAME triples) and parenthesised value lists (NAMAE)",
      "Sweetie HD pinned values: SEEN_START, CAPTION, FOLDNAME.G00, SCREENSIZE_MOD, CANCELCALL, MOUSEACTIONCALL.000.AREA, WINDOW_ATTR, SYSCOM.* count, NAMAE.* count",
    ],
    acceptanceCriteria: [
      'Against `$GAME/REALLIVEDATA/Gameexe.ini` (1,345 lines): `gameexe.get_int("SEEN_START") == 1` (verified: `#SEEN_START=0001`); `gameexe.get_str("CAPTION") == "オシオキSweetie＋Sweets!! HD Edition　"`; `gameexe.get_tuple3("FOLDNAME.G00") == ("G00", 0, "G00.PAK")`; `gameexe.get_int_array("SCREENSIZE_MOD") == [999, 1280, 720]`; `gameexe.get_int_pair("CANCELCALL") == (9999, 10)`; `gameexe.get_int_array("MOUSEACTIONCALL.000.AREA") == [1232, 0, 1279, 719]`; `gameexe.get_int_array("WINDOW_ATTR") == [100, 100, 160, 200, 0]`; `gameexe.list_namespace("SYSCOM").len() >= 32`; `gameexe.list_namespace("NAMAE").len() == 11`.',
      "The parser handles the `=` / `:` mixed separator (FOLDNAME line) and parenthesised value lists (`(1,016, -1)` in NAMAE lines).",
      "Shift-JIS encoding is preserved on output; round-trip is exact for keys the parser recognises.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive gameexe_sweetie_hd_known_values"],
      ["command", "cargo test -p utsushi-reallive gameexe_dotted_path_lookup"],
    ],
    auditFocus: [
      "Lossy UTF-8 conversion silently dropping high-byte characters",
      "Reusing `kaifuu-reallive`'s inventory classifier under the hood instead of parsing structure",
      'Failing to model the `KEY = "..." = N : "..."` triple shape',
    ],
    dependsOnProposal: ["a"],
  },

];
