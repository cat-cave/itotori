use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use kaifuu_core::{
    ASSET_INVENTORY_SCHEMA_VERSION, AdapterCapabilities, AdapterFailure,
    AdapterFailureSemanticParams, AdapterHelperRequirementDeclaration, ArchiveParameter,
    ArchiveParameterKind, ArchiveParameterSource, AssetInventoryAsset, AssetInventoryAssetKind,
    AssetInventoryAssetRef, AssetInventoryManifest, AssetInventoryPatchMode, AssetInventoryRequest,
    AssetInventorySurface, AssetInventorySurfaceKind, AssetInventoryTextSourceKind, AssetKind,
    AssetList, AssetListRequest, AssetProfile, BridgeBundle, BridgeUnit, Capability,
    CapabilityReport, CapabilityStatus, CodecTransform, ContainerTransform, CryptoTransform,
    DetectRequest, DetectionEvidence, DetectionResult, EncodedStringSlot,
    EncodedStringSlotProtectedSpan, EngineAdapter, EngineProfile, EvidenceStatus, ExtractRequest,
    ExtractionResult, FIXTURE_HELPER_ALLOWLIST_REF_ID, FIXTURE_HELPER_REGISTRY_ID, GameProfile,
    HelperCapability, KaifuuResult, KeyMaterialKind, KeyRequirement,
    LayeredAccessCapabilityContract, LayeredAccessHelperStatus, LayeredAccessKeyMaterialStatus,
    LayeredAccessOperationContract, LayeredAccessProfile, LayeredTextSurfaceAccess,
    OperationStatus, PatchBackTransform, PatchPreflightRequest, PatchRef, PatchRequest,
    PatchResult, PlainXp3Entry, PlainXp3InventoryError, ProfileRequest, ProfileRequirement,
    ProtectedSpan, RequirementCategory, RequirementStatus, SecretRef, SemanticErrorCode,
    SourceFingerprint, SurfaceTransform, TextSurface, VerificationResult, VerifyRequest,
    XP3_PLAIN_MAGIC, atomic_write_text, content_hash, deterministic_id, normalize_protected_spans,
    parse_hex_bytes, read_plain_xp3_inventory, require_str, require_u64, safe_join_relative,
    sha256_file_ref,
};
use serde_json::{Value, json};

pub const FIXTURE_ADAPTER_ID: &str = "kaifuu.fixture";
pub const XP3_DETECTOR_ADAPTER_ID: &str = "kaifuu.kirikiri_xp3";
pub const SIGLUS_DETECTOR_ADAPTER_ID: &str = "kaifuu.siglus";
const XP3_ARCHIVE_PATH: &str = "data.xp3";
const XP3_MAGIC: &[u8] = b"XP3";
const XP3_ENCRYPTED_MARKER: &str = "XP3-CRYPT";
const XP3_COMPRESSED_MARKER: &str = "XP3-COMPRESSED";
const XP3_HELPER_REQUIRED_MARKER: &str = "XP3-HELPER-REQUIRED";
const XP3_UNKNOWN_MARKER: &str = "XP3-UNKNOWN-VARIANT";
const XP3_GAME_ID: &str = "kaifuu-kirikiri-xp3-synthetic-archive";
const XP3_SUPPORT_BOUNDARY: &str = "XP3 profile fixtures identify synthetic KiriKiri/XP3 archive containers; plain fixture index metadata may be parsed for inventory only, while payload extraction, decompression, decryption, patch-back, and runtime support are not claimed.";
const SIGLUS_SCENE_PATH: &str = "Scene.pck";
const SIGLUS_GAMEEXE_PATH: &str = "Gameexe.dat";
const SIGLUS_SCENE_MAGIC: &[u8] = b"SIGLUS-SCENE-PCK";
const SIGLUS_GAMEEXE_MAGIC: &[u8] = b"SIGLUS-GAMEEXE-DAT";
const SIGLUS_PROFILE_ID: &str = "019ed000-0000-7000-8000-000000091001";
const SIGLUS_GAME_ID: &str = "kaifuu-siglus-synthetic-scene-pck";
const SIGLUS_SUPPORT_BOUNDARY: &str = "Siglus detector profile identifies synthetic Scene.pck/Gameexe.dat fixtures for identify and inventory only; parser, extraction, decryption, patch-back, and runtime support are not claimed.";

#[derive(Debug, Default, Clone, Copy)]
pub struct FixtureAdapter;

#[derive(Debug, Default, Clone, Copy)]
pub struct Xp3ProfileDetectorAdapter;

#[derive(Debug, Default, Clone, Copy)]
pub struct SiglusProfileDetectorAdapter;

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

    fn requirements(source_present: bool) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: "source.json".to_string(),
                status: if source_present {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::Missing
                },
                description: "fixture games require a plaintext source.json manifest".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "host_os".to_string(),
                status: RequirementStatus::Satisfied,
                description: "fixture adapter uses portable JSON file IO and has no engine runtime platform constraint".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "decryption_key".to_string(),
                status: RequirementStatus::NotRequired,
                description: "fixture projects are plaintext JSON and do not require user-provided keys".to_string(),
                placeholder: None,
                secret: true,
            },
        ]
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

    fn protected_span_patch_failures(
        entry: &kaifuu_core::PatchExportEntry,
        required_spans: &[ProtectedSpan],
    ) -> Vec<AdapterFailure> {
        let mut failures = Vec::new();
        let mut required_counts = BTreeMap::<&str, usize>::new();
        for span in required_spans {
            if span.raw.is_empty() {
                continue;
            }
            *required_counts.entry(span.raw.as_str()).or_default() += 1;
        }

        let mut declared_counts = BTreeMap::<&str, usize>::new();
        for mapping in &entry.protected_span_mappings {
            if mapping.raw.is_empty() {
                continue;
            }
            *declared_counts.entry(mapping.raw.as_str()).or_default() += 1;
            if !mapping.matches_target_text(&entry.target_text) {
                failures.push(Self::patch_failure(
                    "protected_span_mapping_mismatch",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires protectedSpanMappings to point at raw text in targetText",
                    format!(
                        "Align protectedSpanMappings for protected span {:?} in sourceUnitKey {}",
                        mapping.raw, entry.source_unit_key
                    ),
                ));
            }
        }

        let mut protected_raws = BTreeSet::new();
        for raw in required_counts.keys().chain(declared_counts.keys()) {
            protected_raws.insert(*raw);
        }
        for raw in protected_raws {
            let required_count = required_counts.get(raw).copied().unwrap_or_default();
            let declared_count = declared_counts.get(raw).copied().unwrap_or_default();
            if declared_count < required_count {
                failures.push(Self::patch_failure(
                    "protected_span_missing",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires protectedSpanMappings to account for every protected span in the source unit",
                    format!(
                        "Add protectedSpanMappings for protected span {raw:?} in sourceUnitKey {}",
                        entry.source_unit_key
                    ),
                ));
            }

            let required_count = required_count.max(declared_count);
            let actual_count = entry.target_text.match_indices(raw).count();
            if actual_count < required_count {
                failures.push(Self::patch_failure(
                    "protected_span_missing",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires targetText to preserve protected span raw text",
                    format!(
                        "Restore protected span {raw:?} in targetText for sourceUnitKey {}",
                        entry.source_unit_key
                    ),
                ));
            }
        }
        failures
    }

    fn profile_from_source(&self, source_text: &str, source: &Value) -> KaifuuResult<GameProfile> {
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "supportBoundary".to_string(),
            "Synthetic plain JSON fixture with text units in source.json".to_string(),
        );

        let asset = self.asset_from_source(source_text, source)?;
        let layered_access = LayeredAccessProfile::plaintext_identity_for_asset(
            asset.asset_id.clone(),
            asset.path.clone(),
            &asset.text_surfaces,
            "/units/*/sourceText",
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
            source_fingerprint: None,
            key_requirements: vec![],
            archive_parameters: vec![],
            helper_evidence: None,
            assets: vec![asset],
            layered_access: Some(layered_access),
            capabilities: self.capabilities().reports,
            requirements: Self::requirements(true),
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

    fn asset_inventory_from_source(
        &self,
        source_text: &str,
        source: &Value,
    ) -> KaifuuResult<AssetInventoryManifest> {
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "supportBoundary".to_string(),
            "Synthetic plain JSON fixture asset inventory; non-text surfaces are reported from explicit fixture metadata and are not OCR results"
                .to_string(),
        );

        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("asset-inventory", 1),
            adapter_id: FIXTURE_ADAPTER_ID.to_string(),
            source_locale: Self::source_locale(source),
            assets: self.asset_inventory_assets_from_source(source_text, source)?,
            surfaces: self.asset_inventory_surfaces_from_source(source)?,
            capabilities: self.capabilities().reports,
            warnings: vec![],
            metadata,
        };
        manifest.normalize();
        Ok(manifest)
    }

    fn asset_inventory_assets_from_source(
        &self,
        source_text: &str,
        source: &Value,
    ) -> KaifuuResult<Vec<AssetInventoryAsset>> {
        let mut assets = vec![AssetInventoryAsset {
            asset_id: "source.json".to_string(),
            asset_key: "source.json".to_string(),
            asset_kind: AssetInventoryAssetKind::Script,
            path: Some("source.json".to_string()),
            source_hash: Some(content_hash(source_text)),
            metadata: BTreeMap::new(),
        }];

        for asset in source["assets"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            let asset_id = require_str(asset, "assetId")?;
            let asset_key = require_str(asset, "assetKey")?;
            let asset_kind = Self::asset_inventory_asset_kind(require_str(asset, "assetKind")?)?;
            let path = asset["path"].as_str().map(str::to_string);
            let source_hash = asset["sourceHash"]
                .as_str()
                .map(str::to_string)
                .or_else(|| Some(content_hash(&format!("{asset_key}:{}", asset["assetKind"]))));
            assets.push(AssetInventoryAsset {
                asset_id: asset_id.to_string(),
                asset_key: asset_key.to_string(),
                asset_kind,
                path,
                source_hash,
                metadata: Self::string_metadata(asset.get("metadata"))?,
            });
        }

        Ok(assets)
    }

    fn asset_inventory_surfaces_from_source(
        &self,
        source: &Value,
    ) -> KaifuuResult<Vec<AssetInventorySurface>> {
        source["assetSurfaces"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .enumerate()
            .map(|(index, surface)| {
                let surface_id = surface["surfaceId"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| deterministic_id("asset-surface", index + 1));
                let source_text = surface["sourceText"].as_str().map(str::to_string);
                let source_hash = surface["sourceHash"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| source_text.as_deref().map(content_hash));
                let limitation = surface["patchingLimitation"]
                    .as_str()
                    .unwrap_or("fixture adapter reports this asset surface but cannot patch or edit non-text assets");
                Ok(AssetInventorySurface {
                    surface_id,
                    asset_surface_kind: Self::asset_inventory_surface_kind(require_str(
                        surface,
                        "assetSurfaceKind",
                    )?)?,
                    source_asset_ref: Self::asset_inventory_asset_ref(surface)?,
                    source_location: surface.get("sourceLocation").cloned(),
                    source_text,
                    source_hash,
                    text_source_kind: Self::asset_inventory_text_source_kind(require_str(
                        surface,
                        "textSourceKind",
                    )?)?,
                    patch_mode: Self::asset_inventory_patch_mode(require_str(
                        surface,
                        "patchMode",
                    )?)?,
                    patching: CapabilityReport::unsupported(
                        Capability::AssetTextPatching,
                        limitation,
                    ),
                    notes: surface["notes"]
                        .as_array()
                        .map(Vec::as_slice)
                        .unwrap_or(&[])
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect(),
                })
            })
            .collect()
    }

    fn asset_inventory_asset_ref(surface: &Value) -> KaifuuResult<AssetInventoryAssetRef> {
        let asset_ref = surface
            .get("sourceAssetRef")
            .ok_or("asset surface missing sourceAssetRef")?;
        Ok(AssetInventoryAssetRef {
            asset_id: require_str(asset_ref, "assetId")?.to_string(),
            asset_key: asset_ref["assetKey"].as_str().map(str::to_string),
        })
    }

    fn string_metadata(value: Option<&Value>) -> KaifuuResult<BTreeMap<String, String>> {
        let Some(value) = value else {
            return Ok(BTreeMap::new());
        };
        let object = value.as_object().ok_or("metadata must be a JSON object")?;
        let mut metadata = BTreeMap::new();
        for (key, value) in object {
            let Some(value) = value.as_str() else {
                return Err(format!("metadata.{key} must be a string").into());
            };
            metadata.insert(key.clone(), value.to_string());
        }
        Ok(metadata)
    }

    fn asset_inventory_asset_kind(kind: &str) -> KaifuuResult<AssetInventoryAssetKind> {
        Ok(serde_json::from_value(Value::String(kind.to_string()))?)
    }

    fn asset_inventory_surface_kind(kind: &str) -> KaifuuResult<AssetInventorySurfaceKind> {
        Ok(serde_json::from_value(Value::String(kind.to_string()))?)
    }

    fn asset_inventory_text_source_kind(kind: &str) -> KaifuuResult<AssetInventoryTextSourceKind> {
        Ok(serde_json::from_value(Value::String(kind.to_string()))?)
    }

    fn asset_inventory_patch_mode(kind: &str) -> KaifuuResult<AssetInventoryPatchMode> {
        Ok(serde_json::from_value(Value::String(kind.to_string()))?)
    }

    fn protected_spans_for_unit(unit: &Value, text: &str) -> KaifuuResult<Vec<ProtectedSpan>> {
        let mut spans = Self::parse_fixture_markup_spans(text)?;
        spans.extend(Self::explicit_protected_spans_for_unit(unit, text)?);
        normalize_protected_spans(text, spans)
    }

    fn encoded_string_slot_for_unit(
        unit: &Value,
        protected_spans: &[ProtectedSpan],
    ) -> KaifuuResult<Option<EncodedStringSlot>> {
        let Some(slot_value) = unit.get("encodedStringSlot") else {
            return Ok(None);
        };
        let mut slot: EncodedStringSlot = serde_json::from_value(slot_value.clone())?;
        if slot.protected_spans.is_empty() {
            slot.protected_spans = protected_spans
                .iter()
                .filter(|span| !span.raw.is_empty())
                .map(|span| EncodedStringSlotProtectedSpan::new(span.raw.clone()))
                .collect();
        }
        Ok(Some(slot))
    }

    fn source_slot_bytes_for_unit(unit: &Value) -> KaifuuResult<Option<Vec<u8>>> {
        unit.get("encodedStringSlot")
            .and_then(|slot| slot.get("sourceBytesHex"))
            .and_then(Value::as_str)
            .map(parse_hex_bytes)
            .transpose()
            .map_err(Into::into)
    }

    fn patch_preflight_failures(
        &self,
        source: &Value,
        patch_export: &kaifuu_core::PatchExport,
    ) -> KaifuuResult<Vec<AdapterFailure>> {
        let units = source["units"]
            .as_array()
            .ok_or("fixture source missing units")?;
        let mut source_hashes = BTreeMap::new();
        let mut source_protected_spans = BTreeMap::new();
        let mut encoded_slots = BTreeMap::new();
        let mut seen_source_unit_keys = BTreeSet::new();
        let mut duplicate_source_unit_keys = BTreeSet::new();

        for unit in units {
            let key = require_str(unit, "sourceUnitKey")?;
            let unit_source_text = require_str(unit, "sourceText")?;
            if !seen_source_unit_keys.insert(key.to_string()) {
                duplicate_source_unit_keys.insert(key.to_string());
                continue;
            }
            let protected_spans = Self::protected_spans_for_unit(unit, unit_source_text)?;
            if let Some(slot) = Self::encoded_string_slot_for_unit(unit, &protected_spans)? {
                encoded_slots.insert(
                    key.to_string(),
                    (slot, Self::source_slot_bytes_for_unit(unit)?),
                );
            }
            source_hashes.insert(key.to_string(), content_hash(unit_source_text));
            source_protected_spans.insert(key.to_string(), protected_spans);
        }

        if !duplicate_source_unit_keys.is_empty() {
            let duplicate_keys = duplicate_source_unit_keys
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ");
            return Ok(vec![Self::patch_failure(
                "duplicate_source_unit_key_in_source",
                format!("source.json#{duplicate_keys}"),
                "fixture patching requires source.json units to have unique sourceUnitKey values",
                format!(
                    "Fix duplicate source.json sourceUnitKey values before applying this export: {duplicate_keys}"
                ),
            )]);
        }

        let mut failures = Vec::new();
        let mut entries_by_source_unit_key = BTreeMap::new();
        for entry in &patch_export.entries {
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

            let required_spans = source_protected_spans
                .get(&entry.source_unit_key)
                .expect("source hashes and protected spans should have matching keys");
            failures.extend(Self::protected_span_patch_failures(entry, required_spans));

            if let Some((slot, current_slot_bytes)) = encoded_slots.get(&entry.source_unit_key) {
                let report = slot.preflight(
                    &entry.target_text,
                    &entry.protected_span_mappings,
                    current_slot_bytes.as_deref(),
                );
                failures.extend(report.diagnostics.into_iter().map(|diagnostic| {
                    AdapterFailure::encoded_string_slot_preflight(
                        FIXTURE_ADAPTER_ID,
                        "fixture",
                        "plain-json-source",
                        format!(
                            "source.json#{}#{}",
                            entry.source_unit_key, diagnostic.slot_id
                        ),
                        diagnostic,
                    )
                }));
            }
        }

        Ok(failures)
    }

    fn explicit_protected_spans_for_unit(
        unit: &Value,
        text: &str,
    ) -> KaifuuResult<Vec<ProtectedSpan>> {
        unit["protectedSpans"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .map(|span| {
                let raw = require_str(span, "raw")?;
                let (start, end) = Self::fixture_span_offsets(
                    text,
                    raw,
                    require_u64(span, "start")?,
                    require_u64(span, "end")?,
                );
                Ok(ProtectedSpan::new(
                    require_str(span, "kind")?,
                    raw,
                    start,
                    end,
                    span["preserveMode"].as_str().unwrap_or(""),
                ))
            })
            .collect()
    }

    fn fixture_span_offsets(text: &str, raw: &str, start: u64, end: u64) -> (u64, u64) {
        if Self::span_range_matches(text, raw, start, end) {
            return (start, end);
        }
        let Some(byte_start) = Self::char_offset_to_byte(text, start) else {
            return (start, end);
        };
        let Some(byte_end) = Self::char_offset_to_byte(text, end) else {
            return (start, end);
        };
        if Self::span_range_matches(text, raw, byte_start, byte_end) {
            return (byte_start, byte_end);
        }
        (start, end)
    }

    fn span_range_matches(text: &str, raw: &str, start: u64, end: u64) -> bool {
        let Ok(start) = usize::try_from(start) else {
            return false;
        };
        let Ok(end) = usize::try_from(end) else {
            return false;
        };
        start < end
            && end <= text.len()
            && text.is_char_boundary(start)
            && text.is_char_boundary(end)
            && &text[start..end] == raw
    }

    fn char_offset_to_byte(text: &str, offset: u64) -> Option<u64> {
        let offset = usize::try_from(offset).ok()?;
        if offset == text.chars().count() {
            return Some(text.len() as u64);
        }
        text.char_indices()
            .nth(offset)
            .map(|(byte_offset, _)| byte_offset as u64)
    }

    fn parse_fixture_markup_spans(text: &str) -> KaifuuResult<Vec<ProtectedSpan>> {
        let mut spans = Vec::new();
        let mut index = 0;
        while index < text.len() {
            let parsed = match text.as_bytes()[index] {
                b'{' => Some(Self::parse_braced_placeholder(text, index)),
                b'<' => Some(Self::parse_angle_markup(text, index)),
                b'\\' => Self::parse_backslash_markup(text, index),
                _ => None,
            };
            if let Some((span, next_index)) = parsed {
                spans.push(span);
                index = next_index;
                continue;
            }
            let next_char = text[index..]
                .chars()
                .next()
                .ok_or("fixture parser index must point at a UTF-8 character")?;
            index += next_char.len_utf8();
        }
        Ok(spans)
    }

    fn parse_braced_placeholder(text: &str, start: usize) -> (ProtectedSpan, usize) {
        let content_start = start + 1;
        let Some(relative_end) = text[content_start..].find('}') else {
            let raw = &text[start..];
            return (
                ProtectedSpan::control_markup(
                    raw,
                    start as u64,
                    text.len() as u64,
                    "unknown_unclosed_placeholder",
                    vec![],
                ),
                text.len(),
            );
        };
        let content_end = content_start + relative_end;
        let end = content_end + 1;
        let raw = &text[start..end];
        let name = &text[content_start..content_end];
        let span = if Self::is_fixture_placeholder_name(name) {
            ProtectedSpan::variable_placeholder(raw, start as u64, end as u64, name)
        } else {
            ProtectedSpan::control_markup(
                raw,
                start as u64,
                end as u64,
                "unknown_placeholder",
                vec![name.to_string()],
            )
        };
        (span, end)
    }

    fn is_fixture_placeholder_name(name: &str) -> bool {
        !name.is_empty()
            && name.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'_' | b'-' | b'.' | b':' | b'[' | b']')
            })
    }

    fn parse_angle_markup(text: &str, start: usize) -> (ProtectedSpan, usize) {
        let content_start = start + 1;
        let Some(relative_end) = text[content_start..].find('>') else {
            let raw = &text[start..];
            return (
                ProtectedSpan::control_markup(
                    raw,
                    start as u64,
                    text.len() as u64,
                    "unknown_unclosed_tag",
                    vec![],
                ),
                text.len(),
            );
        };
        let content_end = content_start + relative_end;
        let end = content_end + 1;
        if let Some(span) = Self::parse_ruby_markup(text, start, content_start, content_end, end) {
            return (span, end);
        }
        (
            Self::parse_control_tag(text, start, content_start, content_end, end),
            end,
        )
    }

    fn parse_ruby_markup(
        text: &str,
        start: usize,
        content_start: usize,
        content_end: usize,
        end: usize,
    ) -> Option<ProtectedSpan> {
        let content = &text[content_start..content_end];
        let equals_index = content.find('=')?;
        let name = content[..equals_index].trim();
        if !matches!(name, "ruby" | "furigana") {
            return None;
        }
        let values_start = content_start + equals_index + 1;
        let values = &text[values_start..content_end];
        let separator_index = values.find('|')?;
        let base_start = values_start;
        let base_end = values_start + separator_index;
        let annotation_start = base_end + 1;
        let annotation_end = content_end;
        let annotation_text = &text[annotation_start..annotation_end];
        let raw = &text[start..end];
        let mut span = ProtectedSpan::new(
            "ruby_annotation",
            raw,
            start as u64,
            end as u64,
            "locale_policy",
        );
        span.parsed_name = Some(name.to_string());
        span.arguments = Some(vec![
            text[base_start..base_end].to_string(),
            annotation_text.to_string(),
        ]);
        span.base_start_byte = Some(base_start as u64);
        span.base_end_byte = Some(base_end as u64);
        span.annotation_start_byte = Some(annotation_start as u64);
        span.annotation_end_byte = Some(annotation_end as u64);
        span.annotation_text = Some(annotation_text.to_string());
        span.display_mode = Some(name.to_string());
        Some(span)
    }

    fn parse_control_tag(
        text: &str,
        start: usize,
        content_start: usize,
        content_end: usize,
        end: usize,
    ) -> ProtectedSpan {
        let content = text[content_start..content_end].trim();
        let raw = &text[start..end];
        let (parsed_name, arguments) = Self::control_tag_metadata(content);
        ProtectedSpan::control_markup(raw, start as u64, end as u64, parsed_name, arguments)
    }

    fn control_tag_metadata(content: &str) -> (String, Vec<String>) {
        if content.is_empty() {
            return ("unknown_empty_tag".to_string(), vec![]);
        }
        if let Some(closing) = content.strip_prefix('/') {
            let name = Self::normalize_fixture_markup_name(closing);
            return (name, vec!["close".to_string()]);
        }
        let separator = content
            .char_indices()
            .find(|(_, character)| matches!(character, '=' | ':' | ' ' | '\t'));
        let Some((separator_index, separator_char)) = separator else {
            return (Self::normalize_fixture_markup_name(content), vec![]);
        };
        let name = Self::normalize_fixture_markup_name(&content[..separator_index]);
        let argument_text = content[separator_index + separator_char.len_utf8()..].trim();
        let arguments = if argument_text.is_empty() {
            vec![]
        } else {
            argument_text
                .split([',', '|'])
                .map(str::trim)
                .filter(|argument| !argument.is_empty())
                .map(str::to_string)
                .collect()
        };
        (name, arguments)
    }

    fn normalize_fixture_markup_name(name: &str) -> String {
        let name = name.trim();
        if name.is_empty() {
            "unknown_markup".to_string()
        } else {
            name.to_ascii_lowercase()
        }
    }

    fn parse_backslash_markup(text: &str, start: usize) -> Option<(ProtectedSpan, usize)> {
        let after_slash = start + 1;
        let Some(next) = text[after_slash..].chars().next() else {
            return Some(Self::unknown_backslash_markup(
                text,
                start,
                text.len(),
                "unknown_trailing_backslash",
                vec![],
            ));
        };
        if matches!(next, '.' | '|' | '!') {
            let end = after_slash + next.len_utf8();
            return Some((
                ProtectedSpan::control_markup(
                    &text[start..end],
                    start as u64,
                    end as u64,
                    "wait",
                    vec![next.to_string()],
                ),
                end,
            ));
        }
        if !next.is_ascii_alphabetic() {
            return Some(Self::parse_symbol_backslash_markup(
                text,
                start,
                after_slash,
                next,
            ));
        }
        let code_end = text[after_slash..]
            .char_indices()
            .take_while(|(_, character)| character.is_ascii_alphabetic())
            .last()
            .map(|(index, character)| after_slash + index + character.len_utf8())?;
        if !text[code_end..].starts_with('[') {
            let code = &text[after_slash..code_end];
            return Some(Self::unknown_backslash_markup(
                text,
                start,
                code_end,
                Self::normalize_fixture_markup_name(code),
                vec!["missing_bracket".to_string()],
            ));
        }
        let argument_start = code_end + 1;
        let Some(relative_end) = text[argument_start..].find(']') else {
            let code = &text[after_slash..code_end];
            return Some(Self::unknown_backslash_markup(
                text,
                start,
                text.len(),
                "unknown_unclosed_backslash_command",
                vec![code.to_string()],
            ));
        };
        let argument_end = argument_start + relative_end;
        let end = argument_end + 1;
        let code = &text[after_slash..code_end];
        let argument = &text[argument_start..argument_end];
        let raw = &text[start..end];
        let upper_code = code.to_ascii_uppercase();
        let mut span = match upper_code.as_str() {
            "N" | "NAME" => ProtectedSpan::variable_placeholder(
                raw,
                start as u64,
                end as u64,
                format!("name[{argument}]"),
            ),
            "V" | "VAR" => ProtectedSpan::variable_placeholder(
                raw,
                start as u64,
                end as u64,
                format!("variable[{argument}]"),
            ),
            "C" | "COLOR" => ProtectedSpan::control_markup(
                raw,
                start as u64,
                end as u64,
                "color",
                vec![argument.to_string()],
            ),
            _ => ProtectedSpan::control_markup(
                raw,
                start as u64,
                end as u64,
                Self::normalize_fixture_markup_name(code),
                vec![argument.to_string()],
            ),
        };
        span.parsed_name = Some(match upper_code.as_str() {
            "N" | "NAME" => "name_variable".to_string(),
            "V" | "VAR" => "runtime_variable".to_string(),
            "C" | "COLOR" => "color".to_string(),
            _ => Self::normalize_fixture_markup_name(code),
        });
        span.arguments = Some(vec![argument.to_string()]);
        Some((span, end))
    }

    fn parse_symbol_backslash_markup(
        text: &str,
        start: usize,
        after_slash: usize,
        command: char,
    ) -> (ProtectedSpan, usize) {
        let command_end = after_slash + command.len_utf8();
        if text[command_end..].starts_with('[') {
            let argument_start = command_end + 1;
            if let Some(relative_end) = text[argument_start..].find(']') {
                let argument_end = argument_start + relative_end;
                let end = argument_end + 1;
                return Self::unknown_backslash_markup(
                    text,
                    start,
                    end,
                    "unknown_backslash_command",
                    vec![
                        command.to_string(),
                        text[argument_start..argument_end].to_string(),
                    ],
                );
            }
            return Self::unknown_backslash_markup(
                text,
                start,
                text.len(),
                "unknown_unclosed_backslash_command",
                vec![command.to_string()],
            );
        }

        Self::unknown_backslash_markup(
            text,
            start,
            command_end,
            "unknown_backslash_command",
            vec![command.to_string()],
        )
    }

    fn unknown_backslash_markup(
        text: &str,
        start: usize,
        end: usize,
        parsed_name: impl Into<String>,
        arguments: Vec<String>,
    ) -> (ProtectedSpan, usize) {
        (
            ProtectedSpan::control_markup(
                &text[start..end],
                start as u64,
                end as u64,
                parsed_name,
                arguments,
            ),
            end,
        )
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
                CapabilityReport::supported(Capability::AssetInventory),
                CapabilityReport::limited(
                    Capability::NonTextSurfaceExtraction,
                    "reports explicit fixture asset metadata only; does not perform OCR, audio analysis, font inspection, or video frame analysis",
                ),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::limited(
                    Capability::LineParityPatching,
                    "requires patch entries to match existing sourceUnitKey values",
                ),
                CapabilityReport::supported(Capability::ContainerAccess),
                CapabilityReport::supported(Capability::CryptoAccess),
                CapabilityReport::supported(Capability::CodecAccess),
                CapabilityReport::limited(
                    Capability::PatchBack,
                    "rewrites plaintext source.json; archive rebuild and binary patch-back are not supported",
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
        .with_access_contract(LayeredAccessCapabilityContract::plaintext_identity())
        .with_helper_requirements(vec![AdapterHelperRequirementDeclaration::new(
            FIXTURE_HELPER_REGISTRY_ID,
            vec![HelperCapability::FixtureInvocation],
            FIXTURE_HELPER_ALLOWLIST_REF_ID,
        )])
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        let source_path = Self::source_path(request.game_dir);
        if !source_path.exists() {
            return Ok(DetectionResult {
                adapter_id: FIXTURE_ADAPTER_ID.to_string(),
                detected: false,
                engine_family: None,
                engine_version: None,
                detected_variant: None,
                evidence: vec![DetectionEvidence {
                    path: "source.json".to_string(),
                    kind: "required_manifest".to_string(),
                    status: EvidenceStatus::Missing,
                    detail: "source.json is required for the fixture engine".to_string(),
                }],
                requirements: Self::requirements(false),
                capabilities: self.capabilities().reports,
            });
        }
        let source_text = fs::read_to_string(&source_path)?;
        let Ok(source) = serde_json::from_str::<Value>(&source_text) else {
            return Ok(DetectionResult {
                adapter_id: FIXTURE_ADAPTER_ID.to_string(),
                detected: false,
                engine_family: None,
                engine_version: None,
                detected_variant: None,
                evidence: vec![DetectionEvidence {
                    path: "source.json".to_string(),
                    kind: "fixture_source".to_string(),
                    status: EvidenceStatus::Invalid,
                    detail: "source.json exists but is not valid JSON".to_string(),
                }],
                requirements: Self::requirements(true),
                capabilities: self.capabilities().reports,
            });
        };
        let detected = source["units"].is_array();
        Ok(DetectionResult {
            adapter_id: FIXTURE_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| "fixture".to_string()),
            engine_version: detected.then(|| env!("CARGO_PKG_VERSION").to_string()),
            detected_variant: detected.then(|| "plain-json-source".to_string()),
            evidence: vec![DetectionEvidence {
                path: "source.json".to_string(),
                kind: "fixture_source".to_string(),
                status: if detected {
                    EvidenceStatus::Matched
                } else {
                    EvidenceStatus::Missing
                },
                detail: if detected {
                    "source.json contains a units array".to_string()
                } else {
                    "source.json exists but is missing units".to_string()
                },
            }],
            requirements: Self::requirements(true),
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

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        let (source_text, source) = Self::read_source(request.game_dir)?;
        self.asset_inventory_from_source(&source_text, &source)
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
                let protected_spans = Self::protected_spans_for_unit(unit, text)?;
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

    fn patch_preflight(
        &self,
        request: kaifuu_core::PatchPreflightRequest<'_>,
    ) -> KaifuuResult<PatchResult> {
        let (_source_text, source) = Self::read_source(request.game_dir)?;
        let failures = self.patch_preflight_failures(&source, request.patch_export)?;
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-preflight", 1),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: if failures.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            output_hash: content_hash("fixture patch preflight without output"),
            failures,
        })
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let source_path = Self::source_path(request.game_dir);
        let source_text = fs::read_to_string(&source_path)?;
        let mut source: Value = serde_json::from_str(&source_text)?;
        let units = source["units"]
            .as_array()
            .ok_or("fixture source missing units")?;
        let preflight_failures = self.patch_preflight_failures(&source, request.patch_export)?;
        if !preflight_failures.is_empty() {
            return Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 1),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Failed,
                output_hash: content_hash(&source_text),
                failures: preflight_failures,
            });
        }
        let mut source_hashes = BTreeMap::new();
        let mut source_protected_spans = BTreeMap::new();
        let mut seen_source_unit_keys = BTreeSet::new();
        let mut duplicate_source_unit_keys = BTreeSet::new();
        for unit in units {
            let key = require_str(unit, "sourceUnitKey")?;
            let unit_source_text = require_str(unit, "sourceText")?;
            if !seen_source_unit_keys.insert(key.to_string()) {
                duplicate_source_unit_keys.insert(key.to_string());
                continue;
            }
            source_hashes.insert(key.to_string(), content_hash(unit_source_text));
            source_protected_spans.insert(
                key.to_string(),
                Self::protected_spans_for_unit(unit, unit_source_text)?,
            );
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

            let required_spans = source_protected_spans
                .get(&entry.source_unit_key)
                .expect("source hashes and protected spans should have matching keys");
            failures.extend(Self::protected_span_patch_failures(entry, required_spans));
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

        let output_path = safe_join_relative(request.output_dir, "source.json")?;
        let patched_text = format!("{}\n", serde_json::to_string_pretty(&source)?);
        atomic_write_text(&output_path, &patched_text)?;
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

#[derive(Debug, Clone)]
struct Xp3FixtureState {
    archive_path: std::path::PathBuf,
    archive_exists: bool,
    archive_signature: bool,
    archive_hash: Option<String>,
    variant: Xp3FixtureVariant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Xp3FixtureVariant {
    Plain,
    Encrypted,
    HelperRequired,
    Compressed,
    Unknown,
    NotXp3,
}

impl Xp3ProfileDetectorAdapter {
    fn archive_path(game_dir: &Path) -> std::path::PathBuf {
        game_dir.join(XP3_ARCHIVE_PATH)
    }

    fn inspect(game_dir: &Path) -> Xp3FixtureState {
        let archive_path = Self::archive_path(game_dir);
        let archive_exists = archive_path.is_file();
        let bytes = fs::read(&archive_path).unwrap_or_default();
        let archive_signature = bytes.starts_with(XP3_MAGIC);
        let marker_text = Self::legacy_marker_text(&bytes);
        let variant = if !archive_signature {
            if archive_exists {
                Xp3FixtureVariant::Unknown
            } else {
                Xp3FixtureVariant::NotXp3
            }
        } else if marker_text.contains(&XP3_UNKNOWN_MARKER.to_ascii_lowercase()) {
            Xp3FixtureVariant::Unknown
        } else if marker_text.contains(&XP3_HELPER_REQUIRED_MARKER.to_ascii_lowercase()) {
            Xp3FixtureVariant::HelperRequired
        } else if marker_text.contains(&XP3_ENCRYPTED_MARKER.to_ascii_lowercase())
            || marker_text.contains("kaifuu-xp3-encrypted")
        {
            Xp3FixtureVariant::Encrypted
        } else if marker_text.contains(&XP3_COMPRESSED_MARKER.to_ascii_lowercase())
            || marker_text.contains("kaifuu-xp3-compressed")
        {
            Xp3FixtureVariant::Compressed
        } else {
            Xp3FixtureVariant::Plain
        };
        let archive_hash = archive_exists
            .then(|| sha256_file_ref(&archive_path).ok())
            .flatten();
        Xp3FixtureState {
            archive_path,
            archive_exists,
            archive_signature,
            archive_hash,
            variant,
        }
    }

    fn legacy_marker_text(bytes: &[u8]) -> String {
        if !bytes.starts_with(b"XP3\r\n") || bytes.starts_with(XP3_PLAIN_MAGIC) {
            return String::new();
        }
        String::from_utf8_lossy(&bytes[..bytes.len().min(128)]).to_ascii_lowercase()
    }

    fn detected_variant(variant: Xp3FixtureVariant) -> &'static str {
        match variant {
            Xp3FixtureVariant::Plain => "xp3-plain-container",
            Xp3FixtureVariant::Encrypted => "xp3-encrypted-container",
            Xp3FixtureVariant::HelperRequired => "xp3-helper-required-container",
            Xp3FixtureVariant::Compressed => "xp3-compressed-container",
            Xp3FixtureVariant::Unknown => "xp3-unknown-container",
            Xp3FixtureVariant::NotXp3 => "not-xp3",
        }
    }

    fn profile_id(variant: Xp3FixtureVariant) -> &'static str {
        match variant {
            Xp3FixtureVariant::Plain => "019ed000-0000-7000-8000-000000095001",
            Xp3FixtureVariant::Encrypted => "019ed000-0000-7000-8000-000000095002",
            Xp3FixtureVariant::Compressed => "019ed000-0000-7000-8000-000000095003",
            Xp3FixtureVariant::HelperRequired => "019ed000-0000-7000-8000-000000095004",
            Xp3FixtureVariant::Unknown | Xp3FixtureVariant::NotXp3 => {
                "019ed000-0000-7000-8000-000000095099"
            }
        }
    }

    fn archive_parameter_variant(variant: Xp3FixtureVariant) -> &'static str {
        match variant {
            Xp3FixtureVariant::Plain => "plain",
            Xp3FixtureVariant::Encrypted => "encrypted",
            Xp3FixtureVariant::HelperRequired => "helper_required",
            Xp3FixtureVariant::Compressed => "compressed",
            Xp3FixtureVariant::Unknown => "unknown",
            Xp3FixtureVariant::NotXp3 => "not-xp3",
        }
    }

    fn is_detected(variant: Xp3FixtureVariant) -> bool {
        matches!(
            variant,
            Xp3FixtureVariant::Plain
                | Xp3FixtureVariant::Encrypted
                | Xp3FixtureVariant::HelperRequired
                | Xp3FixtureVariant::Compressed
        )
    }

    fn can_inventory(variant: Xp3FixtureVariant) -> bool {
        matches!(
            variant,
            Xp3FixtureVariant::Plain | Xp3FixtureVariant::Compressed
        )
    }

    fn profile_from_state(&self, state: Xp3FixtureState) -> KaifuuResult<GameProfile> {
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: Self::profile_id(state.variant).to_string(),
            game_id: format!("{XP3_GAME_ID}-{}", Self::detected_variant(state.variant)),
            title: "KiriKiri XP3 fixture".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: XP3_DETECTOR_ADAPTER_ID.to_string(),
                engine_family: "kiri_kiri_xp3".to_string(),
                engine_version: None,
                detected_variant: Self::detected_variant(state.variant).to_string(),
            },
            source_fingerprint: Some(SourceFingerprint {
                game_root_hash: None,
                engine_evidence: state.engine_evidence(),
            }),
            key_requirements: state.key_requirements()?,
            archive_parameters: state.archive_parameters(),
            helper_evidence: None,
            assets: state.asset_profiles(),
            layered_access: Some(state.layered_access_profile()),
            capabilities: self.capabilities().reports,
            requirements: state.profile_requirements(),
            metadata: state.metadata(),
        };
        profile.normalize();
        Ok(profile)
    }

    fn inventory_from_state(&self, state: Xp3FixtureState) -> KaifuuResult<AssetInventoryManifest> {
        if state.variant == Xp3FixtureVariant::Encrypted {
            return Err(Self::diagnostic_error(Self::crypto_boundary_failure(
                state.variant,
            )));
        }
        if state.variant == Xp3FixtureVariant::HelperRequired {
            return Err(Self::diagnostic_error(Self::helper_required_failure(
                state.variant,
            )));
        }
        if !Self::can_inventory(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let archive_bytes = fs::read(&state.archive_path)?;
        let xp3_inventory =
            read_plain_xp3_inventory(&archive_bytes).map_err(Self::inventory_reader_error)?;
        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("xp3-inventory", 95),
            adapter_id: XP3_DETECTOR_ADAPTER_ID.to_string(),
            source_locale: "ja-JP".to_string(),
            assets: state.inventory_assets(&xp3_inventory.entries),
            surfaces: vec![],
            capabilities: self.capabilities().reports,
            warnings: vec![],
            metadata: state.metadata(),
        };
        manifest.normalize();
        Ok(manifest)
    }

    fn unsupported_failure(
        code: SemanticErrorCode,
        required_capability: Capability,
        variant: impl Into<String>,
        support_boundary: impl Into<String>,
        remediation: impl Into<String>,
    ) -> AdapterFailure {
        AdapterFailure::semantic(
            AdapterFailureSemanticParams::new(code, XP3_DETECTOR_ADAPTER_ID, support_boundary)
                .engine("kiri_kiri_xp3")
                .detected_variant(variant)
                .asset_ref(XP3_ARCHIVE_PATH)
                .required_capability(required_capability)
                .remediation(remediation),
        )
    }

    fn invalid_input_failure(variant: Xp3FixtureVariant) -> AdapterFailure {
        match variant {
            Xp3FixtureVariant::Unknown => Self::unsupported_failure(
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                Self::detected_variant(variant),
                "XP3 bytes or names were present without a profiled synthetic KAIFUU-095 variant",
                "add a profiled synthetic fixture or private-local aggregate evidence before claiming support",
            ),
            Xp3FixtureVariant::NotXp3 => Self::unsupported_failure(
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                Self::detected_variant(variant),
                "XP3 profile fixtures require a data.xp3 file with a synthetic XP3 header",
                "run detection with a KAIFUU-095 XP3 fixture directory or select another adapter",
            ),
            Xp3FixtureVariant::Plain
            | Xp3FixtureVariant::Encrypted
            | Xp3FixtureVariant::HelperRequired
            | Xp3FixtureVariant::Compressed => Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::ContainerAccess,
                Self::detected_variant(variant),
                XP3_SUPPORT_BOUNDARY,
                "use detect, profile, or asset-inventory output only",
            ),
        }
    }

    fn diagnostic_error(failure: AdapterFailure) -> Box<dyn std::error::Error> {
        match kaifuu_core::stable_json(&failure) {
            Ok(serialized) => serialized.into(),
            Err(error) => error,
        }
    }

    fn parser_boundary_failure(variant: Xp3FixtureVariant) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::MissingContainerCapability,
            Capability::ContainerAccess,
            Self::detected_variant(variant),
            "XP3 archive entry parsing is outside KAIFUU-095 profile fixtures",
            "use identify or asset-inventory output only; do not request extract or patch for this detector profile",
        )
    }

    fn crypto_boundary_failure(variant: Xp3FixtureVariant) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::MissingCryptoCapability,
            Capability::CryptoAccess,
            Self::detected_variant(variant),
            "encrypted XP3 inventory requires crypto support and resolved key material; no decryption is implemented",
            "add an explicit crypto-capable XP3 adapter before inventory or extraction",
        )
    }

    fn helper_required_failure(variant: Xp3FixtureVariant) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::HelperRequired,
            Capability::KeyProfile,
            Self::detected_variant(variant),
            "this XP3 profile requires an external helper before archive table access",
            "run an approved helper or provide a future helper result before inventory or extraction",
        )
    }

    fn inventory_reader_error(error: PlainXp3InventoryError) -> Box<dyn std::error::Error> {
        let failure = match error {
            PlainXp3InventoryError::UnsupportedEncrypted => {
                Self::crypto_boundary_failure(Xp3FixtureVariant::Encrypted)
            }
            PlainXp3InventoryError::UnsupportedIndexEncoding(_) => Self::unsupported_failure(
                SemanticErrorCode::MissingCodecCapability,
                Capability::CodecAccess,
                Self::detected_variant(Xp3FixtureVariant::Compressed),
                format!("plain XP3 inventory supports only uncompressed index tables: {error}"),
                "use a fixture with an uncompressed XP3 index table or add codec support",
            ),
            PlainXp3InventoryError::MalformedHeader
            | PlainXp3InventoryError::Truncated(_)
            | PlainXp3InventoryError::InvalidOffset(_)
            | PlainXp3InventoryError::InvalidChunk(_)
            | PlainXp3InventoryError::InvalidUtf16Path
            | PlainXp3InventoryError::DuplicateEntry(_) => Self::unsupported_failure(
                SemanticErrorCode::MissingContainerCapability,
                Capability::ContainerAccess,
                Self::detected_variant(Xp3FixtureVariant::Plain),
                format!("plain XP3 inventory could not parse the fixture file table: {error}"),
                "use a well-formed plain XP3 fixture with unique file entries",
            ),
        };
        Self::diagnostic_error(failure)
    }

    fn unsupported_patch_result(
        &self,
        patch_export_id: String,
        variant: Xp3FixtureVariant,
    ) -> PatchResult {
        let detected_variant = Self::detected_variant(variant).to_string();
        let mut failures = vec![Self::parser_boundary_failure(variant)];
        if variant == Xp3FixtureVariant::Encrypted {
            failures.push(Self::crypto_boundary_failure(variant));
        }
        if variant == Xp3FixtureVariant::HelperRequired {
            failures.push(Self::helper_required_failure(variant));
        }
        if variant == Xp3FixtureVariant::Compressed {
            failures.push(Self::unsupported_failure(
                SemanticErrorCode::MissingCodecCapability,
                Capability::CodecAccess,
                detected_variant.clone(),
                "compressed XP3 payload handling is outside KAIFUU-095 profile fixtures",
                "provide future adapter decompression support before extraction or patching",
            ));
        }
        failures.push(Self::unsupported_failure(
            SemanticErrorCode::MissingPatchBackCapability,
            Capability::PatchBack,
            detected_variant,
            "XP3 patch-back/repack support is not implemented by the detector profile",
            "add an explicit patch-back adapter before writing patched XP3 output",
        ));
        PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("xp3-patch", 95),
            patch_export_id,
            status: OperationStatus::Failed,
            output_hash: content_hash(XP3_SUPPORT_BOUNDARY),
            failures,
        }
    }
}

impl Xp3FixtureState {
    fn engine_evidence(&self) -> Vec<String> {
        if self.archive_exists {
            vec![XP3_ARCHIVE_PATH.to_string()]
        } else {
            vec![]
        }
    }

    fn asset_profiles(&self) -> Vec<AssetProfile> {
        if !self.archive_exists {
            return vec![];
        }
        vec![AssetProfile {
            asset_id: "kirikiri-xp3-archive".to_string(),
            path: XP3_ARCHIVE_PATH.to_string(),
            asset_kind: AssetKind::Archive,
            text_surfaces: vec![TextSurface::Dialogue, TextSurface::Narration],
            source_hash: self.archive_hash.clone(),
            patching: CapabilityReport::unsupported(
                Capability::Patching,
                "XP3 detector profile does not decrypt, extract payloads, decompress, repack, or patch archives",
            ),
        }]
    }

    fn inventory_assets(&self, entries: &[PlainXp3Entry]) -> Vec<AssetInventoryAsset> {
        if !self.archive_exists {
            return vec![];
        }
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "signatureMatched".to_string(),
            self.archive_signature.to_string(),
        );
        metadata.insert(
            "detectedVariant".to_string(),
            Xp3ProfileDetectorAdapter::detected_variant(self.variant).to_string(),
        );
        metadata.insert("entryCount".to_string(), entries.len().to_string());
        metadata.insert(
            "profileId".to_string(),
            Xp3ProfileDetectorAdapter::profile_id(self.variant).to_string(),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            "plain XP3 index table parsed for inventory only; payload extraction and patch-back are unsupported".to_string(),
        );
        let mut assets = vec![AssetInventoryAsset {
            asset_id: "kirikiri-xp3-archive".to_string(),
            asset_key: XP3_ARCHIVE_PATH.to_string(),
            asset_kind: AssetInventoryAssetKind::Archive,
            path: Some(XP3_ARCHIVE_PATH.to_string()),
            source_hash: self.archive_hash.clone(),
            metadata,
        }];

        assets.extend(entries.iter().enumerate().map(|(index, entry)| {
            let mut metadata = BTreeMap::new();
            metadata.insert("archivePath".to_string(), XP3_ARCHIVE_PATH.to_string());
            metadata.insert("archiveSize".to_string(), entry.archive_size.to_string());
            metadata.insert("compressed".to_string(), entry.compressed.to_string());
            metadata.insert("originalSize".to_string(), entry.original_size.to_string());
            metadata.insert(
                "profileId".to_string(),
                Xp3ProfileDetectorAdapter::profile_id(self.variant).to_string(),
            );
            metadata.insert("segmentCount".to_string(), entry.segment_count.to_string());
            if let Some(stored_adler32) = &entry.stored_adler32 {
                metadata.insert("storedAdler32".to_string(), stored_adler32.clone());
            }
            AssetInventoryAsset {
                asset_id: format!("kirikiri-xp3-entry-{index:04}"),
                asset_key: entry.path.clone(),
                asset_kind: xp3_inventory_asset_kind(&entry.path),
                path: Some(entry.path.clone()),
                source_hash: entry.payload_hash.clone(),
                metadata,
            }
        }));
        assets
    }

    fn archive_parameters(&self) -> Vec<ArchiveParameter> {
        let mut parameters = vec![
            ArchiveParameter {
                parameter_id: "xp3-archive-format".to_string(),
                name: "archiveFormat".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                value: "xp3".to_string(),
                source: Some(ArchiveParameterSource::Detected),
            },
            ArchiveParameter {
                parameter_id: "xp3-profile-variant".to_string(),
                name: "variant".to_string(),
                kind: ArchiveParameterKind::Variant,
                value: Xp3ProfileDetectorAdapter::archive_parameter_variant(self.variant)
                    .to_string(),
                source: Some(ArchiveParameterSource::Detected),
            },
        ];
        match self.variant {
            Xp3FixtureVariant::Encrypted => parameters.push(ArchiveParameter {
                parameter_id: "xp3-cipher-scheme".to_string(),
                name: "cipherScheme".to_string(),
                kind: ArchiveParameterKind::CipherScheme,
                value: "fixture-key-profile-marker".to_string(),
                source: Some(ArchiveParameterSource::Detected),
            }),
            Xp3FixtureVariant::HelperRequired => parameters.push(ArchiveParameter {
                parameter_id: "xp3-helper-requirement".to_string(),
                name: "helperRequirement".to_string(),
                kind: ArchiveParameterKind::Variant,
                value: "fixture-helper-required".to_string(),
                source: Some(ArchiveParameterSource::Detected),
            }),
            Xp3FixtureVariant::Compressed => parameters.push(ArchiveParameter {
                parameter_id: "xp3-compression".to_string(),
                name: "compression".to_string(),
                kind: ArchiveParameterKind::Compression,
                value: "compressed".to_string(),
                source: Some(ArchiveParameterSource::Detected),
            }),
            Xp3FixtureVariant::Plain | Xp3FixtureVariant::Unknown | Xp3FixtureVariant::NotXp3 => {}
        }
        parameters
    }

    fn key_requirements(&self) -> KaifuuResult<Vec<KeyRequirement>> {
        if !matches!(
            self.variant,
            Xp3FixtureVariant::Encrypted | Xp3FixtureVariant::HelperRequired
        ) {
            return Ok(vec![]);
        }
        Ok(vec![KeyRequirement {
            requirement_id: "kirikiri-xp3-key-profile".to_string(),
            secret_ref: SecretRef::new(
                "local-secret:fixture/kirikiri/xp3-archive-password".to_string(),
            )?,
            kind: KeyMaterialKind::ArchivePassword,
            bytes: None,
            validation: None,
        }])
    }

    fn layered_access_profile(&self) -> LayeredAccessProfile {
        let (crypto, key_material_status, helper_status, key_requirement_refs) = match self.variant
        {
            Xp3FixtureVariant::Encrypted => (
                CryptoTransform::KeyProfile,
                LayeredAccessKeyMaterialStatus::Missing,
                LayeredAccessHelperStatus::Unavailable,
                vec!["kirikiri-xp3-key-profile".to_string()],
            ),
            Xp3FixtureVariant::HelperRequired => (
                CryptoTransform::HelperGated,
                LayeredAccessKeyMaterialStatus::HelperGated,
                LayeredAccessHelperStatus::Unavailable,
                vec!["kirikiri-xp3-key-profile".to_string()],
            ),
            Xp3FixtureVariant::Plain | Xp3FixtureVariant::Compressed => (
                CryptoTransform::NullKey,
                LayeredAccessKeyMaterialStatus::NotRequired,
                LayeredAccessHelperStatus::NotRequired,
                vec![],
            ),
            Xp3FixtureVariant::Unknown | Xp3FixtureVariant::NotXp3 => (
                CryptoTransform::Unknown,
                LayeredAccessKeyMaterialStatus::Missing,
                LayeredAccessHelperStatus::Unavailable,
                vec![],
            ),
        };
        let mut profile = LayeredAccessProfile {
            schema_version: "0.1.0".to_string(),
            surfaces: vec![LayeredTextSurfaceAccess {
                surface_id: "kirikiri-xp3-archive#dialogue".to_string(),
                asset_id: "kirikiri-xp3-archive".to_string(),
                path: XP3_ARCHIVE_PATH.to_string(),
                text_surface: TextSurface::Dialogue,
                surface_transform: SurfaceTransform::ArchiveEntry,
                surface_selector: "aggregate-only:synthetic-xp3-archive".to_string(),
                container: ContainerTransform::Xp3,
                crypto,
                codec: CodecTransform::Unknown,
                patch_back: PatchBackTransform::Unsupported,
                key_material_status,
                helper_status,
                key_requirement_refs,
                notes: vec![
                    "detector-only layered access record; plain inventory may list XP3 entries, but script decoding, extraction, and patch-back are not claimed".to_string(),
                ],
            }],
        };
        profile.normalize();
        profile
    }

    fn detection_requirements(&self) -> Vec<ProfileRequirement> {
        let mut requirements = vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: XP3_ARCHIVE_PATH.to_string(),
                status: if self.archive_signature {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::Missing
                },
                description: "synthetic XP3 archive header fixture".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "xp3-parser".to_string(),
                status: RequirementStatus::Unsupported,
                description: "XP3 archive parser/rebuilder boundary is unsupported for KAIFUU-095"
                    .to_string(),
                placeholder: None,
                secret: false,
            },
        ];
        if matches!(
            self.variant,
            Xp3FixtureVariant::Encrypted | Xp3FixtureVariant::HelperRequired
        ) {
            requirements.push(ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "kirikiri-xp3-key-profile".to_string(),
                status: RequirementStatus::Missing,
                description: if self.variant == Xp3FixtureVariant::HelperRequired {
                    "XP3 helper-required payload is detected, but helper execution is outside the detector profile"
                } else {
                    "encrypted XP3 payload is detected, but key resolution is outside the detector profile"
                }
                .to_string(),
                placeholder: Some("KAIFUU_KIRIKIRI_XP3_KEY_PROFILE".to_string()),
                secret: true,
            });
        }
        if self.variant == Xp3FixtureVariant::Compressed {
            requirements.push(ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "xp3-decompressor".to_string(),
                status: RequirementStatus::Unsupported,
                description: "compressed XP3 payload handling is outside the detector profile"
                    .to_string(),
                placeholder: None,
                secret: false,
            });
        }
        if self.variant == Xp3FixtureVariant::Unknown {
            requirements.push(ProfileRequirement {
                category: RequirementCategory::File,
                key: "xp3-synthetic-profile-marker".to_string(),
                status: RequirementStatus::Unsupported,
                description: "XP3 header was present without a profiled synthetic fixture variant"
                    .to_string(),
                placeholder: None,
                secret: false,
            });
        }
        requirements
    }

    fn profile_requirements(&self) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: XP3_ARCHIVE_PATH.to_string(),
                status: RequirementStatus::Satisfied,
                description: "synthetic XP3 detector evidence status".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "xp3-parser".to_string(),
                status: RequirementStatus::NotRequired,
                description: "parser/runtime helpers are outside the detector-only profile"
                    .to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "kirikiri-xp3-key-profile".to_string(),
                status: RequirementStatus::NotRequired,
                description: if matches!(
                    self.variant,
                    Xp3FixtureVariant::Encrypted | Xp3FixtureVariant::HelperRequired
                ) {
                    "encrypted XP3 profile metadata names the key requirement, but detector-only profiles do not resolve local key material"
                } else {
                    "key material is not required for this synthetic XP3 profile"
                }
                .to_string(),
                placeholder: None,
                secret: true,
            },
        ]
    }

    fn metadata(&self) -> BTreeMap<String, String> {
        let mut metadata = BTreeMap::new();
        metadata.insert("fixtureOnly".to_string(), "true".to_string());
        metadata.insert(
            "profileDiagnostics.encryptedPayload".to_string(),
            (self.variant == Xp3FixtureVariant::Encrypted).to_string(),
        );
        if self.variant == Xp3FixtureVariant::HelperRequired {
            metadata.insert(
                "profileDiagnostics.helperRequired".to_string(),
                "true".to_string(),
            );
        }
        metadata.insert(
            "profileDiagnostics.compressedPayload".to_string(),
            (self.variant == Xp3FixtureVariant::Compressed).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.unknownVariant".to_string(),
            (self.variant == Xp3FixtureVariant::Unknown).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.unsupportedParserBoundary".to_string(),
            "true".to_string(),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            XP3_SUPPORT_BOUNDARY.to_string(),
        );
        metadata
    }
}

impl EngineAdapter for Xp3ProfileDetectorAdapter {
    fn id(&self) -> &'static str {
        XP3_DETECTOR_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu KiriKiri XP3 profile fixture adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let identify = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Detection, Capability::ProfileGeneration],
            supported_surfaces: vec![SurfaceTransform::ArchiveEntry],
            supported_containers: vec![ContainerTransform::Xp3],
            supported_crypto: vec![CryptoTransform::NullKey, CryptoTransform::KeyProfile],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some("identify/profile generation reads only synthetic XP3 headers, markers, and source hashes".to_string()),
        };
        let inventory = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::AssetListing, Capability::AssetInventory],
            supported_surfaces: vec![SurfaceTransform::ArchiveEntry],
            supported_containers: vec![ContainerTransform::Xp3],
            supported_crypto: vec![CryptoTransform::NullKey, CryptoTransform::KeyProfile],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some("inventory parses synthetic plain XP3 index metadata and reports archive member rows; payload extraction, decompression, decryption, and patch-back are unsupported".to_string()),
        };
        let unsupported = |required_capabilities| LayeredAccessOperationContract {
            status: CapabilityStatus::Unsupported,
            required_capabilities,
            supported_surfaces: vec![],
            supported_containers: vec![],
            supported_crypto: vec![],
            supported_codecs: vec![],
            supported_patch_back: vec![],
            support_boundary: Some(XP3_SUPPORT_BOUNDARY.to_string()),
        };
        AdapterCapabilities::new(
            XP3_DETECTOR_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::AssetListing),
                CapabilityReport::supported(Capability::AssetInventory),
                CapabilityReport::unsupported(
                    Capability::Extraction,
                    "KAIFUU-095 is an XP3 detector/profile fixture only",
                ),
                CapabilityReport::unsupported(
                    Capability::Patching,
                    "KAIFUU-095 does not patch or rebuild XP3 archives",
                ),
                CapabilityReport::unsupported(
                    Capability::ContainerAccess,
                    "XP3 container access is limited to synthetic plain-index inventory; extraction and rebuild are outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::CryptoAccess,
                    "encrypted XP3 payload handling is outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::CodecAccess,
                    "compressed XP3 payload handling and script decoding are outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::PatchBack,
                    "XP3 patch-back/repack support is outside the detector profile",
                ),
                CapabilityReport::requires_user_input(
                    Capability::KeyProfile,
                    "encrypted XP3 diagnostics name the key requirement, but no key support is claimed",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime support belongs to future Utsushi/KiriKiri work, not this detector fixture",
                ),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "encrypted payloads are identified only and are never decrypted by this profile",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "no XP3 text surfaces are patched by this detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages do not apply to detector-only XP3 profiles",
                ),
                CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    "no non-text extraction or OCR is performed for XP3 detector fixtures",
                ),
            ],
        )
        .with_access_contract(LayeredAccessCapabilityContract {
            identify,
            inventory,
            extract: unsupported(vec![Capability::Extraction]),
            patch: unsupported(vec![Capability::Patching, Capability::PatchBack]),
        })
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        let state = Self::inspect(request.game_dir);
        let detected = Self::is_detected(state.variant);
        let diagnostic_only = !detected && state.variant == Xp3FixtureVariant::Unknown;
        let mut result = DetectionResult {
            adapter_id: XP3_DETECTOR_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| "kiri_kiri_xp3".to_string()),
            engine_version: None,
            detected_variant: (detected || diagnostic_only)
                .then(|| Self::detected_variant(state.variant).to_string()),
            evidence: vec![DetectionEvidence {
                path: XP3_ARCHIVE_PATH.to_string(),
                kind: "synthetic_xp3_archive_signature".to_string(),
                status: evidence_status(state.archive_exists, state.archive_signature),
                detail: signature_detail(
                    state.archive_exists,
                    state.archive_signature,
                    "XP3 synthetic archive signature",
                ),
            }],
            requirements: if detected || diagnostic_only {
                state.detection_requirements()
            } else {
                vec![]
            },
            capabilities: self.capabilities().reports,
        };
        result.normalize();
        Ok(result)
    }

    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        self.profile_from_state(Self::inspect(request.game_dir))
    }

    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        let state = Self::inspect(request.game_dir);
        if !Self::can_inventory(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        Ok(AssetList {
            adapter_id: XP3_DETECTOR_ADAPTER_ID.to_string(),
            assets: state.asset_profiles(),
        })
    }

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        self.inventory_from_state(Self::inspect(request.game_dir))
    }

    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        let state = Self::inspect(request.game_dir);
        if state.variant == Xp3FixtureVariant::Encrypted {
            return Err(Self::diagnostic_error(Self::crypto_boundary_failure(
                state.variant,
            )));
        }
        if state.variant == Xp3FixtureVariant::HelperRequired {
            return Err(Self::diagnostic_error(Self::helper_required_failure(
                state.variant,
            )));
        }
        Err(Self::diagnostic_error(Self::parser_boundary_failure(
            state.variant,
        )))
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        Ok(self
            .unsupported_patch_result(request.patch_export.patch_export_id.clone(), state.variant))
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        Ok(self
            .unsupported_patch_result(request.patch_export.patch_export_id.clone(), state.variant))
    }

    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        let state = Self::inspect(request.game_dir);
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("xp3-verify", 95),
            status: OperationStatus::Failed,
            output_hash: content_hash(XP3_SUPPORT_BOUNDARY),
            failures: vec![Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::RuntimeVm,
                Self::detected_variant(state.variant),
                "runtime/parser verification is outside the XP3 detector profile",
                "use detect, profile, or asset-inventory only",
            )],
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SiglusFixtureVariant {
    CompleteSyntheticPair,
    MissingGameexeDat,
    MissingScenePck,
    UnknownNamedPair,
    NotSiglus,
}

#[derive(Debug, Clone)]
struct SiglusFixtureState {
    scene_exists: bool,
    gameexe_exists: bool,
    scene_signature: bool,
    gameexe_signature: bool,
    scene_hash: Option<String>,
    gameexe_hash: Option<String>,
    variant: SiglusFixtureVariant,
}

impl SiglusProfileDetectorAdapter {
    fn scene_path(game_dir: &Path) -> std::path::PathBuf {
        game_dir.join(SIGLUS_SCENE_PATH)
    }

    fn gameexe_path(game_dir: &Path) -> std::path::PathBuf {
        game_dir.join(SIGLUS_GAMEEXE_PATH)
    }

    fn inspect(game_dir: &Path) -> SiglusFixtureState {
        let scene_path = Self::scene_path(game_dir);
        let gameexe_path = Self::gameexe_path(game_dir);
        let scene_exists = scene_path.is_file();
        let gameexe_exists = gameexe_path.is_file();
        let scene_signature = file_starts_with(&scene_path, SIGLUS_SCENE_MAGIC);
        let gameexe_signature = file_starts_with(&gameexe_path, SIGLUS_GAMEEXE_MAGIC);
        let variant = match (
            scene_signature,
            gameexe_signature,
            scene_exists,
            gameexe_exists,
        ) {
            (true, true, _, _) => SiglusFixtureVariant::CompleteSyntheticPair,
            (true, false, _, _) => SiglusFixtureVariant::MissingGameexeDat,
            (false, true, _, _) => SiglusFixtureVariant::MissingScenePck,
            (false, false, true, _) | (false, false, _, true) => {
                SiglusFixtureVariant::UnknownNamedPair
            }
            _ => SiglusFixtureVariant::NotSiglus,
        };
        SiglusFixtureState {
            scene_exists,
            gameexe_exists,
            scene_signature,
            gameexe_signature,
            scene_hash: scene_exists
                .then(|| sha256_file_ref(&scene_path).ok())
                .flatten(),
            gameexe_hash: gameexe_exists
                .then(|| sha256_file_ref(&gameexe_path).ok())
                .flatten(),
            variant,
        }
    }

    fn detected_variant(variant: SiglusFixtureVariant) -> &'static str {
        match variant {
            SiglusFixtureVariant::CompleteSyntheticPair => "scene-pck-gameexe-dat-synthetic",
            SiglusFixtureVariant::MissingGameexeDat => "scene-pck-missing-gameexe-dat",
            SiglusFixtureVariant::MissingScenePck => "gameexe-dat-missing-scene-pck",
            SiglusFixtureVariant::UnknownNamedPair => "unknown-siglus-named-files",
            SiglusFixtureVariant::NotSiglus => "not-siglus",
        }
    }

    fn is_detected(variant: SiglusFixtureVariant) -> bool {
        matches!(variant, SiglusFixtureVariant::CompleteSyntheticPair)
    }

    fn can_inventory(variant: SiglusFixtureVariant) -> bool {
        Self::is_detected(variant)
    }

    fn profile_from_state(&self, state: SiglusFixtureState) -> KaifuuResult<GameProfile> {
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: SIGLUS_PROFILE_ID.to_string(),
            game_id: SIGLUS_GAME_ID.to_string(),
            title: "Siglus fixture".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: SIGLUS_DETECTOR_ADAPTER_ID.to_string(),
                engine_family: "siglus".to_string(),
                engine_version: None,
                detected_variant: Self::detected_variant(state.variant).to_string(),
            },
            source_fingerprint: Some(SourceFingerprint {
                game_root_hash: None,
                engine_evidence: state.engine_evidence(),
            }),
            key_requirements: vec![],
            archive_parameters: vec![ArchiveParameter {
                parameter_id: "scene-archive".to_string(),
                name: "sceneArchive".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                value: SIGLUS_SCENE_PATH.to_string(),
                source: Some(ArchiveParameterSource::Detected),
            }],
            helper_evidence: None,
            assets: state.asset_profiles(),
            layered_access: Some(state.layered_access_profile()),
            capabilities: self.capabilities().reports,
            requirements: state.profile_requirements(),
            metadata: state.metadata(),
        };
        profile.normalize();
        Ok(profile)
    }

    fn inventory_from_state(
        &self,
        state: SiglusFixtureState,
    ) -> KaifuuResult<AssetInventoryManifest> {
        if !Self::can_inventory(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("siglus-inventory", 91),
            adapter_id: SIGLUS_DETECTOR_ADAPTER_ID.to_string(),
            source_locale: "ja-JP".to_string(),
            assets: state.inventory_assets(),
            surfaces: vec![],
            capabilities: self.capabilities().reports,
            warnings: vec![],
            metadata: state.metadata(),
        };
        manifest.normalize();
        Ok(manifest)
    }

    fn unsupported_failure(
        code: SemanticErrorCode,
        required_capability: Capability,
        variant: impl Into<String>,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
        remediation: impl Into<String>,
    ) -> AdapterFailure {
        AdapterFailure::semantic(
            AdapterFailureSemanticParams::new(code, SIGLUS_DETECTOR_ADAPTER_ID, support_boundary)
                .engine("siglus")
                .detected_variant(variant)
                .asset_ref(asset_ref)
                .required_capability(required_capability)
                .remediation(remediation),
        )
    }

    fn parser_boundary_failure(variant: impl Into<String>) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::UnsupportedLayeredTransform,
            Capability::CodecAccess,
            variant,
            SIGLUS_SCENE_PATH,
            "Siglus Scene.pck parsing/decompilation is outside KAIFUU-091 detector fixtures",
            "use identify or asset-inventory output only; do not request extract or patch for this detector profile",
        )
    }

    fn invalid_input_failure(variant: SiglusFixtureVariant) -> AdapterFailure {
        let (code, required_capability, asset_ref, support_boundary, remediation) = match variant {
            SiglusFixtureVariant::MissingGameexeDat => (
                SemanticErrorCode::MissingContainerCapability,
                Capability::AssetListing,
                SIGLUS_GAMEEXE_PATH,
                "Siglus detector profile requires both synthetic Scene.pck and Gameexe.dat signatures before profiling or inventory",
                "provide the complete synthetic Scene.pck/Gameexe.dat signature pair or treat this input as a diagnostic-only partial fixture",
            ),
            SiglusFixtureVariant::MissingScenePck => (
                SemanticErrorCode::MissingContainerCapability,
                Capability::AssetListing,
                SIGLUS_SCENE_PATH,
                "Siglus detector profile requires both synthetic Scene.pck and Gameexe.dat signatures before profiling or inventory",
                "provide the complete synthetic Scene.pck/Gameexe.dat signature pair or treat this input as a diagnostic-only partial fixture",
            ),
            SiglusFixtureVariant::UnknownNamedPair => (
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                "Scene.pck/Gameexe.dat",
                "Scene.pck/Gameexe.dat names were present without recognized synthetic KAIFUU-091 Siglus signatures",
                "use the complete synthetic signature pair fixture or add an explicit adapter for this Siglus variant before profiling or inventory",
            ),
            SiglusFixtureVariant::NotSiglus => (
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                "Scene.pck/Gameexe.dat",
                "Siglus detector profile requires recognized synthetic Scene.pck/Gameexe.dat fixture evidence",
                "run detection with a complete synthetic Siglus fixture or select another adapter",
            ),
            SiglusFixtureVariant::CompleteSyntheticPair => (
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::CodecAccess,
                SIGLUS_SCENE_PATH,
                SIGLUS_SUPPORT_BOUNDARY,
                "use identify or asset-inventory output only",
            ),
        };
        Self::unsupported_failure(
            code,
            required_capability,
            Self::detected_variant(variant),
            asset_ref,
            support_boundary,
            remediation,
        )
    }

    fn diagnostic_error(failure: AdapterFailure) -> Box<dyn std::error::Error> {
        match kaifuu_core::stable_json(&failure) {
            Ok(serialized) => serialized.into(),
            Err(error) => error,
        }
    }

    fn unsupported_patch_result(
        &self,
        patch_export_id: String,
        variant: SiglusFixtureVariant,
    ) -> PatchResult {
        let detected_variant = Self::detected_variant(variant).to_string();
        PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("siglus-patch", 91),
            patch_export_id,
            status: OperationStatus::Failed,
            output_hash: content_hash(SIGLUS_SUPPORT_BOUNDARY),
            failures: vec![
                Self::unsupported_failure(
                    SemanticErrorCode::MissingContainerCapability,
                    Capability::ContainerAccess,
                    detected_variant.clone(),
                    SIGLUS_SCENE_PATH,
                    "Siglus Scene.pck archive container access is not implemented by the detector profile",
                    "use identify or asset-inventory output only",
                ),
                Self::unsupported_failure(
                    SemanticErrorCode::MissingCryptoCapability,
                    Capability::CryptoAccess,
                    detected_variant.clone(),
                    SIGLUS_SCENE_PATH,
                    "Siglus encrypted payload handling is not implemented by the detector profile",
                    "provide future adapter crypto support before extraction or patching",
                ),
                Self::parser_boundary_failure(detected_variant.clone()),
                Self::unsupported_failure(
                    SemanticErrorCode::MissingPatchBackCapability,
                    Capability::PatchBack,
                    detected_variant,
                    SIGLUS_SCENE_PATH,
                    "Siglus patch-back/repack support is not implemented by the detector profile",
                    "add an explicit patch-back adapter before writing patched Scene.pck output",
                ),
            ],
        }
    }
}

impl SiglusFixtureState {
    fn engine_evidence(&self) -> Vec<String> {
        let mut evidence = Vec::new();
        if self.scene_exists {
            evidence.push(SIGLUS_SCENE_PATH.to_string());
        }
        if self.gameexe_exists {
            evidence.push(SIGLUS_GAMEEXE_PATH.to_string());
        }
        evidence
    }

    fn asset_profiles(&self) -> Vec<AssetProfile> {
        let mut assets = Vec::new();
        if self.scene_exists {
            assets.push(AssetProfile {
                asset_id: "siglus-scene-pck".to_string(),
                path: SIGLUS_SCENE_PATH.to_string(),
                asset_kind: AssetKind::Archive,
                text_surfaces: vec![TextSurface::Dialogue, TextSurface::Narration],
                source_hash: self.scene_hash.clone(),
                patching: CapabilityReport::unsupported(
                    Capability::Patching,
                    "Siglus detector profile does not parse, decrypt, repack, or patch Scene.pck",
                ),
            });
        }
        if self.gameexe_exists {
            assets.push(AssetProfile {
                asset_id: "siglus-gameexe-dat".to_string(),
                path: SIGLUS_GAMEEXE_PATH.to_string(),
                asset_kind: AssetKind::Metadata,
                text_surfaces: vec![TextSurface::MetadataText],
                source_hash: self.gameexe_hash.clone(),
                patching: CapabilityReport::unsupported(
                    Capability::Patching,
                    "Siglus detector profile does not patch Gameexe.dat metadata",
                ),
            });
        }
        assets
    }

    fn inventory_assets(&self) -> Vec<AssetInventoryAsset> {
        let mut assets = Vec::new();
        if self.scene_exists {
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "signatureMatched".to_string(),
                self.scene_signature.to_string(),
            );
            metadata.insert(
                "supportBoundary".to_string(),
                "container identified only; archive entries are not parsed".to_string(),
            );
            assets.push(AssetInventoryAsset {
                asset_id: "siglus-scene-pck".to_string(),
                asset_key: SIGLUS_SCENE_PATH.to_string(),
                asset_kind: AssetInventoryAssetKind::Archive,
                path: Some(SIGLUS_SCENE_PATH.to_string()),
                source_hash: self.scene_hash.clone(),
                metadata,
            });
        }
        if self.gameexe_exists {
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "signatureMatched".to_string(),
                self.gameexe_signature.to_string(),
            );
            metadata.insert(
                "supportBoundary".to_string(),
                "metadata identified only; secondary-key discovery is not implemented".to_string(),
            );
            assets.push(AssetInventoryAsset {
                asset_id: "siglus-gameexe-dat".to_string(),
                asset_key: SIGLUS_GAMEEXE_PATH.to_string(),
                asset_kind: AssetInventoryAssetKind::Metadata,
                path: Some(SIGLUS_GAMEEXE_PATH.to_string()),
                source_hash: self.gameexe_hash.clone(),
                metadata,
            });
        }
        assets
    }

    fn layered_access_profile(&self) -> LayeredAccessProfile {
        let mut surfaces = Vec::new();
        if self.scene_exists {
            surfaces.push(LayeredTextSurfaceAccess {
                surface_id: "siglus-scene-pck#dialogue".to_string(),
                asset_id: "siglus-scene-pck".to_string(),
                path: SIGLUS_SCENE_PATH.to_string(),
                text_surface: TextSurface::Dialogue,
                surface_transform: SurfaceTransform::ArchiveEntry,
                surface_selector: "aggregate-only:synthetic-scene-package".to_string(),
                container: ContainerTransform::SiglusPck,
                crypto: CryptoTransform::KeyProfile,
                codec: CodecTransform::Unknown,
                patch_back: PatchBackTransform::Unsupported,
                key_material_status: LayeredAccessKeyMaterialStatus::Missing,
                helper_status: LayeredAccessHelperStatus::Unavailable,
                key_requirement_refs: vec![],
                notes: vec![
                    "detector-only layered access record; no parser, normalized script text, or archive entry listing is claimed".to_string(),
                ],
            });
        }
        if self.gameexe_exists {
            surfaces.push(LayeredTextSurfaceAccess {
                surface_id: "siglus-gameexe-dat#metadata".to_string(),
                asset_id: "siglus-gameexe-dat".to_string(),
                path: SIGLUS_GAMEEXE_PATH.to_string(),
                text_surface: TextSurface::MetadataText,
                surface_transform: SurfaceTransform::BinaryOffset,
                surface_selector: "aggregate-only:synthetic-gameexe-metadata".to_string(),
                container: ContainerTransform::LooseFile,
                crypto: CryptoTransform::Unknown,
                codec: CodecTransform::Unknown,
                patch_back: PatchBackTransform::Unsupported,
                key_material_status: LayeredAccessKeyMaterialStatus::Missing,
                helper_status: LayeredAccessHelperStatus::Unavailable,
                key_requirement_refs: vec![],
                notes: vec![
                    "detector-only metadata record; secondary-key derivation is outside this profile".to_string(),
                ],
            });
        }
        let mut profile = LayeredAccessProfile {
            schema_version: "0.1.0".to_string(),
            surfaces,
        };
        profile.normalize();
        profile
    }

    fn detection_requirements(&self) -> Vec<ProfileRequirement> {
        let mut requirements = vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: SIGLUS_SCENE_PATH.to_string(),
                status: if self.scene_signature {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::Missing
                },
                description: "synthetic Siglus Scene.pck signature fixture".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::File,
                key: SIGLUS_GAMEEXE_PATH.to_string(),
                status: if self.gameexe_signature {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::Missing
                },
                description: "synthetic Siglus Gameexe.dat signature fixture".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "siglus-secondary-key".to_string(),
                status: RequirementStatus::Missing,
                description: "encrypted Siglus payload is detected, but key resolution is outside the detector profile".to_string(),
                placeholder: Some("KAIFUU_SIGLUS_SECONDARY_KEY_PROFILE".to_string()),
                secret: true,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "siglus-parser".to_string(),
                status: RequirementStatus::Unsupported,
                description: "Scene.pck parser/decompiler boundary is unsupported for KAIFUU-091".to_string(),
                placeholder: None,
                secret: false,
            },
        ];
        if self.variant == SiglusFixtureVariant::UnknownNamedPair {
            requirements.push(ProfileRequirement {
                category: RequirementCategory::File,
                key: "siglus-synthetic-signature".to_string(),
                status: RequirementStatus::Unsupported,
                description: "Scene.pck/Gameexe.dat names were present without recognized synthetic fixture signatures".to_string(),
                placeholder: None,
                secret: false,
            });
        }
        requirements
    }

    fn profile_requirements(&self) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: SIGLUS_SCENE_PATH.to_string(),
                status: if self.scene_exists {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::NotRequired
                },
                description: "synthetic Siglus Scene.pck detector evidence status".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::File,
                key: SIGLUS_GAMEEXE_PATH.to_string(),
                status: if self.gameexe_exists {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::NotRequired
                },
                description: "synthetic Siglus Gameexe.dat detector evidence status".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "siglus-secondary-key".to_string(),
                status: RequirementStatus::NotRequired,
                description: "key material is not accepted by the detector-only profile"
                    .to_string(),
                placeholder: None,
                secret: true,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "siglus-parser".to_string(),
                status: RequirementStatus::NotRequired,
                description: "parser/runtime helpers are outside the detector-only profile"
                    .to_string(),
                placeholder: None,
                secret: false,
            },
        ]
    }

    fn metadata(&self) -> BTreeMap<String, String> {
        let mut metadata = BTreeMap::new();
        metadata.insert("fixtureOnly".to_string(), "true".to_string());
        metadata.insert(
            "profileDiagnostics.missingPair".to_string(),
            (!self.scene_signature || !self.gameexe_signature).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.unknownVariant".to_string(),
            (self.variant == SiglusFixtureVariant::UnknownNamedPair).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.encryptedPayload".to_string(),
            self.scene_signature.to_string(),
        );
        metadata.insert(
            "profileDiagnostics.unsupportedParserBoundary".to_string(),
            "true".to_string(),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            SIGLUS_SUPPORT_BOUNDARY.to_string(),
        );
        metadata
    }
}

impl EngineAdapter for SiglusProfileDetectorAdapter {
    fn id(&self) -> &'static str {
        SIGLUS_DETECTOR_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu Siglus detector profile fixture adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let identify = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Detection, Capability::ProfileGeneration],
            supported_surfaces: vec![SurfaceTransform::Identity],
            supported_containers: vec![ContainerTransform::LooseFile, ContainerTransform::SiglusPck],
            supported_crypto: vec![CryptoTransform::Unknown],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some("identify/profile generation reads only synthetic file names, signatures, and source hashes".to_string()),
        };
        let inventory = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::AssetListing, Capability::AssetInventory],
            supported_surfaces: vec![SurfaceTransform::Identity, SurfaceTransform::ArchiveEntry, SurfaceTransform::BinaryOffset],
            supported_containers: vec![ContainerTransform::LooseFile, ContainerTransform::SiglusPck],
            supported_crypto: vec![CryptoTransform::Unknown],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some("inventory reports only top-level Scene.pck/Gameexe.dat assets and hashes; no archive entry parser is claimed".to_string()),
        };
        let unsupported = |required_capabilities| LayeredAccessOperationContract {
            status: CapabilityStatus::Unsupported,
            required_capabilities,
            supported_surfaces: vec![],
            supported_containers: vec![],
            supported_crypto: vec![],
            supported_codecs: vec![],
            supported_patch_back: vec![],
            support_boundary: Some(SIGLUS_SUPPORT_BOUNDARY.to_string()),
        };
        AdapterCapabilities::new(
            SIGLUS_DETECTOR_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::AssetListing),
                CapabilityReport::supported(Capability::AssetInventory),
                CapabilityReport::unsupported(
                    Capability::Extraction,
                    "KAIFUU-091 is a Siglus detector/profile fixture only",
                ),
                CapabilityReport::unsupported(
                    Capability::Patching,
                    "KAIFUU-091 does not patch or rebuild Siglus assets",
                ),
                CapabilityReport::unsupported(
                    Capability::ContainerAccess,
                    "Scene.pck archive parsing is outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::CryptoAccess,
                    "encrypted Siglus payload handling is outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::CodecAccess,
                    "Siglus script decode/decompile support is outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::PatchBack,
                    "Siglus patch-back/repack support is outside the detector profile",
                ),
                CapabilityReport::requires_user_input(
                    Capability::KeyProfile,
                    "encrypted payload diagnostics name the key requirement, but no key support is claimed",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime support belongs to future Utsushi/Siglus work, not this detector fixture",
                ),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "encrypted payloads are identified only and are never decrypted by this profile",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "no Siglus text surfaces are patched by this detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages do not apply to detector-only Siglus profiles",
                ),
                CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    "no non-text extraction or OCR is performed for Siglus detector fixtures",
                ),
            ],
        )
        .with_access_contract(LayeredAccessCapabilityContract {
            identify,
            inventory,
            extract: unsupported(vec![Capability::Extraction]),
            patch: unsupported(vec![Capability::Patching, Capability::PatchBack]),
        })
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        let state = Self::inspect(request.game_dir);
        let detected = Self::is_detected(state.variant);
        let diagnostic_only = !detected && state.variant != SiglusFixtureVariant::NotSiglus;
        let mut result = DetectionResult {
            adapter_id: SIGLUS_DETECTOR_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| "siglus".to_string()),
            engine_version: None,
            detected_variant: (detected || diagnostic_only)
                .then(|| Self::detected_variant(state.variant).to_string()),
            evidence: vec![
                DetectionEvidence {
                    path: SIGLUS_SCENE_PATH.to_string(),
                    kind: "synthetic_siglus_scene_pck_signature".to_string(),
                    status: evidence_status(state.scene_exists, state.scene_signature),
                    detail: signature_detail(
                        state.scene_exists,
                        state.scene_signature,
                        "Scene.pck synthetic signature",
                    ),
                },
                DetectionEvidence {
                    path: SIGLUS_GAMEEXE_PATH.to_string(),
                    kind: "synthetic_siglus_gameexe_dat_signature".to_string(),
                    status: evidence_status(state.gameexe_exists, state.gameexe_signature),
                    detail: signature_detail(
                        state.gameexe_exists,
                        state.gameexe_signature,
                        "Gameexe.dat synthetic signature",
                    ),
                },
            ],
            requirements: if detected || diagnostic_only {
                state.detection_requirements()
            } else {
                vec![]
            },
            capabilities: self.capabilities().reports,
        };
        result.normalize();
        Ok(result)
    }

    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        self.profile_from_state(Self::inspect(request.game_dir))
    }

    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        let state = Self::inspect(request.game_dir);
        if !Self::can_inventory(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        Ok(AssetList {
            adapter_id: SIGLUS_DETECTOR_ADAPTER_ID.to_string(),
            assets: state.asset_profiles(),
        })
    }

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        self.inventory_from_state(Self::inspect(request.game_dir))
    }

    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        let state = Self::inspect(request.game_dir);
        let variant = Self::detected_variant(state.variant);
        Err(Self::diagnostic_error(Self::parser_boundary_failure(
            variant,
        )))
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        Ok(self
            .unsupported_patch_result(request.patch_export.patch_export_id.clone(), state.variant))
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        Ok(self
            .unsupported_patch_result(request.patch_export.patch_export_id.clone(), state.variant))
    }

    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        let state = Self::inspect(request.game_dir);
        let variant = Self::detected_variant(state.variant).to_string();
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("siglus-verify", 91),
            status: OperationStatus::Failed,
            output_hash: content_hash(SIGLUS_SUPPORT_BOUNDARY),
            failures: vec![Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::RuntimeVm,
                variant,
                SIGLUS_SCENE_PATH,
                "runtime/parser verification is outside the Siglus detector profile",
                "use detect, profile, or asset-inventory only",
            )],
        })
    }
}

fn file_starts_with(path: &Path, expected: &[u8]) -> bool {
    fs::read(path)
        .map(|bytes| bytes.starts_with(expected))
        .unwrap_or(false)
}

fn xp3_inventory_asset_kind(path: &str) -> AssetInventoryAssetKind {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("ks" | "tjs" | "txt") => AssetInventoryAssetKind::Script,
        Some("png" | "jpg" | "jpeg" | "bmp" | "webp") => AssetInventoryAssetKind::Image,
        Some("ogg" | "wav" | "mp3" | "m4a") => AssetInventoryAssetKind::Audio,
        Some("ttf" | "otf") => AssetInventoryAssetKind::Font,
        _ => AssetInventoryAssetKind::Unknown,
    }
}

fn evidence_status(exists: bool, signature_matches: bool) -> EvidenceStatus {
    if signature_matches {
        EvidenceStatus::Matched
    } else if exists {
        EvidenceStatus::Invalid
    } else {
        EvidenceStatus::Missing
    }
}

fn signature_detail(exists: bool, signature_matches: bool, label: &str) -> String {
    match (exists, signature_matches) {
        (_, true) => format!("{label} matched"),
        (true, false) => {
            format!("{label} is present but does not match the synthetic fixture signature")
        }
        (false, false) => format!("{label} is missing"),
    }
}

pub fn registry() -> kaifuu_core::AdapterRegistry {
    let mut registry = kaifuu_core::AdapterRegistry::new();
    registry.register(FixtureAdapter);
    registry.register(Xp3ProfileDetectorAdapter);
    registry.register(SiglusProfileDetectorAdapter);
    registry
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaifuu_core::{
        GoldenAssertionStatus, GoldenByteEquivalenceMode, GoldenHarnessRequest, PatchExport,
        ProtectedSpanMapping, XP3_PLAIN_MAGIC, read_json, run_round_trip_golden, sha256_hash_bytes,
        stable_json,
    };
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::PathBuf;

    fn repo_root() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn public_fixture_dir() -> std::path::PathBuf {
        repo_root().join("fixtures/hello-game")
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kaifuu-engine-fixture-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn temp_game(name: &str) -> std::path::PathBuf {
        let dir = temp_dir(name);
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

    fn hello_fixture_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/hello-game")
    }

    fn expected_asset_inventory_path() -> PathBuf {
        hello_fixture_dir().join("asset-inventory.expected.json")
    }

    fn patch_export_for(extraction: &ExtractionResult) -> PatchExport {
        let target_text = "Hello, {player}.".to_string();
        PatchExport {
            patch_export_id: deterministic_id("patch", 1),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![kaifuu_core::PatchExportEntry {
                bridge_unit_id: extraction.bridge.units[0].bridge_unit_id.clone(),
                source_unit_key: extraction.bridge.units[0].source_unit_key.clone(),
                source_hash: extraction.bridge.units[0].source_hash.clone(),
                protected_span_mappings: protected_span_mappings_for_target(
                    &target_text,
                    &extraction.bridge.units[0].protected_spans,
                ),
                target_text,
            }],
        }
    }

    fn protected_span_mappings_for_target(
        target_text: &str,
        protected_spans: &[ProtectedSpan],
    ) -> Vec<ProtectedSpanMapping> {
        let mut search_start = 0;
        protected_spans
            .iter()
            .filter(|span| !span.raw.is_empty())
            .map(|span| {
                let relative_start = target_text[search_start..]
                    .find(&span.raw)
                    .unwrap_or_else(|| panic!("target text should contain {:?}", span.raw));
                let target_start = search_start + relative_start;
                let target_end = target_start + span.raw.len();
                search_start = target_end;
                ProtectedSpanMapping::new(&span.raw, target_start as u64, target_end as u64)
            })
            .collect()
    }

    #[test]
    fn parses_fixture_markup_into_engine_neutral_spans() {
        let text = "名前は\\N[1]、{player}<color=red><wait=30><ruby=依代|よりしろ><mystery tag>";
        let unit = json!({ "protectedSpans": [] });
        let spans = FixtureAdapter::protected_spans_for_unit(&unit, text).unwrap();

        for span in &spans {
            assert_eq!(
                &text[span.start as usize..span.end as usize],
                span.raw,
                "span should map back to source bytes: {span:?}"
            );
        }

        let placeholder = spans
            .iter()
            .find(|span| span.raw == "{player}")
            .expect("placeholder span");
        assert_eq!(placeholder.kind, "variable_placeholder");
        assert_eq!(placeholder.preserve_mode, "map");
        assert_eq!(placeholder.variable_name.as_deref(), Some("player"));

        let name_variable = spans
            .iter()
            .find(|span| span.raw == "\\N[1]")
            .expect("name variable span");
        assert_eq!(name_variable.kind, "variable_placeholder");
        assert_eq!(name_variable.parsed_name.as_deref(), Some("name_variable"));
        assert_eq!(name_variable.variable_name.as_deref(), Some("name[1]"));

        let color = spans
            .iter()
            .find(|span| span.raw == "<color=red>")
            .expect("color span");
        assert_eq!(color.kind, "control_markup");
        assert_eq!(color.parsed_name.as_deref(), Some("color"));
        assert_eq!(color.arguments.as_deref(), Some(&["red".to_string()][..]));

        let wait = spans
            .iter()
            .find(|span| span.raw == "<wait=30>")
            .expect("wait span");
        assert_eq!(wait.parsed_name.as_deref(), Some("wait"));
        assert_eq!(wait.arguments.as_deref(), Some(&["30".to_string()][..]));

        let ruby = spans
            .iter()
            .find(|span| span.raw == "<ruby=依代|よりしろ>")
            .expect("ruby span");
        assert_eq!(ruby.kind, "ruby_annotation");
        assert_eq!(ruby.annotation_text.as_deref(), Some("よりしろ"));
        assert_eq!(ruby.display_mode.as_deref(), Some("ruby"));

        let unknown = spans
            .iter()
            .find(|span| span.raw == "<mystery tag>")
            .expect("unknown tag span");
        assert_eq!(unknown.kind, "control_markup");
        assert_eq!(unknown.parsed_name.as_deref(), Some("mystery"));
        assert_eq!(unknown.arguments.as_deref(), Some(&["tag".to_string()][..]));
    }

    #[test]
    fn protects_unknown_and_malformed_backslash_markup_conservatively() {
        let text = "未知\\Q[alpha]と\\1[42]と\\#と\\N[broken";
        let unit = json!({ "protectedSpans": [] });
        let spans = FixtureAdapter::protected_spans_for_unit(&unit, text).unwrap();

        for raw in ["\\Q[alpha]", "\\1[42]", "\\#", "\\N[broken"] {
            let span = spans
                .iter()
                .find(|span| span.raw == raw)
                .unwrap_or_else(|| panic!("missing protected span {raw}"));
            assert_eq!(span.kind, "control_markup");
            assert_eq!(
                &text[span.start as usize..span.end as usize],
                span.raw,
                "span should map back to source bytes: {span:?}"
            );
        }

        let symbol_command = spans
            .iter()
            .find(|span| span.raw == "\\1[42]")
            .expect("symbol command span");
        assert_eq!(
            symbol_command.parsed_name.as_deref(),
            Some("unknown_backslash_command")
        );
        assert_eq!(
            symbol_command.arguments.as_deref(),
            Some(&["1".to_string(), "42".to_string()][..])
        );

        let malformed = spans
            .iter()
            .find(|span| span.raw == "\\N[broken")
            .expect("malformed command span");
        assert_eq!(
            malformed.parsed_name.as_deref(),
            Some("unknown_unclosed_backslash_command")
        );
        assert_eq!(malformed.arguments.as_deref(), Some(&["N".to_string()][..]));
    }

    #[test]
    fn explicit_fixture_spans_are_normalized_to_byte_offsets() {
        let text = "こんにちは、{player}。";
        let unit = json!({
            "protectedSpans": [
                {
                    "kind": "placeholder",
                    "raw": "{player}",
                    "start": 6,
                    "end": 14
                }
            ]
        });

        let spans = FixtureAdapter::protected_spans_for_unit(&unit, text).unwrap();

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].kind, "variable_placeholder");
        assert_eq!(spans[0].start, 18);
        assert_eq!(spans[0].end, 26);
        assert_eq!(spans[0].variable_name.as_deref(), Some("player"));
    }

    #[test]
    fn extracts_multi_surface_public_fixture_to_golden_bridge_snapshot() {
        let fixture_dir = public_fixture_dir();
        let extraction = FixtureAdapter
            .extract(ExtractRequest {
                game_dir: &fixture_dir,
            })
            .unwrap();
        let actual = stable_json(&extraction.bridge).unwrap();
        let expected =
            fs::read_to_string(repo_root().join("fixtures/hello-game/expected/bridge-v0.1.json"))
                .unwrap();

        assert_eq!(actual, expected);
        assert_eq!(extraction.bridge.units.len(), 11);

        let surfaces = extraction
            .bridge
            .units
            .iter()
            .map(|unit| unit.text_surface.as_str())
            .collect::<BTreeSet<_>>();
        assert!(surfaces.len() >= 5);
        for required in [
            "dialogue",
            "speaker_name",
            "choice_label",
            "ui_label",
            "tutorial_text",
            "database_entry",
            "image_text",
        ] {
            assert!(surfaces.contains(required), "missing surface {required}");
        }

        let span_kinds = extraction
            .bridge
            .units
            .iter()
            .flat_map(|unit| unit.protected_spans.iter())
            .map(|span| span.kind.as_str())
            .collect::<BTreeSet<_>>();
        assert!(span_kinds.contains("variable_placeholder"));
        assert!(span_kinds.contains("control_markup"));
    }

    #[test]
    fn public_fixture_surface_coverage_matrix_matches_source() {
        let fixture_dir = public_fixture_dir();
        let source: Value =
            serde_json::from_str(&fs::read_to_string(fixture_dir.join("source.json")).unwrap())
                .unwrap();
        let matrix: Value = serde_json::from_str(
            &fs::read_to_string(fixture_dir.join("surface-coverage-v0.2.json")).unwrap(),
        )
        .unwrap();

        let target_locales = source["targetLocales"].as_array().unwrap();
        let locale_branches = source["localeBranches"].as_array().unwrap();
        assert!(target_locales.len() >= 2);
        assert!(locale_branches.len() >= 2);
        assert_eq!(
            matrix["localeBranches"].as_array().unwrap().len(),
            locale_branches.len()
        );

        let mut source_surface_units = BTreeMap::<String, Vec<String>>::new();
        for unit in source["units"].as_array().unwrap() {
            let surface = unit["textSurface"].as_str().unwrap().to_string();
            let key = unit["sourceUnitKey"].as_str().unwrap().to_string();
            source_surface_units.entry(surface).or_default().push(key);
        }

        let mut matrix_surface_units = BTreeMap::<String, Vec<String>>::new();
        for surface in matrix["surfaces"].as_array().unwrap() {
            let surface_kind = surface["surfaceKind"].as_str().unwrap().to_string();
            let unit_keys = surface["unitKeys"]
                .as_array()
                .unwrap()
                .iter()
                .map(|key| key.as_str().unwrap().to_string())
                .collect::<Vec<_>>();
            assert_eq!(
                surface["unitCount"].as_u64().unwrap() as usize,
                unit_keys.len()
            );
            matrix_surface_units.insert(surface_kind, unit_keys);
        }
        assert_eq!(matrix_surface_units, source_surface_units);

        let span_kinds = matrix["protectedSpanCoverage"]
            .as_array()
            .unwrap()
            .iter()
            .map(|span| span["spanKind"].as_str().unwrap())
            .collect::<BTreeSet<_>>();
        assert!(span_kinds.contains("variable_placeholder"));
        assert!(span_kinds.contains("control_markup"));

        for bundle in matrix["expectedBridgeBundles"].as_array().unwrap() {
            let path = bundle["path"].as_str().unwrap();
            assert!(
                repo_root().join(path).is_file(),
                "missing expected bundle {path}"
            );
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
    fn round_trip_golden_harness_applies_public_v02_translated_patch() {
        let fixture_dir = public_fixture_dir();
        let work_dir = temp_dir("golden-public-v02");
        let patch_export: Value =
            read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
        let source_bridge: Value =
            read_json(&fixture_dir.join("expected/bridge-v0.2.json")).unwrap();

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
    fn public_fixture_round_trip_report_matches_reviewed_golden_artifact() {
        let fixture_dir = public_fixture_dir();
        let work_dir = temp_dir("golden-public-report-artifact");
        let patch_export: Value =
            read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
        let source_bridge: Value =
            read_json(&fixture_dir.join("expected/bridge-v0.2.json")).unwrap();

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
        let source_bridge: Value =
            read_json(&fixture_dir.join("expected/bridge-v0.2.json")).unwrap();

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
            failure.phase == "translated_patch"
                && failure.source_unit_key.as_deref() == Some("hello.scene.001.line.001")
                && failure
                    .asset_ref
                    .as_deref()
                    .unwrap_or("")
                    .contains("source.json#hello.scene.001.line.001")
                && failure.code.starts_with("protected_span")
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
        let source_bridge: Value =
            read_json(&fixture_dir.join("expected/bridge-v0.2.json")).unwrap();

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
    fn round_trip_golden_harness_requires_source_bridge_for_v02_source_hash_compatibility() {
        let fixture_dir = public_fixture_dir();
        let work_dir = temp_dir("golden-public-v02-stale-no-bridge");
        let mut patch_export: Value =
            read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
        patch_export["entries"][0]["sourceHash"] =
            json!("sha256:0000000000000000000000000000000000000000000000000000000000000000");

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
            .find(|failure| failure.code == "translated_source_bridge_required")
            .expect("missing source bridge failure");
        assert_eq!(failure.phase, "translated_source_compatibility");
        assert_eq!(failure.actual.as_deref(), Some("missing source bridge"));
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

    fn siglus_fixture_dir(name: &str, scene: Option<&[u8]>, gameexe: Option<&[u8]>) -> PathBuf {
        let dir = temp_dir(name);
        if let Some(scene) = scene {
            fs::write(dir.join(SIGLUS_SCENE_PATH), scene).unwrap();
        }
        if let Some(gameexe) = gameexe {
            fs::write(dir.join(SIGLUS_GAMEEXE_PATH), gameexe).unwrap();
        }
        dir
    }

    fn adapter_failure_from_error(error: Box<dyn std::error::Error>) -> AdapterFailure {
        serde_json::from_str(&error.to_string()).unwrap()
    }

    fn xp3_fixture_dir(name: &str, archive: &[u8]) -> PathBuf {
        let dir = temp_dir(name);
        fs::write(dir.join(XP3_ARCHIVE_PATH), archive).unwrap();
        dir
    }

    #[derive(Clone, Copy)]
    struct Xp3TestEntry<'a> {
        path: &'a str,
        payload: &'a [u8],
        compressed: bool,
        adler32: u32,
    }

    fn plain_xp3_fixture(entries: &[Xp3TestEntry<'_>]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(XP3_PLAIN_MAGIC);
        bytes.extend_from_slice(&0_u64.to_le_bytes());

        let mut segment_offsets = Vec::new();
        for entry in entries {
            segment_offsets.push(bytes.len() as u64);
            bytes.extend_from_slice(entry.payload);
        }

        let index_offset = bytes.len() as u64;
        let mut index = Vec::new();
        for (entry, offset) in entries.iter().zip(segment_offsets) {
            let mut file = Vec::new();
            let path_units = entry.path.encode_utf16().collect::<Vec<_>>();
            let mut info = Vec::new();
            info.extend_from_slice(&0_u32.to_le_bytes());
            info.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
            info.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
            info.extend_from_slice(&(path_units.len() as u16).to_le_bytes());
            for unit in path_units {
                info.extend_from_slice(&unit.to_le_bytes());
            }
            append_xp3_chunk(&mut file, b"info", &info);

            let mut segment = Vec::new();
            segment.extend_from_slice(&(u32::from(entry.compressed)).to_le_bytes());
            segment.extend_from_slice(&offset.to_le_bytes());
            segment.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
            segment.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
            append_xp3_chunk(&mut file, b"segm", &segment);
            append_xp3_chunk(&mut file, b"adlr", &entry.adler32.to_le_bytes());
            append_xp3_chunk(&mut index, b"File", &file);
        }

        bytes.push(0);
        bytes.extend_from_slice(&(index.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&index);
        bytes[XP3_PLAIN_MAGIC.len()..XP3_PLAIN_MAGIC.len() + 8]
            .copy_from_slice(&index_offset.to_le_bytes());
        bytes
    }

    fn append_xp3_chunk(output: &mut Vec<u8>, name: &[u8; 4], content: &[u8]) {
        output.extend_from_slice(name);
        output.extend_from_slice(&(content.len() as u64).to_le_bytes());
        output.extend_from_slice(content);
    }

    #[test]
    fn xp3_profile_records_cover_plain_encrypted_compressed_and_unknown_cases() {
        let cases: &[(&str, &[u8], &str)] = &[
            (
                "xp3-plain",
                b"XP3\r\nfixture-only plain archive",
                "xp3-plain-container",
            ),
            (
                "xp3-encrypted",
                b"XP3\r\nXP3-CRYPT\nfixture-only encrypted archive",
                "xp3-encrypted-container",
            ),
            (
                "xp3-compressed",
                b"XP3\r\nXP3-COMPRESSED\nfixture-only compressed archive",
                "xp3-compressed-container",
            ),
        ];
        let adapter = Xp3ProfileDetectorAdapter;

        for (name, bytes, variant) in cases {
            let game_dir = xp3_fixture_dir(name, bytes);
            let detection = adapter
                .detect(DetectRequest {
                    game_dir: &game_dir,
                })
                .unwrap();
            assert!(detection.detected, "{variant} should be detected");
            assert_eq!(detection.engine_family.as_deref(), Some("kiri_kiri_xp3"));
            assert_eq!(detection.detected_variant.as_deref(), Some(*variant));

            let profile = adapter
                .profile(ProfileRequest {
                    game_dir: &game_dir,
                })
                .unwrap();
            assert_eq!(profile.engine.adapter_id, XP3_DETECTOR_ADAPTER_ID);
            assert_eq!(profile.engine.detected_variant, *variant);
            let validation = profile.validate();
            assert_eq!(
                validation.status,
                OperationStatus::Passed,
                "{:?}",
                validation.failures
            );
            assert!(profile.archive_parameters.iter().any(|parameter| {
                parameter.kind == ArchiveParameterKind::ArchiveFormat && parameter.value == "xp3"
            }));
            assert!(profile.capabilities.iter().any(|capability| {
                capability.capability == Capability::Extraction
                    && capability.status == CapabilityStatus::Unsupported
            }));
            assert!(
                profile
                    .metadata
                    .get("supportBoundary")
                    .unwrap()
                    .contains("not claimed")
            );
            if *variant == "xp3-encrypted-container" {
                assert!(detection.requirements.iter().any(|requirement| {
                    requirement.key == "kirikiri-xp3-key-profile"
                        && requirement.status == RequirementStatus::Missing
                }));
                assert_eq!(profile.key_requirements.len(), 1);
                assert!(profile.requirements.iter().any(|requirement| {
                    requirement.key == "kirikiri-xp3-key-profile"
                        && requirement.status == RequirementStatus::NotRequired
                }));
            } else {
                assert!(profile.key_requirements.is_empty());
            }
            if *variant == "xp3-compressed-container" {
                assert!(
                    profile
                        .archive_parameters
                        .iter()
                        .any(|parameter| { parameter.kind == ArchiveParameterKind::Compression })
                );
            }

            let _ = fs::remove_dir_all(game_dir);
        }

        let unknown_dir = xp3_fixture_dir(
            "xp3-unknown",
            b"XP3\r\nXP3-UNKNOWN-VARIANT\nfixture-only unknown archive",
        );
        let unknown_detection = adapter
            .detect(DetectRequest {
                game_dir: &unknown_dir,
            })
            .unwrap();
        assert!(!unknown_detection.detected);
        assert_eq!(
            unknown_detection.detected_variant.as_deref(),
            Some("xp3-unknown-container")
        );
        assert!(unknown_detection.requirements.iter().any(|requirement| {
            requirement.key == "xp3-synthetic-profile-marker"
                && requirement.status == RequirementStatus::Unsupported
        }));
        let unknown_failure = adapter_failure_from_error(
            adapter
                .profile(ProfileRequest {
                    game_dir: &unknown_dir,
                })
                .unwrap_err(),
        );
        assert_eq!(unknown_failure.error_code, "kaifuu.unknown_engine_variant");
        assert_eq!(
            unknown_failure.required_capability,
            Some(Capability::Detection)
        );

        let _ = fs::remove_dir_all(unknown_dir);
    }

    #[test]
    fn xp3_plain_inventory_reports_file_entries_sizes_hashes_and_profile_id() {
        let game_dir = xp3_fixture_dir(
            "xp3-plain-inventory",
            &plain_xp3_fixture(&[
                Xp3TestEntry {
                    path: "scenario/intro.ks",
                    payload: b"hello xp3",
                    compressed: false,
                    adler32: 0x1111_2222,
                },
                Xp3TestEntry {
                    path: "scenario/compressed.ks",
                    payload: b"compressed payload bytes",
                    compressed: true,
                    adler32: 0x3333_4444,
                },
            ]),
        );

        let inventory = Xp3ProfileDetectorAdapter
            .asset_inventory(AssetInventoryRequest {
                game_dir: &game_dir,
            })
            .unwrap();

        assert_eq!(inventory.validate().status, OperationStatus::Passed);
        assert_eq!(inventory.assets.len(), 3);
        assert_eq!(inventory.assets[0].asset_key, XP3_ARCHIVE_PATH);
        assert_eq!(
            inventory.assets[0]
                .metadata
                .get("profileId")
                .map(String::as_str),
            Some("019ed000-0000-7000-8000-000000095001")
        );
        let compressed = inventory
            .assets
            .iter()
            .find(|asset| asset.asset_key == "scenario/compressed.ks")
            .unwrap();
        assert_eq!(compressed.asset_kind, AssetInventoryAssetKind::Script);
        let compressed_hash = sha256_hash_bytes(b"compressed payload bytes");
        assert_eq!(
            compressed.source_hash.as_deref(),
            Some(compressed_hash.as_str())
        );
        assert_eq!(
            compressed.metadata.get("originalSize").map(String::as_str),
            Some("24")
        );
        assert_eq!(
            compressed.metadata.get("archiveSize").map(String::as_str),
            Some("24")
        );
        assert_eq!(
            compressed.metadata.get("compressed").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            compressed.metadata.get("storedAdler32").map(String::as_str),
            Some("adler32:33334444")
        );

        let plain = inventory
            .assets
            .iter()
            .find(|asset| asset.asset_key == "scenario/intro.ks")
            .unwrap();
        assert_eq!(
            plain.metadata.get("compressed").map(String::as_str),
            Some("false")
        );

        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn xp3_plain_profile_marker_detection_ignores_member_payload_substrings() {
        let game_dir = xp3_fixture_dir(
            "xp3-plain-payload-marker",
            &plain_xp3_fixture(&[Xp3TestEntry {
                path: "scenario/intro.ks",
                payload: b"dialogue mentions XP3-CRYPT as literal text",
                compressed: false,
                adler32: 0,
            }]),
        );

        let detection = Xp3ProfileDetectorAdapter
            .detect(DetectRequest {
                game_dir: &game_dir,
            })
            .unwrap();

        assert!(detection.detected);
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("xp3-plain-container")
        );

        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn xp3_encrypted_and_helper_required_inventory_stop_with_diagnostics() {
        let encrypted_dir = xp3_fixture_dir(
            "xp3-encrypted-inventory",
            b"XP3\r\nXP3-CRYPT\nfixture-only encrypted archive",
        );
        let encrypted_failure = adapter_failure_from_error(
            Xp3ProfileDetectorAdapter
                .asset_inventory(AssetInventoryRequest {
                    game_dir: &encrypted_dir,
                })
                .unwrap_err(),
        );
        assert_eq!(
            encrypted_failure.error_code,
            "kaifuu.missing_capability.crypto"
        );

        let helper_dir = xp3_fixture_dir(
            "xp3-helper-required-inventory",
            b"XP3\r\nXP3-HELPER-REQUIRED\nfixture-only helper archive",
        );
        let helper_failure = adapter_failure_from_error(
            Xp3ProfileDetectorAdapter
                .extract(ExtractRequest {
                    game_dir: &helper_dir,
                })
                .unwrap_err(),
        );
        assert_eq!(helper_failure.error_code, "kaifuu.helper_required");

        let _ = fs::remove_dir_all(encrypted_dir);
        let _ = fs::remove_dir_all(helper_dir);
    }

    #[test]
    fn xp3_extract_returns_serialized_semantic_boundary_failure() {
        let game_dir = xp3_fixture_dir(
            "xp3-extract-boundary",
            b"XP3\r\nXP3-COMPRESSED\nfixture-only compressed archive",
        );
        let failure = adapter_failure_from_error(
            Xp3ProfileDetectorAdapter
                .extract(ExtractRequest {
                    game_dir: &game_dir,
                })
                .unwrap_err(),
        );

        assert_eq!(failure.error_code, "kaifuu.missing_capability.container");
        assert_eq!(
            failure.required_capability,
            Some(Capability::ContainerAccess)
        );
        assert_eq!(failure.asset_ref.as_deref(), Some(XP3_ARCHIVE_PATH));
        assert!(!failure.support_boundary.is_empty());

        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn siglus_only_complete_synthetic_pair_is_profileable_and_inventoryable() {
        let complete_dir = siglus_fixture_dir(
            "siglus-complete-pair",
            Some(SIGLUS_SCENE_MAGIC),
            Some(SIGLUS_GAMEEXE_MAGIC),
        );
        let missing_pair_dir =
            siglus_fixture_dir("siglus-missing-pair", Some(SIGLUS_SCENE_MAGIC), None);
        let unknown_dir = siglus_fixture_dir(
            "siglus-unknown-named-pair",
            Some(b"unknown scene bytes"),
            Some(b"unknown gameexe bytes"),
        );
        let adapter = SiglusProfileDetectorAdapter;

        let complete_detection = adapter
            .detect(DetectRequest {
                game_dir: &complete_dir,
            })
            .unwrap();
        assert!(complete_detection.detected);
        assert_eq!(
            complete_detection.detected_variant.as_deref(),
            Some("scene-pck-gameexe-dat-synthetic")
        );
        assert!(
            adapter
                .profile(ProfileRequest {
                    game_dir: &complete_dir
                })
                .is_ok()
        );
        assert!(
            adapter
                .asset_inventory(AssetInventoryRequest {
                    game_dir: &complete_dir
                })
                .is_ok()
        );

        let missing_detection = adapter
            .detect(DetectRequest {
                game_dir: &missing_pair_dir,
            })
            .unwrap();
        assert!(!missing_detection.detected);
        assert_eq!(
            missing_detection.detected_variant.as_deref(),
            Some("scene-pck-missing-gameexe-dat")
        );
        assert!(missing_detection.requirements.iter().any(|requirement| {
            requirement.key == SIGLUS_GAMEEXE_PATH
                && requirement.status == RequirementStatus::Missing
        }));
        let missing_failure = adapter_failure_from_error(
            adapter
                .profile(ProfileRequest {
                    game_dir: &missing_pair_dir,
                })
                .unwrap_err(),
        );
        assert_eq!(
            missing_failure.error_code,
            "kaifuu.missing_capability.container"
        );
        assert_eq!(
            missing_failure.required_capability,
            Some(Capability::AssetListing)
        );
        assert_eq!(
            missing_failure.detected_variant.as_deref(),
            Some("scene-pck-missing-gameexe-dat")
        );
        assert!(
            adapter
                .asset_inventory(AssetInventoryRequest {
                    game_dir: &missing_pair_dir
                })
                .is_err()
        );

        let unknown_detection = adapter
            .detect(DetectRequest {
                game_dir: &unknown_dir,
            })
            .unwrap();
        assert!(!unknown_detection.detected);
        assert_eq!(
            unknown_detection.detected_variant.as_deref(),
            Some("unknown-siglus-named-files")
        );
        assert!(unknown_detection.requirements.iter().any(|requirement| {
            requirement.key == "siglus-synthetic-signature"
                && requirement.status == RequirementStatus::Unsupported
        }));
        let unknown_failure = adapter_failure_from_error(
            adapter
                .asset_inventory(AssetInventoryRequest {
                    game_dir: &unknown_dir,
                })
                .unwrap_err(),
        );
        assert_eq!(unknown_failure.error_code, "kaifuu.unknown_engine_variant");
        assert_eq!(
            unknown_failure.required_capability,
            Some(Capability::Detection)
        );
        assert_eq!(
            unknown_failure.detected_variant.as_deref(),
            Some("unknown-siglus-named-files")
        );

        let _ = fs::remove_dir_all(complete_dir);
        let _ = fs::remove_dir_all(missing_pair_dir);
        let _ = fs::remove_dir_all(unknown_dir);
    }

    #[test]
    fn siglus_extract_returns_serialized_semantic_boundary_failure() {
        let game_dir = siglus_fixture_dir(
            "siglus-extract-boundary",
            Some(SIGLUS_SCENE_MAGIC),
            Some(SIGLUS_GAMEEXE_MAGIC),
        );
        let failure = adapter_failure_from_error(
            SiglusProfileDetectorAdapter
                .extract(ExtractRequest {
                    game_dir: &game_dir,
                })
                .unwrap_err(),
        );

        assert_eq!(failure.error_code, "kaifuu.unsupported_layered_transform");
        assert_eq!(failure.required_capability, Some(Capability::CodecAccess));
        assert_eq!(failure.asset_ref.as_deref(), Some(SIGLUS_SCENE_PATH));
        assert!(failure.support_boundary.contains("parsing/decompilation"));
        assert!(
            failure
                .remediation
                .as_deref()
                .unwrap_or("")
                .contains("do not request extract")
        );

        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn fixture_asset_inventory_reports_non_text_surfaces_without_patching_support() {
        let game_dir = hello_fixture_dir();
        let manifest = FixtureAdapter
            .asset_inventory(AssetInventoryRequest {
                game_dir: &game_dir,
            })
            .unwrap();

        assert_eq!(manifest.validate().status, OperationStatus::Passed);
        assert_eq!(manifest.assets.len(), 11);
        assert_eq!(manifest.surfaces.len(), 6);
        let surface_kinds = manifest
            .surfaces
            .iter()
            .map(|surface| serde_json::to_string(&surface.asset_surface_kind).unwrap())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            surface_kinds,
            [
                "\"credits\"",
                "\"font\"",
                "\"image_text\"",
                "\"song_title\"",
                "\"ui_art\"",
                "\"video\"",
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<BTreeSet<_>>()
        );
        assert!(manifest.surfaces.iter().all(|surface| {
            surface.patching.capability == Capability::AssetTextPatching
                && surface.patching.status == kaifuu_core::CapabilityStatus::Unsupported
        }));
        assert!(
            manifest.surfaces.iter().all(|surface| {
                surface.text_source_kind != AssetInventoryTextSourceKind::OcrHint
            })
        );
        assert!(manifest.surfaces.iter().any(|surface| {
            surface.asset_surface_kind == AssetInventorySurfaceKind::Font
                && surface.source_text.is_none()
                && surface.text_source_kind == AssetInventoryTextSourceKind::NotApplicable
        }));
    }

    #[test]
    fn fixture_asset_inventory_metadata_round_trips_stably() {
        let game_dir = hello_fixture_dir();
        let manifest = FixtureAdapter
            .asset_inventory(AssetInventoryRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        let serialized = manifest.stable_json().unwrap();
        let round_tripped: AssetInventoryManifest = serde_json::from_str(&serialized).unwrap();

        assert_eq!(round_tripped, manifest);
        assert_eq!(round_tripped.validate().status, OperationStatus::Passed);
        let audio_asset = round_tripped
            .assets
            .iter()
            .find(|asset| asset.asset_id == "asset-audio-moonlit-path")
            .unwrap();
        assert_eq!(
            audio_asset.metadata.get("titleField").map(String::as_str),
            Some("vorbisComment.TITLE")
        );
    }

    #[test]
    fn fixture_asset_inventory_matches_reviewed_fixture_manifest() {
        let game_dir = hello_fixture_dir();
        let mut manifest = FixtureAdapter
            .asset_inventory(AssetInventoryRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        let mut expected: AssetInventoryManifest =
            serde_json::from_str(&fs::read_to_string(expected_asset_inventory_path()).unwrap())
                .unwrap();

        manifest.normalize();
        expected.normalize();
        assert_eq!(manifest.validate().status, OperationStatus::Passed);
        assert_eq!(expected.validate().status, OperationStatus::Passed);
        assert_eq!(manifest, expected);
    }

    #[test]
    fn fixture_profile_json_is_stable() {
        let game_dir = temp_game("profile");
        let first = FixtureAdapter
            .profile(ProfileRequest {
                game_dir: &game_dir,
            })
            .unwrap()
            .stable_json()
            .unwrap();
        let second = FixtureAdapter
            .profile(ProfileRequest {
                game_dir: &game_dir,
            })
            .unwrap()
            .stable_json()
            .unwrap();
        assert_eq!(first, second);
        assert!(first.contains("\"capability\": \"line_parity_patching\""));
        assert!(first.contains("\"container\": \"identity\""));
        assert!(first.contains("\"crypto\": \"null_key\""));
        assert!(first.contains("\"codec\": \"identity\""));
        let _ = fs::remove_dir_all(game_dir);
    }
}
