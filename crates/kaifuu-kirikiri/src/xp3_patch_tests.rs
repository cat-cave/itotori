use super::*;
use crate::xp3_crypt::{
    XP3_CRYPT_CONTAINER, XP3_CRYPT_ENGINE_FAMILY, XP3_CRYPT_REQUIREMENT_ID,
    XP3_CRYPT_SCHEMA_VERSION, XP3_CRYPT_VALID_SECRET_REF, build_synthetic_crypt_xp3,
};
use kaifuu_core::CodecTransform;

fn synthetic_fixture() -> Xp3CryptFixture {
    Xp3CryptFixture {
        schema_version: XP3_CRYPT_SCHEMA_VERSION.to_string(),
        fixture_id: "kirikiri-xp3-patch-back-fixture".to_string(),
        source_node_id: "synthetic-fixture".to_string(),
        engine_family: XP3_CRYPT_ENGINE_FAMILY.to_string(),
        container: XP3_CRYPT_CONTAINER.to_string(),
        crypto_profile: Xp3CryptoProfile::XorSimpleCryptFixture,
        codec: CodecTransform::ShiftJisText,
        surface: KirikiriXp3Surface::ScenarioScript,
        secret_requirement_id: XP3_CRYPT_REQUIREMENT_ID.to_string(),
        secret_ref: SecretRef::new(XP3_CRYPT_VALID_SECRET_REF).unwrap(),
        container_source: crate::xp3_crypt::Xp3CryptContainerSource::SyntheticStub,
        expected_member_ids: vec![
            "scenario/intro.ks".to_string(),
            "system/config.txt".to_string(),
        ],
    }
}

#[test]
fn patch_back_round_trip_verifies_against_declared_profile() {
    let report = run_xp3_patch_smoke_from_fixture(
        &synthetic_fixture(),
        &Xp3PatchManifest::fixture_default(),
        Path::new("."),
    )
    .expect("patch-back smoke runs");

    assert!(report.is_ok());
    // Capability output records patch-back mode / crypto profile / coverage.
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

    // Verified against the declared secret requirement id.
    assert_eq!(
        report.verification.secret_requirement_id,
        XP3_CRYPT_REQUIREMENT_ID
    );
    assert!(report.verification.secret_requirement_verified);
    assert!(report.verification.profile_matched);
}

#[test]
fn identity_rebuild_is_byte_identical() {
    let report = run_xp3_patch_smoke_from_fixture(
        &synthetic_fixture(),
        &Xp3PatchManifest::fixture_default(),
        Path::new("."),
    )
    .expect("smoke runs");
    assert!(report.identity.byte_identical);
    assert_eq!(report.identity.source_bytes, report.identity.rebuilt_bytes);
    assert_eq!(
        report.identity.source_hash.as_str(),
        report.identity.rebuilt_hash.as_str()
    );
    // Independent check: the identity rebuild really equals the source.
    assert_eq!(
        report.identity.source_hash.as_str(),
        sha256_hash_bytes(&build_synthetic_crypt_xp3())
    );
}

#[test]
fn trivial_change_applied_and_isolated() {
    let manifest = Xp3PatchManifest::fixture_default();
    let report = run_xp3_patch_smoke_from_fixture(&synthetic_fixture(), &manifest, Path::new("."))
        .expect("smoke runs");
    assert_eq!(report.patch.member_id, "scenario/intro.ks");
    assert!(report.patch.old_present_in_source);
    assert!(report.patch.new_present_in_rebuilt);
    assert!(report.patch.old_absent_in_rebuilt);
    assert!(report.patch.other_members_byte_identical);
    // Length-changing (proves the repack recomputed sizes/offsets).
    let expected_delta =
        manifest.replacements[0].replace.len() as i64 - manifest.replacements[0].find.len() as i64;
    assert_eq!(report.patch.length_delta, expected_delta);
    assert_ne!(report.patch.length_delta, 0);
}

#[test]
fn report_leaks_no_raw_key_or_plaintext() {
    let manifest = Xp3PatchManifest::fixture_default();
    let report = run_xp3_patch_smoke_from_fixture(&synthetic_fixture(), &manifest, Path::new("."))
        .expect("smoke runs");
    let json = report.stable_json().expect("stable json");
    // The old + new synthetic text never appears verbatim (hash-based).
    assert!(!json.contains(&manifest.replacements[0].find));
    assert!(!json.contains(&manifest.replacements[0].replace));
}

#[test]
fn replacement_absent_find_is_typed_error() {
    let manifest = Xp3PatchManifest {
        schema_version: XP3_PATCH_SCHEMA_VERSION.to_string(),
        manifest_id: "bad".to_string(),
        source_node_id: "synthetic-fixture".to_string(),
        replacements: vec![Xp3TextReplacement {
            member_id: "scenario/intro.ks".to_string(),
            find: "this-text-does-not-exist".to_string(),
            replace: "x".to_string(),
        }],
    };
    let err = run_xp3_patch_smoke_from_fixture(&synthetic_fixture(), &manifest, Path::new("."))
        .expect_err("absent find must be a typed error");
    assert!(matches!(
        err,
        Xp3PatchError::ReplacementNotApplicable { occurrences: 0, .. }
    ));
    assert!(err.to_string().starts_with(XP3_PATCH_MARKER));
}

#[test]
fn replacement_unknown_member_is_typed_error() {
    let manifest = Xp3PatchManifest {
        schema_version: XP3_PATCH_SCHEMA_VERSION.to_string(),
        manifest_id: "bad".to_string(),
        source_node_id: "synthetic-fixture".to_string(),
        replacements: vec![Xp3TextReplacement {
            member_id: "no/such/member.ks".to_string(),
            find: "x".to_string(),
            replace: "y".to_string(),
        }],
    };
    let err = run_xp3_patch_smoke_from_fixture(&synthetic_fixture(), &manifest, Path::new("."))
        .expect_err("unknown member must be a typed error");
    assert!(matches!(err, Xp3PatchError::UnknownMember { .. }));
}
