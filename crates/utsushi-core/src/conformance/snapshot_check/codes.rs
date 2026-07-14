//! Stable semantic codes for snapshot conformance checks ().
//!
//! Each code namespaces under `utsushi.conformance.*` so it lives in
//! the same provider/subsystem registry as the rest of the conformance
//! diagnostics. The full `ALL` slice is also concatenated into
//! [`super::super::diagnostics::codes::ALL`] so a single global registry
//! stays single-sourced for downstream allowed-code validators.

pub const SNAPSHOT_RESTORE_UNSUPPORTED: &str = "utsushi.conformance.snapshot_restore_unsupported";
pub const SNAPSHOT_CHECK_PROFILE_MISMATCH: &str =
    "utsushi.conformance.snapshot_check_profile_mismatch";
pub const SNAPSHOT_REF_INVALID: &str = "utsushi.conformance.snapshot_ref_invalid";
pub const SNAPSHOT_INSPECTABLE_ID_MISMATCH: &str =
    "utsushi.conformance.snapshot_inspectable_id_mismatch";
pub const SNAPSHOT_EVIDENCE_TIER_OVERCLAIM: &str =
    "utsushi.conformance.snapshot_evidence_tier_overclaim";
pub const SNAPSHOT_DIFF_INSPECTABLE_ID_MISMATCH: &str =
    "utsushi.conformance.snapshot_diff_inspectable_id_mismatch";
pub const SNAPSHOT_RESOLUTION_FAILED: &str = "utsushi.conformance.snapshot_resolution_failed";

/// Full set of stable snapshot-conformance semantic codes registered by
/// . Mirrored into [`super::super::diagnostics::codes::ALL`].
pub const ALL: &[&str] = &[
    SNAPSHOT_RESTORE_UNSUPPORTED,
    SNAPSHOT_CHECK_PROFILE_MISMATCH,
    SNAPSHOT_REF_INVALID,
    SNAPSHOT_INSPECTABLE_ID_MISMATCH,
    SNAPSHOT_EVIDENCE_TIER_OVERCLAIM,
    SNAPSHOT_DIFF_INSPECTABLE_ID_MISMATCH,
    SNAPSHOT_RESOLUTION_FAILED,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_check_codes_all_registered_in_conformance_diagnostics() {
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
    fn snapshot_check_codes_are_kebab_namespaced_under_utsushi_conformance() {
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
    fn snapshot_check_codes_all_unique() {
        let set: std::collections::HashSet<&'static str> = ALL.iter().copied().collect();
        assert_eq!(set.len(), ALL.len(), "ALL must not contain duplicates");
    }

    #[test]
    fn snapshot_check_codes_all_has_seven_entries() {
        assert_eq!(ALL.len(), 7);
    }
}
