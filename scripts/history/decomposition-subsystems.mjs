import { SUBSTRATE_GAP_NOTE } from "./decomposition-runtime.mjs";

// Node specifications for the subsystem and replay layers.

export const NODE_SPECS_SUBSYSTEMS = [
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
      "No private dispatch path — all routes call into capability_utsushi_211's `farcall`",
    ],
    acceptanceCriteria: [
      "Boot with Sweetie HD's `Gameexe.ini` loaded; the dispatcher reports 8 known routes with the documented (scene_id, entrypoint) pairs from `docs/research/reallive-engine.md` § H.",
      "`MOUSEACTIONCALL.000.AREA=1232,0,1279,719`: a pointer-move event with `(x=1250, y=300)` triggers the route; a pointer-move with `(x=100, y=100)` does not.",
      "`CANCELCALL_MOD=0` disables the cancel route entirely (mods interpreted per RLDEV).",
      "Routes call into capability_utsushi_211's `farcall` — no private dispatch path.",
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
      '`openBg("BG01A1")` flow: VFS read + g00 decode (capability_utsushi_217) + bg plane registration',
      "`fade(target_alpha, ms)` longop ticking the bg plane alpha across substrate clock ticks",
      "Gated real-bytes test against Sweetie HD `BG01A1.g00` (depends on capability_utsushi_217 landing)",
      "Layer-ordering honoured (`objSetLayer` actually re-orders render-pass output)",
    ],
    acceptanceCriteria: [
      "Each opcode produces an observable mutation of capability_utsushi_213's graphics object stack visible via a `state_snapshot` API.",
      '`openBg("BG01A1")` reads `$GAME/REALLIVEDATA/g00/BG01A1.g00` via the substrate VFS and registers it as the bg plane background; the next render emits a 1280x720 PNG whose top-left pixel matches the documented bg colour (after g00 type-0 decode lands in capability_utsushi_217).',
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
      "Type 2 decoded files expose a `regions: Vec<G00Region { rect, name? }>` list usable by `objLoadRegion` in capability_utsushi_214.",
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
      "Determine whether Sweetie HD's compiler-version-110002 bytecode uses the AVG32 second-level XOR pass, and if so, recover the key. Research-only node — no code changes if the key is off; one constant + documentation if it's recoverable. Either outcome acceptable; what is not is shipping capability_utsushi_203 with a hardcoded 'Key 09' guess and pretending it's Sukara's.",
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
      "If the entropy is random (key on), the capability ships with a known-bytes attack (RealLive scenes always start with a MetaElement opener byte `0x21` or `0x40` at offset 0 of the bytecode) and either recovers the key or documents the recovery path for later work.",
      "Either outcome is acceptable; what is not acceptable is shipping capability_utsushi_203 with a hardcoded 'Key 09' guess and pretending it's Sukara's.",
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
      "Tie the RealLive port into capability_utsushi_147's cross-engine conformance fixture. Document which sub-nodes of the decomposition will be reusable when the Siglus port lands (the AVG32 -> RealLive -> Siglus lineage Visual Arts documents). Boundary-aware: 'reusable' claims must be proven against a Siglus prototype rather than asserted.",
    deliverables: [
      "Cross-engine facade-only-imports conformance test reusing capability_utsushi_147's fixture",
      "Appendix in `docs/research/reallive-engine.md` documenting reusable vs RealLive-only surfaces (expression encoding, bank model, AVG32 LZ+XOR, Gameexe-style config vs rlvm-specific opcode catalogue, OVK voice archives, module identifiers)",
      "Engine-specific boundary notes wherever an acceptance criterion would break under a Siglus reuse claim",
      "Identical-import audit between RealLive scaffold and Siglus minimal-port scaffold",
    ],
    acceptanceCriteria: [
      "capability_utsushi_200..capability_utsushi_220's facade usage is confirmed identical to a Siglus minimal-port scaffold (only `utsushi_core::substrate::*` imports; no engine-specific facade exceptions).",
      "Lineage notes in `docs/research/reallive-engine.md` (new appendix) document: reusable across engines (expression encoding, variable banks — Siglus uses 26 letters not 13 but the trait carries, AVG32 LZ + XOR, Gameexe-style config — Siglus uses Resource.txt but dotted-path tree generalises, headless sink pipeline, snapshot/restore contract); RealLive-only (rlvm-specific opcode catalogue, OVK voice archives — Siglus uses different containers, specific module identifiers).",
      "Any capability_utsushi_200..capability_utsushi_220 node whose acceptance criterion would break under a Siglus reuse claim emits a documented 'engine-specific boundary' note instead of pretending portability.",
    ],
    verification: [
      ["command", "cargo test -p utsushi-siglus --test cross_engine_substrate_alignment"],
      ["command", "just check"],
    ],
    auditFocus: [
      "'Reusable' claims that haven't been proven against a Siglus prototype",
      "Lineage notes that just repeat marketing instead of documenting actual code reuse points",
    ],
    dependsOnProposal: ["u"],
  },
];
