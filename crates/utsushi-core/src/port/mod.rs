//! Engine-port runner template (UTSUSHI-103).
//!
//! Slice A introduces the manifest schema, typed diagnostic surface,
//! the lifecycle trait, and the cooperative cancellation token. The
//! runner orchestrator, adapter shim, and ABI conformance harness land
//! in follow-up commits in the same Slice A change set.
//!
//! See `.plan/UTSUSHI-103.md` for the design rationale.

pub mod diagnostics;
pub mod manifest;
pub mod runner;
pub mod trait_;

pub use diagnostics::{
    CapabilityReason, DriftKind, EnginePortError, ManifestError, PortShutdownOutcome,
    PortShutdownStatus,
};
pub use manifest::{
    EnvFieldSchema, EnvFieldShape, LifecycleStage, OPTIONAL_LIFECYCLE_STAGES, PortCapability,
    PortManifest, REQUIRED_LIFECYCLE_STAGES,
};
pub use runner::RunnerCancellation;
pub use trait_::{CaptureOutcome, EnginePort, MomentId, PortEnv, PortRequest};
