# UTSUSHI-103 — Engine-port runner crate template and ABI conformance

- **Node**: UTSUSHI-103
- **Title**: Engine-port runner crate template and ABI conformance
- **Branch**: `spec/utsushi-103`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-103`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress -> ready_for_review (Slice A merged)

## 1. Goal restatement

UTSUSHI-103 builds the engine-port runner template: the single shared, manifest-
driven ABI that every Utsushi engine port (RPG Maker MV/MZ runtime, plain
XP3+KAG runtime, SiglusEngine, RealLive/`utsushi-reallive`, future ports) must
conform to. The template defines:

1. A manifest schema (Rust `const` types) that ports declare. The manifest is
   the audit surface for capabilities, required/optional lifecycle methods, ABI
   version, environment field schema, and tier ceilings.
2. An `EnginePort` trait with required lifecycle methods (`launch`, `observe`,
   `capture`, `shutdown`) and capability-gated optional methods (`jump`).
3. A `Runner` orchestrator that validates the manifest, plumbs cancellation,
   manages the artifact root and the runtime VFS handoff from UTSUSHI-020,
   enforces unredacted-env rejection, and runs the lifecycle.
4. An ABI conformance harness — a test surface that takes a `dyn EnginePort` +
   `PortManifest` and exercises every required lifecycle method (positive and
   negative).
5. A refactor of `utsushi-fixture::FixtureRuntimeAdapter` to adopt the new
   template as the reference port (Slice B).

This node is engine-neutral substrate. It does NOT contain engine-specific
code. Engine ports live in their own crates (`utsushi-rpgmaker-mv`,
`utsushi-kirikiri-kag`, `utsushi-siglus`, `utsushi-reallive`) and import the
template from `utsushi-core`.

Downstream nodes whose acceptance criteria informed this shape:

- UTSUSHI-031..039 (per-engine ports): each will provide a `PortManifest` and
  implement `EnginePort`. The conformance harness is what they run their tests
  through.
- UTSUSHI-146 (`utsushi-reallive`): explicitly depends on UTSUSHI-103 +
  UTSUSHI-120. The RealLive port is the first non-fixture consumer; the
  manifest must be expressive enough to declare RealLive's no-jump-yet status,
  Scene/SEEN-replay observation envelope, and headless render through the
  substrate sinks.
- UTSUSHI-104 (cross-engine moment index and jump planner): planner emits
  `Jump` commands. UTSUSHI-103 leaves `jump` as a capability-declared optional
  method that returns a typed `CapabilityUnsupported` diagnostic until 104/106
  land. Jump must remain a first-class manifest field so planners can detect
  port support without trying and failing.
- UTSUSHI-106 (branch frontier traversal scheduler): consumes the same
  observation envelope. UTSUSHI-103 must accept frontier-driven control by
  exposing a deterministic cancellation channel and an observation stream that
  scheduler code can drain.
- UTSUSHI-120 (substrate facade): re-exports `EnginePort`, `PortManifest`,
  `Runner`, and the conformance harness. UTSUSHI-103 must compile cleanly
  through the facade by keeping internal types crate-private and exposing only
  the declared surface.

UTSUSHI-103 also coordinates with two parallel-track nodes:

- UTSUSHI-021 (deterministic input/clock + replay log) and
- UTSUSHI-022 (headless text/render/audio sinks).

All three want to extend `RuntimeRequest`. UTSUSHI-020 already added
`vfs: Option<Arc<dyn RuntimeVfs>>`. UTSUSHI-103 plans further additive
`Option<...>` fields (see section 7.1) so any merge order works.

## 2. Module placement

**Recommendation: keep the template in `utsushi-core` as a new public module
`utsushi_core::port`, alongside `utsushi_core::vfs`.**

Justification:

- `utsushi-core` is the only engine-neutral crate. Engine-specific code lives
  in `utsushi-rpgmaker-mv`, `utsushi-kirikiri-kag`, `utsushi-siglus`,
  `utsushi-reallive`, etc. Putting the template in `utsushi-core` means every
  engine crate has one dependency for the template.
- The conformance harness lives in `utsushi_core::port::conformance` so engine
  test crates can call `utsushi_core::port::conformance::run_required_abi(...)`
  through their dev-deps. Putting the harness anywhere else creates a circular
  dependency or forces every engine crate to depend on a new
  `utsushi-port-conformance` crate.
- The legacy operation-shaped `RuntimeAdapter` trait (sections of `lib.rs`
  around `pub trait RuntimeAdapter`) stays as-is. `EnginePort` is a different
  surface: lifecycle-shaped, not operation-shaped. `Runner` knows how to drive
  an `EnginePort` to fulfill the existing `RuntimeAdapter` operations (Trace,
  Capture, SmokeValidation) so that adapters can opt in to the new ABI without
  rewriting the CLI registry. See section 4.5.
- The fixture port (`crates/utsushi-fixture/src/lib.rs::FixtureRuntimeAdapter`)
  stays in `utsushi-fixture`. Slice B refactors it to implement `EnginePort`
  and reach the existing `RuntimeAdapter` surface through the bridge in
  section 4.5.

**Submodule layout under `crates/utsushi-core/src/port/`**:

```
crates/utsushi-core/src/port/
  mod.rs              # re-exports + crate docs
  manifest.rs         # PortManifest, PortCapability, EnvFieldSchema, etc.
  trait_.rs           # EnginePort trait + default jump impl + lifecycle types
  runner.rs           # Runner orchestrator + cancellation token + lifecycle plumbing
  diagnostics.rs      # EnginePortError, capability diagnostics, env-leak errors
  conformance.rs      # ABI conformance harness (gated behind cfg(any(test, feature = "port-conformance")))
```

`utsushi-core` re-exports the public surface from `lib.rs`:

```rust
pub mod port;
pub use port::{
    EnginePort, EnginePortError, EnvFieldSchema, EnvFieldShape, FidelityTier,
    LifecycleStage, MissingMethod, PortCapability, PortManifest, PortRequest,
    PortShutdownOutcome, Runner, RunnerCancellation, RunnerObservation,
    RunnerOutcome,
};
```

(Some names already exist in `utsushi-core` — `FidelityTier`, etc. — and are
re-used, not re-defined.)

**No new workspace member is required for this node.** A possible future
extraction into `utsushi-port` mirrors the same allowance that UTSUSHI-020
left for `utsushi-vfs`; not done here.

## 3. Manifest schema

All manifest types live in `utsushi_core::port::manifest`. The manifest is
declared by each port as a `const PortManifest` so the audit surface is
inspectable without executing any port code.

### 3.1 `PortManifest`

```rust
/// Static, audit-grade declaration of an engine port. Every port crate
/// exposes one `pub const MANIFEST: PortManifest = PortManifest { ... }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortManifest {
    /// Stable, lowercased port id, e.g. `"utsushi-fixture"`,
    /// `"utsushi-reallive"`, `"utsushi-rpgmaker-mv"`.
    pub id: &'static str,

    /// Human display name.
    pub name: &'static str,

    /// Port crate semantic version. Must match
    /// `env!("CARGO_PKG_VERSION")` at construction time (asserted by
    /// `PortManifest::validate`).
    pub version: &'static str,

    /// ABI version this port targets. Runner rejects values outside its
    /// supported range with `EnginePortError::AbiVersionUnsupported`.
    pub abi_version: u32,

    /// Capability set declared as supported. Capabilities not listed here
    /// fail with `EnginePortError::CapabilityUnsupported` if the runner is
    /// asked for them.
    pub capabilities: &'static [PortCapability],

    /// Lifecycle methods that the port commits to implementing. Must list
    /// every method in `EnginePort::REQUIRED_METHODS`. Validated against
    /// the trait implementation by the conformance harness.
    pub required_methods: &'static [LifecycleStage],

    /// Lifecycle methods declared as available beyond the required set
    /// (currently only `Jump`). A method named here that the port has not
    /// implemented fails validation.
    pub optional_methods: &'static [LifecycleStage],

    /// Declared environment fields the port consumes through
    /// `PortRequest::env`. Used to reject ports that read undeclared
    /// values and to enforce redaction at runner boundary.
    pub env_schema: &'static [EnvFieldSchema],

    /// Maximum fidelity tier this port can ever claim. Runner rejects
    /// runner-level evidence above this ceiling.
    pub fidelity_tier_max: FidelityTier,

    /// Maximum evidence tier this port can ever claim. Must satisfy
    /// `<= fidelity_tier_max.evidence_ceiling()`.
    pub evidence_tier_max: EvidenceTier,

    /// Free-form, audit-visible limitations. Forwarded into
    /// `RuntimeAdapterDescriptor::limitations` by the bridge in 4.5.
    pub limitations: &'static [&'static str],
}
```

`PortManifest::validate()` enforces:

- `id` matches `[a-z][a-z0-9-]*` (8..=64 bytes).
- `version` is a non-empty `MAJOR.MINOR.PATCH` triple.
- `abi_version` is one of the runner's supported values
  (`Runner::SUPPORTED_ABI_VERSIONS`).
- `required_methods` contains exactly the set declared by
  `EnginePort::REQUIRED_STAGES` — currently
  `[Launch, Observe, Capture, Shutdown]`.
- `optional_methods` is a subset of `EnginePort::OPTIONAL_STAGES` — currently
  `[Jump]`.
- `required_methods` and `optional_methods` are disjoint.
- Every `PortCapability` declared has a corresponding lifecycle method either
  in `required_methods` or `optional_methods` (e.g. declaring
  `PortCapability::Jump` without `Jump` in `optional_methods` is rejected).
- `evidence_tier_max <= fidelity_tier_max.evidence_ceiling()` reusing the
  existing `FidelityTier::evidence_ceiling` from `lib.rs`.
- `env_schema` passes `EnvFieldSchema::validate()` (section 3.3).

### 3.2 `PortCapability` and `LifecycleStage`

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PortCapability {
    /// Required: load and prepare for observation.
    Launch,
    /// Required: emit observation hook events.
    Observe,
    /// Required: produce artifact-store-backed capture evidence.
    Capture,
    /// Required: shut down deterministically and idempotently.
    Shutdown,
    /// Optional: jump to a moment id (UTSUSHI-104/106 will use this).
    Jump,
    /// Optional: snapshot/restore controlled playback state
    /// (UTSUSHI-023 will fill this in; ports may not declare it yet).
    Snapshot,
    /// Optional: deterministic input/clock replay (UTSUSHI-021).
    DeterministicReplay,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LifecycleStage {
    Launch,
    Observe,
    Capture,
    Jump,
    Shutdown,
}
```

The `Snapshot` and `DeterministicReplay` capabilities are reserved for
UTSUSHI-021/023 follow-up wiring. Defining them now keeps the enum stable;
the runner currently treats them as inert (no lifecycle method, no harness
check). Reserving the names is the cheapest forward compatibility move.

### 3.3 `EnvFieldSchema` — the audited environment surface

The runner reads environment variables only through a declared schema. This
is what enables `auditFocus[2] "Private environment leakage through
manifests"` enforcement.

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct EnvFieldSchema {
    /// Required: variable name as the port consumes it, e.g.
    /// `"UTSUSHI_BROWSER_BIN"`, `"UTSUSHI_REALLIVE_PROFILE"`. Must match
    /// `[A-Z][A-Z0-9_]{0,63}`.
    pub key: &'static str,

    /// Audit shape declaration; the runner validates the raw env value
    /// against this shape before exposing it to the port.
    pub shape: EnvFieldShape,

    /// Whether the field is required for `Launch` to succeed.
    pub required: bool,

    /// Short, audit-grade description (committed in the manifest).
    pub purpose: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EnvFieldShape {
    /// Boolean flag: "1"/"0", "true"/"false" (case-insensitive).
    Flag,
    /// Stable enum value the port declares as part of its schema doc.
    Enum,
    /// Opaque, non-secret token (UUID, content hash, public id).
    OpaqueToken,
    /// A path. This is REJECTED at validate-time. Paths must go through
    /// the VFS or `RuntimePortRequest::artifact_root`, never an env var.
    Path,
    /// Anything that `looks_like_local_path` would flag. REJECTED.
    LocalPath,
    /// Secrets, keys, tokens. REJECTED. Key material flows through the
    /// Kaifuu key/profile channel, not Utsushi env.
    Secret,
}
```

`EnvFieldSchema::validate()` rejects schemas whose `shape` is `Path`,
`LocalPath`, or `Secret`. The runner additionally checks the _value_ at
launch time and rejects any value that matches `looks_like_local_path()`
regardless of declared shape, returning
`EnginePortError::EnvUnredacted { key: &'static str, rule: &'static str }`.

The redaction filter delegates to the existing `looks_like_local_path` in
`utsushi-core`. UTSUSHI-103 makes that function `pub(crate)` -> `pub`
(its current visibility is `fn` private). This is additive.

### 3.4 Tier ceiling re-use

`PortManifest::fidelity_tier_max: FidelityTier` and
`evidence_tier_max: EvidenceTier` reuse the existing enums defined in
`utsushi-core/src/lib.rs` (`FidelityTier`, `EvidenceTier`). No new tier
enum is introduced.

## 4. Runner: `EnginePort` trait and `Runner` orchestrator

### 4.1 `EnginePort` trait

```rust
pub trait EnginePort: Send + Sync {
    /// Required: each port must declare its manifest. The manifest is a
    /// `const`, so reading it is free and audit-safe.
    const MANIFEST: PortManifest;

    /// Required stages every implementor MUST cover.
    const REQUIRED_STAGES: &'static [LifecycleStage] = &[
        LifecycleStage::Launch,
        LifecycleStage::Observe,
        LifecycleStage::Capture,
        LifecycleStage::Shutdown,
    ];

    /// Optional stages a port MAY declare in `MANIFEST.optional_methods`.
    const OPTIONAL_STAGES: &'static [LifecycleStage] = &[LifecycleStage::Jump];

    /// Required: launch the engine port and ready it for observation.
    /// Implementors must honour `request.cancellation`. The default
    /// behaviour for a cancelled launch is to return
    /// `EnginePortError::Cancelled { stage: LifecycleStage::Launch }`.
    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError>;

    /// Required: drain or stream observation hook events. The runner
    /// re-validates every emitted event through `ObservationHookEvent::
    /// validate()`. Implementors return `Ok(None)` to signal end-of-stream
    /// without an error.
    fn observe(&mut self, request: &PortRequest<'_>)
        -> Result<Option<ObservationHookEvent>, EnginePortError>;

    /// Required: produce a capture artifact through the managed runtime
    /// artifact store via `request.artifact_root`. Implementors must NOT
    /// write outside that root.
    fn capture(&mut self, request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError>;

    /// Optional: jump to a declared moment. Default implementation returns
    /// `CapabilityUnsupported` so ports that do not declare the
    /// capability get a typed diagnostic by default.
    fn jump(
        &mut self,
        _request: &PortRequest<'_>,
        _moment: &MomentId,
    ) -> Result<(), EnginePortError> {
        Err(EnginePortError::CapabilityUnsupported {
            capability: PortCapability::Jump,
            reason: CapabilityReason::DefaultUnimplemented,
        })
    }

    /// Required: idempotent shutdown. Calling `shutdown` twice on the
    /// same port must succeed with the same `PortShutdownOutcome::status`.
    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError>;
}
```

Key design choices:

- `MANIFEST` is an associated const because that is what the orchestrator
  audits before construction. Workers cannot ship a port whose runtime
  manifest disagrees with its compile-time const: there is only one.
- `&mut self` on lifecycle methods. Ports are stateful objects that own
  engine handles, decoders, observers. The trait does NOT require interior
  mutability — implementors choose. `Send + Sync` keeps the runner usable
  from spawned threads.
- `launch`, `observe`, `capture`, `shutdown` are required at the source
  level (no default impl that swallows them). A port that fails to
  implement them does not compile. This is the "no optionality on
  lifecycle" hard constraint enforced at the type system.
- `jump` has a default impl that returns `CapabilityUnsupported` with
  `CapabilityReason::DefaultUnimplemented`. The runner additionally checks
  the manifest declares `PortCapability::Jump`; if the port overrides
  `jump` but does not declare the capability, the conformance harness
  flags this drift as `EnginePortError::ManifestCapabilityDrift`.

### 4.2 `PortRequest`

```rust
#[derive(Clone)]
pub struct PortRequest<'a> {
    /// Input root (same shape as the legacy `RuntimeRequest::input_root`).
    pub input_root: &'a Path,

    /// Managed artifact root for capture output. Required when the port
    /// is asked to `capture`.
    pub artifact_root: Option<&'a RuntimeArtifactRoot>,

    /// Optional VFS handoff added by UTSUSHI-020. Ports that consume
    /// asset packages take it from here.
    pub vfs: Option<Arc<dyn RuntimeVfs>>,

    /// Cancellation token. Lifecycle methods must observe it at every
    /// reasonable yield point (UTSUSHI-103 documents the contract: at
    /// minimum at the top of `launch`, between observation events,
    /// before capture flush).
    pub cancellation: RunnerCancellation,

    /// Audited env values. The runner has already filtered every value
    /// through `looks_like_local_path` and the port's declared
    /// `EnvFieldSchema`. The port reads from this map, not from
    /// `std::env` directly.
    pub env: PortEnv,

    /// Run-id and operation passed to `RuntimeAdapterDescriptor`-shaped
    /// reporting. Set by the runner.
    pub run_id: &'a str,
    pub operation: RuntimeOperation,
}
```

### 4.3 `RunnerCancellation`

```rust
/// Cooperative cancellation token. Cheaply clonable; backed by
/// `Arc<AtomicBool>`. The runner sets `requested = true` on timeout,
/// hook failure, or explicit shutdown.
#[derive(Clone, Debug)]
pub struct RunnerCancellation { inner: Arc<AtomicBool> }

impl RunnerCancellation {
    pub fn new() -> Self;
    pub fn is_cancelled(&self) -> bool;
    pub fn cancel(&self);
    /// Helper: yield an error if cancellation is set. Called by ports
    /// inside long loops. Returns `Err(EnginePortError::Cancelled)`.
    pub fn check(&self, stage: LifecycleStage) -> Result<(), EnginePortError>;
}
```

Cancellation is required (`Acceptance criterion 1: cancellation`). The
harness verifies that a port respects mid-launch cancellation by setting
the token before driving the lifecycle and asserting
`EnginePortError::Cancelled { stage: Launch }`.

### 4.4 `Runner` orchestrator

```rust
pub struct Runner {
    /// ABI versions the runner accepts.
    abi_versions: &'static [u32],
}

impl Runner {
    pub const SUPPORTED_ABI_VERSIONS: &'static [u32] = &[1];

    pub fn new() -> Self;

    /// Validate the manifest against the runner's ABI policy. Called
    /// before any lifecycle method runs.
    pub fn validate_manifest(&self, manifest: &PortManifest)
        -> Result<(), EnginePortError>;

    /// Drive a port through a full Trace lifecycle:
    /// `validate_manifest -> launch -> drain observations -> shutdown`.
    /// Returns a `RunnerOutcome` whose `evidence` is a
    /// `RuntimeEvidenceReportV02` `Value` that the legacy
    /// `RuntimeAdapter::trace` bridge re-exposes.
    pub fn run_trace<P: EnginePort>(
        &self,
        port: &mut P,
        request: &PortRequest<'_>,
    ) -> Result<RunnerOutcome, EnginePortError>;

    /// Drive a port through Trace + Capture.
    pub fn run_capture<P: EnginePort>(
        &self,
        port: &mut P,
        request: &PortRequest<'_>,
    ) -> Result<RunnerOutcome, EnginePortError>;

    /// Drive a port through Capture again under the smoke_validate
    /// label. Mirrors the fixture adapter's current `smoke_validate ->
    /// capture` aliasing.
    pub fn run_smoke<P: EnginePort>(
        &self,
        port: &mut P,
        request: &PortRequest<'_>,
    ) -> Result<RunnerOutcome, EnginePortError>;
}
```

`RunnerOutcome` carries the observation hook events the runner collected
and validated, the capture artifact reference if any, the
`PortShutdownOutcome`, and a `RuntimeEvidenceReportV02`-shaped `Value` so
the existing `RuntimeAdapter`-based registry can keep returning the same
JSON shape.

The runner is responsible for:

- Validating the manifest (`validate_manifest`).
- Re-validating every emitted `ObservationHookEvent` (returns
  `ObservationInvalid { event_id, source }` on failure — never silently
  drops).
- Enforcing `RuntimeArtifactRoot` containment: captures use the root
  passed via `PortRequest`. If the port returns a `CaptureOutcome` whose
  artifact URI is outside the managed root, the runner returns
  `EnginePortError::ArtifactRootViolation`.
- Calling `shutdown` regardless of earlier errors (with-cleanup semantics).
- Bridging cancellation to ports: if a timeout is requested at the runner
  level, the runner sets the token and waits the configured grace before
  forcing through.

### 4.5 Bridging to the legacy `RuntimeAdapter` trait

The existing `pub trait RuntimeAdapter` in `lib.rs` exposes
`trace/capture/smoke_validate/discover_branches`. Engine ports that adopt
`EnginePort` should not also reimplement `RuntimeAdapter` by hand; the
`Runner` provides a bridge:

```rust
/// Adapter shim that lets an `EnginePort` participate in the legacy
/// `RuntimeAdapterRegistry`. Used by Slice B (fixture refactor) and by
/// every future engine port crate.
pub struct EnginePortAdapter<P: EnginePort> {
    port: std::sync::Mutex<P>,
    runner: Runner,
    descriptor: RuntimeAdapterDescriptor, // built from MANIFEST
}

impl<P: EnginePort + 'static> EnginePortAdapter<P> {
    pub fn new(port: P) -> Result<Self, EnginePortError>;
}

impl<P: EnginePort + 'static> RuntimeAdapter for EnginePortAdapter<P> {
    fn descriptor(&self) -> RuntimeAdapterDescriptor { /* from MANIFEST */ }
    fn trace(&self, req: &RuntimeRequest<'_>) -> UtsushiResult<Value> { /* runner.run_trace */ }
    fn capture(&self, req: &RuntimeRequest<'_>) -> UtsushiResult<Value> { /* runner.run_capture */ }
    fn smoke_validate(&self, req: &RuntimeRequest<'_>) -> UtsushiResult<Value> { /* runner.run_smoke */ }
    // discover_branches stays at the default error: not part of the
    // EnginePort surface and tracked in UTSUSHI-031 follow-ups.
}
```

Building `RuntimeAdapterDescriptor` from `PortManifest` is mechanical:

- `name = manifest.id`, `version = manifest.version`.
- `fidelity_tier = manifest.fidelity_tier_max`,
  `evidence_tier_ceiling = manifest.evidence_tier_max`.
- `capabilities` derived from `manifest.capabilities` via a small
  `PortCapability -> RuntimeCapability` map.
- `capability_contract` left as a port-supplied function:
  `PortManifest` is the audit surface, but `RuntimeCapabilityContract`
  carries per-feature richer narrative. Each port supplies it through
  `EnginePort::capability_contract() -> RuntimeCapabilityContract`
  (separate method on the trait so manifest stays `const`).
- `limitations = manifest.limitations.iter().map(|s| s.to_string()).collect()`.
- `approximation_tiers` supplied by `EnginePort::approximation_tiers()`.
- `diagnostics` supplied by `EnginePort::diagnostics()`.

This preserves auditFocus[1] "ABI drift between ports": every adapter that
adopts the template can be inspected through one manifest, and the
`EnginePortAdapter` shim guarantees its descriptor reflects the manifest.

## 5. ABI conformance harness

### 5.1 Public surface

```rust
pub mod conformance {
    /// Run the ABI conformance suite against an EnginePort instance.
    /// Returns an `AbiConformanceReport` describing every required-method
    /// outcome. Suitable for use in port crates' integration tests.
    pub fn run_required_abi<P>(
        port_factory: impl Fn() -> P,
        fixture: &ConformanceFixture,
    ) -> Result<AbiConformanceReport, EnginePortError>
    where
        P: EnginePort + 'static;

    /// Lower-level negative-case checks. Each rejects a deliberately bad
    /// manifest and returns the diagnostic so the harness can assert on
    /// it.
    pub fn check_manifest_rejects_missing_method(manifest: &PortManifest)
        -> Result<(), EnginePortError>;
    pub fn check_manifest_rejects_unsupported_abi_version(manifest: &PortManifest)
        -> Result<(), EnginePortError>;
    pub fn check_manifest_rejects_unredacted_env(manifest: &PortManifest)
        -> Result<(), EnginePortError>;
}
```

### 5.2 `ConformanceFixture`

A small `ConformanceFixture` declares the minimum inputs the harness
needs to exercise a port:

```rust
pub struct ConformanceFixture {
    pub input_root: PathBuf,        // tempdir staged with a tiny source
    pub artifact_root: RuntimeArtifactRoot,
    pub env: PortEnv,
    pub run_id: String,
}

impl ConformanceFixture {
    /// Built-in synthetic fixture (no host I/O beyond a tempdir) used
    /// by `utsushi-core`'s own conformance tests against the fixture
    /// port. Engine crates supply their own.
    pub fn synthetic_for_fixture_port() -> Self;
}
```

### 5.3 Positive lifecycle checks

The harness runs:

1. `Runner::validate_manifest(&P::MANIFEST)` — must succeed.
2. Build a fresh port via the factory.
3. `port.launch(&request)` — must succeed.
4. Drain `port.observe(&request)` until `Ok(None)` or N events (bounded);
   assert every event passes `ObservationHookEvent::validate()`.
5. `port.capture(&request)` — must succeed and the returned
   `CaptureOutcome::artifact_uri` must resolve under the artifact root.
6. `port.shutdown()` — must succeed.
7. Second `port.shutdown()` — must succeed with idempotent status.

Cancellation check (separate run):

8. Build a fresh port.
9. `request.cancellation.cancel()` before launch.
10. `port.launch(&request)` must return
    `Err(EnginePortError::Cancelled { stage: Launch })`.

`jump` capability declaration check:

11. If `MANIFEST.capabilities` contains `PortCapability::Jump`,
    `port.jump(&request, &MomentId::synthetic())` must NOT return
    `CapabilityUnsupported { reason: DefaultUnimplemented }`.
12. If `MANIFEST.capabilities` does NOT contain `PortCapability::Jump`,
    `port.jump(...)` MUST return
    `Err(EnginePortError::CapabilityUnsupported { capability: Jump, .. })`
    — typed, never a silent skip.

### 5.4 Negative manifest checks

Three synthetic ports the harness uses internally, all in
`crates/utsushi-core/src/port/conformance.rs` `#[cfg(test)]`:

- `MissingMethodPort` — declares `Jump` in `optional_methods` but the
  trait impl returns `CapabilityUnsupported::DefaultUnimplemented`. The
  conformance harness must reject this with
  `EnginePortError::ManifestCapabilityDrift`.
- `UnsupportedAbiPort` — declares `abi_version = 99`. Must be rejected
  by `Runner::validate_manifest` with
  `EnginePortError::AbiVersionUnsupported { declared: 99, supported: [1] }`.
- `UnredactedEnvPort` — declares an `EnvFieldSchema { shape: Path, .. }`
  in its `env_schema`. Must be rejected by `PortManifest::validate` with
  `EnginePortError::EnvSchemaForbidsPath`. A second variant supplies a
  passed-through value that matches `looks_like_local_path` at launch
  time and the runner must reject it with
  `EnginePortError::EnvUnredacted`.

### 5.5 Why this is a harness, not a `#[derive]` macro

A macro would push capability declarations into proc-macro tokens and
hide them from `cargo doc` / human review. The manifest is intentionally
a value the audit tooling can read at compile time without expansion.

## 6. Capability diagnostics

```rust
#[derive(Debug)]
pub enum EnginePortError {
    /// Manifest validation failure.
    ManifestInvalid { source: ManifestError },

    /// Manifest declares a capability the port does not have, or
    /// vice versa.
    ManifestCapabilityDrift { capability: PortCapability, kind: DriftKind },

    /// Manifest declared an ABI version the runner does not support.
    AbiVersionUnsupported { declared: u32, supported: &'static [u32] },

    /// Manifest declared an env field whose shape is forbidden
    /// (Path, LocalPath, Secret).
    EnvSchemaForbidsPath { key: &'static str, shape: EnvFieldShape },

    /// Runtime env value matched the local-path filter.
    EnvUnredacted { key: &'static str, rule: &'static str },

    /// Lifecycle was cancelled.
    Cancelled { stage: LifecycleStage },

    /// Port emitted an observation event that failed validation.
    ObservationInvalid { stage: LifecycleStage, source: Box<dyn std::error::Error + Send + Sync> },

    /// Port wrote a capture artifact outside the managed root.
    ArtifactRootViolation { artifact_uri: String },

    /// Capability declared as unsupported by the manifest or by the
    /// default trait impl.
    CapabilityUnsupported {
        capability: PortCapability,
        reason: CapabilityReason,
    },

    /// Required lifecycle method panicked or returned an opaque
    /// underlying error.
    Lifecycle {
        stage: LifecycleStage,
        message: String,
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    /// Shutdown was called twice and returned conflicting outcomes.
    ShutdownNotIdempotent { first: PortShutdownStatus, second: PortShutdownStatus },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriftKind {
    /// Manifest declares it but the trait does not implement it.
    DeclaredButUnimplemented,
    /// Trait implements it but the manifest does not declare it.
    UnclaimedImplementation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapabilityReason {
    /// The default trait impl was used (port has not implemented the
    /// optional method).
    DefaultUnimplemented,
    /// The port declared the capability as planned but the current
    /// build deliberately rejects calls (e.g. UTSUSHI-104 not landed).
    NotYetSupported,
    /// The host environment doesn't support it (e.g. browser absent).
    HostUnavailable,
}
```

`EnginePortError: std::error::Error + Send + Sync + 'static` and
implements `Display` for stable diagnostic text. Every `Display`
implementation is filtered through `reject_unredacted_local_paths` in a
debug-assert during tests so a regression that puts a host path into a
diagnostic fails CI.

## 7. Integration with existing crates

### 7.1 `utsushi-core` itself

- New module tree `utsushi_core::port` (section 2).
- `RuntimeRequest` gains two new additive `Option<...>` fields, planned to
  coordinate with UTSUSHI-021 and UTSUSHI-022:

```rust
pub struct RuntimeRequest<'a> {
    pub input_root: &'a Path,
    pub artifact_root: Option<&'a Path>,
    pub vfs: Option<Arc<dyn RuntimeVfs>>,                 // UTSUSHI-020 (merged)
    pub cancellation: Option<RunnerCancellation>,         // UTSUSHI-103 (this node)
    pub replay_log: Option<Arc<dyn ReplayLogHandle>>,     // UTSUSHI-021 (planned; placeholder trait
                                                          //   stub in utsushi-core::replay marked
                                                          //   `#[doc(hidden)]` so additive merges
                                                          //   from UTSUSHI-021 do not need to widen
                                                          //   the struct again)
    pub sinks: Option<Arc<dyn RuntimeSinks>>,             // UTSUSHI-022 (same placeholder pattern)
}
```

Decision: define the three trait stubs (`ReplayLogHandle`, `RuntimeSinks`)
as `pub` empty traits in `utsushi-core` under `#[doc(hidden)]` with a
TODO comment naming the owning node. This is the minimum that keeps the
`Option` fields typed and avoids `Box<dyn Any>` placeholders.

**Coordination note (per the assignment)**: if UTSUSHI-021 or UTSUSHI-022
merge their own additive field first, this plan accepts the merge and
drops the corresponding placeholder. The new struct shape composes
because every new field is `Option<...>`. The two placeholder stubs are
the only forward references this plan adds; they are documented as
provisional in their module docstring.

- `Runner` calls `request.cancellation.clone().unwrap_or_default()` when
  building a `PortRequest`, so adapters built before cancellation lands
  see a never-cancelling token.

### 7.2 `utsushi-fixture` (Slice B)

Slice B is a separate PR that:

- Implements `EnginePort` on a new `FixtureEnginePort` struct that owns
  the loaded source JSON (replacing the per-call `read_source` pattern).
- Declares `const MANIFEST: PortManifest = ...` with:
  - `required_methods = [Launch, Observe, Capture, Shutdown]`,
  - `optional_methods = []` (jump deliberately not declared until the
    fixture has a jump moment plan in UTSUSHI-104),
  - `capabilities = [Launch, Observe, Capture, Shutdown]`,
  - `env_schema = []` (the fixture reads no env directly today),
  - `abi_version = 1`,
  - `fidelity_tier_max = LayoutProbe`, `evidence_tier_max = E2`,
  - `limitations` copied from the current adapter limitations.
- Keeps the public `FixtureRuntimeAdapter` type as an `EnginePortAdapter<
FixtureEnginePort>` so `crates/utsushi-cli/src/main.rs::runtime_registry`
  continues to compile unchanged.
- Runs `utsushi_core::port::conformance::run_required_abi(...)` in a
  fixture integration test (`crates/utsushi-fixture/tests/abi_conformance.rs`).
  This satisfies acceptance criterion 1.

The `launch_adapters.rs` types (`BrowserLaunchAdapter`,
`NwjsLaunchAdapter`) are NOT refactored in Slice B. They live above
`RuntimeAdapter` rather than `EnginePort` because they are launch-host
shims, not engine ports. Per `subprojects-utsushi.md`, launch wrappers
remain useful as developer-time aids and continue to use the legacy
trait. A follow-up node (out of scope) can decide whether to migrate them.

### 7.3 `utsushi-cli`

No change. The cli imports `FixtureRuntimeAdapter` (and the launch
adapters) through `utsushi-fixture`'s public surface; Slice B preserves
that surface.

### 7.4 Engine-port crates (future)

`utsushi-rpgmaker-mv`, `utsushi-kirikiri-kag`, `utsushi-siglus`,
`utsushi-reallive`: each defines `pub struct FooEnginePort` +
`impl EnginePort for FooEnginePort` + `const MANIFEST: PortManifest`
and wires its own conformance test through
`utsushi_core::port::conformance::run_required_abi`. UTSUSHI-103 ships
no code for these crates.

## 8. Test plan

All tests follow `docs/testing-standard.md`. Each test has a behavior
name and asserts one observable claim.

### 8.1 Unit (in `utsushi-core::port::*` modules)

Manifest validation (in `port/manifest.rs` `#[cfg(test)] mod tests`):

- `validate_accepts_well_formed_manifest()`.
- `validate_rejects_id_with_uppercase()`.
- `validate_rejects_required_methods_missing_launch()`.
- `validate_rejects_required_methods_missing_observe()`.
- `validate_rejects_required_methods_missing_capture()`.
- `validate_rejects_required_methods_missing_shutdown()`.
- `validate_rejects_optional_method_outside_known_set()`.
- `validate_rejects_capability_without_matching_lifecycle_method()`.
- `validate_rejects_evidence_tier_above_fidelity_ceiling()`.
- `validate_rejects_env_schema_with_path_shape()`.
- `validate_rejects_env_schema_with_local_path_shape()`.
- `validate_rejects_env_schema_with_secret_shape()`.
- `validate_rejects_abi_version_outside_runner_support()`.

Cancellation (in `port/runner.rs`):

- `runner_cancellation_check_returns_cancelled_for_stage()`.
- `runner_cancellation_default_token_never_signals()`.

Diagnostics (in `port/diagnostics.rs`):

- `engine_port_error_display_passes_local_path_filter()`.
- `capability_unsupported_carries_capability_and_reason()`.
- `env_unredacted_carries_field_key_and_rule()`.

### 8.2 ABI conformance (in `crates/utsushi-core/tests/engine_port.rs`)

This is the test file that `cargo test -p utsushi-core engine_port`
(from the DAG verification) runs against. It exercises the harness
against three synthetic ports defined inside the test crate.

Positive port (`SyntheticReferencePort`) — implements all required
stages correctly, declares `[Launch, Observe, Capture, Shutdown]` in
capabilities:

- `synthetic_port_passes_required_abi_conformance()` — runs
  `run_required_abi` and asserts the report's `result == Pass`.
- `synthetic_port_launch_observes_cancellation_token()` — sets the
  cancel flag pre-launch, asserts
  `EnginePortError::Cancelled { stage: Launch }`.
- `synthetic_port_capture_writes_into_managed_artifact_root()` —
  asserts the returned artifact uri resolves to a path under the
  test's `RuntimeArtifactRoot`.
- `synthetic_port_shutdown_is_idempotent()` — calls `shutdown` twice
  and asserts both return the same status.
- `synthetic_port_jump_returns_capability_unsupported_when_not_declared()`
  — asserts `EnginePortError::CapabilityUnsupported { capability: Jump, ..  }`.

Missing-method port (`MissingObservePort`) — its impl returns
`CapabilityUnsupported::DefaultUnimplemented` for `observe`:

- `port_with_unimplemented_observe_fails_conformance_with_drift_diagnostic()`.

Version-mismatch port (`UnsupportedAbiPort`):

- `port_with_unsupported_abi_version_fails_runner_validate_manifest()`.

Env-leak port (`UnredactedEnvPort`):

- `port_with_path_shape_env_schema_fails_manifest_validate()`.
- `port_with_runtime_env_value_matching_local_path_filter_fails_launch()`.

`jump`-capable port (`SyntheticJumpPort`):

- `port_declaring_jump_capability_runs_jump_against_synthetic_moment()`.
- `port_overriding_jump_without_declaring_capability_fails_drift_check()`.

Bridge to legacy `RuntimeAdapter`:

- `engine_port_adapter_descriptor_reflects_manifest_id_and_version()`.
- `engine_port_adapter_trace_runs_lifecycle_and_returns_runtime_evidence_report_v02()`.

### 8.3 Fixture-side test (in Slice B,

`crates/utsushi-fixture/tests/abi_conformance.rs`)

- `fixture_engine_port_passes_required_abi_conformance()` — runs the
  harness against `FixtureEnginePort`.
- `fixture_engine_port_jump_returns_capability_unsupported()` — fixture
  does not declare jump, so jump must be the typed diagnostic.
- `fixture_runtime_adapter_descriptor_round_trips_through_manifest()` —
  asserts the existing descriptor fields (name, version, fidelity tier,
  evidence ceiling) match what the manifest declares.

### 8.4 Redaction / leak regression

- `engine_port_error_for_unredacted_env_path_does_not_include_path_in_display()`
  — constructs a real tempdir path, sets it as the env value, asserts
  the `Display` of the resulting error does not include the path.
- `runtime_request_debug_does_not_leak_cancellation_or_replay_log()` —
  same shape as the existing `RuntimeRequest::fmt` Debug impl test.

### 8.5 No `compile_fail` doctests

Following the precedent set by UTSUSHI-020 plan (section 8.1 trade-off
note), avoid `trybuild` / `compile_fail` until policy is settled. The
"required methods are enforced by the type system" claim is asserted
through the conformance harness's drift detector instead.

## 9. Verification commands

Per the DAG node (`UTSUSHI-103.verification`):

```
cargo test -p utsushi-core engine_port
node scripts/spec-dag.mjs validate
```

Recommended additional local commands (consistent with the rest of the
roadmap):

```
cargo test -p utsushi-core            # full crate-level smoke
cargo test -p utsushi-fixture         # Slice B
just check                            # workspace gate
```

`just schema` is NOT required: UTSUSHI-103 does not introduce new
runtime-report semantic codes; the `EnginePortError` codes are
internal-to-runner diagnostics and surface through the existing
`RuntimeAdapterDiagnostic` channel.

## 10. Risks and unknowns

### 10.1 Interaction with UTSUSHI-021 / UTSUSHI-022

`RuntimeRequest` extension: see section 7.1. Plan accepts any merge
order via additive `Option<...>` fields. The risk is that 021 or 022
defines a different field name for what UTSUSHI-103 calls
`replay_log` or `sinks`; this plan does not block on that. The
worker implementing Slice A should rename if 021/022 land first.

### 10.2 ABI version bumping strategy

`Runner::SUPPORTED_ABI_VERSIONS = &[1]` is the initial value. Future
breaking changes (e.g. `EnginePort` gains a new required method) bump
the constant to `&[1, 2]` while existing ports declare `abi_version =
1`. Removing version 1 from the supported list is a deliberate
deprecation gate; this plan documents the policy but does not add
deprecation tooling.

Decision: avoid SemVer-flavoured tuples (`u16.u16`). A single `u32` is
inspectable and ordinal. Compatibility checks are exact membership,
not range comparison, so old ports do not silently keep working when
they should be deprecated.

### 10.3 Capability set evolution

`PortCapability` reserves `Snapshot` and `DeterministicReplay` for
UTSUSHI-023 and UTSUSHI-021 respectively. Reserving names now keeps
the enum from being an audit-visible breaking-change vector later. A
future capability addition is a new variant; consumers that match
exhaustively over `PortCapability` will get a warning rather than a
silent mismatch.

### 10.4 `Box<dyn EnginePort>` vs generic `Runner`

Decision: `Runner` is generic over `<P: EnginePort>` rather than taking
`&mut dyn EnginePort`. Reason: associated `const MANIFEST` cannot be
read through a `dyn` reference. The conformance harness uses
`port_factory: impl Fn() -> P` for the same reason. The
`EnginePortAdapter` bridge stores `Mutex<P>` rather than
`Box<dyn EnginePort>` for the same reason.

Trade-off: a heterogeneous registry of engine ports requires the
adapter-shim layer (`EnginePortAdapter`) to hide the generic. That is
acceptable because the CLI registry is keyed on adapter id strings, not
on the trait object itself, and the shim already exists.

### 10.5 Bridge to existing `RuntimeAdapter::discover_branches`

`discover_branches` is not part of `EnginePort`. Branch discovery is
the domain of UTSUSHI-106 (frontier scheduler), driven from the
observation stream. The shim's default `discover_branches` returns the
existing `unsupported_operation` error. This is consistent with the
fixture adapter today (it declares branch discovery as unsupported in
its capability contract).

### 10.6 `observe` as a draining model

`observe` returns `Option<ObservationHookEvent>` (`Ok(None)` ends the
stream). An alternative was a callback-on-event closure, but a drain
model is simpler for the harness (no callback lifetimes) and ports can
internally buffer events. Streams (futures) are out of scope until any
async port emerges (none currently planned).

### 10.7 Forward-additive `ReplayLogHandle` / `RuntimeSinks` placeholders

Risk: leaving placeholder traits in `utsushi-core` invites bit-rot if
021/022 take a long time. Mitigation: each placeholder trait is empty
(no methods) and its module is `#[doc(hidden)]` with a TODO comment
naming the owner node and review date. The worker implementing
UTSUSHI-021/022 owns deleting the placeholder.

## 11. Out of scope

The following are explicitly NOT done in this node:

- Actual engine ports (`utsushi-rpgmaker-mv`, `utsushi-kirikiri-kag`,
  `utsushi-siglus`, `utsushi-reallive`): UTSUSHI-031..039 and
  UTSUSHI-146 own those.
- Cross-engine moment index and jump planner: UTSUSHI-104.
- Branch frontier traversal scheduler: UTSUSHI-106.
- Conformance schema (runtime evidence report v0.3 or v0.3 codes):
  UTSUSHI-026 owns schema-level conformance signal. UTSUSHI-103 only
  produces conformance-test pass/fail at the crate-test level.
- Deterministic input/clock + replay log: UTSUSHI-021 (placeholder
  field only; trait stub `#[doc(hidden)]`).
- Headless render/audio sinks: UTSUSHI-022 (same placeholder pattern).
- Snapshot primitives: UTSUSHI-023 (capability reserved in the enum;
  no lifecycle method).
- Substrate facade re-exports: UTSUSHI-120 (consumes this node's
  public surface as one of many re-exports).
- Migration of `BrowserLaunchAdapter` and `NwjsLaunchAdapter` to the
  template: explicitly deferred. They are launch hosts, not engine
  ports; a separate node can decide whether to refactor them.
- `RuntimeAdapter::discover_branches` integration: the bridge returns
  the existing unsupported error.
- `compile_fail` doc tests: drift detection lives in the conformance
  harness rather than the type system, consistent with the precedent
  set by UTSUSHI-020.

## 12. Implementation worker scoping

Recommendation: **two implementation slices**, mirroring UTSUSHI-020's
pattern (substrate, then fixture adoption).

### Slice A — substrate (`UTSUSHI-103a-substrate`)

Single PR; owns the template substrate:

- `utsushi_core::port::{manifest, trait_, runner, diagnostics,
conformance}` modules.
- Additive `RuntimeRequest` fields (`cancellation`, `replay_log`,
  `sinks`) plus the two `#[doc(hidden)]` trait stubs.
- `EnginePortAdapter<P>` bridge in `utsushi_core::port::runner`.
- `PortCapability`, `LifecycleStage`, `EnvFieldSchema`, `PortManifest`,
  `EnginePort` trait, `Runner`, `RunnerCancellation`,
  `EnginePortError`, full re-exports from `lib.rs`.
- ABI conformance harness in `port::conformance` (covered by
  `cfg(any(test, feature = "port-conformance"))` so engine crates opt
  in via dev-deps).
- Integration test
  `crates/utsushi-core/tests/engine_port.rs` covering every behavior
  test in 8.2 (against synthetic ports defined inside the test crate;
  no `utsushi-fixture` dependency).
- Make `looks_like_local_path` `pub` (additive visibility widening).

Verification: `cargo test -p utsushi-core`, `cargo test -p utsushi-core
engine_port`, `cargo test -p utsushi-fixture` (must still pass with
zero behavior change because the fixture has not adopted the template
yet), `node scripts/spec-dag.mjs validate`, `just check`.

Estimated worker time: medium-large. Largest cost is the conformance
harness (drift detection, env-redaction enforcement, idempotent-shutdown
verification) and writing the synthetic ports inside the test crate.

### Slice B — fixture adoption (`UTSUSHI-103b-fixture-adoption`)

Separate, smaller PR after Slice A merges:

- New `FixtureEnginePort` struct in `crates/utsushi-fixture/src/lib.rs`
  with a `pub const MANIFEST: PortManifest`.
- Refactor `FixtureRuntimeAdapter` to be a thin alias for
  `EnginePortAdapter<FixtureEnginePort>` (public type still named
  `FixtureRuntimeAdapter` so the cli registry compiles unchanged).
- New integration test `crates/utsushi-fixture/tests/abi_conformance.rs`
  running `run_required_abi` against the fixture port.
- Keep `launch_adapters.rs` and `reference_corpus.rs` untouched.

Verification: `cargo test -p utsushi-fixture`, `cargo test -p
utsushi-cli` (no change), `just check`.

Estimated worker time: small. Mechanical refactor + one new test file.

Separating these keeps Slice A reviewable as substrate (no behavioral
change to fixture output) and Slice B reviewable as a regression-free
adoption.

## Plan ends here.
