use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_core::{
    AdapterRegistry, AssetInventoryManifest, AssetInventoryRequest, DetectionReport,
    DetectionResult, EngineAdapter, ExtractRequest, GameProfile, GoldenByteEquivalenceMode,
    GoldenHarnessRequest, KaifuuResult, PatchExport, PatchPreflightRequest, PatchRequest,
    PatchResult, ProfileRequest, VerifyRequest, atomic_write_text, read_json,
    redact_for_log_or_report, redact_report_value, run_round_trip_golden, validate_profile_value,
    write_json,
};
use kaifuu_delta::{apply_delta, create_delta};

fn main() {
    if let Err(error) = run() {
        eprintln!("{}", redact_for_log_or_report(&error.to_string()));
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    run_with_args(std::env::args().skip(1).collect())
}

fn run_with_args(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let registry = engine_registry();
    run_with_args_and_registry(args, &registry)
}

fn run_with_args_and_registry(
    args: Vec<String>,
    registry: &AdapterRegistry,
) -> Result<(), Box<dyn std::error::Error>> {
    match args.first().map(String::as_str) {
        Some("detect") => {
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let output = PathBuf::from(flag(&args, "--output")?);
            let detections = registry.detect_all(&game_dir)?;
            write_json(
                &output,
                &DetectionReport::from_results(&game_dir, detections),
            )?;
        }
        Some("extract") => {
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let output = PathBuf::from(flag(&args, "--output")?);
            let adapter = registered_adapter_for_game(registry, &game_dir)?;
            let extraction = adapter.extract(ExtractRequest {
                game_dir: &game_dir,
            })?;
            write_json(&output, &extraction.bridge)?;
        }
        Some("asset-inventory" | "assets") => {
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let output = PathBuf::from(flag(&args, "--output")?);
            let adapter = registered_adapter_for_game(registry, &game_dir)?;
            let manifest = adapter.asset_inventory(AssetInventoryRequest {
                game_dir: &game_dir,
            })?;
            let validation = manifest.validate();
            if validation.status == kaifuu_core::OperationStatus::Failed {
                return Err(format!(
                    "generated asset inventory failed validation: {}",
                    validation
                        .failures
                        .iter()
                        .map(|failure| failure.code.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
                .into());
            }
            write_stable_asset_inventory(&output, &manifest)?;
        }
        Some("patch") => {
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let patch = PathBuf::from(flag(&args, "--patch")?);
            let output = PathBuf::from(flag(&args, "--output")?);
            let patch_export: PatchExport = read_json(&patch)?;
            let adapter = registered_adapter_for_game(registry, &game_dir)?;
            let preflight = adapter
                .patch_preflight(PatchPreflightRequest {
                    game_dir: &game_dir,
                    patch_export: &patch_export,
                })?
                .redacted_for_report();
            if preflight.status == kaifuu_core::OperationStatus::Failed
                && preflight.has_preflight_blocking_failure()
            {
                return Err(format!(
                    "patch preflight failed: {}",
                    preflight.failure_codes().join(", ")
                )
                .into());
            }
            let result = run_patch_with_owned_staging(adapter, &game_dir, &patch_export, &output)?;
            let failed = result.status == kaifuu_core::OperationStatus::Failed;
            if failed {
                return Err(format!(
                    "patch failed; see {}",
                    redact_for_log_or_report(
                        &output.join("patch-result.json").display().to_string()
                    )
                )
                .into());
            }
        }
        Some("diff") => {
            let original = positional(&args, 1)?;
            let patched = positional(&args, 2)?;
            let output = flag(&args, "--output")?;
            write_json(
                &PathBuf::from(output),
                &create_delta(&PathBuf::from(original), &PathBuf::from(patched))?,
            )?;
        }
        Some("apply") => {
            let game_dir = positional(&args, 1)?;
            let patch = flag(&args, "--patch")?;
            let output = flag(&args, "--output")?;
            let result = apply_delta(
                &PathBuf::from(game_dir),
                &PathBuf::from(patch),
                &PathBuf::from(output),
            )?;
            write_json(
                &PathBuf::from(output).join("patch-result.json"),
                &redact_report_value(&result),
            )?;
        }
        Some("verify") => {
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let output = flag_optional(&args, "--output").unwrap_or("verify-result.json");
            let adapter = registered_adapter_for_game(registry, &game_dir)?;
            let result = adapter
                .verify(VerifyRequest {
                    game_dir: &game_dir,
                })?
                .redacted_for_report();
            write_json(&PathBuf::from(output), &result)?;
        }
        Some("golden") => {
            run_golden_command(&args, registry)?;
        }
        Some("profile") => {
            run_profile_command(&args, registry)?;
        }
        Some("capabilities") => {
            let output = PathBuf::from(flag(&args, "--output")?);
            let capabilities = registry
                .adapters()
                .iter()
                .map(|adapter| adapter.capabilities().redacted_for_report())
                .collect::<Vec<_>>();
            write_json(&output, &capabilities)?;
        }
        _ => {
            return Err(
                "usage: kaifuu <detect|extract|asset-inventory|patch|diff|apply|verify|golden|profile|capabilities> ..."
                    .into(),
            );
        }
    }
    Ok(())
}

fn run_patch_with_owned_staging(
    adapter: &dyn EngineAdapter,
    game_dir: &Path,
    patch_export: &PatchExport,
    output: &Path,
) -> KaifuuResult<PatchResult> {
    let staging_output = allocate_patch_staging_dir(output)?;
    let result = match adapter.patch(PatchRequest {
        game_dir,
        patch_export,
        output_dir: &staging_output,
    }) {
        Ok(result) => result.redacted_for_report(),
        Err(error) => {
            remove_patch_staging_dir(&staging_output)?;
            return Err(error);
        }
    };
    let failed = result.status == kaifuu_core::OperationStatus::Failed;
    if failed && result.has_preflight_blocking_failure() {
        remove_patch_staging_dir(&staging_output)?;
        return Err(format!(
            "patch preflight failed: {}",
            result.failure_codes().join(", ")
        )
        .into());
    }
    if let Err(error) = write_json(&staging_output.join("patch-result.json"), &result) {
        remove_patch_staging_dir(&staging_output)?;
        return Err(error);
    }
    if let Err(error) = promote_patch_staging_dir(&staging_output, output) {
        remove_patch_staging_dir(&staging_output)?;
        return Err(error);
    }
    Ok(result)
}

fn run_golden_command(
    args: &[String],
    registry: &AdapterRegistry,
) -> Result<(), Box<dyn std::error::Error>> {
    let game_dir = PathBuf::from(positional(args, 1)?);
    let output = PathBuf::from(flag(args, "--output")?);
    let work_dir = flag_optional(args, "--work-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| output.with_extension("work"));
    let translated_patch_export = flag_optional(args, "--translated-patch")
        .map(PathBuf::from)
        .map(|path| read_json::<serde_json::Value>(&path))
        .transpose()?;
    let translated_source_bridge = flag_optional(args, "--translated-source-bridge")
        .map(PathBuf::from)
        .map(|path| read_json::<serde_json::Value>(&path))
        .transpose()?;
    let byte_equivalence = if flag_present(args, "--expect-byte-identical") {
        GoldenByteEquivalenceMode::AssertSourceJson
    } else {
        GoldenByteEquivalenceMode::Unsupported {
            support_boundary:
                "byte-identical round-trip is not claimed unless --expect-byte-identical is set for an adapter known to support byte-stable patching"
                    .to_string(),
        }
    };
    let report = run_round_trip_golden(
        registry,
        GoldenHarnessRequest {
            game_dir: &game_dir,
            work_dir: &work_dir,
            adapter_id: flag_optional(args, "--adapter"),
            byte_equivalence,
            translated_patch_export: translated_patch_export.as_ref(),
            translated_source_bridge: translated_source_bridge.as_ref(),
        },
    )?;
    let report = report.redacted_for_report();
    let failed = report.status == kaifuu_core::OperationStatus::Failed;
    write_json(&output, &report)?;
    if failed {
        return Err(format!(
            "golden round-trip failed; report written to {}",
            redact_for_log_or_report(&output.display().to_string())
        )
        .into());
    }
    Ok(())
}

fn run_profile_command(
    args: &[String],
    registry: &AdapterRegistry,
) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "init" => {
            let game_dir = PathBuf::from(positional(args, 2)?);
            let output = PathBuf::from(flag(args, "--output")?);
            let adapter = registered_adapter_for_game(registry, &game_dir)?;
            let profile = adapter.profile(ProfileRequest {
                game_dir: &game_dir,
            })?;
            write_validated_stable_profile(&output, &profile)?;
        }
        "validate" => {
            let profile_path = PathBuf::from(positional(args, 2)?);
            let output = PathBuf::from(flag(args, "--output")?);
            let profile: serde_json::Value = read_json(&profile_path)?;
            write_json(
                &output,
                &validate_profile_value(&profile).redacted_for_report(),
            )?;
        }
        _ => {
            let game_dir = PathBuf::from(positional(args, 1)?);
            let output = PathBuf::from(flag(args, "--output")?);
            let adapter = registered_adapter_for_game(registry, &game_dir)?;
            let profile = adapter.profile(ProfileRequest {
                game_dir: &game_dir,
            })?;
            write_validated_stable_profile(&output, &profile)?;
        }
    }
    Ok(())
}

fn engine_registry() -> AdapterRegistry {
    kaifuu_engine_fixture::registry()
}

fn detect_registered_adapter(
    registry: &AdapterRegistry,
    game_dir: &Path,
) -> KaifuuResult<DetectionResult> {
    registry.detect(game_dir)?.ok_or_else(|| {
        format!(
            "no registered adapter detected {}",
            redact_for_log_or_report(&game_dir.display().to_string())
        )
        .into()
    })
}

fn registered_adapter_for_game<'a>(
    registry: &'a AdapterRegistry,
    game_dir: &Path,
) -> KaifuuResult<&'a dyn EngineAdapter> {
    let detection = detect_registered_adapter(registry, game_dir)?;
    registry.get(&detection.adapter_id).ok_or_else(|| {
        format!(
            "detected adapter {} is not registered",
            detection.adapter_id
        )
        .into()
    })
}

fn write_validated_stable_profile(output: &Path, profile: &GameProfile) -> KaifuuResult<()> {
    let mut normalized = profile.clone();
    normalized.normalize();
    let value = serde_json::to_value(&normalized)?;
    let validation = validate_profile_value(&value);
    if validation.status == kaifuu_core::OperationStatus::Failed {
        let validation = validation.redacted_for_report();
        return Err(format!(
            "generated profile failed validation: {}",
            validation
                .failures
                .iter()
                .map(|failure| failure.code.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
        .into());
    }
    atomic_write_text(
        output,
        &kaifuu_core::stable_json(&redact_report_value(&value))?,
    )
}

fn write_stable_asset_inventory(
    output: &Path,
    manifest: &AssetInventoryManifest,
) -> KaifuuResult<()> {
    let mut normalized = manifest.clone();
    normalized.normalize();
    let value = serde_json::to_value(&normalized)?;
    atomic_write_text(
        output,
        &kaifuu_core::stable_json(&redact_report_value(&value))?,
    )
}

fn allocate_patch_staging_dir(output: &Path) -> KaifuuResult<PathBuf> {
    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let file_name = output
        .file_name()
        .ok_or("patch output directory must include a final path component")?
        .to_string_lossy();
    for attempt in 0..1000 {
        let staging = parent.join(format!(
            ".{file_name}.kaifuu-staging-{}-{attempt}",
            std::process::id()
        ));
        match fs::create_dir(&staging) {
            Ok(()) => return Ok(staging),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err("could not allocate a unique patch staging directory".into())
}

fn remove_patch_staging_dir(staging_output: &Path) -> KaifuuResult<()> {
    match fs::remove_dir_all(staging_output) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn promote_patch_staging_dir(staging_output: &Path, output: &Path) -> KaifuuResult<()> {
    if output.exists() {
        return Err(format!(
            "patch output directory already exists: {}",
            redact_for_log_or_report(&output.display().to_string())
        )
        .into());
    }
    fs::rename(staging_output, output)?;
    Ok(())
}

fn positional(args: &[String], index: usize) -> Result<&str, Box<dyn std::error::Error>> {
    args.get(index)
        .map(String::as_str)
        .ok_or_else(|| format!("missing positional argument {index}").into())
}

fn flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn std::error::Error>> {
    flag_optional(args, name).ok_or_else(|| format!("missing flag {name}").into())
}

fn flag_optional<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

fn flag_present(args: &[String], name: &str) -> bool {
    args.iter().any(|arg| arg == name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaifuu_core::{
        ASSET_INVENTORY_SCHEMA_VERSION, AdapterCapabilities, AdapterFailure, AdapterWarning,
        ArchiveDetectionSignal, ArchiveDetectionStatus, AssetInventoryAsset,
        AssetInventoryAssetKind, AssetInventoryAssetRef, AssetInventoryPatchMode,
        AssetInventorySurface, AssetInventorySurfaceKind, AssetInventoryTextSourceKind, AssetKind,
        AssetList, AssetListRequest, AssetProfile, BridgeBundle, BridgeUnit, Capability,
        CapabilityReport, CapabilityStatus, DetectRequest, DetectionEvidence,
        DetectionReportStatus, EngineProfile, EvidenceStatus, ExtractionResult,
        GoldenAssertionStatus, GoldenRoundTripReport, LayeredAccessPreflightReport,
        LayeredAccessPreflightRequirement, LayeredAccessStage, OperationStatus, PatchExportEntry,
        PatchRef, PatchResult, ProfileRequirement, ProtectedSpanMapping,
        REDACTED_DETECTION_GAME_DIR, RequirementCategory, RequirementStatus, SemanticErrorCode,
        TextSurface, VerificationResult, content_hash, deterministic_id, read_json,
    };
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::fs;
    use std::rc::Rc;
    use std::time::{SystemTime, UNIX_EPOCH};

    const TEST_ADAPTER_ID: &str = "kaifuu.test.registry";

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("kaifuu-cli-{name}-{}-{nonce}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn temp_game(root: &Path) -> PathBuf {
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
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
      "sourceText": "こんにちは、{player}。",
      "protectedSpans": [
        {
          "kind": "placeholder",
          "raw": "{player}",
          "start": 6,
          "end": 14
        }
      ]
    }
  ]
}
"#,
        )
        .unwrap();
        game_dir
    }

    fn public_fixture_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/hello-game")
    }

    fn public_fixture_path(relative_path: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(relative_path)
    }

    fn write_fixture_file(root: &Path, relative_path: &str, bytes: &[u8]) {
        let path = root.join(relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, bytes).unwrap();
    }

    fn run_cli(args: &[&str]) {
        run_with_args(args.iter().map(|arg| arg.to_string()).collect()).unwrap();
    }

    fn run_cli_with_registry(args: &[&str], registry: &AdapterRegistry) {
        run_cli_with_registry_result(args, registry).unwrap();
    }

    fn run_cli_with_registry_result(
        args: &[&str],
        registry: &AdapterRegistry,
    ) -> Result<(), Box<dyn std::error::Error>> {
        run_with_args_and_registry(args.iter().map(|arg| arg.to_string()).collect(), registry)
    }

    fn test_capabilities() -> AdapterCapabilities {
        AdapterCapabilities::new(
            TEST_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::Extraction),
                CapabilityReport::supported(Capability::Patching),
                CapabilityReport::supported(Capability::Verification),
                CapabilityReport::supported(Capability::AssetInventory),
                CapabilityReport::supported(Capability::NonTextSurfaceExtraction),
                CapabilityReport::supported(Capability::ProfileGeneration),
            ],
        )
    }

    struct RecordingAdapter {
        calls: Rc<RefCell<Vec<&'static str>>>,
    }

    impl RecordingAdapter {
        fn record(&self, call: &'static str) {
            self.calls.borrow_mut().push(call);
        }

        fn profile_result(&self) -> GameProfile {
            let mut profile = GameProfile {
                schema_version: "0.1.0".to_string(),
                profile_id: deterministic_id("profile", 98),
                game_id: "registry-dispatch-game".to_string(),
                title: "Registry Dispatch Game".to_string(),
                source_locale: "en-US".to_string(),
                engine: EngineProfile {
                    adapter_id: TEST_ADAPTER_ID.to_string(),
                    engine_family: "registry-test".to_string(),
                    engine_version: Some("9.9.9".to_string()),
                    detected_variant: "injected-adapter".to_string(),
                },
                source_fingerprint: None,
                key_requirements: vec![],
                archive_parameters: vec![],
                helper_evidence: None,
                assets: vec![AssetProfile {
                    asset_id: deterministic_id("asset", 98),
                    path: "registry.txt".to_string(),
                    asset_kind: AssetKind::Script,
                    text_surfaces: vec![TextSurface::Dialogue],
                    source_hash: Some("registry-source-hash".to_string()),
                    patching: CapabilityReport::supported(Capability::Patching),
                }],
                capabilities: test_capabilities().reports,
                requirements: vec![],
                metadata: Default::default(),
            };
            profile.normalize();
            profile
        }
    }

    impl EngineAdapter for RecordingAdapter {
        fn id(&self) -> &'static str {
            TEST_ADAPTER_ID
        }

        fn name(&self) -> &'static str {
            "Kaifuu registry dispatch test adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            self.record("capabilities");
            test_capabilities()
        }

        fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            self.record("detect");
            Ok(DetectionResult {
                adapter_id: TEST_ADAPTER_ID.to_string(),
                detected: true,
                engine_family: Some("registry-test".to_string()),
                engine_version: Some("9.9.9".to_string()),
                detected_variant: Some("injected-adapter".to_string()),
                evidence: vec![DetectionEvidence {
                    path: request.game_dir.display().to_string(),
                    kind: "injected_registry".to_string(),
                    status: EvidenceStatus::Matched,
                    detail: "custom registry adapter was called".to_string(),
                }],
                requirements: vec![ProfileRequirement {
                    category: RequirementCategory::SecretKey,
                    key: "test_key".to_string(),
                    status: RequirementStatus::NotRequired,
                    description: "test adapter does not need secrets".to_string(),
                    placeholder: None,
                    secret: true,
                }],
                capabilities: test_capabilities().reports,
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            self.record("profile");
            Ok(self.profile_result())
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            self.record("list_assets");
            Ok(AssetList {
                adapter_id: TEST_ADAPTER_ID.to_string(),
                assets: vec![],
            })
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            self.record("asset_inventory");
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "supportBoundary".to_string(),
                "registry test asset inventory".to_string(),
            );
            let mut manifest = AssetInventoryManifest {
                schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
                manifest_id: deterministic_id("asset-inventory", 98),
                adapter_id: TEST_ADAPTER_ID.to_string(),
                source_locale: "en-US".to_string(),
                assets: vec![AssetInventoryAsset {
                    asset_id: "registry-image".to_string(),
                    asset_key: "image/registry".to_string(),
                    asset_kind: AssetInventoryAssetKind::Image,
                    path: Some("registry/image.png".to_string()),
                    source_hash: Some(content_hash("registry-image")),
                    metadata: BTreeMap::new(),
                }],
                surfaces: vec![AssetInventorySurface {
                    surface_id: "registry-image-text".to_string(),
                    asset_surface_kind: AssetInventorySurfaceKind::ImageText,
                    source_asset_ref: AssetInventoryAssetRef {
                        asset_id: "registry-image".to_string(),
                        asset_key: Some("image/registry".to_string()),
                    },
                    source_location: None,
                    source_text: Some("Registry".to_string()),
                    source_hash: Some(content_hash("Registry")),
                    text_source_kind: AssetInventoryTextSourceKind::ManualTranscription,
                    patch_mode: AssetInventoryPatchMode::Unsupported,
                    patching: CapabilityReport::unsupported(
                        Capability::AssetTextPatching,
                        "registry test adapter does not patch image assets",
                    ),
                    notes: vec![],
                }],
                capabilities: test_capabilities().reports,
                warnings: vec![],
                metadata,
            };
            manifest.normalize();
            Ok(manifest)
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            self.record("extract");
            Ok(ExtractionResult {
                adapter_id: TEST_ADAPTER_ID.to_string(),
                profile: self.profile_result(),
                bridge: BridgeBundle {
                    schema_version: "0.1.0".to_string(),
                    bridge_id: deterministic_id("bridge", 98),
                    source_bundle_hash: "registry-bundle-hash".to_string(),
                    source_locale: "en-US".to_string(),
                    extractor_name: "registry-test-extractor".to_string(),
                    extractor_version: "9.9.9".to_string(),
                    units: vec![BridgeUnit {
                        bridge_unit_id: deterministic_id("bridge-unit", 98),
                        source_unit_key: "registry.unit.001".to_string(),
                        occurrence_id: "registry-occurrence-001".to_string(),
                        source_hash: "registry-source-hash".to_string(),
                        source_locale: "en-US".to_string(),
                        source_text: "Registry source".to_string(),
                        speaker: "Registry".to_string(),
                        text_surface: "dialogue".to_string(),
                        protected_spans: vec![],
                        patch_ref: PatchRef {
                            asset_id: "registry.txt".to_string(),
                            write_mode: "replace".to_string(),
                            source_unit_key: "registry.unit.001".to_string(),
                        },
                    }],
                },
                warnings: Vec::<AdapterWarning>::new(),
            })
        }

        fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            self.record("patch");
            fs::create_dir_all(request.output_dir)?;
            fs::write(
                request.output_dir.join("registry-adapter-called.txt"),
                "patch\n",
            )?;
            Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 98),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Passed,
                output_hash: "registry-patch-output".to_string(),
                failures: vec![],
            })
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            self.record("verify");
            Ok(VerificationResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("verify", 98),
                status: OperationStatus::Passed,
                output_hash: "registry-verify-output".to_string(),
                failures: vec![],
            })
        }
    }

    fn recording_registry(calls: Rc<RefCell<Vec<&'static str>>>) -> AdapterRegistry {
        let mut registry = AdapterRegistry::new();
        registry.register(RecordingAdapter { calls });
        registry
    }

    struct PreflightBlockingAdapter;

    impl EngineAdapter for PreflightBlockingAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.preflight"
        }

        fn name(&self) -> &'static str {
            "Kaifuu preflight failure test adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(
                self.id(),
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::Patching),
                    CapabilityReport::requires_user_input(
                        Capability::ContainerAccess,
                        "synthetic preflight requires container support",
                    ),
                    CapabilityReport::requires_user_input(
                        Capability::CryptoAccess,
                        "synthetic preflight requires crypto support",
                    ),
                ],
            )
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: true,
                engine_family: Some("preflight-test".to_string()),
                engine_version: None,
                detected_variant: Some("layered-access-test".to_string()),
                evidence: vec![],
                requirements: vec![],
                capabilities: self.capabilities().reports,
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            Err("profile is not used by the preflight test".into())
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            Err("list_assets is not used by the preflight test".into())
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            Err("asset_inventory is not used by the preflight test".into())
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            Err("extract is not used by the preflight test".into())
        }

        fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
            let raw_key = "00112233445566778899aabbccddeeff";
            let preflight = LayeredAccessPreflightReport::from_requirements(
                self.id(),
                "preflight-test",
                "layered-access-test",
                vec![
                    LayeredAccessPreflightRequirement::missing_capability(
                        LayeredAccessStage::Container,
                        "private-route-name/ending.ks",
                        "container helper unavailable for /home/dev/Private Route Spoiler Game/data.xp3",
                    ),
                    LayeredAccessPreflightRequirement::missing_capability(
                        LayeredAccessStage::Crypto,
                        "Scene.pck",
                        format!("helper dump included unresolved raw key {raw_key}"),
                    ),
                ],
            );
            Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 77),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Failed,
                output_hash: content_hash("preflight failed without output"),
                failures: preflight.failures,
            })
        }

        fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            Err("patch must not run after a blocking preflight failure".into())
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            Err("verify is not used by the preflight test".into())
        }
    }

    fn preflight_registry() -> AdapterRegistry {
        let mut registry = AdapterRegistry::new();
        registry.register(PreflightBlockingAdapter);
        registry
    }

    struct MaliciousPreflightBlockingPatchAdapter {
        failure: AdapterFailure,
    }

    impl MaliciousPreflightBlockingPatchAdapter {
        fn new(failure: AdapterFailure) -> Self {
            Self { failure }
        }
    }

    impl EngineAdapter for MaliciousPreflightBlockingPatchAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.malicious-preflight"
        }

        fn name(&self) -> &'static str {
            "Kaifuu malicious preflight failure test adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(
                self.id(),
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::Patching),
                ],
            )
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: true,
                engine_family: Some("malicious-preflight-test".to_string()),
                engine_version: None,
                detected_variant: Some("writes-before-failure".to_string()),
                evidence: vec![],
                requirements: vec![],
                capabilities: self.capabilities().reports,
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            Err("profile is not used by the malicious preflight test".into())
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            Err("list_assets is not used by the malicious preflight test".into())
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            Err("asset_inventory is not used by the malicious preflight test".into())
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            Err("extract is not used by the malicious preflight test".into())
        }

        fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            fs::create_dir_all(request.output_dir)?;
            fs::write(
                request.output_dir.join("must-not-escape.txt"),
                "leaked output\n",
            )?;
            Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 78),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Failed,
                output_hash: content_hash("malicious preflight output"),
                failures: vec![self.failure.clone()],
            })
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            Err("verify is not used by the malicious preflight test".into())
        }
    }

    fn malicious_registry(failure: AdapterFailure) -> AdapterRegistry {
        let mut registry = AdapterRegistry::new();
        registry.register(MaliciousPreflightBlockingPatchAdapter::new(failure));
        registry
    }

    enum PatchFilesystemFailureMode {
        AdapterErrAfterWrite,
        ReportWriteCollision,
        SuccessfulWrite,
    }

    struct PatchFilesystemFailureAdapter {
        mode: PatchFilesystemFailureMode,
    }

    impl PatchFilesystemFailureAdapter {
        fn new(mode: PatchFilesystemFailureMode) -> Self {
            Self { mode }
        }
    }

    impl EngineAdapter for PatchFilesystemFailureAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.patch-filesystem-failure"
        }

        fn name(&self) -> &'static str {
            "Kaifuu patch filesystem failure test adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(
                self.id(),
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::Patching),
                ],
            )
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: true,
                engine_family: Some("patch-filesystem-failure-test".to_string()),
                engine_version: None,
                detected_variant: Some("cleanup".to_string()),
                evidence: vec![],
                requirements: vec![],
                capabilities: self.capabilities().reports,
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            Err("profile is not used by the patch filesystem failure test".into())
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            Err("list_assets is not used by the patch filesystem failure test".into())
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            Err("asset_inventory is not used by the patch filesystem failure test".into())
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            Err("extract is not used by the patch filesystem failure test".into())
        }

        fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            fs::write(
                request.output_dir.join("adapter-output.txt"),
                "staged output\n",
            )?;
            match self.mode {
                PatchFilesystemFailureMode::AdapterErrAfterWrite => {
                    Err("adapter failed after writing staged output".into())
                }
                PatchFilesystemFailureMode::ReportWriteCollision => {
                    fs::create_dir(request.output_dir.join("patch-result.json"))?;
                    Ok(self.patch_result(request.patch_export))
                }
                PatchFilesystemFailureMode::SuccessfulWrite => {
                    Ok(self.patch_result(request.patch_export))
                }
            }
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            Err("verify is not used by the patch filesystem failure test".into())
        }
    }

    impl PatchFilesystemFailureAdapter {
        fn patch_result(&self, patch_export: &PatchExport) -> PatchResult {
            PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 79),
                patch_export_id: patch_export.patch_export_id.clone(),
                status: OperationStatus::Passed,
                output_hash: content_hash("patch filesystem failure output"),
                failures: vec![],
            }
        }
    }

    fn patch_filesystem_failure_registry(mode: PatchFilesystemFailureMode) -> AdapterRegistry {
        let mut registry = AdapterRegistry::new();
        registry.register(PatchFilesystemFailureAdapter::new(mode));
        registry
    }

    fn empty_patch_export(root: &Path, seed: usize) -> PathBuf {
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", seed),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();
        patch_export_path
    }

    fn assert_no_patch_staging_entries(root: &Path, output_name: &str) {
        let leaked_entries = fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(output_name) && name.contains("kaifuu-staging"))
            .collect::<Vec<_>>();
        assert_eq!(leaked_entries, Vec::<String>::new());
    }

    struct SensitiveReportAdapter;

    impl EngineAdapter for SensitiveReportAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.sensitive-report"
        }

        fn name(&self) -> &'static str {
            "Kaifuu sensitive report test adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(
                self.id(),
                vec![
                    CapabilityReport::requires_user_input(
                        Capability::KeyProfile,
                        "path=~/games/private/key.bin",
                    ),
                    CapabilityReport::unsupported(
                        Capability::PatchBack,
                        "requires file=%USERPROFILE%\\Games\\SecretRoute\\patcher.exe",
                    ),
                ],
            )
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: true,
                engine_family: Some("sensitive-report-test".to_string()),
                engine_version: None,
                detected_variant: Some("private-route".to_string()),
                evidence: vec![],
                requirements: vec![
                    ProfileRequirement {
                        category: RequirementCategory::SecretKey,
                        key: "route-key".to_string(),
                        status: RequirementStatus::Missing,
                        description: "read key from $HOME/games/private/key.bin".to_string(),
                        placeholder: Some(
                            "file=%USERPROFILE%\\Games\\SecretRoute\\key.bin".to_string(),
                        ),
                        secret: true,
                    },
                    ProfileRequirement {
                        category: RequirementCategory::File,
                        key: "script".to_string(),
                        status: RequirementStatus::Unsupported,
                        description: "story-ish filename private-route-ending.ks must stay local"
                            .to_string(),
                        placeholder: None,
                        secret: false,
                    },
                ],
                capabilities: self.capabilities().reports,
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "diagnostic".to_string(),
                "source=$HOME/games/private/key.bin".to_string(),
            );
            Ok(GameProfile {
                schema_version: "0.1.0".to_string(),
                profile_id: deterministic_id("profile", 1301),
                game_id: "sensitive-report-game".to_string(),
                title: "Sensitive Report Game".to_string(),
                source_locale: "ja-JP".to_string(),
                engine: EngineProfile {
                    adapter_id: self.id().to_string(),
                    engine_family: "sensitive-report-test".to_string(),
                    engine_version: None,
                    detected_variant: "private-route".to_string(),
                },
                source_fingerprint: None,
                key_requirements: vec![],
                archive_parameters: vec![],
                helper_evidence: None,
                assets: vec![AssetProfile {
                    asset_id: deterministic_id("asset", 1301),
                    path: "~/games/private/source.ks".to_string(),
                    asset_kind: AssetKind::Script,
                    text_surfaces: vec![TextSurface::Dialogue],
                    source_hash: Some(content_hash("sensitive profile asset")),
                    patching: CapabilityReport::limited(
                        Capability::Patching,
                        "helper input lives at %USERPROFILE%\\Games\\SecretRoute\\key.bin",
                    ),
                }],
                capabilities: self.capabilities().reports,
                requirements: vec![ProfileRequirement {
                    category: RequirementCategory::SecretKey,
                    key: "route-key".to_string(),
                    status: RequirementStatus::Missing,
                    description:
                        "helper dump source:/home/dev/game/private-route-ending.ks exposed raw key 00112233445566778899aabbccddeeff"
                            .to_string(),
                    placeholder: Some("file=C:\\Games\\SecretRoute\\key.bin".to_string()),
                    secret: true,
                }],
                metadata,
            })
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            Err("list_assets is not used by the sensitive report test".into())
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            Err("asset_inventory is not used by the sensitive report test".into())
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            Err("extract is not used by the sensitive report test".into())
        }

        fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            Err("patch is not used by the sensitive report test".into())
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            Err("verify is not used by the sensitive report test".into())
        }
    }

    fn sensitive_report_registry() -> AdapterRegistry {
        let mut registry = AdapterRegistry::new();
        registry.register(SensitiveReportAdapter);
        registry
    }

    struct InvalidProfileAdapter;

    impl EngineAdapter for InvalidProfileAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.invalid-profile"
        }

        fn name(&self) -> &'static str {
            "Kaifuu invalid profile test adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(
                self.id(),
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::ProfileGeneration),
                    CapabilityReport::supported(Capability::Patching),
                ],
            )
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: true,
                engine_family: Some("invalid-profile-test".to_string()),
                engine_version: None,
                detected_variant: Some("missing-profile-id".to_string()),
                evidence: vec![],
                requirements: vec![],
                capabilities: self.capabilities().reports,
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            Ok(GameProfile {
                schema_version: "0.1.0".to_string(),
                profile_id: String::new(),
                game_id: "invalid-profile-game".to_string(),
                title: "Invalid Profile Game".to_string(),
                source_locale: "ja-JP".to_string(),
                engine: EngineProfile {
                    adapter_id: self.id().to_string(),
                    engine_family: "invalid-profile-test".to_string(),
                    engine_version: None,
                    detected_variant: "missing-profile-id".to_string(),
                },
                source_fingerprint: None,
                key_requirements: vec![],
                archive_parameters: vec![],
                helper_evidence: None,
                assets: vec![AssetProfile {
                    asset_id: deterministic_id("asset", 1401),
                    path: "source.ks".to_string(),
                    asset_kind: AssetKind::Script,
                    text_surfaces: vec![TextSurface::Dialogue],
                    source_hash: Some(content_hash("invalid profile source")),
                    patching: CapabilityReport::supported(Capability::Patching),
                }],
                capabilities: self.capabilities().reports,
                requirements: vec![],
                metadata: BTreeMap::new(),
            })
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            Err("list_assets is not used by the invalid profile test".into())
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            Err("asset_inventory is not used by the invalid profile test".into())
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            Err("extract is not used by the invalid profile test".into())
        }

        fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            Err("patch is not used by the invalid profile test".into())
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            Err("verify is not used by the invalid profile test".into())
        }
    }

    fn invalid_profile_registry() -> AdapterRegistry {
        let mut registry = AdapterRegistry::new();
        registry.register(InvalidProfileAdapter);
        registry
    }

    fn assert_no_sensitive_profile_material(surface: &str) {
        for forbidden in [
            "~/games",
            "$HOME/games",
            "%USERPROFILE%",
            "/home/dev/game",
            "C:\\Games",
            "private/key.bin",
            "helper dump",
            "decrypted text",
            "00112233445566778899aabbccddeeff",
            "private-route-ending.ks",
            "SecretRoute",
        ] {
            assert!(
                !surface.contains(forbidden),
                "profile write surface leaked {forbidden}: {surface}"
            );
        }
    }

    fn assert_calls(calls: &Rc<RefCell<Vec<&'static str>>>, expected: &[&'static str]) {
        assert_eq!(calls.borrow().as_slice(), expected);
        calls.borrow_mut().clear();
    }

    #[test]
    fn engine_commands_use_supplied_registry() {
        let root = temp_dir("injected-registry-dispatch");
        let game_dir = root.join("non-fixture-game");
        fs::create_dir_all(&game_dir).unwrap();
        let calls = Rc::new(RefCell::new(Vec::new()));
        let registry = recording_registry(Rc::clone(&calls));

        let capabilities_path = root.join("capabilities.json");
        run_cli_with_registry(
            &[
                "capabilities",
                "--output",
                capabilities_path.to_str().unwrap(),
            ],
            &registry,
        );
        let capabilities: Vec<AdapterCapabilities> = read_json(&capabilities_path).unwrap();
        assert_eq!(capabilities, vec![test_capabilities()]);
        assert_calls(&calls, &["capabilities"]);

        let detect_path = root.join("detect.json");
        run_cli_with_registry(
            &[
                "detect",
                game_dir.to_str().unwrap(),
                "--output",
                detect_path.to_str().unwrap(),
            ],
            &registry,
        );
        let detection_report: DetectionReport = read_json(&detect_path).unwrap();
        assert_eq!(detection_report.status, DetectionReportStatus::Matched);
        assert_eq!(detection_report.detections.len(), 1);
        let detection = &detection_report.detections[0];
        assert_eq!(detection.adapter_id, TEST_ADAPTER_ID);
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("injected-adapter")
        );
        assert_eq!(detection.evidence[0].status, EvidenceStatus::Matched);
        let serialized_detection: serde_json::Value = read_json(&detect_path).unwrap();
        let detection_json = &serialized_detection["detections"][0];
        assert_eq!(detection_json["engineFamily"], "registry-test");
        assert_eq!(detection_json["engineVersion"], "9.9.9");
        assert_eq!(detection_json["detectedVariant"], "injected-adapter");
        let serialized_detection_text = fs::read_to_string(&detect_path).unwrap();
        assert!(!serialized_detection_text.contains(&game_dir.display().to_string()));
        assert_calls(&calls, &["detect"]);

        let profile_path = root.join("profile.json");
        run_cli_with_registry(
            &[
                "profile",
                "init",
                game_dir.to_str().unwrap(),
                "--output",
                profile_path.to_str().unwrap(),
            ],
            &registry,
        );
        let profile: GameProfile = read_json(&profile_path).unwrap();
        assert_eq!(profile.engine.adapter_id, TEST_ADAPTER_ID);
        assert_eq!(profile.game_id, "registry-dispatch-game");
        assert_calls(&calls, &["detect", "profile"]);

        let asset_inventory_path = root.join("asset-inventory.json");
        run_cli_with_registry(
            &[
                "asset-inventory",
                game_dir.to_str().unwrap(),
                "--output",
                asset_inventory_path.to_str().unwrap(),
            ],
            &registry,
        );
        let asset_inventory: AssetInventoryManifest = read_json(&asset_inventory_path).unwrap();
        assert_eq!(asset_inventory.adapter_id, TEST_ADAPTER_ID);
        assert_eq!(asset_inventory.surfaces.len(), 1);
        assert_eq!(
            asset_inventory.surfaces[0].patching.status,
            CapabilityStatus::Unsupported
        );
        assert_calls(&calls, &["detect", "asset_inventory"]);

        let validation_path = root.join("profile-validation.json");
        run_cli_with_registry(
            &[
                "profile",
                "validate",
                profile_path.to_str().unwrap(),
                "--output",
                validation_path.to_str().unwrap(),
            ],
            &registry,
        );
        let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
        assert_eq!(validation.status, OperationStatus::Passed);
        assert_calls(&calls, &[]);

        let bridge_path = root.join("bridge.json");
        run_cli_with_registry(
            &[
                "extract",
                game_dir.to_str().unwrap(),
                "--output",
                bridge_path.to_str().unwrap(),
            ],
            &registry,
        );
        let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
        assert_eq!(bridge.extractor_name, "registry-test-extractor");
        assert_eq!(bridge.units[0].source_unit_key, "registry.unit.001");
        assert_calls(&calls, &["detect", "extract"]);

        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 98),
            source_locale: "en-US".to_string(),
            target_locale: "fr-FR".to_string(),
            entries: vec![],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();
        let patched_dir = root.join("patched");
        run_cli_with_registry(
            &[
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                patched_dir.to_str().unwrap(),
            ],
            &registry,
        );
        let patch_result: PatchResult = read_json(&patched_dir.join("patch-result.json")).unwrap();
        assert_eq!(patch_result.output_hash, "registry-patch-output");
        assert!(patched_dir.join("registry-adapter-called.txt").exists());
        assert_calls(&calls, &["detect", "patch"]);

        let verify_path = root.join("verify.json");
        run_cli_with_registry(
            &[
                "verify",
                game_dir.to_str().unwrap(),
                "--output",
                verify_path.to_str().unwrap(),
            ],
            &registry,
        );
        let verify: VerificationResult = read_json(&verify_path).unwrap();
        assert_eq!(verify.output_hash, "registry-verify-output");
        assert_calls(&calls, &["detect", "verify"]);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detection_and_capabilities_reports_redact_sensitive_free_text() {
        let root = temp_dir("sensitive-report-redaction");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let registry = sensitive_report_registry();

        let capabilities_path = root.join("capabilities.json");
        run_cli_with_registry(
            &[
                "capabilities",
                "--output",
                capabilities_path.to_str().unwrap(),
            ],
            &registry,
        );
        let capabilities_serialized = fs::read_to_string(&capabilities_path).unwrap();
        assert!(capabilities_serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
        for forbidden in ["~/games", "%USERPROFILE%", "private/key.bin", "SecretRoute"] {
            assert!(
                !capabilities_serialized.contains(forbidden),
                "capabilities leaked {forbidden}"
            );
        }

        let detect_path = root.join("detect.json");
        run_cli_with_registry(
            &[
                "detect",
                game_dir.to_str().unwrap(),
                "--output",
                detect_path.to_str().unwrap(),
            ],
            &registry,
        );
        let detection_serialized = fs::read_to_string(&detect_path).unwrap();
        assert!(detection_serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
        for forbidden in [
            "$HOME/games",
            "%USERPROFILE%",
            "private/key.bin",
            "SecretRoute",
        ] {
            assert!(
                !detection_serialized.contains(forbidden),
                "detection leaked {forbidden}"
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_write_gate_rejects_unredacted_adapter_payloads_on_init_and_legacy_paths() {
        let root = temp_dir("sensitive-profile-write-gate");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let registry = sensitive_report_registry();

        for legacy in [false, true] {
            let label = if legacy { "legacy" } else { "init" };
            let output = root.join(format!("profile-{label}.json"));
            let args = if legacy {
                vec![
                    "profile",
                    game_dir.to_str().unwrap(),
                    "--output",
                    output.to_str().unwrap(),
                ]
            } else {
                vec![
                    "profile",
                    "init",
                    game_dir.to_str().unwrap(),
                    "--output",
                    output.to_str().unwrap(),
                ]
            };
            let error = run_cli_with_registry_result(&args, &registry)
                .expect_err("sensitive profile payload should be rejected")
                .to_string();

            assert!(
                error.contains("generated profile failed validation"),
                "{label} path returned unexpected error: {error}"
            );
            assert!(
                error.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED),
                "{label} path did not report the redaction boundary: {error}"
            );
            assert!(
                !output.exists(),
                "{label} path persisted an invalid profile to {}",
                output.display()
            );
            assert_no_sensitive_profile_material(&error);
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_write_gate_redacts_raw_key_material_before_persisting_valid_profile() {
        let root = temp_dir("profile-write-gate-redacted-persist");
        let output = root.join("profile.json");
        let profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: deterministic_id("profile", 1402),
            game_id: "valid-redaction-profile-game".to_string(),
            title: "Valid Profile 00112233445566778899aabbccddeeff".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: "kaifuu.test.redacted-persist".to_string(),
                engine_family: "redacted-persist-test".to_string(),
                engine_version: None,
                detected_variant: "valid-title-redaction".to_string(),
            },
            source_fingerprint: None,
            key_requirements: vec![],
            archive_parameters: vec![],
            helper_evidence: None,
            assets: vec![AssetProfile {
                asset_id: deterministic_id("asset", 1402),
                path: "source.ks".to_string(),
                asset_kind: AssetKind::Script,
                text_surfaces: vec![TextSurface::Dialogue],
                source_hash: Some(content_hash("redacted persist source")),
                patching: CapabilityReport::supported(Capability::Patching),
            }],
            capabilities: vec![
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::Patching),
            ],
            requirements: vec![],
            metadata: BTreeMap::new(),
        };

        assert_eq!(profile.validate().status, OperationStatus::Passed);
        write_validated_stable_profile(&output, &profile).unwrap();

        let serialized = fs::read_to_string(&output).unwrap();
        assert!(serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
        assert_no_sensitive_profile_material(&serialized);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_profile_command_rejects_structurally_invalid_profiles_before_write() {
        let root = temp_dir("legacy-profile-invalid-write-gate");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let output = root.join("profile.json");
        let registry = invalid_profile_registry();

        let error = run_cli_with_registry_result(
            &[
                "profile",
                game_dir.to_str().unwrap(),
                "--output",
                output.to_str().unwrap(),
            ],
            &registry,
        )
        .expect_err("legacy profile command should reject invalid generated profiles")
        .to_string();

        assert!(error.contains("generated profile failed validation"));
        assert!(error.contains("missing_required_field"));
        assert!(!output.exists());
        assert_no_sensitive_profile_material(&error);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fixture_commands_dispatch_through_registered_adapter() {
        let root = temp_dir("fixture-dispatch");
        let game_dir = temp_game(&root);

        let capabilities_path = root.join("capabilities.json");
        run_cli(&[
            "capabilities",
            "--output",
            capabilities_path.to_str().unwrap(),
        ]);
        let capabilities: Vec<AdapterCapabilities> = read_json(&capabilities_path).unwrap();
        assert_eq!(capabilities.len(), 1);
        assert_eq!(
            capabilities[0].adapter_id,
            kaifuu_engine_fixture::FIXTURE_ADAPTER_ID
        );
        assert!(capabilities[0].reports.iter().any(|report| {
            report.capability == Capability::LineParityPatching
                && report.status == CapabilityStatus::Limited
        }));

        let detect_path = root.join("detect.json");
        run_cli(&[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ]);
        let detection_report: DetectionReport = read_json(&detect_path).unwrap();
        assert_eq!(detection_report.status, DetectionReportStatus::Matched);
        let detection = &detection_report.detections[0];
        assert!(detection.detected);
        assert_eq!(
            detection.adapter_id,
            kaifuu_engine_fixture::FIXTURE_ADAPTER_ID
        );
        assert!(detection.evidence.iter().any(|evidence| {
            evidence.path == "source.json" && evidence.status == EvidenceStatus::Matched
        }));

        let profile_path = root.join("profile.json");
        run_cli(&[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            profile_path.to_str().unwrap(),
        ]);
        let profile: GameProfile = read_json(&profile_path).unwrap();
        assert_eq!(
            profile.engine.adapter_id,
            kaifuu_engine_fixture::FIXTURE_ADAPTER_ID
        );
        assert!(profile.requirements.iter().any(|requirement| {
            requirement.category == RequirementCategory::SecretKey
                && requirement.status == RequirementStatus::NotRequired
                && requirement.secret
                && requirement.placeholder.is_none()
        }));

        let validation_path = root.join("profile-validation.json");
        run_cli(&[
            "profile",
            "validate",
            profile_path.to_str().unwrap(),
            "--output",
            validation_path.to_str().unwrap(),
        ]);
        let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
        assert_eq!(validation.status, OperationStatus::Passed);

        let bridge_path = root.join("bridge.json");
        run_cli(&[
            "extract",
            game_dir.to_str().unwrap(),
            "--output",
            bridge_path.to_str().unwrap(),
        ]);
        let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
        assert_eq!(bridge.units.len(), 1);

        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 1),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![PatchExportEntry {
                bridge_unit_id: bridge.units[0].bridge_unit_id.clone(),
                source_unit_key: bridge.units[0].source_unit_key.clone(),
                source_hash: bridge.units[0].source_hash.clone(),
                target_text: "Hello, {player}.".to_string(),
                protected_span_mappings: vec![ProtectedSpanMapping::new("{player}", 7, 15)],
            }],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();

        let patched_dir = root.join("patched");
        run_cli(&[
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            patched_dir.to_str().unwrap(),
        ]);
        let patch_result: PatchResult = read_json(&patched_dir.join("patch-result.json")).unwrap();
        assert_eq!(patch_result.status, OperationStatus::Passed);
        assert!(
            fs::read_to_string(patched_dir.join("source.json"))
                .unwrap()
                .contains("Hello, {player}.")
        );

        let verify_path = root.join("verify.json");
        run_cli(&[
            "verify",
            patched_dir.to_str().unwrap(),
            "--output",
            verify_path.to_str().unwrap(),
        ]);
        let verify: VerificationResult = read_json(&verify_path).unwrap();
        assert_eq!(verify.status, OperationStatus::Passed);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn diff_apply_commands_round_trip_v02_delta_package() {
        let root = temp_dir("diff-apply-v02");
        let game_dir = temp_game(&root);
        write_fixture_file(&game_dir, "readme.txt", b"same\n");

        let patched_dir = root.join("patched");
        fs::create_dir_all(&patched_dir).unwrap();
        write_fixture_file(
            &patched_dir,
            "source.json",
            br#"{"units":[{"targetText":"Hello, {player}."}]}"#,
        );
        write_fixture_file(&patched_dir, "readme.txt", b"same\n");
        write_fixture_file(&patched_dir, "extra.txt", b"new\n");
        write_fixture_file(&patched_dir, "patch-result.json", b"cli artifact\n");

        let delta_path = root.join("hello.kaifuu");
        run_cli(&[
            "diff",
            game_dir.to_str().unwrap(),
            patched_dir.to_str().unwrap(),
            "--output",
            delta_path.to_str().unwrap(),
        ]);
        let delta: serde_json::Value = read_json(&delta_path).unwrap();
        assert_eq!(delta["schemaVersion"], "0.2.0");
        let changed_paths = delta["changedEntries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(changed_paths, vec!["extra.txt", "source.json"]);

        let output_dir = root.join("applied");
        run_cli(&[
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]);

        let apply_result: serde_json::Value =
            read_json(&output_dir.join("patch-result.json")).unwrap();
        assert_eq!(apply_result["status"], "passed");
        assert_eq!(apply_result["changedFileCount"], 2);
        assert!(
            fs::read_to_string(output_dir.join("source.json"))
                .unwrap()
                .contains("Hello, {player}.")
        );
        assert_eq!(
            fs::read_to_string(output_dir.join("readme.txt")).unwrap(),
            "same\n"
        );
        assert_eq!(
            fs::read_to_string(output_dir.join("extra.txt")).unwrap(),
            "new\n"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_returns_error_when_adapter_reports_failed_patch_result() {
        let root = temp_dir("patch-failed-exit");
        let game_dir = temp_game(&root);
        let bridge_path = root.join("bridge.json");
        run_cli(&[
            "extract",
            game_dir.to_str().unwrap(),
            "--output",
            bridge_path.to_str().unwrap(),
        ]);
        let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 1),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![PatchExportEntry {
                bridge_unit_id: bridge.units[0].bridge_unit_id.clone(),
                source_unit_key: bridge.units[0].source_unit_key.clone(),
                source_hash: bridge.units[0].source_hash.clone(),
                target_text: "Hello, {player}.".to_string(),
                protected_span_mappings: vec![ProtectedSpanMapping::new("{player}", 0, 8)],
            }],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();
        let patched_dir = root.join("patched");

        let result = run_with_args(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                patched_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        );

        let error = result.unwrap_err().to_string();
        assert!(error.contains("patch failed; see"));
        let patch_result: PatchResult = read_json(&patched_dir.join("patch-result.json")).unwrap();
        assert_eq!(patch_result.status, OperationStatus::Failed);
        assert!(!patched_dir.join("source.json").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_cleans_staging_when_adapter_errors_after_writing() {
        let root = temp_dir("patch-adapter-error-cleanup");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let patch_export_path = empty_patch_export(&root, 79);
        let output_dir = root.join("patched-output");
        let registry =
            patch_filesystem_failure_registry(PatchFilesystemFailureMode::AdapterErrAfterWrite);

        let result = run_with_args_and_registry(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
            &registry,
        );

        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("adapter failed after writing staged output"),
            "{error}"
        );
        assert!(!output_dir.exists());
        assert_no_patch_staging_entries(&root, "patched-output");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_cleans_staging_when_promotion_fails_for_existing_output() {
        let root = temp_dir("patch-promotion-cleanup");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let patch_export_path = empty_patch_export(&root, 80);
        let output_dir = root.join("patched-output");
        fs::create_dir_all(&output_dir).unwrap();
        fs::write(output_dir.join("existing.txt"), "existing output\n").unwrap();
        let registry =
            patch_filesystem_failure_registry(PatchFilesystemFailureMode::SuccessfulWrite);

        let result = run_with_args_and_registry(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
            &registry,
        );

        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("patch output directory already exists"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(output_dir.join("existing.txt")).unwrap(),
            "existing output\n"
        );
        assert!(!output_dir.join("adapter-output.txt").exists());
        assert!(!output_dir.join("patch-result.json").exists());
        assert_no_patch_staging_entries(&root, "patched-output");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_cleans_staging_when_report_write_fails() {
        let root = temp_dir("patch-report-write-cleanup");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let patch_export_path = empty_patch_export(&root, 81);
        let output_dir = root.join("patched-output");
        let registry =
            patch_filesystem_failure_registry(PatchFilesystemFailureMode::ReportWriteCollision);

        let result = run_with_args_and_registry(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
            &registry,
        );

        assert!(result.is_err());
        assert!(!output_dir.exists());
        assert_no_patch_staging_entries(&root, "patched-output");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_preflight_failure_is_redacted_and_writes_no_output() {
        let root = temp_dir("patch-preflight-redaction");
        let game_dir = root.join("Private Route Spoiler Game");
        fs::create_dir_all(&game_dir).unwrap();
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 77),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();
        let output_dir = root.join("patched-output");
        let registry = preflight_registry();

        let result = run_with_args_and_registry(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
            &registry,
        );

        let error = result.unwrap_err().to_string();
        assert!(error.contains("patch preflight failed"), "{error}");
        assert!(
            error.contains(kaifuu_core::SEMANTIC_MISSING_CONTAINER_CAPABILITY),
            "{error}"
        );
        assert!(
            error.contains(kaifuu_core::SEMANTIC_MISSING_CRYPTO_CAPABILITY),
            "{error}"
        );
        assert!(!error.contains("00112233445566778899aabbccddeeff"));
        assert!(!error.contains("/home/dev"));
        assert!(!error.contains("Private Route Spoiler Game"));
        assert!(!error.contains("private-route-name"));
        assert!(!error.contains("helper dump"));
        assert!(!output_dir.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_cleans_malicious_adapter_output_on_late_preflight_failure() {
        let root = temp_dir("patch-preflight-malicious-output");
        let game_dir = root.join("malicious-game");
        fs::create_dir_all(&game_dir).unwrap();
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 78),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();
        let output_dir = root.join("patched-output");
        let registry = malicious_registry(AdapterFailure::missing_key_material(
            "kaifuu.test.malicious-preflight",
            "malicious-preflight-test",
            "writes-before-failure",
            "raw-key",
            "path=/home/dev/game helper dump contained 00112233445566778899aabbccddeeff",
        ));

        let result = run_with_args_and_registry(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
            &registry,
        );

        let error = result.unwrap_err().to_string();
        assert!(error.contains("patch preflight failed"), "{error}");
        assert!(error.contains(kaifuu_core::SEMANTIC_MISSING_KEY_MATERIAL));
        assert!(!error.contains("/home/dev"));
        assert!(!error.contains("helper dump"));
        assert!(!error.contains("00112233445566778899aabbccddeeff"));
        assert!(!output_dir.exists());
        let leaked_entries = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("patched-output") && name.contains("kaifuu-staging"))
            .collect::<Vec<_>>();
        assert_eq!(leaked_entries, Vec::<String>::new());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_preflight_blocking_semantic_classes_write_no_output() {
        let cases = vec![
            AdapterFailure::missing_key_material(
                "kaifuu.test.malicious-preflight",
                "semantic-test",
                "missing-key",
                "local-key",
                "missing local key material",
            ),
            AdapterFailure::helper_unavailable(
                "kaifuu.test.malicious-preflight",
                "semantic-test",
                "helper-unavailable",
                "helper unavailable before patching",
            ),
            AdapterFailure::key_validation_failed(
                "kaifuu.test.malicious-preflight",
                "semantic-test",
                "key-validation",
                "local-key",
                "key validation failed before patching",
            ),
            AdapterFailure::protected_executable_unsupported(
                "kaifuu.test.malicious-preflight",
                "semantic-test",
                "protected-exe",
                "protected executable unsupported before patching",
            ),
            AdapterFailure::semantic(
                kaifuu_core::AdapterFailureSemanticParams::new(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    "kaifuu.test.malicious-preflight",
                    "unsupported layered transform before patching",
                )
                .engine("semantic-test")
                .detected_variant("unsupported-layered-transform"),
            ),
            AdapterFailure::semantic(
                kaifuu_core::AdapterFailureSemanticParams::new(
                    SemanticErrorCode::MissingCodecCapability,
                    "kaifuu.test.malicious-preflight",
                    "codec unavailable before patching",
                )
                .engine("semantic-test")
                .detected_variant("missing-codec")
                .required_capability(Capability::CodecAccess),
            ),
            AdapterFailure::semantic(
                kaifuu_core::AdapterFailureSemanticParams::new(
                    SemanticErrorCode::MissingPatchBackCapability,
                    "kaifuu.test.malicious-preflight",
                    "patch-back unavailable before patching",
                )
                .engine("semantic-test")
                .detected_variant("missing-patch-back")
                .required_capability(Capability::PatchBack),
            ),
        ];

        for (index, failure) in cases.into_iter().enumerate() {
            let root = temp_dir(&format!("patch-preflight-semantic-{index}"));
            let game_dir = root.join("game");
            fs::create_dir_all(&game_dir).unwrap();
            let patch_export = PatchExport {
                patch_export_id: deterministic_id("patch", 790 + index),
                source_locale: "ja-JP".to_string(),
                target_locale: "en-US".to_string(),
                entries: vec![],
            };
            let patch_export_path = root.join("patch-export.json");
            write_json(&patch_export_path, &patch_export).unwrap();
            let output_dir = root.join("patched-output");
            let expected_code = failure.error_code.clone();
            let registry = malicious_registry(failure);

            let result = run_with_args_and_registry(
                [
                    "patch",
                    game_dir.to_str().unwrap(),
                    "--patch",
                    patch_export_path.to_str().unwrap(),
                    "--output",
                    output_dir.to_str().unwrap(),
                ]
                .iter()
                .map(|arg| arg.to_string())
                .collect(),
                &registry,
            );

            let error = result.unwrap_err().to_string();
            assert!(error.contains("patch preflight failed"), "{error}");
            assert!(error.contains(&expected_code), "{error}");
            assert!(!output_dir.exists(), "{expected_code} wrote output");
            let _ = fs::remove_dir_all(root);
        }
    }

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
    fn golden_command_returns_error_for_v02_translated_patch_without_source_bridge() {
        let root = temp_dir("golden-public-translated-no-source-bridge");
        let fixture_dir = public_fixture_dir();
        let mut patch_export: serde_json::Value =
            read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
        patch_export["entries"][0]["sourceHash"] = serde_json::json!(
            "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        );
        let patch_path = root.join("stale-patch-export.json");
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
            .map(|arg| arg.to_string())
            .collect(),
        );

        assert!(result.is_err());
        let report: GoldenRoundTripReport = read_json(&report_path).unwrap();
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(report.failures.iter().any(|failure| {
            failure.phase == "translated_source_compatibility"
                && failure.code == "translated_source_bridge_required"
                && failure.actual.as_deref() == Some("missing source bridge")
        }));
        assert!(!report.phases.iter().any(|phase| {
            phase.phase == "translated_patch_conversion" || phase.phase == "translated_patch"
        }));

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
            .map(|arg| arg.to_string())
            .collect(),
        );

        assert!(result.is_err());
        let report: GoldenRoundTripReport = read_json(&report_path).unwrap();
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(report.failures.iter().any(|failure| {
            failure.phase == "translated_patch"
                && failure.source_unit_key.as_deref() == Some("hello.scene.001.line.001")
                && failure
                    .asset_ref
                    .as_deref()
                    .unwrap_or("")
                    .contains("source.json#hello.scene.001.line.001")
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detect_unknown_directory_is_non_fatal_and_evidence_based() {
        let root = temp_dir("unknown-detect");
        let game_dir = root.join("unknown-game");
        fs::create_dir_all(&game_dir).unwrap();
        let detect_path = root.join("detect.json");

        run_cli(&[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ]);

        let detection_report: DetectionReport = read_json(&detect_path).unwrap();
        assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
        assert_eq!(detection_report.detections.len(), 1);
        assert!(!detection_report.detections[0].detected);
        assert!(
            detection_report.detections[0]
                .evidence
                .iter()
                .any(|evidence| {
                    evidence.path == "source.json" && evidence.status == EvidenceStatus::Missing
                })
        );
        assert!(detection_report.warnings[0].contains("no registered adapter"));

        let serialized = fs::read_to_string(&detect_path).unwrap();
        assert!(!serialized.contains("confidence"));
        let serialized_report: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        let detection_json = serialized_report["detections"][0].as_object().unwrap();
        assert!(!detection_json.contains_key("engineFamily"));
        assert!(!detection_json.contains_key("engineVersion"));
        assert!(!detection_json.contains_key("detectedVariant"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detect_cli_writes_archive_detection_matrix_without_adapter_support_claim() {
        let root = temp_dir("archive-detect");
        let game_dir = root.join("Private Route Spoiler Game");
        fs::create_dir_all(&game_dir).unwrap();
        write_fixture_file(&game_dir, "game/scripts.rpa", b"RenPy archive synthetic");
        write_fixture_file(
            &game_dir,
            "www/data/System.json",
            br#"{
  "hasEncryptedImages": true,
  "encryptionKey": "00112233445566778899aabbccddeeff"
}"#,
        );
        write_fixture_file(&game_dir, "img/pictures/private-title.rpgmvp", b"encrypted");
        write_fixture_file(&game_dir, "img/pictures/private-title.png_", b"encrypted");
        let detect_path = root.join("detect.json");

        run_cli(&[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ]);

        let detection_report: DetectionReport = read_json(&detect_path).unwrap();
        assert_eq!(detection_report.game_dir, REDACTED_DETECTION_GAME_DIR);
        assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
        assert_eq!(
            detection_report.archive_detection.status,
            ArchiveDetectionStatus::Matched
        );
        assert!(!detection_report.detections[0].detected);
        assert!(
            detection_report
                .warnings
                .iter()
                .any(|warning| { warning.contains("no registered extraction adapter") })
        );

        let rpg_maker = detection_report
            .archive_detection
            .rows
            .iter()
            .find(|row| row.row_id == "rpg-maker-mv-mz-encrypted-assets")
            .unwrap();
        assert!(rpg_maker.detected);
        assert!(
            rpg_maker
                .signals
                .contains(&ArchiveDetectionSignal::Encrypted)
        );
        assert!(rpg_maker.evidence.iter().any(|evidence| {
            evidence.pattern == "*.rpgmvp|*.rpgmvm|*.rpgmvo|*.png_|*.m4a_|*.ogg_"
                && evidence.status == EvidenceStatus::Matched
                && evidence.count == 2
        }));
        assert!(
            rpg_maker
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code == SemanticErrorCode::MissingKeyMaterial })
        );
        assert!(rpg_maker.capabilities.iter().any(|capability| {
            capability.capability == Capability::Extraction
                && capability.status == CapabilityStatus::Unsupported
        }));

        let serialized = fs::read_to_string(&detect_path).unwrap();
        assert!(serialized.contains("\"archiveDetection\""));
        assert!(!serialized.contains(&game_dir.display().to_string()));
        assert!(!serialized.contains("Private Route Spoiler Game"));
        assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
        assert!(!serialized.contains("private-title"));
        assert!(!serialized.contains("confidence"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detect_cli_matches_public_rpg_maker_encrypted_suffix_fixture_report() {
        let root = temp_dir("public-rpg-maker-suffix-detect");
        let game_dir = public_fixture_path("fixtures/public/kaifuu-rpg-maker-encrypted-suffixes");
        let expected_path = game_dir.join("expected/detection-report-v0.1.json");
        let detect_path = root.join("detect.json");

        run_cli(&[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ]);

        let actual: serde_json::Value = read_json(&detect_path).unwrap();
        let expected: serde_json::Value = read_json(&expected_path).unwrap();
        assert_eq!(actual, expected);

        let detection_report: DetectionReport = serde_json::from_value(actual).unwrap();
        assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
        assert_eq!(
            detection_report.archive_detection.status,
            ArchiveDetectionStatus::Matched
        );
        assert!(!detection_report.detections[0].detected);
        let rpg_maker = detection_report
            .archive_detection
            .rows
            .iter()
            .find(|row| row.row_id == "rpg-maker-mv-mz-encrypted-assets")
            .unwrap();
        assert!(rpg_maker.detected);
        assert!(rpg_maker.evidence.iter().any(|evidence| {
            evidence.pattern == "*.rpgmvp|*.rpgmvm|*.rpgmvo|*.png_|*.m4a_|*.ogg_"
                && evidence.status == EvidenceStatus::Matched
                && evidence.count == 6
        }));
        assert!(
            rpg_maker
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code == SemanticErrorCode::MissingKeyMaterial })
        );

        let serialized = fs::read_to_string(&detect_path).unwrap();
        for forbidden in ["title.rpgmvp", "theme.rpgmvm", "cursor.rpgmvo"] {
            assert!(!serialized.contains(forbidden), "report leaked {forbidden}");
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detect_source_without_units_has_no_engine_version() {
        let root = temp_dir("source-without-units-detect");
        let game_dir = root.join("unknown-fixture-like-game");
        fs::create_dir_all(&game_dir).unwrap();
        fs::write(
            game_dir.join("source.json"),
            r#"{
  "gameId": "not-fixture-yet",
  "title": "Not Fixture Yet",
  "sourceLocale": "ja-JP"
}
"#,
        )
        .unwrap();
        let detect_path = root.join("detect.json");

        run_cli(&[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ]);

        let detection_report: DetectionReport = read_json(&detect_path).unwrap();
        assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
        let detection = &detection_report.detections[0];
        assert!(!detection.detected);
        assert_eq!(detection.engine_family, None);
        assert_eq!(detection.engine_version, None);
        assert_eq!(detection.detected_variant, None);
        assert!(detection.evidence.iter().any(|evidence| {
            evidence.path == "source.json"
                && evidence.status == EvidenceStatus::Missing
                && evidence.detail.contains("missing units")
        }));
        let serialized: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&detect_path).unwrap()).unwrap();
        let detection_json = serialized["detections"][0].as_object().unwrap();
        assert!(!detection_json.contains_key("engineFamily"));
        assert!(!detection_json.contains_key("engineVersion"));
        assert!(!detection_json.contains_key("detectedVariant"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_init_is_stable_across_repeated_cli_runs() {
        let root = temp_dir("profile-init-stability");
        let game_dir = temp_game(&root);
        let first_path = root.join("profile-first.json");
        let second_path = root.join("profile-second.json");

        run_cli(&[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            first_path.to_str().unwrap(),
        ]);
        run_cli(&[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            second_path.to_str().unwrap(),
        ]);

        assert_eq!(
            fs::read_to_string(&first_path).unwrap(),
            fs::read_to_string(&second_path).unwrap()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_validation_reports_missing_required_fields() {
        let root = temp_dir("profile-validation-failure");
        let profile_path = root.join("profile.json");
        let validation_path = root.join("validation.json");
        fs::write(
            &profile_path,
            r#"{
  "schemaVersion": "0.1.0",
  "profileId": "",
  "gameId": "broken-game",
  "title": "Broken Game",
  "sourceLocale": "ja-JP",
  "engine": {
    "adapterId": "kaifuu.fixture",
    "engineFamily": "fixture",
    "engineVersion": null,
    "detectedVariant": ""
  },
  "assets": [],
  "capabilities": [],
  "requirements": [
    {
      "category": "secret_key",
      "key": "archive_key",
      "status": "missing",
      "description": "archive key must be provided out of band",
      "placeholder": "KAIFUU_ARCHIVE_KEY",
      "secret": true
    }
  ],
  "metadata": {}
}
"#,
        )
        .unwrap();

        run_cli(&[
            "profile",
            "validate",
            profile_path.to_str().unwrap(),
            "--output",
            validation_path.to_str().unwrap(),
        ]);

        let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(validation.failures.iter().any(|failure| {
            failure.code == "missing_required_field" && failure.field == "profileId"
        }));
        assert!(validation.failures.iter().any(|failure| {
            failure.code == "missing_requirement" && failure.field == "requirements.archive_key"
        }));
        let serialized = fs::read_to_string(&validation_path).unwrap();
        assert!(serialized.contains("KAIFUU_ARCHIVE_KEY"));
        assert!(!serialized.contains("actual-secret"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_validation_redacts_secret_bearing_key_profile_fields() {
        let root = temp_dir("profile-validation-redaction");
        let profile_path = root.join("profile.json");
        let validation_path = root.join("validation.json");
        fs::write(
            &profile_path,
            r#"{
  "schemaVersion": "0.1.0",
  "profileId": "019ed000-0000-7000-8000-profile00014",
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
      "rawKey": "00112233445566778899aabbccddeeff",
      "validation": {
        "method": "decryptHeaderProof",
        "proofHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    }
  ],
  "archiveParameters": [
    {
      "parameterId": "scene-cipher-key",
      "name": "cipherKey",
      "kind": "cipherScheme",
      "value": "mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b",
      "source": "manual"
    }
  ],
  "helperEvidence": {
    "helperKind": "staticParser",
    "toolVersion": "kaifuu-key-helper/0.1.0",
    "redactedLogHash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "helperDump": "register dump with local key bytes"
  },
  "assets": [
    {
      "assetId": "019ed000-0000-7000-8000-asset0000014",
      "path": "Scene.pck",
      "assetKind": "archive",
      "textSurfaces": ["dialogue"],
      "sourceHash": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
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
  "metadata": {
    "localPath": "/home/dev/private-game",
    "decryptedText": "private script line"
  }
}
"#,
        )
        .unwrap();

        run_cli(&[
            "profile",
            "validate",
            profile_path.to_str().unwrap(),
            "--output",
            validation_path.to_str().unwrap(),
        ]);

        let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
        assert_eq!(validation.status, OperationStatus::Failed);
        for field in [
            "keyRequirements.0.rawKey",
            "archiveParameters.0.value",
            "helperEvidence.helperDump",
            "metadata.localPath",
            "metadata.decryptedText",
        ] {
            assert!(
                validation.failures.iter().any(|failure| {
                    failure.code == kaifuu_core::SEMANTIC_SECRET_REDACTED && failure.field == field
                }),
                "missing secret redaction failure for {field}: {:#?}",
                validation.failures
            );
        }
        let serialized = fs::read_to_string(&validation_path).unwrap();
        assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
        assert!(!serialized.contains("mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b"));
        assert!(!serialized.contains("/home/dev/private-game"));
        assert!(!serialized.contains("private script line"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_validation_redacts_requirement_free_text_fields() {
        let root = temp_dir("profile-validation-requirement-redaction");
        let profile_path = root.join("profile.json");
        let validation_path = root.join("validation.json");
        fs::write(
            &profile_path,
            r#"{
  "schemaVersion": "0.1.0",
  "profileId": "019ed000-0000-7000-8000-profile00015",
  "gameId": "sensitive-requirements",
  "title": "Sensitive Requirements",
  "sourceLocale": "ja-JP",
  "engine": {
    "adapterId": "kaifuu.fixture",
    "engineFamily": "fixture",
    "engineVersion": null,
    "detectedVariant": "plain-json-source"
  },
  "assets": [],
  "capabilities": [
    {
      "capability": "patching",
      "status": "limited",
      "limitation": "requires profile validation"
    }
  ],
  "requirements": [
    {
      "category": "secret_key",
      "key": "archive-key",
      "status": "missing",
      "description": "helper dump source:/home/dev/game/private-route-ending.ks exposed raw key 00112233445566778899aabbccddeeff",
      "placeholder": "file=C:\\Games\\SecretRoute\\key.bin",
      "secret": true
    },
    {
      "category": "file",
      "key": "story-script",
      "status": "unsupported",
      "description": "decrypted text from private-route-ending.ks must remain local",
      "placeholder": null,
      "secret": false
    }
  ],
  "metadata": {}
}
"#,
        )
        .unwrap();

        run_cli(&[
            "profile",
            "validate",
            profile_path.to_str().unwrap(),
            "--output",
            validation_path.to_str().unwrap(),
        ]);

        let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
        assert_eq!(validation.status, OperationStatus::Failed);
        for field in [
            "requirements.0.description",
            "requirements.0.placeholder",
            "requirements.1.description",
        ] {
            assert!(
                validation.failures.iter().any(|failure| {
                    failure.code == kaifuu_core::SEMANTIC_SECRET_REDACTED && failure.field == field
                }),
                "missing requirement redaction failure for {field}: {:#?}",
                validation.failures
            );
        }
        let serialized = fs::read_to_string(&validation_path).unwrap();
        assert!(serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
        for forbidden in [
            "/home/dev/game",
            "C:\\Games",
            "helper dump",
            "decrypted text",
            "00112233445566778899aabbccddeeff",
            "private-route-ending.ks",
            "SecretRoute",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "validation leaked {forbidden}"
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_validation_reports_malformed_profile_fields() {
        let root = temp_dir("profile-validation-malformed");
        let profile_path = root.join("profile.json");
        let validation_path = root.join("validation.json");
        fs::write(
            &profile_path,
            r#"{
  "schemaVersion": "9.9.9",
  "profileId": "bad profile id",
  "gameId": "broken-game",
  "title": "Broken Game",
  "sourceLocale": "ja_JP",
  "engine": {
    "adapterId": "kaifuu.fixture",
    "engineFamily": "fixture",
    "engineVersion": "",
    "detectedVariant": "plain-json-source"
  },
  "assets": [
    {
      "assetId": "bad asset",
      "path": "../source.json",
      "assetKind": "scriptish",
      "textSurfaces": ["dialogue", "dialogue", "bad_surface"],
      "sourceHash": "",
      "patching": {
        "capability": "line_parity_patching",
        "status": "limited",
        "limitation": ""
      }
    }
  ],
  "capabilities": [
    {
      "capability": "detection",
      "status": "supported",
      "limitation": "unexpected"
    },
    {
      "capability": "detection",
      "status": "supported",
      "limitation": null
    }
  ],
  "requirements": [
    {
      "category": "secret_key",
      "key": "archive key",
      "status": "blocked",
      "description": "",
      "placeholder": null,
      "secret": true
    }
  ],
  "metadata": {}
}
"#,
        )
        .unwrap();

        run_cli(&[
            "profile",
            "validate",
            profile_path.to_str().unwrap(),
            "--output",
            validation_path.to_str().unwrap(),
        ]);

        let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
        assert_eq!(validation.status, OperationStatus::Failed);
        for expected_code in [
            "unsupported_schema_version",
            "invalid_locale",
            "invalid_engine_version",
            "invalid_asset_id",
            "invalid_asset_path",
            "invalid_enum_value",
            "duplicate_text_surface",
            "invalid_text_surface",
            "invalid_source_hash",
            "missing_capability_limitation",
            "unexpected_capability_limitation",
            "duplicate_capability",
            "invalid_requirement_key",
            "inconsistent_capability",
        ] {
            assert!(
                validation
                    .failures
                    .iter()
                    .any(|failure| failure.code == expected_code),
                "missing validation failure code {expected_code}: {:#?}",
                validation.failures
            );
        }
        let serialized = fs::read_to_string(&validation_path).unwrap();
        assert!(!serialized.contains("confidence"));
        assert!(!serialized.contains("actual-secret"));

        let _ = fs::remove_dir_all(root);
    }
}
