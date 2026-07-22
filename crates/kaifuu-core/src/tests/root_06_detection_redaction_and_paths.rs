#[test]
fn archive_detection_normalizes_marker_only_subtypes_to_unknown_variant_diagnostics() {
    let root = temp_dir("archive-marker-only");
    let marker_only_fixtures: &[(&str, &[u8])] = &[
        (
            "notes/kaifuu-xp3-encrypted-marker.txt",
            b"synthetic kaifuu-xp3-encrypted marker",
        ),
        (
            "notes/xp3-encrypted-marker.txt",
            b"synthetic xp3-encrypted marker",
        ),
        ("notes/xp3-crypt-marker.txt", b"synthetic xp3-crypt marker"),
        ("notes/bgi-marker.txt", b"BGI-ENCRYPTED"),
        ("notes/ethornell-marker.txt", b"ethornell-encrypted"),
        ("notes/wolf-protected-marker.txt", b"wolf-protected"),
        ("notes/wolf-protection-key-marker.txt", b"protection-key"),
    ];
    for (relative_path, bytes) in marker_only_fixtures {
        write_fixture_file(&root, relative_path, bytes);
    }

    let report = ArchiveDetectionReport::scan(&root);

    assert_eq!(report.status, ArchiveDetectionStatus::Matched);
    for (row_id, leaked_positive_variant) in [
        ("kirikiri-xp3", "xp3-encrypted-archive"),
        (
            "bgi-ethornell-containers",
            "buriko-arc20-encrypted-container",
        ),
        ("wolf-rpg-editor-archives", "wolf-protected-archive"),
    ] {
        let row = report
            .rows
            .iter()
            .find(|row| row.row_id == row_id)
            .unwrap_or_else(|| panic!("missing archive row {row_id}"));
        assert!(!row.detected, "{row_id} should not be family-detected");
        assert_eq!(
            row.detected_variant, "unknown-variant",
            "{row_id} must not serialize a marker-only candidate as a detected variant"
        );
        assert_ne!(row.detected_variant, leaked_positive_variant);
        assert_eq!(
            row.signals,
            vec![ArchiveDetectionSignal::UnknownVariant],
            "{row_id} must retain only the marker-only unknown-variant signal"
        );
        assert!(
            row.requirements.is_empty(),
            "{row_id} leaked marker-only key requirements"
        );
        assert!(
            row.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == SemanticErrorCode::UnknownEngineVariant
                    && diagnostic.signal == ArchiveDetectionSignal::UnknownVariant
                    && diagnostic.required_capability == Some(Capability::Detection)
            }),
            "{row_id} must report the marker-only unknown-variant diagnostic"
        );
        assert!(!row.capabilities.iter().any(|capability| {
            capability.capability == Capability::EncryptedInput
                || capability.capability == Capability::KeyProfile
        }));
    }
    assert!(
        report
            .rows
            .iter()
            .filter(|row| !row.detected)
            .all(|row| row.detected_variant == "unknown-variant"),
        "every non-detected archive row must serialize the unknown variant"
    );

    let serialized = serde_json::to_value(&report).unwrap();
    for row_id in [
        "kirikiri-xp3",
        "bgi-ethornell-containers",
        "wolf-rpg-editor-archives",
    ] {
        let serialized_row = serialized["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["rowId"] == row_id)
            .unwrap_or_else(|| panic!("missing serialized archive row {row_id}"));
        assert_eq!(serialized_row["detected"], false);
        assert_eq!(serialized_row["detectedVariant"], "unknown-variant");
    }

    let unknown = detected_archive_row(&report, "unknown-archive-variant");
    assert_eq!(
        unknown.signals,
        vec![ArchiveDetectionSignal::UnknownVariant]
    );
    assert!(unknown.evidence.iter().any(|evidence| {
        evidence.pattern == "orphaned encrypted/protected subtype marker"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == marker_only_fixtures.len() as u64
    }));
    assert!(unknown.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::UnknownEngineVariant
            && diagnostic.required_capability == Some(Capability::Detection)
    }));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_preserves_wolf_matches_with_extension_or_header_primary_evidence() {
    let extension_only_root = temp_dir("wolf-extension-primary-evidence");
    write_fixture_file(
        &extension_only_root,
        "Data.wolf",
        b"synthetic protected archive marker without textual header",
    );

    let extension_only_report = ArchiveDetectionReport::scan(&extension_only_root);

    assert_eq!(
        extension_only_report.status,
        ArchiveDetectionStatus::Matched
    );
    let extension_only_wolf =
        detected_archive_row(&extension_only_report, "wolf-rpg-editor-archives");
    assert_eq!(extension_only_wolf.detected_variant, "wolf-archive");
    assert!(
        extension_only_wolf
            .signals
            .contains(&ArchiveDetectionSignal::Packed)
    );
    assert!(
        extension_only_wolf
            .signals
            .contains(&ArchiveDetectionSignal::Encrypted)
    );
    assert!(
        !extension_only_wolf
            .signals
            .contains(&ArchiveDetectionSignal::Protected)
    );
    assert!(extension_only_wolf.evidence.iter().any(|evidence| {
        evidence.pattern == "*.wolf"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(extension_only_wolf.evidence.iter().any(|evidence| {
        evidence.pattern == "WOLF header"
            && evidence.status == EvidenceStatus::Missing
            && evidence.count == 0
    }));

    let header_only_root = temp_dir("wolf-header-primary-evidence");
    write_fixture_file(
        &header_only_root,
        "notes/wolf-header.txt",
        b"WOLF RPG Editor synthetic wolf-protected protection-key marker",
    );

    let header_only_report = ArchiveDetectionReport::scan(&header_only_root);

    assert_eq!(header_only_report.status, ArchiveDetectionStatus::Matched);
    let wolf = detected_archive_row(&header_only_report, "wolf-rpg-editor-archives");
    assert_eq!(wolf.detected_variant, "wolf-protected-archive");
    assert!(wolf.signals.contains(&ArchiveDetectionSignal::Packed));
    assert!(wolf.signals.contains(&ArchiveDetectionSignal::Encrypted));
    assert!(wolf.signals.contains(&ArchiveDetectionSignal::Protected));
    assert!(wolf.evidence.iter().any(|evidence| {
        evidence.pattern == "*.wolf"
            && evidence.status == EvidenceStatus::Missing
            && evidence.count == 0
    }));
    assert!(wolf.evidence.iter().any(|evidence| {
        evidence.pattern == "WOLF header"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(wolf.evidence.iter().any(|evidence| {
        evidence.pattern == "Wolf protection marker"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 2
    }));
    assert_eq!(wolf.requirements.len(), 1);
    assert_eq!(wolf.requirements[0].key, "wolf-rpg-editor-archive-key");

    let unknown = header_only_report
        .rows
        .iter()
        .find(|row| row.row_id == "unknown-archive-variant")
        .unwrap();
    assert!(!unknown.detected);
    assert!(unknown.evidence.iter().any(|evidence| {
        evidence.pattern == "orphaned encrypted/protected subtype marker"
            && evidence.status == EvidenceStatus::Missing
            && evidence.count == 0
    }));

    let _ = fs::remove_dir_all(extension_only_root);
    let _ = fs::remove_dir_all(header_only_root);
}

#[test]
fn detection_report_status_matches_archive_only_inputs_without_adapter_claims() {
    let root = temp_dir("archive-only-detection-report");
    write_fixture_file(&root, "game/scripts.rpa", b"RenPy archive synthetic");
    let report = DetectionReport::from_results(
        &root,
        vec![DetectionResult {
            adapter_id: "kaifuu.fixture".to_string(),
            detected: false,
            engine_family: None,
            engine_version: None,
            detected_variant: None,
            evidence: vec![],
            requirements: vec![],
            capabilities: vec![],
        }],
    );

    assert_eq!(report.status, DetectionReportStatus::Unknown);
    assert_eq!(
        report.archive_detection.status,
        ArchiveDetectionStatus::Matched
    );
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| { warning.contains("no registered extraction adapter") })
    );
    let renpy = detected_archive_row(&report.archive_detection, "renpy-packed-inputs");
    assert!(renpy.capabilities.iter().any(|capability| {
        capability.capability == Capability::Extraction
            && capability.status == CapabilityStatus::Unsupported
    }));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn detection_report_redacts_absolute_game_dir_and_private_title() {
    let root = temp_dir("private-detection-report");
    let game_dir = root.join("Private Route Spoiler Game");
    fs::create_dir_all(&game_dir).unwrap();
    write_fixture_file(&game_dir, "img/pictures/spoiler-title.png_", b"encrypted");
    let report = DetectionReport::from_results(
        &game_dir,
        vec![DetectionResult {
            adapter_id: "kaifuu.fixture".to_string(),
            detected: false,
            engine_family: None,
            engine_version: None,
            detected_variant: None,
            evidence: vec![],
            requirements: vec![],
            capabilities: vec![],
        }],
    );

    assert_eq!(report.game_dir, REDACTED_DETECTION_GAME_DIR);
    let serialized = serde_json::to_string(&report).unwrap();
    assert!(!serialized.contains(&game_dir.display().to_string()));
    assert!(!serialized.contains("Private Route Spoiler Game"));
    assert!(!serialized.contains("spoiler-title"));
    let rpg_maker = detected_archive_row(
        &report.archive_detection,
        "rpg-maker-mv-mz-encrypted-assets",
    );
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));

    let _ = fs::remove_dir_all(root);
}

const UNSAFE_RELATIVE_PATH_FIXTURES: &[(&str, &str)] = &[
    ("empty", ""),
    ("absolute slash", "/source.json"),
    ("absolute backslash", "\\source.json"),
    ("ordinary backslash", "data\\source.json"),
    ("drive absolute slash", "C:/source.json"),
    ("drive absolute backslash", "C:\\source.json"),
    ("drive relative upper", "C:source.json"),
    ("drive relative lower", "c:source.json"),
    ("drive prefix component slash", "data/C:source.json"),
    ("drive prefix component backslash", "data\\C:source.json"),
    ("dot only", "."),
    ("leading dot slash", "./source.json"),
    ("leading dot backslash", ".\\source.json"),
    ("dot component slash", "data/./source.json"),
    ("dot component backslash", "data\\.\\source.json"),
    ("trailing dot component", "data/."),
    ("parent leading slash", "../source.json"),
    ("parent leading backslash", "..\\source.json"),
    ("parent component slash", "data/../source.json"),
    ("parent component backslash", "data\\..\\source.json"),
    ("empty component slash", "data//source.json"),
    ("empty component backslash", "data\\\\source.json"),
    ("nul byte", "source.json\0suffix"),
];

fn profile_with_asset_path(path: &str) -> Value {
    serde_json::json!({
        "schemaVersion": PROFILE_SCHEMA_VERSION,
        "profileId": deterministic_id("profile", 1),
        "gameId": "hello-fixture",
        "title": "Hello Fixture",
        "sourceLocale": "ja-JP",
        "engine": {
            "adapterId": "kaifuu.fixture",
            "engineFamily": "fixture",
            "engineVersion": null,
            "detectedVariant": "plain-json"
        },
        "assets": [
            {
                "assetId": deterministic_id("asset", 1),
                "path": path,
                "assetKind": "script",
                "textSurfaces": ["dialogue"],
                "patching": {
                    "capability": "patching",
                    "status": "supported",
                    "limitation": null
                }
            }
        ],
        "capabilities": [
            {
                "capability": "patching",
                "status": "supported",
                "limitation": null
            }
        ],
        "requirements": []
    })
}

#[test]
fn safe_relative_path_validator_and_join_share_negative_matrix() {
    let root = Path::new("patched-game");
    let safe = safe_join_relative(root, "data/source.json").unwrap();
    assert_eq!(safe, root.join("data").join("source.json"));
    assert!(validate_safe_relative_path("data/source.json").is_ok());

    for (case, unsafe_path) in UNSAFE_RELATIVE_PATH_FIXTURES {
        assert!(
            validate_safe_relative_path(unsafe_path).is_err(),
            "{case}: {unsafe_path:?} should be rejected by shared validation"
        );
        assert!(
            safe_join_relative(root, unsafe_path).is_err(),
            "{case}: {unsafe_path:?} should be rejected by safe_join_relative"
        );
    }
}

#[test]
fn profile_validation_uses_shared_relative_path_negative_matrix() {
    for (case, unsafe_path) in UNSAFE_RELATIVE_PATH_FIXTURES {
        let profile = profile_with_asset_path(unsafe_path);
        let validation = validate_profile_value(&profile);

        assert_eq!(
            validation.status,
            OperationStatus::Failed,
            "{case}: {unsafe_path:?} should fail profile validation"
        );
        if unsafe_path.is_empty() {
            assert!(
                validation.failures.iter().any(|failure| {
                    failure.code == "missing_required_field" && failure.field == "assets.0.path"
                }),
                "{case}: empty path should be rejected as a missing required field, got {:?}",
                validation.failures
            );
        } else {
            assert!(
                validation.failures.iter().any(|failure| {
                    failure.code == "invalid_asset_path" && failure.field == "assets.0.path"
                }),
                "{case}: {unsafe_path:?} should be rejected as invalid asset path, got {:?}",
                validation.failures
            );
        }
    }
}

const ALL_LETTER_RAW_KEY_MATERIAL: &str = "XqQbHYcPLaMRvTEsJZoWknNd";

fn valid_key_profile_value() -> Value {
    serde_json::json!({
        "schemaVersion": PROFILE_SCHEMA_VERSION,
        "profileId": deterministic_id("profile", 14),
        "gameId": "siglus-owned-local",
        "title": "Siglus Owned Local",
        "sourceLocale": "ja-JP",
        "engine": {
            "adapterId": "kaifuu.siglus",
            "engineFamily": "siglus",
            "engineVersion": null,
            "detectedVariant": "scene-pck-secondary-key"
        },
        "sourceFingerprint": {
            "gameRootHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "engineEvidence": ["Scene.pck", "Gameexe.dat"]
        },
        "keyRequirements": [
            {
                "requirementId": "siglus-secondary-key",
                "secretRef": "local-secret:siglus/example/secondary-key",
                "kind": "fixedBytes",
                "bytes": 16,
                "validation": {
                    "method": "decryptHeaderProof",
                    "proofHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                }
            }
        ],
        "archiveParameters": [
            {
                "parameterId": "scene-archive",
                "name": "sceneArchive",
                "kind": "archiveFormat",
                "value": "Scene.pck",
                "source": "detected"
            }
        ],
        "helperEvidence": {
            "helperKind": "staticParser",
            "toolVersion": "kaifuu-key-helper/0.1.0",
            "redactedLogHash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "proofHashes": [
                {
                    "method": "decryptHeaderProof",
                    "proofHash": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                }
            ]
        },
        "assets": [
            {
                "assetId": deterministic_id("asset", 14),
                "path": "Scene.pck",
                "assetKind": "archive",
                "textSurfaces": ["dialogue"],
                "sourceHash": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                "patching": {
                    "capability": "patching",
                    "status": "limited",
                    "limitation": "requires caller-provided resolved keys and archive parameters"
                }
            }
        ],
        "capabilities": [
            {
                "capability": "key_profile",
                "status": "supported",
                "limitation": null
            },
            {
                "capability": "patching",
                "status": "limited",
                "limitation": "requires caller-provided resolved keys and archive parameters"
            }
        ],
        "requirements": [
            {
                "category": "secret_key",
                "key": "siglus-secondary-key",
                "status": "satisfied",
                "description": "secondary key is referenced through local secret storage",
                "placeholder": null,
                "secret": true
            }
        ],
        "metadata": {}
    })
}
