# UTSUSHI-029 — Capture and recording artifact conformance

- **Node**: UTSUSHI-029
- **Title**: Capture and recording artifact conformance
- **Branch**: `spec/utsushi-029`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-029`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review (single implementation slice)
- **Dependencies landed**: UTSUSHI-022 (sinks), UTSUSHI-026 (conformance
  manifest + result schema). UTSUSHI-020 / UTSUSHI-021 / UTSUSHI-103
  substrate landed earlier.
- **Parallel siblings**: UTSUSHI-023, UTSUSHI-027 (trace + branch
  conformance — also extends `conformance/result.rs`), KAIFUU-010.
- **Direct downstream**: UTSUSHI-030 (Itotori ingestion) consumes the
  capture and recording check outputs through the same
  `ConformanceResult` envelope UTSUSHI-026 ships.

## 1. Goal restatement

Add the **capture + recording side** of the runtime conformance contract:
two new check types, paired metadata payloads, and a fixture set, all
sitting on top of UTSUSHI-026's `ConformanceManifest` / `ConformanceResult`
substrate and consuming UTSUSHI-022's `FrameArtifactSink` /
`AudioEventSink` evidence. The slice produces only types, validators,
semantic codes, and fixtures; the actual capture pipeline in any specific
engine adapter is out of scope (it ships when the engine port that owns
that profile lands).

Acceptance-criterion-driven shape:

1. **Capture and recording artifacts are referenced through portable
   artifact refs.** Every artifact mention in a capture/recording check
   flows through `ObservationArtifactRef::validate` →
   `validate_runtime_artifact_uri`. The check types do **not** carry raw
   path strings on any field, and the validator rejects host paths,
   `file:`/`data:`/`blob:` schemes, traversal, absolute paths, and any
   URI outside `RUNTIME_ARTIFACT_URI_ROOT`.
2. **Missing capture support is reported as unsupported, not a parity
   failure.** When an adapter's manifest does NOT declare `FrameCapture`
   or `RecordingCapture`, the runner emits `ResultOutcome::Unsupported {
semantic_code: "utsushi.conformance.frame_capture_unsupported", … }`
   (or the recording analogue) with `declared_in_manifest = false`. The
   validator rejects any attempt to dress a missing-support case up as
   `Fail` with a rendering-parity excuse.
3. **Evidence tiers remain visible.** Pass results always serialize their
   `evidenceTier`. The check structs surface the tier at every layer
   (per-artifact tier, declared profile ceiling, sink ceiling) so a
   reviewer reading the conformance result can see all three numbers
   without joining tables.

### Hard architectural constraints

- Artifact refs use `ObservationArtifactRef` /
  `validate_runtime_artifact_uri` — **no raw paths anywhere on the check
  surface**.
- Missing capture support = `Unsupported` outcome with a semantic code;
  **never** `Fail` with a parity excuse.
- Evidence tier is always present in serialized output (E0..E4).
- Engine-neutral throughout — no engine-specific fields (no XP3, no KAG,
  no RGSS3, no Tyrano).
- Frame artifacts cap at **E4** (the `SinkKind::FrameArtifact` ceiling,
  reserved for ReferenceFidelity); the **floor** for an accepted frame
  is **E2**. The `FrameCapture` profile ceiling is E2 in UTSUSHI-026;
  this slice keeps that ceiling and reserves E3/E4 for a follow-up
  profile addition (no UTSUSHI-029-side schema change required).
- Recording = audio-event metadata + sequential frame metadata. **No raw
  bytes** in the result, ever. The result references frame and recording
  bytes by `ObservationArtifactRef` and audio events by metadata only.
- Stable semantic codes live in
  `conformance::capture_recording::codes::ALL` and roll up into the
  existing `conformance::diagnostics::codes::ALL` registry asserted by
  the UTSUSHI-026 parity test.

## 2. Module placement

**`utsushi-core::conformance::capture_recording`** — sibling to the
trace/branch module UTSUSHI-027 will introduce (`conformance::trace_branch`)
and to the snapshot module UTSUSHI-028 will introduce
(`conformance::snapshot_restore`).

Justification (mirrors the UTSUSHI-026 placement reasoning):

- `utsushi-core` already owns every type this module needs:
  `EvidenceTier`, `RuntimeArtifactKind`, `ObservationArtifactRef`,
  `validate_runtime_artifact_uri`, `RUNTIME_ARTIFACT_URI_ROOT`,
  `SinkKind`, `FrameArtifact`, `AudioEvent`, `ConformanceResult`,
  `ResultOutcome`, `EvidenceRef`, `ProfileId`, the
  `conformance::diagnostics::codes` registry.
- Every downstream consumer (UTSUSHI-030 ingestion, plus engine port
  crates that produce capture/recording results) already depends on
  `utsushi-core`. A separate crate buys zero isolation.
- The slice is small (two check structs, two metadata payloads, a code
  module, fixtures, validators).

**Submodule layout** under `crates/utsushi-core/src/conformance/`:

```
crates/utsushi-core/src/conformance/
  mod.rs                  # existing; re-exports new symbols and the
                          #   new check struct ProfileId mapping helper
  manifest.rs             # unchanged
  result.rs               # SMALL additive change: new EvidenceRef
                          #   variants do NOT belong here. This slice
                          #   reuses the existing variants. See §3.5.
  diagnostics.rs          # additive: new ConformanceError variants for
                          #   capture/recording-specific validation
  fixtures.rs             # additive: capture + recording synthetic
                          #   fixtures referenced by §8
  capture_recording/      # NEW module
    mod.rs                # re-exports + module docs
    frame_check.rs        # FrameCaptureConformanceCheck struct,
                          #   validator, run() helper → ResultOutcome
    recording_check.rs    # RecordingConformanceCheck struct,
                          #   RecordingMetadata, validator, run()
    codes.rs              # capture_recording-namespaced stable codes
                          #   wired into conformance::diagnostics::codes::ALL
```

`utsushi-core/src/lib.rs` re-exports the public surface (additive):

```rust
pub use conformance::capture_recording::{
    FrameCaptureConformanceCheck,
    RecordingConformanceCheck,
    RecordingMetadata,
    FrameArtifactRef as CaptureFrameArtifactRef, // see §3.1 naming note
};
```

**Coordination with UTSUSHI-027 (parallel sibling)**: both UTSUSHI-027
and UTSUSHI-029 add new conformance check types. To stay strictly
additive on the shared `ResultOutcome` / `EvidenceRef` enums, the
coordination rule is:

- **Neither slice adds a `ResultOutcome` variant.** Both encode their
  results through the existing four-variant `ResultOutcome` (Pass / Fail
  / Skip / Unsupported). Per-check shape lives on the check struct
  itself, not on the result envelope.
- **Neither slice adds an `EvidenceRef` variant in this slice.**
  UTSUSHI-029 reuses `EvidenceRef::RuntimeArtifact` for capture and
  recording byte references, `EvidenceRef::FrameArtifactRef` for
  sink-level frame ids, and `EvidenceRef::BridgeUnit` for the bridge-unit
  linkage. UTSUSHI-027 reuses `EvidenceRef::TextLine`,
  `EvidenceRef::ReplayLogRef`, `EvidenceRef::BridgeUnit`. Should a
  future need force a new evidence ref shape (e.g. an audio-event-id
  pointer), both slices coordinate on a single PR that adds the variant
  with a schema bump — out of scope for this slice.
- **Both slices add new `ConformanceError` variants** in
  `conformance/diagnostics.rs`. Variants are additive enum entries; the
  parity test in UTSUSHI-026 already asserts every variant's
  `semantic_code()` is in `codes::ALL`, so the cross-check stays valid as
  long as both slices register their new codes in
  `conformance::diagnostics::codes::ALL`. The two slices touch the
  `ConformanceError` enum and `codes::ALL` slice; merge conflicts there
  are mechanical and resolvable by alphabetical ordering of variant
  names.

No new workspace member; no new third-party dependency.

## 3. Check shapes

### 3.1 `FrameCaptureConformanceCheck`

```rust
/// Capture-side conformance check. Construction does NOT validate; call
/// `run()` to produce a `ResultOutcome` and the runner's outer
/// `ConformanceResult` envelope. Splitting construction from running
/// matches the UTSUSHI-022 sink pattern (sinks have a `capability()`
/// surface separate from `emit_frame`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameCaptureConformanceCheck {
    /// Always `ProfileId::FrameCapture` (validated by `validate`). The
    /// field is explicit (not a `const`) so the JSON wire format is
    /// reviewer-readable.
    pub profile: ProfileId,

    /// Frame artifact references the adapter announced through
    /// `FrameArtifactSink::emit_frame`. Each ref MUST resolve through
    /// `ObservationArtifactRef::validate` (so each `uri` lives under
    /// `RUNTIME_ARTIFACT_URI_ROOT` and carries a managed artifact id).
    /// Sequencing is by `frame_index` ascending (validated).
    pub observed_artifacts: Vec<FrameArtifactRef>,

    /// Manifest-declared evidence tier floor for accepted captures. MUST
    /// be `>= EvidenceTier::E2` (the `SinkKind::FrameArtifact` floor)
    /// and `<= ProfileId::FrameCapture.evidence_tier_ceiling()` (E2 in
    /// the alpha track). Reviewers see the floor inline in the JSON.
    pub expected_tier_floor: EvidenceTier,

    /// Inclusive count window. A passing check has
    /// `observed_artifacts.len()` inside this range. Both fields are
    /// required and non-zero so reviewers can not silently accept a
    /// zero-floor "pass" (audit-focus: unsupported reported as pass).
    pub expected_count_range: ArtifactCountRange,
}

/// Per-artifact view used by the capture check. Carries the portable
/// reference plus the per-frame evidence tier so the validator can
/// enforce the tier floor without joining to the sink-level
/// `FrameArtifact`. Identical to a `FrameArtifact` minus the optional
/// pixel dimensions (which would be informational only and aren't
/// audit-load-bearing).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameArtifactRef {
    /// Stable per-run frame identifier. Carried through to
    /// `EvidenceRef::FrameArtifactRef { frame_id }` when the runner
    /// materialises the result envelope.
    pub frame_id: String,
    /// Per-frame evidence tier. Always `>= E2`. The sink already
    /// rejected lower-tier frames at emission time; this duplicate check
    /// catches manifest-time fixtures that bypass the sink path.
    pub evidence_tier: EvidenceTier,
    /// Portable artifact reference. The `uri` MUST live under
    /// `RUNTIME_ARTIFACT_URI_ROOT`; `validate` calls the existing helper.
    pub artifact_ref: ObservationArtifactRef,
    /// Monotonic frame number from the runtime clock (UTSUSHI-021 owns
    /// the clock). Used for sequencing.
    pub frame_index: u64,
    /// Optional bridge-unit linkage (the unit this capture was taken
    /// for). Surfaces in the result envelope through
    /// `EvidenceRef::BridgeUnit`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_unit_id: Option<String>,
}

/// Inclusive count window. Both ends required; defaults are forbidden
/// (audit-focus: skipped checks hidden as passes).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCountRange {
    pub min: u32,
    pub max: u32,
}
```

**Naming note**: `FrameArtifactRef` is the in-module name; the
re-export at the crate root uses `CaptureFrameArtifactRef` to avoid
collision with the existing `EvidenceRef::FrameArtifactRef { frame_id }`
variant (which is just a string id reference, not a full artifact-ref
payload). This keeps the wire format names short and unambiguous on each
side.

### 3.2 `RecordingConformanceCheck`

```rust
/// Recording-side conformance check. The recording is a logical unit
/// composed of:
/// - 1 recording-level artifact reference (the recording manifest or
///   container), and
/// - a `RecordingMetadata` payload describing frame count, audio event
///   count, duration, and the sequential frame artifact refs.
///
/// The struct intentionally separates the "recording exists at this
/// portable ref" claim from the "and here is what it contains"
/// summary so a reviewer sees both, and so the validator catches the
/// case where the recording ref points outside the managed root
/// independently of any internal metadata.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingConformanceCheck {
    /// Always `ProfileId::RecordingCapture` (validated).
    pub profile: ProfileId,

    /// Observed recording. Metadata only — no bytes.
    pub observed_recording: RecordingMetadata,

    /// Inclusive duration window in milliseconds. The recording's
    /// `duration_ms` MUST fall in `[min, max]`. The runner chooses the
    /// window (deterministic per fixture); the check just enforces.
    pub expected_duration_range: DurationRangeMs,

    /// Inclusive event count window. The recording's
    /// `frame_count + audio_event_count` MUST fall in `[min, max]`.
    pub expected_event_count_range: ArtifactCountRange,
}

/// Recording metadata. The shape is deliberately narrow: there is no
/// surface that could look like playback evidence. No sample rate, no
/// mix levels, no codec, no channels. The intention matches the
/// `AudioEvent` posture from UTSUSHI-022.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingMetadata {
    /// Stable per-run recording identifier.
    pub recording_id: String,
    /// Number of sequential frames captured into the recording. Must
    /// equal `artifact_refs.iter().filter(|r| r.artifact_kind ==
    /// "frame_capture").count()` (validated).
    pub frame_count: u32,
    /// Number of `AudioEventSink` events captured during the recording.
    /// Metadata only; the events themselves are not carried in the
    /// result (they live in the runtime evidence report under the
    /// existing UTSUSHI-022 shape).
    pub audio_event_count: u32,
    /// Recording duration in milliseconds. Monotonic from the runtime
    /// clock; deterministic per fixture.
    pub duration_ms: u64,
    /// Overall evidence tier the adapter claims for this recording.
    /// MUST satisfy:
    ///   `evidence_tier <= ProfileId::RecordingCapture.evidence_tier_ceiling()`
    /// AND
    ///   `evidence_tier <= SinkKind::FrameArtifact.evidence_tier_ceiling()`
    /// AND, when the recording carries any audio metadata,
    ///   `audio_event_count > 0` implies the recording's audio tier ceiling
    ///   is bounded by `SinkKind::AudioEvent.evidence_tier_ceiling()` (E0)
    /// — but the recording-level tier is *frame*-tier; the audio
    /// constraint is encoded as a separate validator rule (§4.3) rather
    /// than a new tier field, keeping the wire shape narrow.
    pub evidence_tier: EvidenceTier,
    /// Portable artifact references composing the recording. MUST
    /// include exactly one `artifact_kind = "recording"` ref (the
    /// container/manifest) plus zero or more
    /// `artifact_kind = "frame_capture"` refs. Other artifact kinds are
    /// rejected. The frame-capture refs MUST be ordered by an implicit
    /// frame index that matches the corresponding `FrameArtifact`
    /// emissions; sequencing is validated through the frame-capture
    /// allow list `FRAME_ARTIFACT_KIND_ALLOW_LIST` already enforced by
    /// `FrameArtifactSink`.
    pub artifact_refs: Vec<ObservationArtifactRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurationRangeMs {
    pub min: u64,
    pub max: u64,
}
```

### 3.3 Why two separate structs

The brief lists "screenshot metadata validators" and "recording metadata
validators" as distinct deliverables. The capture check covers single
frames (screenshots and standalone frame captures); the recording check
covers the composite stream. Keeping them as two structs lets the
acceptance criteria stay sharp:

- A check that fails on the frame side is a _frame_ failure, with a
  frame-specific semantic code.
- A check that fails on the recording side is a _recording_ failure,
  with a recording-specific code.

Combining them into one struct would either (a) force the runner to
fabricate a placeholder recording for screenshot-only adapters or (b)
make the fail diagnostics less precise.

### 3.4 `run()` helpers

Each check struct has a `run(&self) -> ResultOutcome` method that:

1. Calls the check's `validate()`.
2. On `Ok`, returns
   `ResultOutcome::Pass { evidence_tier: <profile ceiling, or the
recording's claimed tier, whichever is lower> }`.
3. On `Err`, returns `ResultOutcome::Fail { semantic_code, detail }`
   where `semantic_code` is one of this slice's `utsushi.conformance.*`
   codes and `detail` is a short, public-string description (no host
   paths, no engine-specific terminology).

The runner is responsible for wrapping the `ResultOutcome` into a
`ConformanceResult` envelope (adapter id, profile id, evidence vec,
recorded_at). The `run()` helper does NOT build the envelope because the
envelope's `evidence` vec is composed of `EvidenceRef`s synthesized from
the check's observed data — that synthesis is the runner's job so the
runner can also pull in cross-check evidence (e.g. impl-map fixture ids
from UTSUSHI-025) that the check struct does not know about.

### 3.5 Why no new `EvidenceRef` variant

Existing `EvidenceRef` variants already cover everything this slice
needs:

| Capture/recording datum | Existing `EvidenceRef` variant                                |
| ----------------------- | ------------------------------------------------------------- |
| Frame bytes URI         | `RuntimeArtifact { kind: FrameCapture, uri, artifact_id }`    |
| Screenshot bytes URI    | `RuntimeArtifact { kind: Screenshot, uri, artifact_id }`      |
| Recording bytes URI     | `RuntimeArtifact { kind: Recording, uri, artifact_id }`       |
| Sink-level frame id     | `FrameArtifactRef { frame_id }`                               |
| Bridge-unit linkage     | `BridgeUnit { bridge_unit_id }`                               |
| Impl-map fixture id     | `ImplMapFixture { fixture_id }` (UTSUSHI-025 cross-reference) |

Audio events have no evidence ref of their own in UTSUSHI-026; the
recording check captures the audio side through `audio_event_count`
metadata only. This matches the audit-focus constraint that the audio
surface MUST NOT look like playback evidence — there is no per-event
URI, just a count.

## 4. Validation rules

`FrameCaptureConformanceCheck::validate(&self) -> Result<(),
ConformanceError>`:

### 4.1 Frame capture rules

1. `self.profile == ProfileId::FrameCapture`. Failure:
   `ConformanceError::CaptureCheckProfileMismatch { observed, expected }`,
   code `utsushi.conformance.capture_check_profile_mismatch`.
2. `self.expected_count_range.min <= self.expected_count_range.max`.
   Failure: `ArtifactCountRangeMalformed { min, max }`, code
   `utsushi.conformance.artifact_count_range_malformed`.
3. `self.expected_tier_floor >= EvidenceTier::E2`. Failure:
   `FrameTierFloorBelowSinkFloor { floor }`, code
   `utsushi.conformance.frame_tier_floor_below_sink_floor`.
4. `self.expected_tier_floor <= ProfileId::FrameCapture
.evidence_tier_ceiling()` (E2 today). Failure:
   `FrameTierFloorAboveProfileCeiling { floor, ceiling }`, code
   `utsushi.conformance.frame_tier_floor_above_profile_ceiling`.
5. `self.observed_artifacts.len()` falls in
   `self.expected_count_range`. Zero observed → if the range allows
   zero, Pass is permitted only when accompanied by a manifest
   declaration that the adapter actually emitted zero (i.e. the runner
   tested a fixture with no frames). The validator rejects `min == 0`
   for accepted captures with code
   `utsushi.conformance.frame_capture_no_artifacts`, so the count
   window's lower bound is intentionally non-zero by construction.
   Failure: `FrameArtifactCountOutOfRange { observed, min, max }`, code
   `utsushi.conformance.frame_artifact_count_out_of_range`.
6. For each `FrameArtifactRef`:
   - `evidence_tier >= self.expected_tier_floor`. Failure:
     `FrameEvidenceTierBelowFloor { frame_id, observed, floor }`, code
     `utsushi.conformance.frame_evidence_tier_below_floor`.
   - `evidence_tier <= SinkKind::FrameArtifact.evidence_tier_ceiling()`
     (E4). Failure: `FrameEvidenceTierAboveSinkCeiling { frame_id,
observed, ceiling }`, code
     `utsushi.conformance.frame_evidence_tier_above_sink_ceiling`. This
     is the recording_evidence_tier_overclaim hard constraint, on the
     frame side.
   - `artifact_ref.validate()` succeeds. The helper calls
     `validate_runtime_artifact_uri` which already rejects host paths,
     `file:` URIs, traversal, and out-of-root paths. Failure:
     `FrameArtifactHostPath { frame_id, reason }`, code
     `utsushi.conformance.frame_artifact_host_path`. This is the
     `frame_artifact_host_path` hard-constraint code.
   - `artifact_ref.artifact_kind` is one of
     `["screenshot", "frame_capture"]` (recording is only valid inside
     the recording check; the frame check rejects it). Failure:
     `FrameArtifactKindOutsideAllowList { frame_id, kind }`, code
     `utsushi.conformance.frame_artifact_kind_outside_allow_list`.
7. `observed_artifacts` is sorted ascending on `frame_index`, and
   `frame_index` values are unique. Failure:
   `FrameSequenceUnordered { previous, current }` /
   `FrameSequenceDuplicate { frame_index }`, codes
   `utsushi.conformance.frame_sequence_unordered` and
   `utsushi.conformance.frame_sequence_duplicate`.

### 4.2 Recording rules

1. `self.profile == ProfileId::RecordingCapture`. Failure:
   `CaptureCheckProfileMismatch` (reused).
2. `self.expected_duration_range.min <= self.expected_duration_range.max`.
   Failure: `DurationRangeMalformed { min, max }`, code
   `utsushi.conformance.duration_range_malformed`.
3. `self.expected_event_count_range.min <= self.expected_event_count_range.max`.
   Failure: `ArtifactCountRangeMalformed` (reused).
4. `RecordingMetadata::recording_id` is non-empty, no whitespace, no
   newlines, does not match `looks_like_local_path` (reused from
   UTSUSHI-026). Failure: `RecordingIdMalformed { reason }`, code
   `utsushi.conformance.recording_id_malformed`.
5. `RecordingMetadata::evidence_tier <= ProfileId::RecordingCapture
.evidence_tier_ceiling()` (E2 today). Failure:
   `RecordingEvidenceTierOverclaim { observed, ceiling }`, code
   `utsushi.conformance.recording_evidence_tier_overclaim`. This is the
   `recording_evidence_tier_overclaim` hard-constraint code.
6. `RecordingMetadata::artifact_refs` contains exactly one
   `artifact_kind = "recording"` ref. Failure: `RecordingContainerMissing`
   / `RecordingContainerDuplicated`, codes
   `utsushi.conformance.recording_container_missing` /
   `utsushi.conformance.recording_container_duplicated`.
7. Every other `artifact_refs` entry has `artifact_kind = "frame_capture"`.
   Failure: `RecordingArtifactKindOutsideAllowList { kind }`, code
   `utsushi.conformance.recording_artifact_kind_outside_allow_list`.
8. Every `artifact_refs` entry passes
   `ObservationArtifactRef::validate()`. Failure:
   `RecordingArtifactHostPath { reason }`, code
   `utsushi.conformance.recording_artifact_host_path`.
9. `frame_count` equals the number of `frame_capture` artifact refs.
   Failure: `RecordingFrameCountMismatch { declared, actual }`, code
   `utsushi.conformance.recording_frame_count_mismatch`.
10. `duration_ms` is in `expected_duration_range`. Failure:
    `RecordingDurationOutOfRange { observed, min, max }`, code
    `utsushi.conformance.recording_duration_out_of_range`.
11. `frame_count + audio_event_count` is in
    `expected_event_count_range`. Failure:
    `RecordingEventCountOutOfRange { observed, min, max }`, code
    `utsushi.conformance.recording_event_count_out_of_range`.

### 4.3 Audio-side discipline

The recording carries an `audio_event_count` integer but no per-event
URIs. This matches the UTSUSHI-022 `AudioEvent` posture (E0 ceiling,
metadata only). The validator does **not** introduce an audio-tier
field on `RecordingMetadata`; instead, it enforces that the recording's
declared `evidence_tier` is the _frame_-tier and a separate
`audio_event_count == 0 || sink_kind_audio_event_ceiling <= E0` guard
holds. Since `SinkKind::AudioEvent.evidence_tier_ceiling()` is **always**
`E0` (pinned by the UTSUSHI-022 audit test), the guard is structurally
trivial here — it shows up only as a documented invariant. If a future
slice raises the audio ceiling, this is where the cross-tier rule would
land.

### 4.4 Unsupported handling

The runner translates manifest state into result-outcome shape before
calling the check at all:

1. **Adapter manifest declares `FrameCapture` but adapter does not
   produce artifacts**: the runner constructs a check with
   `observed_artifacts.is_empty()`. Validation fails with
   `FrameCaptureNoArtifacts { declared_count_range }`, code
   `utsushi.conformance.frame_capture_no_artifacts`. The runner wraps
   this in `ResultOutcome::Fail { semantic_code: ..., detail: ... }`.
2. **Adapter manifest does NOT declare `FrameCapture`**: the runner
   does NOT call the check at all. Instead, it emits
   `ResultOutcome::Unsupported { semantic_code:
"utsushi.conformance.frame_capture_unsupported",
declared_in_manifest: false }`. The recording-side analogue uses
   `utsushi.conformance.recording_capture_unsupported`.
3. **Adapter manifest declares `FrameCapture` as `Unsupported`
   capability through the sink layer** (i.e. `FrameArtifactSink::capability()
== Unsupported`): the UTSUSHI-026 manifest validator already rejects
   this combination at registration time
   (`MissingSubsystem`). UTSUSHI-029 does not need to re-check it.

The audit-focus item "unsupported reported as fail with parity excuse"
is structurally blocked: the runner cannot route a `Fail` outcome from
"capture not supported" because the runner has no check struct to call
in case 2, and case 1 produces a check-internal `FrameCaptureNoArtifacts`
code that is _explicitly not_ a parity code (it names the missing
artifacts).

## 5. Semantic codes

All stable codes for this slice live in
`utsushi-core::conformance::capture_recording::codes`. They mirror the
UTSUSHI-026 / UTSUSHI-022 `codes::ALL` pattern.

```rust
pub mod codes {
    pub const FRAME_CAPTURE_UNSUPPORTED: &str =
        "utsushi.conformance.frame_capture_unsupported";
    pub const RECORDING_CAPTURE_UNSUPPORTED: &str =
        "utsushi.conformance.recording_capture_unsupported";
    pub const FRAME_CAPTURE_NO_ARTIFACTS: &str =
        "utsushi.conformance.frame_capture_no_artifacts";
    pub const FRAME_ARTIFACT_HOST_PATH: &str =
        "utsushi.conformance.frame_artifact_host_path";
    pub const RECORDING_ARTIFACT_HOST_PATH: &str =
        "utsushi.conformance.recording_artifact_host_path";
    pub const RECORDING_EVIDENCE_TIER_OVERCLAIM: &str =
        "utsushi.conformance.recording_evidence_tier_overclaim";
    pub const FRAME_EVIDENCE_TIER_BELOW_FLOOR: &str =
        "utsushi.conformance.frame_evidence_tier_below_floor";
    pub const FRAME_EVIDENCE_TIER_ABOVE_SINK_CEILING: &str =
        "utsushi.conformance.frame_evidence_tier_above_sink_ceiling";
    pub const CAPTURE_CHECK_PROFILE_MISMATCH: &str =
        "utsushi.conformance.capture_check_profile_mismatch";
    pub const ARTIFACT_COUNT_RANGE_MALFORMED: &str =
        "utsushi.conformance.artifact_count_range_malformed";
    pub const DURATION_RANGE_MALFORMED: &str =
        "utsushi.conformance.duration_range_malformed";
    pub const FRAME_TIER_FLOOR_BELOW_SINK_FLOOR: &str =
        "utsushi.conformance.frame_tier_floor_below_sink_floor";
    pub const FRAME_TIER_FLOOR_ABOVE_PROFILE_CEILING: &str =
        "utsushi.conformance.frame_tier_floor_above_profile_ceiling";
    pub const FRAME_ARTIFACT_COUNT_OUT_OF_RANGE: &str =
        "utsushi.conformance.frame_artifact_count_out_of_range";
    pub const FRAME_ARTIFACT_KIND_OUTSIDE_ALLOW_LIST: &str =
        "utsushi.conformance.frame_artifact_kind_outside_allow_list";
    pub const FRAME_SEQUENCE_UNORDERED: &str =
        "utsushi.conformance.frame_sequence_unordered";
    pub const FRAME_SEQUENCE_DUPLICATE: &str =
        "utsushi.conformance.frame_sequence_duplicate";
    pub const RECORDING_ID_MALFORMED: &str =
        "utsushi.conformance.recording_id_malformed";
    pub const RECORDING_CONTAINER_MISSING: &str =
        "utsushi.conformance.recording_container_missing";
    pub const RECORDING_CONTAINER_DUPLICATED: &str =
        "utsushi.conformance.recording_container_duplicated";
    pub const RECORDING_ARTIFACT_KIND_OUTSIDE_ALLOW_LIST: &str =
        "utsushi.conformance.recording_artifact_kind_outside_allow_list";
    pub const RECORDING_FRAME_COUNT_MISMATCH: &str =
        "utsushi.conformance.recording_frame_count_mismatch";
    pub const RECORDING_DURATION_OUT_OF_RANGE: &str =
        "utsushi.conformance.recording_duration_out_of_range";
    pub const RECORDING_EVENT_COUNT_OUT_OF_RANGE: &str =
        "utsushi.conformance.recording_event_count_out_of_range";

    pub const ALL: &[&str] = &[
        FRAME_CAPTURE_UNSUPPORTED,
        RECORDING_CAPTURE_UNSUPPORTED,
        FRAME_CAPTURE_NO_ARTIFACTS,
        FRAME_ARTIFACT_HOST_PATH,
        RECORDING_ARTIFACT_HOST_PATH,
        RECORDING_EVIDENCE_TIER_OVERCLAIM,
        FRAME_EVIDENCE_TIER_BELOW_FLOOR,
        FRAME_EVIDENCE_TIER_ABOVE_SINK_CEILING,
        CAPTURE_CHECK_PROFILE_MISMATCH,
        ARTIFACT_COUNT_RANGE_MALFORMED,
        DURATION_RANGE_MALFORMED,
        FRAME_TIER_FLOOR_BELOW_SINK_FLOOR,
        FRAME_TIER_FLOOR_ABOVE_PROFILE_CEILING,
        FRAME_ARTIFACT_COUNT_OUT_OF_RANGE,
        FRAME_ARTIFACT_KIND_OUTSIDE_ALLOW_LIST,
        FRAME_SEQUENCE_UNORDERED,
        FRAME_SEQUENCE_DUPLICATE,
        RECORDING_ID_MALFORMED,
        RECORDING_CONTAINER_MISSING,
        RECORDING_CONTAINER_DUPLICATED,
        RECORDING_ARTIFACT_KIND_OUTSIDE_ALLOW_LIST,
        RECORDING_FRAME_COUNT_MISMATCH,
        RECORDING_DURATION_OUT_OF_RANGE,
        RECORDING_EVENT_COUNT_OUT_OF_RANGE,
    ];
}
```

The hard-constraint summary lists 8-10 stable codes. This slice ships
**24** codes total. Reasoning: the brief enumerates 3 explicit codes
(`frame_capture_unsupported`, `frame_artifact_host_path`,
`recording_evidence_tier_overclaim`) plus "etc."; the additional codes
fall out of one-failure-mode-per-code discipline that UTSUSHI-022 and
UTSUSHI-026 already follow. Code count grows linearly with validator
rules, and validator rules grow linearly with the audit surface. The
parity test in §7 asserts every variant maps into `ALL`.

Each of these codes is registered in
`conformance::diagnostics::codes::ALL` through an additive
`pub const CAPTURE_RECORDING_CODES: &[&str] = codes::ALL;` re-export
and an aggregate concat in `conformance::diagnostics::codes::ALL` so the
single global registry stays single-sourced.

## 6. Fixtures

All fixtures live in
`utsushi-core::conformance::fixtures` (additive) and are exposed
unconditionally for in-crate use, matching the UTSUSHI-026 fixtures
posture.

### 6.1 Positive frame capture → Pass

`synthetic_frame_capture_check_three_artifacts_at_e2()`:

- Three `FrameArtifactRef` entries with `frame_index = 0, 1, 2`,
  `evidence_tier = E2`, `artifact_kind = "frame_capture"`.
- URIs constructed through
  `runtime_artifact_uri("synthetic-run",
RuntimeArtifactKind::FrameCapture, "frame-0xx")`.
- `expected_tier_floor = E2`, `expected_count_range = { min: 1, max: 8 }`.
- `validate()` returns `Ok(())`.
- `run()` returns `ResultOutcome::Pass { evidence_tier: E2 }`.

### 6.2 Positive recording → Pass

`synthetic_recording_check_metadata_only()`:

- `RecordingMetadata` with one recording-container ref + three
  frame-capture refs; `frame_count = 3`, `audio_event_count = 4`,
  `duration_ms = 1_500`, `evidence_tier = E2`.
- `expected_duration_range = { min: 1_000, max: 2_000 }`,
  `expected_event_count_range = { min: 5, max: 10 }` (3 + 4 = 7).
- `validate()` returns `Ok(())`.
- `run()` returns `ResultOutcome::Pass { evidence_tier: E2 }`.

### 6.3 Missing artifact ref → Unsupported

`synthetic_frame_capture_unsupported_result()`:

- Returns a `ConformanceResult` envelope (not a check struct, because
  the unsupported path bypasses the check) with
  `ResultOutcome::Unsupported { semantic_code:
"utsushi.conformance.frame_capture_unsupported",
declared_in_manifest: false }`.
- The companion manifest does NOT declare `FrameCapture`; the
  cross-validation against the manifest succeeds.

### 6.4 Host path in artifact ref → reject_unredacted_local_paths fails

`synthetic_frame_capture_check_with_host_path()`:

- Same shape as 6.1 but one artifact ref's `uri` is
  `"/home/leak/frame.png"`.
- `validate()` returns
  `Err(ConformanceError::FrameArtifactHostPath { … })` with semantic
  code `utsushi.conformance.frame_artifact_host_path`.
- A second assertion confirms the same payload fails the project-wide
  `reject_unredacted_local_paths` filter when serialized to JSON, so a
  reviewer can see both layers of defense fire.

### 6.5 Evidence tier overclaim → Fail with overclaim diagnostic

`synthetic_recording_check_with_e4_overclaim()`:

- `RecordingMetadata::evidence_tier = E4`.
- `validate()` returns
  `Err(ConformanceError::RecordingEvidenceTierOverclaim { … })` with
  semantic code `utsushi.conformance.recording_evidence_tier_overclaim`.
- `run()` returns `ResultOutcome::Fail { semantic_code:
"utsushi.conformance.recording_evidence_tier_overclaim", detail: ... }`.

### 6.6 Cross-validation fixture

`synthetic_capture_recording_paired_manifest_and_results()`:

- Manifest declares both `FrameCapture` and `RecordingCapture` at E2.
- Results array: one frame-capture Pass result + one recording-capture
  Pass result.
- `cross_validate_results_against_manifest` returns `Ok(())`.
- A negative twin swaps the recording Pass tier to E3, expects the
  cross-checker to reject with `PassAboveManifestCeiling` (the
  UTSUSHI-026 code).

## 7. Test plan

Tests follow `docs/dev/testing-standard.md`: falsifiable, behavior-named,
synthetic inline fixtures only, no live providers.

### 7.1 Frame check (`capture_recording/frame_check.rs::tests`)

Round-trip and serde:

- `frame_capture_check_round_trips_through_serde_json()`.
- `frame_capture_check_serializes_with_camel_case()`.

Positive validation:

- `frame_capture_check_validates_three_frames_at_floor_tier()`.
- `frame_capture_check_validates_single_frame_at_count_min()`.

Negative validation (one per code):

- `frame_capture_check_rejects_profile_mismatch()`.
- `frame_capture_check_rejects_count_range_inverted()`.
- `frame_capture_check_rejects_tier_floor_below_e2()`.
- `frame_capture_check_rejects_tier_floor_above_profile_ceiling()`.
- `frame_capture_check_rejects_zero_observed_when_floor_above_zero()`.
- `frame_capture_check_rejects_frame_below_tier_floor()`.
- `frame_capture_check_rejects_frame_above_sink_ceiling()`.
- `frame_capture_check_rejects_artifact_ref_with_host_path()`.
- `frame_capture_check_rejects_artifact_ref_with_file_scheme()`.
- `frame_capture_check_rejects_artifact_kind_outside_allow_list()`.
- `frame_capture_check_rejects_unsorted_frame_index_sequence()`.
- `frame_capture_check_rejects_duplicate_frame_index()`.

Run-outcome:

- `frame_capture_check_run_returns_pass_with_tier_floor_on_valid_check()`.
- `frame_capture_check_run_returns_fail_with_host_path_code_when_uri_is_absolute()`.

### 7.2 Recording check (`capture_recording/recording_check.rs::tests`)

Round-trip:

- `recording_check_round_trips_through_serde_json()`.
- `recording_check_serializes_with_camel_case()`.

Positive validation:

- `recording_check_validates_one_container_plus_three_frames()`.
- `recording_check_validates_audio_event_count_only_recording()`.

Negative validation (one per code):

- `recording_check_rejects_profile_mismatch()`.
- `recording_check_rejects_duration_range_inverted()`.
- `recording_check_rejects_event_count_range_inverted()`.
- `recording_check_rejects_recording_id_with_whitespace()`.
- `recording_check_rejects_recording_id_that_looks_like_local_path()`.
- `recording_check_rejects_e4_overclaim()`.
- `recording_check_rejects_e3_overclaim_above_profile_ceiling()`.
- `recording_check_rejects_missing_container_ref()`.
- `recording_check_rejects_duplicate_container_ref()`.
- `recording_check_rejects_trace_log_artifact_kind()`.
- `recording_check_rejects_artifact_ref_with_host_path()`.
- `recording_check_rejects_frame_count_mismatch_with_artifact_refs()`.
- `recording_check_rejects_duration_below_minimum()`.
- `recording_check_rejects_duration_above_maximum()`.
- `recording_check_rejects_event_count_out_of_range()`.

Run-outcome:

- `recording_check_run_returns_pass_when_metadata_within_ranges()`.
- `recording_check_run_returns_fail_with_overclaim_code_on_e4_tier()`.

### 7.3 Codes registry (`capture_recording/codes.rs::tests`)

- `capture_recording_codes_all_registered_in_conformance_diagnostics()` —
  asserts every code in `capture_recording::codes::ALL` is also in
  `conformance::diagnostics::codes::ALL`.
- `capture_recording_codes_are_kebab_namespaced_under_utsushi_conformance()`.
- `every_conformance_error_variant_introduced_by_this_slice_emits_a_registered_code()`.

### 7.4 Fixtures (`conformance/fixtures.rs::tests`, additive)

- `synthetic_frame_capture_check_three_artifacts_at_e2_validates()`.
- `synthetic_frame_capture_check_three_artifacts_at_e2_runs_pass()`.
- `synthetic_recording_check_metadata_only_validates()`.
- `synthetic_recording_check_metadata_only_runs_pass()`.
- `synthetic_frame_capture_unsupported_result_validates_against_undeclared_manifest()`.
- `synthetic_frame_capture_check_with_host_path_fails_validation()`.
- `synthetic_frame_capture_check_with_host_path_fails_reject_unredacted_local_paths()`.
- `synthetic_recording_check_with_e4_overclaim_fails_validation()`.
- `synthetic_capture_recording_paired_manifest_and_results_cross_validates()`.
- `synthetic_capture_recording_paired_negative_rejects_tier_above_manifest_ceiling()`.

### 7.5 Integration tests

`crates/utsushi-core/tests/conformance_capture_recording.rs`:

- `capture_recording_check_run_through_synthetic_runner_emits_one_pass_per_profile()`.
- `capture_recording_unsupported_path_does_not_invoke_check_struct()`.
- `capture_recording_result_envelope_carries_evidence_tier_in_serialized_output()`
  — asserts the audit-focus "evidence tier hidden from reviewers" item
  is structurally impossible (the wire JSON contains
  `"evidenceTier": "E2"` literally).
- `capture_recording_result_envelope_passes_reject_unredacted_local_paths_filter()`.

## 8. Verification commands

```
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p utsushi-core conformance
just check
```

`pnpm exec vp run ts:test` and `pnpm exec vp run ts:typecheck` are
preserved as runtime gates by `just check`; this slice does NOT change
any TypeScript surface (UTSUSHI-030 owns the TS-side mirror of the new
codes).

## 9. Risks and unknowns

### 9.1 Recording duration determinism across adapters

`duration_ms` is monotonic from the runtime clock (UTSUSHI-021), which
is deterministic per fixture by construction. The risk: an adapter that
sources duration from a wall clock instead of the logical clock would
report a flaky value. Mitigation: the recording check enforces a
`duration_ms` window, not an exact value. A runner that sees flaky
durations across replays sees a window-violation `Fail`, not silent
drift. Engine-level enforcement (clock provenance) is UTSUSHI-021's job;
this slice surfaces the symptom.

### 9.2 Artifact ref schema stability

`ObservationArtifactRef` is owned by `utsushi-core/src/lib.rs` and shared
by the runtime evidence report shape (UTSUSHI-014 era). The risk: a
future change to the artifact ref shape (e.g. adding a required field)
would force the capture/recording checks to update. Mitigation: this
slice does not introduce any field on `ObservationArtifactRef`; it
consumes the existing shape and re-validates through the existing
helper. Any future change is a single coordinated PR across the runtime
evidence report consumers; that risk is shared, not introduced here.

### 9.3 Very large artifact counts

`expected_count_range` and the `observed_artifacts` vector are `u32` and
`Vec`, both effectively unbounded for the alpha track. The risk: a
runtime that emits ten million frames blows out memory before the check
runs. Mitigation: the slice ships a single guard rail —
`expected_count_range.max` is checked against a documented soft ceiling
of `65_535` in §10.7 (audit-focused: any check claiming more frames
than that is suspicious and should be reviewed by hand). The validator
returns `ArtifactCountRangeMalformed` if `max > 65_535`, with the same
semantic code as the inverted-range failure to keep the code registry
small. A future slice can raise the ceiling once the budget surface
hooks in (the `SinkError::BudgetExhausted` variant from UTSUSHI-022 is
the natural pairing).

### 9.4 Coordination with UTSUSHI-027 on additive enum variants

UTSUSHI-027 will also extend `conformance/diagnostics.rs` and
`conformance/diagnostics::codes::ALL`. Conflict surface: the
`ConformanceError` enum and the `codes::ALL` slice. Both are additive
and order-insensitive; merge conflicts are mechanical. The mitigation
recorded in §2 above keeps both slices off shared structural surfaces
(no shared `ResultOutcome` variant, no shared `EvidenceRef` variant).

### 9.5 Audit-focus checklist

| Audit focus                          | Structural defense                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Host-specific artifact refs          | Every URI passes `validate_runtime_artifact_uri`; fixture 6.4 pins both layers.                                                               |
| Unsupported capture reported as pass | Runner emits `Unsupported` outcome (never Pass) when manifest lacks the profile; `FrameCaptureNoArtifacts` blocks empty-Pass at validation.   |
| Evidence tier hidden from reviewers  | Tier is a required field on `FrameArtifactRef`, `RecordingMetadata`, and every Pass outcome; serde never skips it (no `skip_serializing_if`). |

## 10. Out of scope

- **UTSUSHI-027 trace and branch conformance**: shipped by the parallel
  sibling. This slice does not introduce any text-trace or branch-graph
  validator.
- **UTSUSHI-028 snapshot-restore conformance**: shipped by a later
  slice. `SnapshotPrimitives` is reserved-but-inert in UTSUSHI-026; this
  slice does not touch it.
- **Actual capture implementation in adapters**: no engine port is
  modified by this slice. The first port to publish capture or
  recording conformance results is a follow-up (sibling to the per-port
  PortManifest landings).
- **TypeScript schema mirror** for the new codes: UTSUSHI-030 owns
  ingestion-side validation. Rust-side `codes::ALL` is authoritative for
  this slice; TS mirror is additive and downstream.
- **Audio-event tier above E0**: the `AudioEvent` sink ceiling stays at
  E0 (UTSUSHI-022). Recording's `audio_event_count` is metadata only.
- **Frame-tier above E2** for the canonical `FrameCapture` profile.
  `SinkKind::FrameArtifact.evidence_tier_ceiling()` is E4 (allowing E3
  for replay-review and E4 for reference-fidelity), but the
  `ProfileId::FrameCapture` ceiling is E2 in the alpha track. Raising
  the profile ceiling is a separate, additive node.
- **Budget enforcement** (`SinkError::BudgetExhausted` wiring through
  the artifact store). The variant is reachable from a sink path today;
  the conformance check does not enforce a budget. Documented in §9.3
  as a follow-up.
- **Conformance fixture id schema** in `packages/localization-bridge-schema/`.
  Reference comparison via the existing `"conformance_fixture"` shape
  already accepts the capture/recording fixture ids by string; no new
  TS shape is required.
- **Reference-runtime evidence (`ConformanceReport` artifact kind)**.
  This slice consumes `RuntimeArtifactKind::Screenshot`,
  `::FrameCapture`, and `::Recording`. The
  `RuntimeArtifactKind::ConformanceReport` artifact is the _output_ of a
  conformance run (a higher-level artifact); produced by UTSUSHI-030
  ingestion.

## 11. Worker scoping

**One worker**, single PR onto `spec/utsushi-029`. The slice is
self-contained inside `utsushi-core/src/conformance/capture_recording/`
plus three additive touches (`conformance::fixtures`, `conformance::
diagnostics::codes::ALL`, `utsushi-core/src/lib.rs` re-exports). No
cross-crate changes, no schema-package changes, no new workspace
member. Estimated diff size: ~1,200 LOC (≈600 production + ≈600 tests +
fixtures), well inside a single-worker scope per the UTSUSHI-022 /
UTSUSHI-026 precedent.

## 12. Coordination summary

- **UTSUSHI-026 (landed)** owns the `ConformanceManifest` /
  `ConformanceResult` substrate. UTSUSHI-029 does not modify the
  manifest or the result envelope structurally; it adds check structs
  that produce `ResultOutcome` values the existing envelope already
  carries.
- **UTSUSHI-022 (landed)** owns the sinks. UTSUSHI-029 reuses
  `SinkKind::FrameArtifact.evidence_tier_ceiling()` as a structural
  invariant in the validator. Sink emissions remain the upstream
  capture path; this slice validates the post-emission report.
- **UTSUSHI-027 (in parallel)** also extends conformance. Mechanical
  merge conflict surface: `ConformanceError` enum and
  `conformance::diagnostics::codes::ALL`. Both resolve by additive
  union; see §9.4.
- **UTSUSHI-023 (in parallel)** is the snapshot primitives substrate;
  no surface overlap with this slice.
- **KAIFUU-010 (in parallel)** is upstream of Kaifuu schema work; the
  semantic-code shape `^(utsushi|kaifuu)\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`
  already permits `kaifuu.*` codes inside `ResultOutcome::Fail`. No
  changes required for this slice.
- **UTSUSHI-030 (downstream)** consumes the capture/recording check
  outputs via the existing `ConformanceResult` JSON shape. No new wire
  fields. The TS-side mirror of `codes::ALL` is UTSUSHI-030's
  responsibility.
