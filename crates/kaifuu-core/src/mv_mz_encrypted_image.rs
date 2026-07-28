//! RPG Maker MV/MZ encrypted-IMAGE decrypt + re-encrypt path.
//! This is the **encrypted-media** path for RPG Maker MV/MZ named image
//! surfaces. It is mechanically separate from two neighbouring nodes:
//! - ([`crate::mv_mz_readiness`]) is JSON-text inventory only and
//!   hard-pins encrypted media `extractable = false` / `patchable = false`.
//!   THIS node never touches a JSON-text surface and never widens that node's
//!   claims.
//! - ([`crate::encrypted_media_proof`]) is a research-only
//!   *readiness* proof that NEVER decrypts. THIS node is the distinct path
//!   that genuinely decrypts AND re-encrypts an image asset, with a
//!   byte-correct round-trip proof.
//! # The scheme (native Rust, NO shell-out)
//! RPG Maker MV/MZ encrypted images are the standard `RPGMV`-header scheme: a
//! 16-byte [`RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER`] signature is prepended to
//! the asset, and the first 16 bytes of the original PNG are XOR-masked with a
//! 16-byte key derived from `System.json`'s `encryptionKey`. Decryption strips
//! the header and XORs the first 16 body bytes back; re-encryption prepends the
//! header and XORs the first 16 plaintext bytes. XOR is involutive, so a
//! correct key yields a **byte-correct** round-trip
//! (`re_encrypt(decrypt(enc)) == enc`). The implementation is in-process Rust:
//! no `Command::new`, no helper process, no network.
//! # THE LINE (mechanical, not prose)
//! - Raw key bytes live **only** inside the module-private [`ImageAssetKey`]
//!   (redacting `Debug`, zeroizing `Drop`). They are never serialized, logged,
//!   or returned across the module boundary. Reports carry structured
//!   **secret-refs + proof hashes / counts** only.
//! - A re-encrypted patch artifact is produced **only** after a candidate key
//!   decrypts the asset to a valid PNG. Wrong-key, missing-key,
//!   unsupported-surface (audio / JSON), and unsupported-variant
//!   (malformed-header) entries fail **before** any re-encryption — every one
//!   is a structured [`MvMzEncryptedImageFinding`], never a silent skip or a
//!   panic.
//! - Audio and JSON surfaces are explicitly out of scope: an entry whose
//!   `surface_codec` is not [`CodecTransform::PngImage`] is rejected with a
//!   structured `unsupported_surface` finding before any byte is decrypted.
//! # Fixtures are synthetic + public
//! Every byte is synthesised in-module: a tiny real 1x1 PNG ([`SYNTHETIC_PNG`])
//! and a clearly-fake 16-byte key. No retail image bytes and no real keys are
//! ever vendored; the report carries only hashes / counts / secret-refs.

mod path;
pub use path::*;
use path::{
    FINDING_INTERNAL, FINDING_MISSING_KEY, FINDING_OUTCOME_MISMATCH, FINDING_UNSUPPORTED_SURFACE,
    FINDING_UNSUPPORTED_VARIANT, FINDING_WRONG_KEY, SYNTHETIC_KEY_CORRECT, SYNTHETIC_KEY_WRONG,
};

mod model;
pub use model::*;
use model::{ImageAssetKey, is_png};

mod run;
pub use run::{MvMzEncryptedImageRequest, run_mv_mz_encrypted_image};

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::mv_mz_asset_xor::{MvMzAssetKey, decrypt_rpgmaker_asset, encrypt_rpgmaker_asset};
    use crate::read_json;
    use crate::{
        CodecTransform, ContainerTransform, CryptoTransform, KeyValidationMethod, OperationStatus,
        PatchBackTransform, RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER, sha256_hash_bytes,
    };

    fn manifest_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/rpgmaker")
    }

    fn load_fixture() -> MvMzEncryptedImageFixture {
        read_json(&manifest_dir().join("encrypted-image.json"))
            .expect("encrypted-image manifest must parse")
    }

    fn run(fixture: &MvMzEncryptedImageFixture) -> MvMzEncryptedImageReport {
        run_mv_mz_encrypted_image(MvMzEncryptedImageRequest {
            fixture,
            fixture_file_name: "encrypted-image.json",
        })
        .expect("run must not error internally")
    }

    fn entry_mut<'a>(
        fixture: &'a mut MvMzEncryptedImageFixture,
        entry_id: &str,
    ) -> &'a mut MvMzEncryptedImageFixtureEntry {
        fixture
            .entries
            .iter_mut()
            .find(|entry| entry.entry_id == entry_id)
            .expect("entry must exist")
    }

    fn has_finding(report: &MvMzEncryptedImageReport, entry_id: &str, code: &str) -> bool {
        report
            .entry(entry_id)
            .is_some_and(|entry| entry.findings.iter().any(|finding| finding.code == code))
    }

    #[test]
    fn canonical_path_declares_and_validates_every_leg() {
        let path = MvMzEncryptedImagePath::canonical().unwrap();
        assert_eq!(path.engine_family, "rpg_maker_mv_mz");
        assert_eq!(path.variant, "mv_or_mz");
        assert_eq!(path.container, ContainerTransform::ProjectAsset);
        assert_eq!(path.codec, CodecTransform::PngImage);
        assert_eq!(
            path.crypto_profile.crypto,
            CryptoTransform::RpgMakerAssetXor
        );
        assert_eq!(path.patch_back, PatchBackTransform::ReplaceAsset);
        assert_eq!(
            path.secret_requirement_ids,
            vec![MV_MZ_ENCRYPTED_IMAGE_REQUIREMENT_ID.to_string()]
        );
        assert_eq!(path.image_surfaces.len(), 5);
        assert!(!path.diagnostics.is_empty());
        assert_eq!(path.fixture_id, MV_MZ_ENCRYPTED_IMAGE_FIXTURE_ID);
        path.validate().expect("canonical path is consistent");
    }

    #[test]
    fn validate_rejects_non_image_codec_and_wrong_legs() {
        let mut path = MvMzEncryptedImagePath::canonical().unwrap();
        path.codec = CodecTransform::M4aAudio;
        path.patch_back = PatchBackTransform::RewriteJson;
        path.image_surfaces[0].codec = CodecTransform::OggAudio;
        let violations = path.validate().expect_err("must fail");
        assert!(
            violations
                .iter()
                .any(|v| matches!(v, MvMzEncryptedImagePathViolation::WrongCodec { .. }))
        );
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzEncryptedImagePathViolation::PatchBackNotReplaceAsset { .. }
        )));
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzEncryptedImagePathViolation::ImageSurfaceClaimsNonImageCodec { .. }
        )));
    }

    #[test]
    fn decrypt_re_encrypt_is_byte_correct_round_trip() {
        let key = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT);
        let encrypted = encrypt_synthetic_image(SYNTHETIC_KEY_CORRECT);
        // The encrypted asset carries the RPGMV header magic.
        assert_eq!(
            &encrypted[..RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()],
            RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER
        );
        let plaintext = decrypt_rpgmaker_asset(&encrypted, &key).expect("decrypts");
        assert_eq!(plaintext, SYNTHETIC_PNG, "decrypt recovers the PNG exactly");
        assert!(is_png(&plaintext));
        let reencrypted = encrypt_rpgmaker_asset(&plaintext, &key);
        assert_eq!(
            reencrypted, encrypted,
            "re-encrypt reproduces the source bytes (byte-correct)"
        );
        assert_eq!(
            sha256_hash_bytes(&reencrypted),
            sha256_hash_bytes(&encrypted)
        );
    }

    #[test]
    fn wrong_key_decrypt_does_not_yield_a_png() {
        let encrypted = encrypt_synthetic_image(SYNTHETIC_KEY_CORRECT);
        let wrong = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_WRONG);
        let plaintext = decrypt_rpgmaker_asset(&encrypted, &wrong).expect("strips header");
        assert!(!is_png(&plaintext), "wrong key must not recover the PNG");
    }

    #[test]
    fn malformed_header_is_a_variant_error() {
        let key = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT);
        assert_eq!(
            decrypt_rpgmaker_asset(SYNTHETIC_PNG, &key).err(),
            Some(MvMzImageVariantError::MissingHeaderMagic)
        );
        assert_eq!(
            decrypt_rpgmaker_asset(b"RPGMV", &key).err(),
            Some(MvMzImageVariantError::TooShort)
        );
    }

    #[test]
    fn fixture_matrix_passes_and_records_path() {
        let report = run(&load_fixture());
        assert_eq!(
            report.status,
            OperationStatus::Passed,
            "{:?}",
            report.entries
        );
        assert!(!report.source_node_id.is_empty());
        report.path.validate().expect("path is consistent");
        for entry in &report.entries {
            assert_eq!(entry.status, OperationStatus::Passed, "{entry:?}");
            assert!(!entry.source_node_id.is_empty());
            assert!(
                entry
                    .validation_command
                    .starts_with("kaifuu rpgmaker encrypted-image --fixture")
            );
            assert_eq!(entry.redaction_status, "redacted");
        }
    }

    #[test]
    fn valid_entry_round_trips_with_matching_hashes() {
        let report = run(&load_fixture());
        let entry = report.entry("image-valid-pictures").unwrap();
        assert_eq!(entry.outcome, MvMzEncryptedImageOutcome::RoundTripped);
        assert!(entry.round_tripped);
        let proof = entry
            .consumable_proof()
            .expect("round-tripped is consumable");
        assert!(proof.byte_correct_round_trip);
        // Byte-correct: the re-encrypted hash equals the encrypted source hash.
        assert_eq!(
            proof.reencrypted_hash.as_str(),
            proof.encrypted_source_hash.as_str()
        );
        // The decrypted plaintext is exactly the synthetic PNG.
        assert_eq!(
            proof.decrypted_plaintext_hash.as_str(),
            sha256_hash_bytes(SYNTHETIC_PNG)
        );
        assert_eq!(
            proof.validation.method,
            KeyValidationMethod::FixtureRoundTripProof
        );
        assert_eq!(proof.key_bytes, RPGMAKER_IMAGE_XOR_PREFIX_LEN as u32);
    }

    #[test]
    fn failing_entries_publish_no_patch_artifact() {
        let report = run(&load_fixture());
        for (entry_id, outcome, code) in [
            (
                "image-wrong-key",
                MvMzEncryptedImageOutcome::WrongKey,
                FINDING_WRONG_KEY,
            ),
            (
                "image-missing-key",
                MvMzEncryptedImageOutcome::MissingKey,
                FINDING_MISSING_KEY,
            ),
            (
                "image-unsupported-surface-audio",
                MvMzEncryptedImageOutcome::UnsupportedSurface,
                FINDING_UNSUPPORTED_SURFACE,
            ),
            (
                "image-unsupported-variant",
                MvMzEncryptedImageOutcome::UnsupportedVariant,
                FINDING_UNSUPPORTED_VARIANT,
            ),
        ] {
            let entry = report.entry(entry_id).unwrap();
            assert_eq!(entry.outcome, outcome, "{entry_id}");
            assert!(!entry.round_tripped, "{entry_id} must not round-trip");
            assert!(entry.proof.is_none(), "{entry_id} must publish no proof");
            assert!(
                entry.consumable_proof().is_none(),
                "{entry_id} must not be consumable"
            );
            assert!(has_finding(&report, entry_id, code), "{entry_id} finding");
            // The structured finding carries a semantic code.
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
        let mut fixture = load_fixture();
        entry_mut(&mut fixture, "image-wrong-key").expected =
            MvMzEncryptedImageOutcome::RoundTripped;
        let report = run(&fixture);
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(has_finding(
            &report,
            "image-wrong-key",
            FINDING_OUTCOME_MISMATCH
        ));
    }

    #[test]
    fn report_never_carries_raw_key_material() {
        use std::fmt::Write as _;
        let report = run(&load_fixture());
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

        // The proof carries a one-way commitment + count, not the key.
        let proof = report
            .entry("image-valid-pictures")
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
    fn key_debug_is_redacted_and_zeroized() {
        let key = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT);
        let rendered = format!("{key:?}");
        assert!(rendered.contains("REDACTED"));
        assert!(!rendered.contains(&String::from_utf8_lossy(SYNTHETIC_KEY_CORRECT).into_owned()));
    }

    #[test]
    fn report_round_trips_through_stable_json() {
        let report = run(&load_fixture());
        let json = report.stable_json().expect("stable json");
        assert!(json.ends_with('\n'));
        let parsed: MvMzEncryptedImageReport = serde_json::from_str(&json).expect("round trip");
        assert_eq!(parsed, report.redacted_for_report());
    }
}
