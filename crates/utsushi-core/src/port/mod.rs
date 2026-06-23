//! Engine-port runner template (UTSUSHI-103).
//!
//! Slice A introduces the manifest schema and typed diagnostic surface
//! that every Utsushi engine port will commit to. The trait, runner,
//! adapter shim, and ABI conformance harness land in follow-up commits
//! in the same Slice A change set.
//!
//! See `.plan/UTSUSHI-103.md` for the design rationale.

pub mod diagnostics;
pub mod manifest;

pub use diagnostics::{
    CapabilityReason, DriftKind, EnginePortError, ManifestError, PortShutdownOutcome,
    PortShutdownStatus,
};
pub use manifest::{
    EnvFieldSchema, EnvFieldShape, LifecycleStage, OPTIONAL_LIFECYCLE_STAGES, PortCapability,
    PortManifest, REQUIRED_LIFECYCLE_STAGES,
};
