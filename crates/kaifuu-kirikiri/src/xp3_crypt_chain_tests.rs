use super::*;
use crate::xp3_crypt::{
    XP3_CRYPT_REQUIREMENT_ID, XP3_CRYPT_SCHEMA_VERSION, XP3_CRYPT_VALID_SECRET_REF,
    Xp3CryptContainerSource, build_synthetic_crypt_xp3,
};
use kaifuu_core::{CodecTransform, PatchBackTransform};

fn synthetic_fixture() -> Xp3CryptFixture {
    Xp3CryptFixture {
        schema_version: XP3_CRYPT_SCHEMA_VERSION.to_string(),
        fixture_id: "kirikiri-xp3-crypt-chain-fixture".to_string(),
        source_node_id: "xp3-crypt-chain-smoke".to_string(),
        engine_family: XP3_CRYPT_ENGINE_FAMILY.to_string(),
        container: XP3_CRYPT_CONTAINER.to_string(),
        crypto_profile: Xp3CryptoProfile::XorSimpleCryptFixture,
        codec: CodecTransform::ShiftJisText,
        surface: crate::xp3_crypt::KirikiriXp3Surface::ScenarioScript,
        secret_requirement_id: XP3_CRYPT_REQUIREMENT_ID.to_string(),
        secret_ref: SecretRef::new(XP3_CRYPT_VALID_SECRET_REF).unwrap(),
        container_source: Xp3CryptContainerSource::SyntheticStub,
        expected_member_ids: vec![
            "scenario/intro.ks".to_string(),
            "system/config.txt".to_string(),
        ],
    }
}

#[test]
fn full_chain_runs_every_stage_in_order() {
    let report = run_xp3_crypt_chain_smoke_from_fixture(
        &synthetic_fixture(),
        &Xp3PatchManifest::fixture_default(),
        Path::new("."),
    )
    .expect("chain smoke runs");

    assert!(report.is_ok());
    // The stage ledger carries all seven stages, in order, all Passed.
    let stages: Vec<Xp3ChainStage> = report.stages.iter().map(|o| o.stage).collect();
    assert_eq!(stages, Xp3ChainStage::ordered().to_vec());
    assert!(
        report
            .stages
            .iter()
            .all(|o| o.status == OperationStatus::Passed)
    );
}

#[test]
fn detect_is_magic_byte_not_filename() {
    let container = build_synthetic_crypt_xp3();
    let detect = detect_xp3_container(&container, Xp3CryptoProfile::XorSimpleCryptFixture).unwrap();
    assert!(detect.magic_matched);
    assert_eq!(detect.detected_by, XP3_CHAIN_DETECTED_BY);
    assert_eq!(detect.container, XP3_CRYPT_CONTAINER);
    assert_eq!(detect.engine_family, XP3_CRYPT_ENGINE_FAMILY);
    // The magic hash commits to the public XP3 magic prefix.
    assert_eq!(
        detect.container_magic_hash.as_str(),
        sha256_hash_bytes(XP3_PLAIN_MAGIC)
    );
}

#[test]
fn detect_refuses_non_xp3_bytes() {
    let err = detect_xp3_container(
        b"not-an-xp3-archive",
        Xp3CryptoProfile::XorSimpleCryptFixture,
    )
    .expect_err("non-XP3 bytes must be refused");
    assert!(matches!(err, Xp3ChainError::ContainerNotDetected));
    assert!(err.to_string().starts_with(XP3_CHAIN_MARKER));
}

#[test]
fn profile_resolves_key_through_keyref_without_embedding_it() {
    let report = run_xp3_crypt_chain_smoke_from_fixture(
        &synthetic_fixture(),
        &Xp3PatchManifest::fixture_default(),
        Path::new("."),
    )
    .expect("chain smoke runs");
    assert!(report.profile_resolve.resolved);
    assert_eq!(
        report.profile_resolve.secret_requirement_id,
        XP3_CRYPT_REQUIREMENT_ID
    );
    assert_eq!(
        report.profile_resolve.secret_ref.as_str(),
        XP3_CRYPT_VALID_SECRET_REF
    );
    // Key is a one-way commitment + length only.
    assert_eq!(report.profile_resolve.key_bytes, 16);
}

#[test]
fn delta_evidence_is_hash_based_and_records_the_change() {
    let manifest = Xp3PatchManifest::fixture_default();
    let report =
        run_xp3_crypt_chain_smoke_from_fixture(&synthetic_fixture(), &manifest, Path::new("."))
            .expect("chain smoke runs");
    let delta = &report.delta;
    assert_eq!(delta.format, XP3_CHAIN_DELTA_FORMAT);
    assert_eq!(delta.members.len(), 2);
    assert_eq!(delta.members_changed, 1);
    assert_eq!(delta.members_unchanged, 1);
    // The source and rebuilt containers differ (a real repack happened).
    assert_ne!(
        delta.source_container_hash.as_str(),
        delta.rebuilt_container_hash.as_str()
    );
    // The changed member records a non-zero length delta.
    let changed = delta
        .members
        .iter()
        .find(|m| m.operation == Xp3ChainDeltaOperation::Replace)
        .expect("one member changed");
    assert_eq!(changed.member_id, "scenario/intro.ks");
    assert_ne!(changed.length_delta, 0);
    assert_ne!(
        changed.source_plaintext_hash.as_str(),
        changed.target_plaintext_hash.as_str()
    );
    // The unchanged member is byte-identical across the rebuild.
    let unchanged = delta
        .members
        .iter()
        .find(|m| m.operation == Xp3ChainDeltaOperation::Unchanged)
        .expect("one member unchanged");
    assert_eq!(
        unchanged.source_plaintext_hash.as_str(),
        unchanged.target_plaintext_hash.as_str()
    );
    assert_eq!(unchanged.length_delta, 0);
}

#[test]
fn embedded_patch_back_verifies_against_declared_profile() {
    let report = run_xp3_crypt_chain_smoke_from_fixture(
        &synthetic_fixture(),
        &Xp3PatchManifest::fixture_default(),
        Path::new("."),
    )
    .expect("chain smoke runs");
    assert!(report.patch_back.is_ok());
    assert!(report.patch_back.identity.byte_identical);
    assert!(report.patch_back.verification.secret_requirement_verified);
    assert_eq!(
        report.patch_back.capability.patch_back_mode,
        PatchBackTransform::RepackArchive
    );
}

#[test]
fn report_leaks_no_raw_key_no_plaintext_no_path() {
    let manifest = Xp3PatchManifest::fixture_default();
    let report =
        run_xp3_crypt_chain_smoke_from_fixture(&synthetic_fixture(), &manifest, Path::new("."))
            .expect("chain smoke runs");
    let json = report.stable_json().expect("stable json");

    // Secret ref is disclosed (safe); the raw key never appears.
    assert!(json.contains("local-secret:kaifuu-kirikiri-crypt-fixture-key"));
    assert!(!json.contains("K100-XP3-XORKEY1"));
    assert!(!json.contains("K100-XP3-WRONGKY"));

    // Decrypted plaintext (old + new synthetic text) never appears verbatim.
    assert!(!json.contains(&manifest.replacements[0].find));
    assert!(!json.contains(&manifest.replacements[0].replace));

    // No local fixture path leaks into the report.
    assert!(!json.contains("/scratch/"));
}
