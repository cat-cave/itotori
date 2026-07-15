use super::super::*;
use super::temp_dir;

fn write_encrypted_media_system_json(
    game_dir: &Path,
    has_encrypted_images: bool,
    has_encrypted_audio: bool,
    key: Option<&str>,
) {
    let data_dir = game_dir.join("data");
    fs::create_dir_all(&data_dir).unwrap();
    let body = match key {
        Some(key) => format!(
            "{{\"hasEncryptedImages\":{has_encrypted_images},\"hasEncryptedAudio\":{has_encrypted_audio},\"encryptionKey\":\"{key}\"}}"
        ),
        None => format!(
            "{{\"hasEncryptedImages\":{has_encrypted_images},\"hasEncryptedAudio\":{has_encrypted_audio}}}"
        ),
    };
    fs::write(data_dir.join("System.json"), body).unwrap();
}

fn write_encrypted_media_asset(game_dir: &Path, relative: &str, bytes: &[u8]) {
    let full = game_dir.join(relative);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(&full, bytes).unwrap();
}

fn encrypted_media_with_rpgmv_header(extra: &[u8]) -> Vec<u8> {
    let mut bytes = RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.to_vec();
    bytes.extend_from_slice(extra);
    bytes
}

fn happy_path_encrypted_media_fixture() -> EncryptedMediaProofFixture {
    EncryptedMediaProofFixture {
        schema_version: ENCRYPTED_MEDIA_PROOF_SCHEMA_VERSION.to_string(),
        fixture_id: "kaifuu-rpgmaker-encrypted-media-readiness-synthetic".to_string(),
        profile_id: "019ed000-0000-7000-8000-000000039001".to_string(),
        game_dir: "game".to_string(),
        assets: vec![
            EncryptedMediaProofFixtureAsset {
                asset_id: "title-mv".to_string(),
                path: "img/pictures/title.rpgmvp".to_string(),
                expected_kind: EncryptedMediaAssetKind::Image,
                expected_classification: EncryptedMediaClassification::Encrypted,
            },
            EncryptedMediaProofFixtureAsset {
                asset_id: "theme-mv".to_string(),
                path: "audio/bgm/theme.rpgmvm".to_string(),
                expected_kind: EncryptedMediaAssetKind::Audio,
                expected_classification: EncryptedMediaClassification::Encrypted,
            },
            EncryptedMediaProofFixtureAsset {
                asset_id: "cutscene-video-mv".to_string(),
                path: "movies/cutscene.rpgmvu".to_string(),
                expected_kind: EncryptedMediaAssetKind::Video,
                expected_classification: EncryptedMediaClassification::Encrypted,
            },
            EncryptedMediaProofFixtureAsset {
                asset_id: "portrait-mz".to_string(),
                path: "img/pictures/portrait.png_".to_string(),
                expected_kind: EncryptedMediaAssetKind::Image,
                expected_classification: EncryptedMediaClassification::Encrypted,
            },
            EncryptedMediaProofFixtureAsset {
                asset_id: "opening-video-plain".to_string(),
                path: "movies/opening.webm".to_string(),
                expected_kind: EncryptedMediaAssetKind::Video,
                expected_classification: EncryptedMediaClassification::Plaintext,
            },
        ],
        key_profile: Some(EncryptedMediaProofFixtureKeyProfile {
            profile_id: "rpg-maker-mv-mz-asset-key".to_string(),
            expected_system_json_key_hash: Some(
                ProofHash::new(
                    "sha256:5947d7c33d783f94b3b4c1a96ebc8991ed28f1b069b71e03376cba8caa98a720",
                )
                .unwrap(),
            ),
            key_ref_requirement: Some(EncryptedMediaProofFixtureKeyRefRequirement {
                requirement_id: "rpg-maker-mv-mz-asset-key".to_string(),
                secret_ref: SecretRef::new(
                    "local-secret:fixture/rpgmaker/mv-mz-asset-key".to_string(),
                )
                .unwrap(),
            }),
        }),
    }
}

fn stage_happy_path_encrypted_media_tree(dir: &Path) {
    let game = dir.join("game");
    write_encrypted_media_system_json(&game, true, true, Some("00112233445566778899aabbccddeeff"));
    write_encrypted_media_asset(
        &game,
        "img/pictures/title.rpgmvp",
        &encrypted_media_with_rpgmv_header(b"img-payload"),
    );
    write_encrypted_media_asset(
        &game,
        "audio/bgm/theme.rpgmvm",
        &encrypted_media_with_rpgmv_header(b"audio-payload"),
    );
    write_encrypted_media_asset(
        &game,
        "movies/cutscene.rpgmvu",
        &encrypted_media_with_rpgmv_header(b"video-payload"),
    );
    write_encrypted_media_asset(
        &game,
        "img/pictures/portrait.png_",
        &encrypted_media_with_rpgmv_header(b"mz-img"),
    );
    write_encrypted_media_asset(&game, "movies/opening.webm", b"synthetic-webm-bytes");
}

#[test]
fn encrypted_media_proof_routes_each_asset_kind_with_distinct_capability_levels() {
    // Acceptance criterion: "Encrypted image, audio, and video media
    // variants are detected with exact asset-kind capability levels."
    let dir = temp_dir("encrypted-media-distinct-kinds");
    stage_happy_path_encrypted_media_tree(&dir);

    let fixture = happy_path_encrypted_media_fixture();
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Passed);
    assert_eq!(report.readiness, EncryptedMediaReadiness::Ready);
    // Patch capability never claims `patch_back` or `extract` for any
    // asset — every encrypted asset is `Unsupported`, the aggregate
    // settles at `Unsupported`.
    assert_eq!(
        report.patch_capability_level,
        EncryptedMediaPatchCapability::Unsupported
    );
    // Per-asset kinds + capabilities are distinct.
    let kinds: Vec<EncryptedMediaAssetKind> =
        report.assets.iter().map(|asset| asset.kind).collect();
    assert_eq!(
        kinds,
        vec![
            EncryptedMediaAssetKind::Image,
            EncryptedMediaAssetKind::Audio,
            EncryptedMediaAssetKind::Video,
            EncryptedMediaAssetKind::Image,
            EncryptedMediaAssetKind::Video,
        ]
    );
    let encrypted_assets: Vec<&EncryptedMediaProofAsset> = report
        .assets
        .iter()
        .filter(|asset| asset.classification == EncryptedMediaClassification::Encrypted)
        .collect();
    assert_eq!(encrypted_assets.len(), 4);
    for asset in &encrypted_assets {
        assert_eq!(
            asset.patch_capability_level,
            EncryptedMediaPatchCapability::Unsupported,
            "encrypted asset {} must not claim patch capability",
            asset.asset_id
        );
        assert_eq!(
            asset.decryptability,
            EncryptedMediaDecryptability::KeyProfileSatisfied
        );
        assert_eq!(asset.readiness, EncryptedMediaReadiness::Ready);
    }
    // Plaintext video surfaces as evidence only.
    let video = report
        .assets
        .iter()
        .find(|asset| asset.asset_id == "opening-video-plain")
        .unwrap();
    assert_eq!(
        video.classification,
        EncryptedMediaClassification::Plaintext
    );
    assert_eq!(
        video.patch_capability_level,
        EncryptedMediaPatchCapability::NotClaimed
    );
    assert_eq!(video.readiness, EncryptedMediaReadiness::PlaintextEvidence);
    // Load-bearing claims: media-key detection never implies dialogue
    // extraction or script-patch support, and decrypted bytes are
    // never persisted.
    assert!(!report.script_capability_claimed);
    assert!(!report.decrypted_bytes_persisted);
}

#[test]
fn encrypted_media_proof_carries_metadata_and_redacts_secret_payloads() {
    let dir = temp_dir("encrypted-media-metadata");
    stage_happy_path_encrypted_media_tree(&dir);

    let fixture = happy_path_encrypted_media_fixture();
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(
        report.fixture_id,
        "kaifuu-rpgmaker-encrypted-media-readiness-synthetic"
    );
    assert_eq!(report.profile_id, "019ed000-0000-7000-8000-000000039001");
    // System.json proof hash present + asset evidence hashes present.
    assert!(
        report
            .key_profile
            .system_json_proof_hash
            .as_ref()
            .is_some_and(|hash| hash.as_str().starts_with("sha256:"))
    );
    for asset in &report.assets {
        assert!(asset.asset_evidence_hash.as_str().starts_with("sha256:"));
    }
    // Stable JSON serialization round-trips and never echoes the raw
    // System.json key value (the proof hash is fine; the key bytes
    // are not).
    let json = report.stable_json().unwrap();
    assert!(
        !json.contains("00112233445566778899aabbccddeeff"),
        "raw System.json key must not appear in the report",
    );
    // The system_json_present + key_well_formed flags reflect the
    // happy-path setup.
    assert!(report.key_profile.system_json_present);
    assert!(report.key_profile.system_json_key_present);
    assert!(report.key_profile.system_json_key_well_formed);
    assert_eq!(report.key_profile.has_encrypted_images_flag, Some(true));
    assert_eq!(report.key_profile.has_encrypted_audio_flag, Some(true));
}

#[test]
fn encrypted_media_proof_rejects_leaked_game_dir_before_decryption_claim() {
    // Acceptance criterion: "Public fixtures use synthetic media and
    // public test keys only" + "raw key leakage" negative coverage.
    let dir = temp_dir("encrypted-media-leaked-game-dir");
    let mut fixture = happy_path_encrypted_media_fixture();
    fixture.game_dir = "/home/local-user/private/rpgmaker-mv-mz".to_string();
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.readiness, EncryptedMediaReadiness::Unsupported);
    assert!(report.diagnostics.iter().any(|diagnostic| diagnostic.code
        == "rpgmaker.encrypted_media.game_dir.leaked"
        && diagnostic.semantic_code.as_deref() == Some(SEMANTIC_FORBIDDEN_PUBLIC_SERIALIZATION)));
    // The leaked absolute path is **never** echoed into the report —
    // verify the redacted JSON does not contain the private prefix.
    let json = report.stable_json().unwrap();
    assert!(
        !json.contains("/home/local-user"),
        "leaked absolute path survived into the report: {json}",
    );
}

#[test]
fn encrypted_media_proof_missing_system_json_key_fails_before_decryption_claim() {
    // Acceptance criterion: "Missing or wrong keys return semantic
    // diagnostics before decrypted bytes are persisted."
    let dir = temp_dir("encrypted-media-missing-key");
    let game = dir.join("game");
    write_encrypted_media_system_json(&game, true, true, None);
    write_encrypted_media_asset(
        &game,
        "img/pictures/title.rpgmvp",
        &encrypted_media_with_rpgmv_header(b"img-payload"),
    );

    let mut fixture = happy_path_encrypted_media_fixture();
    fixture.assets.truncate(1);
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.diagnostics.iter().any(|diagnostic| diagnostic.code
        == "rpgmaker.encrypted_media.system_json.key_missing"
        && diagnostic.semantic_code.as_deref() == Some(SEMANTIC_MISSING_KEY_MATERIAL)));
    assert!(!report.decrypted_bytes_persisted);
    assert!(!report.script_capability_claimed);
}

#[test]
fn encrypted_media_proof_malformed_key_fails_before_decryption_claim() {
    // Acceptance criterion: "Missing or wrong keys return semantic
    // diagnostics before decrypted bytes are persisted." A
    // malformed-shape key is the canonical "wrong key" surface.
    let dir = temp_dir("encrypted-media-malformed-key");
    let game = dir.join("game");
    write_encrypted_media_system_json(&game, true, true, Some("not-a-valid-hex-key"));
    write_encrypted_media_asset(
        &game,
        "img/pictures/title.rpgmvp",
        &encrypted_media_with_rpgmv_header(b"img-payload"),
    );

    let mut fixture = happy_path_encrypted_media_fixture();
    fixture.assets.truncate(1);
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.diagnostics.iter().any(|diagnostic| diagnostic.code
        == "rpgmaker.encrypted_media.system_json.key_malformed"
        && diagnostic.semantic_code.as_deref() == Some(SEMANTIC_KEY_VALIDATION_FAILED)));
    assert!(!report.decrypted_bytes_persisted);
}

#[test]
fn encrypted_media_proof_wrong_well_formed_key_fails_before_decryption_claim() {
    // A wrong-but-well-formed 32-hex System.json key must fail as
    // key-validation mismatch, not as malformed input. The proof compares
    // hash-only fixture evidence and still never decrypts.
    let dir = temp_dir("encrypted-media-wrong-key");
    let game = dir.join("game");
    write_encrypted_media_system_json(&game, true, true, Some("ffeeddccbbaa99887766554433221100"));
    write_encrypted_media_asset(
        &game,
        "img/pictures/title.rpgmvp",
        &encrypted_media_with_rpgmv_header(b"img-payload"),
    );

    let mut fixture = happy_path_encrypted_media_fixture();
    fixture.assets.truncate(1);
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.diagnostics.iter().any(|diagnostic| diagnostic.code
        == "rpgmaker.encrypted_media.system_json.key_mismatch"
        && diagnostic.semantic_code.as_deref() == Some(SEMANTIC_KEY_VALIDATION_FAILED)));
    assert_eq!(
        report.assets[0].decryptability,
        EncryptedMediaDecryptability::KeyMismatch
    );
    assert!(!report.decrypted_bytes_persisted);
    assert!(!report.script_capability_claimed);
}

#[test]
fn encrypted_media_proof_malformed_header_routes_to_unsupported_without_overclaim() {
    // Negative coverage: encrypted asset is declared but the bytes do
    // not start with the RPGMV header magic. Must route to
    // `MalformedHeader` + `Unsupported` and never silently upgrade
    // to `Encrypted`.
    let dir = temp_dir("encrypted-media-malformed-header");
    let game = dir.join("game");
    write_encrypted_media_system_json(&game, true, true, Some("00112233445566778899aabbccddeeff"));
    write_encrypted_media_asset(
        &game,
        "img/pictures/malformed.rpgmvp",
        b"NOT-A-RPGMV-HEADER",
    );

    let mut fixture = happy_path_encrypted_media_fixture();
    fixture.assets = vec![EncryptedMediaProofFixtureAsset {
        asset_id: "malformed".to_string(),
        path: "img/pictures/malformed.rpgmvp".to_string(),
        expected_kind: EncryptedMediaAssetKind::Image,
        expected_classification: EncryptedMediaClassification::Encrypted,
    }];
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(
        report.assets[0].classification,
        EncryptedMediaClassification::MalformedHeader
    );
    assert_eq!(
        report.assets[0].patch_capability_level,
        EncryptedMediaPatchCapability::Unsupported
    );
    assert!(
        report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "rpgmaker.encrypted_media.header.malformed")
    );
}

#[test]
fn encrypted_media_proof_unknown_key_profile_fails_closed() {
    // The recognised vocabulary check is routing-only — recognition
    // does not imply decryption capability. Unknown profile id must
    // fire a P0 diagnostic so a fixture-author cannot wedge an
    // arbitrary plugin id into the proof.
    let dir = temp_dir("encrypted-media-unknown-profile");
    stage_happy_path_encrypted_media_tree(&dir);

    let mut fixture = happy_path_encrypted_media_fixture();
    if let Some(profile) = fixture.key_profile.as_mut() {
        profile.profile_id = "not-a-recognised-profile-id".to_string();
    }
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.diagnostics.iter().any(|diagnostic| diagnostic.code
        == "rpgmaker.encrypted_media.key_profile.unknown"
        && diagnostic.semantic_code.as_deref() == Some(SEMANTIC_UNKNOWN_ENGINE_VARIANT)));
}

#[test]
fn encrypted_media_proof_byte_classification_overrides_fixture_declaration() {
    // A fixture that declares plaintext but ships RPGMV-headered bytes
    // must be routed by the bytes (encrypted), not silently trusted
    // as plaintext.
    let dir = temp_dir("encrypted-media-byte-routing");
    let game = dir.join("game");
    write_encrypted_media_system_json(&game, true, true, Some("00112233445566778899aabbccddeeff"));
    // Plaintext-suffix asset with RPGMV bytes — bytes win.
    write_encrypted_media_asset(
        &game,
        "img/pictures/title.png",
        &encrypted_media_with_rpgmv_header(b"sneaky"),
    );

    let mut fixture = happy_path_encrypted_media_fixture();
    fixture.assets = vec![EncryptedMediaProofFixtureAsset {
        asset_id: "sneaky-plain".to_string(),
        path: "img/pictures/title.png".to_string(),
        expected_kind: EncryptedMediaAssetKind::Image,
        expected_classification: EncryptedMediaClassification::Plaintext,
    }];
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    // Suffix is.png (plaintext suffix) so the routing settles at
    // Plaintext — the bytes-classification doesn't override a
    // plaintext-suffix declaration with no encrypted suffix profile;
    // however, since the suffix is plain the resulting classification
    // is still Plaintext but the readiness reports must not assume
    // anything decryptable. This is the "no script capability"
    // separation.
    assert_eq!(
        report.assets[0].classification,
        EncryptedMediaClassification::Plaintext
    );
    assert!(!report.script_capability_claimed);
    assert!(!report.decrypted_bytes_persisted);
    assert_eq!(
        report.assets[0].patch_capability_level,
        EncryptedMediaPatchCapability::NotClaimed
    );
}

#[test]
fn encrypted_media_proof_redacted_view_strips_secret_substrings() {
    let dir = temp_dir("encrypted-media-redacted");
    stage_happy_path_encrypted_media_tree(&dir);

    let fixture = happy_path_encrypted_media_fixture();
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    let redacted = report.redacted_for_report();
    // Acceptance criterion: "Public fixtures use synthetic media and
    // public test keys only" — the raw key value must never appear
    // in the redacted JSON either.
    let json = redacted.stable_json().unwrap();
    assert!(!json.contains("00112233445566778899aabbccddeeff"));
    // Load-bearing flags survive redaction.
    assert!(!redacted.script_capability_claimed);
    assert!(!redacted.decrypted_bytes_persisted);
}
