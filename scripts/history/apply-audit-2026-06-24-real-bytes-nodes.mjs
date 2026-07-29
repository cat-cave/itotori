/** @type {Array<object>} */
export const REAL_BYTES_NODES = [
  // ---- Real-bytes-validation audit (§3) ------------------------------------
  {
    id: "capability_kaifuu_188",
    title: "Parse real RealLive SEEN.TXT fixed offset-table envelope",
    status: "planned",
    priority: "P1",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["capability_kaifuu_173"],
    summary:
      "Replace the synthetic count-prefixed envelope assumption in `kaifuu-reallive::parse_archive` (crates/kaifuu-reallive/src/archive.rs:66-161) and the detector probe `reallive_seen_txt_envelope_ok` (crates/kaifuu-engine-fixture/src/lib.rs:4709-4732) with the documented fixed 10,000-entry RealLive offset table: 80,000 bytes of (u32 LE offset, u32 LE size) records starting at byte 0, with unused slots all-zero. Validated against Sweetie HD's REALLIVEDATA/Seen.txt where parse_archive currently returns Ok(entries=0).",
    deliverables: [
      "Rewrite of `kaifuu-reallive::parse_archive` in `crates/kaifuu-reallive/src/archive.rs` to read a 10,000-slot (u32 LE offset, u32 LE size) directory starting at byte 0, skipping all-zero slots and validating `offset >= 80000` and `offset + size <= archive_len` for nonzero slots.",
      "Updated `reallive_seen_txt_envelope_ok` in `crates/kaifuu-engine-fixture/src/lib.rs` to accept the fixed-table envelope (zero-prefix tolerated) and reject only truncated archives.",
      "New regression test in `crates/kaifuu-reallive/tests/archive.rs` that loads the first 256 KiB of Sweetie HD's `REALLIVEDATA/Seen.txt` (synthesised fixture mirroring the real header layout) and asserts entry count >= 1000 with first nonzero entry at offset 0x13880.",
      "Updated `crates/kaifuu-reallive/examples/probe_real_bytes.rs` exit code 0 when private inventory scene archive points at the real Sweetie HD bytes.",
    ],
    acceptanceCriteria: [
      "`parse_archive` on Sweetie HD's REALLIVEDATA/Seen.txt returns a `SceneIndex` whose `entries.len()` is >= 1000.",
      "The first nonzero entry returned by `parse_archive` has `byte_offset == 80000` (0x13880) and a nonzero `byte_len`.",
      "Zero-size slot entries are skipped silently (no `Diagnostic` emitted, no error returned).",
      "`reallive_seen_txt_envelope_ok` returns true on the Sweetie HD bytes and false on a truncated copy (first 79,999 bytes).",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-reallive --test archive",
      },
      {
        type: "command",
        value:
          "private inventory scene archive=<reallive-game-root>/REALLIVEDATA/Seen.txt direnv exec . cargo run -p kaifuu-reallive --example probe_real_bytes",
      },
    ],
    auditFocus: [
      "Off-by-one slot indexing across the fixed 10,000-entry table boundary.",
      "Zero-prefix scene-id 0 slot must not be mistaken for an end-of-table marker.",
      "Synthetic fixture coverage must not regress; capability_kaifuu_173 envelope still parses.",
    ],
  },
  {
    id: "capability_kaifuu_189",
    title: "RealLive detector resolves nested REALLIVEDATA/ subdirectory",
    status: "planned",
    priority: "P1",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["capability_kaifuu_188"],
    summary:
      "Teach `RealLiveProfileDetectorAdapter::inspect` and `reallive_extension_counts` (crates/kaifuu-engine-fixture/src/lib.rs:3328-3388, 4672-4699) to prefer a `REALLIVEDATA/` subdirectory when present (case-insensitive) and scan it for `Seen.txt`, `Gameexe.ini`, `*.g00`, `*.koe`, `*.ovk`, `*.nwk`. Today the detector hits depth 1 only, so pointing at the Sweetie HD game root reports all evidence missing.",
    deliverables: [
      "`resolve_reallive_data_dir(game_dir)` helper in `crates/kaifuu-engine-fixture/src/lib.rs` that returns `Some(REALLIVEDATA path)` when present (case-insensitive match) and `None` otherwise.",
      "Updated `RealLiveProfileDetectorAdapter::inspect` so SEEN.TXT, Gameexe.ini, and extension counts are read from the resolved data dir when present, falling back to the depth-1 search otherwise.",
      "Updated `reallive_extension_counts` walking the resolved data dir up to depth 2 for `.g00`, `.koe`, `.ovk`, `.nwk`.",
      "Regression test `crates/kaifuu-engine-fixture/tests/reallive_nested.rs` with a synthetic two-level fixture mirroring Sweetie HD's REALLIVEDATA/ layout.",
    ],
    acceptanceCriteria: [
      "`kaifuu detect <Sweetie HD game root>` produces `kaifuu.reallive` with `detected == true` (with capability_kaifuu_188 also landed).",
      "Evidence row counts on Sweetie HD root report `.g00 >= 2400`, `.koe >= 100`, and `Gameexe.ini RealLive keys matched` includes `#REGNAME`, `#KOE*`, `#SEEN*`.",
      "`resolve_reallive_data_dir` returns `Some` for a fixture whose subdir is named `reallivedata` (lowercase) and `None` when no candidate exists.",
      "`kaifuu detect <Sweetie HD>/REALLIVEDATA` still succeeds (no double-recursion into a non-existent nested subdir).",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-engine-fixture --test reallive_nested",
      },
      {
        type: "command",
        value:
          "direnv exec . cargo run -p kaifuu-cli -- detect '<reallive-game-root>' --output /tmp/itotori-probes/detect-root.json",
      },
    ],
    auditFocus: [
      "Case-insensitive directory match must not match unrelated names (`reallive`, `data`).",
      "Recursion bound: the scanner must not descend past depth 2 from the resolved data dir.",
      "Behaviour when both root and nested data dir contain SEEN.TXT (prefer nested).",
    ],
  },
  {
    id: "capability_kaifuu_190",
    title: "Gameexe.ini key catalogue extension to documented RealLive surface",
    status: "planned",
    priority: "P1",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["capability_kaifuu_174"],
    summary:
      "Expand the classifier catalogue in `crates/kaifuu-reallive/src/gameexe.rs:166-182` to recognise the full RLDEV-documented user-visible and asset key surface (`#WINDOW_ATTR`, `#SCREENSIZE_MOD`, `#SYSTEMCALL_*`, `#DISP`, `#TEXTPOS`, `#FACE`, `#OBJBTN`, `#WAKU.*`, `#WEATHER.*`, `#GANBMP`, `#BGM*`, etc.) and distinguish translatable bridge-unit values (e.g., `#NAMAE`, `#CAPTION`, `#NAME.*`) from asset / config references. Today 98.7% of Sweetie HD's `Gameexe.ini` lines fall through to `GameexeKeyTreatment::Unknown` with paired warnings.",
    deliverables: [
      "New `GameexeKeyCatalogue` table in `crates/kaifuu-reallive/src/gameexe.rs` covering the documented RLDEV key surface (config, asset, bridge-unit families), each row tagged with `GameexeKeyTreatment` and example RLDEV reference.",
      "New `parse_gameexe_inventory` classifier hooked to the expanded catalogue; bridge-unit emission for `#NAMAE`, `#CAPTION`, `#NAME.*` style keys.",
      "Regression test `crates/kaifuu-reallive/tests/gameexe_real_bytes.rs` loading a redacted slice of Sweetie HD's `Gameexe.ini` (50-line head, redacted asset paths) and asserting unknown share < 25% and >= 1 BridgeUnit.",
      "Updated `docs/research/reallive-engine.md` Gameexe.ini surface table referencing the new catalogue rows.",
    ],
    acceptanceCriteria: [
      "On the redacted Sweetie HD `Gameexe.ini` slice in the regression test, `parse_gameexe_inventory(...)` reports `unknown.len() * 100 / entries.len() < 25`.",
      "`parse_gameexe_inventory` emits >= 1 `BridgeUnit` from `#REGNAME` and any `#NAMAE`-family key in the slice.",
      "`#WINDOW_ATTR`, `#SCREENSIZE_MOD`, `#SYSTEMCALL_*`, `#DISP`, `#TEXTPOS` keys appear in `entries[].treatment` as either `Config` or `AssetReference`, never `Unknown`.",
      "`cargo test -p kaifuu-reallive --test gameexe_real_bytes` passes deterministically.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-reallive --test gameexe_real_bytes",
      },
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-reallive gameexe",
      },
    ],
    auditFocus: [
      "Catalogue must not classify documented Sweetie-HD-private keys as Config without RLDEV citation.",
      "Bridge-unit emission must distinguish translatable text from asset path text.",
      "Warnings count must drop in lockstep with the unknown share.",
    ],
  },
  {
    id: "capability_kaifuu_191",
    title: "RealLive scene bytecode opcode dispatch (drop synthetic '#' opener)",
    status: "planned",
    priority: "P1",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["capability_kaifuu_188", "capability_kaifuu_173"],
    summary:
      "Replace the synthetic `0x23 ('#') opener + named opcode byte` shape in `crates/kaifuu-reallive/src/parser.rs:36-` with the real RealLive byte stream: bare single-byte opcodes, operand layout per opcode (text strings as length-prefixed Shift-JIS, control codes `0x80..0xFF` as inline directives). Today `parse_scene` would emit `kaifuu.reallive.unrecognized_instruction` for every byte of a real scene because the opener byte never matches.",
    deliverables: [
      "New opcode-dispatch loop in `crates/kaifuu-reallive/src/parser.rs` reading bare single-byte opcodes, dispatching to per-opcode operand decoders.",
      "Per-opcode decoders for at minimum `TextDisplay`, `SetSpeaker`, `Goto`, `End` (mapped from observed Sweetie HD prologue scene); each decoder yields a typed `Instruction` and the byte-count consumed.",
      "Length-prefixed Shift-JIS text decoder (with diagnostic `kaifuu.reallive.invalid_sjis` on decode failure).",
      "Regression test `crates/kaifuu-reallive/tests/scene_real_bytes.rs` loading the first scene payload of Sweetie HD's Seen.txt (bytes [0x13880..0x13880 + first_entry_size]) and asserting `ParseOutcome::status` in {`Clean`, `WithWarnings`} with >= 5 recognised instructions and diagnostic-to-instruction ratio <= 1:1.",
    ],
    acceptanceCriteria: [
      "`parse_scene` on the first scene payload of Sweetie HD's Seen.txt returns a `ParseOutcome` whose `instructions.len() >= 5`.",
      "`parse_scene` on the same payload returns `status` equal to `Clean` or `WithWarnings`; the count of `Diagnostic` entries is `<= instructions.len()`.",
      "Synthetic fixtures from capability_kaifuu_173 continue to parse via the new dispatch loop without regression (synthetic opener byte preserved as an optional legacy path or migrated).",
      "`cargo test -p kaifuu-reallive --test scene_real_bytes` passes deterministically.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-reallive --test scene_real_bytes",
      },
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-reallive parser",
      },
    ],
    auditFocus: [
      "Opcode byte coverage must be documented per RLDEV/rlvm references; no opcode handler may be inferred from Sweetie HD bytes alone.",
      "Shift-JIS decoder must reject UTF-8 byte sequences with a diagnostic (no silent transcoding).",
      "Diagnostic-to-instruction ratio guard must hold on at least one additional real scene payload chosen by the auditor.",
    ],
  },
  {
    id: "capability_kaifuu_192",
    title: "Detector evidence rollup reports resolved nested data dir",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["capability_kaifuu_189"],
    summary:
      'When the detector follows `REALLIVEDATA/`, surface the resolved subdir in `DetectionReport.evidence[].path` fields and add a new `kaifuu.reallive.nested_data_dir_resolved` evidence row so downstream `extract` / `profile` / `verify` invocations don\'t have to re-discover it. Today the JSON report hides the resolved path and shows `path: "SEEN.TXT"` even when the detector walks past it.',
    deliverables: [
      "New `EvidenceCode::NestedDataDirResolved` (string id `kaifuu.reallive.nested_data_dir_resolved`) emitted by `RealLiveProfileDetectorAdapter::inspect` whenever `resolve_reallive_data_dir` returns `Some`.",
      "Evidence rows for SEEN.TXT, Gameexe.ini, and extension counts carry `path` strings that include the resolved data-dir prefix (e.g. `REALLIVEDATA/Seen.txt`).",
      "Regression test in `crates/kaifuu-engine-fixture/tests/reallive_nested.rs` asserting the new evidence row and the prefixed paths.",
      "Updated JSON snapshot fixture under `crates/kaifuu-engine-fixture/tests/fixtures/reallive-nested-detect.json`.",
    ],
    acceptanceCriteria: [
      '`kaifuu detect <Sweetie HD>` JSON output contains an evidence row with `code == "kaifuu.reallive.nested_data_dir_resolved"` and `path` ending in `REALLIVEDATA`.',
      "Every SEEN.TXT / Gameexe.ini evidence row has a `path` starting with `REALLIVEDATA/` when the detector resolved a nested subdir.",
      "When no nested subdir is present, no `nested_data_dir_resolved` row is emitted (negative test).",
    ],
    verification: [
      {
        type: "command",
        value:
          "direnv exec . cargo test -p kaifuu-engine-fixture --test reallive_nested nested_data_dir_resolved",
      },
      {
        type: "command",
        value:
          "direnv exec . cargo run -p kaifuu-cli -- detect '<reallive-game-root>' --output /tmp/itotori-probes/detect-root.json",
      },
    ],
    auditFocus: [
      "Path prefix must not leak absolute paths; only the in-game relative prefix.",
      "Negative test (no nested dir) must remain green.",
      "Snapshot fixture must be byte-deterministic across machines (no timestamp / pid fields).",
    ],
  },
  {
    id: "capability_kaifuu_193",
    title: "extract/profile/verify emit partial output when adapter reports nonzero evidence",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "kaifuu-core",
    dependsOn: ["capability_kaifuu_188", "capability_kaifuu_189"],
    summary:
      "Decouple `extract` / `profile` / `verify` (crates/kaifuu-cli/src/main.rs:59-154) from the binary detect/no-detect gate. When the RealLive adapter reports `detected == false` but `kaifuu.reallive` gathered nonzero evidence (envelope OK but Gameexe.ini key catalogue mismatch, etc.), produce a partial profile / inventory with the diagnostic codes attached, rather than failing closed with `no registered adapter detected`.",
    deliverables: [
      "New `partial_extract_path(adapter, evidence)` branch in `crates/kaifuu-cli/src/main.rs` driving `extract` / `profile` / `verify` when evidence is nonzero and detect was negative.",
      "New JSON envelope `PartialAdapterReport { adapter_id, detected: false, partial: true, evidence: [...], diagnostics: [...], inventory: {...} }` written by the partial path.",
      "Regression test `crates/kaifuu-cli/tests/partial_extract.rs` using a fixture that mirrors Sweetie HD's `parse_archive` success + Gameexe key mismatch.",
      "Updated `docs/subprojects-kaifuu.md` partial-extract section.",
    ],
    acceptanceCriteria: [
      "`kaifuu extract <Sweetie HD>` (after capability_kaifuu_188/189 land, before capability_kaifuu_190/191) exits 0 and emits JSON with `partial == true` and nonzero `inventory.entries`.",
      "`kaifuu profile <Sweetie HD>` emits a `PartialAdapterReport` containing the SEEN.TXT envelope evidence and the Gameexe.ini key-mismatch diagnostics.",
      "`kaifuu verify <Sweetie HD>` exits non-zero only when diagnostics include a P0/P1 severity; partial-evidence runs exit 0 with `status: partial`.",
      "`cargo test -p kaifuu-cli --test partial_extract` passes deterministically.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-cli --test partial_extract",
      },
      {
        type: "command",
        value:
          "direnv exec . cargo run -p kaifuu-cli -- extract '<reallive-game-root>/REALLIVEDATA' --output /tmp/itotori-probes/extract.json",
      },
    ],
    auditFocus: [
      "Partial output must not be confused with a complete `extract` by downstream `apply` / `verify`.",
      "Diagnostic severity routing: P2/P3 must not cause exit 1.",
      "JSON envelope must be schema-stable so the dashboard can ingest partial runs.",
    ],
  },
  {
    id: "capability_utsushi_177",
    title: "utsushi-fixture refuses non-fixture inputs with structured diagnostic",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["utsushi"],
    parallelGroup: "runtime-adapters",
    dependsOn: ["capability_utsushi_103", "capability_kaifuu_189"],
    summary:
      "Either teach `utsushi-fixture` (crates/utsushi-fixture/src/lib.rs:141, 549) to refuse non-fixture inputs with a structured `utsushi.unsupported_input_shape` diagnostic instead of `os::Error::NotFound`, or — preferred — introduce a new `utsushi-reallive` runtime adapter shim that consults the detector's engine-family inference (capability_kaifuu_189) before reading any bytes. Today every `utsushi trace|capture|smoke <real-game>` invocation dies with `No such file or directory (os error 2)`.",
    deliverables: [
      "New `utsushi.unsupported_input_shape` diagnostic code in `crates/utsushi-core/src/diagnostics.rs`.",
      "`utsushi-fixture` source-file probe (`crates/utsushi-fixture/src/lib.rs`) consults `resolve_reallive_data_dir` first; when a non-fixture engine family is detected, emits the diagnostic and exits 1 with structured JSON.",
      "Regression test `crates/utsushi-fixture/tests/real_game_refusal.rs` using the Sweetie HD path: asserts exit 1 with the diagnostic in stdout, no stderr `os::Error::NotFound`.",
      "Updated `docs/utsushi-fixture-policy.md` (or equivalent) documenting the new refusal contract.",
    ],
    acceptanceCriteria: [
      '`utsushi trace <Sweetie HD>` exits 1 and stdout contains JSON `{"diagnostic":{"code":"utsushi.unsupported_input_shape","engine_family":"reallive",...}}`.',
      "stderr does not contain `os::Error::NotFound` or `No such file or directory` for the real-game path.",
      "`utsushi trace <fixture-with-source.json>` continues to succeed (no regression of existing fixture path).",
      "`cargo test -p utsushi-fixture --test real_game_refusal` passes deterministically.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p utsushi-fixture --test real_game_refusal",
      },
      {
        type: "command",
        value:
          "direnv exec . cargo run -p utsushi-cli -- trace '<reallive-game-root>' --output /tmp/itotori-probes/utsushi-trace.json",
      },
    ],
    auditFocus: [
      "Diagnostic schema must be a stable contract for the dashboard and for upstream consumers.",
      "Refusal path must not leak the user's local filesystem absolute path into the diagnostic.",
      "Existing fixture-shaped inputs must not regress.",
    ],
  },
  {
    id: "capability_utsushi_178",
    title: "Browser/NW.js launch adapters gate on detector engine-family match",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["utsushi"],
    parallelGroup: "runtime-adapters",
    dependsOn: ["capability_utsushi_177"],
    summary:
      "`BrowserLaunchAdapter` and `NwjsLaunchAdapter` (crates/utsushi-fixture/src/lib.rs) currently call `fs::read` / similar on a path that doesn't exist for a RealLive title, producing the same opaque `os::Error::NotFound`. Consult the detector first and refuse to launch when the engine family doesn't match, with structured diagnostic `utsushi.engine_family_mismatch`.",
    deliverables: [
      "New `utsushi.engine_family_mismatch` diagnostic code in `crates/utsushi-core/src/diagnostics.rs` carrying `expected_family` and `observed_family` fields.",
      "Updated `BrowserLaunchAdapter::launch` and `NwjsLaunchAdapter::launch` in `crates/utsushi-fixture/src/lib.rs` to consult the detector before reading any browser/NW.js manifest.",
      "Regression test `crates/utsushi-fixture/tests/launch_engine_family_mismatch.rs` invoking the browser adapter on the Sweetie HD path, asserting exit 1 with the structured diagnostic.",
      "Documentation update naming the adapters' new precondition.",
    ],
    acceptanceCriteria: [
      '`utsushi capture <Sweetie HD> --adapter utsushi-browser` exits 1 with JSON diagnostic `code == "utsushi.engine_family_mismatch"` and `observed_family == "reallive"`.',
      "`utsushi capture <Sweetie HD> --adapter utsushi-nwjs` exits 1 with the same diagnostic shape.",
      "stderr does not contain `os::Error::NotFound` for the real-game path.",
      "Existing browser/NW.js fixture paths continue to launch without regression.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p utsushi-fixture --test launch_engine_family_mismatch",
      },
      {
        type: "command",
        value:
          "direnv exec . cargo run -p utsushi-cli -- capture '<reallive-game-root>' --adapter utsushi-browser --output /tmp/itotori-probes/utsushi-browser.json",
      },
    ],
    auditFocus: [
      "Browser and NW.js adapters must share the same precondition contract (no drift).",
      "Diagnostic must include both `expected_family` and `observed_family` so the dashboard can route to the right adapter.",
      "Fixture-path regression suite must remain green.",
    ],
  },
];
