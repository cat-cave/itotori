#!/usr/bin/env node
/**
 * Inserts 23 new DAG nodes proposed by the three 2026-06-24 audits:
 *
 *   1. docs/audits/real-bytes-validation-2026-06-24.md  (8 nodes)
 *      KAIFUU-188, KAIFUU-189, KAIFUU-190, KAIFUU-191, KAIFUU-192, KAIFUU-193,
 *      UTSUSHI-177, UTSUSHI-178
 *
 *   2. docs/audits/non-reallive-fixture-needs-2026-06-24.md  (11 nodes)
 *      KAIFUU-200, KAIFUU-201, KAIFUU-202, KAIFUU-203, KAIFUU-204, KAIFUU-205,
 *      KAIFUU-206, UTSUSHI-179, UTSUSHI-180, UTSUSHI-181, UTSUSHI-182
 *      (audit text proposed UTSUSHI-200..203 — those collide with the RealLive
 *       decomposition's UTSUSHI-200..221 already in the DAG; renumbered to
 *       UTSUSHI-179..182 per the apply task spec.)
 *
 *   3. docs/audits/silenced-2026-06-24.md  (4 nodes)
 *      KAIFUU-207, ITOTORI-202, KAIFUU-208, KAIFUU-209
 *      (audit text proposed KAIFUU-201/203/204 — those collide with the
 *       non-RealLive fixture audit; renumbered to KAIFUU-207/208/209 per the
 *       apply task spec.)
 *
 * The script:
 *   - Loads roadmap/spec-dag.json
 *   - Validates against roadmap/spec-dag.schema.json (ajv 2020 draft)
 *   - Inserts the 23 nodes (skipping any that already exist; printing a notice)
 *   - Filters out any dependsOn entry whose target id is not in the DAG, and
 *     prints a notice listing the dropped pairs.
 *   - Re-validates against the schema and the spec-dag CLI's per-node semantic
 *     checks (re-implemented inline; mirror of scripts/spec-dag.mjs).
 *   - Writes roadmap/spec-dag.json with `JSON.stringify(dag, null, 2) + "\n"`.
 *   - Exits non-zero on any error.
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

// -----------------------------------------------------------------------------
// New nodes
// -----------------------------------------------------------------------------

const REALLIVEDATA_PATH_NOTE =
  "Sweetie HD root: <reallive-game-root>/REALLIVEDATA/";

/** @type {Array<object>} */
const NEW_NODES = [
  // ---- Real-bytes-validation audit (§3) ------------------------------------
  {
    id: "KAIFUU-188",
    title: "Parse real RealLive SEEN.TXT fixed offset-table envelope",
    status: "planned",
    priority: "P1",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["KAIFUU-173"],
    summary:
      "Replace the synthetic count-prefixed envelope assumption in `kaifuu-reallive::parse_archive` (crates/kaifuu-reallive/src/archive.rs:66-161) and the detector probe `reallive_seen_txt_envelope_ok` (crates/kaifuu-engine-fixture/src/lib.rs:4709-4732) with the documented fixed 10,000-entry RealLive offset table: 80,000 bytes of (u32 LE offset, u32 LE size) records starting at byte 0, with unused slots all-zero. Validated against Sweetie HD's REALLIVEDATA/Seen.txt where parse_archive currently returns Ok(entries=0).",
    deliverables: [
      "Rewrite of `kaifuu-reallive::parse_archive` in `crates/kaifuu-reallive/src/archive.rs` to read a 10,000-slot (u32 LE offset, u32 LE size) directory starting at byte 0, skipping all-zero slots and validating `offset >= 80000` and `offset + size <= archive_len` for nonzero slots.",
      "Updated `reallive_seen_txt_envelope_ok` in `crates/kaifuu-engine-fixture/src/lib.rs` to accept the fixed-table envelope (zero-prefix tolerated) and reject only truncated archives.",
      "New regression test in `crates/kaifuu-reallive/tests/archive.rs` that loads the first 256 KiB of Sweetie HD's `REALLIVEDATA/Seen.txt` (synthesised fixture mirroring the real header layout) and asserts entry count >= 1000 with first nonzero entry at offset 0x13880.",
      "Updated `crates/kaifuu-reallive/examples/probe_real_bytes.rs` exit code 0 when KAIFUU_PROBE_SEEN_TXT points at the real Sweetie HD bytes.",
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
          "KAIFUU_PROBE_SEEN_TXT=<reallive-game-root>/REALLIVEDATA/Seen.txt direnv exec . cargo run -p kaifuu-reallive --example probe_real_bytes",
      },
    ],
    auditFocus: [
      "Off-by-one slot indexing across the fixed 10,000-entry table boundary.",
      "Zero-prefix scene-id 0 slot must not be mistaken for an end-of-table marker.",
      "Synthetic fixture coverage must not regress; KAIFUU-173 envelope still parses.",
    ],
  },
  {
    id: "KAIFUU-189",
    title: "RealLive detector resolves nested REALLIVEDATA/ subdirectory",
    status: "planned",
    priority: "P1",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["KAIFUU-188"],
    summary:
      "Teach `RealLiveProfileDetectorAdapter::inspect` and `reallive_extension_counts` (crates/kaifuu-engine-fixture/src/lib.rs:3328-3388, 4672-4699) to prefer a `REALLIVEDATA/` subdirectory when present (case-insensitive) and scan it for `Seen.txt`, `Gameexe.ini`, `*.g00`, `*.koe`, `*.ovk`, `*.nwk`. Today the detector hits depth 1 only, so pointing at the Sweetie HD game root reports all evidence missing.",
    deliverables: [
      "`resolve_reallive_data_dir(game_dir)` helper in `crates/kaifuu-engine-fixture/src/lib.rs` that returns `Some(REALLIVEDATA path)` when present (case-insensitive match) and `None` otherwise.",
      "Updated `RealLiveProfileDetectorAdapter::inspect` so SEEN.TXT, Gameexe.ini, and extension counts are read from the resolved data dir when present, falling back to the depth-1 search otherwise.",
      "Updated `reallive_extension_counts` walking the resolved data dir up to depth 2 for `.g00`, `.koe`, `.ovk`, `.nwk`.",
      "Regression test `crates/kaifuu-engine-fixture/tests/reallive_nested.rs` with a synthetic two-level fixture mirroring Sweetie HD's REALLIVEDATA/ layout.",
    ],
    acceptanceCriteria: [
      "`kaifuu detect <Sweetie HD game root>` produces `kaifuu.reallive` with `detected == true` (with KAIFUU-188 also landed).",
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
    id: "KAIFUU-190",
    title: "Gameexe.ini key catalogue extension to documented RealLive surface",
    status: "planned",
    priority: "P1",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["KAIFUU-174"],
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
    id: "KAIFUU-191",
    title: "RealLive scene bytecode opcode dispatch (drop synthetic '#' opener)",
    status: "planned",
    priority: "P1",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["KAIFUU-188", "KAIFUU-173"],
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
      "Synthetic fixtures from KAIFUU-173 continue to parse via the new dispatch loop without regression (synthetic opener byte preserved as an optional legacy path or migrated).",
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
    id: "KAIFUU-192",
    title: "Detector evidence rollup reports resolved nested data dir",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["KAIFUU-189"],
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
    id: "KAIFUU-193",
    title: "extract/profile/verify emit partial output when adapter reports nonzero evidence",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "kaifuu-core",
    dependsOn: ["KAIFUU-188", "KAIFUU-189"],
    summary:
      "Decouple `extract` / `profile` / `verify` (crates/kaifuu-cli/src/main.rs:59-154) from the binary detect/no-detect gate. When the RealLive adapter reports `detected == false` but `kaifuu.reallive` gathered nonzero evidence (envelope OK but Gameexe.ini key catalogue mismatch, etc.), produce a partial profile / inventory with the diagnostic codes attached, rather than failing closed with `no registered adapter detected`.",
    deliverables: [
      "New `partial_extract_path(adapter, evidence)` branch in `crates/kaifuu-cli/src/main.rs` driving `extract` / `profile` / `verify` when evidence is nonzero and detect was negative.",
      "New JSON envelope `PartialAdapterReport { adapter_id, detected: false, partial: true, evidence: [...], diagnostics: [...], inventory: {...} }` written by the partial path.",
      "Regression test `crates/kaifuu-cli/tests/partial_extract.rs` using a fixture that mirrors Sweetie HD's `parse_archive` success + Gameexe key mismatch.",
      "Updated `docs/subprojects-kaifuu.md` partial-extract section.",
    ],
    acceptanceCriteria: [
      "`kaifuu extract <Sweetie HD>` (after KAIFUU-188/189 land, before KAIFUU-190/191) exits 0 and emits JSON with `partial == true` and nonzero `inventory.entries`.",
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
    id: "UTSUSHI-177",
    title: "utsushi-fixture refuses non-fixture inputs with structured diagnostic",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["utsushi"],
    parallelGroup: "runtime-adapters",
    dependsOn: ["UTSUSHI-103", "KAIFUU-189"],
    summary:
      "Either teach `utsushi-fixture` (crates/utsushi-fixture/src/lib.rs:141, 549) to refuse non-fixture inputs with a structured `utsushi.unsupported_input_shape` diagnostic instead of `os::Error::NotFound`, or — preferred — introduce a new `utsushi-reallive` runtime adapter shim that consults the detector's engine-family inference (KAIFUU-189) before reading any bytes. Today every `utsushi trace|capture|smoke <real-game>` invocation dies with `No such file or directory (os error 2)`.",
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
    id: "UTSUSHI-178",
    title: "Browser/NW.js launch adapters gate on detector engine-family match",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["utsushi"],
    parallelGroup: "runtime-adapters",
    dependsOn: ["UTSUSHI-177"],
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

  // ---- Non-RealLive fixture-needs audit (§1.6) -----------------------------
  {
    id: "KAIFUU-200",
    title: "MV/MZ public-licensed real-game fixture intake (profile A)",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["KAIFUU-108"],
    summary:
      "Import one freely-redistributable RPG Maker MV/MZ project (profile A: plain `data/*.json` with `Show Text` + `Show Choices` in at least one `Map*.json`, populated `CommonEvents.json`, populated `System.json` terms) into `fixtures/public/kaifuu-rpgmaker-mv-mz-profile-a/`, capture license SPDX, and emit a manifest matching the existing fixture-policy schema.",
    deliverables: [
      "`fixtures/public/kaifuu-rpgmaker-mv-mz-profile-a/` directory containing the imported project's `data/*.json` plus a top-level `LICENSE` mirroring the source's verbatim license text.",
      "`fixtures/public/kaifuu-rpgmaker-mv-mz-profile-a.manifest.json` declaring SPDX id, source URL, extraction-surface counts (`Show Text`, `Show Choices`, `CommonEvent` commands, `System.terms` fields), and SHA-256 hashes per file.",
      "Generator script `fixtures/generate-kaifuu-rpgmaker-mv-mz-profile-a.mjs` deterministically regenerating the manifest from the directory.",
      "Regression test `crates/kaifuu-core/tests/rpgmaker_profile_a.rs` asserting the manifest counts match.",
    ],
    acceptanceCriteria: [
      "`fixtures/public/kaifuu-rpgmaker-mv-mz-profile-a.manifest.json` exists with SPDX id present verbatim and `extractionSurfaces.showText >= 5`, `extractionSurfaces.showChoices >= 1`.",
      "`pnpm node fixtures/generate-kaifuu-rpgmaker-mv-mz-profile-a.mjs` regenerates the manifest with identical bytes (deterministic).",
      "`cargo test -p kaifuu-core --test rpgmaker_profile_a` passes deterministically.",
      "Each file under the fixture dir has a SHA-256 row in the manifest that matches `sha256sum` output.",
    ],
    verification: [
      {
        type: "command",
        value:
          "direnv exec . pnpm node fixtures/generate-kaifuu-rpgmaker-mv-mz-profile-a.mjs --check",
      },
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-core --test rpgmaker_profile_a",
      },
    ],
    auditFocus: [
      "License capture must be verbatim and SPDX id must be on the OSI/SPDX approved list.",
      "Fixture file count must not include any non-`data/*.json` body that the source's license does not explicitly cover.",
      "Manifest hashes must match the on-disk bytes deterministically across machines.",
    ],
  },
  {
    id: "KAIFUU-201",
    title: "MV/MZ private-local owned-game readiness lane",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["KAIFUU-036"],
    summary:
      "Wrap an owned RPG Maker MV/MZ project under `fixtures/private-local/` (path-only, body never vendored), produce a redacted readiness summary surface (counts, hashes, suffix histogram, helper requirements) emitted by a new `kaifuu rpg-maker readiness-report` subcommand. The report surface must never contain project filenames or key bytes.",
    deliverables: [
      "New `kaifuu rpg-maker readiness-report --game <PATH>` CLI subcommand in `crates/kaifuu-cli/src/main.rs` that consumes a path under `fixtures/private-local/`.",
      "`MvMzReadinessReport` schema in `crates/kaifuu-core/src/lib.rs` carrying `assetSuffixHistogram`, `systemJsonHasEncryptionKey`, `mapTextSurfaceCounts`, `helperRequirements`, and aggregate SHA-256 of `data/*.json`.",
      "Redaction regression test `crates/kaifuu-cli/tests/mvmz_readiness_redaction.rs` asserting no project filename or key byte appears in the report JSON.",
      "Manifest entry under `fixtures/private-local/README.md` documenting the contract (path lane only; bodies never committed).",
    ],
    acceptanceCriteria: [
      "`kaifuu rpg-maker readiness-report --game fixtures/private-local/<id>` emits JSON whose top-level keys are exactly `{spec, assetSuffixHistogram, systemJsonHasEncryptionKey, mapTextSurfaceCounts, helperRequirements, aggregateDataHashSha256}`.",
      "The redaction regression test asserts the emitted JSON does not contain any project filename, full path, or `System.json.encryptionKey` byte string.",
      "`encryptionKey` presence is reported as boolean only; never as the literal value.",
      "`cargo test -p kaifuu-cli --test mvmz_readiness_redaction` passes deterministically.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-cli --test mvmz_readiness_redaction",
      },
      {
        type: "command",
        value: "direnv exec . cargo build -p kaifuu-cli",
      },
    ],
    auditFocus: [
      "Redaction test must run on synthetic-but-realistic private-local fixture seeded by the test.",
      "Report must not leak hashes that would let an attacker fingerprint the owned project (only aggregate hash is exported).",
      "Path lane contract documented in fixtures/private-local/README.md must match the CLI's expectations.",
    ],
  },
  {
    id: "KAIFUU-202",
    title: "MV/MZ encrypted-asset real-bytes decrypt smoke",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["KAIFUU-115", "KAIFUU-116", "KAIFUU-200"],
    summary:
      "Run KAIFUU-115 (image decrypt) and KAIFUU-116 (audio decrypt) against profile B's fixture and assert a byte-equal round-trip against the author-provided plaintext. Composes the existing decrypt nodes with the new KAIFUU-200 fixture intake.",
    deliverables: [
      "Regression test `crates/kaifuu-core/tests/mvmz_encrypted_roundtrip.rs` that decrypts and re-encrypts at least one `.rpgmvp`/`.png_` and one `.rpgmvo`/`.m4a_` using the `KAIFUU-115`/`KAIFUU-116` APIs against fixture bytes vendored under `fixtures/public/kaifuu-rpgmaker-mv-mz-profile-b/`.",
      "Profile-B fixture intake under `fixtures/public/kaifuu-rpgmaker-mv-mz-profile-b/` with manifest declaring SPDX id and author-provided plaintexts for byte-equal assertions.",
      "Smoke command `kaifuu rpg-maker encrypted-smoke --fixture <id>` printing per-asset PASS/FAIL.",
      "Updated `docs/kaifuu-fixture-policy.md` cross-reference for profile B.",
    ],
    acceptanceCriteria: [
      "`cargo test -p kaifuu-core --test mvmz_encrypted_roundtrip` asserts `decrypt(encrypted_bytes) == plaintext_bytes` and `encrypt(plaintext_bytes) == encrypted_bytes` for >=1 image and >=1 audio asset.",
      "`kaifuu rpg-maker encrypted-smoke --fixture kaifuu-rpgmaker-mv-mz-profile-b` exits 0 with all per-asset rows PASS.",
      "Profile-B manifest declares SPDX id verbatim and includes SHA-256 for every encrypted and plaintext asset.",
      "Regression test runs deterministically across two consecutive invocations.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-core --test mvmz_encrypted_roundtrip",
      },
      {
        type: "command",
        value:
          "direnv exec . cargo run -p kaifuu-cli -- rpg-maker encrypted-smoke --fixture kaifuu-rpgmaker-mv-mz-profile-b",
      },
    ],
    auditFocus: [
      "Encryption key handling must consume `System.json.encryptionKey` from the fixture, not an inline literal.",
      "Round-trip must be byte-equal in both directions; partial decryptions must fail loud.",
      "Profile-B license must explicitly permit re-encryption derivatives.",
    ],
  },
  {
    id: "UTSUSHI-179",
    title: "utsushi-rpgmaker-mv-mz crate scaffold + facade conformance",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["utsushi"],
    parallelGroup: "runtime-adapters",
    dependsOn: ["UTSUSHI-120"],
    summary:
      "Create the `utsushi-rpgmaker-mv-mz` crate (pure-Rust, MIT/Apache-2.0) wiring an `RpgMakerMvMzEnginePort` through the substrate facade conformance manifest and emitting a clean-room attestation for the browser/NW.js path. Zero opcode handlers — analogous to the proposed `146a` shape in alpha-scope-honesty.md §C.3. Depends on the UTSUSHI-120 substrate facade.",
    deliverables: [
      "`crates/utsushi-rpgmaker-mv-mz/` crate scaffold (`cargo new --lib`) with `forbid(unsafe_code)` and `deny(missing_debug_implementations)`.",
      "Crate-level doc declaring clean-room boundary; no MV/MZ source reading.",
      "`EnginePortAdapter` impl stub returning `Unimplemented` for every lifecycle stage.",
      "Conformance manifest registration entry for `utsushi.rpgmaker.mv_mz`.",
      "License + dependency-tree CI gate (license MIT-OR-Apache-2.0; no GPL transitive deps).",
    ],
    acceptanceCriteria: [
      '`crates/utsushi-rpgmaker-mv-mz/Cargo.toml` exists with `license = "MIT OR Apache-2.0"`, depends only on `utsushi-core` via `utsushi_core::substrate::*`.',
      "`cargo test -p utsushi-rpgmaker-mv-mz scaffold` exercises the `ConformanceManifest` registration and reports `Unimplemented` for every lifecycle stage.",
      "Crate-level doc contains the clean-room boundary statement verbatim, identical wording to `utsushi-reallive`.",
      "No `Show Text` / `Show Choices` opcode handler exists in the crate (grep for `handler` returns only the `Unimplemented` stubs).",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p utsushi-rpgmaker-mv-mz scaffold",
      },
      {
        type: "command",
        value: "direnv exec . cargo doc -p utsushi-rpgmaker-mv-mz --no-deps",
      },
    ],
    auditFocus: [
      "Source-tree leakage from any MV/MZ engine source (must be zero opcode handlers).",
      "Facade bypass via direct `utsushi_core::vfs::*` import (forbidden).",
      "Placeholder `Ok(())` returns hiding unimplemented stages (forbidden).",
    ],
  },
  {
    id: "UTSUSHI-180",
    title: "MV/MZ browser launch fixture replay emits E1 trace",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["utsushi"],
    parallelGroup: "runtime-adapters",
    dependsOn: ["UTSUSHI-179", "UTSUSHI-031", "UTSUSHI-032", "UTSUSHI-033", "KAIFUU-200"],
    summary:
      "Drive the Chromium browser launch contract against KAIFUU-200's fixture and emit an E1 trace recording text + choice events. The trace must contain at least one `Show Text` event id matching the KAIFUU-109 bridge unit id from the same fixture.",
    deliverables: [
      "New `utsushi run --adapter utsushi-rpgmaker-mv-mz --fixture kaifuu-rpgmaker-mv-mz-profile-a` driver in `crates/utsushi-cli/src/main.rs`.",
      "E1 trace writer wired through the substrate facade emitting `text_event`, `choice_event`, and `engine_family` rows.",
      "Regression test `crates/utsushi-rpgmaker-mv-mz/tests/browser_replay_e1.rs` asserting trace contains >= 1 `text_event` matching a known KAIFUU-109 bridge unit id.",
      "Snapshot fixture under `crates/utsushi-rpgmaker-mv-mz/tests/fixtures/profile-a-e1-trace.json` for byte-deterministic comparison.",
    ],
    acceptanceCriteria: [
      "`cargo test -p utsushi-rpgmaker-mv-mz --test browser_replay_e1` asserts the emitted trace JSON contains >= 1 `text_event.bridge_unit_id` matching a `KAIFUU-109` bridge unit id from `KAIFUU-200`'s fixture manifest.",
      'Emitted trace JSON declares `engine_family == "rpg_maker_mv_mz"` and `runtime == "browser-chromium"`.',
      "Snapshot fixture compares byte-equal across two consecutive runs (no timestamp / pid fields).",
      "`utsushi run --adapter utsushi-rpgmaker-mv-mz --fixture kaifuu-rpgmaker-mv-mz-profile-a` exits 0.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p utsushi-rpgmaker-mv-mz --test browser_replay_e1",
      },
      {
        type: "command",
        value:
          "direnv exec . cargo run -p utsushi-cli -- run --adapter utsushi-rpgmaker-mv-mz --fixture kaifuu-rpgmaker-mv-mz-profile-a --output /tmp/itotori-probes/utsushi-mvmz.json",
      },
    ],
    auditFocus: [
      "Bridge unit id linkage must be a stable contract between `kaifuu-rpgmaker-mv-mz` extraction and the browser replay.",
      "Trace metadata fields must be stable across runtime variants (browser vs nwjs).",
      "Snapshot fixture must be byte-deterministic; CI runs from multiple platforms.",
    ],
  },
  {
    id: "KAIFUU-203",
    title: "Public synthetic KAG `.ks` corpus (CC0)",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["KAIFUU-009"],
    summary:
      "Hand-author a CC0 KAG `.ks` corpus under `fixtures/public/kaifuu-kag-synthetic-corpus/` covering dialogue, choices, labels, jumps, variables, comments, and the profile-B tag inventory (`[r]`, `[l]`, `[p]`, `[cm]`, `[ct]`, `[wait]`, `[jump]`, `[call]`, `[return]`, `[if]`, `[endif]`, `[macro]`, `[endmacro]`, `[eval]`, `[image]`, `[playbgm]`). Drives KAIFUU-009 against author-independent author-CC0 bytes.",
    deliverables: [
      "`fixtures/public/kaifuu-kag-synthetic-corpus/` directory with >= 6 `.ks` files covering >= 6 distinct KAG tags from the profile-B inventory.",
      "`fixtures/public/kaifuu-kag-synthetic-corpus.manifest.json` declaring `SPDX-License-Identifier: CC0-1.0`, per-file SHA-256, per-file tag inventory.",
      "Generator script `fixtures/generate-kaifuu-kag-synthetic-corpus.mjs` regenerating the manifest deterministically.",
      "Regression test `crates/kaifuu-core/tests/kag_corpus_manifest.rs` asserting manifest invariants.",
    ],
    acceptanceCriteria: [
      'Manifest declares `"SPDX-License-Identifier": "CC0-1.0"` verbatim.',
      "`tagInventory` across all files in the manifest contains >= 6 distinct KAG tag names from the profile-B inventory.",
      "`pnpm node fixtures/generate-kaifuu-kag-synthetic-corpus.mjs --check` succeeds with deterministic byte-equal regeneration.",
      "`cargo test -p kaifuu-core --test kag_corpus_manifest` passes deterministically.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . pnpm node fixtures/generate-kaifuu-kag-synthetic-corpus.mjs --check",
      },
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-core --test kag_corpus_manifest",
      },
    ],
    auditFocus: [
      "Author-CC0 declaration must be explicit per-file (header comment) and at the manifest level.",
      "Tag inventory must be deterministic; generator script must not record file-modification times.",
      "Corpus must include at least one label/jump pair so KAIFUU-009 can exercise control flow.",
    ],
  },
  {
    id: "KAIFUU-204",
    title: "Public licensed real-game plain-XP3 fixture intake",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["KAIFUU-097", "KAIFUU-203"],
    summary:
      "Import one freely-redistributable plain (non-encrypted) XP3 archive (profile A: plain `XP3` magic, raw or zlib index encoding, >=1 `scenario/*.ks` inside) under `fixtures/public/kaifuu-xp3-plain-profile-a/`. Emit a redaction-aware manifest declaring SPDX id, `xp3-archive` row, and a `kag-scenario` row whose tag inventory intersects KAIFUU-203's CC0 corpus above a documented coverage ratio.",
    deliverables: [
      "`fixtures/public/kaifuu-xp3-plain-profile-a/` directory with the imported `*.xp3` (or a minimal sliced copy if the source's license permits derivative slicing).",
      "`fixtures/public/kaifuu-xp3-plain-profile-a.manifest.json` declaring SPDX id, source URL, archive SHA-256, `read_plain_xp3_inventory` entry count, KAG tag inventory, and the intersection ratio against KAIFUU-203.",
      "Generator script `fixtures/generate-kaifuu-xp3-plain-profile-a.mjs` regenerating the manifest.",
      "Regression test `crates/kaifuu-core/tests/xp3_profile_a.rs` asserting `read_plain_xp3_inventory` returns 0 errors and the manifest counts match.",
    ],
    acceptanceCriteria: [
      "`read_plain_xp3_inventory(<fixture>)` returns an `Ok(PlainXp3Inventory)` with `entries.len() >= 3` and zero `PlainXp3InventoryError` results.",
      "Manifest declares SPDX id verbatim and `tagInventoryIntersectionRatioAgainstKaifuu203 >= 0.5` (or a documented lower ratio with justification in the manifest).",
      "`pnpm node fixtures/generate-kaifuu-xp3-plain-profile-a.mjs --check` regenerates the manifest with identical bytes.",
      "`cargo test -p kaifuu-core --test xp3_profile_a` passes deterministically.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . pnpm node fixtures/generate-kaifuu-xp3-plain-profile-a.mjs --check",
      },
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-core --test xp3_profile_a",
      },
    ],
    auditFocus: [
      "License capture verbatim and SPDX id on the OSI/SPDX approved list.",
      "If the source license forbids derivative slicing, the fixture must vendor the original `*.xp3` byte-for-byte.",
      "Intersection ratio against KAIFUU-203 must be computed from the manifest at fixture-generation time, never from runtime KAG parsing.",
    ],
  },
  {
    id: "KAIFUU-205",
    title: "Plain XP3 real-bytes round-trip smoke",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["KAIFUU-098", "KAIFUU-204"],
    summary:
      "Compose KAIFUU-098's deterministic XP3 writer with KAIFUU-097's reader against KAIFUU-204's plain-XP3 fixture and assert a byte-equal round-trip. Surfaces a `kaifuu xp3 smoke --fixture <id>` CLI subcommand.",
    deliverables: [
      "Wired `kaifuu xp3 smoke --fixture <id>` subcommand in `crates/kaifuu-cli/src/main.rs` reading the named fixture and round-tripping it through `read_plain_xp3_inventory` + KAIFUU-098 writer.",
      "Regression test `crates/kaifuu-core/tests/xp3_real_bytes_roundtrip.rs` asserting `repack(read(fixture)) == fixture` byte-for-byte.",
      "Per-entry adler32 + path + size assertion harness used by the round-trip test.",
      "Documentation update in `docs/kaifuu-fixture-policy.md` linking KAIFUU-204 and KAIFUU-205.",
    ],
    acceptanceCriteria: [
      "`cargo test -p kaifuu-core --test xp3_real_bytes_roundtrip` asserts `repack(read(fixture)) == fixture` byte-for-byte for the KAIFUU-204 fixture.",
      "`kaifuu xp3 smoke --fixture kaifuu-xp3-plain-profile-a` exits 0 and prints per-entry PASS rows.",
      "Per-entry adler32 from the recomputed archive equals the manifest-declared value for every declared entry.",
      "Per-entry path and `compressed` flag preserved across round-trip.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-core --test xp3_real_bytes_roundtrip",
      },
      {
        type: "command",
        value:
          "direnv exec . cargo run -p kaifuu-cli -- xp3 smoke --fixture kaifuu-xp3-plain-profile-a",
      },
    ],
    auditFocus: [
      "Round-trip must include both raw and zlib index encodings if the fixture mixes them.",
      "adler32 recomputation must match the manifest exactly; mismatches must fail loud.",
      "Smoke command must not depend on KAIFUU-009 (KAG parsing) — pure container round-trip.",
    ],
  },
  {
    id: "KAIFUU-206",
    title: "Private-local KAG/XP3 owned-game readiness lane",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["KAIFUU-036"],
    summary:
      "Wrap an owned KiriKiri/KAG game under `fixtures/private-local/` (path-only, body never vendored) and produce a redacted readiness summary via a new `kaifuu xp3 readiness-report` subcommand. The report surface must never contain filenames, KAG body bytes, or key material.",
    deliverables: [
      "New `kaifuu xp3 readiness-report --game <PATH>` CLI subcommand in `crates/kaifuu-cli/src/main.rs`.",
      "`XpThreeKagReadinessReport` schema in `crates/kaifuu-core/src/lib.rs` carrying `xp3VariantHistogram`, `kagTagHistogram`, `archiveCount`, `kagScenarioCount`, and aggregate SHA-256 of `.ks` bodies (not per-file).",
      "Redaction regression test `crates/kaifuu-cli/tests/xp3_readiness_redaction.rs` asserting no filename, KAG body, or key material appears in the report JSON.",
      "Manifest entry under `fixtures/private-local/README.md` documenting the contract.",
    ],
    acceptanceCriteria: [
      "`kaifuu xp3 readiness-report --game fixtures/private-local/<id>` emits JSON whose top-level keys are exactly `{spec, xp3VariantHistogram, kagTagHistogram, archiveCount, kagScenarioCount, aggregateKagBodyHashSha256}`.",
      "Redaction regression test asserts the emitted JSON does not contain any filename, KAG body byte string, or encrypted-XP3 key material.",
      "Encrypted vs plain-XP3 split is reported as histogram bucket counts, not as per-file rows.",
      "`cargo test -p kaifuu-cli --test xp3_readiness_redaction` passes deterministically.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-cli --test xp3_readiness_redaction",
      },
      {
        type: "command",
        value: "direnv exec . cargo build -p kaifuu-cli",
      },
    ],
    auditFocus: [
      "Redaction test must run on synthetic-but-realistic private-local fixture seeded by the test.",
      "Aggregate hash must not reveal per-file structure.",
      "Path lane contract documented in fixtures/private-local/README.md must match the CLI's expectations.",
    ],
  },
  {
    id: "UTSUSHI-181",
    title: "utsushi-kirikiri-xp3 crate scaffold + facade conformance",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["utsushi"],
    parallelGroup: "runtime-adapters",
    dependsOn: ["UTSUSHI-120"],
    summary:
      "Create the `utsushi-kirikiri-xp3` crate (pure-Rust, MIT/Apache-2.0) wiring a `KirikiriXp3EnginePort` through the substrate facade conformance manifest; clean-room attestation for the KAG plaintext path. Zero opcode handlers. Depends on the UTSUSHI-120 substrate facade.",
    deliverables: [
      "`crates/utsushi-kirikiri-xp3/` crate scaffold (`cargo new --lib`) with `forbid(unsafe_code)` and `deny(missing_debug_implementations)`.",
      "Crate-level doc declaring clean-room boundary; no KiriKiri / KiriKiri Z source reading.",
      "`EnginePortAdapter` impl stub returning `Unimplemented` for every lifecycle stage.",
      "Conformance manifest registration entry for `utsushi.kirikiri.xp3`.",
      "License + dependency-tree CI gate (license MIT-OR-Apache-2.0; no GPL transitive deps).",
    ],
    acceptanceCriteria: [
      '`crates/utsushi-kirikiri-xp3/Cargo.toml` exists with `license = "MIT OR Apache-2.0"`, depends only on `utsushi-core` via `utsushi_core::substrate::*`.',
      "`cargo test -p utsushi-kirikiri-xp3 scaffold` exercises the `ConformanceManifest` registration and reports `Unimplemented` for every lifecycle stage.",
      "Crate-level doc contains the clean-room boundary statement verbatim, identical wording to `utsushi-reallive`.",
      "No KAG opcode handler exists in the crate (grep for `handler` returns only the `Unimplemented` stubs).",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p utsushi-kirikiri-xp3 scaffold",
      },
      {
        type: "command",
        value: "direnv exec . cargo doc -p utsushi-kirikiri-xp3 --no-deps",
      },
    ],
    auditFocus: [
      "Source-tree leakage from any KiriKiri / TJS engine source (must be zero opcode handlers).",
      "Facade bypass via direct `utsushi_core::vfs::*` import (forbidden).",
      "Placeholder `Ok(())` returns hiding unimplemented stages (forbidden).",
    ],
  },
  {
    id: "UTSUSHI-182",
    title: "KAG plaintext fixture replay emits E0/E1 trace",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["utsushi"],
    parallelGroup: "runtime-adapters",
    dependsOn: ["UTSUSHI-181", "UTSUSHI-037", "UTSUSHI-038", "KAIFUU-009", "KAIFUU-203"],
    summary:
      "Drive UTSUSHI-037 (KAG plaintext parser replay) and UTSUSHI-038 (macro + storage subset) against KAIFUU-203's CC0 synthetic corpus and emit an E0/E1 trace of text + jump events. The trace must contain at least one `text_event` id and at least one `label_jump_event` id matching KAIFUU-009 bridge unit ids.",
    deliverables: [
      "New `utsushi run --adapter utsushi-kirikiri-xp3 --fixture kaifuu-kag-synthetic-corpus` driver in `crates/utsushi-cli/src/main.rs`.",
      "E0/E1 trace writer emitting `text_event`, `label_jump_event`, and `engine_family` rows.",
      "Regression test `crates/utsushi-kirikiri-xp3/tests/kag_replay_e0_e1.rs` asserting the trace contains >=1 `text_event` and >=1 `label_jump_event` matching KAIFUU-009 bridge unit ids.",
      "Snapshot fixture under `crates/utsushi-kirikiri-xp3/tests/fixtures/kag-corpus-e0-e1-trace.json` for byte-deterministic comparison.",
    ],
    acceptanceCriteria: [
      "`cargo test -p utsushi-kirikiri-xp3 --test kag_replay_e0_e1` asserts emitted trace JSON contains >=1 `text_event.bridge_unit_id` and >=1 `label_jump_event.bridge_unit_id` matching `KAIFUU-009` bridge unit ids from KAIFUU-203's corpus manifest.",
      'Emitted trace JSON declares `engine_family == "kirikiri_xp3"` and `runtime == "kag-plaintext-interpreter"`.',
      "Snapshot fixture compares byte-equal across two consecutive runs (no timestamp / pid fields).",
      "`utsushi run --adapter utsushi-kirikiri-xp3 --fixture kaifuu-kag-synthetic-corpus` exits 0.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p utsushi-kirikiri-xp3 --test kag_replay_e0_e1",
      },
      {
        type: "command",
        value:
          "direnv exec . cargo run -p utsushi-cli -- run --adapter utsushi-kirikiri-xp3 --fixture kaifuu-kag-synthetic-corpus --output /tmp/itotori-probes/utsushi-kag.json",
      },
    ],
    auditFocus: [
      "Bridge unit id linkage must be a stable contract between `kaifuu-009` extraction and the KAG replay.",
      "Trace metadata fields must be stable across runtime variants.",
      "Snapshot fixture must be byte-deterministic.",
    ],
  },

  // ---- Silenced-tests audit (§4) -------------------------------------------
  {
    id: "KAIFUU-207",
    title: "binary-patch-smoke helper reconciliation",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "kaifuu-core",
    dependsOn: ["KAIFUU-011"],
    summary:
      "Reconcile every `#[allow(dead_code)]` symbol in `crates/kaifuu-cli/src/binary_patch_smoke.rs`. Drop the stale silences on `parse` (line 45), `BinarySmokeOutcome` enum (line 80), and `write_smoke_summary` (line 492) since the symbols are called from `main.rs:208`, `:224-228`, and `:221`. Either delete or wire the four genuinely-dead helpers (`exit_code` line 91, `patch_result_filename` line 506, `output_seen_filename` line 511, `fixture_path_for` line 516).",
    deliverables: [
      "Edits to `crates/kaifuu-cli/src/binary_patch_smoke.rs` removing all six `#[allow(dead_code)]` attributes; replaced with either deletion or active wiring.",
      "If retained: at least one external caller per remaining helper, callable from `main.rs` or another module.",
      "Regression test `crates/kaifuu-cli/tests/binary_patch_smoke_allowlist.rs` invoking `rg` (via `std::process::Command`) to assert zero `#[allow(dead_code)]` attributes remain.",
      "Updated KAIFUU-011 runtime README cross-reference if a CLI flag is added or removed.",
    ],
    acceptanceCriteria: [
      "`rg '#\\[allow\\(dead_code\\)\\]' crates/kaifuu-cli/src/binary_patch_smoke.rs` returns zero matches.",
      "`cargo build -p kaifuu-cli` succeeds without re-introducing the `dead_code` lint.",
      "Any retained helper has >= 1 external caller verified by `rg` for the helper name across `crates/kaifuu-cli/src/`.",
      "`cargo test -p kaifuu-cli --test binary_patch_smoke_allowlist` passes deterministically.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo build -p kaifuu-cli",
      },
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-cli --test binary_patch_smoke_allowlist",
      },
    ],
    auditFocus: [
      "No `#[allow(dead_code)]` may be replaced with `#[allow(unused)]` or `#[cfg(test)]` as a silencer; either delete or wire.",
      "Deleted helpers must not be re-introduced by KAIFUU-011 follow-up work.",
      "Regression test must hold even after future refactors of `binary_patch_smoke.rs`.",
    ],
  },
  {
    id: "ITOTORI-202",
    title: "Uniform DB-suite failure discipline on missing DATABASE_URL",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["itotori"],
    parallelGroup: "itotori-core",
    dependsOn: [],
    summary:
      "Make `packages/itotori-db/test/authorization-matrix.test.ts:976` follow the same fail-loud-on-missing-`DATABASE_URL` pattern as the rest of the package's DB tests (`db-test-context.ts:48`, `repository.test.ts:3923`). Either standardize the whole package on `skipIf` or standardize on `throw new Error('DATABASE_URL is required …')` — remove the inconsistency that lets contributors running the DB suite without the env var pass this file while the others crash.",
    deliverables: [
      "Edit to `packages/itotori-db/test/authorization-matrix.test.ts:976` replacing `describe.skipIf(!process.env.DATABASE_URL)(...)` with the package's canonical `throw new Error(...)` pattern (matching `db-test-context.ts:48`).",
      "Regression test `packages/itotori-db/test/db-failure-discipline.test.ts` asserting `rg 'skipIf' packages/itotori-db/test/` returns zero matches (or migrates all DB tests to a single canonical pattern).",
      "Documentation update in `packages/itotori-db/README.md` naming the required env var.",
      "CI lane confirmation that `.github/workflows/ci.yml` still sets `DATABASE_URL` so the suite never falls through.",
    ],
    acceptanceCriteria: [
      "`rg 'skipIf' packages/itotori-db/test/` returns zero matches.",
      "`pnpm --filter @itotori/db test` without `DATABASE_URL` fails loud with the canonical error message before any test body runs (no silent skip).",
      "`pnpm --filter @itotori/db test` with `DATABASE_URL` set passes the authorization-matrix suite.",
      "Documentation in `packages/itotori-db/README.md` cites the canonical failure-on-missing-env-var contract.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . pnpm --filter @itotori/db test",
      },
      {
        type: "command",
        value: "rg 'skipIf' packages/itotori-db/test/",
      },
    ],
    auditFocus: [
      "All DB-touching tests must use the same canonical failure pattern; no silent skip.",
      "CI must still set `DATABASE_URL`; the change must not break the CI lane.",
      "Local developers must get the same loud failure across every DB test file.",
    ],
  },
  {
    id: "KAIFUU-208",
    title: "deny.toml strictness pass on bans.multiple-versions and bans.wildcards",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "kaifuu-core",
    dependsOn: [],
    summary:
      'Move `bans.multiple-versions` from `"warn"` to `"deny"`, flip `bans.wildcards` from `"allow"` to `"deny"` in `deny.toml`, and add a documented `skip = [...]` allowlist for any duplicate-version pair we accept (with a one-line `# reason:` justification each).',
    deliverables: [
      'Edit to `deny.toml` setting `bans.multiple-versions = "deny"` and `bans.wildcards = "deny"`.',
      "If duplicates remain unavoidable: `skip` table entries in `deny.toml` listing each crate name + version, each preceded by a `# reason: …` comment line.",
      'Regression test (`scripts/verify-deny-strict.mjs` or equivalent) asserting `bans.multiple-versions == "deny"` and `bans.wildcards == "deny"`.',
      "Updated `docs/dependency-policy.md` (or new section in the kaifuu policy doc) describing the new strictness.",
    ],
    acceptanceCriteria: [
      "`grep -E '^(multiple-versions|wildcards) = \"deny\"' deny.toml` returns both lines.",
      "`cargo deny check bans` exits 0 on `main` after the change.",
      "Every `skip` entry in `deny.toml` has a `# reason:` comment on the immediately preceding line.",
      "`node scripts/verify-deny-strict.mjs` exits 0.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo deny check bans",
      },
      {
        type: "command",
        value: "direnv exec . node scripts/verify-deny-strict.mjs",
      },
    ],
    auditFocus: [
      "`skip` entries must not absorb arbitrary duplicate pairs; each must have a documented reason.",
      '`bans.wildcards = "deny"` must catch `version = "*"` slips at the next dependency add.',
      "Strictness flip must not regress an existing crate transitively (audit the diff).",
    ],
  },
  {
    id: "KAIFUU-209",
    title: "run_golden_patch_phase signature refactor to GoldenPatchPhaseArgs struct",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "kaifuu-core",
    dependsOn: [],
    summary:
      "Replace the eleven-parameter signature of `run_golden_patch_phase` (crates/kaifuu-core/src/lib.rs:15758) with a single `GoldenPatchPhaseArgs` struct, removing the `#[allow(clippy::too_many_arguments)]` attribute and letting clippy enforce the boundary going forward.",
    deliverables: [
      "New `GoldenPatchPhaseArgs` struct in `crates/kaifuu-core/src/lib.rs` carrying the eleven prior positional parameters as named fields.",
      "Refactored `run_golden_patch_phase` accepting `GoldenPatchPhaseArgs` by value.",
      "All call sites updated to struct-literal form.",
      "Removal of the `#[allow(clippy::too_many_arguments)]` attribute at line 15758.",
    ],
    acceptanceCriteria: [
      "`rg 'clippy::too_many_arguments' crates/kaifuu-core/src/lib.rs` returns zero matches.",
      "`cargo clippy -p kaifuu-core --tests -- -D warnings` succeeds.",
      "All call sites of `run_golden_patch_phase` use the `GoldenPatchPhaseArgs { ... }` struct-literal form (grep verifies).",
      "`cargo test -p kaifuu-core` passes deterministically (no behavioural regression).",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo clippy -p kaifuu-core --tests -- -D warnings",
      },
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-core",
      },
    ],
    auditFocus: [
      "Field order in the struct should match a documented grouping (input vs output vs context), not the prior positional order.",
      "Struct must derive `Debug` so trace logs remain informative.",
      "No clippy `too_many_arguments` re-allow may be reintroduced elsewhere in the crate as a workaround.",
    ],
  },
];

// -----------------------------------------------------------------------------
// Apply
// -----------------------------------------------------------------------------

function main() {
  const dag = loadJson(dagPath);
  const schema = loadJson(schemaPath);

  // Schema sanity check on the existing DAG first.
  validateAgainstSchema(dag, schema, "pre-insertion");

  const existingIds = new Set(dag.nodes.map((node) => node.id));
  const insertedIds = [];
  const skippedIds = [];
  const droppedDependencies = [];

  for (const proposed of NEW_NODES) {
    if (existingIds.has(proposed.id)) {
      console.log(`notice: ${proposed.id} already exists in DAG; skipping insertion.`);
      skippedIds.push(proposed.id);
      continue;
    }
    const node = withFilteredDependsOn(proposed, existingIds, droppedDependencies);
    dag.nodes.push(node);
    existingIds.add(node.id);
    insertedIds.push(node.id);
  }

  // Cross-node dependsOn fix-up for nodes whose new sibling was promised but
  // not yet present: NEW_NODES may depend on each other (e.g. KAIFUU-189 ->
  // KAIFUU-188), which is fine because by the time we reach KAIFUU-189 we have
  // already added KAIFUU-188 to existingIds. Order matters; the array is in
  // sequential order. Re-verify by walking once more.
  for (const node of dag.nodes) {
    if (!NEW_NODES.find((proposed) => proposed.id === node.id)) {
      continue;
    }
    for (const dep of node.dependsOn) {
      if (!existingIds.has(dep)) {
        throw new Error(
          `post-insertion validation: ${node.id} still depends on unknown node ${dep}`,
        );
      }
    }
  }

  validateAgainstSchema(dag, schema, "post-insertion");

  writeFileSync(dagPath, JSON.stringify(dag, null, 2) + "\n");

  for (const { nodeId, missing } of droppedDependencies) {
    console.log(`notice: ${nodeId} dropped dependsOn=${missing} (target id not present in DAG).`);
  }
  console.log(
    `applied 2026-06-24 audit nodes: ${insertedIds.length} inserted, ${skippedIds.length} pre-existing.`,
  );
  console.log(`new DAG node count: ${dag.nodes.length}`);
}

function withFilteredDependsOn(proposed, existingIds, droppedAcc) {
  const kept = [];
  for (const dep of proposed.dependsOn) {
    if (existingIds.has(dep)) {
      kept.push(dep);
    } else {
      droppedAcc.push({ nodeId: proposed.id, missing: dep });
    }
  }
  return { ...proposed, dependsOn: kept };
}

main();
