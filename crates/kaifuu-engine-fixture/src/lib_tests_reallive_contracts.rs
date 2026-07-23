use super::*;

#[test]
fn rejects_reallive_extract_request_with_unsupported_layered_transform_error() {
    let dir = reallive_fixture_dir(
        "reallive-extract-unsupported",
        &[
            (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
            (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
        ],
    );
    let failure = adapter_failure_from_error(
        RealLiveProfileDetectorAdapter
            .extract(ExtractRequest { game_dir: &dir })
            .unwrap_err(),
    );
    assert_eq!(failure.error_code, "kaifuu.unsupported_layered_transform");
    assert_eq!(failure.required_capability, Some(Capability::CodecAccess));
    assert_eq!(failure.asset_ref.as_deref(), Some(REALLIVE_SEEN_TXT_PATH));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn rejects_reallive_patch_request_with_unsupported_failures() {
    let dir = reallive_fixture_dir(
        "reallive-patch-unsupported",
        &[
            (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
            (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
        ],
    );
    let export = PatchExport {
        patch_export_id: "kaifuu-reallive-export-001".to_string(),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![],
    };
    let output_dir = temp_dir("reallive-patch-output");
    let result = RealLiveProfileDetectorAdapter
        .patch(PatchRequest {
            game_dir: &dir,
            patch_export: &export,
            output_dir: &output_dir,
        })
        .unwrap();
    assert_eq!(result.status, OperationStatus::Failed);
    assert!(!result.failures.is_empty());
    assert!(
        result
            .failures
            .iter()
            .any(|failure| { failure.error_code == "kaifuu.missing_capability.container" })
    );
    assert!(
        result
            .failures
            .iter()
            .any(|failure| { failure.error_code == "kaifuu.missing_capability.patch_back" })
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn rejects_reallive_verify_request_with_unsupported_layered_transform_error() {
    let dir = reallive_fixture_dir(
        "reallive-verify-unsupported",
        &[
            (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
            (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
        ],
    );
    let result = RealLiveProfileDetectorAdapter
        .verify(VerifyRequest { game_dir: &dir })
        .unwrap();
    assert_eq!(result.status, OperationStatus::Failed);
    assert!(
        result
            .failures
            .iter()
            .any(|failure| { failure.error_code == "kaifuu.unsupported_layered_transform" })
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn reallive_detection_evidence_lists_seen_txt_gameexe_ini_seen_gan_and_g00_counts() {
    let dir = reallive_fixture_dir(
        "reallive-detection-evidence-coverage",
        &[
            (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
            (REALLIVE_SEEN_GAN_PATH, REALLIVE_SEEN_GAN_MAGIC),
            (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
            ("image.g00", b"\0"),
            ("voice.ovk", b"\0"),
        ],
    );
    let detection = RealLiveProfileDetectorAdapter
        .detect(DetectRequest { game_dir: &dir })
        .unwrap();
    let evidence_paths: BTreeSet<_> = detection
        .evidence
        .iter()
        .map(|evidence| evidence.path.as_str())
        .collect();
    for expected in [
        REALLIVE_SEEN_TXT_PATH,
        REALLIVE_SEEN_GAN_PATH,
        REALLIVE_GAMEEXE_INI_PATH,
        "*.g00",
        "*.ovk|*.koe|*.nwk",
        "Scene.pck",
        "Gameexe.dat",
        "*.pdt",
    ] {
        assert!(
            evidence_paths.contains(expected),
            "missing evidence path {expected}"
        );
    }
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn reallive_adapter_capabilities_report_supported_extract_patch_verify() {
    let capabilities = RealLiveProfileDetectorAdapter.capabilities();
    assert_eq!(capabilities.adapter_id, REALLIVE_DETECTOR_ADAPTER_ID);
    let supported: Vec<Capability> = capabilities
        .reports
        .iter()
        .filter(|report| report.status == CapabilityStatus::Supported)
        .map(|report| report.capability.clone())
        .collect();
    for required in [
        Capability::Detection,
        Capability::ProfileGeneration,
        Capability::AssetListing,
        Capability::AssetInventory,
        Capability::Extraction,
        Capability::Verification,
        Capability::ContainerAccess,
        Capability::CodecAccess,
        Capability::PatchBack,
    ] {
        assert!(
            supported.contains(&required),
            "missing supported {required:?}; got: {supported:?}"
        );
    }
    // Patching / AssetTextPatching / LineParityPatching are Limited to
    // one scene-scoped bundle per call and the configured text slots;
    // multi-scene rebuilds and image-overlaid g00 text are out of scope.
    for limited in [
        Capability::Patching,
        Capability::AssetTextPatching,
        Capability::LineParityPatching,
    ] {
        assert!(
            capabilities.reports.iter().any(|report| {
                report.capability == limited && report.status == CapabilityStatus::Limited
            }),
            "missing limited capability {limited:?}"
        );
    }
    // Still Unsupported.
    for unsupported in [
        Capability::CryptoAccess,
        Capability::RuntimeVm,
        Capability::EncryptedInput,
        Capability::KeyProfile,
        Capability::DeltaPatching,
        Capability::NonTextSurfaceExtraction,
    ] {
        assert!(
            capabilities.reports.iter().any(|report| {
                report.capability == unsupported && report.status == CapabilityStatus::Unsupported
            }),
            "missing unsupported capability {unsupported:?}"
        );
    }
    let access = capabilities
        .access_contract
        .as_ref()
        .expect("RealLive adapter must declare a layered access contract");
    assert_eq!(access.identify.status, CapabilityStatus::Supported);
    assert_eq!(access.inventory.status, CapabilityStatus::Supported);
    assert_eq!(access.extract.status, CapabilityStatus::Supported);
    assert_eq!(access.patch.status, CapabilityStatus::Supported);
}

#[test]
fn reallive_detection_report_redacts_game_dir_for_logs_and_reports() {
    let dir = reallive_fixture_dir(
        "reallive-detection-redaction",
        &[
            (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
            (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
        ],
    );
    let detection = RealLiveProfileDetectorAdapter
        .detect(DetectRequest { game_dir: &dir })
        .unwrap();
    let serialized = stable_json(&detection.redacted_for_report()).unwrap();
    let dir_str = dir.to_string_lossy().to_string();
    assert!(
        !serialized.contains(&dir_str),
        "raw game dir leaked into detection report"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn reallive_profile_emits_stable_uuidv7_profile_id_across_runs() {
    let dir_one = reallive_fixture_dir(
        "reallive-stable-profile-one",
        &[
            (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
            (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
        ],
    );
    let dir_two = reallive_fixture_dir(
        "reallive-stable-profile-two",
        &[
            (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
            (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
        ],
    );
    let first = RealLiveProfileDetectorAdapter
        .profile(ProfileRequest { game_dir: &dir_one })
        .unwrap();
    let second = RealLiveProfileDetectorAdapter
        .profile(ProfileRequest { game_dir: &dir_two })
        .unwrap();
    assert_eq!(first.profile_id, REALLIVE_PROFILE_ID);
    assert_eq!(first.profile_id, second.profile_id);
    let _ = fs::remove_dir_all(dir_one);
    let _ = fs::remove_dir_all(dir_two);
}

#[test]
fn reallive_registry_registration_appears_in_adapter_list() {
    let registry = registry();
    let adapters: Vec<_> = registry
        .adapters()
        .iter()
        .map(|adapter| adapter.id())
        .collect();
    assert!(adapters.contains(&REALLIVE_DETECTOR_ADAPTER_ID));
}
