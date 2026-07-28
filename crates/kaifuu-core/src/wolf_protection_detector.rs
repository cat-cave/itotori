//! Wolf RPG Editor archive + protection detector profile fixtures.
//! A *Wolf protection detector profile* records what a Wolf RPG Editor
//! (`.wolf` / DXArchive-family) container reveals about its **protection
//! posture** and mechanically classifies it into one of four detector
//! profiles: [`WolfProtectionProfile::Plain`],
//! [`WolfProtectionProfile::Protected`],
//! [`WolfProtectionProfile::HelperRequired`], and
//! [`WolfProtectionProfile::Unknown`]. It is the Wolf-family sibling of the
//! KiriKiri XP3 capability profile
//! ([`crate::Xp3CapabilityProfileReport`]) and the packed-engine
//! readiness validator ([`crate::PackedReadinessValidationReport`]): it reuses
//! the shared transform vocabulary ([`ContainerTransform`] /
//! [`CryptoTransform`] / [`CodecTransform`] / [`SurfaceTransform`]), the shared
//! capability ladder ([`CapabilityLevel`] / [`CapabilityLevelStatus`]), and the
//! shared semantic-diagnostic taxonomy ([`SemanticErrorCode`]).
//! # Scope (honest boundary — identify-level, synthetic-fixture-driven)
//! This node is a DETECTOR, not a Wolf archive parser. It does NOT open a real
//! `.wolf`/DXA container, walk its file table, or decrypt anything. The
//! fixtures encode the *publicly observable protection posture* a Wolf archive
//! exposes (unencrypted DX archive vs static-key-encrypted vs Wolf "Pro"
//! per-game dynamic-key vs unrecognized) as a small structured signal, and the
//! detector [`derive_wolf_protection_profile`] mechanically classifies that
//! signal into the four profiles with the correct capability tuple and
//! diagnostics. Real Wolf archive extraction / decryption / patch-back is a
//! later adapter node (profile-proof command, helper
//! boundary, encrypted-archive adapter); the dynamic-key helper
//! itself is the continuous-tier boundary. None of those are
//! claimed here.
//! # The mechanical line (computed, never asserted)
//! [`derive_wolf_protection_profile`] is the single source of truth. The
//! profile is a pure function of the recorded protection signal and whether a
//! **concrete key requirement** (secret requirement id) exists:
//! - `unencrypted` → `plain`
//! - `dynamic_key_helper_gated` → `helper_required`
//! - `static_key_protected` WITH a concrete key requirement → `protected`
//! - `static_key_protected` WITHOUT a concrete key requirement → `unknown`
//!   (reports `missing_capability.crypto`)
//! - `unrecognized_protection` → `unknown`
//!   (reports `unknown_engine_variant`)
//!   The capability tuple the detector advertises separates the *identify* and
//!   *inventory* rungs it can claim from the *extract*, *patch*, *helper*, and
//!   *runtime* rungs it can NEVER claim (those are later Wolf nodes). A protected
//!   helper-required / unknown archive can therefore never present a resolved
//!   extract, patch, helper, or runtime capability no matter what the fixture
//!   declares.
//! # Evidence is synthetic, redacted, hash-free-of-keys
//! Fixtures carry NO retail bytes and NO raw key material: only the structured
//! protection signal, the shared transform legs, local-scheme [`SecretRef`]
//! key references, and stable requirement ids. The report is funnelled through
//! [`redact_for_log_or_report`] and serialized via [`stable_json`].

mod model;
pub use model::*;

mod run;
pub use run::*;

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::{ContainerTransform, CryptoTransform, OperationStatus};

    fn fixtures_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/wolf")
    }

    fn load() -> WolfProtectionDetectorFixture {
        read_wolf_protection_detector_fixture(
            &fixtures_dir().join("protection-detector.profiles.json"),
        )
        .expect("Wolf detector fixture must parse")
    }

    fn run() -> WolfProtectionDetectorReport {
        run_wolf_protection_detector(&load())
    }

    // --- The whole fixture set is green + records the full acceptance tuple. -

    #[test]
    fn detector_fixture_set_passes_and_records_every_field() {
        let report = run();
        assert_eq!(
            report.status,
            OperationStatus::Passed,
            "{:?}",
            report.entries
        );
        assert!(!report.entries.is_empty());
        for entry in &report.entries {
            assert_eq!(
                entry.status,
                OperationStatus::Passed,
                "record {} failed: {:?}",
                entry.fixture_id,
                entry.findings
            );
            // Acceptance: every record carries engine_family=wolf, variant,
            // container, crypto/protection state, codec, surface, fixture id,
            // secret requirement ids, and diagnostics.
            assert_eq!(entry.engine_family, WOLF_ENGINE_FAMILY);
            assert_eq!(entry.container, ContainerTransform::WolfArchive);
            assert!(!entry.fixture_id.is_empty());
            assert!(!entry.variant.is_empty());
            assert!(!entry.source_node_id.is_empty());
            // The detector never claims extract/patch/helper/runtime.
            assert!(entry.capability_tuple.is_detector_only());
        }
    }

    #[test]
    fn the_four_profiles_are_distinct() {
        let report = run();
        let plain = report.entry("wolf.plain").unwrap();
        let protected = report.entry("wolf.protected").unwrap();
        let helper = report.entry("wolf.helper-required").unwrap();
        let unknown = report.entry("wolf.unknown-variant").unwrap();

        assert_eq!(plain.profile, WolfProtectionProfile::Plain);
        assert_eq!(protected.profile, WolfProtectionProfile::Protected);
        assert_eq!(helper.profile, WolfProtectionProfile::HelperRequired);
        assert_eq!(unknown.profile, WolfProtectionProfile::Unknown);

        // plain!= protected!= helper_required!= unknown.
        let profiles = [
            plain.profile,
            protected.profile,
            helper.profile,
            unknown.profile,
        ];
        for i in 0..profiles.len() {
            for j in (i + 1)..profiles.len() {
                assert_ne!(profiles[i], profiles[j], "profiles must all be distinct");
            }
        }
    }

    #[test]
    fn each_profile_carries_the_correct_capability_tuple() {
        let report = run();
        // Only plain advertises inventory; every profile is identify-level and
        // never claims extract/patch/helper/runtime.
        let plain = report.entry("wolf.plain").unwrap();
        assert!(plain.capability_tuple.identify.is_supported());
        assert!(plain.capability_tuple.inventory.is_supported());

        let protected = report.entry("wolf.protected").unwrap();
        assert!(protected.capability_tuple.identify.is_supported());
        assert!(protected.capability_tuple.inventory.is_unsupported());

        let helper = report.entry("wolf.helper-required").unwrap();
        assert!(helper.capability_tuple.identify.is_supported());
        assert!(helper.capability_tuple.inventory.is_unsupported());

        let unknown = report.entry("wolf.unknown-variant").unwrap();
        assert!(unknown.capability_tuple.identify.is_partial());
        assert!(unknown.capability_tuple.inventory.is_unsupported());

        for entry in &report.entries {
            assert!(entry.capability_tuple.extract.is_unsupported());
            assert!(entry.capability_tuple.patch.is_unsupported());
            assert!(entry.capability_tuple.helper.is_unsupported());
            assert!(entry.capability_tuple.runtime.is_unsupported());
        }
    }

    #[test]
    fn each_profile_carries_the_correct_diagnostics() {
        let report = run();
        // Plain is a clean detection: no diagnostics.
        assert!(report.entry("wolf.plain").unwrap().diagnostics.is_empty());
        // Protected records an unsupported-layered-transform boundary (the key
        // is named, so NOT missing_capability.crypto).
        let protected = report.entry("wolf.protected").unwrap();
        assert_eq!(protected.diagnostics.len(), 1);
        assert_eq!(
            protected.diagnostics[0].semantic_code,
            "kaifuu.unsupported_layered_transform"
        );
        assert!(!protected.secret_requirement_ids.is_empty());
        // Helper-required reports helper_required.
        let helper = report.entry("wolf.helper-required").unwrap();
        assert_eq!(
            helper.diagnostics[0].semantic_code,
            "kaifuu.helper_required"
        );
    }

    // --- Acceptance 4: unknown reports unknown_variant OR
    // missing_capability.crypto (unless a concrete key requirement exists).

    #[test]
    fn unknown_unrecognized_reports_unknown_variant() {
        let report = run();
        let unknown = report.entry("wolf.unknown-variant").unwrap();
        assert_eq!(unknown.profile, WolfProtectionProfile::Unknown);
        assert_eq!(
            unknown.diagnostics[0].semantic_code,
            "kaifuu.unknown_engine_variant"
        );
    }

    #[test]
    fn key_gated_without_requirement_reports_missing_crypto_capability() {
        let report = run();
        let missing = report.entry("wolf.unknown-missing-crypto").unwrap();
        assert_eq!(missing.profile, WolfProtectionProfile::Unknown);
        assert_eq!(
            missing.diagnostics[0].semantic_code,
            "kaifuu.missing_capability.crypto"
        );
    }

    #[test]
    fn a_concrete_key_requirement_lifts_static_key_to_protected() {
        // Pure mechanical rule: static_key_protected is `protected` iff a
        // concrete key requirement exists, else `unknown`.
        assert_eq!(
            derive_wolf_protection_profile(WolfArchiveProtectionSignal::StaticKeyProtected, true),
            WolfProtectionProfile::Protected
        );
        assert_eq!(
            derive_wolf_protection_profile(WolfArchiveProtectionSignal::StaticKeyProtected, false),
            WolfProtectionProfile::Unknown
        );
    }

    #[test]
    fn classifier_is_total_over_all_signals() {
        assert_eq!(
            derive_wolf_protection_profile(WolfArchiveProtectionSignal::Unencrypted, false),
            WolfProtectionProfile::Plain
        );
        assert_eq!(
            derive_wolf_protection_profile(
                WolfArchiveProtectionSignal::DynamicKeyHelperGated,
                true
            ),
            WolfProtectionProfile::HelperRequired
        );
        assert_eq!(
            derive_wolf_protection_profile(
                WolfArchiveProtectionSignal::UnrecognizedProtection,
                false
            ),
            WolfProtectionProfile::Unknown
        );
    }

    #[test]
    fn declared_profile_mismatch_is_a_blocking_finding() {
        let mut fixture = load();
        let entry = fixture
            .entries
            .iter_mut()
            .find(|entry| entry.fixture_id == "wolf.plain")
            .unwrap();
        entry.expected_profile = WolfProtectionProfile::Protected;
        let report = run_wolf_protection_detector(&fixture);
        assert_eq!(report.status, OperationStatus::Failed);
        let plain = report.entry("wolf.plain").unwrap();
        assert_eq!(plain.status, OperationStatus::Failed);
        assert!(
            plain
                .findings
                .iter()
                .any(|f| f.code == "wolf.detector.profile_mismatch")
        );
        // The DERIVED profile still refuses the lie.
        assert_eq!(plain.profile, WolfProtectionProfile::Plain);
    }

    #[test]
    fn crypto_signal_mismatch_is_a_blocking_finding() {
        let mut fixture = load();
        let entry = fixture
            .entries
            .iter_mut()
            .find(|entry| entry.fixture_id == "wolf.protected")
            .unwrap();
        // Claim a plain crypto for a protected signal.
        entry.crypto = CryptoTransform::NullKey;
        let report = run_wolf_protection_detector(&fixture);
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(
            report
                .entry("wolf.protected")
                .unwrap()
                .findings
                .iter()
                .any(|f| f.code == "wolf.detector.crypto_signal_mismatch")
        );
    }

    #[test]
    fn diagnostic_matrix_covers_every_profile() {
        let matrix = wolf_protection_diagnostic_matrix();
        // Plain, Protected, HelperRequired, + two Unknown rows.
        assert_eq!(matrix.len(), 5);
        for profile in WolfProtectionProfile::all() {
            assert!(
                matrix.iter().any(|row| row.profile == profile),
                "matrix missing profile {}",
                profile.as_str()
            );
        }
        // Both acceptance-required unknown diagnostics are represented.
        let unknown_codes: Vec<&str> = matrix
            .iter()
            .filter(|row| row.profile == WolfProtectionProfile::Unknown)
            .flat_map(|row| row.diagnostics.iter().map(|d| d.semantic_code.as_str()))
            .collect();
        assert!(unknown_codes.contains(&"kaifuu.unknown_engine_variant"));
        assert!(unknown_codes.contains(&"kaifuu.missing_capability.crypto"));
        // Every matrix row is detector-only.
        for row in &matrix {
            assert!(row.capability_tuple.is_detector_only());
        }
    }

    #[test]
    fn report_redacts_paths_and_never_carries_raw_key_material() {
        let mut fixture = load();
        fixture.detector_set_id = "/home/trevor/private/wolf/leak.wolf".to_string();
        let report = run_wolf_protection_detector(&fixture);
        let json = report.stable_json().expect("stable json");
        assert!(json.contains("[REDACTED:"));
        assert!(!json.contains("/home/trevor/private/wolf/leak.wolf"));
        // Only requirement ids + local-scheme secret refs appear, never a raw
        // key. (The fixture carries none by construction; assert the scheme.)
        assert!(!json.contains("BEGIN"));
    }
}
