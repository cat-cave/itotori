# UTSUSHI-064 — Controlled playback recording metadata smoke

- **Node**: UTSUSHI-064
- **Title**: Controlled playback recording metadata smoke
- **Branch**: `spec/utsushi-064`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-064`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review (single implementation slice)
- **Dependencies landed**: UTSUSHI-012 (controlled playback contract), UTSUSHI-022
  (text/frame/audio sinks), UTSUSHI-029 (capture + recording artifact
  conformance, providing `RecordingMetadata` and `RecordingConformanceCheck`).
- **Direct downstream**: engine ports landing controlled playback that emit
  recordings consume this smoke as their determinism oracle; UTSUSHI-030
  ingestion reuses the same metadata round-trip shape on the TypeScript side.

## 1. Goal restatement

Add an **integration-level smoke test** that exercises the controlled playback
contract end-to-end through a fixture **recording** path and asserts the
resulting `RecordingMetadata` round-trips through the existing
`RecordingConformanceCheck` (UTSUSHI-029) **without ever exposing host paths,
without overclaiming the recording's evidence tier, and without silently
passing a missing recording as if it had been produced**.

The slice's value is structural: the substrate (sinks, recording metadata,
conformance check) already exists; this slice writes the smoke that pins
the recording contract so every controlled-playback engine port that
later claims to produce a recording has a concrete behavioural gate to
satisfy.

Acceptance-criterion-driven shape:

1. **Recording metadata is portable.** Every artifact ref inside
   `RecordingMetadata.artifact_refs` flows through
   `ObservationArtifactRef::validate` → `validate_runtime_artifact_uri`. No
   host path, no `file:`/`data:`/`blob:` scheme, no traversal, no path
   outside `RUNTIME_ARTIFACT_URI_ROOT` can appear in any committed JSON
   produced by the smoke.
2. **Recording metadata does not overclaim the evidence tier.** The smoke
   asserts that the `RecordingMetadata.evidence_tier` reported by the
   fixture recorder satisfies the existing UTSUSHI-029 invariants:
   `audio_event_count > 0` implies the recording's audio side stays bounded
   by `SinkKind::AudioEvent.evidence_tier_ceiling()` (E0); the frame side
   stays bounded by `SinkKind::FrameArtifact.evidence_tier_ceiling()` (E4)
   and by `ProfileId::RecordingCapture.evidence_tier_ceiling()` (E2 in the
   alpha track). A twin asserts that an E3 / E4 overclaim from the fixture
   recorder fails the conformance check with the
   `utsushi.conformance.recording_evidence_tier_overclaim` semantic code.
3. **Missing recording is reported as `Unsupported`, not Pass.** When a
   fixture run does not produce a recording (e.g. the runtime's manifest
   does not declare `ProfileId::RecordingCapture`), the smoke asserts the
   runner emits `ResultOutcome::Unsupported { semantic_code:
"utsushi.conformance.recording_capture_unsupported", declared_in_manifest:
false }`. A second twin asserts that constructing a
   `RecordingConformanceCheck` against an empty (frame-count = 0) recording
   when the manifest **does** declare `RecordingCapture` fails validation
   with `RecordingFrameCountMismatch` or
   `RecordingEventCountOutOfRange` — never `Pass` with no evidence.

### Hard architectural constraints

- Engine-neutral. The smoke names no engine; the fixture recorder is the
  only producer.
- Recording metadata is metadata only; no bytes are inlined. Frame and
  recording artifact references go through `ObservationArtifactRef`. Audio
  events appear only as a count.
- The smoke uses the existing UTSUSHI-022 sinks (`FrameArtifactSink`,
  `AudioEventSink`) routed through a deterministic in-memory recorder; no
  real I/O is performed.
- Determinism path: the metadata JSON is serialized through the existing
  deterministic JSON helper (`utsushi-core::recorder::deterministic_json_bytes`
  re-export, or the conformance module's deterministic emitter — whichever
  the substrate already exposes for `ConformanceResult`).
- The smoke asserts every `ResultOutcome` payload passes
  `reject_unredacted_local_paths` end-to-end (defends the audit-focus
  "recording metadata exposing host paths").
- No new public surface. The slice writes only an integration test plus,
  if necessary, a small in-test fixture recorder living under the test
  file itself.

## 2. Module placement

The smoke test is a single integration test file in `utsushi-core/tests/`,
sitting alongside the existing capture/recording conformance integration
test from UTSUSHI-029 (`conformance_capture_recording.rs`) and the
parallel-sibling smoke from UTSUSHI-063
(`fixture_snapshot_restore.rs`).

```
crates/utsushi-core/tests/
  recording_metadata.rs                  # NEW — the smoke test
  conformance_capture_recording.rs       # existing (UTSUSHI-029)
  fixture_snapshot_restore.rs            # parallel sibling (UTSUSHI-063)
  replay_log_jump_target.rs              # parallel sibling (UTSUSHI-062)
```

The test reuses:

- `utsushi_core::conformance::capture_recording::{RecordingConformanceCheck,
RecordingMetadata, DurationRangeMs, ArtifactCountRange}` from UTSUSHI-029.
- `utsushi_core::conformance::{ResultOutcome, EvidenceRef,
ConformanceResult, ProfileId, EvidenceTier}` from UTSUSHI-026.
- `utsushi_core::conformance::capture_recording::codes::*` for the stable
  semantic codes the smoke asserts on.
- `utsushi_core::sink::{FrameArtifactSink, AudioEventSink, SinkKind,
FrameArtifact, AudioEvent}` from UTSUSHI-022 (the smoke routes through the
  sinks to produce the frame artifact references the recording metadata
  cites).
- `utsushi_core::{ObservationArtifactRef, RuntimeArtifactKind,
runtime_artifact_uri}` for portable ref construction.
- `utsushi_core::recorder::deterministic_json_bytes` (UTSUSHI-060) for the
  byte-equality oracle.

No new module, no new workspace member, no new source file outside the
single integration test.

Coordination with UTSUSHI-062 / UTSUSHI-063 (parallel siblings):

- UTSUSHI-062 owns the jump-target + replay-log fixture set; this slice
  does NOT depend on those fixtures and constructs its own inline recording
  fixture so the three integration tests stay decoupled.
- UTSUSHI-063 owns the snapshot restore smoke; this slice does NOT touch
  snapshot surfaces.
- Both siblings share the "single integration test in `utsushi-core/tests/`
  driven by deterministic JSON byte comparison" pattern; the file naming
  matches that template.

## 3. Smoke pipeline

The smoke test performs the following operations in order. Each step is a
named sub-test (the `#[test]` functions in §7 each exercise a subset of
this pipeline).

1. **Construct an inline fixture frame stream.** A `Vec<FrameArtifact>` of
   three frames with `frame_index = 0, 1, 2`, `evidence_tier = E2`,
   `artifact_kind = "frame_capture"`, and `uri` constructed through
   `runtime_artifact_uri("smoke-recording-run",
RuntimeArtifactKind::FrameCapture, "frame-000")` etc.
2. **Construct an inline fixture audio event stream.** A `Vec<AudioEvent>`
   of four events (start, marker, marker, stop) — metadata only, capped at
   E0 by the sink's invariant.
3. **Route through the sinks.** Drive an `InMemoryFrameArtifactSink` and an
   `InMemoryAudioEventSink` with the inline streams. The sinks' job is
   structural — they would be the wiring an engine port uses; the smoke
   uses them so the metadata it later builds is grounded in the real sink
   contracts.
4. **Build `RecordingMetadata`.** Compose the metadata from the sinks'
   accumulated state:
   - `recording_id = "smoke-recording-000"` (kebab-namespaced, not a path).
   - `frame_count = 3` (from the frame sink's emitted count).
   - `audio_event_count = 4` (from the audio sink's emitted count).
   - `duration_ms = 1_500` (deterministic per-fixture value, derived from
     the inline stream's logical-clock advance — never wall-clock).
   - `evidence_tier = E2` (the `ProfileId::RecordingCapture` ceiling in
     the alpha track).
   - `artifact_refs`: one container ref +
     three frame-capture refs, all through `runtime_artifact_uri`.
5. **Build `RecordingConformanceCheck`.** With
   `profile = ProfileId::RecordingCapture`,
   `expected_duration_range = { min: 1_000, max: 2_000 }`,
   `expected_event_count_range = { min: 5, max: 10 }` (3 + 4 = 7).
6. **Validate and run.** `check.validate()` returns `Ok(())`;
   `check.run()` returns `ResultOutcome::Pass { evidence_tier: E2 }`.
7. **Byte-deterministic round-trip.** Serialize the `RecordingMetadata`
   twice through `deterministic_json_bytes` and assert byte-equality.
8. **Twin: missing recording → `Unsupported`.** Construct a runner-shaped
   path where the fixture manifest does NOT declare
   `ProfileId::RecordingCapture`; assert the runner emits
   `ResultOutcome::Unsupported { semantic_code:
"utsushi.conformance.recording_capture_unsupported",
declared_in_manifest: false }`.
9. **Twin: empty-recording-with-declaration → `Fail`.** Construct a
   `RecordingMetadata` with `frame_count = 0` and a manifest that DOES
   declare `RecordingCapture`; assert `check.validate()` returns
   `Err(ConformanceError::RecordingFrameCountMismatch { declared, actual })`
   with code `utsushi.conformance.recording_frame_count_mismatch`. This is
   the "missing recording silently passed" defense.
10. **Twin: evidence-tier overclaim → `Fail`.** Construct a
    `RecordingMetadata` with `evidence_tier = E4`; assert `check.validate()`
    returns `Err(ConformanceError::RecordingEvidenceTierOverclaim { … })`
    with code `utsushi.conformance.recording_evidence_tier_overclaim`.
11. **Twin: host path in artifact ref → `Fail`.** Construct a
    `RecordingMetadata` whose one artifact ref's `uri` is
    `"/home/leak/recording.bin"`; assert `check.validate()` returns
    `Err(ConformanceError::RecordingArtifactHostPath { … })` with code
    `utsushi.conformance.recording_artifact_host_path` and that the same
    payload fails the project-wide `reject_unredacted_local_paths` filter
    when serialized to JSON.

## 4. Determinism oracle

The smoke test serializes the recording metadata twice through
`deterministic_json_bytes` (UTSUSHI-060) and asserts byte-equality. This is
the canonical "serialize twice → same bytes" pattern shared with
UTSUSHI-022 fixtures, UTSUSHI-060 recorder tests, and the sibling
UTSUSHI-063 smoke.

The test does NOT compare against a committed JSON artifact. Rationale:
the metadata is small (~400 bytes JSON), entirely inline, and the byte
oracle is most useful as a same-process check that catches nondeterminism
sources inside the serializer (serde hashmap iteration, serializer-internal
buffering, integer-vs-float numeric formatting).

## 5. Evidence tier discipline

The smoke exercises the three tier ceilings UTSUSHI-029 pins, with one
positive assertion and two twin negatives:

- **Positive.** `evidence_tier = E2` passes validation; `run()` returns
  `Pass { evidence_tier: E2 }`. Pass evidence tier is asserted to appear
  in the serialized JSON literally (`"evidenceTier": "E2"`) — defends the
  audit-focus item "evidence tier hidden from reviewers".
- **Negative twin (frame ceiling).** `evidence_tier = E4` (the
  `SinkKind::FrameArtifact` ceiling but **above** the
  `ProfileId::RecordingCapture` profile ceiling of E2) fails with
  `RecordingEvidenceTierOverclaim`. This guards "metadata overclaiming
  fidelity tier".
- **Negative twin (audio discipline).** A `RecordingMetadata` with
  `audio_event_count > 0` and an embedded audio-side tier hint above E0
  would violate the recording's audio-side discipline. UTSUSHI-029 keeps
  the audio surface metadata-only (no audio tier field), so the structural
  defense is already in place. The smoke asserts the JSON shape: serialize
  the metadata and assert no `audioEventTier`, `audioSampleRate`, `codec`,
  `channels`, or similar field appears anywhere in the wire form (defends
  "metadata overclaiming fidelity tier" on the audio side).

## 6. Unsupported handling

The smoke exercises the runner-level routing rule UTSUSHI-029 documents
(§4.4 of UTSUSHI-029):

- **Manifest does NOT declare `RecordingCapture`.** The smoke does not
  construct a check at all. Instead, it asserts the runner emits
  `ResultOutcome::Unsupported { semantic_code:
"utsushi.conformance.recording_capture_unsupported",
declared_in_manifest: false }`. The smoke constructs this outcome
  directly (the runner is a thin orchestrator; the structural assertion is
  the outcome shape) and asserts the JSON serialization contains the
  literal `"outcome": "unsupported"` and the literal semantic code string.
- **Manifest DOES declare `RecordingCapture` but recording is empty.** The
  smoke constructs the check with `frame_count = 0` and asserts validation
  fails with `RecordingFrameCountMismatch` — never `Pass`. This is the
  structural blocker for "missing recording silently passed".

## 7. Test plan

Tests live in `crates/utsushi-core/tests/recording_metadata.rs`.
Tests follow `docs/testing-standard.md`: falsifiable, behavior-named,
synthetic inline fixtures only, no live providers, no host paths.

### 7.1 Happy path

- `recording_metadata_round_trips_through_serde_json_byte_for_byte()`.
- `recording_metadata_serializes_with_camel_case_field_names()`.
- `recording_metadata_round_trip_preserves_artifact_ref_order()`.
- `recording_conformance_check_run_returns_pass_with_e2_tier_on_in_range_metadata()`.
- `recording_conformance_check_passes_when_frame_count_audio_event_count_and_duration_are_in_range()`.
- `recording_metadata_serialized_form_contains_evidence_tier_literal_in_wire_json()`.

### 7.2 Determinism oracle

- `recording_metadata_serialize_twice_produces_byte_identical_output()`.
- `recording_metadata_serialize_resolve_serialize_produces_byte_identical_output_across_three_runs()`.
- `recording_conformance_result_envelope_serialize_twice_produces_byte_identical_output()`.

### 7.3 Evidence tier discipline (negative twins)

- `recording_conformance_check_fails_with_evidence_tier_overclaim_code_on_e4_tier()`.
- `recording_conformance_check_fails_with_evidence_tier_overclaim_code_on_e3_tier()`.
- `recording_metadata_serialized_form_does_not_contain_audio_event_tier_field()` —
  walks the wire JSON and asserts no `audioEventTier`, `audioSampleRate`,
  `codec`, `channels`, or `mixLevels` key appears at any depth (defends
  "metadata overclaiming fidelity tier" on the audio side, structurally).

### 7.4 Missing recording handling (one per code)

- `recording_runner_emits_unsupported_outcome_when_manifest_does_not_declare_recording_capture()` —
  asserts `ResultOutcome::Unsupported { semantic_code:
"utsushi.conformance.recording_capture_unsupported",
declared_in_manifest: false }`.
- `recording_conformance_check_fails_with_frame_count_mismatch_when_frame_count_is_zero_but_artifact_refs_are_nonempty()`.
- `recording_conformance_check_fails_with_event_count_out_of_range_when_audio_event_count_plus_frame_count_is_below_expected_min()`.
- `recording_conformance_check_does_not_return_pass_for_a_recording_with_zero_frame_count_and_zero_audio_events()` —
  asserts the validator rejects the trivially-empty recording when the
  manifest declared the profile. Defends "missing recording silently
  passed".

### 7.5 Host path defense (one per code)

- `recording_conformance_check_fails_with_recording_artifact_host_path_code_when_artifact_uri_is_absolute_local_path()`.
- `recording_conformance_check_fails_with_recording_artifact_host_path_code_when_artifact_uri_uses_file_scheme()`.
- `recording_conformance_check_fails_with_recording_id_malformed_when_recording_id_looks_like_local_path()`.
- `recording_metadata_serialized_form_passes_reject_unredacted_local_paths_filter()`.
- `recording_conformance_result_envelope_passes_reject_unredacted_local_paths_filter()`.

### 7.6 Cross-validation against manifest

- `recording_conformance_pass_result_cross_validates_against_manifest_declaring_recording_capture_at_e2()`.
- `recording_conformance_pass_result_fails_cross_validation_against_manifest_declaring_recording_capture_at_e1_ceiling()` —
  the cross-validator from UTSUSHI-026 rejects a Pass at E2 if the manifest
  ceiling for the profile is below E2.

### 7.7 Sink contract integration

- `recording_metadata_frame_count_equals_emitted_frame_sink_event_count()`.
- `recording_metadata_audio_event_count_equals_emitted_audio_sink_event_count()`.
- `recording_metadata_artifact_refs_count_minus_container_equals_frame_sink_event_count()`.

### 7.8 Codes registry

- `recording_metadata_smoke_only_emits_codes_registered_in_capture_recording_codes_all()` —
  the test runs every twin's `Err` arm, captures the `semantic_code()`,
  and asserts every captured code is in
  `utsushi_core::conformance::capture_recording::codes::ALL`.

## 8. Verification commands

```
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p utsushi-core recording_metadata
cargo test -p utsushi-fixture
just check
```

`pnpm exec vp run ts:test` and `pnpm exec vp run ts:typecheck` are
preserved as runtime gates by `just check`; this slice does NOT change
any TypeScript surface. The TS mirror of the new smoke is downstream of
UTSUSHI-030 ingestion.

## 9. Risks

### 9.1 Sink contract surface drift

UTSUSHI-022 owns `FrameArtifactSink` and `AudioEventSink`. Risk: a
downstream slice tightens the trait signature (e.g. adds a required
method) and the smoke's in-test sinks break. Mitigation: the smoke
consumes the public surface only; any change to the trait surfaces as a
compile error and the smoke refresh is mechanical. The smoke does NOT
implement the trait itself except in the small in-test recorder, which is
intentionally minimal.

### 9.2 Recording metadata schema drift

UTSUSHI-029 pins the `RecordingMetadata` shape. Risk: a future slice adds
a required field. Mitigation: the smoke constructs the metadata through
the public constructor (or struct literal) and any new required field
surfaces as a compile error. The committed plan for UTSUSHI-029 is
explicit that the shape stays narrow (no per-event audio surface, no
codec/sample-rate fields); reviewers can sanity-check the diff against
that posture.

### 9.3 Deterministic JSON helper location

UTSUSHI-060 ships `recorder::deterministic_json_bytes`. Risk: the
conformance module exposes its own deterministic emitter for
`ConformanceResult` that differs. Mitigation: the smoke uses
`deterministic_json_bytes` for both the `RecordingMetadata` and the
`ConformanceResult` envelope; the helper canonicalizes through
`BTreeMap`-based walks, which is byte-stable across both shapes. If the
conformance module later adds its own emitter, the smoke can be refreshed
to use it.

### 9.4 Unsupported routing structural assertion

The runner is not yet implemented (the first runner that emits
`Unsupported { recording_capture_unsupported }` lands when the first
controlled-playback engine port lands). The smoke asserts the **outcome
shape** the runner is contracted to produce, not the runner's existence.
Risk: a future runner produces a different shape. Mitigation: the smoke
constructs the expected outcome literally and asserts its serialized JSON
shape; any runner divergence will fail this test in CI when the runner's
own integration test runs.

### 9.5 Audio-side discipline regression

The "no audio tier field" assertion (test 7.3) walks the serialized JSON
form looking for known forbidden keys. Risk: a future schema bump
introduces a legitimate audio metadata field that looks superficially
like an overclaim. Mitigation: the test names the forbidden keys
explicitly; any legitimate addition is a coordinated PR that updates both
UTSUSHI-029's `RecordingMetadata` shape and this smoke's forbidden-key
list at the same time.

### 9.6 Audit-focus checklist

| Audit focus | Structural defense |
| --- | --- |
| Recording metadata exposing host paths | Tests 7.5 — `reject_unredacted_local_paths` walk on both metadata and result envelope JSON; `RecordingArtifactHostPath` twin asserts the validator quotes the host-path code. |
| Metadata overclaiming fidelity tier | Tests 7.3 — E4 / E3 overclaim twins emit `RecordingEvidenceTierOverclaim`; serialized JSON forbidden-key audit on audio side. |
| Missing recording silently passed | Tests 7.4 — `Unsupported` outcome when manifest does not declare; `RecordingFrameCountMismatch` when manifest declares but recording is empty; explicit "does not return Pass for empty recording" assertion. |

## 10. Out of scope

- **Frame capture smoke.** The frame-capture surface is covered by
  UTSUSHI-029's own integration tests; this slice focuses on the recording
  surface specifically.
- **Engine-port recording producer.** A real controlled-playback engine
  port emitting recordings is a follow-up sibling to UTSUSHI-103; this
  slice uses an inline in-test recorder only.
- **Audio event payload schema.** The audio event surface is metadata-only
  (count + sink-level fields); this slice does not extend it.
- **Recording bundle reader / writer.** No file I/O is performed; the smoke
  is entirely in-memory.
- **TypeScript recording metadata ingestion.** Itotori ingestion
  (downstream of UTSUSHI-030) consumes the JSON shape; the TS mirror is
  additive and downstream of this slice.
- **Snapshot or jump-target fixtures.** UTSUSHI-062 and UTSUSHI-063 own
  those families.
- **Live capture orchestration.** UTSUSHI-061 territory.
- **Performance budgeting.** `SinkError::BudgetExhausted` wiring through
  the artifact store is documented as a follow-up in UTSUSHI-029 §10; this
  slice does not exercise it.

## 11. Worker scoping

**One worker.** Scope is bounded:

- One new integration test file in `crates/utsushi-core/tests/`
  (~400 LOC).
- No new modules, no new fixtures committed (inline-only).
- No public-API changes.

Estimated diff size: ~400 LOC test code, well inside a single-worker
scope per the UTSUSHI-022 / UTSUSHI-029 precedent. No cross-crate API
changes; no schema-package changes; no migration. Worker uses only the
public surfaces UTSUSHI-022 / UTSUSHI-029 / UTSUSHI-060 already shipped.

---

## Plan-only confirmation

This document is plan-only. No feature code, no fixture JSON, and no
test files are committed by this PR. The implementation worker will
translate this plan into the smoke integration test in a follow-up
branch.
