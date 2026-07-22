use super::*;

#[test]
fn empty_protected_span_mappings_fail_even_when_target_contains_raw_span() {
    let game_dir = temp_game("empty-mappings-unrepresented-protected-span");
    let adapter = FixtureAdapter;
    let extraction = adapter
        .extract(ExtractRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    let mut patch_export = patch_export_for(&extraction);
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
            && failure.support_boundary.contains("protectedSpanMappings")
            && failure
                .remediation
                .as_deref()
                .unwrap_or("")
                .contains("{player}")
    }));
    assert!(!output_dir.join("source.json").exists());
    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn duplicate_raw_protected_spans_require_distinct_target_mappings() {
    let game_dir = temp_game("duplicate-raw-protected-spans");
    fs::write(
        game_dir.join("source.json"),
        r#"{
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "{name} meets {name}.",
      "protectedSpans": [
        {
          "kind": "placeholder",
          "raw": "{name}",
          "start": 0,
          "end": 6
        },
        {
          "kind": "placeholder",
          "raw": "{name}",
          "start": 13,
          "end": 19
        }
      ]
    }
  ]
}
"#,
    )
    .unwrap();
    let adapter = FixtureAdapter;
    let extraction = adapter
        .extract(ExtractRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    let unit = &extraction.bridge.units[0];
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 13),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![kaifuu_core::PatchExportEntry {
            bridge_unit_id: unit.bridge_unit_id.clone(),
            source_unit_key: unit.source_unit_key.clone(),
            source_hash: unit.source_hash.clone(),
            target_text: "{name} and {name}.".to_string(),
            protected_span_mappings: vec![
                ProtectedSpanMapping::new("{name}", 0, 6),
                ProtectedSpanMapping::new("{name}", 0, 6),
            ],
        }],
    };

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
        failure.error_code == "protected_span_duplicate_mapping"
            || failure.error_code == "protected_span_missing"
    }));
    assert!(!output_dir.join("source.json").exists());
    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn duplicate_raw_protected_spans_require_valid_source_identity() {
    let game_dir = temp_game("duplicate-raw-protected-span-identity");
    fs::write(
        game_dir.join("source.json"),
        r#"{
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "{name} meets {name}.",
      "protectedSpans": [
        {
          "kind": "placeholder",
          "raw": "{name}",
          "start": 0,
          "end": 6
        },
        {
          "kind": "placeholder",
          "raw": "{name}",
          "start": 13,
          "end": 19
        }
      ]
    }
  ]
}
"#,
    )
    .unwrap();
    let adapter = FixtureAdapter;
    let extraction = adapter
        .extract(ExtractRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    let unit = &extraction.bridge.units[0];
    let first_span = &unit.protected_spans[0];
    let second_span = &unit.protected_spans[1];
    let patch_entry = |protected_span_mappings| kaifuu_core::PatchExportEntry {
        bridge_unit_id: unit.bridge_unit_id.clone(),
        source_unit_key: unit.source_unit_key.clone(),
        source_hash: unit.source_hash.clone(),
        target_text: "{name} and {name}.".to_string(),
        protected_span_mappings,
    };
    let patch_export = |patch_export_id, protected_span_mappings| PatchExport {
        patch_export_id,
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![patch_entry(protected_span_mappings)],
    };

    let missing_identity = patch_export(
        deterministic_id("patch", 14),
        vec![
            ProtectedSpanMapping::new("{name}", 0, 6),
            ProtectedSpanMapping::new("{name}", 11, 17),
        ],
    );
    let wrong_identity = patch_export(
        deterministic_id("patch", 15),
        vec![
            ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                first_span.span_id.clone(),
                first_span.start,
                first_span.end,
            ),
            ProtectedSpanMapping::new("{name}", 11, 17).with_source_identity(
                second_span.span_id.clone(),
                20,
                26,
            ),
        ],
    );
    let reused_identity = patch_export(
        deterministic_id("patch", 16),
        vec![
            ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                first_span.span_id.clone(),
                first_span.start,
                first_span.end,
            ),
            ProtectedSpanMapping::new("{name}", 11, 17).with_source_identity(
                first_span.span_id.clone(),
                first_span.start,
                first_span.end,
            ),
        ],
    );
    let valid = patch_export(
        deterministic_id("patch", 17),
        vec![
            ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                second_span.span_id.clone(),
                second_span.start,
                second_span.end,
            ),
            ProtectedSpanMapping::new("{name}", 11, 17).with_source_identity(
                first_span.span_id.clone(),
                first_span.start,
                first_span.end,
            ),
        ],
    );

    for (index, patch_export) in [missing_identity, wrong_identity, reused_identity]
        .iter()
        .enumerate()
    {
        let output_dir = game_dir.join(format!("patched-invalid-{index}"));
        let patch = adapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export,
                output_dir: &output_dir,
            })
            .unwrap();

        assert_eq!(patch.status, OperationStatus::Failed);
        assert!(patch.failures.iter().any(|failure| {
            failure.error_code == "protected_span_mapping_mismatch"
                || failure.error_code == "protected_span_missing"
        }));
        assert!(!output_dir.join("source.json").exists());
    }

    let output_dir = game_dir.join("patched-valid");
    let patch = adapter
        .patch(PatchRequest {
            game_dir: &game_dir,
            patch_export: &valid,
            output_dir: &output_dir,
        })
        .unwrap();

    assert_eq!(patch.status, OperationStatus::Passed, "{patch:?}");
    assert!(output_dir.join("source.json").exists());
    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn empty_protected_span_mappings_fail_for_source_control_markup() {
    let game_dir = temp_game("empty-mappings-control-markup");
    fs::write(
        game_dir.join("source.json"),
        r#"{
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "待って<wait=30>から進む。",
      "protectedSpans": []
    }
  ]
}
"#,
    )
    .unwrap();
    let adapter = FixtureAdapter;
    let extraction = adapter
        .extract(ExtractRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    let unit = &extraction.bridge.units[0];
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 12),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![kaifuu_core::PatchExportEntry {
            bridge_unit_id: unit.bridge_unit_id.clone(),
            source_unit_key: unit.source_unit_key.clone(),
            source_hash: unit.source_hash.clone(),
            target_text: "Wait, then continue.".to_string(),
            protected_span_mappings: vec![],
        }],
    };

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
                .contains("<wait=30>")
    }));
    assert!(!output_dir.join("source.json").exists());
    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn shared_contract_mappings_missing_from_target_fail_without_writing_output() {
    let game_dir = temp_game("shared-contract-missing-protected-span");
    let adapter = FixtureAdapter;
    let extraction = adapter
        .extract(ExtractRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    let unit = &extraction.bridge.units[0];
    let patch_export_value = json!({
        "schemaVersion": "0.1.0",
        "patchExportId": deterministic_id("patch", 11),
        "sourceBridgeId": extraction.bridge.bridge_id.clone(),
        "sourceLocale": extraction.bridge.source_locale.clone(),
        "targetLocale": "en-US",
        "entries": [
            {
                "entryId": deterministic_id("patchentry", 11),
                "bridgeUnitId": unit.bridge_unit_id.clone(),
                "sourceUnitKey": unit.source_unit_key.clone(),
                "sourceHash": unit.source_hash.clone(),
                "targetText": "Hello.",
                "protectedSpanMappings": [
                    {
                        "raw": "{player}",
                        "targetStart": 7,
                        "targetEnd": 15
                    }
                ]
            }
        ]
    });
    assert!(
        patch_export_value["entries"][0]
            .get("protectedSpans")
            .is_none(),
        "regression payload must not use Rust-only protectedSpans"
    );
    let patch_export = PatchExport::from_value(&patch_export_value).unwrap();

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
