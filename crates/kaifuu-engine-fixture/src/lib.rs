use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use kaifuu_core::{
    ASSET_INVENTORY_SCHEMA_VERSION, AdapterCapabilities, AdapterFailure, AssetInventoryAsset,
    AssetInventoryAssetKind, AssetInventoryAssetRef, AssetInventoryManifest,
    AssetInventoryPatchMode, AssetInventoryRequest, AssetInventorySurface,
    AssetInventorySurfaceKind, AssetInventoryTextSourceKind, AssetKind, AssetList,
    AssetListRequest, AssetProfile, BridgeBundle, BridgeUnit, Capability, CapabilityReport,
    DetectRequest, DetectionEvidence, DetectionResult, EngineAdapter, EngineProfile,
    EvidenceStatus, ExtractRequest, ExtractionResult, GameProfile, KaifuuResult, OperationStatus,
    PatchRef, PatchRequest, PatchResult, ProfileRequest, ProfileRequirement, ProtectedSpan,
    RequirementCategory, RequirementStatus, TextSurface, VerificationResult, VerifyRequest,
    atomic_write_text, content_hash, deterministic_id, normalize_protected_spans, require_str,
    require_u64, safe_join_relative,
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

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let source_path = Self::source_path(request.game_dir);
        let source_text = fs::read_to_string(&source_path)?;
        let mut source: Value = serde_json::from_str(&source_text)?;
        let units = source["units"]
            .as_array()
            .ok_or("fixture source missing units")?;
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

pub fn registry() -> kaifuu_core::AdapterRegistry {
    let mut registry = kaifuu_core::AdapterRegistry::new();
    registry.register(FixtureAdapter);
    registry
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaifuu_core::{
        GoldenAssertionStatus, GoldenByteEquivalenceMode, GoldenHarnessRequest, PatchExport,
        ProtectedSpanMapping, read_json, run_round_trip_golden, stable_json,
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
        let _ = fs::remove_dir_all(game_dir);
    }
}
