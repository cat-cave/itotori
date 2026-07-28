//! - profiled Wolf encrypted archive extract + patch.
//!   This module composes the existing Wolf pieces into a data-driven profiled
//!   archive/protection-key workflow:
//! - container + crypto: [`crate::wolf_encrypted_smoke`]
//!   pack/decrypt using [`crate::wolf_encrypted_smoke::WolfEncryptedArchiveKey`]
//!   (zeroize-on-drop, `Debug` redacted);
//! - text surface: [`crate::wolf_adapter`] Shift-JIS text-table
//!   codec and patch coordinates; and
//! - key/helper evidence: a concrete [`SecretRef`] and, for helper-gated
//!   profiles, a [`crate::HelperResult`] bound to that EXACT ref.
//!   A claimed profile that cannot extract + patch is a compatibility BUG:
//!   [`WolfProfiledProductionError::ClaimedProfileFailed`]. Unclaimed profiles are
//!   explicit out-of-scope rows. All fixtures are synthetic.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::wolf_adapter::{
    WolfAdapterError, WolfAdapterPatchCoordinate, WolfTextPatchRequest, WolfTextTable,
};
use crate::wolf_encrypted_smoke::{
    WolfEncryptedArchiveKey, WolfEncryptedCryptoProfile, WolfEncryptedFixtureSecretResolver,
    WolfEncryptedSmokeError,
};
use crate::wolf_helper_boundary::WolfHelperBoundaryKind;
use crate::wolf_protection_detector::WolfProtectionProfile;
use crate::{
    HELPER_RESULT_SCHEMA_VERSION, HelperCapabilityLevel, HelperDiagnostic, HelperDiagnosticCode,
    HelperExecutionFilesystemAccess, HelperExecutionSummary, HelperProvenance, HelperRedaction,
    HelperRedactionStatus, HelperResult, HelperResultSecretRef, KaifuuResult, KeyMaterialKind,
    KeyValidationMethod, KeyValidationProof, OperationStatus, ProofHash, SecretRef,
    deterministic_id, redact_for_log_or_report, secret_holder::SecretRefSecretResolver,
    sha256_hash_bytes, stable_json,
};

mod run;

pub use run::run_wolf_profiled_production;

pub const WOLF_PROFILED_PRODUCTION_MARKER: &str = "kaifuu.wolf.profiled_production";
pub const WOLF_PROFILED_PRODUCTION_SCHEMA_VERSION: &str = "0.1.0";
pub const WOLF_PROFILED_PRODUCTION_CAPABILITY_ID: &str =
    "kaifuu-wolf-profiled-encrypted-archive-production";
pub const WOLF_PROFILED_PRODUCTION_CONTAINER: &str = "wolf-like-encrypted-archive";
pub const WOLF_PROFILED_PRODUCTION_SUPPORT_BOUNDARY: &str = "Kaifuu Wolf profiled encrypted-archive production extract+patch drives PROFILED archive/protection-key workflows on SYNTHETIC Wolf-like encrypted archive fixtures. A variant is DATA: declared protection profile + crypto profile + text-table surfaces + required key/helper evidence (a SecretRef, never raw key material, and an exact-ref-bound  helper result when helper-gated). A claimed profile must extract text-bearing data and patch it back through the same protection/container; claimed failures are loud typed compatibility bugs, never silent skips. Keys remain inside module-private zeroize-on-drop Debug-redacting holders and reports carry refs, hashes, and counts only. This is not commercial Wolf/DXArchive coverage.";

mod model;
pub use model::*;

fn table_member_id(table_name: &str) -> String {
    format!("Data/{table_name}.wolftable")
}

fn fixture_key_material(label: &str) -> Vec<u8> {
    let mut bytes = b"kaifuu-wolf-profiled-production-key\0".to_vec();
    bytes.extend_from_slice(sha256_hash_bytes(label.as_bytes()).as_bytes());
    bytes
}

pub mod synthetic;

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> WolfProfiledProductionRegistry {
        synthetic::production_registry()
    }

    #[test]
    fn profiled_wolf_variants_extract_and_patch_round_trip() {
        let report = run_wolf_profiled_production(&registry(), "synthetic-fixture")
            .expect("profiled run passes");
        assert!(report.is_ok());
        assert_eq!(report.claimed_count, 2);
        assert_eq!(report.not_claimed_count, 1);
        assert!(
            report
                .claimed_profiles
                .contains(&WolfProtectionProfile::Protected)
        );
        assert!(
            report
                .claimed_profiles
                .contains(&WolfProtectionProfile::HelperRequired)
        );

        let claimed: Vec<&WolfProfiledVariantReport> = report
            .outcomes
            .iter()
            .filter_map(|outcome| match outcome {
                WolfProfiledOutcome::Claimed(report) => Some(report),
                WolfProfiledOutcome::NotClaimed(_) => None,
            })
            .collect();
        assert_eq!(claimed.len(), 2);
        for variant in claimed {
            assert!(variant.identity_byte_identical);
            assert_eq!(variant.members_patched, 1);
            assert_eq!(variant.members_byte_preserved, 1);
            assert_ne!(
                variant.source_archive_hash.as_str(),
                variant.rebuilt_archive_hash.as_str()
            );
            assert_eq!(variant.patch_reports.len(), 1);
            assert!(variant.patch_reports[0].patched_text_verified);
            assert!(variant.patch_reports[0].old_text_absent);
        }
    }

    #[test]
    fn claimed_but_broken_profile_fails_loud() {
        let mut registry = registry();
        let secret_ref = registry.variants[0].secret_ref.as_str().to_string();
        registry.resolved_keys =
            resolver_from_fixture_labels(vec![(secret_ref, "wolf-profiled-production/wrong")]);
        let err = run_wolf_profiled_production(&registry, "synthetic-fixture")
            .expect_err("wrong key is a compatibility bug");
        match err {
            WolfProfiledProductionError::ClaimedProfileFailed {
                variant_id, stage, ..
            } => {
                assert_eq!(variant_id, "kaifuu-k058-wolf-static-profile");
                assert_eq!(stage, "extract");
            }
            other @ WolfProfiledProductionError::Internal { .. } => {
                panic!("expected claimed profile failure, got {other}")
            }
        }
    }

    #[test]
    fn no_raw_key_leaks_through_debug_or_report() {
        let registry = registry();
        let debug = format!("{registry:?}");
        let report = run_wolf_profiled_production(&registry, "synthetic-fixture")
            .expect("profiled run passes");
        let json = report.stable_json().expect("stable json");

        for plaintext in [
            "synthetic-k058-line-before",
            "synthetic-k058-line-after-longer",
            "synthetic-k058-event-before",
            "synthetic-k058-event-after",
        ] {
            assert!(
                !json.contains(plaintext),
                "plaintext {plaintext} leaked through report"
            );
        }
        assert!(
            !registry.archive_keys.any_key_appears_in(debug.as_bytes()),
            "archive key appeared in registry Debug"
        );
        assert!(
            !registry.resolved_keys.any_key_appears_in(json.as_bytes()),
            "resolved key appeared in report JSON"
        );
    }

    #[test]
    fn helper_evidence_must_bind_exact_secret_ref() {
        let mut registry = registry();
        let requirement = registry.variants[1].secret_requirement_id.clone();
        let wrong_ref = SecretRef::new("local-secret:kaifuu/k058/wolf-wrong-ref")
            .expect("synthetic secret ref is valid");
        registry.variants[1].helper_evidence = Some(synthetic::satisfied_helper(
            WolfProfiledHelperWorkflow::DynamicKeyHelper,
            &requirement,
            &wrong_ref,
        ));
        let err = run_wolf_profiled_production(&registry, "synthetic-fixture")
            .expect_err("wrong-ref helper evidence must not satisfy the gate");
        match err {
            WolfProfiledProductionError::ClaimedProfileFailed {
                variant_id,
                stage,
                cause,
                ..
            } => {
                assert_eq!(variant_id, "kaifuu-k058-wolf-dynamic-helper-profile");
                assert_eq!(stage, "evidence-check");
                assert!(cause.contains("exact SecretRef"));
            }
            other @ WolfProfiledProductionError::Internal { .. } => {
                panic!("expected claimed profile failure, got {other}")
            }
        }
    }

    #[test]
    fn unclaimed_profile_is_explicit_out_of_scope() {
        let report = run_wolf_profiled_production(&registry(), "synthetic-fixture")
            .expect("profiled run passes");
        let not_claimed: Vec<&WolfProfiledNotClaimedReport> = report
            .outcomes
            .iter()
            .filter_map(|outcome| match outcome {
                WolfProfiledOutcome::NotClaimed(report) => Some(report),
                WolfProfiledOutcome::Claimed(_) => None,
            })
            .collect();
        assert_eq!(not_claimed.len(), 1);
        assert_eq!(
            not_claimed[0].variant_id,
            "kaifuu-k058-wolf-unclaimed-research-profile"
        );
        assert!(not_claimed[0].reason.contains("not claimed"));
    }
}
