#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::read_json;

    fn manifest_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/rpgmaker")
    }

    fn load_fixture() -> MvMzEncryptedAudioFixture {
        read_json(&manifest_dir().join("encrypted-audio.json"))
            .expect("encrypted-audio manifest must parse")
    }

    fn run(fixture: &MvMzEncryptedAudioFixture) -> MvMzEncryptedAudioReport {
        run_mv_mz_encrypted_audio(MvMzEncryptedAudioRequest {
            fixture,
            fixture_file_name: "encrypted-audio.json",
        })
        .expect("run must not error internally")
    }

    fn entry_mut<'a>(
        fixture: &'a mut MvMzEncryptedAudioFixture,
        entry_id: &str,
    ) -> &'a mut MvMzEncryptedAudioFixtureEntry {
        fixture
            .entries
            .iter_mut()
            .find(|entry| entry.entry_id == entry_id)
            .expect("entry must exist")
    }

    fn has_finding(report: &MvMzEncryptedAudioReport, entry_id: &str, code: &str) -> bool {
        report
            .entry(entry_id)
            .is_some_and(|entry| entry.findings.iter().any(|finding| finding.code == code))
    }

    #[test]
    fn canonical_path_declares_and_validates_every_leg() {
        let path = MvMzEncryptedAudioPath::canonical().unwrap();
        assert_eq!(path.engine_family, "rpg_maker_mv_mz");
        assert_eq!(path.variant, "mv_or_mz");
        assert_eq!(path.container, ContainerTransform::ProjectAsset);
        assert_eq!(path.codec, CodecTransform::OggAudio);
        assert_eq!(
            path.crypto_profile.crypto,
            CryptoTransform::RpgMakerAssetXor
        );
        assert_eq!(path.patch_back, PatchBackTransform::ReplaceAsset);
        assert_eq!(
            path.secret_requirement_ids,
            vec![MV_MZ_ENCRYPTED_AUDIO_REQUIREMENT_ID.to_string()]
        );
        assert_eq!(path.audio_surfaces.len(), 4);
        assert!(!path.diagnostics.is_empty());
        assert_eq!(path.fixture_id, MV_MZ_ENCRYPTED_AUDIO_FIXTURE_ID);
        path.validate().expect("canonical path is consistent");
    }

    #[test]
    fn engine_family_token_matches_image_path() {
        assert_eq!(
            MV_MZ_ENCRYPTED_AUDIO_ENGINE_FAMILY,
            crate::MV_MZ_ENCRYPTED_IMAGE_ENGINE_FAMILY,
            "audio and image paths must share the engine_family token"
        );
        assert_eq!(
            MV_MZ_ENCRYPTED_AUDIO_VARIANT,
            crate::MV_MZ_ENCRYPTED_IMAGE_VARIANT
        );
        assert_eq!(
            MV_MZ_ENCRYPTED_AUDIO_CRYPTO_PROFILE_ID,
            crate::MV_MZ_ENCRYPTED_IMAGE_CRYPTO_PROFILE_ID
        );
        assert_eq!(
            MV_MZ_ENCRYPTED_AUDIO_REQUIREMENT_ID,
            crate::MV_MZ_ENCRYPTED_IMAGE_REQUIREMENT_ID
        );
    }

    #[test]
    fn validate_rejects_non_audio_codec_and_wrong_legs() {
        let mut path = MvMzEncryptedAudioPath::canonical().unwrap();
        path.codec = CodecTransform::PngImage;
        path.patch_back = PatchBackTransform::RewriteJson;
        path.audio_surfaces[0].codec = CodecTransform::PngImage;
        let violations = path.validate().expect_err("must fail");
        assert!(
            violations
                .iter()
                .any(|v| matches!(v, MvMzEncryptedAudioPathViolation::WrongCodec { .. }))
        );
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzEncryptedAudioPathViolation::PatchBackNotReplaceAsset { .. }
        )));
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzEncryptedAudioPathViolation::AudioSurfaceClaimsNonAudioCodec { .. }
        )));
    }

    #[test]
    fn decrypt_re_encrypt_is_byte_correct_round_trip() {
        let key = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT);
        let encrypted = encrypt_synthetic_audio(SYNTHETIC_KEY_CORRECT);
        // The encrypted asset carries the RPGMV header magic.
        assert_eq!(
            &encrypted[..RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()],
            RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER
        );
        let plaintext = decrypt_rpgmaker_asset(&encrypted, &key).expect("decrypts");
        assert_eq!(plaintext, SYNTHETIC_OGG, "decrypt recovers the OGG exactly");
        assert!(is_ogg(&plaintext));
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
    fn wrong_key_decrypt_does_not_yield_an_ogg() {
        let encrypted = encrypt_synthetic_audio(SYNTHETIC_KEY_CORRECT);
        let wrong = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_WRONG);
        let plaintext = decrypt_rpgmaker_asset(&encrypted, &wrong).expect("strips header");
        assert!(!is_ogg(&plaintext), "wrong key must not recover the OGG");
    }

    #[test]
    fn malformed_header_is_a_variant_error() {
        let key = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT);
        assert_eq!(
            decrypt_rpgmaker_asset(SYNTHETIC_OGG, &key).err(),
            Some(MvMzAudioVariantError::MissingHeaderMagic)
        );
        assert_eq!(
            decrypt_rpgmaker_asset(b"RPGMV", &key).err(),
            Some(MvMzAudioVariantError::TooShort)
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
                    .starts_with("kaifuu rpgmaker encrypted-audio --fixture")
            );
            assert_eq!(entry.redaction_status, "redacted");
        }
    }

    #[test]
    fn valid_entry_round_trips_with_matching_hashes() {
        let report = run(&load_fixture());
        let entry = report.entry("audio-valid-bgm").unwrap();
        assert_eq!(entry.outcome, MvMzEncryptedAudioOutcome::RoundTripped);
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
        // The decrypted plaintext is exactly the synthetic OGG.
        assert_eq!(
            proof.decrypted_plaintext_hash.as_str(),
            sha256_hash_bytes(SYNTHETIC_OGG)
        );
        assert_eq!(
            proof.validation.method,
            KeyValidationMethod::FixtureRoundTripProof
        );
        assert_eq!(proof.key_bytes, RPGMAKER_AUDIO_XOR_PREFIX_LEN as u32);
    }

    #[test]
    fn failing_entries_publish_no_patch_artifact() {
        let report = run(&load_fixture());
        for (entry_id, outcome, code) in [
            (
                "audio-wrong-key",
                MvMzEncryptedAudioOutcome::WrongKey,
                FINDING_WRONG_KEY,
            ),
            (
                "audio-missing-key",
                MvMzEncryptedAudioOutcome::MissingKey,
                FINDING_MISSING_KEY,
            ),
            (
                "audio-unsupported-surface-image",
                MvMzEncryptedAudioOutcome::UnsupportedSurface,
                FINDING_UNSUPPORTED_SURFACE,
            ),
            (
                "audio-unsupported-variant",
                MvMzEncryptedAudioOutcome::UnsupportedVariant,
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
        entry_mut(&mut fixture, "audio-wrong-key").expected =
            MvMzEncryptedAudioOutcome::RoundTripped;
        let report = run(&fixture);
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(has_finding(
            &report,
            "audio-wrong-key",
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
            .entry("audio-valid-bgm")
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
        let parsed: MvMzEncryptedAudioReport = serde_json::from_str(&json).expect("round trip");
        assert_eq!(parsed, report.redacted_for_report());
    }
}

