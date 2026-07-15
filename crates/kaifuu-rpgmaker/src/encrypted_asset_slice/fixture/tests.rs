use super::super::*;
use super::*;

fn report() -> MvMzSliceReport {
    run_mv_mz_slice(&canonical_slice_fixture(), MV_MZ_SLICE_SOURCE_NODE_ID)
        .expect("slice run must not fault internally")
}

#[test]
fn suffix_routes_every_profiled_extension_to_a_capability() {
    for (name, suffix, cap) in [
        (
            "a.rpgmvp",
            EncryptedAssetSuffix::Rpgmvp,
            MediaCapability::Image,
        ),
        (
            "a.png_",
            EncryptedAssetSuffix::PngUnderscore,
            MediaCapability::Image,
        ),
        (
            "a.rpgmvo",
            EncryptedAssetSuffix::Rpgmvo,
            MediaCapability::Audio,
        ),
        (
            "a.ogg_",
            EncryptedAssetSuffix::OggUnderscore,
            MediaCapability::Audio,
        ),
        (
            "a.rpgmvm",
            EncryptedAssetSuffix::Rpgmvm,
            MediaCapability::Audio,
        ),
        (
            "a.m4a_",
            EncryptedAssetSuffix::M4aUnderscore,
            MediaCapability::Audio,
        ),
    ] {
        let parsed = EncryptedAssetSuffix::parse(name).expect("profiled suffix");
        assert_eq!(parsed, suffix, "{name}");
        assert_eq!(parsed.capability(), cap, "{name}");
    }
    // Case-insensitive.
    assert_eq!(
        EncryptedAssetSuffix::parse("A.RPGMVP").unwrap(),
        EncryptedAssetSuffix::Rpgmvp
    );
}

#[test]
fn off_profile_suffix_is_a_typed_unsupported_error() {
    let err = EncryptedAssetSuffix::parse("a.webm").expect_err("off-profile");
    assert!(matches!(err, MvMzSliceError::UnsupportedSuffix { .. }));
    assert_eq!(err.code(), "kaifuu.rpgmaker.k068.unsupported_suffix");
    let no_suffix = EncryptedAssetSuffix::parse("noextension").expect_err("no suffix");
    assert!(matches!(
        no_suffix,
        MvMzSliceError::UnsupportedSuffix { .. }
    ));
}

#[test]
fn system_json_hex_key_decrypts_and_image_derived_recovers_the_same_key() {
    let report = report();
    let via_hex = report.entry("image-round-trip").unwrap();
    let via_derived = report.entry("image-derived-key").unwrap();
    assert_eq!(via_hex.status, OperationStatus::Passed);
    assert_eq!(via_derived.status, OperationStatus::Passed);
    // Both key sources commit to the SAME key (image-derived recovered it).
    assert_eq!(
        via_hex.verify.as_ref().unwrap().key_material_hash.as_str(),
        via_derived
            .verify
            .as_ref()
            .unwrap()
            .key_material_hash
            .as_str()
    );
    assert_eq!(
        via_hex.verify.as_ref().unwrap().key_material_hash.as_str(),
        sha256_hash_bytes(SLICE_KEY_CORRECT)
    );
    assert_eq!(
        via_derived.verify.as_ref().unwrap().key_source_kind,
        MvMzKeySourceKind::ImageDerived
    );
}

#[test]
fn bad_hex_encryption_key_is_typed_bad_key_material() {
    let bytes = decode_encryption_key_hex("not-hex");
    assert!(matches!(bytes, Err(MvMzSliceError::BadKeyMaterial { .. })));
    // Wrong length is also bad material.
    assert!(matches!(
        decode_encryption_key_hex("00"),
        Err(MvMzSliceError::BadKeyMaterial { .. })
    ));
    // A correct 32-hex key decodes to the 16 bytes.
    let ok = decode_encryption_key_hex(&hex_encode(SLICE_KEY_CORRECT)).unwrap();
    assert_eq!(ok, SLICE_KEY_CORRECT);
}

#[test]
fn slice_matrix_passes_and_records_the_node() {
    let report = report();
    assert_eq!(
        report.status,
        OperationStatus::Passed,
        "{:?}",
        report.entries
    );
    assert_eq!(
        report.source_node_id,
        "rpgmaker-mv-mz-encrypted-asset-slice"
    );
    assert_eq!(report.engine_family, "rpg_maker_mv_mz");
    assert_eq!(report.crypto_profile_id, "rpgmaker/mv_mz/asset_xor_v1");
    for entry in &report.entries {
        assert_eq!(entry.status, OperationStatus::Passed, "{entry:?}");
        assert_eq!(entry.source_node_id, "rpgmaker-mv-mz-encrypted-asset-slice");
        assert!(
            entry
                .validation_command
                .starts_with("kaifuu rpgmaker encrypted-asset-slice --asset")
        );
        assert_eq!(entry.redaction_status, "redacted");
    }
}

#[test]
fn image_and_audio_decrypt_round_trip_with_matching_hashes() {
    let report = report();
    for (entry_id, plaintext) in [
        ("image-round-trip", SYNTHETIC_PNG),
        ("audio-round-trip", SYNTHETIC_OGG),
    ] {
        let entry = report.entry(entry_id).unwrap();
        assert_eq!(entry.outcome, MvMzSliceOutcome::DecryptedRoundTripped);
        assert!(entry.verified);
        let proof = entry.consumable_proof().expect("consumable");
        assert!(proof.decrypt_matches_known);
        assert_eq!(
            proof.decrypted_plaintext_hash.as_str(),
            sha256_hash_bytes(plaintext)
        );
        assert_eq!(
            proof.decrypted_plaintext_hash.as_str(),
            proof.known_plaintext_hash.as_str()
        );
        let round_trip = proof.round_trip.as_ref().expect("round-trip leg");
        assert!(round_trip.byte_correct_round_trip);
        // Byte-correct: the re-encrypted hash equals the encrypted source hash.
        assert_eq!(
            round_trip.reencrypted_hash.as_str(),
            proof.encrypted_source_hash.as_str()
        );
        assert!(proof.patch.is_none());
        assert_eq!(proof.key_bytes, RPGMAKER_ASSET_XOR_PREFIX_LEN as u32);
    }
}

#[test]
fn replacement_patch_applies_and_verifies_for_image_and_audio() {
    let report = report();
    for (entry_id, replacement) in [
        ("image-replace", replacement_image()),
        ("audio-replace", replacement_audio()),
    ] {
        let entry = report.entry(entry_id).unwrap();
        assert_eq!(entry.outcome, MvMzSliceOutcome::Replaced);
        let proof = entry.consumable_proof().expect("consumable");
        let patch = proof.patch.as_ref().expect("patch leg");
        assert!(patch.decrypt_matches_replacement);
        assert!(patch.differs_from_original);
        // decrypt(patched) hashes to exactly the replacement plaintext.
        assert_eq!(
            patch.decrypted_patched_hash.as_str(),
            sha256_hash_bytes(&replacement)
        );
        assert_eq!(
            patch.decrypted_patched_hash.as_str(),
            patch.replacement_plaintext_hash.as_str()
        );
        // The patch genuinely changed the encrypted asset.
        assert_ne!(
            patch.patched_encrypted_hash.as_str(),
            proof.encrypted_source_hash.as_str()
        );
        assert_eq!(
            proof.validation.method,
            KeyValidationMethod::KnownPlaintextProof
        );
    }
}

#[test]
fn no_key_bad_key_unsupported_suffix_and_capability_diff_are_typed() {
    let report = report();
    for (entry_id, outcome, code) in [
        (
            "no-key",
            MvMzSliceOutcome::NoKey,
            "kaifuu.rpgmaker.k068.no_key",
        ),
        (
            "bad-key-material",
            MvMzSliceOutcome::BadKeyMaterial,
            "kaifuu.rpgmaker.k068.bad_key_material",
        ),
        (
            "wrong-key",
            MvMzSliceOutcome::WrongKey,
            "kaifuu.rpgmaker.k068.wrong_key",
        ),
        (
            "unsupported-suffix",
            MvMzSliceOutcome::UnsupportedSuffix,
            "kaifuu.rpgmaker.k068.unsupported_suffix",
        ),
        (
            "capability-diff",
            MvMzSliceOutcome::CapabilityDiff,
            "kaifuu.rpgmaker.k068.capability_diff",
        ),
        (
            "replacement-not-media",
            MvMzSliceOutcome::ReplacementNotMedia,
            "kaifuu.rpgmaker.k068.replacement_not_media",
        ),
    ] {
        let entry = report.entry(entry_id).unwrap();
        assert_eq!(entry.outcome, outcome, "{entry_id}");
        assert!(!entry.verified, "{entry_id} must not verify");
        assert!(entry.verify.is_none(), "{entry_id} must publish no proof");
        assert!(
            entry.consumable_proof().is_none(),
            "{entry_id} must not be consumable"
        );
        let diagnostic = entry.error.as_ref().expect("typed diagnostic");
        assert_eq!(diagnostic.code, code, "{entry_id}");
        assert!(
            diagnostic
                .semantic_code
                .starts_with("kaifuu.rpgmaker.encrypted_asset_slice."),
            "{entry_id}"
        );
        // A correctly-diagnosed failure is a PASSING conformance entry.
        assert_eq!(entry.status, OperationStatus::Passed, "{entry_id}");
    }
}

#[test]
fn validator_fails_on_outcome_mismatch() {
    let mut ops = canonical_slice_fixture();
    for op in &mut ops {
        if op.entry_id == "wrong-key" {
            op.expected = MvMzSliceOutcome::DecryptedRoundTripped;
        }
    }
    let report = run_mv_mz_slice(&ops, MV_MZ_SLICE_SOURCE_NODE_ID).unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    let entry = report.entry("wrong-key").unwrap();
    assert_eq!(entry.status, OperationStatus::Failed);
    // The evidence-derived outcome is still the truthful wrong-key.
    assert_eq!(entry.outcome, MvMzSliceOutcome::WrongKey);
}

#[test]
fn report_never_carries_raw_key_material() {
    let report = report();
    let json = report.stable_json().expect("stable json");
    let key_text = String::from_utf8_lossy(SLICE_KEY_CORRECT);
    assert!(!json.contains(key_text.as_ref()), "raw key leaked");
    // The hex form of the key must not leak either.
    assert!(
        !json.contains(&hex_encode(SLICE_KEY_CORRECT)),
        "raw key hex leaked"
    );
    // The proof carries a one-way commitment + count, not the key.
    let proof = report
        .entry("image-round-trip")
        .unwrap()
        .verify
        .as_ref()
        .unwrap();
    assert_eq!(proof.key_bytes as usize, SLICE_KEY_CORRECT.len());
    assert_eq!(
        proof.key_material_hash.as_str(),
        sha256_hash_bytes(SLICE_KEY_CORRECT)
    );
}

#[test]
fn report_round_trips_through_stable_json() {
    let report = report();
    let json = report.stable_json().expect("stable json");
    assert!(json.ends_with('\n'));
    let parsed: MvMzSliceReport = serde_json::from_str(&json).expect("round trip");
    assert_eq!(parsed, report.redacted_for_report());
}

#[test]
fn image_derived_recovery_recovers_the_exact_key_bytes() {
    let encrypted = encrypted_image();
    let recovered = recover_image_derived_key(&encrypted).expect("recovers");
    assert_eq!(&recovered, SLICE_KEY_CORRECT);
    // A malformed (headerless) asset is a typed malformed-asset error.
    assert!(matches!(
        recover_image_derived_key(SYNTHETIC_PNG),
        Err(MvMzSliceError::MalformedAsset { .. })
    ));
}
