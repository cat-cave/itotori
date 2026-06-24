# Real-Bytes Validation — kaifuu / utsushi vs Oshioki Sweetie HD

Dated audit, 2026-06-24. Runs every CLI entry point and public library
surface of `kaifuu-*` and `utsushi-*` against the real
**オシオキSweetie＋Sweets!! HD_DL版** bytes at
`/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版/`
("Sweetie HD"). Records exact commands, exit status, observed output,
and the upstream cause of each failure. No edits to `roadmap/spec-dag.json`;
new DAG node proposals appear as patches in §3.

Sibling refs:

- [`docs/audits/code-criticism.md`](code-criticism.md) — earlier verdict that
  detect = false, `parse_archive` returns empty, 98.7% Gameexe keys Unknown.
- [`docs/audits/alpha-scope-honesty.md`](alpha-scope-honesty.md) — calls the
  RealLive chain fixture-shaped relative to real game scale.
- [`docs/research/reallive-engine.md`](../research/reallive-engine.md) —
  format research the chain claims to implement.

Game-data root used throughout (read-only): `/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版/`. Scripts and assets are under
`REALLIVEDATA/` — `Seen.txt` (3,876,496 B), `Gameexe.ini` (51,800 B, 1,345
lines), `g00/` (2,450 files), `koe/` (139 files), `bgm/` (28), `wav/` (73),
`dat/` (`mode.cgm`).

Build: `direnv exec . cargo build -p kaifuu-cli -p utsushi-cli` succeeded;
binaries live at `/scratch/cache/itotori/target/debug/{kaifuu-cli,utsushi-cli}`.

---

## 1. Inventory of entry points probed

Discovered from `crates/*/Cargo.toml` (no `[[bin]]` blocks other than
the default crate binaries; one `[[example]]` per crate) and from the
`match` arms in `kaifuu-cli/src/main.rs:49-200` and
`utsushi-cli/src/main.rs:49-83`.

CLI subcommands (kaifuu): `detect`, `extract`, `asset-inventory`, `patch`,
`diff`, `apply`, `verify`, `golden`, `offset-map`, `helper-result`,
`key-helper`, `helper-registry`, `key`, `siglus`, `rpg-maker`, `profile`,
`capabilities`, `binary-patch-smoke`.

CLI subcommands (utsushi): `capabilities`, `validate-reference-captures`,
`trace`, `capture`, `smoke` (each `trace|capture|smoke` takes
`--adapter {utsushi-fixture, utsushi-browser, utsushi-nwjs}`).

Library surfaces probed directly through a temporary example
`crates/kaifuu-reallive/examples/probe_real_bytes.rs` (read-only on
data, doesn't touch the DAG): `parse_archive`, `parse_scene`,
`parse_gameexe_inventory`.

Not probed (no real-bytes scenario, or pure synthetic-fixture surfaces
gated on `source.json` shape): `kaifuu binary-patch-smoke` (fixture-only
smoke), `kaifuu siglus parser-boundary-smoke` (needs a hand-built
synthetic Scene.pck scene + Gameexe.dat), `kaifuu rpg-maker
validate-fixture-key` (needs a synthetic RPG Maker MV/MZ image asset +
secret store), `kaifuu helper-*` /`key*` (need synthetic helper
manifests), `kaifuu offset-map` / `golden` / `diff` (need pre-produced
extract/patch artifacts), `kaifuu patch` / `apply` (need a `.kaifuu`
PatchExport — none can be produced because `extract` fails).

---

## 2. Per-entry findings

### 2.1 `kaifuu detect <GAME>/REALLIVEDATA --output …`

- Exit 0, output written; reports `kaifuu.reallive` with `detected: false`.
- Failure detail (from `/tmp/itotori-probes/detect-rld.json`): `"RealLive
.g00 image asset count: 0"`, `"RealLive voice archive extension count:
0"`, `"Gameexe.ini RealLive keys matched: #REGNAME, #KOE*, #SEEN*"`,
  `"SEEN.GAN marker is missing"`, `"SEEN.TXT envelope is present but does
not match the synthetic fixture signature"`.
- Status: **loud false negative.** Gameexe key sniff is the only positive
  signal; envelope check rejects real RealLive bytes.
- Upstream causes:
  - `crates/kaifuu-engine-fixture/src/lib.rs:71-73` pins
    `REALLIVE_SEEN_TXT_PATH = "SEEN.TXT"` etc. at the game-dir root, but
    Sweetie HD nests them under `REALLIVEDATA/`.
  - `crates/kaifuu-engine-fixture/src/lib.rs:4672-4699`
    `reallive_extension_counts` only walks direct children, so `.g00` /
    `.koe` evidence is missed when the user points at `REALLIVEDATA/`.
  - `crates/kaifuu-engine-fixture/src/lib.rs:4723-4724`
    `reallive_seen_txt_envelope_ok` rejects `count == 0` — but the real
    envelope begins with eight zero bytes (scene-id 0 unused), so any
    real Sweetie/SiglusKey-era SEEN.TXT trips this check.

### 2.2 `kaifuu detect <GAME> --output …`

- Exit 0, all four adapters report `detected: false`.
- The RealLive adapter's failure detail at the game root is similar but
  worse: `"Gameexe.ini missing"`, `"SEEN.GAN marker is missing"`. The
  detector never looks under `REALLIVEDATA/`.
- Status: **silent miss.** No diagnostic suggests recursing.
- Upstream cause: same as 2.1; the `inspect` flow only checks
  `case_insensitive_find(game_dir, "SEEN.TXT")` at depth 1
  (`lib.rs:3313-3316`).

### 2.3 `kaifuu extract <GAME>/REALLIVEDATA --output …`

- Exit 1, `eprintln`: `"no registered adapter detected [REDACTED:…]"`.
- Status: **gated failure.** Extract is reachable only after `detect = true`
  (`kaifuu-cli/main.rs:62 registered_adapter_for_game`). Same cause as
  2.1/2.2.

### 2.4 `kaifuu asset-inventory <GAME>/REALLIVEDATA --output …`

- Exit 1, same `"no registered adapter"` error. Identical gating.

### 2.5 `kaifuu profile <GAME>/REALLIVEDATA --output …`

- Exit 1, same `"no registered adapter"` error. Identical gating.

### 2.6 `kaifuu verify <GAME>/REALLIVEDATA`

- Exit 1, same `"no registered adapter"` error. Identical gating.

### 2.7 `kaifuu capabilities --output …`

- Exit 0, valid JSON: 4 adapter descriptors
  (`kaifuu.fixture`, `kaifuu.kirikiri_xp3`, `kaifuu.reallive`,
  `kaifuu.siglus`). Static descriptor list, no bytes read.
- Status: **works as designed.** Pure metadata.

### 2.8 `kaifuu-reallive::parse_archive(&Seen.txt bytes)`

- Returns `Ok(SceneIndex { entries: 0, archive_len: 3_876_496 })`.
- Status: **silent zero-state pass.** The function reads `bytes[0..4]`
  as a u32 LE scene count, gets `0x0000_0000`, and exits the loop with
  zero entries. No diagnostic is emitted.
- Upstream cause: `crates/kaifuu-reallive/src/archive.rs:78-105` assumes
  a Haeleth-documented "u32 count + (u32 offset, u32 size) entries"
  envelope. Real RealLive (post-Siglus, including Sweetie HD) ships a
  fixed-size 10,000-entry offset table starting at offset 0; the first
  payload is at offset `0x00013880 = 80,000 = 4 + 8 × 9999`. The 8-byte
  zero prefix is the unused scene-id 0 slot, not a count.

### 2.9 `kaifuu-reallive::parse_scene(payload_bytes, archive_index, scene_offset)`

- Not reached because `parse_archive` produced no entries; the probe
  example skips it. If a scene blob were synthesised manually (e.g., the
  bytes at `Seen.txt[0x13880..]`) the parser would emit
  `kaifuu.reallive.unrecognized_instruction` warnings for every byte
  because real scene bytecode does not use `0x23` (`#`) as an
  instruction opener.
- Status: **wrong-shape parser.** The synthetic-fixture opcode table at
  `crates/kaifuu-reallive/src/lib.rs:86-97` is explicitly documented as
  "intentionally narrower than the real RealLive opcode space."

### 2.10 `kaifuu-reallive::parse_gameexe_inventory(&Gameexe.ini bytes)`

- Returns `entries=1345, bridgeUnits=0, assetReferences=17,
unknown=1328, warnings=1328` (98.7% unknown — matches earlier audit).
- Status: **loud but useless classifier.** Every unknown line gets a
  warning, but the catalogue only recognises `#TITLE` / `#WINTITLE`
  (BridgeUnit), `#REGNAME` / `#GAMEEXE_VERSION` and `#G00*` / `#KOE*` /
  `#SEEN*` / `#NWK*` / `#OVK*` (AssetReference). Sweetie HD's Gameexe.ini
  contains zero `#TITLE` / `#WINTITLE` (so no bridge units) and uses
  hundreds of documented keys
  (`#SCREENSIZE_MOD`, `#SYSTEMCALL_*`, `#WINDOW_ATTR`, `#DISP`,
  `#TEXTPOS`, `#OBJBTN`, etc.) that the classifier doesn't recognise.
- Upstream cause: `crates/kaifuu-reallive/src/gameexe.rs:166-182`
  catalogue is ~10 prefixes; the real RLDEV-documented Gameexe.ini
  surface is ~150+ keys.

### 2.11 `utsushi capabilities --output …`

- Exit 0, valid JSON: 3 runtime adapters
  (`utsushi-fixture`, `utsushi-browser`, `utsushi-nwjs`). Static
  descriptors only.
- Status: **works as designed.**

### 2.12 `utsushi trace <GAME> --output …` (default adapter `utsushi-fixture`)

- Exit 1, stderr `"No such file or directory (os error 2)"`. Output JSON
  not written.
- Status: **wrong-shape input expected.** The fixture adapter at
  `crates/utsushi-fixture/src/lib.rs:141` tries to read
  `game_dir.join("source.json")`. There is no real-game support at all.

### 2.13 `utsushi smoke <GAME> --output …`

- Identical to 2.12.

### 2.14 `utsushi capture <GAME> --adapter utsushi-browser …`

- Exit 1, same `"No such file or directory (os error 2)"`. The
  BrowserLaunchAdapter is also fixture-shaped (looks for an HTML/manifest
  artefact rather than negotiating a real RealLive runtime).

### 2.15 `utsushi validate-reference-captures <manifest>`

- Exit 1 on a missing manifest path. Operates only over a
  `corpus_manifest` JSON; not a real-bytes-anchored operation.

---

## 3. Concrete fixes — proposed DAG nodes

Each entry below proposes a fresh node id, title, summary, primary
acceptance criterion, and the real-bytes scenario that will demonstrate
the fix. IDs were chosen by reading `roadmap/spec-dag.json`: max
existing was `KAIFUU-187` / `UTSUSHI-176`.

### KAIFUU-188 — RealLive detector: recognise the real fixed-table SEEN.TXT envelope

- **Summary.** Replace the synthetic "u32 count + entries" envelope check
  in `kaifuu-reallive::parse_archive`
  (`crates/kaifuu-reallive/src/archive.rs:66-161`) and the matching
  detector probe `reallive_seen_txt_envelope_ok`
  (`crates/kaifuu-engine-fixture/src/lib.rs:4709-4732`) with the
  documented fixed 10,000-entry RealLive offset table: 80,000 bytes of
  `(u32 LE offset, u32 LE size)` records starting at byte 0, with unused
  slots all-zero. Skip zero-size entries; treat nonzero entries with
  `offset >= 80,000` and `offset + size <= archive_len` as valid scenes.
- **Acceptance.** `parse_archive(&fs::read(Sweetie/Seen.txt)?)` returns
  ≥ 1,000 entries (first entry at `byte_offset = 80_000`, `byte_len =
1530`), and `detect` against either the game root or
  `REALLIVEDATA/` reports `kaifuu.reallive` `detected = true` once
  KAIFUU-189 lands.
- **Demonstrating bytes.** First 16 entries of Sweetie HD's
  `REALLIVEDATA/Seen.txt`: slots 0..1 zero, slots 2..7 nonzero starting
  at `0x00013880`, slots 8..9 zero, slot 10 nonzero at `0x00016fe9`.
- **Depends on.** KAIFUU-173 (current synthetic envelope spec).

```json
{
  "id": "KAIFUU-188",
  "status": "planned",
  "title": "Parse real RealLive SEEN.TXT fixed offset-table envelope",
  "priority": "P1",
  "target": "alpha",
  "projects": ["kaifuu"],
  "parallelGroup": "kaifuu-reallive",
  "dependsOn": ["KAIFUU-173"],
  "summary": "Replace the synthetic count-prefixed envelope assumption with the fixed 10,000-entry (u32 offset, u32 size) table that real RealLive SEEN.TXT ships, validated against Sweetie HD's Seen.txt where parse_archive currently returns Ok(entries=0).",
  "acceptanceCriteria": [
    "parse_archive on Sweetie HD's REALLIVEDATA/Seen.txt returns a SceneIndex with >= 1000 nonzero entries.",
    "First valid entry has byte_offset = 80000 (0x13880) and a nonzero byte_len.",
    "Zero-size slot entries are skipped without producing fatal diagnostics."
  ]
}
```

### KAIFUU-189 — RealLive detector: locate REALLIVEDATA/ subdir and corroborating assets recursively

- **Summary.** Teach `RealLiveProfileDetectorAdapter::inspect` and
  `reallive_extension_counts`
  (`crates/kaifuu-engine-fixture/src/lib.rs:3328-3388, 4672-4699`) to
  prefer a `REALLIVEDATA/` subdirectory when present (case-insensitive)
  and scan it for `Seen.txt`, `Gameexe.ini`, `*.g00`, `*.koe`,
  `*.ovk`, `*.nwk`. Today the detector hits depth 1 only, so pointing
  at the game root reports all evidence missing.
- **Acceptance.** `kaifuu detect` on the unmodified Sweetie HD game
  root produces `kaifuu.reallive` with `detected = true`, with evidence
  counts: `g00 ≥ 2400`, `voice archives ≥ 100`, `Gameexe.ini RealLive
keys matched` includes `#REGNAME`, `#KOE*`, `#SEEN*`.
- **Demonstrating bytes.** `find <Sweetie>/REALLIVEDATA -maxdepth 2`
  shows 2,450 `.g00`, 139 `.koe`, `Gameexe.ini`, `Seen.txt`.
- **Depends on.** KAIFUU-188 (envelope check must accept the real
  shape before detection can corroborate).

### KAIFUU-190 — Gameexe.ini classifier: extend catalogue to documented RealLive key surface

- **Summary.** Expand the catalogue in
  `crates/kaifuu-reallive/src/gameexe.rs:166-182` to recognise the full
  RLDEV-documented user-visible and asset key surface (`#WINDOW_ATTR`,
  `#SCREENSIZE_MOD`, `#SYSTEMCALL_*`, `#DISP`, `#TEXTPOS`, `#FACE`,
  `#OBJBTN`, `#WAKU.*`, `#WEATHER.*`, `#GANBMP`, `#BGM*`, etc.) and
  distinguish translatable bridge-unit values (e.g., `#NAMAE`,
  `#CAPTION`, `#NAME.*`) from asset / config references. Today 98.7%
  of Sweetie HD's `Gameexe.ini` lines fall through to
  `GameexeKeyTreatment::Unknown` with paired warnings, drowning genuine
  signal.
- **Acceptance.** On Sweetie HD's `Gameexe.ini`, the unknown share
  drops below 25%, and at least one BridgeUnit is emitted from the real
  file (`#REGNAME` and any future `#WINTITLE`-equivalent translatable).
- **Demonstrating bytes.** `Gameexe.ini` lines 1..30 (visible in
  `head -30 Gameexe.ini`) cover `#MEMORY`, `#DEBUG_*`, `#SCREENSIZE_MOD`,
  `#MMX_ENABLE`, `#D3D_ENABLE`, `#SEEN_START`, `#SEEN_MENU`,
  `#SYSTEMCALL_*` — none recognised today.
- **Depends on.** KAIFUU-174.

### KAIFUU-191 — Scene bytecode parser: real RealLive opcode dispatch (not '#' opener)

- **Summary.** Replace the synthetic `0x23 ('#') opener + named opcode
byte` shape in `crates/kaifuu-reallive/src/parser.rs:36-` with the
  real RealLive byte stream: bare single-byte opcodes, with operand
  layout per opcode (text strings as length-prefixed Shift-JIS,
  control codes `0x80..0xFF` as inline directives). Today
  `parse_scene` would emit `kaifuu.reallive.unrecognized_instruction`
  for every byte of a real scene because the opener byte never matches.
- **Acceptance.** `parse_scene` on the first scene payload of Sweetie
  HD's `Seen.txt` (bytes `[0x13880 .. 0x13880 + 1530]`) returns a
  `ParseOutcome` with `status = Clean` (or `WithWarnings` for known
  control-code gaps) and ≥ 5 recognised `Instruction` nodes; the
  diagnostic-to-instruction ratio is at most 1:1.
- **Demonstrating bytes.** Same scene payload; covers `TextDisplay` /
  `SetSpeaker` analogues that drive the opening of Sweetie HD's title
  flow.
- **Depends on.** KAIFUU-188, KAIFUU-173.

### KAIFUU-192 — Detector evidence rollup: report nested-path discovery in the JSON report

- **Summary.** When the detector follows `REALLIVEDATA/` it should
  surface the resolved subdir in the `DetectionReport.evidence[].path`
  fields and add a new `kaifuu.reallive.nested_data_dir_resolved`
  evidence row, so downstream `extract` / `profile` / `verify`
  invocations don't have to re-discover it. Today the JSON report
  hides the resolved path and shows `path: "SEEN.TXT"` even when the
  detector walks past it.
- **Acceptance.** `kaifuu detect <Sweetie>` includes an evidence row
  with `path = "REALLIVEDATA/Seen.txt"` and status `matched`.
- **Depends on.** KAIFUU-189.

### KAIFUU-193 — `extract` / `profile` / `verify`: define a real-bytes path even for partial detect

- **Summary.** Decouple `extract` / `profile` / `verify`
  (`crates/kaifuu-cli/src/main.rs:59-154`) from the binary
  detect/no-detect gate. When the RealLive adapter reports `detected =
false` but `kaifuu.reallive` gathered nonzero evidence (envelope OK
  but Gameexe.ini key catalogue mismatch, etc.), produce a partial
  profile / inventory with the diagnostic codes attached, rather than
  failing closed with `"no registered adapter detected"`.
- **Acceptance.** On Sweetie HD with KAIFUU-188/189 landed but
  KAIFUU-190/191 not yet, `kaifuu extract` and `kaifuu profile`
  succeed and emit JSON containing the recognised SEEN.TXT envelope and
  Gameexe.ini key counts, plus diagnostics for the unmatched portions.
- **Depends on.** KAIFUU-188, KAIFUU-189.

### UTSUSHI-177 — Runtime fixture adapter: stop requiring `source.json` for real-game probes

- **Summary.** Either teach `utsushi-fixture`
  (`crates/utsushi-fixture/src/lib.rs:141, 549`) to refuse non-fixture
  inputs with a structured `utsushi.unsupported_input_shape` diagnostic
  (instead of `os::Error::NotFound`), or — preferred — introduce a new
  `utsushi-reallive` runtime adapter that observes a RealLive game tree
  and emits structured diagnostics rather than reading a synthetic
  manifest. Today every `utsushi trace|capture|smoke <real-game>`
  invocation dies with `"No such file or directory (os error 2)"`.
- **Acceptance.** `utsushi trace <Sweetie>` exits 1 with a structured
  diagnostic JSON identifying the engine family (`reallive`) and the
  missing port; or, with the new adapter, exits 0 with a non-empty
  runtime observation envelope.
- **Demonstrating bytes.** Same Sweetie HD root.
- **Depends on.** UTSUSHI-103 (substrate facade), KAIFUU-189
  (detector evidence rollup for the engine-family inference).

### UTSUSHI-178 — Browser / NW.js adapters: gate on real-engine match before opening files

- **Summary.** `BrowserLaunchAdapter` / `NwjsLaunchAdapter`
  (`crates/utsushi-fixture/src/lib.rs`) currently call `fs::read` /
  similar on a path that doesn't exist for a RealLive title, producing
  the same opaque `os::Error::NotFound`. They should consult the
  detector first and refuse to launch when the engine family doesn't
  match, with diagnostic `utsushi.engine_family_mismatch`.
- **Acceptance.** `utsushi capture <Sweetie> --adapter utsushi-browser`
  exits 1 with structured JSON pointing at `engine_family_mismatch`
  rather than `os::Error::NotFound`.
- **Depends on.** UTSUSHI-177.

---

## 4. What works today on real bytes

- **Static-metadata CLIs**: `kaifuu capabilities` and `utsushi
capabilities` both produce valid JSON listing the four engine
  adapters and three runtime adapters; these are descriptor-only and
  do not read game bytes. Reproducible via the commands in §5.
- **Gameexe.ini key sniff (partial)**: the detector's small sniff
  catalogue
  (`reallive_gameexe_ini_key_hits`,
  `crates/kaifuu-engine-fixture/src/lib.rs:4738-4771`) does correctly
  identify `#REGNAME`, `#KOE*`, and `#SEEN*` in Sweetie HD's
  `Gameexe.ini`. This is the _only_ genuine positive signal observed.
- **`parse_archive` byte-level safety**: even though it returns
  zero entries, it does not panic or read out of bounds; it correctly
  treats `count = 0` as an empty archive. The behaviour is wrong for
  the real envelope shape, but the failure mode is silent-empty, not
  unsafe.
- **`parse_gameexe_inventory` line walker**: correctly tokenises 1,345
  CRLF lines and decodes the Shift-JIS-rich value bytes. The walker
  itself is sound; only the classifier catalogue is undersized.
- **Detector envelope length math**: `reallive_seen_txt_envelope_ok`
  correctly rejects truncated archives (`required <= file_len` check
  at `lib.rs:4730-4731`). It just happens to reject the real envelope
  for an unrelated reason (`count == 0`).

No `extract`, `patch`, `apply`, `verify`, `profile`, or `asset-inventory`
codepath produces a meaningful artefact on any real-bytes input today;
all are gated on `registered_adapter_for_game` succeeding.

---

## 5. Reproduction recipes

All commands assume the working tree at `/home/trevor/projects/itotori`
and the read-only game tree at the Sweetie HD path above. The
`direnv exec . …` prefix loads the devshell with the cached Cargo
target dir at `/scratch/cache/itotori/target`.

```sh
# Build the two CLIs once.
direnv exec . cargo build -p kaifuu-cli -p utsushi-cli

# Game-data short names.
export GAME='/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版'
export KAIFUU=/scratch/cache/itotori/target/debug/kaifuu-cli
export UTSUSHI=/scratch/cache/itotori/target/debug/utsushi-cli
mkdir -p /tmp/itotori-probes
```

### 5.1 `kaifuu detect`

```sh
direnv exec . "$KAIFUU" detect "$GAME"               --output /tmp/itotori-probes/detect-root.json
direnv exec . "$KAIFUU" detect "$GAME/REALLIVEDATA"  --output /tmp/itotori-probes/detect-rld.json
# Inspect: every adapter `detected: false`; reallive failure detail is
# "SEEN.TXT envelope is present but does not match the synthetic fixture signature".
jq '.detections[] | {adapterId, detected}' /tmp/itotori-probes/detect-rld.json
```

### 5.2 `kaifuu` gated commands (all currently exit 1)

```sh
for cmd in extract asset-inventory profile verify; do
  direnv exec . "$KAIFUU" $cmd "$GAME/REALLIVEDATA" --output "/tmp/itotori-probes/$cmd.json"
  echo "$cmd exit=$?"
done
# Expected: stderr "no registered adapter detected [REDACTED:...]", exit=1.
```

### 5.3 `kaifuu capabilities` (works)

```sh
direnv exec . "$KAIFUU" capabilities --output /tmp/itotori-probes/capabilities.json
jq '.[].adapterId' /tmp/itotori-probes/capabilities.json
```

### 5.4 Library probe: `parse_archive` / `parse_scene` /

`parse_gameexe_inventory`

The doc-time example at
`crates/kaifuu-reallive/examples/probe_real_bytes.rs` is read-only on
the input bytes. Re-run via:

```sh
KAIFUU_PROBE_SEEN_TXT="$GAME/REALLIVEDATA/Seen.txt" \
KAIFUU_PROBE_GAMEEXE_INI="$GAME/REALLIVEDATA/Gameexe.ini" \
direnv exec . cargo run -p kaifuu-reallive --example probe_real_bytes
```

Expected output: `parse_archive: OK, … entries=0`, then
`parse_gameexe_inventory: entries=1345 bridge=0 asset_ref=17
unknown=1328 warnings=1328 / unknown-key share: 98.7%`.

### 5.5 `utsushi capabilities` (works)

```sh
direnv exec . "$UTSUSHI" capabilities --output /tmp/itotori-probes/utsushi-caps.json
jq '.runtimeAdapters[].adapterName' /tmp/itotori-probes/utsushi-caps.json
```

### 5.6 `utsushi` real-game probes (all fail with `os error 2`)

```sh
for cmd in trace capture smoke; do
  direnv exec . "$UTSUSHI" $cmd "$GAME" --output "/tmp/itotori-probes/utsushi-$cmd.json"
  echo "$cmd exit=$?"
done
# Expected: stderr "No such file or directory (os error 2)", exit=1.
```

### 5.7 Header inspection (helps future engineers correlate envelope shape)

```sh
xxd -l 256 "$GAME/REALLIVEDATA/Seen.txt"
# First 8 bytes are 00; next u32 LE = 0x00013880 = 80000 = 4 + 8*9999, which is
# the documented RealLive fixed-table layout (10,000 slots * 8 bytes).
```

---

Generated 2026-06-24. No edits made to `roadmap/spec-dag.json` or to
any source under `crates/`. The temporary probe example at
`crates/kaifuu-reallive/examples/probe_real_bytes.rs` is the only file
added; it is read-only on game data and can be removed without
regressing CI.
