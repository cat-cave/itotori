use super::*;
use std::path::PathBuf;

use crate::{KeyValidationMethod, read_json};

fn manifest_dir() -> PathBuf {
    crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/rpgmaker")
}

fn load_manifest() -> MvMzAssetReplacementManifest {
    read_json(&manifest_dir().join("encrypted-asset-replacement.json"))
        .expect("encrypted-asset-replacement manifest must parse")
}

fn run(manifest: &MvMzAssetReplacementManifest) -> MvMzAssetReplacementReport {
    run_mv_mz_asset_replacement(MvMzAssetReplacementRequest {
        manifest,
        manifest_file_name: "encrypted-asset-replacement.json",
    })
    .expect("run must not error internally")
}

fn entry_mut<'a>(
    manifest: &'a mut MvMzAssetReplacementManifest,
    entry_id: &str,
) -> &'a mut MvMzAssetReplacementEntry {
    manifest
        .entries
        .iter_mut()
        .find(|entry| entry.entry_id == entry_id)
        .expect("entry must exist")
}

fn has_finding(report: &MvMzAssetReplacementReport, entry_id: &str, code: &str) -> bool {
    report
        .entry(entry_id)
        .is_some_and(|entry| entry.findings.iter().any(|finding| finding.code == code))
}

#[test]
fn canonical_path_declares_and_validates_every_leg() {
    let path = MvMzAssetReplacementPath::canonical().unwrap();
    assert_eq!(path.engine_family, "rpg_maker_mv_mz");
    assert_eq!(path.variant, "mv_or_mz");
    assert_eq!(path.container, ContainerTransform::ProjectAsset);
    assert_eq!(
        path.crypto_profile.crypto,
        CryptoTransform::RpgMakerAssetXor
    );
    assert_eq!(path.patch_back, PatchBackTransform::ReplaceAsset);
    assert_eq!(path.media_kinds.len(), 2);
    assert!(!path.diagnostics.is_empty());
    path.validate().expect("canonical path is consistent");
    // Consistency with the image/audio paths: shared crypto profile + key.
    assert_eq!(
        MV_MZ_ASSET_REPLACEMENT_CRYPTO_PROFILE_ID,
        crate::MV_MZ_ENCRYPTED_IMAGE_CRYPTO_PROFILE_ID
    );
    assert_eq!(
        MV_MZ_ASSET_REPLACEMENT_REQUIREMENT_ID,
        crate::MV_MZ_ENCRYPTED_AUDIO_REQUIREMENT_ID
    );
}

#[test]
fn media_kind_extensions_note_mv_vs_mz() {
    assert_eq!(ReplacementMediaKind::Image.mv_extension(), "rpgmvp");
    assert_eq!(ReplacementMediaKind::Image.mz_extension(), "png_");
    assert_eq!(ReplacementMediaKind::Audio.mv_extension(), "rpgmvo");
    assert_eq!(ReplacementMediaKind::Audio.mz_extension(), "ogg_");
}

#[test]
fn validate_rejects_wrong_codec_and_legs() {
    let mut path = MvMzAssetReplacementPath::canonical().unwrap();
    path.patch_back = PatchBackTransform::RewriteJson;
    path.media_kinds[0].codec = CodecTransform::OggAudio;
    let violations = path.validate().expect_err("must fail");
    assert!(violations.iter().any(|v| matches!(
        v,
        MvMzAssetReplacementPathViolation::PatchBackNotReplaceAsset { .. }
    )));
    assert!(violations.iter().any(|v| matches!(
        v,
        MvMzAssetReplacementPathViolation::MediaKindClaimsWrongCodec { .. }
    )));
}

#[test]
fn manifest_matrix_passes_and_records_path() {
    let report = run(&load_manifest());
    assert_eq!(
        report.status,
        OperationStatus::Passed,
        "{:?}",
        report.entries
    );
    assert_eq!(report.source_node_id, load_manifest().source_node_id);
    report.path.validate().expect("path is consistent");
    for entry in &report.entries {
        assert_eq!(entry.status, OperationStatus::Passed, "{entry:?}");
        assert_eq!(entry.source_node_id, report.source_node_id);
        assert!(
            entry
                .validation_command
                .starts_with("kaifuu rpgmaker asset-replacement --manifest")
        );
        assert_eq!(entry.redaction_status, "redacted");
    }
}

// --- Image replacement: encrypt-with-key -> patch -> decrypt==replacement.

#[test]
fn image_replacement_round_trips_and_verifies() {
    let report = run(&load_manifest());
    let entry = report.entry("replace-image-pictures").unwrap();
    assert_eq!(entry.media_kind, ReplacementMediaKind::Image);
    assert_eq!(entry.outcome, MvMzAssetReplacementOutcome::Replaced);
    assert!(entry.replaced);
    let proof = entry.consumable_proof().expect("replaced is consumable");
    assert!(proof.decrypt_matches_replacement);
    assert!(proof.header_correct);
    assert!(proof.tail_bytes_correct);
    assert!(proof.differs_from_original);
    assert!(proof.matches_declared_commitment);
    assert!(proof.key_commitment_matches);
    // decrypt(patched) == replacement == the declared replacement commitment.
    assert_eq!(
        proof.decrypted_patched_hash.as_str(),
        proof.replacement_plaintext_hash.as_str()
    );
    assert_eq!(
        proof.decrypted_patched_hash.as_str(),
        sha256_hash_bytes(&replacement_image())
    );
    // The patch genuinely changed the asset.
    assert_ne!(
        proof.patched_encrypted_hash.as_str(),
        proof.original_encrypted_hash.as_str()
    );
    assert_eq!(
        proof.validation.method,
        KeyValidationMethod::KnownPlaintextProof
    );
}

#[test]
fn audio_replacement_round_trips_and_verifies() {
    let report = run(&load_manifest());
    let entry = report.entry("replace-audio-bgm").unwrap();
    assert_eq!(entry.media_kind, ReplacementMediaKind::Audio);
    assert_eq!(entry.outcome, MvMzAssetReplacementOutcome::Replaced);
    let proof = entry.consumable_proof().expect("replaced is consumable");
    assert!(proof.decrypt_matches_replacement);
    assert!(proof.header_correct);
    assert!(proof.tail_bytes_correct);
    assert!(proof.differs_from_original);
    assert_eq!(
        proof.decrypted_patched_hash.as_str(),
        sha256_hash_bytes(&replacement_audio())
    );
}

#[test]
fn wrong_key_and_tamper_and_more_are_rejected_with_no_consumable_patch() {
    let report = run(&load_manifest());
    for (entry_id, outcome, code) in [
        (
            "replace-image-wrong-key",
            MvMzAssetReplacementOutcome::WrongKeyRejected,
            FINDING_WRONG_KEY,
        ),
        (
            "replace-image-tampered",
            MvMzAssetReplacementOutcome::TamperRejected,
            FINDING_TAMPERED,
        ),
        (
            "replace-audio-tampered",
            MvMzAssetReplacementOutcome::TamperRejected,
            FINDING_TAMPERED,
        ),
        (
            "replace-image-missing-key",
            MvMzAssetReplacementOutcome::MissingKey,
            FINDING_MISSING_KEY,
        ),
        (
            "replace-audio-unsupported-surface",
            MvMzAssetReplacementOutcome::UnsupportedSurface,
            FINDING_UNSUPPORTED_SURFACE,
        ),
        (
            "replace-image-not-media",
            MvMzAssetReplacementOutcome::ReplacementNotMedia,
            FINDING_NOT_MEDIA,
        ),
    ] {
        let entry = report.entry(entry_id).unwrap();
        assert_eq!(entry.outcome, outcome, "{entry_id}");
        assert!(!entry.replaced, "{entry_id} must not replace");
        assert!(entry.proof.is_none(), "{entry_id} must publish no proof");
        assert!(
            entry.consumable_proof().is_none(),
            "{entry_id} must not be consumable"
        );
        assert!(has_finding(&report, entry_id, code), "{entry_id} finding");
        let finding = report
            .entry(entry_id)
            .unwrap()
            .findings
            .iter()
            .find(|finding| finding.code == code)
            .unwrap();
        assert!(finding.semantic_code.is_some(), "{entry_id} semantic code");
    }
}

#[test]
fn validator_fails_on_outcome_mismatch() {
    let mut manifest = load_manifest();
    entry_mut(&mut manifest, "replace-image-wrong-key").expected =
        MvMzAssetReplacementOutcome::Replaced;
    let report = run(&manifest);
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(has_finding(
        &report,
        "replace-image-wrong-key",
        FINDING_OUTCOME_MISMATCH
    ));
}

#[test]
fn manifest_carries_secret_refs_and_commitments_never_raw_key() {
    let manifest = load_manifest();
    for entry in &manifest.entries {
        assert_eq!(
            entry.secret_ref.scheme(),
            crate::SecretRefScheme::LocalSecret
        );
        // A `sha256:` + 64-hex commitment (never raw key material).
        assert!(entry.key_commitment_sha256.starts_with("sha256:"));
        assert_eq!(entry.key_commitment_sha256.len(), "sha256:".len() + 64);
        assert!(entry.replacement_sha256.starts_with("sha256:"));
        assert_eq!(entry.replacement_sha256.len(), "sha256:".len() + 64);
    }
    // The declared key commitment is the sha256 of the fake key, not the key.
    let valid = manifest
        .entries
        .iter()
        .find(|entry| entry.scenario == MvMzAssetReplacementScenario::Valid)
        .unwrap();
    assert_eq!(
        valid.key_commitment_sha256,
        sha256_hash_bytes(SYNTHETIC_KEY_CORRECT)
    );
}

#[test]
fn report_never_carries_raw_key_material() {
    use std::fmt::Write as _;
    let report = run(&load_manifest());
    let json = report.stable_json().expect("stable json");
    let key_text = String::from_utf8_lossy(SYNTHETIC_KEY_CORRECT);
    assert!(!json.contains(key_text.as_ref()), "raw key leaked");
    let key_hex: String = SYNTHETIC_KEY_CORRECT
        .iter()
        .fold(String::new(), |mut acc, byte| {
            let _ = write!(acc, "{byte:02x}");
            acc
        });
    assert!(!json.contains(&key_hex), "raw key hex leaked");

    let proof = report
        .entry("replace-image-pictures")
        .unwrap()
        .proof
        .as_ref()
        .unwrap();
    assert_eq!(proof.key_bytes as usize, SYNTHETIC_KEY_CORRECT.len());
    assert_eq!(
        proof.key_material_hash.as_str(),
        sha256_hash_bytes(SYNTHETIC_KEY_CORRECT)
    );
}

#[test]
fn report_round_trips_through_stable_json() {
    let report = run(&load_manifest());
    let json = report.stable_json().expect("stable json");
    assert!(json.ends_with('\n'));
    let parsed: MvMzAssetReplacementReport = serde_json::from_str(&json).expect("round trip");
    assert_eq!(parsed, report.redacted_for_report());
}

#[test]
fn replacement_media_differs_from_the_original() {
    assert_ne!(replacement_image(), SYNTHETIC_PNG.to_vec());
    assert_ne!(replacement_audio(), SYNTHETIC_OGG.to_vec());
    assert!(ReplacementMediaKind::Image.is_valid_media(&replacement_image()));
    assert!(ReplacementMediaKind::Audio.is_valid_media(&replacement_audio()));
    assert!(!ReplacementMediaKind::Image.is_valid_media(&replacement_not_media_blob()));
}
