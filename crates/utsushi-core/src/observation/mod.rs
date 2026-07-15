//! Observation metadata types and runtime-evidence report validation.
//!
//! Extracted from `lib.rs` as a cohesive group: observation-hook metadata
//! shapes plus the structural validator for RuntimeEvidenceReportV02 and the
//! path-redaction helpers it shares with sink/VFS consumers.

mod metadata;
mod path_redaction;
mod rfc3339;
mod runtime_report;
mod runtime_report_capabilities;
mod runtime_report_events;

// `deleted-hook-envelopeKind` + `deleted-hook-envelope` deleted.
// Engine ports now push observation payloads through the
// `crate::sink::SinkSet` bridge. The wire-shape `observationHookEvents`
// array remains a `kaifuu-core` contract surface and is synthesized as raw
// JSON in the fixture engine ports (no `utsushi-core` Rust type backs it).

pub(crate) use path_redaction::reject_unredacted_local_paths;
#[cfg(test)]
pub(crate) use rfc3339::validate_rfc3339_instant_metadata;

pub use metadata::{
    ObservationAdapterId, ObservationArtifactRef, ObservationBridgeRef, ObservationEnvironment,
    ObservationRedactionMetadata, ObservationRedactionStatus, ObservationSourceRevision,
};
pub use path_redaction::looks_like_local_path;
pub use runtime_report::validate_runtime_evidence_report_value;
