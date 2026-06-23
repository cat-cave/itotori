//! ABI conformance harness. Engine port crates call into the harness
//! from their integration tests to assert manifest validation, lifecycle
//! correctness, cancellation observance, capture-root containment, and
//! `shutdown` idempotence.

use std::path::PathBuf;

use crate::{RuntimeArtifactRoot, RuntimeOperation};

use super::diagnostics::{CapabilityReason, EnginePortError};
use super::manifest::{PortCapability, PortManifest};
use super::runner::{Runner, RunnerCancellation};
use super::trait_::{EnginePort, MomentId, PortEnv, PortRequest};

/// Per-port inputs the harness needs in order to exercise every required
/// lifecycle method.
pub struct ConformanceFixture {
    pub input_root: PathBuf,
    pub artifact_root: RuntimeArtifactRoot,
    pub env: PortEnv,
    pub run_id: String,
}

/// Coarse result of an ABI conformance run. Each required stage gets one
/// observable outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AbiConformanceReport {
    pub manifest_id: &'static str,
    pub launched: bool,
    pub observation_count: usize,
    pub captured: bool,
    pub first_shutdown_clean: bool,
    pub second_shutdown_idempotent: bool,
    pub jump_outcome: JumpOutcome,
    pub cancellation_observed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JumpOutcome {
    /// Manifest does not declare `Jump`; runner-level call returned
    /// `CapabilityUnsupported`.
    NotDeclared,
    /// Manifest declared `Jump`; port honoured the call.
    Honoured,
}

/// Run the ABI conformance suite against an `EnginePort`. Builds a fresh
/// port per scenario via `port_factory`.
pub fn run_required_abi<P, F>(
    port_factory: F,
    fixture: &ConformanceFixture,
) -> Result<AbiConformanceReport, EnginePortError>
where
    P: EnginePort + 'static,
    F: Fn() -> P,
{
    let runner = Runner::new();
    runner.validate_manifest(&P::MANIFEST)?;

    // Positive lifecycle path: launch -> drain observations -> capture
    // -> shutdown (twice).
    let mut port = port_factory();
    let request = PortRequest::new(
        &fixture.input_root,
        &fixture.run_id,
        RuntimeOperation::Capture,
    )
    .with_artifact_root(&fixture.artifact_root)
    .with_env(fixture.env.clone());

    let outcome = runner.run_capture(&mut port, &request)?;
    let launched = true;
    let observation_count = outcome.observations.len();
    let captured = outcome.capture.is_some();
    let first_shutdown_clean =
        outcome.shutdown.status == super::diagnostics::PortShutdownStatus::Clean;
    let second_shutdown = port.shutdown()?;
    let second_shutdown_idempotent = matches!(
        second_shutdown.status,
        super::diagnostics::PortShutdownStatus::AlreadyShutDown
            | super::diagnostics::PortShutdownStatus::Clean
    );

    // Jump capability check: a port must produce the typed
    // CapabilityUnsupported when it does not declare jump.
    let mut jump_port = port_factory();
    let jump_request = PortRequest::new(
        &fixture.input_root,
        &fixture.run_id,
        RuntimeOperation::Trace,
    );
    let jump_outcome = if P::MANIFEST.capabilities.contains(&PortCapability::Jump) {
        runner.run_jump(&mut jump_port, &jump_request, &MomentId::synthetic())?;
        JumpOutcome::Honoured
    } else {
        // Drift detection: a port that did NOT declare Jump but
        // nonetheless overrides the trait method to return Ok is
        // surfacing an UnclaimedImplementation. Call the port trait
        // method directly (bypassing the runner's capability gate) and
        // assert it returns the typed CapabilityUnsupported.
        match jump_port.jump(&jump_request, &MomentId::synthetic()) {
            Err(EnginePortError::CapabilityUnsupported {
                capability: PortCapability::Jump,
                reason: CapabilityReason::DefaultUnimplemented | CapabilityReason::NotYetSupported,
            }) => JumpOutcome::NotDeclared,
            Err(other) => return Err(other),
            Ok(()) => {
                return Err(EnginePortError::ManifestCapabilityDrift {
                    capability: PortCapability::Jump,
                    kind: super::diagnostics::DriftKind::UnclaimedImplementation,
                });
            }
        }
    };
    let _ = jump_port.shutdown();

    // Cancellation: a fresh port with the token already cancelled must
    // return Cancelled from launch.
    let mut cancel_port = port_factory();
    let cancel_token = RunnerCancellation::new();
    cancel_token.cancel();
    let cancel_request = PortRequest::new(
        &fixture.input_root,
        &fixture.run_id,
        RuntimeOperation::Trace,
    )
    .with_artifact_root(&fixture.artifact_root)
    .with_env(fixture.env.clone())
    .with_cancellation(cancel_token);
    let cancellation_observed = matches!(
        runner.run_trace(&mut cancel_port, &cancel_request),
        Err(EnginePortError::Cancelled {
            stage: super::manifest::LifecycleStage::Launch,
        })
    );
    let _ = cancel_port.shutdown();

    Ok(AbiConformanceReport {
        manifest_id: P::MANIFEST.id,
        launched,
        observation_count,
        captured,
        first_shutdown_clean,
        second_shutdown_idempotent,
        jump_outcome,
        cancellation_observed,
    })
}

/// Lower-level negative-case check: assert that a deliberately bad
/// manifest fails structural validation due to a missing required
/// method.
pub fn check_manifest_rejects_missing_method(
    manifest: &PortManifest,
) -> Result<EnginePortError, &'static str> {
    match manifest.validate() {
        Err(error) => Ok(error),
        Ok(()) => Err("manifest with missing required method must fail validation"),
    }
}

/// Lower-level check: assert that a manifest declaring an unsupported
/// ABI version is rejected by the runner.
pub fn check_manifest_rejects_unsupported_abi_version(
    manifest: &PortManifest,
) -> Result<EnginePortError, &'static str> {
    let runner = Runner::new();
    match runner.validate_manifest(manifest) {
        Err(error @ EnginePortError::AbiVersionUnsupported { .. }) => Ok(error),
        Err(other) => {
            // Manifest-level structural error landed first; still a
            // rejection but not the one we want.
            Err(match other {
                EnginePortError::ManifestInvalid { .. } => {
                    "manifest with unsupported abi version surfaced structural error first"
                }
                _ => "unexpected non-abi rejection",
            })
        }
        Ok(()) => Err("manifest with unsupported abi version must be rejected"),
    }
}

/// Lower-level check: assert that a manifest declaring a forbidden env
/// shape is rejected.
pub fn check_manifest_rejects_unredacted_env(
    manifest: &PortManifest,
) -> Result<EnginePortError, &'static str> {
    match manifest.validate() {
        Err(error @ EnginePortError::EnvSchemaForbidsPath { .. }) => Ok(error),
        Err(_) => Err("manifest with forbidden env shape surfaced a different rejection"),
        Ok(()) => Err("manifest with forbidden env shape must be rejected"),
    }
}
