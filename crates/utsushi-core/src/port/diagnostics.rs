//! Typed diagnostics for `EnginePort` lifecycle errors and manifest drift.

use std::fmt;

use crate::{EvidenceTier, FidelityTier, RuntimeOperation};

use super::manifest::{EnvFieldShape, LifecycleStage, PortCapability};

/// Top-level error surface for the engine port template. Every typed
/// rejection a port emits — manifest drift, ABI mismatch, env leak
/// cancellation, capability gap — flows through this enum.
#[derive(Debug)]
pub enum EnginePortError {
    /// Manifest structural validation failed.
    ManifestInvalid { source: ManifestError },

    /// Manifest declares a capability the port does not have, or vice versa.
    ManifestCapabilityDrift {
        capability: PortCapability,
        kind: DriftKind,
    },

    /// Manifest declared an ABI version the runner does not support.
    AbiVersionUnsupported {
        declared: u32,
        supported: &'static [u32],
    },

    /// Manifest declared an env field whose shape is forbidden
    /// (`Path`, `LocalPath`, `Secret`).
    EnvSchemaForbidsPath {
        key: &'static str,
        shape: EnvFieldShape,
    },

    /// Runtime env value matched a redaction rule.
    EnvUnredacted {
        key: &'static str,
        rule: &'static str,
    },

    /// Lifecycle was cancelled via the runner cancellation token.
    Cancelled { stage: LifecycleStage },

    /// Port emitted an observation event that failed validation.
    ObservationInvalid {
        stage: LifecycleStage,
        // Boxed on purpose: this is the opaque underlying error surfaced by an
        // arbitrary engine port, so no closed type can name it; `Send + Sync`
        // keeps `EnginePortError` thread-safe.
        source: Box<dyn std::error::Error + Send + Sync>,
    },

    /// Port wrote a capture artifact outside the managed root.
    ArtifactRootViolation { artifact_uri: String },

    /// Capture (or smoke-validate) was requested without a managed
    /// artifact root, so capture containment cannot be enforced. The
    /// runner rejects the request rather than silently skipping the
    /// containment guard.
    ArtifactRootMissing { stage: LifecycleStage },

    /// Capability declared as unsupported by the manifest or by the
    /// default trait impl.
    CapabilityUnsupported {
        capability: PortCapability,
        reason: CapabilityReason,
    },

    /// The `EnginePortAdapter` cannot drive this runtime operation through
    /// the lifecycle-shaped `EnginePort` ABI. This is intentionally distinct
    /// from a manifest capability declaration so callers at the
    /// `RuntimeAdapter` boundary can match the rejected operation without
    /// parsing a display string.
    AdapterOperationUnsupported { operation: RuntimeOperation },

    /// Required lifecycle method returned an opaque underlying error.
    Lifecycle {
        stage: LifecycleStage,
        message: String,
        // Boxed on purpose: opaque underlying error from a required lifecycle
        // method of an arbitrary engine port; no closed type can name it.
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    /// `shutdown` was called twice and returned conflicting outcomes.
    ShutdownNotIdempotent {
        first: PortShutdownStatus,
        second: PortShutdownStatus,
    },
}

impl fmt::Display for EnginePortError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ManifestInvalid { source } => write!(formatter, "manifest invalid: {source}"),
            Self::ManifestCapabilityDrift { capability, kind } => write!(
                formatter,
                "manifest capability drift for {capability_name}: {kind}",
                capability_name = capability.as_str(),
            ),
            Self::AbiVersionUnsupported {
                declared,
                supported,
            } => write!(
                formatter,
                "engine port abi version {declared} is not supported (supported: {supported:?})"
            ),
            Self::EnvSchemaForbidsPath { key, shape } => write!(
                formatter,
                "env field {key} declares forbidden shape {shape}",
                shape = shape.as_str()
            ),
            Self::EnvUnredacted { key, rule } => {
                write!(formatter, "env field {key} value rejected by rule {rule}")
            }
            Self::Cancelled { stage } => {
                write!(formatter, "lifecycle stage {} cancelled", stage.as_str())
            }
            Self::ObservationInvalid { stage, source } => write!(
                formatter,
                "observation invalid during {stage}: {source}",
                stage = stage.as_str(),
            ),
            Self::ArtifactRootViolation { artifact_uri } => write!(
                formatter,
                "capture artifact uri {artifact_uri} is outside the managed root"
            ),
            Self::ArtifactRootMissing { stage } => write!(
                formatter,
                "lifecycle stage {} requested capture without a managed artifact root",
                stage.as_str()
            ),
            Self::CapabilityUnsupported { capability, reason } => write!(
                formatter,
                "capability {capability_name} unsupported: {reason}",
                capability_name = capability.as_str(),
            ),
            Self::AdapterOperationUnsupported { operation } => write!(
                formatter,
                "engine port adapter does not support {}",
                operation.as_str(),
            ),
            Self::Lifecycle { stage, message, .. } => write!(
                formatter,
                "lifecycle stage {} failed: {message}",
                stage.as_str()
            ),
            Self::ShutdownNotIdempotent { first, second } => write!(
                formatter,
                "shutdown is not idempotent: first={first}, second={second}"
            ),
        }
    }
}

impl std::error::Error for EnginePortError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::ObservationInvalid { source, .. } => Some(source.as_ref()),
            Self::Lifecycle {
                source: Some(error),
                ..
            } => Some(error.as_ref()),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub enum ManifestError {
    IdMalformed {
        id: &'static str,
    },
    NameMissing,
    VersionMalformed {
        version: &'static str,
    },
    RequiredMethodsMismatch,
    OptionalMethodOutsideKnownSet {
        stage: LifecycleStage,
    },
    OptionalAndRequiredOverlap {
        stage: LifecycleStage,
    },
    EvidenceTierAboveFidelityCeiling {
        evidence: EvidenceTier,
        fidelity: FidelityTier,
    },
    EnvFieldKeyMalformed {
        key: &'static str,
    },
    EnvFieldPurposeMissing {
        key: &'static str,
    },
    EnvFieldDuplicate {
        key: &'static str,
    },
}

impl fmt::Display for ManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::IdMalformed { id } => write!(formatter, "port id is malformed: {id}"),
            Self::NameMissing => write!(formatter, "port name is missing"),
            Self::VersionMalformed { version } => {
                write!(formatter, "port version is malformed: {version}")
            }
            Self::RequiredMethodsMismatch => write!(
                formatter,
                "required_methods must equal [Launch, Observe, Capture, Shutdown]"
            ),
            Self::OptionalMethodOutsideKnownSet { stage } => write!(
                formatter,
                "optional_methods contains stage outside the known set: {}",
                stage.as_str()
            ),
            Self::OptionalAndRequiredOverlap { stage } => write!(
                formatter,
                "optional_methods overlaps required_methods at stage: {}",
                stage.as_str()
            ),
            Self::EvidenceTierAboveFidelityCeiling { evidence, fidelity } => write!(
                formatter,
                "evidence tier {} exceeds fidelity ceiling {}",
                evidence.as_str(),
                fidelity.as_str(),
            ),
            Self::EnvFieldKeyMalformed { key } => {
                write!(formatter, "env field key is malformed: {key}")
            }
            Self::EnvFieldPurposeMissing { key } => {
                write!(formatter, "env field {key} purpose is empty")
            }
            Self::EnvFieldDuplicate { key } => {
                write!(formatter, "env field key declared twice: {key}")
            }
        }
    }
}

impl std::error::Error for ManifestError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriftKind {
    /// Trait implements it but the manifest does not declare it.
    UnclaimedImplementation,
}

impl fmt::Display for DriftKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnclaimedImplementation => formatter.write_str("unclaimed_implementation"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapabilityReason {
    /// The default trait impl was used (port has not implemented the
    /// optional method).
    DefaultUnimplemented,
    /// The port declared the capability as planned but the current build
    /// deliberately rejects calls.
    NotYetSupported,
}

impl fmt::Display for CapabilityReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DefaultUnimplemented => formatter.write_str("default_unimplemented"),
            Self::NotYetSupported => formatter.write_str("not_yet_supported"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortShutdownStatus {
    /// Port shut down cleanly on this call.
    Clean,
    /// Port was already shut down; the call is a no-op.
    AlreadyShutDown,
}

impl fmt::Display for PortShutdownStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Clean => formatter.write_str("clean"),
            Self::AlreadyShutDown => formatter.write_str("already_shut_down"),
        }
    }
}

/// Outcome reported by a port's `shutdown` method. Returned outcomes from
/// repeated calls must be either identical or compose under the idempotence
/// rule (`Clean` -> `AlreadyShutDown`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortShutdownOutcome {
    pub status: PortShutdownStatus,
    pub message: Option<String>,
}

impl PortShutdownOutcome {
    pub fn clean() -> Self {
        Self {
            status: PortShutdownStatus::Clean,
            message: None,
        }
    }

    pub fn already_shut_down() -> Self {
        Self {
            status: PortShutdownStatus::AlreadyShutDown,
            message: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::looks_like_local_path;

    #[test]
    fn engine_port_error_display_passes_local_path_filter() {
        let error = EnginePortError::EnvUnredacted {
            key: "UTSUSHI_PORT_FLAG",
            rule: "looks_like_local_path",
        };
        let rendered = format!("{error}");
        assert!(
            !looks_like_local_path(&rendered),
            "rendered diagnostic must not look like a local path: {rendered}"
        );
    }

    #[test]
    fn capability_unsupported_carries_capability_and_reason() {
        let error = EnginePortError::CapabilityUnsupported {
            capability: PortCapability::Jump,
            reason: CapabilityReason::DefaultUnimplemented,
        };
        match error {
            EnginePortError::CapabilityUnsupported { capability, reason } => {
                assert_eq!(capability, PortCapability::Jump);
                assert_eq!(reason, CapabilityReason::DefaultUnimplemented);
            }
            other => panic!("expected CapabilityUnsupported, got {other:?}"),
        }
    }

    #[test]
    fn env_unredacted_carries_field_key_and_rule() {
        let error = EnginePortError::EnvUnredacted {
            key: "UTSUSHI_PORT_FLAG",
            rule: "looks_like_local_path",
        };
        match error {
            EnginePortError::EnvUnredacted { key, rule } => {
                assert_eq!(key, "UTSUSHI_PORT_FLAG");
                assert_eq!(rule, "looks_like_local_path");
            }
            other => panic!("expected EnvUnredacted, got {other:?}"),
        }
    }
}
