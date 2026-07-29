// Node specifications for the VM execution layer.

export const SUBSTRATE_GAP_NOTE =
  "[substrate-gap: requires substrate extension — see docs/research/reallive-engine-dag-proposal.md substrate-gap callouts]";

export const NODE_SPECS_RUNTIME = [
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
      "Sweetie HD scene #0001 first-textout match (gated on capability_utsushi_203/204/208)",
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
      "System-call entry into Sweetie HD scene 9999 via the `CANCELCALL=9999,10` route works once capability_utsushi_212 (system-call dispatch) is in place; this node just exposes `farcall` for capability_utsushi_212 to call.",
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
      "First-choice-scene smoke against Sweetie HD Seen.txt (discoverable post-capability_utsushi_203/204)",
    ],
    acceptanceCriteria: [
      'A synthetic scene with `select_s ["a", "b", "c"]` emits 3 `TextLine` events of `kind = Choice` (existing substrate type), then suspends.',
      "Feeding `ChoiceIndex(1)` resumes; store register reads as 1; pc advances past the choice element.",
      "Sweetie HD's first `select`/`select_s` in scene #0001 (location TBD — will be the first 0x23-opener element with module_id matching sel-module dispatch in the real bytecode) decodes its choice strings correctly. (If scene #0001 doesn't have a choice, this node's real-bytes test targets the first scene that does — discoverable once capability_utsushi_203/204 land.)",
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
];
