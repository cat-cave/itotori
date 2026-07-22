fn rpgmaker_fixture_path(relative_path: &str) -> PathBuf {
    test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/rpgmaker")
        .join(relative_path)
}

fn run_encrypted_media_proof_cli(
    fixture: &Path,
    output: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    run_with_args(
        [
            "rpg-maker",
            "encrypted-media-proof",
            "--fixture",
            fixture.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    )
}

#[test]
fn encrypted_media_proof_command_happy_path_routes_without_overclaim() {
    let root = temp_dir("encrypted-media-happy");
    let output = root.join("encrypted-media-proof.json");
    run_encrypted_media_proof_cli(&rpgmaker_fixture_path("encrypted-media.json"), &output).unwrap();
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["readiness"], "ready");
    // Load-bearing: media-key detection never implies script
    // capability; decrypted bytes are never persisted; the
    // aggregate patch capability never claims patch_back or extract.
    assert_eq!(report["scriptCapabilityClaimed"], false);
    assert_eq!(report["decryptedBytesPersisted"], false);
    assert_ne!(report["patchCapabilityLevel"], "patch_back");
    assert_ne!(report["patchCapabilityLevel"], "extract");
    // Per-asset distinct kinds.
    let assets = report["assets"].as_array().unwrap();
    let kinds: Vec<&str> = assets
        .iter()
        .map(|asset| asset["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"image"));
    assert!(kinds.contains(&"audio"));
    assert!(kinds.contains(&"video"));
    // Every encrypted asset claims `unsupported` patch capability.
    for asset in assets {
        if asset["classification"] == "encrypted" {
            assert_eq!(asset["patchCapabilityLevel"], "unsupported");
            assert_ne!(asset["patchCapabilityLevel"], "patch_back");
            assert_ne!(asset["patchCapabilityLevel"], "extract");
            assert_eq!(asset["decryptability"], "key_profile_satisfied");
        }
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn encrypted_media_proof_command_qd_contract_writes_stdout_without_output_flag() {
    run_with_args(
        [
            "rpgmaker",
            "encrypted-media-proof",
            "--fixture",
            rpgmaker_fixture_path("encrypted-media.json")
                .to_str()
                .unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    )
    .unwrap();
}

#[test]
fn encrypted_media_proof_command_missing_key_routes_to_unsupported() {
    let root = temp_dir("encrypted-media-missing-key");
    let output = root.join("missing-key-report.json");
    let result = run_encrypted_media_proof_cli(
        &rpgmaker_fixture_path("encrypted-media-missing-key.json"),
        &output,
    );
    assert!(result.is_err(), "missing-key fixture must exit non-zero");
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["readiness"], "unsupported");
    assert_eq!(report["decryptedBytesPersisted"], false);
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"]
                == "rpgmaker.encrypted_media.system_json.key_missing")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn encrypted_media_proof_command_wrong_key_routes_to_unsupported() {
    let root = temp_dir("encrypted-media-wrong-key");
    let output = root.join("wrong-key-report.json");
    let result = run_encrypted_media_proof_cli(
        &rpgmaker_fixture_path("encrypted-media-wrong-key.json"),
        &output,
    );
    assert!(result.is_err(), "wrong-key fixture must exit non-zero");
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["readiness"], "unsupported");
    assert_eq!(report["decryptedBytesPersisted"], false);
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"]
                == "rpgmaker.encrypted_media.system_json.key_mismatch"
                && diagnostic["semanticCode"] == "kaifuu.key_validation_failed")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn encrypted_media_proof_command_leaked_game_dir_rejected_before_any_decryption_claim() {
    let root = temp_dir("encrypted-media-leaked-game-dir");
    let output = root.join("leaked-game-dir-report.json");
    let result = run_encrypted_media_proof_cli(
        &rpgmaker_fixture_path("negative/encrypted-media-leaked-game-dir.json"),
        &output,
    );
    assert!(result.is_err(), "leaked game dir must exit non-zero");
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["readiness"], "unsupported");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "rpgmaker.encrypted_media.game_dir.leaked")
    );
    // The leaked absolute path must not survive into the report.
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("/home/local-user"));
    assert!(!serialized.contains("C:\\"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn encrypted_media_proof_command_malformed_header_routes_to_unsupported() {
    let root = temp_dir("encrypted-media-malformed-header");
    let output = root.join("malformed-header-report.json");
    let result = run_encrypted_media_proof_cli(
        &rpgmaker_fixture_path("negative/encrypted-media-malformed-header.json"),
        &output,
    );
    assert!(
        result.is_err(),
        "malformed-header fixture must exit non-zero"
    );
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "rpgmaker.encrypted_media.header.malformed")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn encrypted_media_proof_command_unknown_key_profile_routes_to_unsupported() {
    let root = temp_dir("encrypted-media-unknown-profile");
    let output = root.join("unknown-profile-report.json");
    let result = run_encrypted_media_proof_cli(
        &rpgmaker_fixture_path("negative/encrypted-media-unknown-key-profile.json"),
        &output,
    );
    assert!(result.is_err(), "unknown-key-profile must exit non-zero");
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "rpgmaker.encrypted_media.key_profile.unknown")
    );
    let _ = fs::remove_dir_all(root);
}

/// multi-game validation — exercise the proof against
/// real RPG Maker MV/MZ media bytes when an optional corpus root is
/// configured. Following the "multi-game validation"
/// memory rule and the spec's research-only anchor (commercial
/// product; no vendored decryption code, no key extraction): the
/// test reads, classifies, and emits the redacted readiness report;
/// it never decrypts, never extracts, and never claims patch_back
/// or script capability on real bytes.
/// The test no-ops when `ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ`
/// is unset; the synthetic fixtures above are the load-bearing
/// correctness coverage.
#[test]
fn encrypted_media_proof_command_real_bytes_rpgmaker_corpus_when_available() {
    let Some(real_root) = std::env::var_os("ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ") else {
        println!("encrypted-media real-bytes corpus root unset; skipping");
        return;
    };
    let real_root = PathBuf::from(real_root);
    if !real_root.is_dir() {
        eprintln!("SKIP: RPG Maker MV/MZ corpus is not staged");
        return;
    }
    let title_asset = real_root.join("img/sv_actors/Actor1_1.rpgmvp");
    let theme_asset = real_root.join("audio/bgm/Battle1.rpgmvo");
    let system_json = real_root.join("data/System.json");
    if !(title_asset.is_file() && theme_asset.is_file() && system_json.is_file()) {
        eprintln!("SKIP: RPG Maker MV/MZ corpus misses required media anchors");
        return;
    }

    let root = temp_dir("encrypted-media-real-bytes");
    // The proof's path validator rejects absolute paths so we
    // materialise a relative game tree by symlinking the real
    // sub-tree under our fixture-root.
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let symlink_targets = &[
        ("data", real_root.join("data")),
        ("img", real_root.join("img")),
        ("audio", real_root.join("audio")),
    ];
    for (name, target) in symlink_targets {
        std::os::unix::fs::symlink(target, game_dir.join(name)).unwrap();
    }

    let fixture_path = root.join("fixture.json");
    let fixture_body = serde_json::json!({
        "schemaVersion": "0.1.0",
        "fixtureId": "kaifuu-real-rpgmaker-mv-mz-corpus",
        "profileId": "019ed000-0000-7000-8000-000000039999",
        "gameDir": "game",
        "assets": [
            {
                "assetId": "real-image-mv",
                "path": "img/sv_actors/Actor1_1.rpgmvp",
                "expectedKind": "image",
                "expectedClassification": "encrypted"
            },
            {
                "assetId": "real-audio-mv",
                "path": "audio/bgm/Battle1.rpgmvo",
                "expectedKind": "audio",
                "expectedClassification": "encrypted"
            }
        ],
        "keyProfile": {
            "profileId": "rpg-maker-mv-mz-asset-key",
            "keyRefRequirement": {
                "requirementId": "rpg-maker-mv-mz-asset-key",
                "secretRef": "local-secret:fixture/rpgmaker/mv-mz-asset-key"
            }
        }
    });
    fs::write(&fixture_path, fixture_body.to_string()).unwrap();

    let output = root.join("real-bytes-proof.json");
    // We accept Err — the proof exits non-zero whenever any blocking
    // diagnostic fires. We assert from the report contents.
    let _ = run_encrypted_media_proof_cli(&fixture_path, &output);

    let report: serde_json::Value = read_json(&output).unwrap();

    // Load-bearing checks across real bytes:
    // - decryptedBytesPersisted is always false (no decryption).
    // - scriptCapabilityClaimed is always false (no script claim).
    // - patchCapabilityLevel never claims patch_back / extract.
    assert_eq!(report["decryptedBytesPersisted"], false);
    assert_eq!(report["scriptCapabilityClaimed"], false);
    assert_ne!(report["patchCapabilityLevel"], "patch_back");
    assert_ne!(report["patchCapabilityLevel"], "extract");

    // Every real-bytes encrypted asset must be classified as
    // `encrypted` and route to `unsupported` patch capability.
    let assets = report["assets"].as_array().unwrap();
    let encrypted_assets: Vec<_> = assets
        .iter()
        .filter(|asset| asset["classification"] == "encrypted")
        .collect();
    assert!(
        !encrypted_assets.is_empty(),
        "expected at least one encrypted real-bytes asset"
    );
    for asset in &encrypted_assets {
        assert_eq!(asset["patchCapabilityLevel"], "unsupported");
        assert_ne!(asset["patchCapabilityLevel"], "patch_back");
        assert_ne!(asset["patchCapabilityLevel"], "extract");
    }

    // Absolute real-bytes path must not leak into the report.
    let serialized = fs::read_to_string(&output).unwrap();
    if let Some(real_root_text) = real_root.to_str() {
        assert!(
            !serialized.contains(real_root_text),
            "configured real-bytes root leaked into report",
        );
    }

    // The encryption key from real-bytes System.json must not leak
    // into the report (we only emit the proof hash). Some real
    // corpora use permissive placeholder keys, but any
    // 32-hex token would be unsafe to surface.
    if let Ok(system_json_text) = fs::read_to_string(&system_json)
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(&system_json_text)
        && let Some(real_key) = value.get("encryptionKey").and_then(|v| v.as_str())
    {
        assert!(
            !serialized.contains(real_key),
            "raw real-bytes System.json key leaked into report",
        );
    }

    println!("encrypted-media real-bytes corpus exercised configured root");
    let _ = fs::remove_dir_all(root);
}
