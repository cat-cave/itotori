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

| Subsystem                     | Owning spec      | Canonical type / fn                                                         | Use when…                                             |
| ----------------------------- | ---------------- | --------------------------------------------------------------------------- | ----------------------------------------------------- |
| Runtime VFS                   | UTSUSHI-020      | `RuntimeVfs`, `AssetPackage`, `AssetId`                                     | You mount engine content for read.                    |
| Logical clock                 | UTSUSHI-021      | `LogicalClock`, `LogicalClockTick`                                          | You advance deterministic time.                       |
| Input + replay log            | UTSUSHI-021      | `InputEvent`, `ReplayLogBuilder`, `ReplayLog`                               | You record / replay a deterministic input stream.     |
| Sinks (text / audio / frame)  | UTSUSHI-022      | `SinkSet`, `TextSurfaceSink`, `FrameArtifactSink`, `AudioEventSink`         | You emit observed runtime events.                     |
| Snapshot primitives           | UTSUSHI-023      | `Inspectable`, `Restorable`, `take_snapshot`                                | You expose / restore controlled-playback state.       |
| Embed ABI                     | UTSUSHI-024      | `EmbedState`, `embed_capabilities`, `embed_state`                           | You expose a host-readable snapshot of the substrate. |
| Reference recorder            | UTSUSHI-060      | `ReferenceRecorder`, `InMemoryReferenceRecorder`                            | You produce a reference trace from a fixture run.     |
| Conformance manifest + checks | UTSUSHI-025..030 | `ConformanceManifest`, `TraceConformanceCheck`, `RecordingConformanceCheck` | You declare or evaluate conformance.                  |
| Port + observation hook       | UTSUSHI-025/056  | `PortManifest`, `EnginePort`, `LifecycleStage`                              | You expose an engine port to the runner.              |
| Redaction policy              | UTSUSHI-056      | `reject_unredacted_local_paths`                                             | You sweep an outgoing artifact for host-path leakage. |

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
| `SNAPSHOT_SCHEMA_VERSION`        | `0.1.0-alpha` | UTSUSHI-023     |
| `EMBED_SCHEMA_VERSION`           | `0.1.0-alpha` | UTSUSHI-024     |
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
- Sink-payload-internal constants: `EMBED_MAX_ARTIFACT_REFS`,
  `EMBED_MAX_CAPABILITIES` (the accessor functions
  `embed_capabilities()` and `embed_state()` are exposed instead).

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
