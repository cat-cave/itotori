# Utsushi substrate facade contract

Status: alpha (UTSUSHI-120)
Schema authority: `utsushi_core::substrate`

## 1. Contract

`utsushi_core::substrate` is the **single import root** for engine ports
and conformance consumers. The narrow public surface re-exported there
is the only stable API surface; everything else under `utsushi_core::*`
is internal substrate detail subject to change.

Consumers MUST reach the substrate through this path. Direct submodule
imports (`utsushi_core::vfs::*`, `utsushi_core::recorder::*`, etc.) are
NOT part of the stable contract and may move when the substrate
extracts into its own crate.

A future `utsushi-substrate` crate extraction is source-level
back-compatible iff every consumer imports via
`utsushi_core::substrate::*`. The const-assertion block in
`crates/utsushi-core/src/substrate.rs` (and the runtime test mirror in
`crates/utsushi-core/tests/substrate_conformance.rs`) make a silent
contract drift loud at build time.

## 2. Subsystem entry points

| Subsystem                     | Owning spec      | Canonical type / fn                                                           | Use when…                                                |
| ----------------------------- | ---------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| Runtime VFS                   | UTSUSHI-020      | `RuntimeVfs`, `AssetPackage`, `AssetId`                                       | You mount engine content for read.                       |
| Logical clock                 | UTSUSHI-021      | `LogicalClock`, `LogicalClockTick`                                            | You advance deterministic time.                          |
| Input + replay log            | UTSUSHI-021      | `InputEvent`, `ReplayLogBuilder`, `ReplayLog`                                 | You record / replay a deterministic input stream.        |
| Sinks (text / audio / frame)  | UTSUSHI-022      | `SinkSet`, `TextSurfaceSink`, `FrameArtifactSink`, `AudioEventSink`           | You emit observed runtime events.                        |
| Snapshot primitives           | UTSUSHI-023      | `Inspectable`, `Restorable`, `take_snapshot`                                  | You expose / restore controlled-playback state.          |
| Embed capability surface      | UTSUSHI-024      | `EmbedCapability`, `EmbedCapabilityId`, `EmbedCapabilityStatus`, `EmbedError` | You declare the observable surface a host embed exposes. |
| Reference recorder            | UTSUSHI-060      | `ReferenceRecorder`, `InMemoryReferenceRecorder`                              | You produce a reference trace from a fixture run.        |
| Conformance manifest + checks | UTSUSHI-025..030 | `ConformanceManifest`, `TraceConformanceCheck`, `RecordingConformanceCheck`   | You declare or evaluate conformance.                     |
| Port + observation hook       | UTSUSHI-025/056  | `PortManifest`, `EnginePort`, `LifecycleStage`, `CaptureOutcome`              | You expose an engine port to the runner.                 |
| Redaction policy              | UTSUSHI-056      | `reject_unredacted_local_paths`                                               | You sweep an outgoing artifact for host-path leakage.    |

The facade also re-exports the universal `EvidenceTier` and
`FidelityTier` tier enums, plus `ObservationArtifactRef` /
`ObservationBridgeRef` (the canonical payload-shape types every sink
emits and conformance reader consumes).

## 3. Schema version inventory

Every facade-re-exported schema version constant is pinned by a
compile-time const-assertion in `substrate.rs`:

| Schema                           | Value         | Owning spec     |
| -------------------------------- | ------------- | --------------- |
| `REPLAY_LOG_SCHEMA_VERSION`      | `0.1.0-alpha` | UTSUSHI-021     |
| `SNAPSHOT_SCHEMA_VERSION`        | `0.2.0-alpha` | UTSUSHI-023     |
| `REFERENCE_TRACE_SCHEMA_VERSION` | `0.1.0-alpha` | UTSUSHI-060     |
| `CONFORMANCE_SCHEMA_VERSION`     | `0.2.0-alpha` | UTSUSHI-026/028 |

A substrate slice that bumps its schema version constant without
revising the facade contract trips the const-assertion at build time;
the substrate facade revision (this node's successor) is the
coordinated landing point for any bump.

## 4. Engine neutrality

`SourceTag` is the only engine-family axis in the facade. Its variant
set is exactly four engine-neutral values: `Browser`, `Native`, `Wine`,
`Fixture`. No engine port name appears in:

- the facade module source (`crates/utsushi-core/src/substrate.rs`);
- this documentation file;
- any facade-routed type definition.

The conformance test enforces this with two engine-neutrality lints —
one over the facade source bytes, one over this document's bytes. A
new engine-family variant added without a matching facade revision
fails the `SourceTag` exhaustive-match assertion in `substrate.rs`.

## 5. Deliberately-excluded surface

The following are intentionally left at their direct-submodule paths
because they are engine-implementation helpers, conformance internals,
or crate-private validators that downstream port authors do not need
to reach:

- VFS implementation helpers: `AssetIdErrorReason`, `AssetRef`,
  `MountedVfs`, `PlaintextDirPackage`, `RequiredCapability`,
  `IoSummary`, `ResourceBoundKind`, `TransformKind`. Implementations
  reach the direct submodule.
- Trace-branch helpers used only inside the conformance crate path:
  `BranchCheckOptions`, `BranchMismatch`, `BranchMismatchKind`,
  `GoldenBranch`, `TraceMismatch`, `TraceMismatchKind`,
  `ArtifactCountRange`, `DurationRangeMs`, `SubsystemRequirement`,
  `FrameArtifactRef as CaptureFrameArtifactRef`,
  `unsupported_frame_capture_result`,
  `unsupported_recording_capture_result`,
  `unsupported_snapshot_restore_result`.
- Crate-private helpers: `reject_unredacted_local_paths_public`,
  `looks_like_local_path_public`.
- Embed capability helpers and bound consumed by the reference
  recorder at finalize time: `sort_capabilities`,
  `validate_capability_list`, `EMBED_MAX_CAPABILITIES`. The facade
  re-exports the capability value types (`EmbedCapability` and its
  id/status enums) instead; the recorder reaches these helpers at
  their direct submodule path.

When a downstream consumer demonstrates a need for one of these
symbols, the correct response is to revise the facade — not to reach
around it. The conformance test will surface any such reach-around as
a forbidden-import lint failure.

## 6. Forward compatibility

The facade is the natural carve-out point for a future
`utsushi-substrate` crate extraction. When that landing happens:

1. `crates/utsushi-substrate/src/lib.rs` re-exports the substrate
   subsystems verbatim from a new `utsushi-substrate-impl` crate.
2. `utsushi_core` continues to expose `pub mod substrate` as a
   shim that re-exports `pub use utsushi_substrate::*;`.
3. Every consumer that imports via `utsushi_core::substrate::*`
   keeps working without source change.

The conformance release ABI version is owned by `ConformanceAbiVersion`
(UTSUSHI-026) and is re-exported through this facade. The facade
does NOT introduce a separate facade version constant; instead, the
const-assertion block in `substrate.rs` is the structural pin.

## 7. Canonical runtime path

The runtime layer currently forks into two abstractions plus a
free-function bypass. This section fixes the single canonical
architecture so the dependent routing/delete nodes have one direction
to migrate toward; no code change is required by the decision itself.

**Decision: `EnginePort` + `Runner` is the canonical engine-port
substrate. The `RuntimeAdapter` registry is the thin CLI dispatch
seam, not a competing runtime.** These two are not symmetric
competitors: `EnginePortAdapter<P>` already
`impl RuntimeAdapter` (`crates/utsushi-core/src/port/runtime_adapter.rs:122`),
so the canonical shape is the port substrate sitting _behind_ the
dispatch seam. Every adapter registered into
`RuntimeAdapterRegistry` is — at the canonical endpoint — an
`EnginePortAdapter<SomePort>`; the `RuntimeAdapter` trait stays only
as the registry's dispatch interface (`descriptor`/`trace`/
`capture`/`smoke_validate`). Hand-rolled `impl RuntimeAdapter` bodies
that re-implement lifecycle logic in parallel with a port, and the
standalone engine-VM `replay_scene` CLI driver, are the non-canonical
paths to be folded in or deleted.

Direction of the dependency is fixed: **the adapter wraps the port,
never the reverse.** `Runner` drives an `EnginePort` through its
lifecycle inside `EnginePortAdapter::run_lifecycle`; the seam never
re-derives lifecycle behaviour of its own.

### 7.1 No-legacy-compat endpoint

At the canonical endpoint there is exactly one runtime path: CLI
dispatch (`RuntimeAdapterRegistry`) → `EnginePortAdapter<P>` →
`Runner` → `EnginePort`. The hand-rolled parallel adapters and the
free-function replay driver are _deleted_ once their replacement is
wired in the same change — not retained behind a feature flag,
`#[deprecated]`, or dual plumbing.

### 7.2 Scope table — the three current runtime paths

| Current runtime path                                          | What it is today                                                                                                                                                                                                                                                                                                                                                                                                               | Resolution node                                                        | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RuntimeAdapterRegistry` + hand-rolled `RuntimeAdapter` impls | `crates/utsushi-cli/src/main.rs` drives capabilities/trace/capture/smoke through the registry; `FixtureRuntimeAdapter` (`crates/utsushi-fixture/src/lib.rs:51`) hand-rolls `impl RuntimeAdapter` in parallel with `FixtureEnginePort` (`crates/utsushi-fixture/src/engine_port.rs`).                                                                                                                                           | `utsushi-delete-parallel-runtime-adapter`                              | **delete** — rebase `FixtureRuntimeAdapter` onto `EnginePortAdapter<FixtureEnginePort>` and delete the duplicate hand-rolled lifecycle body. The registry itself is the dispatch seam and is kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `EnginePort` / `Runner` substrate                             | Implemented by `FixtureEnginePort` (real); `Runner` only executes inside `EnginePortAdapter::run` and tests, never instantiated by a product binary.                                                                                                                                                                                                                                                                           | `utsushi-cli-route-conformance-result`                                 | **wire** — give `Runner` + the `*ConformanceCheck` / `ConformanceManifest` family their first product-binary consumer via a routed CLI subcommand that writes a `ConformanceResult`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Standalone engine-VM `replay_scene` CLI driver                | `crates/utsushi-cli/src/replay.rs` and `replay_validate.rs` call the engine-VM crate's `replay_scene` free function directly, bypassing both abstractions. (The old engine-VM-side `validate_*` free-function validator was deleted in the sentinel/fake-binary purge; the `replay-validate` command now emits the observed `TextLine` output and `ReplayLog` JSON, and validation of that evidence lives on the caller side.) | engine-VM replay-routing node (P2 decomposition node 4 of this parent) | **defer** — that engine's port is now the real substrate producer (its `launch`/`observe` drive the text/frame/audio sinks from a single real-bytes replay; it is no longer an `EnginePortError::Lifecycle` stub), but the shipping `replay` / `replay-validate` CLI subcommands still call the `replay_scene` free function directly instead of routing through `Runner` + `EnginePortAdapter`. no-legacy-compat forbids deleting the shipping free-function driver before that routing lands; the remaining work is to dispatch `replay` / `replay-validate` through the port's `observe` internals and delete the free-function driver in the same change. |

The `BrowserLaunchAdapter` and `NwjsLaunchAdapter` hand-rolled
adapters registered alongside `FixtureRuntimeAdapter` are sub-cases of
the first row: each becomes an `EnginePortAdapter<SomePort>` once its
engine port exists, and the hand-rolled body is deleted at that point.
No fourth runtime path exists outside these three.

### 7.3 Cross-references

- **UTSUSHI-154** ("Fixture engine port adoption", UTSUSHI-103
  Slice B) rebases `FixtureRuntimeAdapter` onto
  `EnginePortAdapter<FixtureEnginePort>`, making the shipping CLI
  trace/capture/smoke path the **first product execution of
  `Runner`**. `utsushi-delete-parallel-runtime-adapter` then enforces
  the no-legacy-compat deletion on top of it.
- **UTSUSHI-160** ("First production engine port consumes
  `ConformanceManifest`") is the first non-test consumer of the
  conformance surface and the foundation
  `utsushi-cli-route-conformance-result` builds on.

### 7.4 Engine-neutrality note

This document is held engine-neutral by the
`facade_documentation_contains_no_engine_family_names` lint in
`crates/utsushi-core/tests/substrate_conformance.rs` (see §4). The
third runtime path and its resolution node are therefore named by
**role** (engine-VM `replay_scene` driver; P2 decomposition node 4),
not by the engine-specific crate, port type, or node id. The literal,
engine-named node id and crate path live in `roadmap/spec-dag.json`
(this parent's decomposition) and in that node's own spec, which are
not subject to the neutrality lint.
