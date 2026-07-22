#[test]
fn archive_detection_bgi_negative_variants_emit_unknown_and_missing_capability_diagnostics() {
    let root = temp_dir("bgi-negative-variants");
    write_fixture_file(
        &root,
        "bse.arc",
        b"BURIKO ARC20\0BGI-ENCRYPTED synthetic BSE marker",
    );
    write_fixture_file(
        &root,
        "dsc.arc",
        b"BURIKO ARC20\0DSC-COMPRESSED synthetic compressed marker",
    );
    write_fixture_file(
        &root,
        "layer.arc",
        b"BURIKO ARC20\0CompressedBG synthetic layered transform marker",
    );

    let report = ArchiveDetectionReport::scan(&root);
    let bgi = detected_archive_row(&report, "bgi-ethornell-containers");

    assert_eq!(
        bgi.detected_variant,
        "buriko-arc20-compressed-bg-layered-transform"
    );
    assert_eq!(bgi.requirements, vec![]);
    assert!(
        bgi.signals
            .contains(&ArchiveDetectionSignal::UnknownVariant)
    );
    assert!(bgi.signals.contains(&ArchiveDetectionSignal::Encrypted));
    assert!(
        bgi.signals
            .contains(&ArchiveDetectionSignal::CryptoUnsupported)
    );
    assert!(bgi.signals.contains(&ArchiveDetectionSignal::Compressed));
    assert!(
        bgi.signals
            .contains(&ArchiveDetectionSignal::LayeredTransform)
    );
    assert!(bgi.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::UnknownEngineVariant
            && diagnostic.required_capability == Some(Capability::Detection)
    }));
    assert!(bgi.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::UnsupportedVariantEncrypted
            && diagnostic.required_capability == Some(Capability::EncryptedInput)
    }));
    // fixture parity: an encrypted (BSE) BGI archive must emit
    // the missing_capability.crypto diagnostic the detector fixtures claim.
    assert!(bgi.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::MissingCryptoCapability
            && diagnostic.required_capability == Some(Capability::CryptoAccess)
    }));
    assert!(bgi.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::MissingCodecCapability
            && diagnostic.required_capability == Some(Capability::CodecAccess)
    }));
    // fixture parity: a CompressedBG/layered BGI archive must
    // emit the unsupported layered-transform diagnostic the fixtures claim.
    assert!(bgi.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::UnsupportedLayeredTransform
            && diagnostic.required_capability == Some(Capability::ContainerAccess)
    }));
    assert!(bgi.capabilities.iter().any(|capability| {
        capability.capability == Capability::EncryptedInput
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(bgi.capabilities.iter().any(|capability| {
        capability.capability == Capability::CryptoAccess
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(bgi.capabilities.iter().any(|capability| {
        capability.capability == Capability::CodecAccess
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(bgi.capabilities.iter().any(|capability| {
        capability.capability == Capability::ContainerAccess
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(bgi.capabilities.iter().any(|capability| {
        capability.capability == Capability::Extraction
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(bgi.capabilities.iter().any(|capability| {
        capability.capability == Capability::Patching
            && capability.status == CapabilityStatus::Unsupported
    }));

    let serialized = serde_json::to_string(&report).unwrap();
    assert!(!serialized.contains("BGI-ENCRYPTED"));
    assert!(!serialized.contains("DSC-COMPRESSED"));
    assert!(!serialized.contains("CompressedBG"));

    let _ = fs::remove_dir_all(root);
}

// strict-proof: the detector fixtures
// (`fixtures/kaifuu/bgi/detector.profiles.json`) claim, per profile, the
// semantic diagnostics BGI containers produce (BSE encrypted =>
// missing_capability.crypto; CompressedBG layered => unsupported_layered_transform,
// etc.). This test proves the LIVE archive detector actually EMITS every
// semantic code those fixtures claim for a synthetic encrypted + compressed
// + layered BGI archive — so the fixtures never claim a diagnostic the live
// detector does not emit (no fixture-vs-detector drift).
#[test]
fn archive_detection_bgi_live_detector_agrees_with_kaifuu_128_fixture_claims() {
    // What the detector fixtures CLAIM, per profile.
    let fixture = read_bgi_detector_fixture(
        &test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/bgi/detector.profiles.json"),
    )
    .expect("BGI detector fixture must parse");
    let fixture_report = run_bgi_detector_fixture(&fixture);
    assert_eq!(fixture_report.status, OperationStatus::Passed);

    let claimed_codes = |fixture_id: &str| -> Vec<SemanticErrorCode> {
        fixture_report
            .entry(fixture_id)
            .unwrap_or_else(|| panic!("missing fixture entry {fixture_id}"))
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.semantic_code)
            .collect()
    };
    let encrypted_claims = claimed_codes("bgi.bse-encrypted-container");
    let layered_claims = claimed_codes("bgi.compressed-bg-layered-transform");
    // Guard the drift class directly: the fixtures must genuinely CLAIM the
    // two codes the audit found missing from the live detector.
    assert!(encrypted_claims.contains(&SemanticErrorCode::MissingCryptoCapability));
    assert!(layered_claims.contains(&SemanticErrorCode::UnsupportedLayeredTransform));

    // What the LIVE archive detector EMITS for the same profiles combined.
    let root = temp_dir("bgi-live-vs-fixture");
    write_fixture_file(
        &root,
        "bse.arc",
        b"BURIKO ARC20\0BGI-ENCRYPTED synthetic BSE marker",
    );
    write_fixture_file(
        &root,
        "dsc.arc",
        b"BURIKO ARC20\0DSC-COMPRESSED synthetic compressed marker",
    );
    write_fixture_file(
        &root,
        "layer.arc",
        b"BURIKO ARC20\0CompressedBG synthetic layered transform marker",
    );
    let report = ArchiveDetectionReport::scan(&root);
    let bgi = detected_archive_row(&report, "bgi-ethornell-containers");
    let live_codes: Vec<SemanticErrorCode> = bgi.diagnostics.iter().map(|d| d.code).collect();

    // Every semantic code the fixtures claim for the encrypted + layered
    // profiles must be emitted by the live detector: fixture ⊆ detector.
    for claimed in encrypted_claims.iter().chain(layered_claims.iter()) {
        assert!(
            live_codes.contains(claimed),
            "fixture claims {claimed:?} but the live BGI detector did not emit it (drift); live emitted {live_codes:?}"
        );
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_genuinely_encrypted_and_compressed_xp3_are_still_detected() {
    // true-positive guard: hardening the marker scan must not
    // break detection of a real synthetic encrypted/compressed XP3, whose
    // subtype token sits on the structural marker line right after the
    // `XP3\r\n` container prefix.
    let encrypted_root = temp_dir("kirikiri-xp3-genuine-encrypted");
    write_fixture_file(
        &encrypted_root,
        "private-route-name.xp3",
        b"XP3\r\nXP3-CRYPT\nkaifuu-xp3-encrypted synthetic fixture\n",
    );
    let report = ArchiveDetectionReport::scan(&encrypted_root);
    let kirikiri = detected_archive_row(&report, "kirikiri-xp3");
    assert_eq!(kirikiri.detected_variant, "xp3-encrypted-archive");
    assert!(
        kirikiri
            .signals
            .contains(&ArchiveDetectionSignal::Encrypted)
    );
    assert!(
        kirikiri.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SemanticErrorCode::UnsupportedVariantEncrypted
        })
    );
    let _ = fs::remove_dir_all(encrypted_root);

    let compressed_root = temp_dir("kirikiri-xp3-genuine-compressed");
    write_fixture_file(
        &compressed_root,
        "private-route-name.xp3",
        b"XP3\r\nXP3-COMPRESSED\nkaifuu-xp3-compressed synthetic fixture\n",
    );
    let report = ArchiveDetectionReport::scan(&compressed_root);
    let kirikiri = detected_archive_row(&report, "kirikiri-xp3");
    assert_eq!(kirikiri.detected_variant, "xp3-compressed-archive");
    assert!(
        kirikiri
            .signals
            .contains(&ArchiveDetectionSignal::Compressed)
    );
    let _ = fs::remove_dir_all(compressed_root);
}

#[test]
fn archive_detection_matrix_includes_reallive_row() {
    let root = temp_dir("reallive-row-present");
    write_fixture_file(&root, "placeholder.txt", b"unrelated");
    let report = ArchiveDetectionReport::scan(&root);
    assert!(
        report
            .rows
            .iter()
            .any(|row| row.row_id == "reallive-seen-txt"),
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_reallive_row_reports_seen_txt_and_gameexe_ini_counts_as_aggregate_evidence() {
    let root = temp_dir("reallive-row-aggregate-evidence");
    write_fixture_file(&root, "SEEN.TXT", b"SEEN\x01");
    write_fixture_file(&root, "SEEN.GAN", b"GAN\x01");
    write_fixture_file(
        &root,
        "Gameexe.ini",
        b"# RealLive Gameexe.ini fixture\n#GAMEEXE_VERSION=1.0\n",
    );
    write_fixture_file(&root, "image.g00", b"\0");
    write_fixture_file(&root, "voice.ovk", b"\0");
    let report = ArchiveDetectionReport::scan(&root);
    let reallive = detected_archive_row(&report, "reallive-seen-txt");
    assert_eq!(reallive.engine_family, ArchiveEngineFamily::RealLive);
    assert_eq!(reallive.detected_variant, "reallive-seen-txt-archive");
    assert!(reallive.signals.contains(&ArchiveDetectionSignal::Packed));
    assert!(reallive.evidence.iter().any(|evidence| {
        evidence.pattern == "SEEN.TXT"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(reallive.evidence.iter().any(|evidence| {
        evidence.pattern == "SEEN.GAN"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(reallive.evidence.iter().any(|evidence| {
        evidence.pattern == "Gameexe.ini"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(reallive.evidence.iter().any(|evidence| {
        evidence.pattern == "*.g00"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(reallive.evidence.iter().any(|evidence| {
        evidence.pattern == "*.ovk|*.koe|*.nwk"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_reallive_row_emits_ambiguous_diagnostic_when_siglus_markers_co_present() {
    let root = temp_dir("reallive-row-ambiguous-siglus");
    write_fixture_file(&root, "SEEN.TXT", b"SEEN\x01");
    write_fixture_file(
        &root,
        "Gameexe.ini",
        b"# RealLive Gameexe.ini fixture\n#GAMEEXE_VERSION=1.0\n",
    );
    write_fixture_file(&root, "Scene.pck", b"SIGLUS-SCENE-PCK");
    write_fixture_file(&root, "Gameexe.dat", b"SIGLUS-GAMEEXE-DAT");
    let report = ArchiveDetectionReport::scan(&root);
    let reallive = report
        .rows
        .iter()
        .find(|row| row.row_id == "reallive-seen-txt")
        .unwrap();
    assert!(!reallive.detected);
    assert_eq!(reallive.detected_variant, "unknown-variant");
    assert!(
        reallive
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::AmbiguousEngineVariant })
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_reallive_row_emits_unsupported_engine_variant_for_avg32_lineage() {
    let root = temp_dir("reallive-row-avg32-lineage");
    write_fixture_file(&root, "SEEN.TXT", b"SEEN\x01");
    write_fixture_file(&root, "image.PDT", b"\0");
    let report = ArchiveDetectionReport::scan(&root);
    let reallive = report
        .rows
        .iter()
        .find(|row| row.row_id == "reallive-seen-txt")
        .unwrap();
    assert!(!reallive.detected);
    assert_eq!(reallive.detected_variant, "unknown-variant");
    assert!(
        reallive
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::UnsupportedEngineVariant })
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_reallive_row_does_not_claim_extraction_or_patch_support() {
    let root = temp_dir("reallive-row-no-extract-claim");
    write_fixture_file(&root, "SEEN.TXT", b"SEEN\x01");
    write_fixture_file(&root, "Gameexe.ini", b"# RealLive Gameexe.ini fixture\n");
    let report = ArchiveDetectionReport::scan(&root);
    let reallive = detected_archive_row(&report, "reallive-seen-txt");
    assert!(reallive.capabilities.iter().any(|capability| {
        capability.capability == Capability::Extraction
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(reallive.capabilities.iter().any(|capability| {
        capability.capability == Capability::Patching
            && capability.status == CapabilityStatus::Unsupported
    }));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rpg_maker_encrypted_suffix_detection_matrix_covers_mv_mz_suffixes() {
    let root = temp_dir("rpg-maker-suffix-matrix");
    for suffix in RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES {
        write_fixture_file(
            &root,
            &format!("encrypted-assets/sample.{suffix}"),
            b"synthetic encrypted RPG Maker asset suffix fixture",
        );
    }

    let report = ArchiveDetectionReport::scan(&root);

    assert_eq!(report.status, ArchiveDetectionStatus::Matched);
    let rpg_maker = detected_archive_row(&report, "rpg-maker-mv-mz-encrypted-assets");
    assert_eq!(rpg_maker.detected_variant, "mv_or_mz");
    assert_eq!(
        rpg_maker.signals,
        vec![
            ArchiveDetectionSignal::Encrypted,
            ArchiveDetectionSignal::MissingKey,
        ]
    );
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES.len() as u64
    }));
    assert!(rpg_maker.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::UnsupportedVariantEncrypted
            && diagnostic.required_capability == Some(Capability::EncryptedInput)
    }));
    assert!(rpg_maker.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::MissingKeyMaterial
            && diagnostic.required_capability == Some(Capability::KeyProfile)
    }));
    assert!(rpg_maker.capabilities.iter().any(|capability| {
        capability.capability == Capability::EncryptedInput
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(rpg_maker.capabilities.iter().any(|capability| {
        capability.capability == Capability::KeyProfile
            && capability.status == CapabilityStatus::RequiresUserInput
    }));
    assert_eq!(rpg_maker.requirements.len(), 1);
    assert_eq!(rpg_maker.requirements[0].key, "rpg-maker-mv-mz-asset-key");
    assert_eq!(
        rpg_maker.surfaces.len(),
        RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES.len()
    );
    for suffix in RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES {
        let surface = rpg_maker
            .surfaces
            .iter()
            .find(|surface| surface.fixture_id.ends_with(suffix))
            .unwrap_or_else(|| panic!("missing surface for suffix {suffix}"));
        assert_eq!(surface.engine_family, "rpg_maker_mv_mz");
        assert_eq!(surface.variant, "mv_or_mz");
        assert_eq!(surface.container, ContainerTransform::ProjectAsset);
        assert_eq!(surface.crypto, CryptoTransform::RpgMakerAssetXor);
        assert_eq!(
            surface.key_requirement_refs,
            vec!["rpg-maker-mv-mz-asset-key"]
        );
        assert!(
            surface
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code == SemanticErrorCode::MissingKeyMaterial })
        );
    }

    let serialized = serde_json::to_string(&report).unwrap();
    assert!(!serialized.contains("sample.rpgmvp"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn rpg_maker_unknown_suffixes_do_not_emit_missing_key_without_known_requirement() {
    let root = temp_dir("rpg-maker-unknown-suffix-matrix");
    for suffix in RPG_MAKER_MV_MZ_UNKNOWN_SUFFIXES {
        write_fixture_file(
            &root,
            &format!("encrypted-assets/sample.{suffix}"),
            b"synthetic unknown RPG Maker-like asset suffix fixture",
        );
    }

    let report = ArchiveDetectionReport::scan(&root);

    assert_eq!(report.status, ArchiveDetectionStatus::Matched);
    let rpg_maker = detected_archive_row(&report, "rpg-maker-mv-mz-encrypted-assets");
    assert_eq!(rpg_maker.detected_variant, "unknown_suffix");
    assert_eq!(
        rpg_maker.signals,
        vec![ArchiveDetectionSignal::UnknownVariant]
    );
    assert!(rpg_maker.requirements.is_empty());
    assert!(
        !rpg_maker
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == SemanticErrorCode::MissingKeyMaterial)
    );
    assert!(
        rpg_maker
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::UnknownEngineVariant })
    );
    assert_eq!(
        rpg_maker.surfaces.len(),
        RPG_MAKER_MV_MZ_UNKNOWN_SUFFIXES.len()
    );
    for surface in &rpg_maker.surfaces {
        assert_eq!(surface.engine_family, "rpg_maker_mv_mz");
        assert_eq!(surface.variant, "unknown_suffix");
        assert_eq!(surface.container, ContainerTransform::ProjectAsset);
        assert_eq!(surface.crypto, CryptoTransform::Unknown);
        assert_eq!(surface.codec, CodecTransform::Unknown);
        assert!(surface.key_requirement_refs.is_empty());
        assert!(
            surface.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == SemanticErrorCode::MissingCryptoCapability
            })
        );
        assert!(
            !surface
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == SemanticErrorCode::MissingKeyMaterial)
        );
    }

    let _ = fs::remove_dir_all(root);
}
