# UTSUSHI-060 — Reference runtime trace and capture recorder

- **Node**: UTSUSHI-060
- **Title**: Reference runtime trace and capture recorder
- **Branch**: `spec/utsushi-060`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-060`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review (implementation slice follows this plan)

## 1. Goal restatement

Build the engine-neutral **recording substrate** that captures a runtime's
observed trace, capability state, snapshot refs, and replay events from a
fixture (or, later, real-engine) run and serializes them as a deterministic
JSON `ReferenceTrace`. The output is the input that the conformance trace
(`UTSUSHI-027`), branch, snapshot (`UTSUSHI-028`), and capture
(`UTSUSHI-029`) checks consume to compare partial-VM and replay-engine
behavior against an observed reference.

This is a **recording substrate only**. No engine port lands here; no live
capture orchestration runs here. A fixture runtime is the only producer in
this slice (browser/native/Wine variants are wired through a stable
`SourceTag` enum so when the real engine ports arrive they plug in without
schema churn).

### Downstream contracts that constrain the shape

- **UTSUSHI-027 / UTSUSHI-028 / UTSUSHI-029** (conformance checks): consume
  the recorded text events, snapshot refs, and capture refs. The recorder
  must emit a JSON shape that round-trips through the conformance check
  inputs without re-derivation.
- **UTSUSHI-021** (`ReplayLog`): the replay-events portion of a recorded
  trace must be a flat `Vec<ReplayEntry>` so a downstream consumer can rebuild
  a `ReplayLog` without bespoke decoding.
- **UTSUSHI-024** (embed ABI): capability state is recorded as
  `Vec<EmbedCapability>` so the recorder agrees with the ABI's published
  capability shape.

### Engine-neutrality bar

The recorder MUST NOT name an engine. `SourceTag` is the only place an
engine family surfaces, and it is an enum (`Browser`, `Native`, `Wine`,
`Fixture`) — never a host path, never a binary version, never a renderer
name. A future RealLive / RPGM port plugs in by selecting an existing tag.

## 2. Module placement

**Recommendation: new submodule `utsushi_core::recorder` in
`crates/utsushi-core/src/recorder/`. No new workspace member.**

Justification:

- The recorder is downstream of `sink::text` (consumes `TextLine`),
  `embed::capability` (consumes `EmbedCapability`), `snapshot::SnapshotRef`,
  and `replay::ReplayEntry`. All four already live in `utsushi-core`.
- The conformance modules that will consume the recorder output also live
  in `utsushi-core/src/conformance/`. Keeping recorder in the same crate
  avoids a circular-or-thin extra crate.
- Module layout:
  - `recorder/mod.rs` — re-exports + schema version pin
  - `recorder/trace.rs` — `ReferenceTrace`, `SourceTag`
  - `recorder/builder.rs` — `ReferenceRecorder` trait, in-memory accumulator
    impl `InMemoryReferenceRecorder`
  - `recorder/serialize.rs` — deterministic JSON helper
  - `recorder/sink_bridge.rs` — `RecordingTextSink<S>` adaptor

Public re-exports at crate root: `ReferenceTrace`, `SourceTag`,
`ReferenceRecorder`, `InMemoryReferenceRecorder`, `RecordingTextSink`,
`REFERENCE_TRACE_SCHEMA_VERSION`.

## 3. Types

```rust
/// Schema version pin for the reference trace wire form.
pub const REFERENCE_TRACE_SCHEMA_VERSION: &str = "0.1.0-alpha";

/// Engine-family-neutral source tag for a recorded run.
/// Never a host path. Never a host or engine binary version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceTag {
    Browser,
    Native,
    Wine,
    Fixture,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReferenceTrace {
    pub schema_version: String,
    pub source: SourceTag,
    /// Public adapter identifier (e.g. the conformance manifest adapter_id).
    pub adapter_id: String,
    /// Text events in observation order. Stable order = insertion order;
    /// serializer never reorders these (they are inherently sequential).
    pub text_events: Vec<TextLine>,
    /// Embed capability snapshot at recording time. Serialized via
    /// `sort_capabilities` so order is stable across runs.
    pub capability_state: Vec<EmbedCapability>,
    /// Snapshot references by id only. No raw bytes, no host paths.
    pub snapshot_refs: Vec<SnapshotRef>,
    /// Replay log events, in logical-tick order (the order ReplayLog already
    /// guarantees through UTSUSHI-021).
    pub replay_events: Vec<ReplayEntry>,
    /// Stable, source-supplied recording label. Must NOT be a wall-clock
    /// instant; it is a deterministic identifier (run id / fixture name).
    pub recorded_at: String,
}
```

`recorded_at` is intentionally a `String` label rather than a timestamp.
The audit-focus item "determinism gaps" is structurally defended: the
recorder will not call any host clock. The caller supplies a deterministic
label.

## 4. Recorder trait

```rust
pub trait ReferenceRecorder: Send + Sync {
    fn record_text_event(&self, line: TextLine);
    fn record_capability_state(&self, capabilities: &[EmbedCapability]);
    fn record_snapshot_ref(&self, snapshot: SnapshotRef);
    fn record_replay_event(&self, entry: ReplayEntry);

    /// Build the final `ReferenceTrace`. Idempotent: calling twice returns
    /// the same value (with internal lists sorted/canonicalised).
    fn finalize(&self) -> ReferenceTrace;

    /// Convenience: finalize and serialize via the canonical helper.
    fn finalize_to_bytes(&self) -> Vec<u8> {
        deterministic_json_bytes(&self.finalize())
    }
}
```

`InMemoryReferenceRecorder` is the only impl in this slice:

- Constructed with `source: SourceTag`, `adapter_id: String`,
  `recorded_at: String`.
- Internally uses `Mutex<Inner>` so it is `Send + Sync` and `&self`.
- `finalize` clones the inner state, runs `sort_capabilities` on the
  capability list, and leaves the other three lists in insertion order.

## 5. Deterministic JSON serializer

`recorder::serialize::deterministic_json_bytes(trace: &ReferenceTrace) -> Vec<u8>`:

- Serializes through `serde_json::to_value` first, then walks the resulting
  `Value` to produce a sorted-key form. (Walk recursively: every `Map` is
  re-emitted as a `BTreeMap`-backed object; arrays preserve order.)
- Writes via `serde_json::ser::Serializer` configured with
  `CompactFormatter` to a `Vec<u8>` so byte output is reproducible across
  serde-json minor versions (no whitespace negotiation).
- Test pins: round-trip JSON bytes through a hash compare across two
  consecutive `finalize_to_bytes()` calls.

Rationale: relying on serde's struct-field declaration order plus
`BTreeMap` re-emit is the smallest defense that survives a serde-json
version bump. The risk note (§9) records why we add the post-walk.

## 6. Sink integration

`RecordingTextSink<S: TextSurfaceSink>`:

- Wraps an inner `S` plus an `Arc<dyn ReferenceRecorder>`.
- Implements `TextSurfaceSink`. On each `accept_line`, calls
  `self.inner.accept_line(line.clone())` first, then
  `self.recorder.record_text_event(line)`.
- Forwards error from the inner sink unchanged. The recorder side is
  infallible (no I/O).

Frame / audio sinks are NOT wrapped in this slice: the recorder records
snapshot refs and replay events explicitly through the trait, and capture
refs flow in through `record_snapshot_ref` when conformance check sites
have collected them. The slice's stated scope is the text + capability +
snapshot-ref + replay-event substrate; capture-ref recording is the same
mechanism (id-only refs) and uses `record_snapshot_ref` semantics via
`SnapshotRef` — `FrameArtifactSink` integration is out of scope here
because it would require a new artifact-ref recorder field. UTSUSHI-061
will widen the trace when the first capture consumer lands.

## 7. Test plan

All tests live in `crates/utsushi-core/src/recorder/` as `#[cfg(test)]`
modules. Run with `cargo test -p utsushi-core recorder`.

1. **Round-trip determinism (byte-identical)**. Build an
   `InMemoryReferenceRecorder` with a fixed `SourceTag::Fixture`, a fixed
   `adapter_id`, and a fixed `recorded_at`. Push three text events, two
   capabilities, one snapshot ref, two replay entries. Call
   `finalize_to_bytes()` twice; assert byte equality.
2. **Cross-recorder determinism**. Two independent
   `InMemoryReferenceRecorder` instances receive the same events in the
   same order. `finalize_to_bytes()` outputs MUST be byte-equal.
3. **Capability list stable order**. Push capabilities in reversed
   `sort_key` order; assert the finalized trace lists them in
   `sort_capabilities` order.
4. **SourceTag wire form is the kebab-case enum**. For every variant of
   `SourceTag`, build a trace, serialize, parse the JSON back, and assert
   the `source` field is one of `"browser" | "native" | "wine" |
   "fixture"`. Also assert no field in the serialized JSON contains the
   substring of any host-specific value (`/home`, `C:\\`, `wine-`).
5. **All four SourceTag variants produce valid records**. For each variant,
   round-trip `ReferenceTrace` through serde and assert equality.
6. **Empty trace round-trip**. A recorder with no recorded events still
   produces a valid JSON trace (empty arrays, present schema_version).
7. **Without snapshot refs**. A trace built without any
   `record_snapshot_ref` calls serializes `snapshotRefs: []`.
8. **With snapshot refs**. Recording two `SnapshotRef` entries preserves
   their insertion order and only id-only fields appear (no raw bytes
   field, no host path — defended by `SnapshotRef`'s own serde shape
   already; the test asserts the recorder did not somehow inject one).
9. **RecordingTextSink forwards both ways**. Wrap a recording text sink
   around a fake `TextSurfaceSink`; push a line; assert the fake received
   it AND the recorder's finalized trace contains it.
10. **Inner sink error does not poison recorder**. If the inner sink
    returns an error, the recorder still records the line. (Decision:
    record-then-forward is wrong; we forward first, and if the forward
    errors, we DO NOT record — recording is observation of accepted
    output. Test pins this contract.)
11. **`finalize` is idempotent**. Two `finalize()` calls return equal
    `ReferenceTrace` values; one `record_text_event` between them appears
    in the second call.

## 8. Verification

```
cargo test -p utsushi-core recorder
cargo test -p utsushi-core
just check
```

## 9. Risks

- **ReplayLog determinism contract.** UTSUSHI-021 owns the determinism of
  `ReplayEntry` ordering and content. The recorder relies on the caller to
  push entries in the same order the `ReplayLog` already produces. Risk:
  if a future `ReplayLog` minor bump changes entry semantics, the recorder
  schema_version stays pinned but the embedded `replay_events` shape
  shifts. Mitigation: the recorder records `ReplayEntry` by serde forward,
  no re-derivation, so the embedded version is the `ReplayLog`'s own
  version.
- **Recorder buffer size.** In-memory accumulator grows linearly with
  events. Mitigation: this is a fixture-driven slice; long-run capture is
  UTSUSHI-061's problem.
- **Serializer key-order stability across serde versions.** Mitigated by
  the post-walk `Value` rebuild in §5; if a future serde-json version
  changes its `Value::Object` map type, the post-walk explicitly converts
  to `BTreeMap`-backed ordering so output is independent of the upstream
  default.
- **SourceTag enrichment temptation.** Future workers may want to add
  variants ("BrowserChromium", "WineProton"). The enum stays minimal in
  this slice; any addition is a schema_version bump and is out of scope.

## 10. Out of scope

- Actual recording from a real engine port (browser/native/Wine). Plug-in
  for those producers lands when the corresponding engine port ships.
- Live capture orchestration (driving a runtime to produce reference
  traces from a workflow). UTSUSHI-061+ will own this.
- Frame / audio artifact recording (no new `artifact_refs` field). A
  follow-up node will widen the trace when the first capture consumer
  needs it.
- Replay of a `ReferenceTrace`. Conformance checks consume the recorded
  JSON directly; nothing here re-runs it.
- Persistent on-disk recorder (this slice is in-memory only;
  `finalize_to_bytes()` is the only on-disk seam).

## 11. Worker scoping

One worker. The slice is bounded: one new submodule, four files, ~5
public types, ~11 unit tests, all in `utsushi-core`. No new crate, no
new workspace member, no cross-crate edit.
