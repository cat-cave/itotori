use super::*;

#[test]
fn fixture_uses_engine_adapter_trait_for_round_trip() {
    let game_dir = temp_game("round-trip");
    let adapter: &dyn EngineAdapter = &FixtureAdapter;
    let detection = adapter
        .detect(DetectRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    assert!(detection.detected);

    let extraction = adapter
        .extract(ExtractRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    assert_eq!(extraction.bridge.units.len(), 1);
    assert_eq!(extraction.profile.engine.adapter_id, FIXTURE_ADAPTER_ID);

    let output_dir = game_dir.join("patched");
    let patch_export = patch_export_for(&extraction);
    let patch = adapter
        .patch(PatchRequest {
            game_dir: &game_dir,
            patch_export: &patch_export,
            output_dir: &output_dir,
        })
        .unwrap();
    assert_eq!(patch.status, OperationStatus::Passed);
    let verify = adapter
        .verify(VerifyRequest {
            game_dir: &output_dir,
        })
        .unwrap();
    assert_eq!(verify.status, OperationStatus::Passed);
    let patched = fs::read_to_string(output_dir.join("source.json")).unwrap();
    assert!(patched.contains("Hello, {player}."));
    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn round_trip_golden_harness_reports_fixture_byte_identity_as_unsupported() {
    let game_dir = temp_game("golden-round-trip");
    let work_dir = game_dir.join("golden-work");
    let report = run_round_trip_golden(
            &registry(),
            GoldenHarnessRequest {
                game_dir: &game_dir,
                work_dir: &work_dir,
                adapter_id: Some(FIXTURE_ADAPTER_ID),
                byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                    support_boundary:
                        "fixture adapter rewrites source.json as pretty JSON and writes targetText fields"
                            .to_string(),
                },
                translated_patch_export: None,
                translated_source_bridge: None,
            },
        )
        .unwrap();

    assert_eq!(report.status, OperationStatus::Passed);
    assert!(report.failures.is_empty());
    let byte_phase = report
        .phases
        .iter()
        .find(|phase| phase.phase == "byte_equivalence")
        .expect("byte equivalence phase");
    assert_eq!(byte_phase.status, GoldenAssertionStatus::Skipped);
    assert!(
        byte_phase
            .support_boundary
            .as_deref()
            .unwrap_or("")
            .contains("rewrites source.json")
    );
    assert!(report.phases.iter().any(|phase| {
        phase.phase == "unchanged_output_equivalence"
            && phase.status == GoldenAssertionStatus::Passed
    }));

    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn round_trip_golden_harness_asserts_assets_via_inventory_and_capability() {
    // the real fixture adapter, driven in adapter-neutral
    // AssertInventory mode. Even though the public fixture happens to ship a
    // source.json, the harness asserts asset preservation + emits
    // capability-aware unsupported-asset diagnostics purely from the adapter's
    // asset inventory + capability reports — the source.json layout is never
    // assumed by the asset-assertion path.
    let fixture_dir = public_fixture_dir();
    let work_dir = temp_dir("golden-inventory-assert");

    let report = run_round_trip_golden(
        &registry(),
        GoldenHarnessRequest {
            game_dir: &fixture_dir,
            work_dir: &work_dir,
            adapter_id: Some(FIXTURE_ADAPTER_ID),
            byte_equivalence: GoldenByteEquivalenceMode::AssertInventory,
            translated_patch_export: None,
            translated_source_bridge: None,
        },
    )
    .unwrap();

    assert_eq!(report.status, OperationStatus::Passed);
    assert!(report.failures.is_empty());

    // Adapter-neutral preservation phase passed (no source.json byte compare).
    let preservation = report
        .phases
        .iter()
        .find(|phase| phase.phase == "inventory_asset_preservation")
        .expect("inventory preservation phase");
    assert_eq!(preservation.status, GoldenAssertionStatus::Passed);
    assert!(
        !report
            .phases
            .iter()
            .any(|phase| phase.phase == "byte_equivalence")
    );

    // The fixture's 6 capability-unsupported asset surfaces each produce a
    // typed capability-aware diagnostic keyed on AssetTextPatching.
    let diagnostics: Vec<_> = report
        .phases
        .iter()
        .filter(|phase| phase.phase == "asset_capability_diagnostic")
        .collect();
    assert_eq!(
        diagnostics.len(),
        6,
        "one diagnostic per unsupported surface"
    );
    assert!(diagnostics.iter().all(|phase| {
        phase.status == GoldenAssertionStatus::Skipped
            && phase.required_capability == Some(Capability::AssetTextPatching)
            && phase.asset_ref.as_deref() != Some("source.json")
    }));

    let _ = fs::remove_dir_all(work_dir);
}

#[test]
fn round_trip_golden_harness_applies_public_v02_translated_patch() {
    let fixture_dir = public_fixture_dir();
    let work_dir = temp_dir("golden-public-v02");
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
                        "fixture adapter rewrites source.json as pretty JSON and writes targetText fields"
                            .to_string(),
                },
                translated_patch_export: Some(&patch_export),
                translated_source_bridge: Some(&source_bridge),
            },
        )
        .unwrap();

    assert_eq!(report.status, OperationStatus::Passed);
    assert!(report.failures.is_empty());
    for phase_name in [
        "translated_patch_contract",
        "translated_source_compatibility",
        "translated_patch_conversion",
        "translated_patch",
        "translated_target_equivalence",
        "translated_verify",
    ] {
        assert!(
            report.phases.iter().any(|phase| {
                phase.phase == phase_name && phase.status == GoldenAssertionStatus::Passed
            }),
            "missing passed phase {phase_name}"
        );
    }

    let patched = fs::read_to_string(work_dir.join("translated-patch/source.json")).unwrap();
    assert!(patched.contains("Bonjour, {player}."));
    assert!(patched.contains("La porte du crepuscule"));
    let _ = fs::remove_dir_all(work_dir);
}

#[test]
fn round_trip_golden_harness_recomputes_native_v02_source_hashes_without_source_bridge() {
    let fixture_dir = public_fixture_dir();
    let source_hashes = native_source_hashes_fixture();
    let extraction = FixtureAdapter
        .extract(ExtractRequest {
            game_dir: &fixture_dir,
        })
        .unwrap();
    assert_eq!(source_hashes.len(), extraction.bridge.units.len());
    for unit in &extraction.bridge.units {
        assert_eq!(
            source_hashes
                .get(&unit.source_unit_key)
                .expect("native source hash for extracted unit"),
            &sha256_hash_bytes(unit.source_text.as_bytes()),
            "fixture hash must be canonical native source text hash for {}",
            unit.source_unit_key
        );
    }

    let patch_export = native_source_patch_fixture();
    let source_bridge = native_source_bridge_fixture();
    let bridge_hashes: BTreeMap<_, _> = source_bridge["units"]
        .as_array()
        .expect("public bridge units")
        .iter()
        .map(|unit| {
            (
                unit["sourceUnitKey"]
                    .as_str()
                    .expect("public bridge sourceUnitKey"),
                unit["sourceHash"]
                    .as_str()
                    .expect("public bridge sourceHash"),
            )
        })
        .collect();
    assert_eq!(
        bridge_hashes,
        source_hashes
            .iter()
            .map(|(source_unit_key, source_hash)| {
                (source_unit_key.as_str(), source_hash.as_str())
            })
            .collect()
    );

    let native_work_dir = temp_dir("golden-native-v02-source-hashes");
    let native_report = run_round_trip_golden(
            &registry(),
            GoldenHarnessRequest {
                game_dir: &fixture_dir,
                work_dir: &native_work_dir,
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
    assert_eq!(native_report.status, OperationStatus::Passed);
    assert!(native_report.failures.is_empty());
    assert!(native_report.phases.iter().any(|phase| {
        phase.phase == "translated_source_compatibility"
            && phase.status == GoldenAssertionStatus::Passed
            && phase.details.contains("native adapter extraction")
    }));
    assert!(
        fs::read_to_string(native_work_dir.join("translated-patch/source.json"))
            .unwrap()
            .contains("Bonjour, {player}.")
    );

    let bridge_work_dir = temp_dir("golden-native-v02-source-hashes-bridge");
    let bridge_report = run_round_trip_golden(
            &registry(),
            GoldenHarnessRequest {
                game_dir: &fixture_dir,
                work_dir: &bridge_work_dir,
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
    assert_eq!(bridge_report.status, OperationStatus::Passed);
    assert!(bridge_report.failures.is_empty());
    assert!(bridge_report.phases.iter().any(|phase| {
        phase.phase == "translated_source_compatibility"
            && phase.status == GoldenAssertionStatus::Passed
            && phase.details.contains("source bridge")
    }));

    let _ = fs::remove_dir_all(native_work_dir);
    let _ = fs::remove_dir_all(bridge_work_dir);
}
