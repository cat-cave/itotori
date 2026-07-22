use super::*;

#[test]
fn siglus_only_complete_synthetic_pair_is_profileable_and_inventoryable() {
    let complete_dir = siglus_fixture_dir(
        "siglus-complete-pair",
        Some(SIGLUS_SCENE_MAGIC),
        Some(SIGLUS_GAMEEXE_MAGIC),
    );
    let missing_pair_dir =
        siglus_fixture_dir("siglus-missing-pair", Some(SIGLUS_SCENE_MAGIC), None);
    let unknown_dir = siglus_fixture_dir(
        "siglus-unknown-named-pair",
        Some(b"unknown scene bytes"),
        Some(b"unknown gameexe bytes"),
    );
    let adapter = SiglusProfileDetectorAdapter;

    let complete_detection = adapter
        .detect(DetectRequest {
            game_dir: &complete_dir,
        })
        .unwrap();
    assert!(complete_detection.detected);
    assert_eq!(
        complete_detection.detected_variant.as_deref(),
        Some("scene-pck-gameexe-dat-synthetic")
    );
    assert!(
        adapter
            .profile(ProfileRequest {
                game_dir: &complete_dir
            })
            .is_ok()
    );
    assert!(
        adapter
            .asset_inventory(AssetInventoryRequest {
                game_dir: &complete_dir
            })
            .is_ok()
    );

    let missing_detection = adapter
        .detect(DetectRequest {
            game_dir: &missing_pair_dir,
        })
        .unwrap();
    assert!(!missing_detection.detected);
    assert_eq!(
        missing_detection.detected_variant.as_deref(),
        Some("scene-pck-missing-gameexe-dat")
    );
    assert!(missing_detection.requirements.iter().any(|requirement| {
        requirement.key == SIGLUS_GAMEEXE_PATH && requirement.status == RequirementStatus::Missing
    }));
    let missing_failure = adapter_failure_from_error(
        adapter
            .profile(ProfileRequest {
                game_dir: &missing_pair_dir,
            })
            .unwrap_err(),
    );
    assert_eq!(
        missing_failure.error_code,
        "kaifuu.missing_capability.container"
    );
    assert_eq!(
        missing_failure.required_capability,
        Some(Capability::AssetListing)
    );
    assert_eq!(
        missing_failure.detected_variant.as_deref(),
        Some("scene-pck-missing-gameexe-dat")
    );
    assert!(
        adapter
            .asset_inventory(AssetInventoryRequest {
                game_dir: &missing_pair_dir
            })
            .is_err()
    );

    let unknown_detection = adapter
        .detect(DetectRequest {
            game_dir: &unknown_dir,
        })
        .unwrap();
    assert!(!unknown_detection.detected);
    assert_eq!(
        unknown_detection.detected_variant.as_deref(),
        Some("unknown-siglus-named-files")
    );
    assert!(unknown_detection.requirements.iter().any(|requirement| {
        requirement.key == "siglus-synthetic-signature"
            && requirement.status == RequirementStatus::Unsupported
    }));
    let unknown_failure = adapter_failure_from_error(
        adapter
            .asset_inventory(AssetInventoryRequest {
                game_dir: &unknown_dir,
            })
            .unwrap_err(),
    );
    assert_eq!(unknown_failure.error_code, "kaifuu.unknown_engine_variant");
    assert_eq!(
        unknown_failure.required_capability,
        Some(Capability::Detection)
    );
    assert_eq!(
        unknown_failure.detected_variant.as_deref(),
        Some("unknown-siglus-named-files")
    );

    let _ = fs::remove_dir_all(complete_dir);
    let _ = fs::remove_dir_all(missing_pair_dir);
    let _ = fs::remove_dir_all(unknown_dir);
}

#[test]
fn siglus_detects_real_signature_pair_at_identify_level() {
    let real_dir = siglus_fixture_dir(
        "siglus-real-signature-pair",
        Some(&realistic_real_scene_pck(10)),
        Some(&realistic_real_gameexe_dat()),
    );
    let adapter = SiglusProfileDetectorAdapter;

    let detection = adapter
        .detect(DetectRequest {
            game_dir: &real_dir,
        })
        .unwrap();
    assert!(
        detection.detected,
        "real Scene.pck + Gameexe.dat signatures must be detected"
    );
    assert_eq!(detection.engine_family.as_deref(), Some("siglus"));
    assert_eq!(
        detection.detected_variant.as_deref(),
        Some("scene-pck-gameexe-dat-real")
    );
    // Evidence reports the REAL signature class honestly, not synthetic.
    let scene_evidence = detection
        .evidence
        .iter()
        .find(|row| row.path == SIGLUS_SCENE_PATH)
        .expect("Scene.pck evidence row");
    assert_eq!(scene_evidence.kind, "real_siglus_scene_pck_signature");
    assert_eq!(scene_evidence.status, EvidenceStatus::Matched);
    let gameexe_evidence = detection
        .evidence
        .iter()
        .find(|row| row.path == SIGLUS_GAMEEXE_PATH)
        .expect("Gameexe.dat evidence row");
    assert_eq!(gameexe_evidence.kind, "real_siglus_gameexe_dat_signature");
    assert_eq!(gameexe_evidence.status, EvidenceStatus::Matched);

    // Profile + inventory succeed at identify level and report honestly.
    let profile = adapter
        .profile(ProfileRequest {
            game_dir: &real_dir,
        })
        .unwrap();
    assert_eq!(
        profile.engine.detected_variant,
        "scene-pck-gameexe-dat-real"
    );
    assert_eq!(profile.game_id, "kaifuu-siglus-real-scene-pck");
    assert_eq!(profile.title, "Siglus title (detector profile)");
    assert_eq!(
        profile.metadata.get("fixtureOnly").map(String::as_str),
        Some("false")
    );
    assert!(
        adapter
            .asset_inventory(AssetInventoryRequest {
                game_dir: &real_dir
            })
            .is_ok()
    );

    // Stays identify/inventory-level: extraction and patching still fail
    // with the documented boundary (no overclaim of decrypt/repack).
    assert!(
        adapter
            .extract(ExtractRequest {
                game_dir: &real_dir
            })
            .is_err(),
        "detector must not claim extraction on real bytes"
    );

    let _ = fs::remove_dir_all(real_dir);
}

#[test]
fn siglus_synthetic_pair_still_detected_after_real_signature_support() {
    // Regression guard: adding real-signature recognition must not drop
    // the synthetic-fixture path (no-legacy-compat: both work).
    let synthetic_dir = siglus_fixture_dir(
        "siglus-synthetic-still-detected",
        Some(SIGLUS_SCENE_MAGIC),
        Some(SIGLUS_GAMEEXE_MAGIC),
    );
    let adapter = SiglusProfileDetectorAdapter;
    let detection = adapter
        .detect(DetectRequest {
            game_dir: &synthetic_dir,
        })
        .unwrap();
    assert!(detection.detected);
    assert_eq!(
        detection.detected_variant.as_deref(),
        Some("scene-pck-gameexe-dat-synthetic")
    );
    let scene_evidence = detection
        .evidence
        .iter()
        .find(|row| row.path == SIGLUS_SCENE_PATH)
        .expect("Scene.pck evidence row");
    assert_eq!(scene_evidence.kind, "synthetic_siglus_scene_pck_signature");
    let profile = adapter
        .profile(ProfileRequest {
            game_dir: &synthetic_dir,
        })
        .unwrap();
    assert_eq!(
        profile.metadata.get("fixtureOnly").map(String::as_str),
        Some("true")
    );
    assert_eq!(profile.game_id, "kaifuu-siglus-synthetic-scene-pck");
    let _ = fs::remove_dir_all(synthetic_dir);
}

#[test]
fn siglus_real_signature_does_not_false_positive() {
    let adapter = SiglusProfileDetectorAdapter;

    // A Scene.pck opening with the 0x5C header but only a short (<8)
    // ascending offset run is NOT recognized as a real archive.
    let weak_scene = siglus_fixture_dir(
        "siglus-weak-ascending-offsets",
        Some(&realistic_real_scene_pck(3)),
        Some(&realistic_real_gameexe_dat()),
    );
    let weak_detection = adapter
        .detect(DetectRequest {
            game_dir: &weak_scene,
        })
        .unwrap();
    assert!(
        !weak_detection.detected,
        "0x5C header with a short offset run must not be recognized"
    );

    // An unrelated file that merely opens with `5c 00 00 00` then
    // non-ascending garbage is rejected.
    let mut noisy = vec![0x5Cu8, 0x00, 0x00, 0x00];
    noisy.extend_from_slice(&[0xFF; 0x60]);
    let noisy_scene = siglus_fixture_dir(
        "siglus-noisy-0x5c-prefix",
        Some(&noisy),
        Some(&realistic_real_gameexe_dat()),
    );
    assert!(
        !adapter
            .detect(DetectRequest {
                game_dir: &noisy_scene,
            })
            .unwrap()
            .detected
    );

    // A Gameexe.dat with the correct 8-byte prefix but a low-entropy
    // (all-zero) body is rejected by the entropy gate.
    let mut low_entropy_gameexe = Vec::new();
    low_entropy_gameexe.extend_from_slice(&0u32.to_le_bytes());
    low_entropy_gameexe.extend_from_slice(&1u32.to_le_bytes());
    low_entropy_gameexe.resize(8 + 4096, 0);
    let low_entropy_dir = siglus_fixture_dir(
        "siglus-low-entropy-gameexe",
        Some(&realistic_real_scene_pck(10)),
        Some(&low_entropy_gameexe),
    );
    let low_detection = adapter
        .detect(DetectRequest {
            game_dir: &low_entropy_dir,
        })
        .unwrap();
    assert!(
        !low_detection.detected,
        "low-entropy Gameexe.dat body must not be recognized as encrypted"
    );

    // A plain text pair is not Siglus at all.
    let text_dir = siglus_fixture_dir(
        "siglus-plain-text",
        Some(b"just some plain text that is not a Siglus archive at all"),
        Some(b"another plain text file"),
    );
    let text_detection = adapter
        .detect(DetectRequest {
            game_dir: &text_dir,
        })
        .unwrap();
    assert!(!text_detection.detected);
    assert_eq!(
        text_detection.detected_variant.as_deref(),
        Some("unknown-siglus-named-files")
    );

    let _ = fs::remove_dir_all(weak_scene);
    let _ = fs::remove_dir_all(noisy_scene);
    let _ = fs::remove_dir_all(low_entropy_dir);
    let _ = fs::remove_dir_all(text_dir);
}

// Real-corpus validation (≥2 titles). Ignored by default because it needs
// owned, uncommitted Siglus game trees; point `KAIFUU_SIGLUS_REAL_DIRS` at
// a `:`-separated list of directories each holding a real `Scene.pck` +
// `Gameexe.dat` from materialized real-corpus titles and run with
// `--ignored`. Reads only the header signature; commits no game bytes.
#[test]
#[ignore = "requires owned Siglus corpus via KAIFUU_SIGLUS_REAL_DIRS"]
fn siglus_detects_real_corpus_titles() {
    // Visible SKIP (not a panic) when the owned Siglus corpus is not wired.
    // This `#[ignore]`d test is selected by the broad `-p kaifuu-engine-fixture
    // -- --ignored` real-bytes invocation; the Siglus corpus is provisioned
    // separately (vault-materialized), so a `panic!` here false-FAILED that
    // lane whenever KAIFUU_SIGLUS_REAL_DIRS was absent. Skipping matches the
    // Softpal detector proofs in this crate: no corpus -> no assertion, no red.
    let Ok(dirs) = std::env::var("KAIFUU_SIGLUS_REAL_DIRS") else {
        eprintln!(
            "skipping: set KAIFUU_SIGLUS_REAL_DIRS to a :-separated list of Siglus game dirs"
        );
        return;
    };
    let adapter = SiglusProfileDetectorAdapter;
    let mut recognized = 0usize;
    for dir in dirs.split(':').filter(|d| !d.is_empty()) {
        let game_dir = PathBuf::from(dir);
        let detection = adapter
            .detect(DetectRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        eprintln!(
            "[siglus-real-corpus] {dir} detected={} variant={:?}",
            detection.detected, detection.detected_variant
        );
        assert!(
            detection.detected,
            "real Siglus title must be detected: {dir}"
        );
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("scene-pck-gameexe-dat-real"),
            "real Siglus title must report the real variant: {dir}"
        );
        recognized += 1;
    }
    assert!(
        recognized >= 2,
        "expected >=2 real Siglus titles, recognized {recognized}"
    );
}

#[test]
fn siglus_extract_returns_serialized_semantic_boundary_failure() {
    let game_dir = siglus_fixture_dir(
        "siglus-extract-boundary",
        Some(SIGLUS_SCENE_MAGIC),
        Some(SIGLUS_GAMEEXE_MAGIC),
    );
    let failure = adapter_failure_from_error(
        SiglusProfileDetectorAdapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap_err(),
    );

    assert_eq!(failure.error_code, "kaifuu.unsupported_layered_transform");
    assert_eq!(failure.required_capability, Some(Capability::CodecAccess));
    assert_eq!(failure.asset_ref.as_deref(), Some(SIGLUS_SCENE_PATH));
    assert!(failure.support_boundary.contains("parsing/decompilation"));
    assert!(
        failure
            .remediation
            .as_deref()
            .unwrap_or("")
            .contains("do not request extract")
    );

    let _ = fs::remove_dir_all(game_dir);
}
