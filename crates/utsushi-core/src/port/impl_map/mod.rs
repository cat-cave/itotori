//! Engine-port implementation-map artifact (UTSUSHI-025).
//!
//! Every Utsushi engine port slice ships an `ImplementationMap` JSON
//! document declaring (a) the engine subsystems it covers, (b) the public
//! fixtures it exercises with full provenance, (c) the validation commands
//! that drive those fixtures, and (d) the reference behavior an auditor can
//! compare against to falsify the coverage claim.
//!
//! The schema is engine-neutral. Engine-specific shape lives entirely in
//! the [`EngineFamily`] discriminant, free-form per-subsystem
//! [`Subsystem::capabilities`] tags, and audit-visible
//! `name`/`caption`/`notes` strings.
//!
//! `Status::Validated` is **coverage-scaffold-shaped, not alpha-ready**.
//! The [`STATUS_VALIDATED_DISCLAIMER`] string is the audit-load-bearing
//! signal of this distinction; consumers MUST surface it whenever they
//! surface [`Status::Validated`].

pub mod diagnostics;
pub mod json_schema;
pub mod schema;
pub mod store;
pub mod validator;

pub use diagnostics::{
    FixtureHashMismatch, ImplMapError, ImplMapManifestMismatch, ProvenanceField, ReferenceField,
};
pub use json_schema::build_schema;
pub use schema::{
    CaptureMethod, EngineFamily, EvidenceKind, EvidenceRef, ExpectedOutcome, FixtureClassification,
    FixtureKind, FixtureRef, IMPL_MAP_SCHEMA_VERSION, ImplementationMap, PortId, ReferenceBehavior,
    Status, Subsystem, SubsystemId, SubsystemStatus, UnsupportedReason, ValidationCommand,
    ValidationCommandId,
};
pub use store::{FixtureStore, FixtureStoreError, sha256_hex, verify_fixture_hashes};
pub use validator::{
    STATUS_VALIDATED_DISCLAIMER, ValidationReport, ValidationWarning, validate,
    validate_against_manifest,
};

/// Validate the map and, on success, promote `Status::Draft` -> `Validated`
/// and stamp the audit-visible disclaimer. Idempotent; preserves
/// `Status::Outdated` as-is.
pub fn validate_and_promote(
    map: &mut ImplementationMap,
) -> Result<ValidationReport, Vec<ImplMapError>> {
    let report = validator::validate(map)?;
    validator::promote_status(map, &report);
    Ok(report)
}

#[cfg(test)]
mod tests;
