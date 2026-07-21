//! BGI / Ethornell readiness proof.
//!
//! This module combines synthetic archive/container detector evidence with
//! scenario-bytecode parser evidence into an honest per-capability report. A
//! readiness level can reach `identify`, `inventory`, `extract`, or `patch` only
//! when the corresponding evidence passed validation; a failed detector leaves
//! the outer container gate closed at `unsupported`.

/// Schema version of the readiness fixture input.
pub const BGI_READINESS_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the generated readiness report.
pub const BGI_READINESS_REPORT_SCHEMA_VERSION: &str = "0.1.0";

/// The provenance node the embedded detector evidence is validated under.
pub const BGI_READINESS_DETECTOR_PROVENANCE_NODE: &str = "KAIFUU-126";
/// The provenance node the embedded bytecode evidence is validated under.
pub const BGI_READINESS_BYTECODE_PROVENANCE_NODE: &str = "KAIFUU-127";

/// The support boundary surfaced in every BGI readiness report.
pub const BGI_READINESS_SUPPORT_BOUNDARY: &str = "The BGI/Ethornell readiness proof COMBINES the KAIFUU-126 archive/container detector evidence (identify + honest missing_capability boundaries for encrypted/compressed/layered/unknown variants) with the KAIFUU-127 scenario-bytecode parser evidence (inventory of Shift-JIS string-reference surfaces plus verified extract-to-patch round-trips) into ONE per-capability-level readiness report. It reports the ACHIEVED level (unsupported, identify, inventory, extract, or patch) mechanically per the fixture evidence and NEVER claims a level beyond it: an encrypted (BSE), compressed (DSC), layered (CompressedBG), header-less, or unrecognized container is unsupported; identify recognizes a Buriko ARC20 container; inventory enumerates the parser/profile string-reference surfaces; extract is claimed ONLY where an explicit synthetic fixture proves it; patch additionally requires a verified bytecode extract-to-patch round-trip (non-empty verified patch_reports) plus an explicit synthetic patch fixture (retail BGI archive decryption/decompression/extraction/patch-back is later adapter work and is never claimed here). Evidence is synthetic and redacted — synthetic ids and sha256 hashes only, never raw keys, paths, or retail bytes.";

#[path = "bgi_readiness_model.rs"]
mod bgi_readiness_model;
#[path = "bgi_readiness_resolver.rs"]
mod bgi_readiness_resolver;

pub use bgi_readiness_model::*;
pub use bgi_readiness_resolver::{read_bgi_readiness_fixture, run_bgi_readiness};

#[cfg(test)]
#[path = "bgi_readiness_tests.rs"]
mod tests;
