use super::*;

#[test]
fn xp3_profile_records_cover_plain_encrypted_compressed_and_unknown_cases() {
    let cases: &[(&str, &[u8], &str)] = &[
        (
            "xp3-plain",
            b"XP3\r\nfixture-only plain archive",
            "xp3-plain-container",
        ),
        (
            "xp3-encrypted",
            b"XP3\r\nXP3-CRYPT\nfixture-only encrypted archive",
            "xp3-encrypted-container",
        ),
        (
            "xp3-compressed",
            b"XP3\r\nXP3-COMPRESSED\nfixture-only compressed archive",
            "xp3-compressed-container",
        ),
    ];
    let adapter = Xp3ProfileDetectorAdapter;

    for (name, bytes, variant) in cases {
        let game_dir = xp3_fixture_dir(name, bytes);
        let detection = adapter
            .detect(DetectRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        assert!(detection.detected, "{variant} should be detected");
        assert_eq!(detection.engine_family.as_deref(), Some("kiri_kiri_xp3"));
        assert_eq!(detection.detected_variant.as_deref(), Some(*variant));

        let profile = adapter
            .profile(ProfileRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        assert_eq!(profile.engine.adapter_id, XP3_DETECTOR_ADAPTER_ID);
        assert_eq!(profile.engine.detected_variant, *variant);
        let validation = profile.validate();
        assert_eq!(
            validation.status,
            OperationStatus::Passed,
            "{:?}",
            validation.failures
        );
        assert!(profile.archive_parameters.iter().any(|parameter| {
            parameter.kind == ArchiveParameterKind::ArchiveFormat && parameter.value == "xp3"
        }));
        assert!(profile.capabilities.iter().any(|capability| {
            capability.capability == Capability::Extraction
                && capability.status == CapabilityStatus::Unsupported
        }));
        assert!(
            profile
                .metadata
                .get("supportBoundary")
                .unwrap()
                .contains("not claimed")
        );
        if *variant == "xp3-encrypted-container" {
            assert!(detection.requirements.iter().any(|requirement| {
                requirement.key == "kirikiri-xp3-key-profile"
                    && requirement.status == RequirementStatus::Missing
            }));
            assert_eq!(profile.key_requirements.len(), 1);
            assert!(profile.requirements.iter().any(|requirement| {
                requirement.key == "kirikiri-xp3-key-profile"
                    && requirement.status == RequirementStatus::NotRequired
            }));
        } else {
            assert!(profile.key_requirements.is_empty());
        }
        if *variant == "xp3-compressed-container" {
            assert!(
                profile
                    .archive_parameters
                    .iter()
                    .any(|parameter| { parameter.kind == ArchiveParameterKind::Compression })
            );
        }

        let _ = fs::remove_dir_all(game_dir);
    }

    let unknown_dir = xp3_fixture_dir(
        "xp3-unknown",
        b"XP3\r\nXP3-UNKNOWN-VARIANT\nfixture-only unknown archive",
    );
    let unknown_detection = adapter
        .detect(DetectRequest {
            game_dir: &unknown_dir,
        })
        .unwrap();
    assert!(!unknown_detection.detected);
    assert_eq!(
        unknown_detection.detected_variant.as_deref(),
        Some("xp3-unknown-container")
    );
    assert!(unknown_detection.requirements.iter().any(|requirement| {
        requirement.key == "xp3-synthetic-profile-marker"
            && requirement.status == RequirementStatus::Unsupported
    }));
    let unknown_failure = adapter_failure_from_error(
        adapter
            .profile(ProfileRequest {
                game_dir: &unknown_dir,
            })
            .unwrap_err(),
    );
    assert_eq!(unknown_failure.error_code, "kaifuu.unknown_engine_variant");
    assert_eq!(
        unknown_failure.required_capability,
        Some(Capability::Detection)
    );

    let _ = fs::remove_dir_all(unknown_dir);
}

#[test]
fn xp3_plain_inventory_reports_file_entries_sizes_hashes_and_profile_id() {
    let game_dir = xp3_fixture_dir(
        "xp3-plain-inventory",
        &plain_xp3_fixture(&[
            Xp3TestEntry {
                path: "scenario/intro.ks",
                payload: b"hello xp3",
                compressed: false,
                adler32: 0x1111_2222,
            },
            Xp3TestEntry {
                path: "scenario/compressed.ks",
                payload: b"compressed payload bytes",
                compressed: true,
                adler32: 0x3333_4444,
            },
        ]),
    );

    let inventory = Xp3ProfileDetectorAdapter
        .asset_inventory(AssetInventoryRequest {
            game_dir: &game_dir,
        })
        .unwrap();

    assert_eq!(inventory.validate().status, OperationStatus::Passed);
    assert_eq!(inventory.assets.len(), 3);
    assert_eq!(inventory.assets[0].asset_key, XP3_ARCHIVE_PATH);
    assert_eq!(
        inventory.assets[0]
            .metadata
            .get("profileId")
            .map(String::as_str),
        Some("019ed000-0000-7000-8000-000000095001")
    );
    let compressed = inventory
        .assets
        .iter()
        .find(|asset| asset.asset_key == "scenario/compressed.ks")
        .unwrap();
    assert_eq!(compressed.asset_kind, AssetInventoryAssetKind::Script);
    let compressed_hash = sha256_hash_bytes(b"compressed payload bytes");
    assert_eq!(
        compressed.source_hash.as_deref(),
        Some(compressed_hash.as_str())
    );
    assert_eq!(
        compressed.metadata.get("originalSize").map(String::as_str),
        Some("24")
    );
    assert_eq!(
        compressed.metadata.get("archiveSize").map(String::as_str),
        Some("24")
    );
    assert_eq!(
        compressed.metadata.get("compressed").map(String::as_str),
        Some("true")
    );
    assert_eq!(
        compressed.metadata.get("storedAdler32").map(String::as_str),
        Some("adler32:33334444")
    );

    let plain = inventory
        .assets
        .iter()
        .find(|asset| asset.asset_key == "scenario/intro.ks")
        .unwrap();
    assert_eq!(
        plain.metadata.get("compressed").map(String::as_str),
        Some("false")
    );

    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn xp3_plain_profile_marker_detection_ignores_member_payload_substrings() {
    let game_dir = xp3_fixture_dir(
        "xp3-plain-payload-marker",
        &plain_xp3_fixture(&[Xp3TestEntry {
            path: "scenario/intro.ks",
            payload: b"dialogue mentions XP3-CRYPT as literal text",
            compressed: false,
            adler32: 0,
        }]),
    );

    let detection = Xp3ProfileDetectorAdapter
        .detect(DetectRequest {
            game_dir: &game_dir,
        })
        .unwrap();

    assert!(detection.detected);
    assert_eq!(
        detection.detected_variant.as_deref(),
        Some("xp3-plain-container")
    );

    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn xp3_encrypted_and_helper_required_inventory_stop_with_diagnostics() {
    let encrypted_dir = xp3_fixture_dir(
        "xp3-encrypted-inventory",
        b"XP3\r\nXP3-CRYPT\nfixture-only encrypted archive",
    );
    let encrypted_failure = adapter_failure_from_error(
        Xp3ProfileDetectorAdapter
            .asset_inventory(AssetInventoryRequest {
                game_dir: &encrypted_dir,
            })
            .unwrap_err(),
    );
    assert_eq!(
        encrypted_failure.error_code,
        "kaifuu.missing_capability.crypto"
    );

    let helper_dir = xp3_fixture_dir(
        "xp3-helper-required-inventory",
        b"XP3\r\nXP3-HELPER-REQUIRED\nfixture-only helper archive",
    );
    let helper_failure = adapter_failure_from_error(
        Xp3ProfileDetectorAdapter
            .extract(ExtractRequest {
                game_dir: &helper_dir,
            })
            .unwrap_err(),
    );
    assert_eq!(helper_failure.error_code, "kaifuu.helper_required");

    let _ = fs::remove_dir_all(encrypted_dir);
    let _ = fs::remove_dir_all(helper_dir);
}

#[test]
fn xp3_extract_returns_serialized_semantic_boundary_failure() {
    let game_dir = xp3_fixture_dir(
        "xp3-extract-boundary",
        b"XP3\r\nXP3-COMPRESSED\nfixture-only compressed archive",
    );
    let failure = adapter_failure_from_error(
        Xp3ProfileDetectorAdapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap_err(),
    );

    assert_eq!(failure.error_code, "kaifuu.missing_capability.container");
    assert_eq!(
        failure.required_capability,
        Some(Capability::ContainerAccess)
    );
    assert_eq!(failure.asset_ref.as_deref(), Some(XP3_ARCHIVE_PATH));
    assert!(!failure.support_boundary.is_empty());

    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn xp3_extract_and_patch_wording_distinguishes_index_parsing_from_payload_extraction() {
    // Regression: plain XP3 inventory now parses the index /
    // entry metadata, so the extract + patch boundary failures must NOT
    // imply archive entry parsing is entirely absent. They must say the
    // metadata IS parsed, while extraction / decompression / decryption of
    // the payload is what is out of scope for this detector profile.
    let game_dir = xp3_fixture_dir(
        "xp3-boundary-wording",
        &plain_xp3_fixture(&[Xp3TestEntry {
            path: "scenario/intro.ks",
            payload: b"hello xp3",
            compressed: false,
            adler32: 0x1111_2222,
        }]),
    );

    let extract_failure = adapter_failure_from_error(
        Xp3ProfileDetectorAdapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap_err(),
    );
    let boundary = extract_failure.support_boundary.clone();
    // The stale claim ("entry parsing is entirely absent") is gone.
    assert!(
        !boundary.contains("archive entry parsing is outside"),
        "stale entry-parsing-absent wording still present: {boundary}"
    );
    // Metadata parsing is acknowledged as done...
    assert!(
        boundary.contains("metadata is parsed for inventory"),
        "boundary must acknowledge index/entry metadata parsing: {boundary}"
    );
    // ...while payload extraction / decompression / decryption is the limit.
    for out_of_scope in ["extraction", "decompression", "decryption"] {
        assert!(
            boundary.contains(out_of_scope),
            "boundary must name {out_of_scope} as out of scope: {boundary}"
        );
    }

    // --- patch: same container-boundary distinction + a separate
    // patch-back (rebuild) failure. ---
    let output_dir = game_dir.join("patched");
    let patch = Xp3ProfileDetectorAdapter
        .patch(PatchRequest {
            game_dir: &game_dir,
            patch_export: &PatchExport {
                patch_export_id: deterministic_id("xp3-boundary-patch", 95),
                source_locale: "ja-JP".to_string(),
                target_locale: "en-US".to_string(),
                entries: vec![],
            },
            output_dir: &output_dir,
        })
        .unwrap();
    assert_eq!(patch.status, OperationStatus::Failed);
    // The container-boundary failure carries the metadata-parsed / payload-out
    // distinction, never the stale "entry parsing is outside" claim.
    assert!(
        patch.failures.iter().any(|failure| {
            failure
                .support_boundary
                .contains("metadata is parsed for inventory")
                && failure.support_boundary.contains("extraction")
                && !failure
                    .support_boundary
                    .contains("archive entry parsing is outside")
        }),
        "patch container-boundary wording not updated: {:?}",
        patch.failures
    );
    // Patch-back / repack (rebuild) is separately reported as unimplemented.
    assert!(
        patch.failures.iter().any(|failure| failure
            .support_boundary
            .contains("patch-back/repack support is not implemented")),
        "patch must still report rebuild support out of scope: {:?}",
        patch.failures
    );

    // --- inventory support-boundary snapshot: distinguishes index parsing
    // from payload extraction / decompression / decryption. ---
    let contract = Xp3ProfileDetectorAdapter
        .capabilities()
        .access_contract
        .expect("XP3 adapter declares a layered access contract");
    let inventory_boundary = contract
        .inventory
        .support_boundary
        .expect("plain XP3 inventory declares a support boundary");
    assert!(
        inventory_boundary.contains("index metadata"),
        "inventory boundary must acknowledge index metadata parsing: {inventory_boundary}"
    );
    assert!(
        inventory_boundary.contains("extraction")
            && inventory_boundary.contains("decompression")
            && inventory_boundary.contains("decryption")
            && inventory_boundary.contains("patch-back are unsupported"),
        "inventory boundary must name payload extraction as out of scope: {inventory_boundary}"
    );

    let _ = fs::remove_dir_all(game_dir);
}
