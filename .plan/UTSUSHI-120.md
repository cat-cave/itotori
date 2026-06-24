# UTSUSHI-120 — Runtime substrate facade and conformance release

- **Node**: UTSUSHI-120
- **Title**: Runtime substrate facade and conformance release
- **Branch**: `spec/utsushi-120`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-120`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review (single planning slice)
- **Dependencies landed**: UTSUSHI-020 (VFS + asset package), UTSUSHI-021
  (deterministic input clock + replay log), UTSUSHI-022 (text/render/audio
  sinks), UTSUSHI-023 (snapshot primitives), UTSUSHI-024 (WASM embed ABI
  fixture), UTSUSHI-025 (engine port implementation map validator),
  UTSUSHI-026 (conformance manifest + result schema), UTSUSHI-027
  (trace + branch conformance), UTSUSHI-028 (snapshot conformance),
  UTSUSHI-029 (capture + recording conformance), UTSUSHI-030 (ingestion
  fixture), UTSUSHI-056 (observation hook protocol), UTSUSHI-060
  (reference recorder), UTSUSHI-062 (bridge-linked jump target + replay
  log fixture), UTSUSHI-063 (snapshot restore smoke), UTSUSHI-064
  (recording metadata smoke).
- **Direct downstream**: UTSUSHI-103 (engine port runner template);
  every engine port (RealLive / RPGM / Kirikiri) consumes one stable
  import path; itotori ingestion (downstream of UTSUSHI-030) reaches
  conformance + replay shapes through one re-export root.

## 1. Goal restatement

Publish a narrow, engine-neutral **runtime substrate facade** as the
single import root for engine runners and conformance consumers. The
facade aggregates the existing eight substrate slices (VFS, clock,
input + replay log, sinks, snapshot, embed ABI, recorder + reference
trace, conformance manifest + checks, port + observation hook) behind
one stable public surface. A conformance-style integration test proves
every subsystem is reachable through the facade alone — direct
submodule imports are NOT required to drive a runner end-to-end.

This slice is **pure aggregation + documentation**. No new types, no
new traits, no schema bumps, no behavior change. The facade exists to:

1. Pin a single import path that engine ports cite, so substrate
   refactors (e.g. eventually splitting `utsushi-core` into a
   `utsushi-substrate` crate) do not cascade into every port.
2. Make the "one stable API surface" claim falsifiable by a
   conformance test that imports only `utsushi_core::substrate::*`
   and exercises every subsystem.
3. Document the substrate contract in one place so port authors and
   downstream auditors find the surface without re-reading nine
   prior plans.

### Non-negotiable properties (auditFocus)

1. **Facade does NOT leak substrate internals.** The facade
   re-exports a curated subset of each subsystem's public surface
   (one canonical entry point per subsystem). Internal helpers,
   crate-private types, and the redaction module are NOT re-exported
   through the facade. The conformance test asserts every
   facade-exposed symbol is reachable; a separate compile-fail test
   (`tests/substrate_no_internal_leakage.rs`) asserts a fixed list of
   known internal symbols are NOT visible via the facade path.
2. **API surface is engine-neutral.** No engine family name
   (`RealLive`, `RPGM`, `Kirikiri`, `Wine`) appears in the facade
   module, the facade docs, or any facade-routed type. The
   `SourceTag` enum (UTSUSHI-060) is the single recognized
   engine-family axis, and it stays in the recorder subsystem with
   the canonical kebab-case variants `Browser`, `Native`, `Wine`,
   `Fixture`.
3. **Conformance gap closed.** The integration test
   `tests/substrate_conformance.rs` drives a smoke runner through
   the facade only and asserts the facade is sufficient to:
   - mount a VFS, open an asset, take a snapshot;
   - drive a logical clock + replay log under deterministic input;
   - emit text / audio / frame sink events;
   - record a reference trace via `ReferenceRecorder`;
   - load a conformance manifest, run a trace + branch + snapshot +
     capture check;
   - construct a port manifest, run a runner, observe lifecycle
     stages.
   Compile-time reachability is not enough; the test executes each
   path so a future API churn that breaks reachability fails CI.

### Hard architectural constraints

- **No new logic.** The facade is a single `pub mod substrate { ... }`
  with `pub use` items. Any helper that does not already exist in a
  substrate submodule is OUT of scope — this slice ships zero net
  new behavior.
- **No new workspace member.** The facade lives inside
  `crates/utsushi-core` to avoid a circular thin crate. A future
  `utsushi-substrate` extraction stays source-level back-compatible
  because the facade path becomes the canonical one (engine ports
  citing `utsushi_core::substrate::*` keep working when the crate
  splits).
- **No schema bump.** Recorder schema (`REFERENCE_TRACE_SCHEMA_VERSION`),
  conformance schema (`CONFORMANCE_SCHEMA_VERSION`), snapshot schema
  (`SNAPSHOT_SCHEMA_VERSION`), replay schema (`REPLAY_LOG_SCHEMA_VERSION`),
  embed schema (`EMBED_SCHEMA_VERSION`) all stay pinned. The facade
  re-exports each version constant so downstream callers see one
  import path for "what schemas does this substrate emit?".
- **No engine-specific test fixtures.** The conformance test uses
  the existing `SourceTag::Fixture` reference recorder fixture
  (UTSUSHI-060) and the existing jump-target fixture (UTSUSHI-062)
  for end-to-end coverage; no new fixture data is introduced.

## 2. Module placement

**Recommendation: new submodule `utsushi_core::substrate` in
`crates/utsushi-core/src/substrate.rs`.** No new workspace member.

```
crates/utsushi-core/
  src/
    lib.rs                         # gains `pub mod substrate;`
    substrate.rs                   # NEW — pure re-export root
    clock.rs, conformance/, embed/, input/, port/, recorder/,
    replay/, sink/, snapshot/, vfs/   # unchanged
  tests/                           # NEW additive (no crate-level tests
                                   #   for the substrate today)
    substrate_conformance.rs       # end-to-end smoke via facade only
    substrate_no_internal_leakage.rs   # compile-fail style test (see §7)
```

Justification:

- `utsushi-core` already owns every subsystem the facade aggregates;
  a thin sibling crate would force every downstream consumer to add
  a second Cargo dependency for zero behavior gain at this stage.
- The plan is explicitly forward-compatible with a future
  `utsushi-substrate` extraction: the facade module is the natural
  carve-out point because it already names exactly the surface that
  would migrate.
- `lib.rs` is already large (~5400 lines per UTSUSHI-020); the
  facade is intentionally a sibling file so its re-export list
  reviews as one coherent diff.

The facade is the **eighth** new sibling module (the previous seven
landed across UTSUSHI-020..060). No reshuffling of existing modules.

## 3. Facade surface

`crates/utsushi-core/src/substrate.rs` contains one `pub use` block
per subsystem. Each subsystem gets one canonical entry point plus a
small list of contract types directly required to drive that entry
point. Convenience re-exports of helper types that downstream callers
demonstrably use today (verified from the prior plans' "downstream
consumer" sections) are included; everything else stays behind the
direct-submodule path for the rare consumer that needs it.

### 3.1 Subsystem entry points

```rust
//! Engine-neutral runtime substrate facade.
//!
//! This module is the **single import root** for engine ports and
//! conformance consumers. The narrow public surface re-exported here is
//! the only stable API surface; everything else under
//! `utsushi_core::*` is internal substrate detail subject to change.
//!
//! See `docs/utsushi-substrate-facade.md` for the contract.

// --- VFS subsystem (UTSUSHI-020) -------------------------------------
pub use crate::vfs::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage,
    CaseRule, PackageDescriptor, PackageKind, RuntimeVfs,
    TraversalKind, VfsError, VfsResult,
};

// --- Clock + input + replay (UTSUSHI-021) -----------------------------
pub use crate::clock::{ClockOrigin, LogicalClock, LogicalClockTick};
pub use crate::input::{
    ChoiceIndex, InputError, InputEvent, InputKind, MenuTarget,
    PointerButton, RawInputCode,
};
pub use crate::replay::{
    REPLAY_LOG_SCHEMA_VERSION, ReplayCursor, ReplayEntry, ReplayLog,
    ReplayLogBuilder, ReplayMetadata, ReplaySchemaVersion,
};

// --- Sink subsystem (UTSUSHI-022) -------------------------------------
pub use crate::sink::{
    AudioEvent, AudioEventKind, AudioEventSink, FrameArtifact,
    FrameArtifactSink, SinkCapability, SinkCapabilitySummary,
    SinkError, SinkKind, SinkResult, SinkSet, TextLine,
    TextSurfaceSink,
};

// --- Snapshot subsystem (UTSUSHI-023) ---------------------------------
pub use crate::snapshot::{
    InMemorySnapshotStore, Inspectable, Restorable, RestoreReport,
    SNAPSHOT_SCHEMA_VERSION, Snapshot, SnapshotError, SnapshotId,
    SnapshotRef, SnapshotRequest, SnapshotSchemaVersion,
    SnapshotStore, SnapshotStoreError, StateChange, StateChangeKind,
    StateDiff, StateNamespace, StatePath, StateTree, StateValue,
    diff_snapshots, restore_snapshot, take_snapshot,
};

// --- Embed ABI (UTSUSHI-024) ------------------------------------------
pub use crate::embed::{
    EMBED_SCHEMA_VERSION, EmbedArtifactRef, EmbedCapability,
    EmbedCapabilityId, EmbedCapabilityStatus, EmbedError,
    EmbedSchemaVersion, EmbedSnapshotRef, EmbedState, EmbedTrace,
    EmbedTraceLine, embed_capabilities, embed_state,
};

// --- Recorder + reference trace (UTSUSHI-060/062) ---------------------
pub use crate::recorder::{
    InMemoryReferenceRecorder, REFERENCE_TRACE_SCHEMA_VERSION,
    RecordingTextSink, ReferenceRecorder, ReferenceTrace, SourceTag,
    deterministic_json_bytes,
};

// --- Conformance manifest + checks (UTSUSHI-025..030) -----------------
pub use crate::conformance::{
    CONFORMANCE_SCHEMA_VERSION, ConformanceAbiVersion,
    ConformanceError, ConformanceManifest, ConformanceProfile,
    ConformanceResult, EvidenceRef, ProfileExtension, ProfileId,
    ResultOutcome,
    cross_validate_conformance_manifest_against_port_manifest,
    cross_validate_results_against_manifest,
};
pub use crate::conformance::trace_branch::{
    BranchCheckResult, BranchConformanceCheck, ObservedBranch,
    ObservedTextEvent, TraceCheckResult, TraceConformanceCheck,
};
// Snapshot + capture conformance entry points (UTSUSHI-028/029).
pub use crate::conformance::{
    CaptureCheckSummary, FrameCaptureConformanceCheck,
    RecordingCheckSummary, RecordingConformanceCheck,
    RecordingMetadata, SnapshotConformanceCheck,
};

// --- Port + observation hook (UTSUSHI-025/056) ------------------------
pub use crate::port::{
    EnginePort, EnginePortAdapter, EnginePortError, LifecycleStage,
    MomentId, OPTIONAL_LIFECYCLE_STAGES, PortCapability, PortEnv,
    PortManifest, PortRequest, PortShutdownOutcome,
    PortShutdownStatus, REQUIRED_LIFECYCLE_STAGES, Runner,
    RunnerCancellation, RunnerObservation, RunnerOutcome,
};

// --- Redaction policy (UTSUSHI-056) -----------------------------------
//
// The redaction filter is exposed through the facade because every
// substrate-emitted artifact (snapshot, replay log, reference trace,
// conformance result) is required to pass the same filter on the way
// out. Engine ports run the filter on adapter-emitted strings before
// handing them to the substrate.
pub use crate::redaction::reject_unredacted_local_paths;
```

### 3.2 What the facade deliberately does NOT re-export

The facade is the curated surface; the following are intentionally
left at their direct-submodule paths:

- `AssetIdErrorReason`, `AssetRef`, `AssetSize`, `MountedVfs`,
  `PlaintextDirPackage`, `RequiredCapability`, `IoSummary`,
  `ResourceBoundKind`, `TransformKind` — VFS implementation-side
  detail; ports consume `RuntimeVfs` + `AssetId` + `AssetBytes` and
  the diagnostic enum `VfsError`. Implementation packages reach the
  direct submodule.
- Trace-branch helper types `BranchCheckOptions`,
  `BranchMismatch`, `BranchMismatchKind`, `GoldenBranch`,
  `GoldenTextEvent`, `TextNormalisation`, `TraceCheckOptions`,
  `TraceMismatch`, `TraceMismatchKind`, `ArtifactCountRange`,
  `DurationRangeMs`, `SubsystemRequirement`,
  `FrameArtifactRef as CaptureFrameArtifactRef`,
  `unsupported_frame_capture_result`,
  `unsupported_recording_capture_result`,
  `unsupported_snapshot_restore_result` — conformance internals;
  authoring a check from inside the conformance crate path is the
  rare consumer.
- Crate-private helpers like `reject_unredacted_local_paths_public`
  and `looks_like_local_path_public` (already private).
- Sink-payload-internal types (e.g. helper constants like
  `EMBED_MAX_ARTIFACT_REFS`, `EMBED_MAX_CAPABILITIES`) — exposed
  only through the `embed_capabilities()` / `embed_state()`
  accessor functions in the facade.

The omission list is documented in `docs/utsushi-substrate-facade.md`
(§4 below) so reviewers see explicit "what's excluded and why" rather
than spot-checking.

### 3.3 Re-export discipline

- One `pub use` per subsystem, grouped + commented with the owning
  spec id.
- Each item appears exactly once across all `pub use` blocks;
  duplicate symbols across subsystems (e.g. `EvidenceRef` lives in
  `conformance`) get a single canonical re-export.
- Item order inside each block: types first, traits second,
  constants third, free functions last. The conformance test asserts
  this order via a sorted-walk of the module's public items
  (mechanical; mirrors the UTSUSHI-022 sink-capability sort
  pattern).

## 4. Documentation

`docs/utsushi-substrate-facade.md` (new) documents:

1. The contract: substrate facade is the only stable surface;
   submodule paths are internal.
2. Subsystem entry points (one table row per re-export) with the
   owning spec id and a one-sentence "use this when…" prompt.
3. Explicit exclusion list (§3.2) with the rationale per omitted
   symbol.
4. Engine-neutrality rule: `SourceTag::{Browser,Native,Wine,Fixture}`
   is the only engine-family axis; no engine port name appears in
   facade-exposed symbols, docs, or tests.
5. Schema version inventory: every schema version constant
   re-exported by the facade plus a pin reminder ("bumps require a
   substrate facade revision per the conformance release contract").
6. Forward-compatibility note: a future `utsushi-substrate` crate
   extraction is source-level back-compatible iff every consumer
   imports via `utsushi_core::substrate::*`.

`docs/roadmap-utsushi-runtime.md` (existing): append one paragraph
under the runtime-substrate alpha track noting that the facade ships
in this slice and naming the conformance release ABI version
(matches `ConformanceAbiVersion` re-exported from `conformance`).
This is the only doc edit outside the new facade doc.

## 5. Conformance release ABI version

The facade pins the conformance release at the existing
`ConformanceAbiVersion` constant (owned by UTSUSHI-026; unchanged in
this slice). The substrate facade does NOT introduce a new version
constant — instead, the facade's own "is this the contract you
think it is?" assertion uses a private `const _: () =
substrate_facade_assertions();` block in `substrate.rs` that:

- Asserts each re-exported schema-version constant is still its
  expected literal (e.g. `REFERENCE_TRACE_SCHEMA_VERSION ==
"0.1.0-alpha"`). Drift trips a compile error in this crate.
- Asserts the `SourceTag` variant set is exactly the four known
  values (via a match-exhaustive `match` over a const fixture).
  Adds a new engine-neutral variant later? The assert fails and
  the facade revision is required.

This keeps the facade structurally honest without adding a runtime
test for compile-time constants.

## 6. Implementation steps

The implementation worker translates this plan into:

1. Add `pub mod substrate;` to `crates/utsushi-core/src/lib.rs`
   immediately after the existing `pub mod vfs;` line, preserving
   alphabetic order.
2. Write `crates/utsushi-core/src/substrate.rs` with the §3.1
   re-export blocks verbatim, the §3.2 exclusion comment, and the
   §5 const-assertion block.
3. Write the conformance test in §7.1 and the leakage gate in §7.2.
4. Author `docs/utsushi-substrate-facade.md` per §4.
5. Append the roadmap paragraph per §4.

No edits to any subsystem module. No `Cargo.toml` change. No
dependency change.

## 7. Test plan

Two new integration tests live in `crates/utsushi-core/tests/`.

### 7.1 `substrate_conformance.rs`

The headline test. Drives a smoke runner end-to-end through the
facade-only import path and asserts every subsystem is reachable +
exercised.

```rust
use utsushi_core::substrate::{
    // VFS
    AssetId, RuntimeVfs,
    // Clock + input + replay
    LogicalClock, ReplayLog, ReplayLogBuilder, InputEvent, InputKind,
    // Sinks
    TextLine, TextSurfaceSink, SinkSet,
    // Snapshot
    InMemorySnapshotStore, SnapshotStore, take_snapshot,
    // Embed
    embed_capabilities, embed_state,
    // Recorder
    InMemoryReferenceRecorder, ReferenceRecorder, SourceTag,
    deterministic_json_bytes,
    // Conformance
    ConformanceManifest, TraceConformanceCheck, ObservedTextEvent,
    // Port
    PortManifest, PortRequest, LifecycleStage,
    // Redaction
    reject_unredacted_local_paths,
};
```

Test cases (one `#[test]` per case):

1. `mount_a_fixture_vfs_through_the_facade()` — construct a
   `PlaintextDirPackage`-equivalent via the facade
   (`PackageDescriptor`/`AssetPackage`/`AssetId`/`AssetBytes`) and
   open one asset.
2. `drive_a_logical_clock_and_replay_log_through_the_facade()` —
   build a `ReplayLog` via `ReplayLogBuilder`, advance ticks, assert
   round-trip serialization passes
   `deterministic_json_bytes`.
3. `emit_text_audio_frame_sink_events_through_the_facade()` —
   construct a `SinkSet` with the three sink kinds and accept one
   event each; assert no redaction violation via
   `reject_unredacted_local_paths`.
4. `take_and_restore_a_snapshot_through_the_facade()` — `Inspectable`
   over a tiny struct, `take_snapshot`, store via
   `InMemorySnapshotStore`, `restore_snapshot`.
5. `record_a_reference_trace_through_the_facade()` — push three text
   events, two embed capabilities, one snapshot ref, two replay
   entries; assert `finalize_to_bytes()` is byte-stable across two
   calls (mirrors UTSUSHI-060 §7.1).
6. `run_a_trace_conformance_check_through_the_facade()` — load a
   minimal `ConformanceManifest` (one profile, one trace check),
   feed an `ObservedTextEvent` set, assert the
   `TraceConformanceCheck` returns `ResultOutcome::Pass`.
7. `instantiate_a_port_manifest_and_inspect_lifecycle_through_the_facade()`
   — build a `PortManifest` with the required lifecycle stages,
   assert `REQUIRED_LIFECYCLE_STAGES` matches the `LifecycleStage`
   set the facade re-exports.
8. `every_facade_exposed_schema_version_is_pinned()` — assert each
   facade-re-exported schema-version constant equals its expected
   literal string. This is the runtime mirror of §5's compile-time
   const-assertion and is the test that fails loudly when a future
   substrate change forgets to bump the facade contract.
9. `source_tag_variant_set_is_engine_neutral()` — match every
   `SourceTag` variant and assert the set is exactly
   `{Browser, Native, Wine, Fixture}`. A new engine-family variant
   added without revising the facade contract fails this test
   structurally.

Hard constraint enforced by file-level lint: the test file imports
only `use utsushi_core::substrate::*;` (or `use
utsushi_core::substrate::{...};`). No `use utsushi_core::vfs::*;`
etc. anywhere in the file. The conformance test asserts this with a
literal-string check on its own source (uses `include_str!` of the
test file's path), so "we accidentally reached around the facade" is
catchable in CI.

### 7.2 `substrate_no_internal_leakage.rs`

A compile-fail-style negative test that asserts known internal
symbols are NOT visible through the facade. Implemented as a list of
expected absences plus a run-time reflection-style check via the
`trybuild` pattern is overkill for one slice; instead, this test
relies on the conformance test's own import discipline plus a
documentation-grade assertion list inside this file:

```rust
//! Substrate facade leakage gate.
//!
//! Each line below is a symbol that MUST NOT be re-exported through
//! the substrate facade. Each line is verified by attempting to
//! import the symbol via the facade path; the import is wrapped in a
//! macro that succeeds when the symbol is absent and fails (compile
//! error) when present.

// The actual mechanism: a #[cfg(test)] inline module that names the
// known-internal symbols and lets `cargo test` confirm by build-time
// resolution. The test is two-phase:
//   1. The compile-test asserts no facade re-export adds an
//      internal symbol (manual: reviewer pairs every new `pub use`
//      in `substrate.rs` against this exclusion list).
//   2. A runtime `#[test]` walks a small JSON manifest in
//      `tests/substrate_exclusion_list.json` and `cargo expand`-free
//      check that the substrate module's public items are exactly
//      the §3.1 set.
```

The implementer ships the JSON exclusion list with one line per
omitted symbol named in §3.2; the runtime test in
`substrate_no_internal_leakage.rs` uses
`std::any::type_name`-style reflection (or `syn`-parsing
`substrate.rs` source under `OUT_DIR`) only if straightforward. If
the reflection path proves unergonomic, the implementer falls back
to a documentation-only manifest (`tests/substrate_facade_surface.md`
listing exposed + excluded symbols) and a `cargo expand`-driven
manual review. The slice's hard requirement is §7.1; §7.2 is the
defense in depth.

### 7.3 Engine-neutrality lint

A focused lint in `substrate_conformance.rs`:

```rust
#[test]
fn facade_module_source_contains_no_engine_family_names() {
    let src = include_str!("../src/substrate.rs");
    let forbidden = [
        "RealLive", "real_live", "reallive",
        "RPGM", "RpgMaker", "rpg_maker", "rpgm",
        "Kirikiri", "kirikiri", "Xp3", "xp3",
        "Siglus", "siglus",
    ];
    for needle in forbidden {
        assert!(
            !src.contains(needle),
            "facade source contains engine-family name {needle:?}; \
             the substrate facade must stay engine-neutral",
        );
    }
}
```

This is the load-bearing structural defense for auditFocus item
"API surface engine-specific". Same lint runs against the new
documentation file (`docs/utsushi-substrate-facade.md`) via a
sibling test that asserts the same forbidden list against the doc's
bytes (`include_str!("../../../docs/utsushi-substrate-facade.md")`).

## 8. Verification commands

```bash
cargo test -p utsushi-core substrate              # §7.1 + §7.2
cargo test -p utsushi-core                        # full crate
just check                                        # lint + types
just test                                         # full repo sweep
```

`just check` invokes `cargo fmt --check` + `cargo clippy --workspace
--all-targets -- -D warnings`. No new `just` target.

## 9. Risks

### 9.1 Facade scope creep

The facade is a re-export root; the temptation is to inline
"convenience helpers" (e.g. a `mount_fixture_vfs(&Path)` wrapper).
The plan refuses: every helper would be either engine-family-specific
or a new public API that this slice explicitly forbids. Reviewers
should reject any PR that adds a new `fn`/`struct`/`trait` definition
to `substrate.rs`. Mitigation: §6 process step 2 names "verbatim
re-exports only" as the implementer's instruction; §7.1 case 1
exercises the existing `RuntimeVfs` + `AssetPackage` types directly,
not a wrapper.

### 9.2 Internal-leakage drift across substrate refactors

A future substrate refactor (e.g. moving a type from `embed::` to a
sibling module) may force a facade update that accidentally widens
the re-export set. Mitigation: the conformance test's
`every_facade_exposed_schema_version_is_pinned` + the engine-
neutrality lint catch the load-bearing cases; the documentation
file's exclusion list (§3.2) is the human-review gate.

### 9.3 SourceTag enrichment temptation

Adding a new engine-family variant (e.g. `BrowserChromium`,
`WineProton`) is downstream of this slice. The `SourceTag` invariant
in test §7.1 case 9 keeps the facade contract honest: any variant
addition lands a substrate facade revision (this node's successor)
that adopts the new variant explicitly.

### 9.4 Schema version drift

If a substrate slice (recorder, replay log, snapshot) bumps its
schema version constant without revising the facade contract, the
const-assertion in §5 breaks the build. This is the intended trip
wire — the implementer of the bumping slice MUST coordinate a
facade-revision PR.

### 9.5 Conformance test brittleness

The §7.1 case 8 hard-codes literal schema-version strings (e.g.
`"0.1.0-alpha"` for `REFERENCE_TRACE_SCHEMA_VERSION`). Mitigation:
the test asserts equality against the re-exported constant value,
not against a hardcoded literal; the constant pinning rule is in §5.

### 9.6 Audit-focus checklist

| Audit focus                                | Structural defense                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Facade leaks substrate internals           | §3.2 exclusion list, §7.2 leakage gate, doc surface in §4, manual code-review gate against new `pub use` items.                                                                  |
| API surface engine-specific                | §7.3 engine-neutrality lint over facade source and docs; §7.1 case 9 `SourceTag` variant pin; doc rule §4(4).                                                                    |
| Conformance gaps undermine "one stable surface" | §7.1 nine end-to-end cases drive every subsystem through the facade only; case 6 runs a real conformance check; case 8 pins schema versions so a silent bump is loud in CI.   |

## 10. Out of scope

- **Splitting `utsushi-core` into a `utsushi-substrate` crate.**
  Forward-compatible per §1 / §4; not done in this slice.
- **New helpers or convenience wrappers** on the facade. §9.1.
- **Substrate behavior changes** — every subsystem stays at its
  current shape and schema version.
- **Engine port implementations.** UTSUSHI-103 owns the runner
  template; engine-family ports (RealLive / RPGM / Kirikiri) consume
  the facade.
- **WASM-side facade.** The embed ABI (UTSUSHI-024) already pins a
  wasm-friendly surface; a separate WASM facade is not needed.
- **TypeScript mirror** of the facade surface. Itotori ingestion
  (downstream of UTSUSHI-030) consumes conformance result JSON, not
  Rust types; no TS facade is required.
- **Live engine conformance tests.** Fixture-only in this slice;
  engine ports run their own conformance suites via the facade
  later.

## 11. Worker scoping

**One worker.** Scope is bounded:

- One new sibling file in `utsushi-core/src/` (~200 LOC of
  documented `pub use` blocks and one const-assertion).
- One additive line in `lib.rs`.
- Two new integration test files in `utsushi-core/tests/` (~300
  LOC combined).
- One new doc file (`docs/utsushi-substrate-facade.md`) plus one
  paragraph appended to `docs/roadmap-utsushi-runtime.md`.

Estimated diff size: ~600 LOC (≈200 facade source + ≈300 tests +
≈100 doc), well inside a single-worker scope per the UTSUSHI-022 /
UTSUSHI-060 precedent. No cross-crate API change. No
schema-package change. No `Cargo.toml` change.

---

## Plan-only confirmation

This document is plan-only. No facade code, no test files, no docs,
and no `lib.rs` edits are committed by this PR. The implementation
worker will translate this plan into code in a follow-up branch
under `spec/utsushi-120`.
