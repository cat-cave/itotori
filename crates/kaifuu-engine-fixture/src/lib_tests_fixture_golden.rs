use super::*;

#[test]
fn public_fixture_round_trip_report_matches_reviewed_golden_artifact() {
    let fixture_dir = public_fixture_dir();
    let work_dir = temp_dir("golden-public-report-artifact");
    let patch_export: Value =
        read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
    let source_bridge: Value = read_json(&fixture_dir.join("expected/bridge-v0.2.json")).unwrap();

    let report = run_round_trip_golden(
            &registry(),
            GoldenHarnessRequest {
                game_dir: &fixture_dir,
                work_dir: &work_dir,
                adapter_id: Some(FIXTURE_ADAPTER_ID),
                byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                    support_boundary:
                        "byte-identical round-trip is not claimed unless --expect-byte-identical is set for an adapter known to support byte-stable patching"
                            .to_string(),
                },
                translated_patch_export: Some(&patch_export),
                translated_source_bridge: Some(&source_bridge),
            },
        )
        .unwrap();
    let actual = report.stable_json().unwrap();
    let expected =
        fs::read_to_string(fixture_dir.join("expected/round-trip-golden-report-v0.1.json"))
            .unwrap();

    assert_eq!(actual, expected);
    let _ = fs::remove_dir_all(work_dir);
}

#[test]
fn round_trip_golden_harness_cites_exact_unit_for_translated_patch_failure() {
    let fixture_dir = public_fixture_dir();
    let work_dir = temp_dir("golden-public-v02-negative");
    let mut patch_export: Value =
        read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
    patch_export["entries"][0]["targetText"] = json!("Bonjour.");
    let source_bridge: Value = read_json(&fixture_dir.join("expected/bridge-v0.2.json")).unwrap();

    let report = run_round_trip_golden(
            &registry(),
            GoldenHarnessRequest {
                game_dir: &fixture_dir,
                work_dir: &work_dir,
                adapter_id: Some(FIXTURE_ADAPTER_ID),
                byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                    support_boundary:
                        "fixture adapter rewrites source.json as pretty JSON and writes targetText fields"
                            .to_string(),
                },
                translated_patch_export: Some(&patch_export),
                translated_source_bridge: Some(&source_bridge),
            },
        )
        .unwrap();

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.failures.iter().any(|failure| {
        failure.phase == "translated_source_compatibility"
            && failure.source_unit_key.as_deref() == Some("hello.scene.001.line.001")
            && failure
                .asset_ref
                .as_deref()
                .unwrap_or("")
                .contains("#hello.scene.001.line.001")
            && failure.code == "translated_protected_span_mapping_mismatch"
    }));
    assert!(!work_dir.join("translated-patch/source.json").exists());
    let _ = fs::remove_dir_all(work_dir);
}

#[test]
fn round_trip_golden_harness_rejects_stale_v02_source_hash_before_translation() {
    let fixture_dir = public_fixture_dir();
    let work_dir = temp_dir("golden-public-v02-stale");
    let mut patch_export: Value =
        read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
    patch_export["entries"][0]["sourceHash"] =
        json!("sha256:0000000000000000000000000000000000000000000000000000000000000000");
    let source_bridge: Value = read_json(&fixture_dir.join("expected/bridge-v0.2.json")).unwrap();

    let report = run_round_trip_golden(
            &registry(),
            GoldenHarnessRequest {
                game_dir: &fixture_dir,
                work_dir: &work_dir,
                adapter_id: Some(FIXTURE_ADAPTER_ID),
                byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                    support_boundary:
                        "fixture adapter rewrites source.json as pretty JSON and writes targetText fields"
                            .to_string(),
                },
                translated_patch_export: Some(&patch_export),
                translated_source_bridge: Some(&source_bridge),
            },
        )
        .unwrap();

    assert_eq!(report.status, OperationStatus::Failed);
    let failure = report
        .failures
        .iter()
        .find(|failure| failure.code == "translated_source_hash_mismatch")
        .expect("source hash mismatch failure");
    assert_eq!(
        failure.source_unit_key.as_deref(),
        Some("hello.scene.001.line.001")
    );
    assert!(failure.asset_ref.as_deref().unwrap_or("").contains('#'));
    assert!(
        !report
            .phases
            .iter()
            .any(|phase| phase.phase == "translated_patch")
    );
    let _ = fs::remove_dir_all(work_dir);
}

#[test]
fn native_source_hash_mismatch_blocks_translation_before_patch_write() {
    let fixture_dir = public_fixture_dir();
    let work_dir = temp_dir("golden-native-v02-source-hash-mismatch");
    let patch_export = native_source_hash_mismatch_patch_fixture();

    let report = run_round_trip_golden(
            &registry(),
            GoldenHarnessRequest {
                game_dir: &fixture_dir,
                work_dir: &work_dir,
                adapter_id: Some(FIXTURE_ADAPTER_ID),
                byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                    support_boundary:
                        "fixture adapter rewrites source.json as pretty JSON and writes targetText fields"
                            .to_string(),
                },
                translated_patch_export: Some(&patch_export),
                translated_source_bridge: None,
            },
        )
        .unwrap();

    assert_eq!(report.status, OperationStatus::Failed);
    let failure = report
        .failures
        .iter()
        .find(|failure| failure.code == "translated_source_hash_mismatch")
        .expect("native source hash mismatch failure");
    assert_eq!(failure.phase, "translated_source_compatibility");
    assert_eq!(
        failure.source_unit_key.as_deref(),
        Some("hello.scene.001.line.001")
    );
    assert_eq!(
        failure.asset_ref.as_deref(),
        Some("source.json#hello.scene.001.line.001")
    );
    assert!(failure.message.contains("native adapter extraction"));
    assert_eq!(
        failure.actual.as_deref(),
        Some("sha256:0000000000000000000000000000000000000000000000000000000000000000")
    );
    assert!(!report.phases.iter().any(|phase| {
        phase.phase == "translated_patch_conversion" || phase.phase == "translated_patch"
    }));
    assert!(!work_dir.join("translated-patch/source.json").exists());
    let _ = fs::remove_dir_all(work_dir);
}

#[test]
fn unmatched_patch_source_unit_key_fails_without_full_pass() {
    let game_dir = temp_game("unmatched-key");
    let adapter = FixtureAdapter;
    let extraction = adapter
        .extract(ExtractRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    let mut patch_export = patch_export_for(&extraction);
    patch_export.entries[0].source_unit_key = "missing.scene.line".to_string();

    let output_dir = game_dir.join("patched");
    let patch = adapter
        .patch(PatchRequest {
            game_dir: &game_dir,
            patch_export: &patch_export,
            output_dir: &output_dir,
        })
        .unwrap();

    assert_eq!(patch.status, OperationStatus::Failed);
    assert!(patch.failures.iter().any(|failure| {
        failure.error_code == "unmatched_source_unit_key"
            && failure
                .asset_ref
                .as_deref()
                .unwrap_or("")
                .contains("missing.scene.line")
    }));
    assert!(!output_dir.join("source.json").exists());
    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn source_hash_mismatch_fails_without_full_pass() {
    let game_dir = temp_game("stale-hash");
    let adapter = FixtureAdapter;
    let extraction = adapter
        .extract(ExtractRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    let mut patch_export = patch_export_for(&extraction);
    patch_export.entries[0].source_hash = "stale-source-hash".to_string();

    let output_dir = game_dir.join("patched");
    let patch = adapter
        .patch(PatchRequest {
            game_dir: &game_dir,
            patch_export: &patch_export,
            output_dir: &output_dir,
        })
        .unwrap();

    assert_eq!(patch.status, OperationStatus::Failed);
    assert!(patch.failures.iter().any(|failure| {
        failure.error_code == "source_hash_mismatch"
            && failure.required_capability == Some(Capability::LineParityPatching)
    }));
    assert!(!output_dir.join("source.json").exists());
    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn missing_protected_span_in_patch_target_fails_without_writing_output() {
    let game_dir = temp_game("missing-protected-span");
    let adapter = FixtureAdapter;
    let extraction = adapter
        .extract(ExtractRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    let mut patch_export = patch_export_for(&extraction);
    patch_export.entries[0].target_text = "Hello.".to_string();

    let output_dir = game_dir.join("patched");
    let patch = adapter
        .patch(PatchRequest {
            game_dir: &game_dir,
            patch_export: &patch_export,
            output_dir: &output_dir,
        })
        .unwrap();

    assert_eq!(patch.status, OperationStatus::Failed);
    assert!(patch.failures.iter().any(|failure| {
        failure.error_code == "protected_span_missing"
            && failure
                .asset_ref
                .as_deref()
                .unwrap_or("")
                .contains("hello.scene.001.line.001")
    }));
    assert!(!output_dir.join("source.json").exists());
    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn empty_protected_span_mappings_do_not_bypass_source_required_spans() {
    let game_dir = temp_game("empty-mappings-missing-protected-span");
    let adapter = FixtureAdapter;
    let extraction = adapter
        .extract(ExtractRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    let mut patch_export = patch_export_for(&extraction);
    patch_export.entries[0].target_text = "Hello.".to_string();
    patch_export.entries[0].protected_span_mappings.clear();

    let output_dir = game_dir.join("patched");
    let patch = adapter
        .patch(PatchRequest {
            game_dir: &game_dir,
            patch_export: &patch_export,
            output_dir: &output_dir,
        })
        .unwrap();

    assert_eq!(patch.status, OperationStatus::Failed);
    assert!(patch.failures.iter().any(|failure| {
        failure.error_code == "protected_span_missing"
            && failure
                .remediation
                .as_deref()
                .unwrap_or("")
                .contains("{player}")
    }));
    assert!(!output_dir.join("source.json").exists());
    let _ = fs::remove_dir_all(game_dir);
}
