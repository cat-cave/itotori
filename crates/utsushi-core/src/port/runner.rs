//! Runner: validates the manifest, drives the lifecycle, plumbs
//! cancellation, enforces artifact-root containment, and re-validates
//! every emitted observation event.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::{ObservationHookEvent, RuntimeArtifactRoot};

use super::diagnostics::{EnginePortError, PortShutdownOutcome};
use super::manifest::{LifecycleStage, PortCapability, PortManifest};
use super::trait_::{CaptureOutcome, EnginePort, MomentId, PortRequest};

/// Cooperative cancellation token. Cheaply clonable; backed by
/// `Arc<AtomicBool>`. The runner sets `requested = true` on timeout,
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

/// Maximum number of observation events the runner drains per lifecycle
/// run. Hard cap so a misbehaving port cannot run the runner forever.
const RUNNER_OBSERVATION_DRAIN_CAP: usize = 4096;

/// Single observation event the runner has validated and collected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunnerObservation {
    pub event: ObservationHookEvent,
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

    /// Drive a port through a full Trace lifecycle: validate manifest,
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
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
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
            let outcome = port.capture(request)?;
            if let Some(root) = request.artifact_root {
                ensure_capture_within_root(root, &outcome)?;
            }
            Some(outcome)
        } else {
            None
        };

        Ok((observations, capture_outcome))
    }

    fn drain_observations<P: EnginePort>(
        &self,
        port: &mut P,
        request: &PortRequest<'_>,
    ) -> Result<Vec<RunnerObservation>, EnginePortError> {
        let mut collected = Vec::new();
        for _ in 0..RUNNER_OBSERVATION_DRAIN_CAP {
            request.cancellation.check(LifecycleStage::Observe)?;
            match port.observe(request)? {
                Some(event) => {
                    event
                        .validate()
                        .map_err(|error| EnginePortError::ObservationInvalid {
                            stage: LifecycleStage::Observe,
                            source: error_into_send_sync(error),
                        })?;
                    collected.push(RunnerObservation { event });
                }
                None => return Ok(collected),
            }
        }
        Err(EnginePortError::Lifecycle {
            stage: LifecycleStage::Observe,
            message: format!(
                "observation drain exceeded cap {RUNNER_OBSERVATION_DRAIN_CAP}; port must yield None"
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
        let root_path = root.path();
        let canonical_root = std::fs::canonicalize(root_path).unwrap_or_else(|_| root_path.into());
        let canonical_artifact = std::fs::canonicalize(path).unwrap_or_else(|_| path.into());
        if !canonical_artifact.starts_with(&canonical_root) {
            return Err(EnginePortError::ArtifactRootViolation {
                artifact_uri: outcome.artifact_uri.clone(),
            });
        }
    }
    Ok(())
}

fn error_into_send_sync(
    error: Box<dyn std::error::Error>,
) -> Box<dyn std::error::Error + Send + Sync> {
    // `UtsushiResult` errors are `Box<dyn std::error::Error>`. Adapt to
    // the `Send + Sync` form by re-stringifying — the rendered text is
    // the diagnostic surface anyway.
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
}
