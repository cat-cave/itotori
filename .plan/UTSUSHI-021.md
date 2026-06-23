# UTSUSHI-021 — Deterministic input clock and replay log

- **Node**: UTSUSHI-021
- **Title**: Deterministic input clock and replay log
- **Branch**: `spec/utsushi-021`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-021`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review
- **Dependency layer landed**: UTSUSHI-020 (Runtime VFS + asset-package boundary, on main)

## 1. Goal restatement

Provide the engine-neutral, deterministic input + clock + replay-log primitives
that every future Utsushi runtime port uses to drive controlled playback,
record traces, and replay branches without leaking host nondeterminism.

The substrate must satisfy three claims that downstream nodes can mechanically
falsify:

1. A fixture runtime fed a recorded `ReplayLog` reproduces the same text and
   choice sequence as the original recording, bit-for-bit.
2. Unsupported input kinds reach the adapter as a typed semantic enum variant —
   never silently dropped, never converted into a successful no-op.
3. A serialized `ReplayLog` round-trips through `serde_json` without containing
   raw host paths or embedded asset bytes, and passes the existing
   `reject_unredacted_local_paths` filter in `utsushi-core`.

Downstream consumers and what they need from this layer:

- **UTSUSHI-022** (headless text/render/audio sinks) — sink contracts need
  monotonically increasing `LogicalClockTick` values to order text and frame
  evidence; sinks pull "now" from a clock handle, never from
  `std::time::Instant`.
- **UTSUSHI-023** (snapshot primitives) — a snapshot is anchored at a
  `LogicalClockTick`; restoring a snapshot then replaying the tail of a log
  must produce the same observable text/choice/branch sequence as a from-zero
  replay. Snapshots must reference assets by `AssetId`, not by host path.
- **UTSUSHI-024** (WASM embed ABI) — the WASM bridge serializes a
  `ReplayLog` across the ABI boundary; `InputEvent` and `LogicalClockTick`
  must serialize without host-only types (no `PathBuf`, no `Instant`, no
  `SystemTime`).
- **UTSUSHI-027** (branch and trace conformance checks) — branch-trace
  determinism is defined as "two replays of the same `ReplayLog` produce
  the same `ObservationHookEvent` sequence modulo declared volatile fields".
- **UTSUSHI-056** (observation hook protocol, complete) — already enforces
  `reject_unredacted_local_paths` and supplies `ObservationHookEventKind`.
  `ReplayLog` events must be losslessly convertible into the matching
  observation payload kinds (text → `ObservationTextPayload`, choice →
  `ObservationChoicePayload`).
- **UTSUSHI-103** (engine-port runner template) — the runner pulls the
  `ReplayLog` off `RuntimeRequest`, drives the adapter, and asserts the
  resulting trace matches the recorded one. The signature change to
  `RuntimeRequest` is the only public-surface commitment this node makes.

## 2. Module placement

**Recommendation: three new public submodules under `utsushi-core`:**

```
crates/utsushi-core/src/
  input.rs       # InputEvent enum, InputKind, InputError, conversion helpers
  clock.rs       # LogicalClock, LogicalClockTick, ClockOrigin
  replay.rs      # ReplayLog, ReplayMetadata, replay-log redaction guard
```

Re-exported from `crates/utsushi-core/src/lib.rs`:

```rust
pub mod input;
pub mod clock;
pub mod replay;

pub use input::{InputEvent, InputKind, InputError, ChoiceIndex, MenuTarget, RawInputCode};
pub use clock::{LogicalClock, LogicalClockTick, ClockOrigin};
pub use replay::{ReplayLog, ReplayLogBuilder, ReplayMetadata, ReplaySchemaVersion};
```

Justification (same posture as UTSUSHI-020):

- These primitives are tightly coupled with `RuntimeAdapter`, `RuntimeRequest`,
  `ObservationHookEvent`, `reject_unredacted_local_paths`, and the
  `AssetId`/`RuntimeVfs` surface that UTSUSHI-020 just landed. They share the
  redaction policy directly. Co-locating avoids re-exporting the policy across
  a crate boundary.
- Every downstream node already depends on `utsushi-core`. A separate
  `utsushi-replay` crate would force two dependencies on every port with no
  isolation win.
- `lib.rs` is already ~5500 lines; splitting it is a future refactor not
  triggered by this slice. The three modules are small and self-contained.

**No new workspace member is introduced.** No new dependency is introduced
(serde + serde_json are already in `utsushi-core`).

## 3. Input event model

### 3.1 `InputKind` discriminant

A small, finite, engine-neutral enum that names the input shapes our
substrate models. Engine-specific extensions go through `InputKind::Raw` so
the model remains additive.

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputKind {
    Text,         // text-advance / proceed-with-currently-displayed-line
    Choice,       // pick a numbered choice from a presented choice prompt
    Advance,      // generic single-step advance (synonym for "click-to-advance"
                  // when no text box is active)
    Skip,         // engine "skip read text" toggle
    Auto,         // engine "auto advance" toggle
    Save,         // save-state request (not the underlying serialization)
    Load,         // load-state request
    MenuSelect,   // menu-tree selection (used by RPG Maker MV/MZ for
                  // events, items, and option screens; carries a stable
                  // logical id, never a screen position)
    Pointer,      // bounded pointer input (logical coords, click_kind);
                  // used only by adapters that document pointer support
    Raw,          // unsupported-by-substrate input; only constructible
                  // through InputEvent::raw() so a typed diagnostic
                  // surface fires
}
```

The list intentionally covers what the three current adapter classes need:

- **Synthetic fixture** — `Text`, `Choice`, `Advance` cover every observation
  the current `utsushi-fixture` emits.
- **RPG Maker MV/MZ** (via UTSUSHI-031 et al.) — adds `MenuSelect`, `Save`,
  `Load`, `Skip`, `Auto`. MV/MZ event commands map cleanly onto `MenuSelect`
  (menu id + choice id).
- **RealLive / Siglus** (via UTSUSHI-035..038) — adds `Skip`, `Auto`, and uses
  `Choice` plus `Text` for the standard message-box loop. The voice-replay and
  rollback features are out of scope here.

### 3.2 `InputEvent` payload

```rust
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputEvent {
    Text {
        // The substrate does not author text; advancing past a displayed line
        // does not require the text content. This variant carries no payload
        // by design — the text observed at this tick is in the trace.
    },
    Choice {
        // 0-based index into the presented choice list. Engine-neutral by
        // construction; engines that present choices by string id MUST map
        // to indices when recording. Adapters validate that the index is
        // within the prompt's option count.
        index: ChoiceIndex,
        // Optional bridge identifier for review tooling. Skipped if absent.
        #[serde(skip_serializing_if = "Option::is_none")]
        bridge_unit_id: Option<String>,
    },
    Advance {},
    Skip { enable: bool },
    Auto { enable: bool },
    Save { slot: u16 },
    Load { slot: u16 },
    MenuSelect {
        // Stable, engine-defined menu identifier (e.g. "main_menu", "items",
        // "options"). Adapters MUST NOT serialize raw screen coordinates here.
        target: MenuTarget,
    },
    Pointer {
        // Logical, normalized coordinates in [0.0, 1.0] inside the engine's
        // declared output surface. Floats are serialized as numbers and
        // compared exactly (no host wall-clock involvement).
        x: f32,
        y: f32,
        button: PointerButton,
    },
    Raw {
        // Carries the diagnostic context an adapter saw but could not lower
        // into a supported variant. Distinct from InputError::UnsupportedKind
        // because Raw means "I recorded this on the input side" — the
        // unsupported diagnostic still fires when a downstream consumer
        // attempts to dispatch it.
        code: RawInputCode,
    },
}

pub struct ChoiceIndex(pub u16);

pub struct MenuTarget {
    pub menu_id: String,     // engine-namespaced public id
    pub item_id: String,     // stable string id, not a screen index
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerButton { Primary, Secondary, Auxiliary }

pub struct RawInputCode {
    pub engine: String,     // e.g. "rpgmv", "siglus", "fixture"
    pub code: String,       // engine-defined opaque token (no path, no bytes)
}
```

Constraints on the payload:

- No field carries `PathBuf`, `Instant`, `SystemTime`, thread id, process id,
  or any host-derived nondeterministic value.
- `Choice::bridge_unit_id`, `MenuTarget::menu_id`, `MenuTarget::item_id`,
  `RawInputCode::engine`, `RawInputCode::code` are validated against
  `reject_unredacted_local_paths` at log-finalize time. A string that
  matches `looks_like_local_path` causes log construction to fail with
  `InputError::RedactionViolation`.
- `Pointer.x` / `Pointer.y` are normalized; adapters that consume them in
  physical pixels MUST convert through their own surface size (which is
  static per adapter run).
- `kind()` returns the matching `InputKind`. A round-trip test asserts every
  serialized payload deserializes to the same value and reports the same
  `kind()`.

### 3.3 Engine coverage table

| Engine            | Variants used                                                             | Recording strategy                                                          |
| ----------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `utsushi-fixture` | `Text`, `Choice`, `Advance`                                               | Author-time scripted log; pure unit/integration tests.                      |
| RPG Maker MV/MZ   | `Text`, `Choice`, `Advance`, `Skip`, `Auto`, `MenuSelect`, `Save`, `Load` | Browser/NW.js observation hooks emit equivalent events at recording time.   |
| RealLive / Siglus | `Text`, `Choice`, `Advance`, `Skip`, `Auto`                               | Recorded via Siglus instrumentation hook (UTSUSHI-036).                     |
| KiriKiri / KAG    | `Text`, `Choice`, `Advance`, `Skip`, `Auto`, `MenuSelect`                 | KAG-tag observation in instrumentation slice.                               |
| Future engines    | `Raw` + targeted lowering once requirements crystallize.                  | `Raw` keeps recording lossless without forcing premature variant additions. |

## 4. Deterministic clock model

### 4.1 `LogicalClockTick` and `ClockOrigin`

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord,
         Serialize, Deserialize)]
#[serde(transparent)]
pub struct LogicalClockTick(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClockOrigin {
    /// Tick 0 is when the runtime begins driving the recorded session.
    RunStart,
    /// Tick 0 is when a recorded snapshot was restored. Used by
    /// UTSUSHI-023 so log tails can be replayed against a restored
    /// state.
    SnapshotRestore,
}
```

`LogicalClockTick` is a plain monotonic `u64`. There is no implicit mapping
to wall-clock or frame time. Adapters that want a frame counter implement
their own surface and tick the clock once per consumed input.

### 4.2 `LogicalClock`

```rust
pub struct LogicalClock {
    origin: ClockOrigin,
    current: LogicalClockTick,
}

impl LogicalClock {
    pub fn starting_at(origin: ClockOrigin) -> Self;
    pub fn origin(&self) -> ClockOrigin;
    pub fn now(&self) -> LogicalClockTick;
    pub fn tick(&mut self) -> LogicalClockTick;   // returns the post-tick value
    pub fn advance_to(&mut self, target: LogicalClockTick) -> Result<(), InputError>;
}
```

Properties enforced by tests:

- `tick()` is the only mutator on the read path.
- `advance_to(target)` fails with `InputError::ClockBacktrack` when
  `target < self.current`. Replaying a log MUST refuse to rewind silently —
  rewinding is a snapshot restore responsibility (UTSUSHI-023 owns it).
- Two clocks constructed with the same `ClockOrigin` and ticked through the
  same sequence of inputs produce the same `LogicalClockTick` values, by
  construction (no wall-clock involvement).
- `LogicalClock` does NOT implement `Default` to force callers to choose
  an explicit `ClockOrigin`.
- `Send + Sync`; `&mut self` for mutation. No interior mutability so the
  recording loop cannot accidentally share a clock across threads without
  explicit synchronization.

### 4.3 What the clock is NOT

- It is not a frame timer; UTSUSHI-022's frame sink owns its own counter.
- It is not a wall-clock; runtime evidence reports already carry
  `observedAt` RFC3339 strings; those are recorded once at run start and
  do not leak into `ReplayLog`.
- It is not a `rand` seed; adapters that need RNG receive an explicit seed
  from `ReplayMetadata::seed` (see §5). The seed is a fixed `u64`, no
  thread-id or pid involvement.

## 5. Replay log

### 5.1 Types

```rust
pub const REPLAY_LOG_SCHEMA_VERSION: &str = "0.1.0-alpha";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySchemaVersion(pub String);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayLog {
    pub schema_version: ReplaySchemaVersion,
    pub metadata: ReplayMetadata,
    events: Vec<ReplayEntry>,         // private; accessed via iter() / events()
    asset_refs: Vec<AssetId>,         // assets the recording depended on
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayEntry {
    pub tick: LogicalClockTick,
    pub event: InputEvent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayMetadata {
    /// Stable identifier of the recorded run. Format: `replay-<uuid7>`.
    pub run_id: String,
    /// The engine adapter that produced the recording. Public name only.
    pub adapter_name: String,
    pub adapter_version: String,
    /// Clock origin used by the recording.
    pub clock_origin: ClockOrigin,
    /// RNG seed delivered to the adapter; 0 is "no RNG was requested".
    pub seed: u64,
    /// Optional public-name reference to the asset bundle used; never a
    /// host path. (e.g. "public-fixture:hello-game".)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_label: Option<String>,
}

#[derive(Default)]
pub struct ReplayLogBuilder {
    metadata: Option<ReplayMetadata>,
    events: Vec<ReplayEntry>,
    asset_refs: BTreeSet<AssetId>,
    last_tick: Option<LogicalClockTick>,
}

impl ReplayLogBuilder {
    pub fn new() -> Self;
    pub fn metadata(self, metadata: ReplayMetadata) -> Self;
    pub fn record(&mut self, tick: LogicalClockTick, event: InputEvent)
        -> Result<(), InputError>;
    pub fn note_asset(&mut self, id: AssetId);
    pub fn build(self) -> Result<ReplayLog, InputError>;
}

impl ReplayLog {
    pub fn events(&self) -> &[ReplayEntry];
    pub fn asset_refs(&self) -> &[AssetId];
    pub fn iter(&self) -> impl Iterator<Item = &ReplayEntry>;
    pub fn next_event(&self, cursor: ReplayCursor)
        -> Result<Option<(ReplayEntry, ReplayCursor)>, InputError>;
    pub fn to_json_value(&self) -> UtsushiResult<Value>;
    pub fn from_json_value(value: Value) -> UtsushiResult<Self>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReplayCursor(pub usize);

impl ReplayCursor {
    pub fn start() -> Self { Self(0) }
}
```

### 5.2 Append-only API

`ReplayLog` itself has no public mutators. Recording goes through
`ReplayLogBuilder::record` and then `build()` consumes the builder.
This enforces "immutable once recorded" structurally rather than by
convention.

`record` validates:

- The new `tick` is strictly greater than the previous recorded tick (or
  greater than `LogicalClockTick(0)` for the first record).
- The event passes the redaction filter (see §5.4) so a `MenuTarget::menu_id`
  containing `/tmp/foo` cannot enter the log.
- The event kind is supported — adapters wishing to record an unsupported
  input should call the typed escape hatch on `InputEvent::Raw`, never
  bypass `record`.

`build()` runs a final consistency pass:

- `metadata` is present.
- `schema_version` equals `REPLAY_LOG_SCHEMA_VERSION`.
- `asset_refs` contains every `AssetId` mentioned inline (currently none of
  the variants embeds an `AssetId` directly, but `note_asset` is the
  forward-compatible hook for future snapshot integration).
- The serialized JSON form passes `reject_unredacted_local_paths` end-to-end.

### 5.3 Replay cursor

`next_event(cursor)` returns the entry at the cursor and the next cursor, or
`Ok(None)` at end-of-log. Adapters drive replay by:

```rust
let mut cursor = ReplayCursor::start();
let mut clock = LogicalClock::starting_at(log.metadata.clock_origin);
while let Some((entry, next)) = log.next_event(cursor)? {
    clock.advance_to(entry.tick)?;
    adapter.dispatch_input(&entry.event)?;
    cursor = next;
}
```

This pattern is the same shape that UTSUSHI-103's runner template expects.

### 5.4 Redaction

A new private helper `assert_replay_event_redaction(event)` walks the event
via `serde_json::to_value` and runs `reject_unredacted_local_paths`. It is
called by both `ReplayLogBuilder::record` and `ReplayLog::from_json_value`.

`ReplayLog::to_json_value` runs the same filter on the full serialized form
before returning, so a `ReplayLog` that somehow accumulated a leaking field
fails serialization with a `UtsushiResult::Err`.

### 5.5 Size / artifact discipline

`ReplayLog` deliberately does NOT carry:

- screenshot or capture bytes — those live as `RuntimeArtifactName` URIs
  under `RUNTIME_ARTIFACT_URI_ROOT` and are referenced by id, not embedded;
- raw asset bytes — references are `AssetId`, which the consumer re-opens
  via `RuntimeVfs`;
- bridge bundles, source revisions, or evidence reports — those are produced
  by replay, not consumed as recording input.

A unit test asserts that the serialized JSON for a 100-event log stays under
a small ceiling (e.g. 16 KiB) so accidental binary embedding regresses
loudly.

## 6. Asset-id integration

`AssetId` (from UTSUSHI-020) is imported by `replay.rs` only for the
`asset_refs` collection on `ReplayLog`. The current input event variants do
not embed `AssetId` directly because none of them require it — `Text`
advances the line at the current displayed observation, and `Choice`
references a choice index inside the current prompt; both are anchored
at the current logical tick, not by asset id.

When UTSUSHI-023 needs snapshot anchors that point at asset ids (e.g.
"snapshot taken after consuming `vfs://www/data/Map001.json`"), the
snapshot record will carry its own `AssetId`s. UTSUSHI-021's contribution
is `ReplayLog::note_asset(AssetId)` so the recorder can declare every asset
the run depended on, surfaced through `ReplayLog::asset_refs()`.

No event variant accepts `PathBuf` or `&str` for an asset; the type system
prevents host-path leakage at the recording boundary.

## 7. Unsupported input diagnostics

```rust
#[derive(Debug)]
pub enum InputError {
    /// An adapter received an input kind it does not implement. The kind is
    /// reported by stable string token; supported kinds are listed so the
    /// caller can surface "this engine supports X, Y, Z".
    UnsupportedKind {
        kind: String,                          // e.g. "pointer", "raw"
        supported: &'static [InputKind],
        code: &'static str,                    // "utsushi.input.unsupported_kind"
    },

    /// A replay log included an event whose payload failed validation
    /// (e.g. Choice index out of range against the current prompt, or
    /// MenuTarget::item_id empty).
    InvalidPayload {
        kind: InputKind,
        reason: String,
        code: &'static str,                    // "utsushi.input.invalid_payload"
    },

    /// A clock advance attempted to move backwards.
    ClockBacktrack {
        from: LogicalClockTick,
        to: LogicalClockTick,
        code: &'static str,                    // "utsushi.clock.backtrack"
    },

    /// The log violated tick monotonicity at record time.
    NonMonotonicTick {
        previous: LogicalClockTick,
        attempted: LogicalClockTick,
        code: &'static str,                    // "utsushi.replay.non_monotonic_tick"
    },

    /// A recorded event or finalized log carried a string that would
    /// match `reject_unredacted_local_paths`.
    RedactionViolation {
        field_path: String,
        code: &'static str,                    // "utsushi.replay.redaction_violation"
    },

    /// The replay-log JSON failed schema-version pinning.
    UnsupportedSchemaVersion {
        observed: String,
        expected: &'static str,
        code: &'static str,                    // "utsushi.replay.unsupported_schema_version"
    },
}

impl InputError {
    pub fn semantic_code(&self) -> &'static str;
}

impl std::error::Error for InputError {}
```

`InputError` is `Send + Sync + 'static` and implements
`From<InputError> for Box<dyn std::error::Error>` so it slots into
`UtsushiResult<T>` unchanged.

Critically, **there is no silent-drop path**. The adapter's
`dispatch_input` is required to return `Err(InputError::UnsupportedKind)`
for any kind it does not implement. The default `RuntimeAdapter` machinery
does not get a "fallback to no-op" behavior for inputs; the only way to
acknowledge an unsupported input is to return the typed error and let the
runner record it as a runtime-evidence diagnostic.

## 8. Integration with `RuntimeRequest`

UTSUSHI-020 added `vfs: Option<Arc<dyn RuntimeVfs>>`. UTSUSHI-021 makes the
analogous additive change:

```rust
#[derive(Clone)]
pub struct RuntimeRequest<'a> {
    pub input_root: &'a Path,
    pub artifact_root: Option<&'a Path>,
    pub vfs: Option<Arc<dyn RuntimeVfs>>,
    pub replay: Option<Arc<ReplayLog>>,        // <-- new field
}

impl<'a> RuntimeRequest<'a> {
    pub fn new(input_root: &'a Path) -> Self {
        Self {
            input_root,
            artifact_root: None,
            vfs: None,
            replay: None,
        }
    }

    pub fn with_replay(mut self, replay: Arc<ReplayLog>) -> Self {
        self.replay = Some(replay);
        self
    }
}
```

Reasoning:

- `Arc<ReplayLog>` keeps cloning cheap when the runner shares the log across
  multiple adapter invocations (replay-then-capture, replay-then-validate).
- It is `Option<...>` because most current adapters do not consume it; the
  current fixture flow (which has no input) stays unchanged. The field is
  additive in the same posture UTSUSHI-020 took.
- `RuntimeAdapter` trait does NOT change. Adapters that wish to consume the
  log read `request.replay.as_ref()` inside their existing trait methods.
  The signature decision (whether to add a typed `replay` method to the
  trait) is deferred to UTSUSHI-103, matching the deferral noted in
  UTSUSHI-020's plan.
- `Debug` for `RuntimeRequest` is updated to print `"Arc<ReplayLog>"`
  rather than the full contents (so `Debug` cannot leak), following the
  pattern UTSUSHI-020 introduced for `vfs`.

When `request.replay` is `Some`, an adapter that drives input MUST consume
events through `ReplayLog::next_event` instead of querying live input. The
fixture adapter does not currently take input at all, so this constraint is
informational here and becomes a hard contract for the runner template
(UTSUSHI-103) and the first real-engine port (UTSUSHI-146).

## 9. Test plan

Behavior-first names per `docs/testing-standard.md`. Unit tests live under
`crates/utsushi-core/src/{input,clock,replay}.rs` with `#[cfg(test)] mod tests`.
Integration tests live under `crates/utsushi-core/tests/replay_*.rs`.

### 9.1 Input event model

- `input_event_text_serializes_and_round_trips()`.
- `input_event_choice_round_trips_index_and_optional_bridge_id()`.
- `input_event_choice_rejects_bridge_id_containing_host_path()`.
- `input_event_menu_select_round_trips_menu_and_item_ids()`.
- `input_event_menu_select_rejects_empty_item_id()`.
- `input_event_pointer_round_trips_normalized_coordinates()`.
- `input_event_raw_records_engine_and_code_without_path_leakage()`.
- `input_event_kind_matches_payload_for_every_variant()`.
- `input_error_unsupported_kind_carries_stable_semantic_code()`.

### 9.2 Logical clock

- `logical_clock_tick_returns_strictly_monotonic_values()`.
- `logical_clock_advance_to_rejects_backtrack_with_typed_error()`.
- `logical_clock_two_instances_with_same_input_produce_same_tick_sequence()`.
- `logical_clock_does_not_implement_default()` — `compile_fail` test
  asserting `LogicalClock::default()` does not compile, so callers must
  pick an origin explicitly.
- `clock_origin_round_trips_through_serde()`.

### 9.3 Replay log

- `replay_log_builder_records_events_in_strictly_monotonic_tick_order()`.
- `replay_log_builder_rejects_non_monotonic_tick_with_typed_error()`.
- `replay_log_builder_rejects_event_with_redaction_violation()`.
- `replay_log_round_trips_through_serde_json()`.
- `replay_log_to_json_value_passes_reject_unredacted_local_paths()`.
- `replay_log_from_json_value_rejects_mismatched_schema_version()`.
- `replay_log_serialized_form_does_not_embed_asset_bytes()` — asserts JSON
  size stays under the small-binary ceiling for a synthetic 100-event log.
- `replay_log_asset_refs_only_contain_vfs_scheme_ids()` — verifies every id
  returned by `asset_refs()` parses with `AssetId::parse` and uses the
  `vfs://` scheme.
- `replay_cursor_drives_log_end_to_end_and_terminates_at_end()`.
- `replay_log_redaction_walk_catches_path_in_metadata_source_label()`.

### 9.4 Fixture-driven record/replay determinism (integration)

A new integration test `crates/utsushi-core/tests/replay_determinism.rs`:

- `fixture_replay_emits_same_text_and_choice_sequence_as_recording()`:
  - Build a synthetic `ReplayLog` with three `Text` events and one
    `Choice { index: 1 }` event interleaved at ticks 1..4.
  - Construct an in-test `RecordingAdapter` that observes each
    `InputEvent` and emits the corresponding `ObservationHookPayload`
    (`Text` -> `ObservationTextPayload` with synthetic text, `Choice` ->
    `ObservationChoicePayload`).
  - Run the adapter once to record the trace, serialize the trace.
  - Run the adapter a second time with the same `ReplayLog` and same
    seed, serialize the trace.
  - Assert the two serialized traces are equal byte-for-byte.

- `fixture_replay_unsupported_input_surface_typed_unsupported_kind_error()`:
  - Build a `RecordingAdapter` that supports only `Text` and `Choice`.
  - Drive it with a log containing a `Pointer` event.
  - Assert the call returns `Err(InputError::UnsupportedKind { kind:
"pointer", supported: [Text, Choice], code:
"utsushi.input.unsupported_kind" })`.

- `fixture_replay_choice_index_out_of_range_returns_invalid_payload()`:
  - Build a prompt with two options, drive a `Choice { index: 5 }`,
    assert `Err(InputError::InvalidPayload { kind: Choice, ... })`.

### 9.5 No regression in `utsushi-fixture`

`cargo test -p utsushi-fixture` must pass unchanged. The fixture adapter
does not take input today; this slice does not refactor it (matching the
UTSUSHI-020 Slice A posture). No new test is added there.

### 9.6 Test placement summary

- Unit tests: `crates/utsushi-core/src/input.rs`, `clock.rs`, `replay.rs`.
- Integration tests: `crates/utsushi-core/tests/replay_determinism.rs`,
  `crates/utsushi-core/tests/replay_redaction.rs`.
- One `compile_fail` doc test on `LogicalClock` to enforce explicit-origin
  construction. (If `trybuild` is declined as policy, replace with a
  documentation comment and a runtime `#[should_panic]` substitute — same
  decision UTSUSHI-020 left open.)

## 10. Verification commands

```
cargo test -p utsushi-core
cargo test -p utsushi-fixture
```

Both are listed by the DAG node. Reasoning:

- `cargo test -p utsushi-core` exercises every new module plus integration
  tests. This is the substrate bar.
- `cargo test -p utsushi-fixture` must pass unchanged — the fixture adapter
  is not modified here. This is the no-regression bar.

Recommended local additions (not gating):

- `just check` — fmt, clippy, schema lint; CI runs it.
- `just schema` — confirms the new `utsushi.input.*`, `utsushi.clock.*`, and
  `utsushi.replay.*` semantic codes are listed in the conformance schema's
  allowed-code registry. This pre-allocation lands here so UTSUSHI-026 does
  not need to retrofit it (same posture as UTSUSHI-020's
  `utsushi.vfs.*` allocation).

No `cargo test -p utsushi-replay` because no new crate is introduced.

## 11. Risks and unknowns

### 11.1 `LogicalClock` interaction with WASM ABI (UTSUSHI-024)

Decision: `LogicalClockTick` is `#[serde(transparent)] u64`. This is
WASM-portable (no platform-dependent type) and serializes as a plain
integer over the embed ABI. The risk is that an engine port wants a richer
clock representation (e.g. PTS in microseconds for audio sync). The
mitigation: keep `LogicalClockTick` as the substrate unit and let
`utsushi-core::clock` add a future `pts_us: u64` field on the trace event
side (UTSUSHI-022's text/audio sink owns that) without changing the input
clock. UTSUSHI-024's planning worker reviews this assumption.

### 11.2 `InputEvent` extension without breaking serialized logs

The schema is pinned via `REPLAY_LOG_SCHEMA_VERSION = "0.1.0-alpha"`.
`from_json_value` rejects any other version. Adding a new variant in a
later slice is a schema bump.

Two-direction policy:

- **Adding a variant** (e.g. `Rollback`) is a minor bump (`0.2.0-alpha`).
  `from_json_value` accepts both 0.1 and 0.2 logs; emitting always uses
  the latest. A test will assert this once the second variant lands.
- **Removing or changing a variant's fields** is a major bump and breaks
  on-disk logs by design. UTSUSHI-021's logs are not yet stored on disk
  outside test fixtures, so the cost is bounded today.

Risk: someone evolves a variant in-place silently. Mitigation: a
`#[derive(serde::Deserialize)] #[serde(deny_unknown_fields)]` on every
event payload plus a unit test that round-trips a checked-in tiny golden
log. The golden is added in §9.3 (`replay_log_round_trips_through_serde_json`).

### 11.3 Whether the replay log needs a version field

It does. `ReplayLog.schema_version` is required, validated on every
`from_json_value`, and pinned to `REPLAY_LOG_SCHEMA_VERSION`. Future
evolution per §11.2.

### 11.4 `Arc<ReplayLog>` on `RuntimeRequest`

`Arc` (rather than `&ReplayLog`) is chosen so the runner can share the log
across adapter invocations and across threads. The `Send + Sync` bound is
implied by `Arc<T: Send + Sync>` and `ReplayLog: Send + Sync` follows from
its plain-data fields. Risk: `Arc` clones inside hot loops — adapters
should clone the `Arc` once per invocation, not per event. Documented in
the module-level rustdoc.

### 11.5 Choice index vs. choice id

`Choice::index` is a `u16` ordinal into the presented prompt. Some engines
(KAG, Siglus) identify choices by string id rather than ordinal. The
recording adapter is responsible for canonicalizing to ordinal at record
time using the prompt's option order. This is consistent with
`ObservationChoicePayload::options[].option_id` already pairing an
`option_id` with a label. Risk: an engine where the prompt's option order
is not stable between runs. Mitigation: such engines must record the
ordering at the same logical tick they record the choice; this is an
engine-port concern, not a substrate change.

### 11.6 Pointer support

`Pointer` is included so launch/capture wrappers (the browser adapter) can
record realistic input traces. Replay across host environments demands
that the consumer treat normalized coordinates as the contract. Risk:
overclaim of pointer fidelity. Mitigation: pointer events are only valid
when the adapter's `RuntimeCapabilityContract` declares the matching
playback feature. This linkage is documented but the contract addition
itself happens whenever an adapter first claims pointer support, not in
this slice.

## 12. Out of scope

The following are explicitly NOT done in this node:

- **Runtime port execution** (UTSUSHI-146 and the per-engine port slices).
  The fixture remains the only consumer at this stage; the in-test
  `RecordingAdapter` lives in `crates/utsushi-core/tests/` and is not a
  shipped product.
- **Snapshot / restore primitives** (UTSUSHI-023). `ClockOrigin::SnapshotRestore`
  exists so the API does not need to change when 023 lands, but no
  snapshot type, snapshot serialization, or restore semantics are
  implemented here.
- **Trace and branch graph conformance checks** (UTSUSHI-027).
- **WASM embed ABI fixture** (UTSUSHI-024). The clock and log are designed
  to serialize across the ABI; the ABI itself is 024's surface.
- **Headless sinks** (UTSUSHI-022). Text/render/audio sink contracts read
  from `LogicalClock::now()` but are owned by 022.
- **`utsushi-fixture` refactor** to consume `RuntimeRequest::replay`. The
  fixture has no inputs to replay today; if/when it grows interactive
  fixtures, that change is a sibling slice (mirroring UTSUSHI-020 Slice B).
- **Real-engine instrumentation hooks** (UTSUSHI-031 et al.). Recording
  adapters at the engine-port boundary translate engine-native input into
  `InputEvent`; that translation lives in the engine port crates.
- **Encrypted log storage**, **log signing**, **log compression**. The
  serialized log is plain JSON; binary-efficient encodings are a later
  performance concern.

## 13. Worker scoping

Recommendation: **one implementation slice** owned by a single worker.

Rationale:

- `InputEvent`, `LogicalClock`, and `ReplayLog` are tightly coupled.
  `ReplayLogBuilder::record` validates monotonic ticks against
  `LogicalClock` semantics; `next_event` advances a clock; the redaction
  walk is the same helper across all three modules. Splitting them would
  create cross-PR coupling on shared private helpers.
- The fixture adapter is not refactored (mirrors UTSUSHI-020 Slice A
  posture). There is no companion Slice B because the fixture takes no
  input today; the natural follow-up is the runner template
  (UTSUSHI-103) plus the first real-engine port (UTSUSHI-146), both
  separately tracked.
- Test surface is moderate: ~25 unit tests, 2 integration files, 1
  `compile_fail` (or substitute). All inside `utsushi-core`.

Verification (per §10): `cargo test -p utsushi-core`,
`cargo test -p utsushi-fixture`, `just schema`, `just check`.

Estimated worker time: medium. Enum design and serde plumbing are
mechanical; the determinism tests and the redaction integration test are
the highest-value pieces.

## Plan ends here.
