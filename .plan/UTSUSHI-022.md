# UTSUSHI-022 — Headless text render and audio sink contracts

- **Node**: UTSUSHI-022
- **Title**: Headless text render and audio sink contracts
- **Branch**: `spec/utsushi-022`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-022`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review (implementation slice follows this plan)

## 1. Goal restatement

Build the engine-neutral, headless sink contracts that runtime ports emit into so
the runtime evidence layer can describe what was observed without pretending to
have rendered or played anything. The deliverables are:

- `TextSurfaceSink` — text-only adapters (synthetic JSON, RealLive Scene
  strings, RPG Maker MV/MZ JS DOM) emit text lines as E1 evidence.
- `FrameArtifactSink` — adapters that can produce frame bytes attach an
  `ArtifactRef` (routed through `RuntimeArtifactRoot`, never a raw path) and
  claim E2.
- `AudioEventSink` — adapters describe audio events (start, stop, label, cue,
  marker) as **metadata only**, capped at E0 evidence — no bytes leak out, no
  playback-fidelity claim is implied.
- `Evidence-tier sink docs` — a new section in `docs/utsushi-fidelity-policy.md`
  pinning per-sink tier rules.

This node sits between UTSUSHI-020 (the VFS substrate, complete) and the
conformance layer (UTSUSHI-026, then the capture/recording check at
UTSUSHI-029, which is the first downstream consumer that declares a hard
dependency on this node). It is co-equal to UTSUSHI-021 (input/clock/replay)
inside the `utsushi-core` parallel group; both touch `RuntimeRequest` and both
must be additive so they can land in either order without merge conflict.

### Downstream contracts that constrain this shape

- **UTSUSHI-029** (capture/recording artifact conformance, `dependsOn`
  UTSUSHI-022): consumes the `FrameArtifactSink` output and asserts that every
  artifact ref is portable, lives under the managed artifact root, and that
  unsupported capture is a typed unsupported result rather than a silent pass.
  The conformance side of "unsupported" needs a typed enum, not a missing
  field.
- **UTSUSHI-027** (trace/branch conformance, `dependsOn` UTSUSHI-026): the
  text-surface sink output is the source of the trace event sequence that
  conformance checks compare against. Order must be deterministic and bridge
  units must be referenceable.
- **UTSUSHI-026** (conformance manifest + result schema, `dependsOn`
  UTSUSHI-021): the manifest references the sink shapes by name and tier.
  We pre-register sink kinds + their tier ceilings here so 026 can codify them
  without retrofitting.
- **UTSUSHI-024** (WASM embed ABI, `dependsOn` UTSUSHI-022 + UTSUSHI-023): the
  embed exposes accumulated sink output through a stable ABI. Sink types must
  be `Send + Sync` and serializable without committing to a renderer.
- **UTSUSHI-103** (engine-port runner template, deferred from UTSUSHI-020): if
  103 chooses to pass sinks through `RuntimeRequest`, the `sinks` field must
  already exist as an additive `Option`. This plan installs it.

### Engine-neutrality bar

The sink contracts run for synthetic-json, RPG Maker MV/MZ (JS DOM-shaped
runtime), and RealLive Scene strings. No JSON shape, no DOM shape, no Scene
opcode leaks into the trait surface. Sink methods take typed lines / events /
artifact refs that any engine can produce.

## 2. Module placement

**Recommendation: keep sinks in `utsushi-core` under a new module
`utsushi_core::sink`, with submodules `sink::{text, frame, audio, set,
errors}`. Do not introduce a new crate.**

Justification (mirrors the UTSUSHI-020 placement reasoning, which set the
substrate-in-core precedent):

- `utsushi-core` already owns `RuntimeAdapter`, `RuntimeRequest`, every
  evidence/fidelity tier enum (`EvidenceTier`, `FidelityTier`,
  `RuntimeCapabilityClass`), `ObservationArtifactRef`,
  `RuntimeArtifactRoot`, the redaction policy in
  `reject_unredacted_local_paths`, and `OBSERVATION_HOOK_SCHEMA_VERSION`. The
  sinks must participate in all of these directly; cross-crate re-exports
  would be churn for no isolation gain.
- Every downstream substrate node (023, 024, 026/027/029, 103, 120) already
  depends on `utsushi-core`. A new crate forces them to add a second dep.
- The three sinks share types (`EvidenceTier`, `ArtifactRef`, `SinkError`,
  `SinkKind`, redaction-validated payloads). Splitting them into three modules
  is enough; splitting them across crates would force the shared
  unsupported-diagnostic and redaction logic to live in a fourth shared crate.
- The slice is bounded: ~3 traits, 2 payload types, 1 holder, 1 error enum,
  1 capability enum. Module-level isolation inside `utsushi-core/src/sink/`
  matches the UTSUSHI-020 `vfs/` precedent.

Public re-exports at the crate root: `SinkSet`, `SinkKind`, `SinkError`,
`SinkCapability`, `TextSurfaceSink`, `TextLine`, `FrameArtifactSink`,
`FrameArtifact`, `AudioEventSink`, `AudioEvent`.

**No new workspace member is required for this node.**

## 3. Trait surfaces

All three sink traits are `Send + Sync`, take `&self` only (no `&mut`), and
return `SinkResult<()>`. Interior mutability is the implementor's concern
(typically a `Mutex<Vec<...>>` collector in the fixture). This mirrors the
UTSUSHI-020 `RuntimeVfs` posture and is the only choice compatible with
adapters wanting to share a sink between threads.

### 3.1 Shared types

```rust
pub type SinkResult<T> = Result<T, SinkError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SinkKind {
    TextSurface,
    FrameArtifact,
    AudioEvent,
}

impl SinkKind {
    pub fn as_str(self) -> &'static str { /* "text_surface" | "frame_artifact" | "audio_event" */ }

    /// Maximum evidence tier a single emission into this sink may claim.
    /// This is a per-sink ceiling and is independent of the adapter's
    /// declared `EvidenceTier` ceiling — it stops a low-tier sink from
    /// being mistaken for high-tier evidence.
    pub fn evidence_tier_ceiling(self) -> EvidenceTier {
        match self {
            Self::TextSurface => EvidenceTier::E1, // text trace only
            Self::FrameArtifact => EvidenceTier::E2, // capture
            Self::AudioEvent => EvidenceTier::E0,   // metadata only
        }
    }
}

/// Adapter-declared support for a sink kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SinkCapability {
    Unsupported,
    Supported { evidence_tier_ceiling: EvidenceTier },
}
```

`SinkKind::evidence_tier_ceiling` is the headline invariant. A frame-artifact
emission can never claim E1-only because that would be under-claiming, and a
text emission cannot claim E2 because text is not a rendered screen. Audio is
always E0 metadata; an adapter wanting to claim audio playback parity must do
so through a _different_ sink that does not yet exist (out of scope: see §11).

### 3.2 `TextSurfaceSink`

```rust
pub trait TextSurfaceSink: Send + Sync {
    fn capability(&self) -> SinkCapability;

    /// Emit a text line at the declared evidence tier. The sink MUST reject
    /// `evidence_tier > SinkKind::TextSurface.evidence_tier_ceiling()`.
    fn emit_line(&self, line: TextLine) -> SinkResult<()>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextLine {
    /// Stable per-run identifier (UUIDv7 or deterministic-derived). Used by
    /// trace conformance (UTSUSHI-027) to assert ordering.
    pub line_id: String,
    /// E0 (no runtime ran), E1 (runtime trace), or capped at E1 by
    /// `SinkKind::evidence_tier_ceiling`. Higher tiers are rejected.
    pub evidence_tier: EvidenceTier,
    /// The observed text. UTF-8, post-decoding, post-engine-text-substitution.
    pub text: String,
    /// Optional speaker label observed by the runtime (e.g. RealLive name
    /// register, MV/MZ event speaker). Never a host identifier.
    pub speaker: Option<String>,
    /// Optional engine-supplied surface label (e.g. "ADV", "NVL", "Choice",
    /// "Database.terms"). Engine-neutral string; the sink does not interpret.
    pub text_surface: Option<String>,
    /// Bridge-unit linkage. Required for trace conformance bridge-ref checks.
    pub bridge_ref: Option<ObservationBridgeRef>,
    /// Optional asset id this text came from (e.g. `vfs://www/data/Map001.json`).
    /// Engine-neutral; uses the UTSUSHI-020 `AssetId` shape.
    pub source_asset: Option<AssetId>,
}
```

A `TextLine` is not a screenshot. The wording in
`docs/utsushi-fidelity-policy.md` for the new "Sink tier rules" section makes
the distinction explicit (see §8): a `TextSurfaceSink` emission proves "the
runtime emitted this text string for this bridge unit," not "this text was
rendered on screen at any point."

### 3.3 `FrameArtifactSink`

```rust
pub trait FrameArtifactSink: Send + Sync {
    fn capability(&self) -> SinkCapability;

    /// Emit a frame artifact reference. The sink MUST reject
    /// `evidence_tier < EvidenceTier::E2` because a frame artifact is the
    /// minimum E2 evidence; lower tiers must use a different sink.
    /// The sink also MUST reject any `FrameArtifact` whose `artifact_ref`
    /// has not been produced through `RuntimeArtifactRoot::write_bytes`
    /// (validated by URI shape, not by host filesystem state).
    fn emit_frame(&self, artifact: FrameArtifact) -> SinkResult<()>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameArtifact {
    /// Stable per-run identifier; UTSUSHI-029 uses this for portability
    /// assertions.
    pub frame_id: String,
    /// Always >= E2. E3 is allowed for adapters that genuinely produce
    /// branchable review artifacts; E4 is allowed only for adapters that
    /// have reference comparison evidence and declare `ReferenceFidelity`
    /// in their descriptor.
    pub evidence_tier: EvidenceTier,
    /// Required: portable artifact reference. The URI MUST live under the
    /// `RUNTIME_ARTIFACT_URI_ROOT` namespace (`artifacts/utsushi/runtime/...`)
    /// per `RuntimeArtifactRoot`. The sink calls
    /// `validate_runtime_artifact_uri` on insert; failure becomes
    /// `SinkError::ArtifactPolicy`.
    pub artifact_ref: ObservationArtifactRef,
    /// Optional pixel dimensions; informational only.
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Monotonic frame number from the runtime clock. Required so frame
    /// streams stay deterministic; UTSUSHI-021 owns the clock.
    pub frame_index: u64,
    /// Bridge-unit linkage (the bridge unit this capture was taken for).
    /// Optional because not every capture corresponds to a specific
    /// localized unit (e.g. transition frames).
    pub bridge_ref: Option<ObservationBridgeRef>,
}
```

The sink does not store bytes. Bytes live behind the artifact-store API
(`RuntimeArtifactRoot::write_bytes`, already implemented). `FrameArtifactSink`
is the _announcement_ surface, not the storage surface; this is what keeps
"screenshot refs bypassing artifact policy" out of the audit focus.

### 3.4 `AudioEventSink`

```rust
pub trait AudioEventSink: Send + Sync {
    fn capability(&self) -> SinkCapability;

    /// Emit an audio event as inspectable metadata. The sink MUST reject
    /// `evidence_tier > EvidenceTier::E0` because audio events do not
    /// prove playback parity.
    fn emit_event(&self, audio: AudioEvent) -> SinkResult<()>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioEvent {
    pub event_id: String,
    /// Always E0; the sink rejects anything else.
    pub evidence_tier: EvidenceTier,
    /// Engine-neutral discriminant; not opcode/file-format leakage.
    pub event_kind: AudioEventKind,
    /// Stable cue/label/track id from the runtime. Engine-supplied string;
    /// the sink does not interpret. NEVER a host path.
    pub cue_id: Option<String>,
    /// Optional asset id of the audio resource (e.g.
    /// `vfs://www/audio/bgm/Field1.ogg`). Uses the UTSUSHI-020 AssetId, so
    /// it is engine-neutral and host-path-free by construction.
    pub source_asset: Option<AssetId>,
    /// Optional bridge-unit linkage (for voiced dialogue tied to a line).
    pub bridge_ref: Option<ObservationBridgeRef>,
    /// Optional monotonic timeline marker from the runtime clock.
    pub frame_index: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AudioEventKind {
    BgmStart,
    BgmStop,
    SeFire,
    VoicePlay,
    VoiceStop,
    Marker,
}
```

The kind enum is intentionally bounded to engine-neutral events. New kinds
require a typed-enum extension, not a free-form string, so adapters cannot
smuggle engine semantics into metadata. The audit focus item "audio metadata
treated as playback fidelity" is met because the trait does not accept bytes,
durations, sample rates, or mix levels — there is no surface that _could_
look like playback evidence.

### 3.5 Trait posture (all three)

- `Send + Sync`, `&self`-only methods (sync trait surface, matches UTSUSHI-020
  and matches the existing `RuntimeAdapter` posture).
- No `&mut`. Implementations use interior mutability (`Mutex<Vec<TextLine>>`
  in the fixture collector). A future async surface, if ever needed, is a
  parallel `async_trait` addition in a later node; documented, not built now.
- No `&Path` / `&PathBuf`. All path-shaped fields use `AssetId`
  (UTSUSHI-020) or `ObservationArtifactRef` (existing `utsushi-core`).
- Serializable inputs (`TextLine`, `FrameArtifact`, `AudioEvent`) implement
  `Serialize`/`Deserialize` with `#[serde(rename_all = "camelCase")]` to match
  the existing observation hook payloads.

## 4. `SinkSet` and `RuntimeRequest` extension

### 4.1 `SinkSet`

```rust
#[derive(Clone, Default)]
pub struct SinkSet {
    text: Option<Arc<dyn TextSurfaceSink>>,
    frame: Option<Arc<dyn FrameArtifactSink>>,
    audio: Option<Arc<dyn AudioEventSink>>,
}

impl SinkSet {
    pub fn new() -> Self { Self::default() }

    pub fn with_text(mut self, sink: Arc<dyn TextSurfaceSink>) -> Self { /* ... */ }
    pub fn with_frame(mut self, sink: Arc<dyn FrameArtifactSink>) -> Self { /* ... */ }
    pub fn with_audio(mut self, sink: Arc<dyn AudioEventSink>) -> Self { /* ... */ }

    pub fn text(&self) -> Option<&dyn TextSurfaceSink> { /* ... */ }
    pub fn frame(&self) -> Option<&dyn FrameArtifactSink> { /* ... */ }
    pub fn audio(&self) -> Option<&dyn AudioEventSink> { /* ... */ }

    /// Capability summary, for descriptor / report introspection.
    pub fn capabilities(&self) -> SinkCapabilitySummary;
}
```

A bare `Option<Arc<dyn ...>>` per sink kind is enough; the holder exists so
`RuntimeRequest` carries a single optional field rather than three. The
`capabilities()` helper produces the summary that conformance reports embed.

### 4.2 `RuntimeRequest` extension — additive

```rust
pub struct RuntimeRequest<'a> {
    pub input_root: &'a Path,
    pub artifact_root: Option<&'a Path>,
    pub vfs: Option<Arc<dyn RuntimeVfs>>,        // added by UTSUSHI-020
    pub sinks: Option<SinkSet>,                  // added by UTSUSHI-022
    // UTSUSHI-021 will add `replay: Option<ReplayLog>` similarly.
}
```

Builder method follows the existing convention:

```rust
impl<'a> RuntimeRequest<'a> {
    pub fn with_sinks(mut self, sinks: SinkSet) -> Self {
        self.sinks = Some(sinks);
        self
    }
}
```

The `Debug` impl is updated to print `sinks: <present>/<absent>` without
exposing the implementor type (matches the existing `vfs` formatting).

### Coordination with UTSUSHI-021

Both UTSUSHI-021 and UTSUSHI-022 add additive optional fields to
`RuntimeRequest`. Whichever node lands first wins the import-order conflict
in `Cargo.lock` and the trivial conflict in the struct literal in `new()`.
Both planners committed to this posture; the structural decision is "one new
`Option<...>` field per node, with a `with_*` builder." There is no shared
type between the two nodes (replay and sinks do not refer to each other), so
the merge is a one-line addition either way.

The other reason the additive `Option` posture is required: existing
adapters that do not consume sinks must keep working. The fixture adapter
constructs `RuntimeRequest::new(input_root)` in tests and via the CLI;
neither call site should change in this node. Slice B (see §12) is the
fixture refactor that opts into the sink set.

## 5. Evidence tier declaration on sink output

The headline rule: **each sink output carries its `EvidenceTier`, and the
sink contract enforces the per-sink ceiling**.

| Sink                | Field on the payload type      | Enforced ceiling                | Lower bound         |
| ------------------- | ------------------------------ | ------------------------------- | ------------------- |
| `TextSurfaceSink`   | `TextLine::evidence_tier`      | E1                              | E0 allowed (static) |
| `FrameArtifactSink` | `FrameArtifact::evidence_tier` | E4 (only for ReferenceFidelity) | E2 minimum required |
| `AudioEventSink`    | `AudioEvent::evidence_tier`    | E0                              | E0 minimum required |

The sink methods validate the tier on insert and return
`SinkError::EvidenceTierMismatch { sink, claimed, ceiling }` on violation.
The lower bound for frame artifacts is the load-bearing rule: a frame ref
that claims E1 is rejected because that hides a screenshot inside the trace
lane and confuses dashboards that filter by tier.

The adapter descriptor (`RuntimeAdapterDescriptor`) is unchanged structurally
in this node, but a follow-up audit asserts that an adapter declaring
`evidence_tier_ceiling = E1` does not register a `FrameArtifactSink` with
capability `Supported { evidence_tier_ceiling: E2 }`. That check is added as
a separate runtime-time assertion in `SinkSet::capabilities()` rather than as
a new descriptor field: the descriptor stays stable, and the sink set
provides a typed view that conformance (UTSUSHI-026) can inspect later.

## 6. `ArtifactRef` integration

Frame artifacts use the existing `ObservationArtifactRef` from
`utsushi-core`, which already requires a URI of the form
`artifacts/utsushi/runtime/<run-id>/<kind>/<artifact-id>.<ext>` and is
validated by `validate_runtime_artifact_uri` (which rejects absolute paths,
backslashes, traversal, `file:`/`data:`/`blob:` schemes, and uses
`RUNTIME_ARTIFACT_URI_ROOT` as the only allowed prefix).

The sink integration:

1. The adapter writes frame bytes through `RuntimeArtifactRoot::write_bytes`
   (already exists). That call produces a managed-root-relative path and
   validates the URI.
2. The adapter constructs an `ObservationArtifactRef` (existing struct,
   already a `validate()` is implemented) referencing the URI produced.
3. The adapter calls `FrameArtifactSink::emit_frame` with that ref inside a
   `FrameArtifact`.
4. The sink calls `ObservationArtifactRef::validate()` on insert. Any
   non-managed-root URI fails with `SinkError::ArtifactPolicy`.

This means there is exactly one path artifact bytes can reach the sink
through: the managed artifact store. The audit focus item "screenshot refs
bypassing artifact policy" is met because the sink rejects refs whose URI
fails `validate_runtime_artifact_uri`, and rejects refs whose
`artifact_kind` is not in the allow-list (`"screenshot"`, `"frame_capture"`,
`"recording"`).

Confirmed by reading `crates/utsushi-core/src/lib.rs`:
`RuntimeArtifactRoot::write_bytes` (lines 244–258) is the artifact-store
write surface; `validate_runtime_artifact_uri` (lines 392–433) is the
existing portability validator; `ObservationArtifactRef::validate` (lines
1490–1496) already calls it. The sink reuses these unchanged.

## 7. Unsupported diagnostic — typed, never silent

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SinkError {
    /// The adapter routed an emission to a sink kind it cannot serve. This
    /// is the canonical "no optionality" case from the audit focus.
    UnsupportedKind { sink: SinkKind, adapter_id: String, reason: String },

    /// The emission's evidence tier violates the sink's per-kind ceiling
    /// or the frame-artifact lower bound (E2).
    EvidenceTierMismatch {
        sink: SinkKind,
        claimed: EvidenceTier,
        ceiling: EvidenceTier,
    },

    /// The frame artifact ref is not a managed runtime artifact URI, or its
    /// `artifact_kind` is not in the allow-list.
    ArtifactPolicy { artifact_id: String, reason: String },

    /// The payload failed redaction (a field matched
    /// `looks_like_local_path` after serialization).
    RedactionViolation { sink: SinkKind, field: String },

    /// The sink is configured but disabled (e.g. soft artifact-budget ceiling
    /// hit per the fidelity policy's `artifactLimits`).
    BudgetExhausted { sink: SinkKind, budget: String },
}

impl SinkError {
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::UnsupportedKind { .. } => "utsushi.sink.unsupported_kind",
            Self::EvidenceTierMismatch { .. } => "utsushi.sink.evidence_tier_mismatch",
            Self::ArtifactPolicy { .. } => "utsushi.sink.artifact_policy",
            Self::RedactionViolation { .. } => "utsushi.sink.redaction_violation",
            Self::BudgetExhausted { .. } => "utsushi.sink.budget_exhausted",
        }
    }
}
```

`SinkError: std::error::Error + Send + Sync + 'static`, converts to
`Box<dyn std::error::Error>` so it lives inside `UtsushiResult<T>`.

`UnsupportedKind` is what a text-only adapter returns when its
`AudioEventSink` capability is `Unsupported` and the runtime tries to emit
an audio event. The runtime path MUST surface this; the sink never silently
drops. The `adapter_id` carries the public adapter name (not a host path),
and `reason` carries a stable, public phrase like "adapter does not produce
audio metadata."

The schema registry update prepays the `utsushi.sink.*` semantic-code prefix
inside the conformance schema package, matching the UTSUSHI-020 precedent
where `utsushi.vfs.*` was preallocated for UTSUSHI-026 to codify later.

## 8. Evidence-tier sink docs

Extend `docs/utsushi-fidelity-policy.md` (do NOT create a new doc — the
fidelity policy is the canonical home for tier rules; adding a parallel
sink-tier doc would create a wording-drift hazard).

Add a new top-level section `## Sink Tier Rules` between the existing
`## Adapter Capability Contract` and `## Runtime Environment Matrix`:

```md
## Sink Tier Rules

Utsushi runtime ports emit observed evidence into three headless sink
contracts. Each sink kind has a fixed evidence-tier ceiling that is
independent of the adapter's `evidenceTier` ceiling — a powerful adapter
emitting into the text sink still only produces text-tier evidence.

### Text surface sink

Emissions describe the runtime-observed text for a bridge unit. The maximum
claim is **E1 trace-reachable**: the runtime emitted this string, the
adapter assumptions hold, and the bridge unit linkage is valid. Text-only
adapters (synthetic JSON, RealLive Scene strings, RPG Maker MV/MZ JS DOM
when not capturing) operate at E1. A text emission MUST NOT be summarized
as "rendered" or "captured" in any report; only the per-sink ceiling
applies.

### Frame artifact sink

Emissions describe a captured frame as a portable artifact reference. The
minimum claim is **E2 captured**; the sink rejects E0/E1 frame refs. An
adapter that supports replay review with annotated frames may emit E3
artifacts; an adapter that claims reference fidelity may emit E4 artifacts
but only when its descriptor declares `reference_fidelity` and the
capability contract includes `ReferenceComparison`. A frame artifact ref
that lives outside `artifacts/utsushi/runtime/...` is policy-rejected and
the report MUST surface the failure as a runtime finding, not as a missing
artifact.

### Audio event sink

Emissions describe audio events as inspectable metadata. The maximum claim
is **E0 metadata**: a marker that an audio cue, BGM start, SE fire, or
voice line was triggered, plus optional VFS-shaped asset id and bridge
linkage. The sink does NOT accept audio bytes, sample rates, durations,
or mix levels. Audio metadata MUST NOT be promoted to E1 trace or higher,
and an adapter wanting to claim audio playback fidelity must introduce a
new sink in a future node; the audio event sink is not that surface.

### Unsupported sink kinds

An adapter that cannot serve a sink kind (e.g. a text-only adapter
receiving an audio event) returns `utsushi.sink.unsupported_kind`. Silent
drop is forbidden by contract. A runtime evidence report that lists
`utsushi.sink.unsupported_kind` MUST NOT be promoted to a higher tier on
the basis of "no audio events found."
```

The wording above intentionally matches the existing "Wording Rules" tone
in the same document: precise claim verbs, no marketing language, explicit
unsupported semantics.

## 9. Test plan

All tests follow `docs/testing-standard.md`: behavior-named, falsifiable,
no live providers, synthetic/inline fixtures only. Tests live under
`crates/utsushi-core/src/sink/` (`#[cfg(test)] mod tests`) and
`crates/utsushi-core/tests/sink_contracts.rs` (integration).

### 9.1 Text-surface sink

- `text_sink_accepts_e1_emission_for_bridge_unit()`.
- `text_sink_accepts_e0_emission_for_static_text()`.
- `text_sink_rejects_e2_emission_as_evidence_tier_mismatch()` — the
  "cannot be misused for screenshot claims" guarantee.
- `text_sink_rejects_e3_emission_as_evidence_tier_mismatch()`.
- `text_sink_unsupported_capability_returns_unsupported_kind()` — a
  capability-`Unsupported` text sink receives a `TextLine` and returns
  `SinkError::UnsupportedKind { sink: TextSurface, .. }` instead of silently
  dropping.
- `text_sink_emission_with_source_asset_uses_vfs_asset_id()` — confirms the
  payload accepts an `AssetId` rather than a `&Path` (compile-level via the
  type, behavior-level via JSON serialization round trip).
- `text_sink_emission_serializes_with_camel_case()` — schema-stability
  contract.
- `text_sink_emission_passes_observation_redaction_filter()` — the line is
  serialized and run through `reject_unredacted_local_paths` on a wrapper
  observation event; passes.
- `text_sink_emission_with_local_path_in_speaker_fails_redaction()` — a
  speaker field containing `/home/...` is rejected when wrapped, so the
  caller never lands a leak.

### 9.2 Frame-artifact sink

- `frame_sink_accepts_e2_capture_through_managed_artifact_root()` —
  end-to-end: caller writes bytes through `RuntimeArtifactRoot::write_bytes`,
  builds an `ObservationArtifactRef`, emits.
- `frame_sink_rejects_e1_emission_as_evidence_tier_mismatch()` — capture is
  E2-or-higher only.
- `frame_sink_rejects_e0_emission_as_evidence_tier_mismatch()`.
- `frame_sink_rejects_artifact_ref_with_absolute_path_uri()`.
- `frame_sink_rejects_artifact_ref_with_file_scheme()`.
- `frame_sink_rejects_artifact_ref_outside_runtime_artifact_root()`.
- `frame_sink_rejects_artifact_kind_outside_allow_list()` — `artifact_kind`
  values that are not `screenshot`, `frame_capture`, or `recording` fail.
- `frame_sink_capability_declaration_prevents_text_only_adapter_from_emitting()`
  — a text-only adapter wires up a frame sink whose capability is
  `Unsupported`; `emit_frame` returns
  `SinkError::UnsupportedKind { sink: FrameArtifact, .. }`. Adapter cannot
  forge screenshot fidelity.
- `frame_sink_emission_passes_observation_redaction_filter()`.

### 9.3 Audio-event sink

- `audio_sink_accepts_e0_bgm_start_with_vfs_asset_id()`.
- `audio_sink_accepts_e0_voice_play_with_bridge_ref()`.
- `audio_sink_rejects_e1_emission_as_evidence_tier_mismatch()` — metadata
  cannot be promoted to trace.
- `audio_sink_rejects_e2_emission_as_evidence_tier_mismatch()`.
- `audio_sink_rejects_e3_emission_as_evidence_tier_mismatch()`.
- `audio_sink_unsupported_capability_returns_unsupported_kind()` — a
  capability-`Unsupported` audio sink rejects emission rather than silently
  dropping.
- `audio_sink_payload_has_no_audio_bytes_field()` — structural test on
  `AudioEvent` (round-trip through serde to JSON; assert no `bytes`,
  `sampleRate`, `duration`, `mixLevel` keys appear). Confirms the audit
  focus item "audio metadata treated as playback fidelity" by structural
  impossibility.
- `audio_sink_round_trips_metadata_through_json_without_loss()`.
- `audio_sink_emission_passes_observation_redaction_filter()`.

### 9.4 SinkSet and RuntimeRequest

- `sink_set_capability_summary_reports_each_sink_kind()`.
- `sink_set_capability_summary_distinguishes_supported_from_unsupported()`.
- `runtime_request_with_sinks_preserves_existing_vfs_field()` — additive
  field check.
- `runtime_request_debug_does_not_expose_sink_implementor_type()` — the
  `Debug` impl prints a marker, never the concrete type name.

### 9.5 Cross-sink redaction

A single integration test, `sink_output_passes_reject_unredacted_local_paths`,
in `crates/utsushi-core/tests/sink_contracts.rs`:

1. Builds a `SinkSet` with all three sinks `Supported`.
2. Emits one `TextLine`, one `FrameArtifact`, one `AudioEvent`. Each
   payload uses `AssetId` for any path-shaped field and an
   `ObservationArtifactRef` for the frame's artifact ref.
3. Drains the collector, serializes every emission into a JSON value, runs
   `reject_unredacted_local_paths("", &value)` — the existing crate-private
   helper made available to the sink module via `pub(crate)` exposure, or
   re-exported as `pub fn redaction::reject_unredacted_local_paths` for
   external test use. Recommend the latter so integration tests outside
   `utsushi-core` can run the same filter on their sink emissions.

This is the "redaction" acceptance criterion from the plan brief.

### 9.6 Engine-neutrality smoke

A small `engine_neutral_text_sink_accepts_three_engine_shapes()` test
constructs three `TextLine`s with `text_surface` set to `"adv"`,
`"event_command"`, and `"scene_string"` (representing synthetic, MV/MZ, and
RealLive). The sink accepts all three identically, with no engine-specific
branching. The test exists to prevent a future "if MV/MZ" check from
sneaking into the sink trait.

### 9.7 Test placement and posture

- Unit tests live with the module they exercise.
- `crates/utsushi-fixture` is NOT changed in this node. Sink consumption by
  the fixture adapter is Slice B (see §12). The plan brief allows running
  `cargo test -p utsushi-fixture` to confirm no regression; that command is
  expected to pass unchanged because no API the fixture depends on changes
  shape.

## 10. Verification commands

```
cargo test -p utsushi-core
cargo test -p utsushi-fixture
just schema
```

Reasoning, per the brief:

- `cargo test -p utsushi-core` exercises every new sink test.
- `cargo test -p utsushi-fixture` confirms no regression in the existing
  fixture surface (the additive `sinks: Option<SinkSet>` field on
  `RuntimeRequest` is opt-in; the fixture's existing construction is
  unchanged).
- `just schema` validates the schema package: this matters because
  conformance manifests (UTSUSHI-026 future) reference the sink shapes by
  name, and the `utsushi.sink.*` semantic-code prefix is pre-registered
  here (matches the UTSUSHI-020 `utsushi.vfs.*` precedent).

`just check` is recommended locally; CI runs it.

## 11. Risks and unknowns

### 11.1 `RuntimeRequest` collision with UTSUSHI-021

Both UTSUSHI-021 (`replay`) and UTSUSHI-022 (`sinks`) add an
`Option<...>` field to `RuntimeRequest`. The plan-brief coordination note
states both must be additive. Concrete mitigation:

- This plan commits to exactly one new field, `sinks: Option<SinkSet>`,
  and one new builder method, `with_sinks`. No other field is touched.
- The `Debug` impl gains exactly one new line.
- `RuntimeRequest::new(input_root)` initializes `sinks: None`.

If UTSUSHI-021 lands first, this plan's diff is a one-line struct addition
and a one-line builder method addition — trivially mergeable. If
UTSUSHI-022 lands first, UTSUSHI-021's diff is symmetric. Neither plan
depends on field ordering, so `rustfmt` ordering is not a concern.

### 11.2 Frame artifact size policy

The `docs/utsushi-fidelity-policy.md` `## Artifact Limits` table already
defines per-screenshot soft/hard ceilings (5 MiB / 15 MiB). The sink does
not enforce byte size — that is the artifact-store's concern, and the bytes
go through `RuntimeArtifactRoot::write_bytes`, which is the right enforcement
point. The sink does include a `SinkError::BudgetExhausted` variant for
future use by an artifact-budget tracker; this node does not implement
budget tracking, only models the diagnostic so a follow-up can wire it
without an ABI break.

The remaining unknown: where exactly the soft-budget hook lives. The
recommendation is `RuntimeArtifactRoot::write_bytes` returns
`SinkError::BudgetExhausted`-equivalent when a budget tracker is registered;
the sink simply propagates. That decision can wait until UTSUSHI-029 needs
it, which is the first downstream consumer of frame refs.

### 11.3 Audio event taxonomy completeness

`AudioEventKind` covers BGM start/stop, SE fire, voice play/stop, and a
generic marker. Real engines have more states: BGM crossfade, SE volume
ramp, voice "now playing this exact subtitle" sync. The current taxonomy is
deliberately small because:

- Adding a kind is a small additive enum extension; removing one is a
  breaking change. Start narrow.
- Audio is E0 metadata only; the taxonomy needs to be expressive enough to
  describe _that an event happened_, not _what its audio signal looked
  like_. The current six kinds carry that contract for synthetic, MV/MZ
  (audio_bgm/audio_se), and RealLive (BGM/SE/voice opcodes).
- A future "audio fidelity sink" that does claim playback parity would be
  a different trait with a different tier ceiling; nothing here forecloses
  that.

Unknown for follow-up: whether voice-subtitle sync needs its own variant or
fits inside `VoicePlay`/`Marker`. Deferred to the first port that needs it.

### 11.4 Sink composition vs `RuntimeAdapter` change

This plan does NOT add a sink parameter to `RuntimeAdapter::run` or
`RuntimeAdapter::trace`. The reasoning matches UTSUSHI-020: the
`RuntimeRequest` carries optional fields, adapters read what they need,
and the trait stays stable until UTSUSHI-103 makes a signature decision.
The fixture refactor (Slice B) demonstrates the consume-from-request
pattern without changing the trait.

### 11.5 Re-export of `reject_unredacted_local_paths`

The function is currently private (`fn`, not `pub fn`). The integration
test in §9.5 needs it from outside the crate root, and downstream nodes
(UTSUSHI-029 conformance for sink output) will want it too. Recommendation:
expose it as `pub fn redaction::reject_unredacted_local_paths` in a new
`utsushi_core::redaction` module that re-exports the existing helper. This
is a tiny additive change in this node. If review prefers to keep it
private, an alternative is to add a `pub fn validate_sink_payload_redaction`
wrapper inside the sink module — same behavior, narrower surface. Either is
acceptable; the plan prefers the first for cross-crate reusability.

## 12. Out of scope

- Actual rendering of any kind. UTSUSHI-146 / UTSUSHI-060 territory.
- Conformance schema for sink output. UTSUSHI-026 codifies it; this node
  pre-allocates the `utsushi.sink.*` semantic-code prefix.
- Capture orchestration (when to take a screenshot, jump-to-moment
  triggering). UTSUSHI-029 plus the engine-port nodes.
- Audio fidelity / playback comparison sink. Future node; not foreclosed.
- Replay log integration (UTSUSHI-021). The two nodes coordinate via the
  additive `RuntimeRequest` field; neither node imports the other's types.
- WASM embed ABI for sinks. UTSUSHI-024 consumes these sinks; this node
  designs the Rust-side trait surface only.
- Fixture adapter refactor to consume sinks. See Slice B below — recommended
  follow-up node, not part of UTSUSHI-022.
- Browser, NW.js, or other launch-host wiring. UTSUSHI-029 + engine ports.
- Bridge-unit ref schema changes. `ObservationBridgeRef` is reused as-is.

## 13. Implementation worker scoping

Recommendation: **one worker, one implementation slice**, matching the
plan brief's "worker scoping" guidance. The three sinks are conceptually
parallel but share `EvidenceTier`, `ArtifactRef`, `SinkError`, redaction,
and the `SinkSet`/`RuntimeRequest` integration. Splitting into three PRs
would multiply review cost and risk inconsistent tier enforcement.

### Slice A — sink substrate (`UTSUSHI-022a-sinks`)

Single PR; owns all of:

- `utsushi_core::sink::{text, frame, audio, set, errors}` modules.
- Public re-exports at the crate root.
- Additive `RuntimeRequest::sinks: Option<SinkSet>` field plus
  `with_sinks` builder.
- All unit + integration + redaction tests under `utsushi-core`.
- `docs/utsushi-fidelity-policy.md` "Sink Tier Rules" section.
- Schema registry update for the `utsushi.sink.*` semantic-code prefix
  (validated by `just schema`).
- Optional `pub use redaction::reject_unredacted_local_paths` re-export per
  §11.5.

Verification: `cargo test -p utsushi-core`, `cargo test -p utsushi-fixture`,
`just schema`, `just check`.

Estimated worker time: medium. Trait + payload shapes are mechanical; the
heavier work is the redaction-integration test, tier-ceiling enforcement
on insert, and the fidelity-policy doc update.

### Slice B (follow-up, NOT this node) — fixture sink consumption

Tracked as a sibling implementation slice once Slice A merges. Adds a
fixture-adapter collector implementing all three sinks, wires
`RuntimeRequest::with_sinks`, and asserts that the existing trace/capture
report shapes still serialize identically. Out of scope here.

## Plan ends here.
