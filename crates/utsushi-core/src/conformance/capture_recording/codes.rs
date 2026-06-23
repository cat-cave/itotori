//! Stable semantic codes for capture and recording conformance checks
//! (UTSUSHI-029).
//!
//! Each code namespaces under `utsushi.conformance.*` so it lives in the
//! same provider/subsystem registry as the rest of the conformance
//! diagnostics. The full `ALL` slice is also concatenated into
//! [`super::super::diagnostics::codes::ALL`] so a single global registry
//! stays single-sourced for downstream allowed-code validators.

pub const FRAME_CAPTURE_UNSUPPORTED: &str = "utsushi.conformance.frame_capture_unsupported";
pub const RECORDING_CAPTURE_UNSUPPORTED: &str = "utsushi.conformance.recording_capture_unsupported";
pub const FRAME_CAPTURE_NO_ARTIFACTS: &str = "utsushi.conformance.frame_capture_no_artifacts";
pub const FRAME_ARTIFACT_HOST_PATH: &str = "utsushi.conformance.frame_artifact_host_path";
pub const RECORDING_ARTIFACT_HOST_PATH: &str = "utsushi.conformance.recording_artifact_host_path";
pub const RECORDING_EVIDENCE_TIER_OVERCLAIM: &str =
    "utsushi.conformance.recording_evidence_tier_overclaim";
pub const FRAME_EVIDENCE_TIER_BELOW_FLOOR: &str =
    "utsushi.conformance.frame_evidence_tier_below_floor";
pub const FRAME_EVIDENCE_TIER_ABOVE_SINK_CEILING: &str =
    "utsushi.conformance.frame_evidence_tier_above_sink_ceiling";
pub const CAPTURE_CHECK_PROFILE_MISMATCH: &str =
    "utsushi.conformance.capture_check_profile_mismatch";
pub const ARTIFACT_COUNT_RANGE_MALFORMED: &str =
    "utsushi.conformance.artifact_count_range_malformed";
pub const DURATION_RANGE_MALFORMED: &str = "utsushi.conformance.duration_range_malformed";
pub const FRAME_TIER_FLOOR_BELOW_SINK_FLOOR: &str =
    "utsushi.conformance.frame_tier_floor_below_sink_floor";
pub const FRAME_TIER_FLOOR_ABOVE_PROFILE_CEILING: &str =
    "utsushi.conformance.frame_tier_floor_above_profile_ceiling";
pub const FRAME_ARTIFACT_COUNT_OUT_OF_RANGE: &str =
    "utsushi.conformance.frame_artifact_count_out_of_range";
pub const FRAME_ARTIFACT_KIND_OUTSIDE_ALLOW_LIST: &str =
    "utsushi.conformance.frame_artifact_kind_outside_allow_list";
pub const FRAME_SEQUENCE_UNORDERED: &str = "utsushi.conformance.frame_sequence_unordered";
pub const FRAME_SEQUENCE_DUPLICATE: &str = "utsushi.conformance.frame_sequence_duplicate";
pub const RECORDING_ID_MALFORMED: &str = "utsushi.conformance.recording_id_malformed";
pub const RECORDING_CONTAINER_MISSING: &str = "utsushi.conformance.recording_container_missing";
pub const RECORDING_CONTAINER_DUPLICATED: &str =
    "utsushi.conformance.recording_container_duplicated";
pub const RECORDING_ARTIFACT_KIND_OUTSIDE_ALLOW_LIST: &str =
    "utsushi.conformance.recording_artifact_kind_outside_allow_list";
pub const RECORDING_FRAME_COUNT_MISMATCH: &str =
    "utsushi.conformance.recording_frame_count_mismatch";
pub const RECORDING_DURATION_OUT_OF_RANGE: &str =
    "utsushi.conformance.recording_duration_out_of_range";
pub const RECORDING_EVENT_COUNT_OUT_OF_RANGE: &str =
    "utsushi.conformance.recording_event_count_out_of_range";

/// Full set of stable capture/recording conformance semantic codes.
pub const ALL: &[&str] = &[
    FRAME_CAPTURE_UNSUPPORTED,
    RECORDING_CAPTURE_UNSUPPORTED,
    FRAME_CAPTURE_NO_ARTIFACTS,
    FRAME_ARTIFACT_HOST_PATH,
    RECORDING_ARTIFACT_HOST_PATH,
    RECORDING_EVIDENCE_TIER_OVERCLAIM,
    FRAME_EVIDENCE_TIER_BELOW_FLOOR,
    FRAME_EVIDENCE_TIER_ABOVE_SINK_CEILING,
    CAPTURE_CHECK_PROFILE_MISMATCH,
    ARTIFACT_COUNT_RANGE_MALFORMED,
    DURATION_RANGE_MALFORMED,
    FRAME_TIER_FLOOR_BELOW_SINK_FLOOR,
    FRAME_TIER_FLOOR_ABOVE_PROFILE_CEILING,
    FRAME_ARTIFACT_COUNT_OUT_OF_RANGE,
    FRAME_ARTIFACT_KIND_OUTSIDE_ALLOW_LIST,
    FRAME_SEQUENCE_UNORDERED,
    FRAME_SEQUENCE_DUPLICATE,
    RECORDING_ID_MALFORMED,
    RECORDING_CONTAINER_MISSING,
    RECORDING_CONTAINER_DUPLICATED,
    RECORDING_ARTIFACT_KIND_OUTSIDE_ALLOW_LIST,
    RECORDING_FRAME_COUNT_MISMATCH,
    RECORDING_DURATION_OUT_OF_RANGE,
    RECORDING_EVENT_COUNT_OUT_OF_RANGE,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_recording_codes_all_registered_in_conformance_diagnostics() {
        let registry: std::collections::HashSet<&'static str> =
            crate::conformance::diagnostics::codes::ALL
                .iter()
                .copied()
                .collect();
        for code in ALL {
            assert!(
                registry.contains(code),
                "code {code} missing from conformance::diagnostics::codes::ALL"
            );
        }
    }

    #[test]
    fn capture_recording_codes_are_kebab_namespaced_under_utsushi_conformance() {
        for code in ALL {
            assert!(
                code.starts_with("utsushi.conformance."),
                "code {code} must namespace under utsushi.conformance."
            );
            let tail = &code["utsushi.conformance.".len()..];
            assert!(!tail.is_empty(), "code {code} missing trailing reason");
            assert!(
                tail.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "code {code} trailing segment {tail} must be lowercase snake_case"
            );
            assert!(
                tail.as_bytes()[0].is_ascii_lowercase(),
                "code {code} trailing segment must start with a lowercase letter"
            );
        }
    }

    #[test]
    fn capture_recording_codes_all_unique() {
        let set: std::collections::HashSet<&'static str> = ALL.iter().copied().collect();
        assert_eq!(set.len(), ALL.len(), "ALL must not contain duplicates");
    }

    #[test]
    fn capture_recording_codes_all_has_twenty_four_entries() {
        assert_eq!(ALL.len(), 24);
    }
}
