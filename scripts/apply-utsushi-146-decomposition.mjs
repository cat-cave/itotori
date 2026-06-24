#!/usr/bin/env node
/**
 * Translates the structured 22-node decomposition in
 * docs/research/reallive-engine-dag-proposal.md into spec-dag.json entries.
 *
 * Plan:
 *   - Load roadmap/spec-dag.json and validate against the schema.
 *   - Mark UTSUSHI-146 as `cancelled`, retain all other fields, retarget the
 *     summary at the decomposition doc.
 *   - Insert 22 new nodes (UTSUSHI-200 .. UTSUSHI-221) right after UTSUSHI-146,
 *     drawn verbatim where possible from the proposal doc.
 *   - Re-validate against the schema; bail loudly on any error.
 *   - Write with JSON.stringify(dag, null, 2) + "\n" (the spec-dag lifecycle
 *     canonicalizer reformats on subsequent CLI runs).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dagPath = resolve(root, "roadmap/spec-dag.json");
const schemaPath = resolve(root, "roadmap/spec-dag.schema.json");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateAgainstSchema(dag, schema, label) {
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(dag)) {
    const errors = (validate.errors ?? [])
      .map((e) => `  ${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
      .join("\n");
    throw new Error(`schema validation failed (${label}):\n${errors}`);
  }
}

// ID mapping helpers ---------------------------------------------------------

// Proposal "146x" -> numeric DAG id (200 .. 221).
const SUFFIX_LETTERS = "abcdefghijklmnopqrstuv".split("");
const ID_BY_SUFFIX = new Map(
  SUFFIX_LETTERS.map((letter, index) => [letter, `UTSUSHI-${200 + index}`]),
);

function mapProposalIdToDagId(suffix) {
  const id = ID_BY_SUFFIX.get(suffix);
  if (!id) throw new Error(`unknown proposal suffix: ${suffix}`);
  return id;
}

// Common fields applied to every sub-node -----------------------------------

const COMMON = {
  projects: ["utsushi"],
  parallelGroup: "runtime-adapters",
  status: "planned",
};

const SUBSTRATE_GAP_NOTE =
  "[substrate-gap: requires substrate extension — see docs/research/reallive-engine-dag-proposal.md substrate-gap callouts]";

// P1 nodes per task scope: 200, 201, 202, 203, 204, 205, 207, 208, 209, 211,
// 213, 212, 216, 219, 221. All others P2.
const P1_IDS = new Set([
  "UTSUSHI-200",
  "UTSUSHI-201",
  "UTSUSHI-202",
  "UTSUSHI-203",
  "UTSUSHI-204",
  "UTSUSHI-205",
  "UTSUSHI-207",
  "UTSUSHI-208",
  "UTSUSHI-209",
  "UTSUSHI-211",
  "UTSUSHI-212",
  "UTSUSHI-213",
  "UTSUSHI-216",
  "UTSUSHI-219",
  "UTSUSHI-221",
]);

function priorityFor(id) {
  return P1_IDS.has(id) ? "P1" : "P2";
}

function targetFor(id) {
  return id === "UTSUSHI-200" ? "alpha" : "continuous";
}

// ---------------------------------------------------------------------------
// Per-node content. Acceptance criteria and audit focus are drawn verbatim
// from the proposal doc; verification commands map to {type:"command"} entries.
// Deliverables are derived from the proposal title + acceptance criteria so
// each node has 4-6 concrete bullets.
// ---------------------------------------------------------------------------

const NODE_SPECS = [
  // ---- Foundation layer -------------------------------------------------
  {
    suffix: "a",
    title: "utsushi-reallive crate skeleton + facade dependency (RealLive port foundation)",
    summary:
      "Create the `utsushi-reallive` crate (pure-Rust, GPL-incompatible-free) importing only the UTSUSHI-120 substrate facade and `kaifuu-reallive` for inventory cross-reference; no rlvm / siglus_rs / xclannad source. Crate-level doc declares 'research anchor: rlvm' provenance with the same clean-room boundary statement that `kaifuu-reallive` carries.",
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
    dependsOnProposal: [], // explicitly anchored: UTSUSHI-120 + KAIFUU-174.
    extraDeps: ["UTSUSHI-120", "KAIFUU-174"],
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
      "Sukara-title XOR-2 key handling: if the key is unknown for Sweetie HD, the node ships with `xor_2_key = None` and emits `utsushi.reallive.xor2_key_unknown` Warning — the node does not silently skip the second pass and pretend success. Resolution of the actual key happens in UTSUSHI-219 (research-only).",
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
      "Per-element scene-blob byte range partition (matching KAIFUU-173 parser-boundary contract)",
      "`CommandElement` header decode exposing `module_type`, `module_id`, `opcode (u16 LE)`, `arg_count`, `overload`",
      "Selection-element option marker recognition (`0x30`-`0x34`) distinct from default textout",
      "Sweetie HD scene #0001 partition test (≤200, ≥50 elements; first is `0x21` or `0x40` meta)",
    ],
    acceptanceCriteria: [
      "Decoding Sweetie HD scene #0001's 1660 uncompressed bytes produces a bounded element stream (target: ≤ 200 elements, ≥ 50 elements based on the 1660-byte size and typical RealLive density). The first element is either an entrypoint MetaElement (`0x21`) or a kidoku MetaElement (`0x40`).",
      "The element-stream byte ranges partition the 1660 uncompressed bytes completely (same partition guarantee as the existing parser-boundary contract in KAIFUU-173).",
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
      "Gated real-bytes test (`expression_real_sweetie_hd_first_command_args`) wired for UTSUSHI-208 follow-up",
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
      "Define typed banks `intA`-`intZ` (13 letters per RLDEV; rlvm caps each at 2,000), `strS`/`strM`/`strK`, and a u32 store register. Expose `get(bank, idx) -> Value`, `set(bank, idx, value)`, and a `Snapshot` / `Restore` impl wired to the substrate `Inspectable`/`Restorable` traits so VM state snapshots flow through UTSUSHI-023 unchanged.",
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

  // ---- VM execution layer ----------------------------------------------
  {
    suffix: "i",
    title: "Bytecode VM (fetch / decode / dispatch / advance)",
    summary: `Implement \`Vm { scene, pc, stack, banks, store_reg, longop_queue }\` with fetch/decode/dispatch/advance loop. Dispatch hooks call into per-module RLOperation tables (separate nodes below). Snapshot/restore round-trips paused longops through the substrate facade. ${SUBSTRATE_GAP_NOTE}`,
    deliverables: [
      "`Vm { scene, pc, stack, banks, store_reg, longop_queue }` runtime with fetch/decode/dispatch/advance loop",
      "`max_steps` deterministic out-of-budget terminator (no panic on infinite goto loop)",
      "`gosub`/`ret` and cross-scene `farcall`/`rtl` stack-frame handling",
      "Longop yield/resume + snapshot-at-suspend round trip through `SnapshotStore`",
      "Sweetie HD scene #0001 step-until-Unimplemented harness",
    ],
    acceptanceCriteria: [
      "Stepping the VM on a synthetic scene `goto +0` infinite loop with a `max_steps=100` terminator produces a deterministic `out_of_budget` outcome (no panic).",
      "A `gosub` followed by `ret` returns the pc to the post-`gosub` byte.",
      "A `farcall` (cross-scene) followed by `rtl` returns to the calling scene at the post-`farcall` byte.",
      "Longop yields (synthetic `pause` longop) suspend the VM; the next `step` call resumes from the paused state, and a snapshot taken at the suspend point restores into the same longop with the same private state.",
      "End-to-end: stepping Sweetie HD scene #0001 emits at least one `CommandElement` dispatch (the first command of the prologue) before hitting an `Unimplemented` opcode boundary — proves the VM can drive a real scene up to the opcode coverage frontier.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive vm_synthetic_goto_loop"],
      ["command", "cargo test -p utsushi-reallive vm_gosub_ret_returns"],
      ["command", "cargo test -p utsushi-reallive vm_steps_scene1_until_unimplemented"],
    ],
    auditFocus: [
      "Longop scheduler being a placeholder enum that never fires",
      "`step` advancing the pc by a constant instead of by the element's byte length",
      "Gosub/ret stack mishandling on cross-scene jumps",
    ],
    dependsOnProposal: ["e", "f", "g"],
  },

  {
    suffix: "j",
    title: "Text / messaging RLOperation family (module_msg subset)",
    summary:
      "Implement the text/messaging opcodes (module_msg equivalent): `text` (textout element), `pause`, `par`, `br`, `page`, `msgHide`, `msgHideAll`, `msgClear`, `FontColor`, `FontSize`, `TextWindow`, `FastText`, `NormalText`, `FaceOpen`, `FaceClose`. Target: ~15 opcodes of the ~35 in rlvm's module_msg. Speaker resolution through the `NAMAE` Gameexe table.",
    deliverables: [
      "Implementation of ~15 module_msg opcodes through the substrate `TextSurfaceSink`",
      "`TextLine` emission with speaker (from `intA`/`intB` per RealLive convention) and Shift-JIS-decoded body",
      "Synthetic `[textout 'こんにちは'] [pause]` -> one `TextLine` + idle smoke",
      "Sweetie HD scene #0001 first-textout match (gated on UTSUSHI-203/204/208)",
      "`utsushi.reallive.unimplemented_opcode` Warning for the ~20 unimplemented opcodes (carries module_type, module_id, opcode)",
    ],
    acceptanceCriteria: [
      "Each implemented opcode emits exactly one `TextLine` / `TextSurfaceEvent` through the substrate `TextSurfaceSink`, with the speaker name (from `intA` / `intB` per RealLive convention) and Shift-JIS-decoded body.",
      'A synthetic scene `[textout "こんにちは"] [pause]` produces one `TextLine { speaker: "", body: "こんにちは" }` followed by an idle state until the next input event.',
      "The decoded text matches the Shift-JIS round-trip exactly (no UTF-8 drift).",
      "Unimplemented opcodes in this module emit `utsushi.reallive.unimplemented_opcode` Warning carrying `module_type`, `module_id`, `opcode` — and the VM advances past them without aborting.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive msg_text_emits_textline"],
      ["command", "cargo test -p utsushi-reallive msg_pause_yields_until_input"],
      [
        "command",
        "cargo test -p utsushi-reallive msg_scene1_first_textout_matches_shift_jis_decoded",
      ],
    ],
    auditFocus: [
      "TextLine emission shape (must use existing facade type, not a new one)",
      "Decoded body being lossy",
      "Speaker name not resolved through `NAMAE` table",
    ],
    dependsOnProposal: ["i"],
  },

  {
    suffix: "k",
    title: "Control-flow RLOperation family (`goto`/`gosub`/`farcall`/`ret`/`rtl` subset)",
    summary:
      "Control-flow opcodes: `goto`, `goto_if`, `goto_unless`, `goto_on`, `goto_case`, `gosub`, `gosub_if`, `gosub_unless`, `gosub_on`, `gosub_with`, `ret`, `ret_with`, `rtl`, `rtl_with`, `jump`, `farcall`, `farcall_with`. Target: 17 of rlvm's 22. Exposes `farcall` for the system-call dispatch node to consume.",
    deliverables: [
      "Implementation of 17 control-flow opcodes covering conditional + indexed + case + gosub_with + farcall variants",
      "Parameter stack-frame push/pop for `gosub_with` and `ret_with`",
      "Cross-scene `farcall` validated against `RealSceneIndex` scene entries",
      "Default-sink semantics for `goto_case` (fallthrough, not Fatal)",
      "`farcall(9999, 10)` smoke against Sweetie HD scene 9999 entrypoint layout",
    ],
    acceptanceCriteria: [
      "`goto_if($intA[0] == 1, label)`: with `intA[0]=1`, pc advances to label; with `intA[0]=0`, pc advances to next element.",
      "`goto_on($intA[0], [l0, l1, l2, l3])`: with `intA[0]=2`, pc advances to `l2`.",
      "`goto_case($intA[0], [(1, l1), (5, l5)])`: with `intA[0]=5`, pc advances to `l5`; with `intA[0]=99`, pc advances past the `goto_case` (default sink).",
      "`gosub_with(label, $intA[0])`: pushes a stack frame whose parameter slot 0 = current intA[0]; the called scene's expressions can read that parameter; `ret_with(...)` propagates the return value back into the caller's store register.",
      "`farcall(scene_id, entrypoint)`: cross-scene jump with proper stack-frame push for `rtl` return; targets must be valid scene entries in the `RealSceneIndex`.",
      "System-call entry into Sweetie HD scene 9999 via the `CANCELCALL=9999,10` route works once UTSUSHI-212 (system-call dispatch) is in place; this node just exposes `farcall` for UTSUSHI-212 to call.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive ctl_goto_if_branches"],
      ["command", "cargo test -p utsushi-reallive ctl_gosub_with_parameter_passing"],
      ["command", "cargo test -p utsushi-reallive ctl_farcall_scene9999_entrypoint10"],
    ],
    auditFocus: [
      "Off-by-one on entrypoint-table indexing",
      "Missing parameter-stack cleanup on `ret_with`",
      "Treating `goto_case` default as a fatal instead of a fallthrough",
    ],
    dependsOnProposal: ["i"],
  },

  {
    suffix: "l",
    title: "Choice family (`select` / `select_s` / `select_w` / `select_objbtn`)",
    summary: `Implement \`select\`, \`select_s\`, \`select_w\`, \`select_objbtn\`. The choice mechanism is a longop: it suspends the VM, emits one \`TextLine\` per option (annotated as a choice), waits for an \`InputEvent::ChoiceMade(ChoiceIndex)\`, then resumes by writing the index into the store register. Honours \`SELBTN.NNN.*\` styling from Gameexe. ${SUBSTRATE_GAP_NOTE}`,
    deliverables: [
      "`select` / `select_s` / `select_w` / `select_objbtn` longop implementations using the substrate scheduler",
      "Choice-kind `TextLine` emission per option through `TextSurfaceSink`",
      "`InputEvent::ChoiceMade(ChoiceIndex)` resume path writing the index to store_reg",
      "`SELBTN.NNN.*` Gameexe styling honoured on rendered choice text",
      "First-choice-scene smoke against Sweetie HD Seen.txt (discoverable post-UTSUSHI-203/204)",
    ],
    acceptanceCriteria: [
      'A synthetic scene with `select_s ["a", "b", "c"]` emits 3 `TextLine` events of `kind = Choice` (existing substrate type), then suspends.',
      "Feeding `ChoiceIndex(1)` resumes; store register reads as 1; pc advances past the choice element.",
      "Sweetie HD's first `select`/`select_s` in scene #0001 (location TBD — will be the first 0x23-opener element with module_id matching sel-module dispatch in the real bytecode) decodes its choice strings correctly. (If scene #0001 doesn't have a choice, this node's real-bytes test targets the first scene that does — discoverable once UTSUSHI-203/204 land.)",
      "Choice strings honour `SELBTN.NNN.*` styling values from Gameexe.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive choice_select_s_emits_three_options"],
      ["command", "cargo test -p utsushi-reallive choice_resume_writes_store_reg"],
    ],
    auditFocus: [
      "Longop coupling — the longop must use the substrate scheduler, not a private wait loop",
    ],
    dependsOnProposal: ["i", "h", "j"],
  },

  {
    suffix: "m",
    title: "String / memory / system-arithmetic RLOperation families",
    summary:
      "Implement string ops (`strcpy`, `strcat`, `strlen`, `Uppercase`, `Lowercase`, `itoa`, `atoi`, `strout`, `intout`, `strpos`, `strlpos`, `hantozen`, `zentohan`), memory ops (`setarray`, `setrng`, `cpyrng`, `setarray_stepped`, `setrng_stepped`, `cpyvars`, `sum`, `sums`), system arithmetic (`rnd`, `pcnt`, `abs`, `power`, `sin`, `cos`, `min`, `max`, `constrain`). Target: ~24 of the ~70 across rlvm's module_str + module_mem + module_sys arithmetic subset.",
    deliverables: [
      "~24 opcodes implemented across string, memory, and system-arithmetic modules",
      "Per-op input/output table (≥3 cases incl. boundary) wired as unit tests",
      "Deterministic `rnd` seeded from substrate `LogicalClock` with `SnapshotStore` round-trip of rng state",
      "Shift-JIS half/full-width conversions (`hantozen`, `zentohan`) verified",
      "Sparse memory-range setters (`setrng_stepped`, `setarray_stepped`) covered with step + bound cases",
    ],
    acceptanceCriteria: [
      "Each op: input/output table with at least 3 cases including a boundary (empty string, zero-size range, max u16 index).",
      "`rnd` is deterministic when the substrate `LogicalClock` is fixed; snapshot/restore of the rng state round-trips through `SnapshotStore`.",
      'Shift-JIS handling: `Uppercase("ＡＢＣ")` returns `"ＡＢＣ"` (already upper); `hantozen("abc")` returns `"ａｂｃ"` (full-width); these are the documented half/full conversions per RLDEV.',
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive str_ops_table"],
      ["command", "cargo test -p utsushi-reallive mem_setarray_stepped_table"],
      ["command", "cargo test -p utsushi-reallive sys_rnd_deterministic_under_logical_clock"],
    ],
    auditFocus: [
      "`rnd` reading from the OS rng instead of substrate clock-seeded rng",
      "Encoding conversions silently dropping half-width katakana",
    ],
    dependsOnProposal: ["g"],
  },

  // ---- Subsystem layer -------------------------------------------------
  {
    suffix: "n",
    title: "System-call dispatch wired to Gameexe routes",
    summary:
      "Wire the eight Gameexe-declared system-call routes (`CANCELCALL`, `SYSTEMCALL_SAVE`/`LOAD`/`SYSTEM`, `MOUSEACTIONCALL.000`, `LOADCALL`, `EXAFTERCALL`, `WBCALL.000`-`007`) into the VM event loop. Each route is a `farcall(scene_id, entrypoint)` from the control-flow node triggered by the matching substrate `InputEvent` kind.",
    deliverables: [
      "Eight system-call routes wired into the VM event loop as `farcall(scene_id, entrypoint)` invocations",
      "Pointer hot-region dispatch (`MOUSEACTIONCALL.000.AREA`) via `InputEvent` match",
      "`_MOD` flag handling (e.g. `CANCELCALL_MOD=0` disables the cancel route)",
      "Sweetie HD route smoke against `Gameexe.ini` lines 14-28",
      "No private dispatch path — all routes call into UTSUSHI-211's `farcall`",
    ],
    acceptanceCriteria: [
      "Boot with Sweetie HD's `Gameexe.ini` loaded; the dispatcher reports 8 known routes with the documented (scene_id, entrypoint) pairs from `docs/research/reallive-engine.md` § H.",
      "`MOUSEACTIONCALL.000.AREA=1232,0,1279,719`: a pointer-move event with `(x=1250, y=300)` triggers the route; a pointer-move with `(x=100, y=100)` does not.",
      "`CANCELCALL_MOD=0` disables the cancel route entirely (mods interpreted per RLDEV).",
      "Routes call into UTSUSHI-211's `farcall` — no private dispatch path.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive syscall_routes_match_sweetie_hd"],
      ["command", "cargo test -p utsushi-reallive mouseactioncall_hot_region_dispatches"],
    ],
    auditFocus: [
      "Routes that say 'TODO' in unit tests but pretend to pass",
      "Failing to wire `_MOD` flags",
    ],
    dependsOnProposal: ["h", "k"],
  },

  {
    suffix: "o",
    title: "Graphics object stack (headless render pipeline)",
    summary: `Implement the rlvm \`GraphicsSystem\` equivalent: a stack of ~256 graphics objects (foreground + background planes), each with \`(position, scale, alpha, colour_tone, image_ref, layer_order)\` state, plus a render-pass that walks the stack and rasterises a per-frame \`FrameArtifact\` into the substrate artifact store. Deterministic PNG output. ${SUBSTRATE_GAP_NOTE}`,
    deliverables: [
      "~256-slot graphics object stack (foreground + background planes) with full per-object state",
      "Render-pass walking the stack into a `FrameArtifact` through the substrate `FrameArtifactSink`",
      "Deterministic-PNG output (no timestamp metadata; byte-identical across runs)",
      "`SCREENSIZE_MOD=999,1280,720` Gameexe-observed framebuffer dimensions",
      "Wipe object (full-screen colour) smoke producing a solid-colour PNG",
      "`FrameArtifact` carries `frame_index`, `evidence_tier=E1`, and a real PNG `artifact_id`",
    ],
    acceptanceCriteria: [
      "Allocating 256 objects, setting positions, calling render → deterministic PNG bytes (same input → same output bytes including PNG metadata).",
      "Two render passes with the same state produce byte-identical PNGs.",
      "The render pass observes the `SCREENSIZE_MOD=999,1280,720` Gameexe value and emits a 1280x720 buffer.",
      "A 'wipe' object (full-screen colour) renders to a solid-colour PNG matching the documented colour byte order.",
      "The frame artifact carries `frame_index`, `evidence_tier=E1`, and an `artifact_id` resolving to a PNG blob.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive graphics_object_stack_256_objects"],
      ["command", "cargo test -p utsushi-reallive render_wipe_solid_colour_deterministic_png"],
    ],
    auditFocus: [
      "Non-deterministic PNG output (timestamp metadata)",
      "The artifact store being a stub `Vec` that doesn't actually retain bytes",
    ],
    dependsOnProposal: ["a", "h"],
  },

  {
    suffix: "p",
    title: "Graphics RLOperation family (module_grp + module_obj subset)",
    summary:
      "Implement the rlvm module_grp + module_obj_management + module_obj_fg_bg subset: `allocDC`, `wipe`, `shake`, `load`/`open`/`openBg`, `copy`/`fill`/`invert`/`mono`/`colour`/`light`, `fade`, `stretchBlit`/`zoom`, `objAlloc`/`objFree`/`objInit`/`objCopy`, per-object setters `objSetPos`, `objSetAlpha`, `objSetScale`, `objSetLayer`, `objShow`/`objHide`. Target: ~25 opcodes of the ~150 across rlvm's module_grp + module_obj_*.",
    deliverables: [
      "~25 graphics opcodes wired to the graphics object stack with observable mutations through `state_snapshot`",
      '`openBg("BG01A1")` flow: VFS read + g00 decode (UTSUSHI-217) + bg plane registration',
      "`fade(target_alpha, ms)` longop ticking the bg plane alpha across substrate clock ticks",
      "Gated real-bytes test against Sweetie HD `BG01A1.g00` (depends on UTSUSHI-217 landing)",
      "Layer-ordering honoured (`objSetLayer` actually re-orders render-pass output)",
    ],
    acceptanceCriteria: [
      "Each opcode produces an observable mutation of UTSUSHI-213's graphics object stack visible via a `state_snapshot` API.",
      '`openBg("BG01A1")` reads `$GAME/REALLIVEDATA/g00/BG01A1.g00` via the substrate VFS and registers it as the bg plane background; the next render emits a 1280x720 PNG whose top-left pixel matches the documented bg colour (after g00 type-0 decode lands in UTSUSHI-217).',
      "`fade(target_alpha, ms)` schedules a longop that mutates the bg plane's alpha over `ms / clock_tick_period` ticks.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive grp_openbg_bg01a1_registers_bg_plane"],
    ],
    auditFocus: [
      "Opcodes that mutate state but never produce a visible effect (stack updates that don't render)",
      "Layer-ordering that ignores `objSetLayer`",
    ],
    dependsOnProposal: ["o", "q"],
  },

  {
    suffix: "q",
    title: "g00 image decoder (types 0 / 1 / 2)",
    summary:
      "Decode the three g00 sub-formats: type 0 (raw 24-bpp BGR), type 1 (8-bpp paletted + LZSS), type 2 (24-bpp + region list + LZSS). Output is a `(width, height, pixels_rgba: Vec<u8>, regions: Vec<G00Region>)`. Verifies against Sweetie HD `BACK.g00`, `BG01A1.g00`, and a 2,450-file corpus histogram.",
    deliverables: [
      "Decoders for g00 types 0, 1, and 2 with shared LZSS distance-encoding",
      "BGR -> RGBA pixel reorder",
      "Type 2 region list exposed as `Vec<G00Region { rect, name? }>` for `objLoadRegion`",
      "Sweetie HD `BACK.g00` type-0 decode pinned (width/height + first-pixel BGR order)",
      "2,450-file corpus histogram (type 0/1/2/unknown distribution) + `utsushi.reallive.g00_no_type_N_in_corpus` Warning",
    ],
    acceptanceCriteria: [
      "For Sweetie HD's `$GAME/REALLIVEDATA/g00/BACK.g00` (type 0): decoded width is non-zero, decoded `pixels_rgba.len()` matches `width * height * 4`, and the first pixel matches the documented BGR byte order from the file header.",
      "A directory-wide histogram pass reports the lead-byte distribution across all 2,450 `.g00` files (counts of type 0 / 1 / 2 / unknown). The acceptance criterion requires types 0, 1, and 2 are each decoded for at least one Sweetie HD file (if the corpus contains that type) — emit `utsushi.reallive.g00_no_type_N_in_corpus` for types not present.",
      "Type 2 decoded files expose a `regions: Vec<G00Region { rect, name? }>` list usable by `objLoadRegion` in UTSUSHI-214.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive g00_type0_back_decodes"],
      ["command", "cargo test -p utsushi-reallive g00_corpus_histogram_sweetie_hd_2450_files"],
    ],
    auditFocus: [
      "Treating 'BGR' as 'RGB' silently",
      "LZSS distance encoding regression that decodes a few bytes and then garbage",
      "Region table off-by-one against type 2 sub-bitmap counts",
    ],
    dependsOnProposal: ["a"],
  },

  {
    suffix: "r",
    title: "Audio system: NWA + OVK decoders + AudioEvent emitter",
    summary: `Implement NWA decoder (raw PCM + run-length variants), OVK decoder (16-byte header entries + Ogg Vorbis sample passthrough), and RLOperations \`bgmPlay\`, \`bgmStop\`, \`bgmFadeOut\`, \`koePlay\`, \`koeStop\`, \`wavPlay\`, \`wavStop\`, \`playSe\`. Target: ~15 of rlvm's ~60 across module_bgm + module_koe + module_pcm + module_se. ${SUBSTRATE_GAP_NOTE}`,
    deliverables: [
      "NWA decoder (raw PCM + RLE variants) verified against Sweetie HD `ASA.nwa`",
      "OVK decoder (16-byte header entries, Ogg Vorbis passthrough) verified against `z0001.ovk`",
      "~15 audio RLOperations (bgm/koe/wav/se) emitting `AudioEvent` through the substrate sink",
      "`koePlay` resolution through the `NAMAE` speaker table to `(archive_id, sample_id)` metadata",
      "`bgmPlay` resolution through `FOLDNAME.BGM` to the on-disk NWA path",
    ],
    acceptanceCriteria: [
      "NWA: against `$GAME/REALLIVEDATA/bgm/ASA.nwa` (18,317,046 bytes, raw 16-bit PCM), decoder returns 33,818,820 sample frames at 44,100 Hz, 16-bit, 2-channel.",
      "OVK: against `$GAME/REALLIVEDATA/koe/z0001.ovk`, decoder returns 2 entries with `(sample_num=46, length=36)` and `(sample_num=52, length=183,476)`. The first sample's raw bytes start with `OggS` magic.",
      '`koePlay($intA[0]=46)` resolves through the speaker table to `z0001.ovk sample 46` and emits `AudioEvent { kind: VoicePlay, archive_id: "z0001", sample_id: 46, evidence_tier: E1 }`.',
      '`bgmPlay("ASA")` resolves through `Gameexe FOLDNAME.BGM` to `$GAME/REALLIVEDATA/bgm/ASA.nwa` and emits `AudioEvent { kind: BgmStart, asset_id: "bgm/ASA", evidence_tier: E1 }`.',
      "No actual sample mixing required; the decoder just verifies header decode and emits metadata.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive nwa_asa_decodes_33M_frames"],
      ["command", "cargo test -p utsushi-reallive ovk_z0001_two_entries"],
      ["command", "cargo test -p utsushi-reallive koe_play_resolves_through_namae_table"],
    ],
    auditFocus: [
      "Treating NWA as raw bytes (i.e. skipping the offset table)",
      "OVK entry size as anything other than 16 bytes",
      "AudioEvent payload missing voice-archive metadata",
    ],
    dependsOnProposal: ["h", "i"],
  },

  {
    suffix: "s",
    title: "Save / load (AVG-derived format: REALLIVE.sav / save999.sav / read.sav)",
    summary:
      "Implement read + write of `REALLIVE.sav` (per-slot system save), `save999.sav` (global save), `read.sav` (per-line read flags). Format follows the AVG32-derived `SAVE_FORMAT=3` Gameexe declaration. Substrate `SnapshotStore` is the in-memory backing; on-disk serialiser is separate.",
    deliverables: [
      "`SystemSave`, `GlobalSave`, `ReadFlags` typed readers/writers",
      "AVG-derived `SAVE_FORMAT=3` serialiser keyed against magic strings (`AVG_SYSTEM_SAVE`, `AVG_GLOBAL_SAVE`)",
      "Shift-JIS title decode (`オシオキSweetie＋Sweets!! HD Edition\\u{8140}`) round-trip",
      "Synthetic round-trip producing byte-identical output",
      "Read-only mount enforcement (writes to the research mount banned at the test layer)",
    ],
    acceptanceCriteria: [
      'Reading `$GAME/SAVEDATA/REALLIVE.sav` produces a `SystemSave { magic: "AVG_SYSTEM_SAVE", slots: [...] }` with the declared file-size (24,876) cross-checked against the `2C 61 00 00` leading u32.',
      'Reading `$GAME/SAVEDATA/save999.sav` produces a `GlobalSave { magic: "AVG_GLOBAL_SAVE", ... }`.',
      'Reading `$GAME/SAVEDATA/read.sav` produces a `ReadFlags { title: "オシオキSweetie＋Sweets!! HD Edition\\u{8140}", ... }` (the Shift-JIS title decodes round-trip).',
      "Writing a freshly-snapshotted save produces byte-identical output to a known synthetic fixture (round-trip).",
      "The substrate `SnapshotStore` is used as the in-memory backing for save state; on-disk write is a separate serialiser.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive save_reads_avg_system_save"],
      ["command", "cargo test -p utsushi-reallive save_reads_avg_global_save"],
      ["command", "cargo test -p utsushi-reallive save_read_flags_decodes_title"],
    ],
    auditFocus: [
      "Writing to the read-only research mount (must be banned at the test layer)",
      "Endianness flips between read and write",
      "Silently truncating slots",
    ],
    dependsOnProposal: ["g", "h"],
  },

  // ---- Game-state-machine + replay layer -------------------------------
  {
    suffix: "t",
    title: "Sukara title XOR-2 key resolution (research-only)",
    summary:
      "Determine whether Sweetie HD's compiler-version-110002 bytecode uses the AVG32 second-level XOR pass, and if so, recover the key. Research-only node — no code changes if the key is off; one constant + documentation if it's recoverable. Either outcome acceptable; what is not is shipping UTSUSHI-203 with a hardcoded 'Key 09' guess and pretending it's Sukara's.",
    deliverables: [
      "Bench tool under `crates/utsushi-reallive/benches/` decompressing scene #0001 with no XOR-2 and reporting byte statistics",
      "Entropy + lead-byte distribution analysis against the documented opener set",
      "Known-bytes attack scaffold (if entropy random) seeded by MetaElement opener at offset 0",
      "`docs/research/reallive-engine.md` update recording the resolved finding (key off OR key + value OR follow-up path)",
      "Shipped `xor_2_key = None` constant when the title family is confirmed key-off",
    ],
    acceptanceCriteria: [
      "A bench tool (under `crates/utsushi-reallive/benches/`) decompresses Sweetie HD scene #0001 with no XOR-2 pass and reports byte statistics of the first 64 bytes (entropy, lead-byte distribution against the documented `{0x00, 0x0a, 0x21, 0x23, 0x24, 0x2c, 0x40}` + Shift-JIS leads).",
      "If the entropy is structured (key off), the node ships with `xor_2_key = None` for the Sukara title family and `docs/research/reallive-engine.md` is updated to record the finding.",
      "If the entropy is random (key on), the node ships with a known-bytes attack (RealLive scenes always start with a MetaElement opener byte `0x21` or `0x40` at offset 0 of the bytecode) and either recovers the key or documents the recovery path for a follow-up node.",
      "Either outcome is acceptable; what is not acceptable is shipping UTSUSHI-203 with a hardcoded 'Key 09' guess and pretending it's Sukara's.",
    ],
    verification: [["command", "cargo bench -p utsushi-reallive sukara_xor2_entropy_scan"]],
    auditFocus: [
      "Silent acceptance of garbage decompressed bytes",
      "Using a Visual-Arts title key on a Sukara title",
    ],
    dependsOnProposal: ["d"],
  },

  {
    suffix: "u",
    title: "End-to-end Sweetie HD scene-1 text-replay smoke",
    summary:
      "Drive Sweetie HD scene #0001 through the VM until either (a) the first `pause` opcode fires producing a `TextLine` capture through the substrate `TextSurfaceSink`, or (b) an unimplemented opcode trips a documented diagnostic. Byte-deterministic `ReplayLog` JSON across two runs; snapshot/restore identity at any tick boundary.",
    deliverables: [
      "`utsushi-reallive::replay_scene(seen_path, 1)` driver function",
      "`ReplayLog` JSON capturing TextLine events + diagnostics, byte-deterministic across runs",
      "Snapshot-at-tick-boundary + restore-into-identical-state round trip",
      "Warning-not-Fatal posture for unimplemented opcodes so the smoke reaches first textout",
      "Sweetie HD scene #0001 end-to-end smoke producing at least one non-empty Shift-JIS `TextLine`",
    ],
    acceptanceCriteria: [
      "Running `utsushi-reallive::replay_scene(seen_path, 1)` against `$GAME/REALLIVEDATA/Seen.txt` produces a `ReplayLog` with at least one `TextLine` event whose body is non-empty Shift-JIS text.",
      "The replay is byte-deterministic: two runs produce identical `ReplayLog` JSON.",
      "The same replay can be snapshotted at any tick boundary and restored to identical state.",
      "Unimplemented opcodes emit Warnings (not Fatals) so the run reaches 'first textual output' before any unknown stops it.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive replay_scene1_emits_textline"],
      ["command", "cargo test -p utsushi-reallive replay_scene1_byte_deterministic"],
      ["command", "cargo test -p utsushi-reallive replay_scene1_snapshot_restore_identity"],
    ],
    auditFocus: [
      "The test passing because the VM happens to halt on a Warning before producing any output",
      "'Deterministic' actually being flaky and hidden by retry",
      "Snapshot-restore being a no-op",
    ],
    dependsOnProposal: [
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
      "n",
      "o",
      "p",
      "q",
      "r",
      "s",
      "t",
    ],
  },

  {
    suffix: "v",
    title: "Cross-engine substrate conformance + Siglus lineage notes",
    summary:
      "Tie the RealLive port into UTSUSHI-147's cross-engine conformance fixture. Document which sub-nodes of the decomposition will be reusable when the Siglus port lands (the AVG32 -> RealLive -> Siglus lineage Visual Arts documents). Boundary-aware: 'reusable' claims must be proven against a Siglus prototype rather than asserted.",
    deliverables: [
      "Cross-engine facade-only-imports conformance test reusing UTSUSHI-147's fixture",
      "Appendix in `docs/research/reallive-engine.md` documenting reusable vs RealLive-only surfaces (expression encoding, bank model, AVG32 LZ+XOR, Gameexe-style config vs rlvm-specific opcode catalogue, OVK voice archives, module identifiers)",
      "Engine-specific boundary notes wherever an acceptance criterion would break under a Siglus reuse claim",
      "Identical-import audit between RealLive scaffold and Siglus minimal-port scaffold",
    ],
    acceptanceCriteria: [
      "UTSUSHI-200..UTSUSHI-220's facade usage is confirmed identical to a Siglus minimal-port scaffold (only `utsushi_core::substrate::*` imports; no engine-specific facade exceptions).",
      "Lineage notes in `docs/research/reallive-engine.md` (new appendix) document: reusable across engines (expression encoding, variable banks — Siglus uses 26 letters not 13 but the trait carries, AVG32 LZ + XOR, Gameexe-style config — Siglus uses Resource.txt but dotted-path tree generalises, headless sink pipeline, snapshot/restore contract); RealLive-only (rlvm-specific opcode catalogue, OVK voice archives — Siglus uses different containers, specific module identifiers).",
      "Any UTSUSHI-200..UTSUSHI-220 node whose acceptance criterion would break under a Siglus reuse claim emits a documented 'engine-specific boundary' note instead of pretending portability.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-reallive cross_engine_facade_only_imports"],
      ["command", "just check"],
    ],
    auditFocus: [
      "'Reusable' claims that haven't been proven against a Siglus prototype",
      "Lineage notes that just repeat marketing instead of documenting actual code reuse points",
    ],
    dependsOnProposal: ["u"],
  },
];

// ---------------------------------------------------------------------------
// Build node objects and apply mutations.
// ---------------------------------------------------------------------------

function buildNode(spec) {
  const id = mapProposalIdToDagId(spec.suffix);
  const dependsOnFromProposal = (spec.dependsOnProposal ?? []).map(mapProposalIdToDagId);
  const extraDeps = spec.extraDeps ?? [];
  const dependsOn = [...new Set([...dependsOnFromProposal, ...extraDeps])];
  const verification = spec.verification.map(([type, value]) => ({ type, value }));
  return {
    id,
    title: spec.title,
    status: COMMON.status,
    priority: priorityFor(id),
    target: targetFor(id),
    projects: COMMON.projects,
    parallelGroup: COMMON.parallelGroup,
    dependsOn,
    summary: spec.summary,
    deliverables: spec.deliverables,
    acceptanceCriteria: spec.acceptanceCriteria,
    verification,
    auditFocus: spec.auditFocus,
  };
}

function applyDecomposition(dag) {
  const nodes = dag.nodes;
  const oldIdx = nodes.findIndex((n) => n.id === "UTSUSHI-146");
  if (oldIdx === -1) throw new Error("UTSUSHI-146 not found in DAG");

  const oldNode = nodes[oldIdx];
  if (oldNode.status === "cancelled") {
    throw new Error("UTSUSHI-146 already cancelled — refusing to re-apply decomposition");
  }

  // Marks UTSUSHI-146 cancelled, points the summary at the decomposition, and
  // attaches the required statusReason. Drops the alpha target so the cancelled
  // shell does not re-flag the alpha-readiness gate (the alpha claim is carried
  // by UTSUSHI-200 — the crate skeleton — per docs/audits/alpha-scope-honesty.md
  // §D). Other fields (priority, projects, parallelGroup, deliverables,
  // acceptanceCriteria, verification, auditFocus) stay.
  oldNode.status = "cancelled";
  oldNode.target = "continuous";
  oldNode.statusReason =
    "Decomposed into UTSUSHI-200..UTSUSHI-221 per docs/research/reallive-engine-dag-proposal.md; per docs/audits/alpha-scope-honesty.md §D + docs/alpha-localization-project-readiness.md, only the crate-skeleton (UTSUSHI-200) retains target=alpha. End-to-end scene-1 replay (originally UTSUSHI-146) lands as UTSUSHI-219.";
  oldNode.summary =
    "Superseded by the 22-node decomposition in docs/research/reallive-engine-dag-proposal.md (UTSUSHI-200..UTSUSHI-221). Original scope split into: foundation (utsushi-reallive crate skeleton, Seen.txt directory parser, scene header, LZ+XOR decompressor, element-stream decoder, expression evaluator, variable banks); Gameexe parser; VM (fetch/decode/dispatch, control flow, text/messaging, choice, string/memory/arithmetic); subsystems (syscall dispatch, graphics stack, graphics RLOps, g00 decoder, audio, save/load); game-state-machine (XOR-2 key research, end-to-end scene-1 smoke, cross-engine conformance). The original 'rlvm referenced only as research anchor, never invoked as a binary' acceptance criterion propagates to every sub-node.";

  // Build the 22 new nodes and insert directly after UTSUSHI-146.
  const newNodes = NODE_SPECS.map(buildNode);

  // Sanity-check: every node has the minimum required content.
  for (const node of newNodes) {
    if (!node.acceptanceCriteria?.length) {
      throw new Error(`${node.id} missing acceptanceCriteria`);
    }
    if (!node.deliverables?.length) {
      throw new Error(`${node.id} missing deliverables`);
    }
    if (!node.verification?.length) {
      throw new Error(`${node.id} missing verification`);
    }
    if (!node.auditFocus?.length) {
      throw new Error(`${node.id} missing auditFocus`);
    }
  }

  nodes.splice(oldIdx + 1, 0, ...newNodes);

  // Rewrite stale `UTSUSHI-146` dependsOn entries in callers. Both current
  // callers (ALPHA-006, UTSUSHI-147) are target=alpha, and the schema
  // enforces target ordering (alpha cannot depend on continuous). The honest
  // route therefore points each caller at UTSUSHI-200 — the only alpha
  // sub-node and the explicit alpha claim per docs/audits/alpha-scope-honesty.md
  // §D + docs/alpha-localization-project-readiness.md redefinition. The
  // end-to-end smoke (UTSUSHI-219) and cross-engine conformance (UTSUSHI-221)
  // are continuous follow-ups, not alpha gates.
  const rewrites = [];
  for (const node of nodes) {
    if (node.id === "UTSUSHI-146") continue;
    if (!node.dependsOn?.includes("UTSUSHI-146")) continue;
    node.dependsOn = node.dependsOn.map((dep) => (dep === "UTSUSHI-146" ? "UTSUSHI-200" : dep));
    rewrites.push(node.id);
  }

  return {
    addedCount: newNodes.length,
    addedIds: newNodes.map((n) => n.id),
    rewrittenCallers: rewrites,
  };
}

// ---------------------------------------------------------------------------

function main() {
  const schema = loadJson(schemaPath);
  const dag = loadJson(dagPath);

  validateAgainstSchema(dag, schema, "pre-mutation");

  const result = applyDecomposition(dag);

  validateAgainstSchema(dag, schema, "post-mutation");

  writeFileSync(dagPath, `${JSON.stringify(dag, null, 2)}\n`);

  process.stdout.write(
    `applied UTSUSHI-146 decomposition: ${result.addedCount} new nodes (${result.addedIds[0]}..${result.addedIds.at(-1)}), UTSUSHI-146 marked cancelled, rewrote stale callers ${JSON.stringify(result.rewrittenCallers)}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`apply-utsushi-146-decomposition failed: ${error.message}\n`);
  process.exit(1);
}
