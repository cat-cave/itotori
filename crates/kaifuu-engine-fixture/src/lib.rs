use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use kaifuu_core::{
    AdapterCapabilities, AdapterFailure, AssetKind, AssetList, AssetListRequest, AssetProfile,
    BridgeBundle, BridgeUnit, Capability, CapabilityReport, DetectRequest, DetectionIndicator,
    DetectionResult, EngineAdapter, EngineProfile, ExtractRequest, ExtractionResult, GameProfile,
    KaifuuResult, OperationStatus, PatchExport, PatchRef, PatchRequest, PatchResult,
    ProfileRequest, ProtectedSpan, TextSurface, VerificationResult, VerifyRequest, content_hash,
    deterministic_id, read_json, require_str, require_u64, write_json,
};
use serde_json::{Value, json};

pub const FIXTURE_ADAPTER_ID: &str = "kaifuu.fixture";

#[derive(Debug, Default, Clone, Copy)]
pub struct FixtureAdapter;

impl FixtureAdapter {
    fn source_path(game_dir: &Path) -> std::path::PathBuf {
        game_dir.join("source.json")
    }

    fn read_source(game_dir: &Path) -> KaifuuResult<(String, Value)> {
        let source_text = fs::read_to_string(Self::source_path(game_dir))?;
        let source = serde_json::from_str(&source_text)?;
        Ok((source_text, source))
    }

    fn source_locale(source: &Value) -> String {
        source["sourceLocale"]
            .as_str()
            .unwrap_or("ja-JP")
            .to_string()
    }

    fn text_surface_from_fixture_name(name: &str) -> TextSurface {
        match name {
            "narration" => TextSurface::Narration,
            "speaker_name" => TextSurface::SpeakerName,
            "choice_label" => TextSurface::ChoiceLabel,
            "ui_label" => TextSurface::UiLabel,
            "tutorial_text" => TextSurface::TutorialText,
            "database_entry" => TextSurface::DatabaseEntry,
            "song_title" => TextSurface::SongTitle,
            "image_text" => TextSurface::ImageText,
            "metadata_text" => TextSurface::MetadataText,
            _ => TextSurface::Dialogue,
        }
    }

    fn patch_failure(
        error_code: impl Into<String>,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
        remediation: impl Into<String>,
    ) -> AdapterFailure {
        AdapterFailure {
            error_code: error_code.into(),
            adapter: FIXTURE_ADAPTER_ID.to_string(),
            engine: Some("fixture".to_string()),
            detected_variant: Some("plain-json-source".to_string()),
            asset_ref: Some(asset_ref.into()),
            required_capability: Some(Capability::LineParityPatching),
            support_boundary: support_boundary.into(),
            remediation: Some(remediation.into()),
        }
    }

    fn profile_from_source(&self, source_text: &str, source: &Value) -> KaifuuResult<GameProfile> {
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "supportBoundary".to_string(),
            "Synthetic plain JSON fixture with text units in source.json".to_string(),
        );

        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: deterministic_id("profile", 1),
            game_id: source["gameId"]
                .as_str()
                .unwrap_or("fixture-game")
                .to_string(),
            title: source["title"]
                .as_str()
                .unwrap_or("Fixture Game")
                .to_string(),
            source_locale: Self::source_locale(source),
            engine: EngineProfile {
                adapter_id: FIXTURE_ADAPTER_ID.to_string(),
                engine_family: "fixture".to_string(),
                engine_version: Some(env!("CARGO_PKG_VERSION").to_string()),
                detected_variant: "plain-json-source".to_string(),
            },
            assets: vec![self.asset_from_source(source_text, source)?],
            capabilities: self.capabilities().reports,
            metadata,
        };
        profile.normalize();
        Ok(profile)
    }

    fn asset_from_source(&self, source_text: &str, source: &Value) -> KaifuuResult<AssetProfile> {
        let units = source["units"]
            .as_array()
            .ok_or("fixture source missing units")?;
        let mut text_surfaces = units
            .iter()
            .map(|unit| {
                Self::text_surface_from_fixture_name(
                    unit["textSurface"].as_str().unwrap_or("dialogue"),
                )
            })
            .collect::<Vec<_>>();
        text_surfaces.sort_by_key(|surface| serde_json::to_string(surface).unwrap_or_default());
        text_surfaces.dedup();
        Ok(AssetProfile {
            asset_id: "source.json".to_string(),
            path: "source.json".to_string(),
            asset_kind: AssetKind::Script,
            text_surfaces,
            source_hash: Some(content_hash(source_text)),
            patching: CapabilityReport::limited(
                Capability::LineParityPatching,
                "patches existing fixture units by sourceUnitKey; new, deleted, and reordered units are not supported",
            ),
        })
    }
}

impl EngineAdapter for FixtureAdapter {
    fn id(&self) -> &'static str {
        FIXTURE_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu fixture adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities::new(
            FIXTURE_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::Extraction),
                CapabilityReport::limited(
                    Capability::Patching,
                    "writes source.json only; does not rebuild engine archives or binary assets",
                ),
                CapabilityReport::supported(Capability::Verification),
                CapabilityReport::supported(Capability::AssetListing),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::limited(
                    Capability::LineParityPatching,
                    "requires patch entries to match existing sourceUnitKey values",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "image, audio, video, and external asset text are outside the fixture format",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages are handled by kaifuu-delta, not this engine adapter",
                ),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "fixture projects are plaintext JSON and never encrypted",
                ),
                CapabilityReport::unsupported(
                    Capability::KeyProfile,
                    "fixture projects do not use user-provided keys",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime validation belongs to Utsushi fixture plumbing",
                ),
            ],
        )
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        let source_path = Self::source_path(request.game_dir);
        if !source_path.exists() {
            return Ok(DetectionResult {
                adapter_id: FIXTURE_ADAPTER_ID.to_string(),
                detected: false,
                confidence: 0.0,
                engine_family: None,
                engine_version: None,
                detected_variant: None,
                indicators: vec![],
                capabilities: self.capabilities().reports,
            });
        }
        let (_source_text, source) = Self::read_source(request.game_dir)?;
        let detected = source["units"].is_array();
        Ok(DetectionResult {
            adapter_id: FIXTURE_ADAPTER_ID.to_string(),
            detected,
            confidence: if detected { 1.0 } else { 0.25 },
            engine_family: detected.then(|| "fixture".to_string()),
            engine_version: Some(env!("CARGO_PKG_VERSION").to_string()),
            detected_variant: detected.then(|| "plain-json-source".to_string()),
            indicators: vec![DetectionIndicator {
                path: "source.json".to_string(),
                kind: "fixture_source".to_string(),
                evidence: if detected {
                    "source.json contains a units array".to_string()
                } else {
                    "source.json exists but is missing units".to_string()
                },
            }],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        let (source_text, source) = Self::read_source(request.game_dir)?;
        self.profile_from_source(&source_text, &source)
    }

    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        let (source_text, source) = Self::read_source(request.game_dir)?;
        Ok(AssetList {
            adapter_id: FIXTURE_ADAPTER_ID.to_string(),
            assets: vec![self.asset_from_source(&source_text, &source)?],
        })
    }

    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        let (source_text, source) = Self::read_source(request.game_dir)?;
        let profile = self.profile_from_source(&source_text, &source)?;
        let units = source["units"]
            .as_array()
            .ok_or("fixture source missing units")?;
        let source_locale = Self::source_locale(&source);
        let bridge_units = units
            .iter()
            .enumerate()
            .map(|(index, unit)| {
                let source_unit_key = require_str(unit, "sourceUnitKey")?;
                let text = require_str(unit, "sourceText")?;
                let protected_spans = unit["protectedSpans"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[])
                    .iter()
                    .map(|span| {
                        Ok(ProtectedSpan {
                            kind: require_str(span, "kind")?.to_string(),
                            raw: require_str(span, "raw")?.to_string(),
                            start: require_u64(span, "start")?,
                            end: require_u64(span, "end")?,
                            preserve_mode: "exact".to_string(),
                        })
                    })
                    .collect::<KaifuuResult<Vec<_>>>()?;
                Ok(BridgeUnit {
                    bridge_unit_id: deterministic_id("bridge-unit", index + 1),
                    source_unit_key: source_unit_key.to_string(),
                    occurrence_id: format!("occurrence-{}", index + 1),
                    source_hash: content_hash(text),
                    source_locale: source_locale.clone(),
                    source_text: text.to_string(),
                    speaker: unit["speaker"].as_str().unwrap_or("").to_string(),
                    text_surface: unit["textSurface"]
                        .as_str()
                        .unwrap_or("dialogue")
                        .to_string(),
                    protected_spans,
                    patch_ref: PatchRef {
                        asset_id: "source.json".to_string(),
                        write_mode: "replace".to_string(),
                        source_unit_key: source_unit_key.to_string(),
                    },
                })
            })
            .collect::<KaifuuResult<Vec<_>>>()?;
        Ok(ExtractionResult {
            adapter_id: FIXTURE_ADAPTER_ID.to_string(),
            profile,
            bridge: BridgeBundle {
                schema_version: "0.1.0".to_string(),
                bridge_id: deterministic_id("bridge", 1),
                source_bundle_hash: content_hash(&source_text),
                source_locale,
                extractor_name: "kaifuu-fixture".to_string(),
                extractor_version: env!("CARGO_PKG_VERSION").to_string(),
                units: bridge_units,
            },
            warnings: vec![],
        })
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let source_path = Self::source_path(request.game_dir);
        let source_text = fs::read_to_string(&source_path)?;
        let mut source: Value = serde_json::from_str(&source_text)?;
        let units = source["units"]
            .as_array()
            .ok_or("fixture source missing units")?;
        let mut source_hashes = BTreeMap::new();
        let mut seen_source_unit_keys = BTreeSet::new();
        let mut duplicate_source_unit_keys = BTreeSet::new();
        for unit in units {
            let key = require_str(unit, "sourceUnitKey")?;
            let source_text = require_str(unit, "sourceText")?;
            if !seen_source_unit_keys.insert(key.to_string()) {
                duplicate_source_unit_keys.insert(key.to_string());
                continue;
            }
            source_hashes.insert(key.to_string(), content_hash(source_text));
        }

        if !duplicate_source_unit_keys.is_empty() {
            let duplicate_keys = duplicate_source_unit_keys
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ");
            return Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 1),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Failed,
                output_hash: content_hash(&source_text),
                failures: vec![Self::patch_failure(
                    "duplicate_source_unit_key_in_source",
                    format!("source.json#{duplicate_keys}"),
                    "fixture patching requires source.json units to have unique sourceUnitKey values",
                    format!(
                        "Fix duplicate source.json sourceUnitKey values before applying this export: {duplicate_keys}"
                    ),
                )],
            });
        }

        let mut failures = Vec::new();
        let mut entries_by_source_unit_key = BTreeMap::new();
        for entry in &request.patch_export.entries {
            if entries_by_source_unit_key
                .insert(entry.source_unit_key.as_str(), entry)
                .is_some()
            {
                failures.push(Self::patch_failure(
                    "duplicate_source_unit_key",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires at most one patch entry per sourceUnitKey",
                    format!(
                        "Remove duplicate patch entries for sourceUnitKey {} before applying this export",
                        entry.source_unit_key
                    ),
                ));
            }

            let Some(current_hash) = source_hashes.get(&entry.source_unit_key) else {
                failures.push(Self::patch_failure(
                    "unmatched_source_unit_key",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching only updates existing source.json units by sourceUnitKey",
                    format!(
                        "Re-extract the fixture or remove patch entry {} before applying this export",
                        entry.source_unit_key
                    ),
                ));
                continue;
            };

            if current_hash != &entry.source_hash {
                failures.push(Self::patch_failure(
                    "source_hash_mismatch",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires PatchExportEntry.sourceHash to match the current sourceText hash",
                    format!(
                        "Re-extract sourceUnitKey {} and regenerate the patch export before applying it",
                        entry.source_unit_key
                    ),
                ));
            }
        }

        if !failures.is_empty() {
            return Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 1),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Failed,
                output_hash: content_hash(&source_text),
                failures,
            });
        }

        let units = source["units"]
            .as_array_mut()
            .ok_or("fixture source missing units")?;
        let mut remaining_entries = entries_by_source_unit_key;
        for unit in units {
            let key = require_str(unit, "sourceUnitKey")?;
            if let Some(entry) = remaining_entries.remove(key) {
                unit["targetText"] = json!(entry.target_text);
            }
        }
        if !remaining_entries.is_empty() {
            let unapplied_keys = remaining_entries
                .keys()
                .copied()
                .collect::<Vec<_>>()
                .join(", ");
            return Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 1),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Failed,
                output_hash: content_hash(&source_text),
                failures: vec![Self::patch_failure(
                    "validated_patch_entry_not_applied",
                    format!("source.json#{unapplied_keys}"),
                    "fixture patching must apply every validated PatchExportEntry exactly once",
                    format!(
                        "Re-extract the fixture or regenerate the patch export; unapplied sourceUnitKey values: {unapplied_keys}"
                    ),
                )],
            });
        }

        fs::create_dir_all(request.output_dir)?;
        let output_path = request.output_dir.join("source.json");
        let patched_text = format!("{}\n", serde_json::to_string_pretty(&source)?);
        fs::write(&output_path, &patched_text)?;
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-result", 1),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash(&patched_text),
            failures: vec![],
        })
    }

    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        let source_path = Self::source_path(request.game_dir);
        let source_text = fs::read_to_string(&source_path)?;
        let source: Value = serde_json::from_str(&source_text)?;
        let status = if source["units"].is_array() {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        };
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("verify", 1),
            status,
            output_hash: content_hash(&source_text),
            failures: vec![],
        })
    }
}

pub fn registry() -> kaifuu_core::AdapterRegistry {
    let mut registry = kaifuu_core::AdapterRegistry::new();
    registry.register(FixtureAdapter);
    registry
}

pub fn extract_fixture(game_dir: &Path) -> KaifuuResult<Value> {
    Ok(serde_json::to_value(
        FixtureAdapter.extract(ExtractRequest { game_dir })?.bridge,
    )?)
}

pub fn patch_fixture(
    game_dir: &Path,
    patch_export: &Value,
    output_dir: &Path,
) -> KaifuuResult<Value> {
    let patch_export = PatchExport::from_value(patch_export)?;
    Ok(serde_json::to_value(FixtureAdapter.patch(
        PatchRequest {
            game_dir,
            patch_export: &patch_export,
            output_dir,
        },
    )?)?)
}

pub fn verify_fixture(game_dir: &Path) -> KaifuuResult<Value> {
    Ok(serde_json::to_value(
        FixtureAdapter.verify(VerifyRequest { game_dir })?,
    )?)
}

pub fn profile_fixture(game_dir: &Path) -> KaifuuResult<GameProfile> {
    FixtureAdapter.profile(ProfileRequest { game_dir })
}

pub fn write_fixture_profile(game_dir: &Path, output: &Path) -> KaifuuResult<()> {
    let profile = profile_fixture(game_dir)?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output, profile.stable_json()?)?;
    Ok(())
}

pub fn read_patch_export(path: &Path) -> KaifuuResult<PatchExport> {
    read_json(path)
}

pub fn write_adapter_json<T>(path: &Path, value: &T) -> KaifuuResult<()>
where
    T: serde::Serialize,
{
    write_json(path, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_game(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kaifuu-engine-fixture-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("source.json"),
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
        dir
    }

    fn patch_export_for(extraction: &ExtractionResult) -> PatchExport {
        PatchExport {
            patch_export_id: deterministic_id("patch", 1),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![kaifuu_core::PatchExportEntry {
                bridge_unit_id: extraction.bridge.units[0].bridge_unit_id.clone(),
                source_unit_key: extraction.bridge.units[0].source_unit_key.clone(),
                source_hash: extraction.bridge.units[0].source_hash.clone(),
                target_text: "Hello, {player}.".to_string(),
                protected_spans: extraction.bridge.units[0].protected_spans.clone(),
            }],
        }
    }

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
                protected_spans: vec![],
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
            report.capability == Capability::RuntimeVm
                && report.status == kaifuu_core::CapabilityStatus::Unsupported
        }));
    }

    #[test]
    fn fixture_profile_json_is_stable() {
        let game_dir = temp_game("profile");
        let first = profile_fixture(&game_dir).unwrap().stable_json().unwrap();
        let second = profile_fixture(&game_dir).unwrap().stable_json().unwrap();
        assert_eq!(first, second);
        assert!(first.contains("\"capability\": \"line_parity_patching\""));
        let _ = fs::remove_dir_all(game_dir);
    }
}
