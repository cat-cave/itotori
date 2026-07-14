//! Runner: validates the manifest, drives the lifecycle, plumbs
//! cancellation, enforces artifact-root containment, and re-validates
//! every emitted observation event.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::RuntimeArtifactRoot;
use crate::sink::{AudioEvent, FrameArtifact, TextLine};

use super::diagnostics::{EnginePortError, PortShutdownOutcome};
use super::manifest::{LifecycleStage, PortCapability, PortManifest};
use super::trait_::{CaptureOutcome, EnginePort, MomentId, PortRequest};

/// Cooperative cancellation token. Cheaply clonable; backed by
/// `Arc<AtomicBool>`. The runner sets `requested = true` on timeout
/// hook failure, or explicit shutdown.
#[derive(Clone, Debug, Default)]
pub struct RunnerCancellation {
    inner: Arc<AtomicBool>,
}

impl RunnerCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.load(Ordering::SeqCst)
    }

    pub fn cancel(&self) {
        self.inner.store(true, Ordering::SeqCst);
    }

    /// Yield an error if cancellation is set. Ports call this inside long
    /// loops. Returns `Err(EnginePortError::Cancelled { stage })` when
    /// cancelled.
    pub fn check(&self, stage: LifecycleStage) -> Result<(), EnginePortError> {
        if self.is_cancelled() {
            Err(EnginePortError::Cancelled { stage })
        } else {
            Ok(())
        }
    }
}

/// Maximum number of observation ticks the runner drives per lifecycle
/// run. Hard cap so a misbehaving port cannot run the runner forever. A
/// tick is one call to `EnginePort::observe` followed by the per-tick
/// sink drain (text, then frame, then audio).
const RUNNER_OBSERVATION_TICK_CAP: usize = 4096;

/// One tick of validated sink emissions the runner has collected from a
/// port. Carries every payload the runner drained from the [`crate::sink::SinkSet`]
/// after a single call to [`EnginePort::observe`].
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct RunnerObservation {
    /// Text emissions drained in this tick (first, per the documented
    /// ordering invariant on [`Runner::tick`]).
    pub text: Vec<TextLine>,
    /// Frame emissions drained in this tick (second).
    pub frames: Vec<FrameArtifact>,
    /// Audio emissions drained in this tick (third).
    pub audio: Vec<AudioEvent>,
}

impl RunnerObservation {
    /// Total number of payloads collected across the three sinks. Used by
    /// the conformance harness `observation_count` and by tests that need
    /// a single end-of-stream cardinal.
    pub fn total(&self) -> usize {
        self.text.len() + self.frames.len() + self.audio.len()
    }

    /// True iff no sink yielded a payload for this tick. The runner uses
    /// this as the end-of-stream signal: a tick whose drains are all
    /// empty and whose `observe` returned `Ok(())` completes the
    /// observation phase.
    pub fn is_empty(&self) -> bool {
        self.text.is_empty() && self.frames.is_empty() && self.audio.is_empty()
    }
}

/// Aggregate result of a `Runner::run_*` call.
#[derive(Debug)]
pub struct RunnerOutcome {
    pub manifest_id: &'static str,
    pub manifest_version: &'static str,
    pub observations: Vec<RunnerObservation>,
    pub capture: Option<CaptureOutcome>,
    pub shutdown: PortShutdownOutcome,
}

/// Validates a port manifest and drives lifecycle methods. Generic over
/// the port type because `EnginePort::MANIFEST` is an associated const
/// and cannot be read through a `dyn EnginePort` reference.
#[derive(Clone, Debug)]
pub struct Runner {
    abi_versions: &'static [u32],
}

impl Runner {
    pub const SUPPORTED_ABI_VERSIONS: &'static [u32] = &[1];

    pub fn new() -> Self {
        Self {
            abi_versions: Self::SUPPORTED_ABI_VERSIONS,
        }
    }

    pub fn supported_abi_versions(&self) -> &'static [u32] {
        self.abi_versions
    }

    /// Validate a port manifest against the runner's ABI policy. Calls
    /// `PortManifest::validate` for structural rules, then layers in the
    /// runner-level checks (currently only ABI version membership).
    pub fn validate_manifest(&self, manifest: &PortManifest) -> Result<(), EnginePortError> {
        manifest.validate()?;
        if !self.abi_versions.contains(&manifest.abi_version) {
            return Err(EnginePortError::AbiVersionUnsupported {
                declared: manifest.abi_version,
                supported: self.abi_versions,
            });
        }
        Ok(())
    }

    /// Drive a port through a full Trace lifecycle: validate manifest
    /// launch, drain observations, shutdown.
    pub fn run_trace<P: EnginePort>(
        &self,
        port: &mut P,
        request: &PortRequest<'_>,
    ) -> Result<RunnerOutcome, EnginePortError> {
        self.run_lifecycle(port, request, /*capture =*/ false)
    }

    /// Drive a port through Trace + Capture.
    pub fn run_capture<P: EnginePort>(
        &self,
        port: &mut P,
        request: &PortRequest<'_>,
    ) -> Result<RunnerOutcome, EnginePortError> {
        self.run_lifecycle(port, request, /*capture =*/ true)
    }

    /// Drive a port through Capture under the smoke-validate label.
    pub fn run_smoke<P: EnginePort>(
        &self,
        port: &mut P,
        request: &PortRequest<'_>,
    ) -> Result<RunnerOutcome, EnginePortError> {
        self.run_lifecycle(port, request, /*capture =*/ true)
    }

    /// Drive a port through the replay-review observation lifecycle. Replay
    /// review is a port-driven capability, but execution still uses the same
    /// validated launch/observe/shutdown path as trace; the operation on
    /// `PortRequest` lets the port select its review evidence.
    pub fn run_replay_review<P: EnginePort>(
        &self,
        port: &mut P,
        request: &PortRequest<'_>,
    ) -> Result<RunnerOutcome, EnginePortError> {
        self.run_lifecycle(port, request, /*capture =*/ false)
    }

    /// Drive a port through `jump` to the given moment. Validates
    /// capability declaration before invoking the trait method.
    pub fn run_jump<P: EnginePort>(
        &self,
        port: &mut P,
        request: &PortRequest<'_>,
        moment: &MomentId,
    ) -> Result<(), EnginePortError> {
        self.validate_manifest(&P::MANIFEST)?;
        if !P::MANIFEST.capabilities.contains(&PortCapability::Jump) {
            return Err(EnginePortError::CapabilityUnsupported {
                capability: PortCapability::Jump,
                reason: super::diagnostics::CapabilityReason::NotYetSupported,
            });
        }
        request.cancellation.check(LifecycleStage::Jump)?;
        port.jump(request, moment)
    }

    fn run_lifecycle<P: EnginePort>(
        &self,
        port: &mut P,
        request: &PortRequest<'_>,
        capture: bool,
    ) -> Result<RunnerOutcome, EnginePortError> {
        self.validate_manifest(&P::MANIFEST)?;

        // Outer execution: ensure shutdown is invoked even on a mid-run
        // failure, then promote whichever error landed first.
        let primary = self.execute_with_artifact_root(port, request, capture, &P::MANIFEST);
        let shutdown_result = port.shutdown();

        match (primary, shutdown_result) {
            (Ok((observations, capture_outcome)), Ok(shutdown)) => Ok(RunnerOutcome {
                manifest_id: P::MANIFEST.id,
                manifest_version: P::MANIFEST.version,
                observations,
                capture: capture_outcome,
                shutdown,
            }),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn execute_with_artifact_root<P: EnginePort>(
        &self,
        port: &mut P,
        request: &PortRequest<'_>,
        capture: bool,
        manifest: &PortManifest,
    ) -> Result<(Vec<RunnerObservation>, Option<CaptureOutcome>), EnginePortError> {
        // Validate env values up-front per the manifest schema.
        for schema in manifest.env_schema {
            if let Some(value) = request.env.get(schema.key) {
                schema.validate_value(value)?;
            } else if schema.required {
                return Err(EnginePortError::EnvUnredacted {
                    key: schema.key,
                    rule: "required_env_missing",
                });
            }
        }

        request.cancellation.check(LifecycleStage::Launch)?;
        port.launch(request)?;

        let observations = self.drain_observations(port, request)?;

        let capture_outcome = if capture {
            request.cancellation.check(LifecycleStage::Capture)?;
            // Containment is mandatory: a capture run with no managed
            // artifact root cannot have its artifact path validated, so
            // reject up front rather than letting an unvalidated
            // CaptureOutcome flow into the report.
            let Some(root) = request.artifact_root else {
                return Err(EnginePortError::ArtifactRootMissing {
                    stage: LifecycleStage::Capture,
                });
            };
            let outcome = port.capture(request)?;
            ensure_capture_within_root(root, &outcome)?;
            Some(outcome)
        } else {
            None
        };

        Ok((observations, capture_outcome))
    }

    /// Drive a single observation tick against `port`.
    ///
    /// # Ordering invariant
    ///
    /// `tick` enforces a strict per-tick call order that downstream
    /// conformance and replay rely on:
    ///
    /// 1. `engine.observe(request)` is called **first**. The port pushes
    ///    any observed text / frame / audio payloads into its
    ///    [`crate::sink::SinkSet`] during this call.
    /// 2. The runner drains `sink_set().drain_text()` **second**.
    /// 3. The runner drains `sink_set().drain_frame()` **third**.
    /// 4. The runner drains `sink_set().drain_audio()` **fourth**.
    ///
    /// Each drained payload is re-validated through its per-sink
    /// validator (text/frame/audio) before being attached to the
    /// returned [`RunnerObservation`]. The ordering is the contract the
    /// behaviour test
    /// `runner_tick_drains_sinks_in_text_then_frame_then_audio_order`
    /// pins.
    ///
    /// Returns `Ok(RunnerObservation::default())` (i.e. an empty tick)
    /// when no sink yielded a payload. A single empty tick completes the
    /// observation phase: the runner's `drain_observations` loop stops on
    /// the first empty tick, matching [`RunnerObservation::is_empty`] and
    /// [`EnginePort::observe`].
    pub fn tick<P: EnginePort>(
        &self,
        port: &mut P,
        request: &PortRequest<'_>,
    ) -> Result<RunnerObservation, EnginePortError> {
        request.cancellation.check(LifecycleStage::Observe)?;
        // Step 1: drive observe().
        port.observe(request)?;

        let sinks = port.sink_set();

        // Step 2: drain text.
        let text = sinks.drain_text();
        for line in &text {
            line.validate()
                .map_err(|error| EnginePortError::ObservationInvalid {
                    stage: LifecycleStage::Observe,
                    source: sink_error_into_send_sync(error),
                })?;
        }

        // Step 3: drain frame.
        let frames = sinks.drain_frame();
        for frame in &frames {
            frame
                .validate()
                .map_err(|error| EnginePortError::ObservationInvalid {
                    stage: LifecycleStage::Observe,
                    source: sink_error_into_send_sync(error),
                })?;
        }

        // Step 4: drain audio.
        let audio = sinks.drain_audio();
        for event in &audio {
            event
                .validate()
                .map_err(|error| EnginePortError::ObservationInvalid {
                    stage: LifecycleStage::Observe,
                    source: sink_error_into_send_sync(error),
                })?;
        }

        Ok(RunnerObservation {
            text,
            frames,
            audio,
        })
    }

    fn drain_observations<P: EnginePort>(
        &self,
        port: &mut P,
        request: &PortRequest<'_>,
    ) -> Result<Vec<RunnerObservation>, EnginePortError> {
        let mut collected = Vec::new();
        for _ in 0..RUNNER_OBSERVATION_TICK_CAP {
            let observation = self.tick(port, request)?;
            if observation.is_empty() {
                return Ok(collected);
            }
            collected.push(observation);
        }
        Err(EnginePortError::Lifecycle {
            stage: LifecycleStage::Observe,
            message: format!(
                "observation tick loop exceeded cap {RUNNER_OBSERVATION_TICK_CAP}; port must stop emitting"
            ),
            source: None,
        })
    }
}

impl Default for Runner {
    fn default() -> Self {
        Self::new()
    }
}

fn ensure_capture_within_root(
    root: &RuntimeArtifactRoot,
    outcome: &CaptureOutcome,
) -> Result<(), EnginePortError> {
    // The managed URI form is the audit surface. Resolve it: if the URI
    // does not resolve, that itself is a violation.
    root.artifact_path(&outcome.artifact_uri).map_err(|_| {
        EnginePortError::ArtifactRootViolation {
            artifact_uri: outcome.artifact_uri.clone(),
        }
    })?;
    if let Some(path) = outcome.artifact_path.as_deref() {
        let violation = || EnginePortError::ArtifactRootViolation {
            artifact_uri: outcome.artifact_uri.clone(),
        };
        // A capture artifact that cannot be canonicalized (non-existent
        // broken symlink,...) cannot be proven to live under the managed
        // root. Treat the canonicalize failure itself as a containment
        // violation rather than falling back to the unresolved path, which
        // would let a missing/symlinked artifact defeat the starts_with
        // guard below.
        let root_path = root.path();
        let canonical_root = std::fs::canonicalize(root_path).map_err(|_| violation())?;
        let canonical_artifact = std::fs::canonicalize(path).map_err(|_| violation())?;
        if !canonical_artifact.starts_with(&canonical_root) {
            return Err(violation());
        }
    }
    Ok(())
}

fn sink_error_into_send_sync(
    error: crate::sink::SinkError,
) -> Box<dyn std::error::Error + Send + Sync> {
    // Boxed on purpose: the target is `EnginePortError::ObservationInvalid.source`
    // the enum's opaque `Send + Sync` error carrier. `SinkError` already
    // implements Display via its stable semantic code surface; re-stringify for
    // the runner's diagnostic carrier.
    Box::<dyn std::error::Error + Send + Sync>::from(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_cancellation_check_returns_cancelled_for_stage() {
        let token = RunnerCancellation::new();
        token.cancel();
        let error = token
            .check(LifecycleStage::Launch)
            .expect_err("cancelled token must return Cancelled");
        match error {
            EnginePortError::Cancelled { stage } => assert_eq!(stage, LifecycleStage::Launch),
            other => panic!("expected Cancelled, got {other:?}"),
        }
    }

    #[test]
    fn runner_cancellation_default_token_never_signals() {
        let token = RunnerCancellation::new();
        assert!(!token.is_cancelled());
        token
            .check(LifecycleStage::Observe)
            .expect("default token does not signal cancel");
    }

    #[test]
    fn runner_supports_abi_version_one() {
        let runner = Runner::new();
        assert_eq!(runner.supported_abi_versions(), &[1]);
    }

    const SAMPLE_ARTIFACT_URI: &str =
        "artifacts/utsushi/runtime/smoke-run-0001/screenshots/shot-00.png";

    #[test]
    fn ensure_capture_within_root_accepts_existing_artifact_under_root() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = RuntimeArtifactRoot::new(temp.path().to_path_buf());
        root.prepare().expect("prepare managed root");
        let path = root
            .write_bytes(SAMPLE_ARTIFACT_URI, b"frame-bytes")
            .expect("materialise artifact under root");
        let outcome = CaptureOutcome::new(SAMPLE_ARTIFACT_URI).with_path(path);

        ensure_capture_within_root(&root, &outcome)
            .expect("artifact materialised under the managed root is contained");
    }

    #[test]
    fn ensure_capture_within_root_rejects_unresolvable_artifact_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = RuntimeArtifactRoot::new(temp.path().to_path_buf());
        root.prepare().expect("prepare managed root");
        // A valid managed URI (string-level) but a path that does not exist
        // on disk: canonicalize fails, which must surface as a containment
        // violation rather than falling back to the unresolved path.
        let outcome = CaptureOutcome::new(SAMPLE_ARTIFACT_URI)
            .with_path(temp.path().join("smoke-run-0001/screenshots/shot-00.png"));

        let error = ensure_capture_within_root(&root, &outcome)
            .expect_err("non-existent artifact path must be a violation");
        match error {
            EnginePortError::ArtifactRootViolation { artifact_uri } => {
                assert_eq!(artifact_uri, SAMPLE_ARTIFACT_URI);
            }
            other => panic!("expected ArtifactRootViolation, got {other:?}"),
        }
    }

    #[test]
    fn ensure_capture_within_root_rejects_artifact_materialised_outside_root() {
        let temp = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("outside tempdir");
        let root = RuntimeArtifactRoot::new(temp.path().to_path_buf());
        root.prepare().expect("prepare managed root");
        // A real file that lives OUTSIDE the managed root: canonicalize
        // succeeds, but the starts_with(root) containment check fails.
        let outside_path = outside.path().join("escaped.png");
        std::fs::write(&outside_path, b"frame-bytes").expect("write outside artifact");
        let outcome = CaptureOutcome::new(SAMPLE_ARTIFACT_URI).with_path(outside_path);

        let error = ensure_capture_within_root(&root, &outcome)
            .expect_err("artifact outside the managed root must be a violation");
        assert!(matches!(
            error,
            EnginePortError::ArtifactRootViolation { .. }
        ));
    }
}
