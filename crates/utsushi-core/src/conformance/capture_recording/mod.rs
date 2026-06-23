//! Capture- and recording-side runtime conformance checks (UTSUSHI-029).
//!
//! This module ships the per-profile shape, validators, semantic codes,
//! and `run()` helpers for the [`crate::conformance::ProfileId::FrameCapture`]
//! and [`crate::conformance::ProfileId::RecordingCapture`] profiles. The
//! module is engine-neutral; no XP3/KAG/RGSS3/Tyrano-specific surface
//! lives here. Every artifact reference flows through
//! [`crate::ObservationArtifactRef`] /
//! [`crate::validate_runtime_artifact_uri`], so host paths, `file:`/
//! `data:`/`blob:` schemes, traversal, and any URI outside
//! [`crate::RUNTIME_ARTIFACT_URI_ROOT`] are rejected.
//!
//! ## Shape
//!
//! Two check structs:
//!
//! - [`FrameCaptureConformanceCheck`] — single frames (screenshots,
//!   standalone frame captures).
//! - [`RecordingConformanceCheck`] — composite recording: container +
//!   sequential frame refs + audio-event count metadata.
//!
//! Both expose `validate()` (structural rules) and `run()` (project the
//! result into a [`crate::conformance::ResultOutcome`]).
//! `into_conformance_result()` bundles the outcome with the three audit
//! tiers (per-artifact floor, profile ceiling, sink ceiling).
//!
//! ## Stable codes
//!
//! See [`codes`]. The 24 codes registered here are also wired into
//! [`crate::conformance::diagnostics::codes::ALL`] so the single global
//! registry stays single-sourced.
//!
//! ## Unsupported handling
//!
//! Missing capture support is reported as
//! [`crate::conformance::ResultOutcome::Unsupported`] with the
//! [`codes::FRAME_CAPTURE_UNSUPPORTED`] or
//! [`codes::RECORDING_CAPTURE_UNSUPPORTED`] semantic code; the runner
//! does NOT call the check struct in that path. See
//! [`unsupported_frame_capture_result`] / [`unsupported_recording_capture_result`].

pub mod codes;
pub mod frame_check;
pub mod recording_check;

pub use frame_check::{
    ArtifactCountRange, CaptureCheckSummary, FRAME_ARTIFACT_COUNT_MAX_SOFT_CEILING,
    FrameArtifactRef, FrameCaptureConformanceCheck,
};
pub use recording_check::{
    DurationRangeMs, RecordingCheckSummary, RecordingConformanceCheck, RecordingMetadata,
};

use crate::conformance::result::ResultOutcome;

/// Build the `Unsupported` outcome the runner emits when the adapter's
/// manifest does NOT declare [`crate::conformance::ProfileId::FrameCapture`].
///
/// Carries [`codes::FRAME_CAPTURE_UNSUPPORTED`] and
/// `declared_in_manifest = false` so the cross-validator in
/// [`crate::conformance::cross_validate_results_against_manifest`]
/// accepts it.
pub fn unsupported_frame_capture_result() -> ResultOutcome {
    ResultOutcome::Unsupported {
        semantic_code: codes::FRAME_CAPTURE_UNSUPPORTED.to_string(),
        declared_in_manifest: false,
    }
}

/// Build the `Unsupported` outcome the runner emits when the adapter's
/// manifest does NOT declare
/// [`crate::conformance::ProfileId::RecordingCapture`].
pub fn unsupported_recording_capture_result() -> ResultOutcome {
    ResultOutcome::Unsupported {
        semantic_code: codes::RECORDING_CAPTURE_UNSUPPORTED.to_string(),
        declared_in_manifest: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conformance::diagnostics;

    /// Asserts every code introduced by this slice is also registered in
    /// the global `conformance::diagnostics::codes::ALL`. Catches a
    /// missing additive entry the moment it lands.
    #[test]
    fn capture_recording_codes_all_present_in_conformance_diagnostics_all() {
        let registry: std::collections::HashSet<&'static str> =
            diagnostics::codes::ALL.iter().copied().collect();
        for code in codes::ALL {
            assert!(
                registry.contains(code),
                "code {code} missing from conformance::diagnostics::codes::ALL"
            );
        }
    }

    #[test]
    fn unsupported_frame_capture_result_carries_the_documented_semantic_code() {
        match unsupported_frame_capture_result() {
            ResultOutcome::Unsupported {
                semantic_code,
                declared_in_manifest,
            } => {
                assert_eq!(semantic_code, codes::FRAME_CAPTURE_UNSUPPORTED);
                assert!(!declared_in_manifest);
            }
            other => panic!("expected Unsupported, got {other:?}"),
        }
    }

    #[test]
    fn unsupported_recording_capture_result_carries_the_documented_semantic_code() {
        match unsupported_recording_capture_result() {
            ResultOutcome::Unsupported {
                semantic_code,
                declared_in_manifest,
            } => {
                assert_eq!(semantic_code, codes::RECORDING_CAPTURE_UNSUPPORTED);
                assert!(!declared_in_manifest);
            }
            other => panic!("expected Unsupported, got {other:?}"),
        }
    }
}
