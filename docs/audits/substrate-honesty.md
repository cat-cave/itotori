# UTSUSHI substrate honesty audit

> **⚠️ SUPERSEDED 2026-07-11.** This audit predates the real RealLive engine
> port. Its "functionally fixture-shaped" / "no engine port crate exists"
> framing is stale: `crates/utsushi-reallive/` now ships a real VM
> (`src/vm.rs`, `src/engine_port.rs`), a render pipeline (`src/render_pipeline.rs`,
> swash rasterization), branch replay, and honest E0/E1/E2 evidence tiers — the
> RealLive runtime is a real interpreter+rasterizer at **E2**, not a facade. The
> `#[ignore]`/env-gated real-bytes proofs run under `just ci-real-bytes` /
> `just real-bytes-oracle`. Retained below as the historical record of the
> substrate cascade; for current reality see
> [`../localize-reallive.md`](../localize-reallive.md) and
> [`../utsushi-fidelity-policy.md`](../utsushi-fidelity-policy.md).

Status: audit, no code changes. Scope: UTSUSHI-020..120 substrate cascade,
audited against a hypothetical RealLive engine port for
**オシオキSweetie＋Sweets!! HD_DL版** ("Sweetie HD") under
`/scratch/itotori-research/sweetie-hd/extracted/`.

## 0. Headline

The substrate is **architecturally credible** (it factors the right
subsystems and pins schema versions) but **functionally fixture-shaped**
in critical places: the only production consumer of any substrate type
in the workspace is `utsushi_core` itself plus its in-tree
`tests/substrate_conformance.rs`. The `utsushi-fixture` adapter does
not implement `EnginePort`, does not emit through any sink trait, and
does not snapshot through `Inspectable`/`Restorable`; it ships the
legacy `RuntimeAdapter` and synthesises `ObservationHookEvent` directly.
The `kaifuu-reallive` crate has **zero** dependency on `utsushi-core`.

Concretely, the cascade closed UTSUSHI-020..120 without ever
round-tripping the substrate through a real engine port — not even a
synthetic one. Every test the substrate self-validates with is a
substrate-internal collector struct (`CollectingTextSink`,
`CollectingFrameSink`, `CollectingAudioSink`) declared inside
`#[cfg(test)]` modules in the same files as the trait. The closed-world
nature is structural, not incidental.

Verdict counts (sections A..K): substrate-sufficient 1, minor-extension
2, substantial-gap 5, wrong-shape 3.

---

## A. VFS (UTSUSHI-020) — **substantial-gap**

### Provides

- `AssetId` (`crates/utsushi-core/src/vfs/id.rs:42`): wire form
  `vfs://<package-id>/<normalized-path>`. Package id is forced
  `[a-z0-9][a-z0-9._-]{0,62}` ASCII lowercase
  (`crates/utsushi-core/src/vfs/id.rs:188`).
- `RuntimeVfs` trait + `MountedVfs` composition by package-id prefix
  (`crates/utsushi-core/src/vfs/runtime.rs:26`).
- `AssetPackage` read-only trait (`resolve`, `exists`, `stat`, `open`,
  `list`) with `CaseRule::{Sensitive, InsensitiveAscii}`
  (`crates/utsushi-core/src/vfs/package.rs:180`).
- One concrete impl: `PlaintextDirPackage` over `std::fs`
  (`crates/utsushi-core/src/vfs/runtime.rs:152`). No archive impl, no
  composite impl.

### What the fixture adapter uses

Nothing. `utsushi-fixture` reads `source.json` via `std::fs` directly
(`crates/utsushi-fixture/src/lib.rs:140`). No `RuntimeVfs`, no
`AssetPackage`. The `RuntimeVfs` lives in `PortRequest::vfs` as an
`Option<Arc<dyn RuntimeVfs>>` (`crates/utsushi-core/src/port/trait_.rs:97`),
and no port in the workspace populates it.

### What a Sweetie HD RealLive port would need

Gameexe declares 13 `#FOLDNAME.*` entries each of the form
`#FOLDNAME.G00 = "G00" = 0 : "G00.PAK"` — i.e. **per-asset-kind
dual-source: try directory `G00/`, fall back to `G00.PAK` archive**.
Sweetie HD's tree happens to have only `g00/` (2450 files) without the
`.PAK` archive, but the engine port can't depend on that — the
substrate has to be able to express both forms because other RealLive
titles populate the `.PAK` alongside or instead of the dir, and a Wine
runner replaying Gameexe semantics has to mirror RealLive's
look-in-dir-then-archive resolution.

Sweetie HD ground-truth corpus visible in the vault:

- 2450 g00 (image), 139 koe (`.ovk` voice container), 28 bgm (`.nwa`),
  1 Seen.txt (3.88 MB), 24 KB `REALLIVE.sav` save.
- Gameexe is **Shift-JIS encoded** (folder string contains 0x83 etc.),
  not UTF-8.
- Stored file casing is **UPPERCASE** (`BG01A1.g00`) but RealLive
  references are case-insensitive (Gameexe says
  `#FOLDNAME.G00 = "G00"` while disk holds `g00/`).

### Concrete gaps

1. **No composite/archive package kind in the read-model.**
   `PackageKind::{Plaintext, Archive, Composite}` is declared
   (`vfs/package.rs:126`) but only `Plaintext` is implemented. There
   is no facade-exported archive helper, no PAK opener, no overlay
   resolver, no `try-dir-then-archive` policy primitive. The engine
   port would have to implement `AssetPackage` from scratch — i.e. the
   substrate provides only a trait, not a primitive for the multiplexed
   layout RealLive titles actually use.

2. **Package id grammar is wrong shape for RealLive.** `AssetId`
   requires `[a-z0-9]` lowercase ASCII. Sweetie HD's asset roots are
   uppercase short tokens (`G00`, `BGM`, `KOE`). The engine port can
   either (a) downcase, breaking back-mapping to Gameexe's
   `#FOLDNAME.G00` keys, or (b) prefix-with-something to shoehorn
   in. Neither is sound — the engine port wants
   `vfs://reallive.g00/BG01A1.G00`, and the substrate forbids the
   dot-prefix package id pattern most cleanly. (`vfs/id.rs:188` allows
   `.` inside but rejects uppercase, so `reallive.g00` works only if
   lowercased.) This is a downstream-survivable annoyance, not a
   showstopper, but it's a fixture-shape tell: the synthetic fixture
   only ever needs `"hello"` / `"www"` / `"lex"`.

3. **`CaseRule::InsensitiveAscii` requires a `read_dir` walk to recover
   the stored case on every `resolve`** (`vfs/runtime.rs:282`). For a
   2450-file `g00/` directory walked per asset open this is
   O(directory) per lookup. The fixture's 1-3 file directories never
   surface this. A real port needs a case-folded directory index, not
   a linear scan.

4. **No "logical asset id" namespace separate from VFS path.** RealLive
   bytecode references images as `"S001A"` and resolves to
   `g00/S001A.g00` per Gameexe `#FOLDNAME.G00`. The substrate has no
   first-class concept of an engine-supplied logical id that resolves
   through a Gameexe-style lookup table; the engine port has to embed
   that mapping inside its `AssetPackage::resolve` implementation,
   which makes the substrate's `resolve(logical: &str)` essentially a
   string-passthrough.

5. **No revision/content-hash provenance the engine actually exposes.**
   `AssetMetadata::revision: Option<String>` is set by the package
   adapter, but the substrate offers no way to plumb the Sweetie HD
   `read.sav` / save data fingerprint (which the engine state would
   need to round-trip) through a stable channel.

---

## B. Clock (UTSUSHI-021) — **substantial-gap (shape mismatch)**

### Provides

- `LogicalClock` (`crates/utsushi-core/src/clock.rs:46`): a `u64`
  monotonic tick with `RunStart` / `SnapshotRestore` origin enum.
- `tick()` advances by 1, `advance_to(target)` jumps to an explicit
  tick (rejects backtrack).

### What the fixture adapter uses

Nothing in `utsushi-fixture/src/lib.rs`. The `jump_targets` submodule
references `LogicalClockTick` as a value type but does not drive a
clock (`crates/utsushi-fixture/src/jump_targets.rs:53`).

### What a Sweetie HD RealLive port would need

RealLive bytecode includes timing-bearing opcodes:

- `Pause` (NamedOpcode 0x08, `crates/kaifuu-reallive/src/opcodes.rs`)
- Gameexe-driven wait macros: `#SHAKE.000=(000,032,050)(032,032,050)...`
  encodes per-step (dx, dy, **duration_ms**) tuples — the third
  argument is wall-clock milliseconds (50 ms per shake step).
- `#SHAKEZOOM`, `#WAIT*` directives the engine schedules animation
  against host frame time.
- `#BGM_KOEFADE_VOL=180` plus fade-time directives that interpolate
  per-millisecond.

### Concrete gaps

1. **No frame / wall-clock dimension on the clock.** A `u64` tick
   counter that advances "once per consumed input" cannot represent
   "wait 50 ms then continue" without the engine port inventing a
   ticks-per-millisecond convention out-of-band. The substrate has no
   place to assert "this run advanced N logical ticks corresponding to
   M ms of in-engine wait."

2. **The doc-comment says "one tick per consumed input"** (`clock.rs:6`).
   That model presumes a discrete input-driven runtime, which is what
   the synthetic fixture is. RealLive runs free-running between input
   waits; an engine port using this clock would have to synthesise
   fake ticks at every animation step to keep the tick semantics
   meaningful, defeating determinism.

3. **No way for the snapshot/replay tail to know what wall-clock
   duration a tick range corresponds to.** Replay determinism is
   guaranteed at the input-event level, but Sweetie HD's `#SHAKE.000`
   sequence (8 frames at 50 ms each = 400 ms) plays differently when
   the engine port's wait-loop tick rate is unspecified.

Net: the clock is sufficient for "advance through a scripted input
sequence" (which is what fixture replay does) and insufficient for
"replay a real game's frame timing."

---

## C. Input (UTSUSHI-021) — **wrong-shape**

### Provides

- 10 `InputKind` variants: `Text`, `Choice`, `Advance`, `Skip`, `Auto`,
  `Save`, `Load`, `MenuSelect`, `Pointer`, `Raw`
  (`crates/utsushi-core/src/input.rs:41`).
- `Pointer { x: f32, y: f32, button: PointerButton }` in **normalized
  `[0.0, 1.0]` coordinates** (`input.rs:194`).
- `MenuSelect { target: MenuTarget { menu_id, item_id } }` with
  string ids only — **explicitly not screen coordinates**
  (`input.rs:120`).
- `Raw { code: RawInputCode { engine, code } }` escape hatch
  (`input.rs:201`).

### What the fixture adapter uses

Nothing.

### Sweetie HD reality

```
#MOUSEACTIONCALL.000.MOD=1
#MOUSEACTIONCALL.000.SEEN=9999,30
#MOUSEACTIONCALL.000.AREA=1232,0,1279,719
#SCREENSIZE_MOD=999,1280,720
```

This is a **rectangular hit area in physical screen coordinates**
(1232 ≤ x ≤ 1279, 0 ≤ y ≤ 719 at 1280×720) that, when clicked, jumps
to scene 9999.30 (the system menu).

```
#SYSTEMCALL_SAVE=9999,20
#SYSTEMCALL_LOAD=9999,21
#SYSTEMCALL_SYSTEM=9999,22
```

The save/load/system-menu entry points are also (scene, line) targets,
not button presses.

### Concrete gaps

1. **Mouse area trigger is not expressible.** The substrate ruled out
   screen coordinates by design (`MenuTarget` doc: "stable string id,
   not a screen index", `input.rs:120`). A RealLive engine port has to
   round-trip MOUSEACTIONCALL through `InputEvent::Raw`, which by
   definition the substrate "does not model" (`input.rs:200`), losing
   all replay structure. The substrate's pointer event is in
   normalized `[0.0, 1.0]` — fine for replay determinism, but the
   engine port can't bind a pointer event to "this MOUSEACTIONCALL hit
   area fired" without round-tripping pixel coords through `Raw`.

2. **No engine-system-call distinction.** `Save`/`Load` map to slot
   integers, but RealLive's `SYSTEMCALL_SAVE=9999,20` is a _scene
   jump_, not a slot save — the substrate's `Save { slot: u16 }`
   variant has no model for "the engine entered its save menu and the
   user picked slot N from inside the engine's UI." This is an honest
   modeling decision but it does mean replay logs for a Sweetie HD
   port cannot round-trip the save menu without `Raw` opacity.

3. **No "wait completed" / "pause expired" input.** A `Pause` opcode
   in a RealLive scene advances when its timer expires; no user input
   fires. The substrate has no clock-driven advance shape; the engine
   port must synthesise an `Advance {}` at the right tick, which is
   only deterministic if section B is fixed first.

### Verdict

Wrong shape for RealLive specifically — the substrate's input model
was designed for "click-driven VN with menus" and rules out the
coordinate-bound triggers that Gameexe declares natively. Round-tripping
through `Raw` defeats the substrate's own conformance value (raw
events are opaque, `input.rs:200`).

---

## D. Replay (UTSUSHI-021) — **minor-extension-needed**

### Provides

- `ReplayLog` + `ReplayLogBuilder` with tick monotonicity, payload
  validation, and end-to-end redaction sweep
  (`crates/utsushi-core/src/replay.rs:88`).
- Schema version pin `0.1.0-alpha` (`replay.rs:34`).
- Asset-ref list (deduped, insertion-ordered, `replay.rs:160`).

### What the fixture adapter uses

Indirectly: `jump_targets.rs` defines a fixture concept of
"jump targets" with logical-tick anchors and computes a `ReplayLog`
fingerprint (`crates/utsushi-fixture/src/jump_targets.rs:157`). But it
does not actually drive a `ReplayLog` through a runtime.

### Sweetie HD reality

A scene #0001 replay would need to:

1. Boot via Gameexe (1345 directives → engine state).
2. Enter Seen.txt scene 1 (Seen.txt is 3.88 MB).
3. Issue a few hundred `TextDisplay` + `SetSpeaker` advances.
4. Hit a `Choice` opcode → user picks index N.
5. Continue until `Return` or scene exit.

### Concrete gaps

1. **`Choice { index }` is sufficient**, modulo the input-shape gap
   in C.
2. **No "scene jump" or "scenario position" tick anchor.** A
   `ReplayLog` records ticks + events; it does not record "we are now
   at Seen.txt offset X" so a snapshot-restore-then-tail-replay scheme
   has no built-in way to assert the post-restore scenario position
   matches the recording. (UTSUSHI-104 "MomentId" exists as a stub in
   `port/trait_.rs:30` but is opaque and not threaded into
   `ReplayLog`.)
3. The `metadata.source_label` field (`replay.rs:74`) is a single
   `Option<String>`; Sweetie HD recordings would want a Gameexe
   fingerprint AND a Seen.txt revision AND a saved-data fingerprint
   to bind replay validity. Doable through a follow-up minor schema
   bump.

Net: replay is the soundest piece of the cascade for an engine port.
The gaps are minor schema extensions, not shape mismatches.

---

## E. Snapshot (UTSUSHI-023) — **wrong-shape (size + namespace)**

### Provides

- 6 `StateNamespace` roots: `runtime`, `replay`, `bridge`, `vfs`,
  `port`, `metadata` (`crates/utsushi-core/src/snapshot/state.rs:49`).
- 9 `StateValue` variants: `String`, `Int`, `Uint`, `Bool`, `AssetId`,
  `Bytes` (hash+sample), `Tick`, `List`, `Nested`
  (`state.rs:313`).
- **`SNAPSHOT_MAX_SERIALIZED_BYTES = 16 * 1024` (16 KiB)**
  (`snapshot/snapshot.rs:19`).
- `STATE_TREE_MAX_SERIALIZED_BYTES = 12 * 1024` (12 KiB) inside the
  envelope (`state.rs:37`).
- `MAX_STATE_PATH_BYTES = 512`, `MAX_STATE_PATH_SEGMENTS = 12`
  (`state.rs:40`).

### What the fixture adapter uses

Nothing in production; `RuntimePlaybackFeature::Snapshot` is declared
`Unsupported` (`utsushi-fixture/src/lib.rs:223`). Tests in
`crates/utsushi-core/tests/snapshot_*.rs` use synthetic `Inspectable`
struct impls.

### Sweetie HD reality

Save files on disk:

- `SAVEDATA/save999.sav`: 6748 bytes.
- `SAVEDATA/REALLIVE.sav`: 24876 bytes.
- `SAVEDATA/read.sav`: read-history (per-line-seen flags) — typically
  much larger because every Seen.txt line has a flag.

RealLive scratchpad (from RLDEV documentation referenced in
`kaifuu-reallive/src/lib.rs:8`):

- ~50 integer banks × ~2000 entries each = `intK[]`, `intL[]`, ...,
  `intM[]` family.
- String variable bank `strS[]`, `strM[]` of bounded but large
  capacity.
- Global vars `globalvars` and read-mark bitset per scene line.
- Graphics layer state: ~256 "objects" per `#OBJECT_MAX=256`
  (Gameexe), each with composite parameters.

### Concrete gaps

1. **The 16 KiB envelope ceiling is below RealLive's actual save
   size.** Sweetie HD's `REALLIVE.sav` is 24876 bytes raw, and the
   normalised state-tree representation (with per-int and per-str
   slots as separate `StateValue`s under `port.intvars.*` /
   `port.strvars.*`) will be much larger after JSON encoding. The
   substrate's snapshot primitive cannot hold a RealLive game state by
   construction. The 12 KiB inner-tree limit is even tighter. This is
   not a soft suggestion: `Snapshot::validate` rejects with
   `SnapshotError::Oversize` (`snapshot/snapshot.rs:328`). A real
   engine port would have to either (a) elide most state into
   `BytesValue` hashes (defeating inspectability and the "diff names
   the path verbatim" conformance claim) or (b) shard across multiple
   snapshots without substrate support.

2. **`port.*` is the only escape hatch.** All RealLive scratchpad would
   land under `port.intvars.int_k.0`, etc. Per-int slots blow through
   `MAX_STATE_PATH_SEGMENTS = 12` if any nesting is used (it isn't
   needed here, but graphics layer state like
   `port.gfx.objects.250.attr.alpha` is 5 segments and fine — until
   you nest sub-attributes). Workable but tightly bounded.

3. **No bytes-passthrough for the engine save format.** A RealLive
   port that wanted to round-trip a save file as a single
   inspectable-but-opaque chunk would use `BytesValue`, which forces a
   hash and bounded 64-byte sample (`state.rs:27`). Restore would
   need to come from somewhere else (the engine, not the snapshot) —
   defeating the substrate's restore-from-snapshot claim.

4. **Graphics layer state has no schema affordance.** RealLive carries
   ~256 `OBJECT.NNN` per Gameexe (8 ints each plus a g00 reference).
   At 8 entries × 256 objects × ~80 bytes serialised JSON each =
   ~160 KB — 10x the ceiling. The substrate would have to skip
   graphics, which means a restore can't actually restore the screen
   state.

### Verdict

The snapshot envelope is sized for a fixture that has perhaps 8–16
typed fields. Sweetie HD's minimum useful state-tree is 50–500x
larger. This is the single most fixture-shaped subsystem in the cascade.

---

## F. Sinks (UTSUSHI-022) — **substantial-gap**

### Provides three sink contracts

- `TextSurfaceSink::emit_line(TextLine)` — E1 ceiling
  (`crates/utsushi-core/src/sink/text.rs:19`). `TextLine` carries
  optional `speaker`, `text_surface`, `bridge_ref`, `source_asset`.
- `FrameArtifactSink::emit_frame(FrameArtifact)` — E2 floor, E4 ceiling.
  `FrameArtifact` is **announcement-only**: it carries an
  `ObservationArtifactRef` URI, never bytes
  (`crates/utsushi-core/src/sink/frame.rs:37`). The artifact
  must live under `RUNTIME_ARTIFACT_URI_ROOT = "artifacts/utsushi/runtime/"`
  and `artifact_kind` must be in
  `["screenshot", "frame_capture", "recording"]` (`frame.rs:17`).
- `AudioEventSink::emit_event(AudioEvent)` — E0 only
  (`crates/utsushi-core/src/sink/audio.rs:14`). 6 `AudioEventKind`
  variants: `BgmStart`, `BgmStop`, `SeFire`, `VoicePlay`, `VoiceStop`,
  `Marker`.

### What the fixture adapter uses

Nothing. `utsushi-fixture` builds `ObservationHookEvent` payloads
directly (`utsushi-fixture/src/lib.rs:335,367`) using the legacy
`ObservationTextPayload` / `ObservationFramePayload` types
(`utsushi-core/src/lib.rs:1542,1630`), not `TextLine` / `FrameArtifact`
/ `AudioEvent`. The substrate sinks have **no production producer**.

### Sweetie HD reality

- **Text:** RealLive `TextDisplay` opcodes emit Shift-JIS strings. Each
  line may have a speaker (set via `SetSpeaker`), ruby annotations
  (`<ruby><rb>...</rb><rt>...</rt></ruby>`-style control codes), and
  in-line styling (color/bold control codes inside the string).
  Sweetie HD's `Seen.txt` is 3.88 MB of bytecode — many thousands of
  lines.
- **Frame:** A frame is a composition of `OBJECT_MAX=256` graphics
  layers each pointing at a g00 image. Sweetie HD ships 2450 g00s.
  A capture is "the layer composite at this tick."
- **Audio:** BGM directives (`#BGM_KOEFADE_VOL=180`,
  `#BGM_KOEFADE_USE=1`) imply per-frame cross-fades. Voice playback is
  driven by per-line `koe` references (Sweetie HD has 139 `.ovk`
  voice containers covering many tens of thousands of voice clips).
  `KOEONOFF.NNN` defines per-speaker voice-enable toggles
  (`KOEONOFF.005.(000,002,003,004).ON` covers four speakers).

### Concrete gaps

1. **`TextLine.text: String` cannot carry ruby/inline style.** It's
   "post-decoding, post-engine-text-substitution" (`text.rs:42`). Ruby
   and styled spans are core to RealLive content; the engine port has
   to either strip them (losing fidelity) or encode them as markup
   inside the string (defeating the "engine-neutral string" pretense).
   The substrate's `TextLine` has no companion "annotation span"
   field.

2. **Frame sink is announcement-only with E2 floor and tightly
   bounded artifact-kind allow-list.** A RealLive layer-composite
   capture is fine. But the substrate's `FrameArtifact` cannot model
   the layer state itself (`width`/`height` are pixel dimensions,
   informational only, `frame.rs:51`). For deterministic frame
   capture, the port has to render to PNG/etc. and announce the URI;
   the substrate has no concept of "frame = list of (layer_index,
   asset_id, transform, blend_mode)" which is what RealLive actually
   produces. So "frame capture" through this substrate means "the
   port renders bytes and stores them" — a much heavier requirement
   than the fixture's "the port writes 53 bytes of placeholder text"
   (`utsushi-fixture/src/lib.rs:489`).

3. **`AudioEventKind` is too coarse.** No `BgmCrossfade`, no
   `BgmFadeOut(duration)`, no per-voice subtitle binding beyond a
   single `bridge_ref`. Sweetie HD's `KOEONOFF` per-speaker masking
   has no expression. The doc comment says voice-subtitle sync is "a
   deliberate follow-up" (`audio.rs:67`), which honestly admits this.

4. **No "scene transition" or "screen clear" sink event.** RealLive
   has `ClearScreen` (NamedOpcode 0x07). The text sink can emit a
   line, the frame sink can announce a capture, but the substrate has
   nowhere to record "the engine just cleared the screen and switched
   scenes" as a first-class evidence event. This is what
   `bridge_unit_id` was supposed to anchor against, but the substrate
   has no bridge-emit verb.

5. **E0 audio ceiling is incompatible with replay determinism claims.**
   The substrate explicitly forbids audio at E1+ (`audio.rs:21`)
   because "audio events do not prove playback parity." A RealLive
   replay deterministically chooses BGM/voice cues based on opcode
   execution; an engine port can verifiably claim E1 audio parity
   (BGM cue ID and voice file ID match the recording), but the
   substrate refuses to record the claim. This is a policy gap, not a
   shape gap, but it forces the engine port to either lie about audio
   or stay silent.

---

## G. Recorder (UTSUSHI-060) — **substantial-gap**

### Provides

- `InMemoryReferenceRecorder` → `ReferenceTrace` JSON
  (`crates/utsushi-core/src/recorder/builder.rs`).
- `ReferenceTrace` carries: `text_events: Vec<TextLine>`,
  `capability_state: Vec<EmbedCapability>`, `snapshot_refs:
Vec<SnapshotRef>`, `replay_events: Vec<ReplayEntry>`
  (`crates/utsushi-core/src/recorder/trace.rs:49`).
- `SourceTag::{Browser, Native, Wine, Fixture}` — exactly four engine-
  neutral values, **policed by const-assert in `substrate.rs:132`**.

### What the fixture adapter uses

`SourceTag` only, indirectly via tests. No production
`ReferenceRecorder` consumer exists.

### Sweetie HD reality + concrete gaps

1. **`ReferenceTrace` has no `frame_artifacts` or `audio_events`
   field.** A Sweetie HD scene #0001 recording with BGM, voice, and
   layer composites cannot be captured into a `ReferenceTrace`. The
   doc admits "No frame / audio artifact recording" as a follow-up
   (`recorder/mod.rs:31`). The gap is honest but real.

2. **`SourceTag` is too coarse.** Sweetie HD running under Wine is
   `SourceTag::Wine`; the same game running under a hypothetical
   native Rust RealLive port is `SourceTag::Native`. The substrate
   cannot distinguish "Wine-wrapped real RealLive.exe" from "native
   port of RealLive opcodes" — but a conformance check that compares
   the two MUST distinguish them, otherwise it's comparing the
   reference against itself.

3. **The const-asserted 4-variant ceiling on `SourceTag`
   (`substrate.rs:132`) actively prevents adding the distinction.**
   A facade revision is required to add a variant. This is the right
   gate but the variants the substrate currently exposes do not
   factor the producer-identity axis a real comparison needs.

---

## H. Embed (UTSUSHI-024) — **substrate-sufficient (within scope)**

### Provides

- `EmbedState` envelope (32 KiB) carrying `adapter_id`,
  `capabilities`, `trace`, `current_snapshot`, `artifact_refs`
  (`crates/utsushi-core/src/embed/state.rs:34`).
- `EmbedCapability` discovery surface
  (`crates/utsushi-core/src/embed/capability.rs`).

### Verdict

The embed ABI is the most genuinely engine-neutral piece — it's
literally a JSON envelope with a trace window, snapshot ref, and
artifact refs. A RealLive port would surface state through this just
as the fixture would. The 32 KiB ceiling is twice the snapshot
ceiling, so the snapshot ceiling problem (section E) caps the embed
envelope's usefulness, but the embed shape itself doesn't add
fixture-bias.

Minor caveat: `EmbedTrace::MAX_LINES = 256` (`embed/state.rs:39`) is
tight for a real Seen.txt scene that emits thousands of text lines.
Trace pagination is "deferred to a follow-up slice"
(`embed/state.rs:38`).

---

## I. Port (UTSUSHI-103) — **wrong-shape**

### Provides

- `EnginePort` trait (`crates/utsushi-core/src/port/trait_.rs:204`)
  with `const MANIFEST: PortManifest` (associated const, not associated
  type).
- `PortManifest` is a `&'static`-everywhere struct
  (`crates/utsushi-core/src/port/manifest.rs:229`) holding
  `&'static [PortCapability]`, `&'static [LifecycleStage]`,
  `&'static [EnvFieldSchema]`, `&'static [&'static str]` limitations,
  and `fidelity_tier_max` / `evidence_tier_max`.
- 5 `LifecycleStage`s: Launch, Observe, Capture, Jump, Shutdown.
- `Runner` validates manifest, enforces ABI version (1 only), drains
  observations (cap 4096), enforces artifact-root containment
  (`crates/utsushi-core/src/port/runner.rs`).

### What the fixture adapter uses

**Nothing.** `utsushi-fixture` still implements the legacy
`RuntimeAdapter` trait (`utsushi-fixture/src/lib.rs:43`), not
`EnginePort`. The `Runner` has no production consumers.

### Sweetie HD reality + concrete gaps

1. **`EnginePort::observe` returns `Option<ObservationHookEvent>`
   (`port/trait_.rs:223`)** — the LEGACY observation type from
   `lib.rs:1268`, NOT the new substrate sink types. So even when an
   engine port is implemented against `EnginePort`, it does not emit
   through `TextSurfaceSink` / `FrameArtifactSink` / `AudioEventSink`.
   **The new sinks are unreachable from `EnginePort`.** This is the
   single biggest fixture-shape tell: the substrate's most polished
   subsystem (sinks) is not wired to the substrate's main port trait.

2. **`PortManifest` is `&'static` everywhere.** Fine for a ported
   engine compiled into the binary. But `RuntimeVfs`, `AssetPackage`,
   `Inspectable`, `Restorable` are all dynamic-dispatched and stateful,
   so the const manifest cannot statically describe "this port
   carries an inspectable surface with these state-tree namespaces" —
   only the runtime can. The substrate has no `port-declares-snapshot-
surface` const that would prove a manifest's claims at compile
   time.

3. **`MomentId` is an opaque string with one synthetic constructor**
   (`port/trait_.rs:30`). For a RealLive port to support `jump` to
   "Seen.txt scene 4 line 17", it round-trips through an
   engine-defined string format. The substrate does not provide a
   moment-id namespace mechanism — every port invents its own. That
   defeats the cross-port comparison the substrate would otherwise
   enable.

4. **`PortCapability::{Snapshot, DeterministicReplay}` are explicitly
   "inert at this ABI version"** (`port/manifest.rs:15`). A port can
   declare them in MANIFEST but the runner does nothing with them.
   This is honest deferral, but it means the substrate's UTSUSHI-023
   (snapshot) and UTSUSHI-021 (replay) work isn't reachable through
   the official port trait — a port using snapshot/replay has to
   bypass `Runner` entirely.

---

## J. Conformance (UTSUSHI-026/027/028/029) — **substantial-gap**

### Provides

- 6 `ProfileId`s: `TextTrace`, `BranchCapture`, `SnapshotRestore`,
  `FrameCapture`, `RecordingCapture`, `DeterministicReplay`
  (`crates/utsushi-core/src/conformance/mod.rs:67`).
- `ConformanceManifest`, `ConformanceResult` (Pass/Fail/Skip/Unsupported
  with cross-validation, `mod.rs:159`).
- 4 evidence tiers `E0..E4`; profile ceilings: text/branch/snapshot/
  replay → E1, frame/recording → E2.

### Sweetie HD reality + concrete gaps

1. **No audio-parity profile.** Sweetie HD has 28 BGM and 139 voice
   containers. Even at E0, the substrate has no
   `ProfileId::AudioEventTrace`. The audio sink exists; conformance
   ignores it.

2. **No "Gameexe inventory parity" profile.** A useful claim a real
   RealLive port could make is "I read 1345 Gameexe directives and
   recognised N of them." There is no profile that verifies the port
   ingested its config correctly. The substrate has nothing to bind
   `kaifuu-reallive::parse_gameexe_inventory` evidence to.

3. **No scene-coverage profile.** "I drove the engine through scenes
   1..N and observed text events for each line" is a primary value
   prop for the port; the substrate's `TextTrace` profile is
   per-trace, not per-corpus. Sweetie HD has 1 Seen.txt covering
   many scenes — coverage would be the headline evidence.

4. **Evidence tiers `E0..E4` work for declarative pinning, but the
   tier ceilings for profiles** (`mod.rs:136`) **were chosen at slice
   commit time without a real-engine producer to validate them
   against.** `SnapshotRestore → E1` is questionable: if a RealLive
   port byte-equality-restores its full state tree, that's at least
   E2 (artifact-store-backed evidence). The ceilings are
   fixture-anchored.

5. **`Skip ≠ Pass` enforcement is good** (`mod.rs:208`). The cross-
   validation surface is the soundest part of the conformance work.

---

## K. Substrate facade (UTSUSHI-120) — **correct, but cosmetic**

### Provides

- Single `utsushi_core::substrate` import root re-exporting ~70
  symbols (`crates/utsushi-core/src/substrate.rs:22`).
- Const-asserted schema-version pins for all five wire schemas
  (`substrate.rs:115`).
- Const-asserted `SourceTag` four-variant lock (`substrate.rs:132`).
- Engine-neutrality lint forbidding RealLive/Siglus/RPGM/Kirikiri/XP3
  substrings in the facade source and docs
  (`crates/utsushi-core/tests/substrate_conformance.rs:708`).

### Will the engine-neutrality lint block legitimate consumption?

**No.** The lint sweeps `crates/utsushi-core/src/substrate.rs` and
`docs/utsushi-substrate-facade.md` only — not consumer crates. A
`crates/utsushi-reallive/` port crate would have "RealLive" in its
name and source and that's fine. The lint correctly guards the facade,
not consumers.

### Real concern

The facade is **load-bearing only if there are consumers**. Today
there is exactly one consumer:
`crates/utsushi-core/tests/substrate_conformance.rs`. The facade
contract's value ("future extraction is source-level back-compatible
iff every consumer imports via `utsushi_core::substrate::*`",
`docs/utsushi-substrate-facade.md:18`) is currently a contract about a
hypothetical future.

---

## L. Cross-cutting gaps

### Concepts that don't exist but should

1. **An engine-port → substrate-sink bridge.** The `EnginePort` trait
   emits `ObservationHookEvent` (legacy) instead of the new sink
   payloads. There is no `impl TextSurfaceSink for RunnerObservationCollector`
   or equivalent. The substrate's most-polished work (sinks) and its
   official port trait do not connect.

2. **A frame-as-layer-composition primitive.** RealLive (and SiglusEngine,
   and most VN engines) render frames as composites of independently
   addressable layers. The substrate has only "frame = artifact URI."

3. **A scene/scenario position type.** `MomentId` is opaque. RealLive
   has `(scene_id, line_offset)`; RPG Maker has `(map_id, event_id,
page, command_index)`. The substrate could surface a
   `ScenarioPosition` trait without committing to any one engine's
   shape.

4. **A wait-driven advance input event.** "Pause completed at tick N"
   needs a real model so a `Pause` opcode's replay is deterministic
   without abusing `Advance {}`.

5. **A `RealLive`-shaped multiplexed package primitive.** Try-dir-
   then-archive, plus case-folded directory index. Without it,
   `AssetPackage` is "the engine port writes its own VFS from scratch."

### Concepts that exist but are over-narrow (fixture-shaped)

1. **Snapshot 16 KiB envelope.** Sized for the fixture's ~8 fields.
   Real saves: 24 KiB raw, much more normalised.

2. **`STATE_TREE_MAX_SERIALIZED_BYTES = 12 KiB`.** Same problem,
   inside the envelope.

3. **`EmbedTrace::MAX_LINES = 256`.** Sized for synthetic 1-line
   fixture scenes; real scenes have thousands of `TextDisplay` calls.

4. **`AudioEventKind` 6-variant taxonomy.** No fade kinds, no
   per-speaker mask.

5. **`InputEvent::Pointer` normalised coordinates.** Designed to
   reject screen coordinates by policy, but `MOUSEACTIONCALL.AREA`
   uses screen coordinates as ground truth. The substrate's
   normalised model and Gameexe's pixel model do not round-trip
   through anything but `Raw`.

6. **Frame artifact-kind allow-list of 3 strings** (`sink/frame.rs:17`).
   Fine for now; just noting the literal allow-list is fixture-test
   scaffolding promoted to runtime policy.

7. **`SourceTag` four-variant lock.** Cannot distinguish "native Rust
   port" from "Wine-wrapped reference engine" — which is the comparison
   conformance is supposed to enable.

8. **`PortManifest` is `&'static`-only.** Cannot describe stateful
   substrate surfaces (VFS, snapshot, replay) the port carries.

---

## M. Recommended substrate extensions before UTSUSHI-146 (decomposed) can land

These are scoped to needs **proven by Sweetie HD ground-truth**, not
hypothetical engine families. Each is a candidate node sketch with
acceptance criteria.

### M.1 UTSUSHI-EXT-A: Composite asset package + try-dir-then-archive resolver

**Why:** Gameexe's `#FOLDNAME.G00 = "G00" = 0 : "G00.PAK"` syntax is
present in 13 of 13 Sweetie HD asset folders. Real RealLive ports
cannot ship without this.

**Acceptance:**

- New `CompositeAssetPackage` impl whose `resolve` consults an ordered
  source list (first-match-wins) of `(plaintext_dir |
archive_reader)`.
- New typed archive-reader trait `AssetArchiveReader` with PAK as a
  follow-up; substrate provides the multiplex policy primitive even
  if PAK lands later.
- Case-folded directory index so resolve is O(1) per asset, not
  O(directory).

### M.2 UTSUSHI-EXT-B: Snapshot envelope size class

**Why:** Sweetie HD `REALLIVE.sav` is 24876 bytes raw. After
normalised JSON encoding of the int/str banks + graphics layer state,
a useful snapshot is at least 64 KiB and likely 256 KiB. The current
16 KiB envelope (`snapshot/snapshot.rs:19`) is below the floor.

**Acceptance:**

- Replace fixed `SNAPSHOT_MAX_SERIALIZED_BYTES` with a tier: Small =
  16 KiB (current, fixture), Medium = 256 KiB (single-engine save),
  Large = 4 MiB (full-engine state including layers).
- Tier declared at manifest level so the runner enforces per-port.
- Add a SnapshotSchemaVersion bump because the envelope grows.

### M.3 UTSUSHI-EXT-C: `EnginePort` → substrate-sinks bridge

**Why:** Today `EnginePort::observe` emits `ObservationHookEvent`
(legacy). The new sinks (`TextSurfaceSink` etc.) have no production
producer. This is the single most-fixture-shaped element of the
cascade.

**Acceptance:**

- New `EnginePort::sink_set(&self) -> &SinkSet` or equivalent
  surface that lets a port plug its `TextSurfaceSink`,
  `FrameArtifactSink`, `AudioEventSink` impls into the runner.
- `Runner` drains sinks alongside `observe`, or `observe` is
  refactored to push into sinks instead of returning legacy events.
- Migration plan for `utsushi-fixture` to implement `EnginePort` so
  the new path has at least one working consumer.

### M.4 UTSUSHI-EXT-D: Pixel-bound mouse area input

**Why:** Sweetie HD declares 1 `MOUSEACTIONCALL` with
`AREA=1232,0,1279,719`. RealLive bytecode binds clicks to scene
jumps via screen rectangles. The substrate's normalised pointer model
cannot represent this without `Raw` opacity.

**Acceptance:**

- New `InputEvent::AreaHit { area_id: String, screen_x: u16,
screen_y: u16 }` or, alternatively, an explicit `screen_size`
  metadata field on `Pointer` so the engine port can de-normalise.
- Replay log records the hit deterministically; conformance check
  can compare across two ports.
- `bridge_unit_id` linkage so a hit maps to the scene-jump target.

### M.5 UTSUSHI-EXT-E: Frame-as-layer-composition sink

**Why:** Sweetie HD's `OBJECT_MAX=256` graphics layers is the
ground-truth frame model. A frame is "list of (layer_index,
asset_id, transform, blend_mode)" — capturing only an artifact URI
loses the layer-level evidence the conformance comparison wants.

**Acceptance:**

- New `LayerCompositionSink::emit_composition(FrameComposition)`
  or extend `FrameArtifactSink` with an optional
  `composition: Option<LayerComposition>` field.
- `LayerComposition` carries an ordered Vec of
  `(layer_index, asset_id: AssetId, transform: AffineTransform,
blend_mode: BlendMode)`.
- E2 or E3 ceiling because the layer list is structural evidence.
- Optional: substrate does not need to render; the port produces both
  the composition and (separately) a PNG artifact URI.

---

## Closing note

The substrate's discipline — typed errors with semantic codes,
deterministic JSON, schema-version pinning, redaction sweeps,
const-asserted facade — is genuinely good engineering. The work that
is fixture-shaped is fixture-shaped because **no real engine port has
exercised it yet**: every consumer in the substrate's test suite is a
collector struct declared inside the trait's own `#[cfg(test)]`
module, and every wire-shape constant was sized for the synthetic
"one-text-unit fixture game" that `utsushi-fixture` ships.

UTSUSHI-146 (or whatever node carries the first real engine port)
will surface these gaps as compile errors and oversized envelopes
within the first day of integration. Landing M.1, M.2, and M.3 before
that node opens is the load-bearing pre-requisite. M.4 and M.5 can
follow once the port has emitted its first text-only trace.
