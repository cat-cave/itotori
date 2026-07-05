//! KAIFUU-101 — integration smoke: the profiled XP3 **patch-back** rebuild
//! verification command. It runs from the committed fixture + trivial
//! replacement manifest JSON, extracts the encrypted archive through the
//! declared secret ref, applies the trivial replacement, repacks, and verifies
//! the patch output against the declared fixture profile + secret requirement
//! id — proving the identity rebuild is byte-identical, the trivial change is
//! present, everything else is byte-identical, and the capability records the
//! patch-back mode / crypto profile / coverage.

use std::path::PathBuf;

use kaifuu_core::{OperationStatus, PatchBackTransform};
use kaifuu_kirikiri::xp3_crypt::{XP3_CRYPT_REQUIREMENT_ID, Xp3CryptoProfile};
use kaifuu_kirikiri::xp3_patch::run_xp3_patch_smoke_from_paths;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/kaifuu/kirikiri")
}

/// The rebuild verification command: extract -> apply trivial replacement ->
/// rebuild -> verify against the declared profile + secret requirement id.
#[test]
fn committed_patch_fixture_rebuilds_and_verifies_against_declared_profile() {
    let dir = fixtures_dir();
    let report = run_xp3_patch_smoke_from_paths(
        &dir.join("xp3-patch.json"),
        &dir.join("xp3-patch-manifest.json"),
    )
    .expect("patch-back rebuild verification runs");

    assert_eq!(report.status, OperationStatus::Passed);

    // Verified against the declared secret requirement id.
    assert_eq!(report.secret_requirement_id, XP3_CRYPT_REQUIREMENT_ID);
    assert_eq!(
        report.verification.secret_requirement_id,
        XP3_CRYPT_REQUIREMENT_ID
    );
    assert!(report.verification.secret_requirement_verified);
    assert!(report.verification.profile_matched);

    // Capability records patch-back mode / crypto profile / coverage.
    assert_eq!(
        report.capability.patch_back_mode,
        PatchBackTransform::RepackArchive
    );
    assert_eq!(
        report.capability.crypto_profile,
        Xp3CryptoProfile::XorSimpleCryptFixture
    );
    assert_eq!(report.capability.coverage.total_members, 2);
    assert_eq!(report.capability.coverage.members_patched, 1);
    assert_eq!(report.capability.coverage.members_byte_preserved, 1);
    assert_eq!(report.capability.coverage.replacements_applied, 1);

    // Identity round-trip is byte-identical; the trivial change is present +
    // isolated + length-changing (a real repack).
    assert!(report.identity.byte_identical);
    assert_eq!(report.patch.member_id, "scenario/intro.ks");
    assert!(report.patch.new_present_in_rebuilt);
    assert!(report.patch.old_absent_in_rebuilt);
    assert!(report.patch.other_members_byte_identical);
    assert_ne!(report.patch.length_delta, 0);
}

#[test]
fn committed_patch_report_leaks_no_key_or_plaintext_or_path() {
    let dir = fixtures_dir();
    let report = run_xp3_patch_smoke_from_paths(
        &dir.join("xp3-patch.json"),
        &dir.join("xp3-patch-manifest.json"),
    )
    .expect("patch-back rebuild verification runs");
    let json = report.stable_json().expect("stable json");

    // Secret-ref is disclosed (safe); the raw key never appears.
    assert!(json.contains("local-secret:kaifuu-kirikiri-crypt-fixture-key"));
    assert!(!json.contains("K100-XP3-XORKEY1"));
    assert!(!json.contains("K100-XP3-WRONGKY"));

    // The synthetic member text (old + new) never appears verbatim.
    assert!(!json.contains("[synthetic-kirikiri-xp3-crypt-line-0]"));
    assert!(!json.contains("[localized-kirikiri-xp3-patch-back-line-0-JA]"));

    // No local fixture path leaks.
    assert!(!json.contains("/scratch/"));
    assert!(!json.contains(env!("CARGO_MANIFEST_DIR")));
}
