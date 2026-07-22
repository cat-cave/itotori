#[test]
fn siglus_detector_profile_fixture_reports_identify_inventory_only() {
    let root = temp_dir("public-siglus-detector");
    let game_dir = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus");
    let expected_root = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/expected");

    let detect_path = root.join("siglus-detect.json");
    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);
    let actual_detection: serde_json::Value = read_json(&detect_path).unwrap();
    let detection_report: DetectionReport = serde_json::from_value(actual_detection).unwrap();
    assert_eq!(detection_report.status, DetectionReportStatus::Matched);
    assert_bgi_detection_absent_or_undetected(&detection_report);
    let siglus_detection = detection_report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::SIGLUS_DETECTOR_ADAPTER_ID)
        .unwrap();
    assert!(siglus_detection.detected);
    assert_eq!(siglus_detection.engine_family.as_deref(), Some("siglus"));
    assert!(siglus_detection.capabilities.iter().any(|capability| {
        capability.capability == Capability::Detection
            && capability.status == CapabilityStatus::Supported
    }));
    assert!(siglus_detection.capabilities.iter().any(|capability| {
        capability.capability == Capability::AssetInventory
            && capability.status == CapabilityStatus::Supported
    }));
    assert!(siglus_detection.capabilities.iter().any(|capability| {
        capability.capability == Capability::Extraction
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(siglus_detection.capabilities.iter().any(|capability| {
        capability.capability == Capability::RuntimeVm
            && capability.status == CapabilityStatus::Unsupported
    }));

    let profile_path = root.join("siglus-profile.json");
    run_cli(&[
        "profile",
        "init",
        game_dir.to_str().unwrap(),
        "--output",
        profile_path.to_str().unwrap(),
    ]);
    let actual_profile: serde_json::Value = read_json(&profile_path).unwrap();
    let expected_profile: serde_json::Value =
        read_json(&expected_root.join("siglus-detector-profile-v0.1.json")).unwrap();
    assert_eq!(actual_profile, expected_profile);
    let profile: GameProfile = serde_json::from_value(actual_profile).unwrap();
    assert_eq!(profile.profile_id, "019ed000-0000-7000-8000-000000091001");
    assert_eq!(
        profile
            .metadata
            .get("profileDiagnostics.encryptedPayload")
            .map(String::as_str),
        Some("true")
    );
    assert_eq!(
        profile
            .metadata
            .get("profileDiagnostics.unsupportedParserBoundary")
            .map(String::as_str),
        Some("true")
    );
    assert!(profile.assets.iter().all(|asset| {
        asset
            .source_hash
            .as_deref()
            .unwrap_or("")
            .starts_with("sha256:")
    }));
    assert!(profile.capabilities.iter().any(|capability| {
        capability.capability == Capability::Patching
            && capability.status == CapabilityStatus::Unsupported
    }));

    let inventory_path = root.join("siglus-inventory.json");
    run_cli(&[
        "asset-inventory",
        game_dir.to_str().unwrap(),
        "--output",
        inventory_path.to_str().unwrap(),
    ]);
    let actual_inventory: serde_json::Value = read_json(&inventory_path).unwrap();
    let expected_inventory: serde_json::Value =
        read_json(&expected_root.join("siglus-asset-inventory-v0.1.json")).unwrap();
    assert_eq!(actual_inventory, expected_inventory);
    let inventory: AssetInventoryManifest = serde_json::from_value(actual_inventory).unwrap();
    assert_eq!(inventory.validate().status, OperationStatus::Passed);
    assert!(inventory.assets.iter().all(|asset| {
        asset
            .source_hash
            .as_deref()
            .unwrap_or("")
            .starts_with("sha256:")
    }));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn siglus_parser_boundary_smoke_cli_writes_redacted_report_and_blocks_unsupported_opcode() {
    let root = temp_dir("siglus-parser-boundary-smoke");
    let game_dir = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus");
    let key_request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
    );

    let success_output = root.join("siglus-parser-boundary-success.json");
    run_cli(&[
        "siglus",
        "parser-boundary-smoke",
        "--scene",
        game_dir.join("Scene.pck").to_str().unwrap(),
        "--gameexe",
        game_dir.join("Gameexe.dat").to_str().unwrap(),
        "--key-request",
        key_request.to_str().unwrap(),
        "--output",
        success_output.to_str().unwrap(),
    ]);
    let success: serde_json::Value = read_json(&success_output).unwrap();
    let expected_success: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-encrypted-matrix/expected/siglus-parser-boundary-smoke-v0.1.json",
    ))
    .unwrap();
    assert_eq!(success, expected_success);
    assert_eq!(success["status"], "passed");
    assert_eq!(success["outcome"], "parser_boundary_success");
    assert_eq!(success["profileId"], "019ed000-0000-7000-8000-000000091001");
    assert_eq!(success["patchWriteAttempted"], false);
    assert_eq!(
        success["textSlots"][0]["textSlotId"],
        "siglus.synthetic.scene.text.001"
    );
    assert_eq!(
        success["textSlots"][0]["byteSpan"],
        serde_json::json!({"startByte": 17, "endByte": 52})
    );

    let unsupported_output = root.join("siglus-parser-boundary-unsupported.json");
    let result = run_with_args(vec![
        "siglus".to_string(),
        "parser-boundary-smoke".to_string(),
        "--scene".to_string(),
        game_dir.join("Scene.pck").to_str().unwrap().to_string(),
        "--gameexe".to_string(),
        game_dir.join("Gameexe.dat").to_str().unwrap().to_string(),
        "--key-request".to_string(),
        key_request.to_str().unwrap().to_string(),
        "--variant".to_string(),
        "unsupported-opcode".to_string(),
        "--output".to_string(),
        unsupported_output.to_str().unwrap().to_string(),
    ]);
    assert!(result.is_err());
    let unsupported: serde_json::Value = read_json(&unsupported_output).unwrap();
    assert_eq!(unsupported["status"], "failed");
    assert_eq!(unsupported["outcome"], "unsupported_opcode");
    assert_eq!(unsupported["patchWriteAttempted"], false);
    assert_eq!(
        unsupported["diagnostics"][0]["semanticCode"],
        kaifuu_core::SEMANTIC_SIGLUS_UNSUPPORTED_OPCODE
    );
    assert_eq!(
        unsupported["diagnostics"][0]["unsupportedOpcode"],
        "SIGLUS_SYNTH_UNSUPPORTED_7f"
    );

    for output in [success_output, unsupported_output] {
        let serialized = fs::read_to_string(output).unwrap();
        for forbidden in [
            "rawKey",
            "keyMaterial",
            "00112233445566778899aabbccddeeff",
            "fixture-only-siglus-secondary-key-v1",
            "decrypted script",
            "/home/",
            "C:\\",
        ] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}");
        }
    }

    let _ = fs::remove_dir_all(root);
}

/// Build a synthetic profile-proof fixture into `dir`, wiring the
/// composed slices at absolute paths to the committed synthetic fixtures. The
/// optional `seed_key_profile_id` overrides `keyProfile.keyProfileId` so the
/// deep-scan reject tests can inject secret-shaped material; `capability_level`
/// overrides the honest default.
fn write_siglus_profile_proof_fixture(
    dir: &Path,
    seed_key_profile_id: Option<&str>,
    capability_level: &str,
) -> PathBuf {
    let raw = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus");
    let key_request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
    );
    let compat = public_fixture_path("fixtures/kaifuu/compat-profile/siglus.extract.tuple.json");
    let fixture = serde_json::json!({
        "schemaVersion": "0.1.0",
        "fixtureId": "kaifuu-siglus-synthetic-profile-proof",
        "profileId": "019ed000-0000-7000-8000-000000091001",
        "detectorGameDir": raw.to_str().unwrap(),
        "parser": {
            "parserProfileId": "019ed000-0000-7000-8000-000000091001",
            "scene": raw.join("Scene.pck").to_str().unwrap(),
            "gameexe": raw.join("Gameexe.dat").to_str().unwrap(),
            "keyRequest": key_request.to_str().unwrap(),
            "variant": "parser-boundary-success"
        },
        "keyProfile": {
            "keyProfileId": seed_key_profile_id.unwrap_or("siglus-secondary-key"),
            "secretRef": "local-secret:fixture/siglus/secondary-key-ref"
        },
        "compatTuple": compat.to_str().unwrap(),
        "capabilityLevel": capability_level
    });
    let path = dir.join("synthetic-profile.json");
    fs::write(&path, serde_json::to_string_pretty(&fixture).unwrap()).unwrap();
    path
}

#[test]
fn siglus_profile_proof_composes_slices_into_honest_redacted_report() {
    let root = temp_dir("siglus-profile-proof-happy");
    let fixture = write_siglus_profile_proof_fixture(&root, None, "known-key-extract");
    let out = root.join("profile-proof.json");

    run_with_args(vec![
        "siglus".to_string(),
        "profile-proof".to_string(),
        "--fixture".to_string(),
        fixture.to_str().unwrap().to_string(),
        "--out".to_string(),
        out.to_str().unwrap().to_string(),
    ])
    .unwrap();

    let report: serde_json::Value = read_json(&out).unwrap();
    assert_eq!(report["status"], "passed");
    // (1) records detector evidence + key-profile-id + parser-profile-id +
    // capability-level + redaction-summary.
    assert_eq!(report["detector"]["detected"], true);
    assert_eq!(report["detector"]["engineFamily"], "siglus");
    assert!(
        report["detector"]["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .any(|evidence| evidence["status"] == "matched")
    );
    assert_eq!(report["keyProfile"]["keyProfileId"], "siglus-secondary-key");
    assert_eq!(report["keyProfile"]["extractCoreStatus"], "not_implemented");
    assert_eq!(
        report["parserProfile"]["parserProfileId"],
        "019ed000-0000-7000-8000-000000091001"
    );
    assert_eq!(
        report["parserProfile"]["outcome"],
        "parser_boundary_success"
    );
    assert_eq!(report["capabilityLevel"], "known-key-extract");
    assert_eq!(report["redactionSummary"]["deepScanPerformed"], true);
    assert_eq!(report["redactionSummary"]["secretLeakFindings"], 0);
    assert_eq!(report["redactionSummary"]["redactionBoundaryOk"], true);
    // Honest scope: never claims broad commercial Siglus support.
    assert_eq!(report["broadCommercialClaim"], false);
    assert_eq!(report["compat"]["honest"], true);
    assert_eq!(report["compat"]["patchBackMode"], "unsupported");

    // Deterministic: a second run over the same fixture is byte-identical.
    let out2 = root.join("profile-proof-2.json");
    run_with_args(vec![
        "siglus".to_string(),
        "profile-proof".to_string(),
        "--fixture".to_string(),
        fixture.to_str().unwrap().to_string(),
        "--out".to_string(),
        out2.to_str().unwrap().to_string(),
    ])
    .unwrap();
    assert_eq!(
        fs::read_to_string(&out).unwrap(),
        fs::read_to_string(&out2).unwrap()
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn siglus_profile_proof_rejects_seeded_secrets_before_write() {
    // A raw key, helper dump, private path, and decrypted private text seeded
    // into the input are each REJECTED from the persisted artifact: the
    // command fails loud and writes nothing.
    for seed in [
        "00112233445566778899aabbccddeeff00112233",
        "helper dump of the secondary key state",
        "/home/trevor/games/siglus/private/Scene.pck",
        "decrypted script: secret dialogue",
    ] {
        let root = temp_dir("siglus-profile-proof-seed");
        let fixture = write_siglus_profile_proof_fixture(&root, Some(seed), "known-key-extract");
        let out = root.join("profile-proof.json");

        let result = run_with_args(vec![
            "siglus".to_string(),
            "profile-proof".to_string(),
            "--fixture".to_string(),
            fixture.to_str().unwrap().to_string(),
            "--out".to_string(),
            out.to_str().unwrap().to_string(),
        ]);
        assert!(result.is_err(), "seed {seed:?} should be rejected");
        assert!(
            !out.exists(),
            "seed {seed:?} must persist no artifact before write"
        );
        let _ = fs::remove_dir_all(root);
    }
}

#[test]
fn siglus_profile_proof_rejects_capability_overclaim() {
    // Declaring known-key-patch-verify overclaims past the evidence ceiling
    // (the extract/patch core is NotImplemented): the proof fails.
    let root = temp_dir("siglus-profile-proof-overclaim");
    let fixture = write_siglus_profile_proof_fixture(&root, None, "known-key-patch-verify");
    let out = root.join("profile-proof.json");

    let result = run_with_args(vec![
        "siglus".to_string(),
        "profile-proof".to_string(),
        "--fixture".to_string(),
        fixture.to_str().unwrap().to_string(),
        "--out".to_string(),
        out.to_str().unwrap().to_string(),
    ]);
    assert!(result.is_err());
    // The Failed report IS written (no secret leak), recording the overclaim.
    let report: serde_json::Value = read_json(&out).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["semanticCode"]
                == kaifuu_core::SEMANTIC_SIGLUS_PROFILE_PROOF_CAPABILITY_OVERCLAIM)
    );

    let _ = fs::remove_dir_all(root);
}
