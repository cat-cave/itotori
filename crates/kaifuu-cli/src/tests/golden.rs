#[test]
fn golden_command_runs_fixture_round_trip_and_public_translated_patch() {
    let root = temp_dir("golden-public-translated");
    let fixture_dir = public_fixture_dir();
    let report_path = root.join("golden-report.json");
    let work_dir = root.join("golden-work");
    run_cli(&[
        "golden",
        fixture_dir.to_str().unwrap(),
        "--adapter",
        kaifuu_engine_fixture::FIXTURE_ADAPTER_ID,
        "--translated-patch",
        fixture_dir
            .join("expected/patch-export-v0.2.fr-FR.json")
            .to_str()
            .unwrap(),
        "--translated-source-bridge",
        fixture_dir
            .join("expected/bridge-v0.2.json")
            .to_str()
            .unwrap(),
        "--work-dir",
        work_dir.to_str().unwrap(),
        "--output",
        report_path.to_str().unwrap(),
    ]);

    let report: GoldenRoundTripReport = read_json(&report_path).unwrap();
    assert_eq!(report.status, OperationStatus::Passed);
    assert!(report.failures.is_empty());
    assert!(report.phases.iter().any(|phase| {
        phase.phase == "byte_equivalence" && phase.status == GoldenAssertionStatus::Skipped
    }));
    assert!(report.phases.iter().any(|phase| {
        phase.phase == "translated_target_equivalence"
            && phase.status == GoldenAssertionStatus::Passed
    }));
    assert!(
        fs::read_to_string(work_dir.join("translated-patch/source.json"))
            .unwrap()
            .contains("Bonjour, {player}.")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn golden_command_accepts_v02_translated_patch_with_native_source_hashes() {
    let root = temp_dir("golden-public-translated-no-source-bridge");
    let fixture_dir = public_fixture_dir();
    let patch_export = native_source_patch_export();
    let patch_path = root.join("native-source-patch-export.json");
    write_json(&patch_path, &patch_export).unwrap();
    let report_path = root.join("golden-report.json");
    let work_dir = root.join("golden-work");

    run_cli(&[
        "golden",
        fixture_dir.to_str().unwrap(),
        "--adapter",
        kaifuu_engine_fixture::FIXTURE_ADAPTER_ID,
        "--translated-patch",
        patch_path.to_str().unwrap(),
        "--work-dir",
        work_dir.to_str().unwrap(),
        "--output",
        report_path.to_str().unwrap(),
    ]);

    let report: GoldenRoundTripReport = read_json(&report_path).unwrap();
    assert_eq!(report.status, OperationStatus::Passed);
    assert!(report.failures.is_empty());
    assert!(report.phases.iter().any(|phase| {
        phase.phase == "translated_source_compatibility"
            && phase.status == GoldenAssertionStatus::Passed
            && phase.details.contains("native adapter extraction")
    }));
    assert!(work_dir.join("translated-patch/source.json").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn golden_command_rejects_native_v02_source_hash_mismatch_before_patch_write() {
    let root = temp_dir("golden-public-native-source-hash-mismatch");
    let fixture_dir = public_fixture_dir();
    let patch_export = native_source_hash_mismatch_patch_export();
    let patch_path = root.join("native-source-hash-mismatch-patch-export.json");
    write_json(&patch_path, &patch_export).unwrap();
    let report_path = root.join("golden-report.json");
    let work_dir = root.join("golden-work");

    let result = run_with_args(
        [
            "golden",
            fixture_dir.to_str().unwrap(),
            "--adapter",
            kaifuu_engine_fixture::FIXTURE_ADAPTER_ID,
            "--translated-patch",
            patch_path.to_str().unwrap(),
            "--work-dir",
            work_dir.to_str().unwrap(),
            "--output",
            report_path.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    assert!(result.is_err());
    let report: GoldenRoundTripReport = read_json(&report_path).unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    let failure = report
        .failures
        .iter()
        .find(|failure| failure.code == "translated_source_hash_mismatch")
        .expect("native source hash mismatch failure");
    assert_eq!(failure.phase, "translated_source_compatibility");
    assert_eq!(
        failure.asset_ref.as_deref(),
        Some("source.json#hello.scene.001.line.001")
    );
    assert!(failure.message.contains("native adapter extraction"));
    assert!(!report.phases.iter().any(|phase| {
        phase.phase == "translated_patch_conversion" || phase.phase == "translated_patch"
    }));
    assert!(!work_dir.join("translated-patch/source.json").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn golden_command_returns_error_and_report_for_translated_patch_failure() {
    let root = temp_dir("golden-public-translated-failure");
    let fixture_dir = public_fixture_dir();
    let mut patch_export: serde_json::Value =
        read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
    patch_export["entries"][0]["targetText"] = serde_json::json!("Bonjour.");
    let patch_path = root.join("bad-patch-export.json");
    write_json(&patch_path, &patch_export).unwrap();
    let report_path = root.join("golden-report.json");
    let work_dir = root.join("golden-work");

    let result = run_with_args(
        [
            "golden",
            fixture_dir.to_str().unwrap(),
            "--adapter",
            kaifuu_engine_fixture::FIXTURE_ADAPTER_ID,
            "--translated-patch",
            patch_path.to_str().unwrap(),
            "--translated-source-bridge",
            fixture_dir
                .join("expected/bridge-v0.2.json")
                .to_str()
                .unwrap(),
            "--work-dir",
            work_dir.to_str().unwrap(),
            "--output",
            report_path.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    assert!(result.is_err());
    let report: GoldenRoundTripReport = read_json(&report_path).unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.failures.iter().any(|failure| {
        failure.phase == "translated_source_compatibility"
            && failure.code == "translated_protected_span_mapping_mismatch"
            && failure.source_unit_key.as_deref() == Some("hello.scene.001.line.001")
            && failure
                .asset_ref
                .as_deref()
                .unwrap_or("")
                .contains("script/prologue#hello.scene.001.line.001")
    }));

    let _ = fs::remove_dir_all(root);
}
