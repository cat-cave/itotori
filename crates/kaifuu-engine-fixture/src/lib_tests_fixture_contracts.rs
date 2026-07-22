use super::*;

#[test]
fn validation_failure_preserves_existing_output_file() {
    let game_dir = temp_game("failed-preserves-output");
    let adapter = FixtureAdapter;
    let extraction = adapter
        .extract(ExtractRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    let mut patch_export = patch_export_for(&extraction);
    patch_export.entries[0].source_hash = "stale-source-hash".to_string();

    let output_dir = game_dir.join("patched");
    fs::create_dir_all(&output_dir).unwrap();
    let existing_output = output_dir.join("source.json");
    fs::write(&existing_output, "preexisting output\n").unwrap();

    let patch = adapter
        .patch(PatchRequest {
            game_dir: &game_dir,
            patch_export: &patch_export,
            output_dir: &output_dir,
        })
        .unwrap();

    assert_eq!(patch.status, OperationStatus::Failed);
    assert_eq!(
        fs::read_to_string(&existing_output).unwrap(),
        "preexisting output\n"
    );
    let temp_entries = fs::read_dir(&output_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".source.json.tmp-")
        })
        .count();
    assert_eq!(temp_entries, 0);
    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn duplicate_patch_source_unit_key_fails_without_writing_output() {
    let game_dir = temp_game("duplicate-key");
    let adapter = FixtureAdapter;
    let extraction = adapter
        .extract(ExtractRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    let mut patch_export = patch_export_for(&extraction);
    let mut duplicate_entry = patch_export.entries[0].clone();
    duplicate_entry.target_text = "Ignored duplicate should fail.".to_string();
    patch_export.entries.push(duplicate_entry);

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
        failure.error_code == "duplicate_source_unit_key"
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
fn duplicate_source_unit_key_in_source_fails_without_writing_output() {
    let game_dir = temp_game("duplicate-source-key");
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
      "sourceText": "最初の行。",
      "protectedSpans": []
    },
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "二番目の行。",
      "protectedSpans": []
    }
  ]
}
"#,
    )
    .unwrap();
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 1),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![kaifuu_core::PatchExportEntry {
            bridge_unit_id: deterministic_id("bridge-unit", 2),
            source_unit_key: "hello.scene.001.line.001".to_string(),
            source_hash: content_hash("二番目の行。"),
            target_text: "Second line.".to_string(),
            protected_span_mappings: vec![],
        }],
    };

    let output_dir = game_dir.join("patched");
    let patch = FixtureAdapter
        .patch(PatchRequest {
            game_dir: &game_dir,
            patch_export: &patch_export,
            output_dir: &output_dir,
        })
        .unwrap();

    assert_eq!(patch.status, OperationStatus::Failed);
    assert!(patch.failures.iter().any(|failure| {
        failure.error_code == "duplicate_source_unit_key_in_source"
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
fn fixture_text_surface_parsing_stays_in_fixture_adapter() {
    assert_eq!(
        FixtureAdapter::text_surface_from_fixture_name("speaker_name"),
        TextSurface::SpeakerName
    );
    assert_eq!(
        FixtureAdapter::text_surface_from_fixture_name("image_text"),
        TextSurface::ImageText
    );
    assert_eq!(
        FixtureAdapter::text_surface_from_fixture_name("unknown_fixture_surface"),
        TextSurface::Dialogue
    );
}

#[test]
fn capabilities_report_unsupported_patching_limitations() {
    let capabilities = FixtureAdapter.capabilities();
    assert!(capabilities.key_requirements.is_empty());
    assert!(capabilities.reports.iter().any(|report| {
        report.capability == Capability::AssetInventory
            && report.status == kaifuu_core::CapabilityStatus::Supported
    }));
    assert!(capabilities.reports.iter().any(|report| {
        report.capability == Capability::NonTextSurfaceExtraction
            && report.status == kaifuu_core::CapabilityStatus::Limited
            && report
                .limitation
                .as_deref()
                .unwrap_or("")
                .contains("does not perform OCR")
    }));
    assert!(capabilities.reports.iter().any(|report| {
        report.capability == Capability::LineParityPatching
            && report.status == kaifuu_core::CapabilityStatus::Limited
            && report
                .limitation
                .as_deref()
                .unwrap_or("")
                .contains("sourceUnitKey")
    }));
    assert!(capabilities.reports.iter().any(|report| {
        report.capability == Capability::ContainerAccess
            && report.status == kaifuu_core::CapabilityStatus::Supported
    }));
    assert!(capabilities.reports.iter().any(|report| {
        report.capability == Capability::CryptoAccess
            && report.status == kaifuu_core::CapabilityStatus::Supported
    }));
    assert!(capabilities.reports.iter().any(|report| {
        report.capability == Capability::CodecAccess
            && report.status == kaifuu_core::CapabilityStatus::Supported
    }));
    assert!(capabilities.reports.iter().any(|report| {
        report.capability == Capability::PatchBack
            && report.status == kaifuu_core::CapabilityStatus::Limited
    }));
    assert!(capabilities.access_contract.is_some());
    assert!(capabilities.reports.iter().any(|report| {
        report.capability == Capability::AssetTextPatching
            && report.status == kaifuu_core::CapabilityStatus::Unsupported
    }));
    assert!(capabilities.reports.iter().any(|report| {
        report.capability == Capability::DeltaPatching
            && report.status == kaifuu_core::CapabilityStatus::Unsupported
    }));
    assert!(capabilities.reports.iter().any(|report| {
        report.capability == Capability::EncryptedInput
            && report.status == kaifuu_core::CapabilityStatus::Unsupported
    }));
    assert!(capabilities.reports.iter().any(|report| {
        report.capability == Capability::KeyProfile
            && report.status == kaifuu_core::CapabilityStatus::Unsupported
    }));
    assert!(capabilities.reports.iter().any(|report| {
        report.capability == Capability::RuntimeVm
            && report.status == kaifuu_core::CapabilityStatus::Unsupported
    }));
}

// detector level-matrix snapshot tests. Each detector must
// emit a stable typed matrix so consumers can rely on the strict gate.
#[test]
fn fixture_adapter_level_matrix_is_stable() {
    use kaifuu_core::{CapabilityLevel, CapabilityLevelStatus};
    let matrix = FixtureAdapter.capabilities().level_matrix;
    assert_eq!(matrix.adapter_id, FIXTURE_ADAPTER_ID);
    assert!(matrix.supports(CapabilityLevel::Identify));
    assert!(matrix.supports(CapabilityLevel::Inventory));
    assert!(matrix.supports(CapabilityLevel::Extract));
    // Patch is Partial — not Supported — per fixture line-parity policy.
    assert!(!matrix.supports(CapabilityLevel::Patch));
    assert!(matrix.patch.is_partial());
    if let CapabilityLevelStatus::Partial { limitations } = &matrix.patch {
        assert!(
            limitations.iter().any(|l| l.contains("source.json")),
            "expected line-parity limitation"
        );
    }
}

#[test]
fn xp3_detector_level_matrix_is_identify_and_inventory_only() {
    use kaifuu_core::CapabilityLevel;
    let matrix = Xp3ProfileDetectorAdapter.capabilities().level_matrix;
    assert_eq!(matrix.adapter_id, XP3_DETECTOR_ADAPTER_ID);
    assert!(matrix.supports(CapabilityLevel::Identify));
    assert!(matrix.supports(CapabilityLevel::Inventory));
    assert!(matrix.extract.is_unsupported());
    assert!(matrix.patch.is_unsupported());
}

#[test]
fn siglus_detector_level_matrix_is_identify_only() {
    use kaifuu_core::CapabilityLevel;
    let matrix = SiglusProfileDetectorAdapter.capabilities().level_matrix;
    assert_eq!(matrix.adapter_id, SIGLUS_DETECTOR_ADAPTER_ID);
    assert!(matrix.supports(CapabilityLevel::Identify));
    // Higher rungs are identify-only — explicit conservative override.
    assert!(matrix.inventory.is_unsupported());
    assert!(matrix.extract.is_unsupported());
    assert!(matrix.patch.is_unsupported());
}

#[test]
fn reallive_adapter_level_matrix_extract_and_patch_are_partial() {
    use kaifuu_core::CapabilityLevel;
    let matrix = RealLiveProfileDetectorAdapter.capabilities().level_matrix;
    assert_eq!(matrix.adapter_id, REALLIVE_DETECTOR_ADAPTER_ID);
    assert!(matrix.supports(CapabilityLevel::Identify));
    assert!(matrix.supports(CapabilityLevel::Inventory));
    // Extract is Partial: Scene parser covers text only.
    assert!(!matrix.supports(CapabilityLevel::Extract));
    assert!(matrix.extract.is_partial());
    // Patch is Partial: length-changing single-scene slot
    // replacement is real, but multi-scene archive rebuild is not claimed.
    assert!(!matrix.supports(CapabilityLevel::Patch));
    assert!(matrix.patch.is_partial());
}

#[test]
fn detectors_level_matrices_do_not_overclaim_against_reports() {
    use kaifuu_core::AdapterCapabilityMatrix;
    for capabilities in [
        FixtureAdapter.capabilities(),
        Xp3ProfileDetectorAdapter.capabilities(),
        SiglusProfileDetectorAdapter.capabilities(),
        RealLiveProfileDetectorAdapter.capabilities(),
        SoftpalProfileDetectorAdapter.capabilities(),
    ] {
        let derived = AdapterCapabilityMatrix::derive_from_reports(
            &capabilities.adapter_id,
            &capabilities.reports,
        );
        assert!(
            capabilities
                .level_matrix
                .first_overclaim_against(&derived)
                .is_none(),
            "{} declared level_matrix overclaims against per-Capability reports",
            capabilities.adapter_id
        );
    }
}
