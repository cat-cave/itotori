use super::*;

impl FixtureAdapter {
    pub(super) fn source_path(game_dir: &Path) -> std::path::PathBuf {
        game_dir.join("source.json")
    }

    pub(super) fn read_source(game_dir: &Path) -> KaifuuResult<(String, Value)> {
        let source_text = fs::read_to_string(Self::source_path(game_dir))?;
        let source = serde_json::from_str(&source_text)?;
        Ok((source_text, source))
    }

    pub(super) fn source_locale(source: &Value) -> String {
        source["sourceLocale"]
            .as_str()
            .unwrap_or("ja-JP")
            .to_string()
    }

    pub(super) fn requirements(source_present: bool) -> Vec<ProfileRequirement> {
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

    pub(super) fn text_surface_from_fixture_name(name: &str) -> TextSurface {
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

    pub(super) fn patch_failure(
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

    pub(super) fn protected_span_patch_failures(
        entry: &kaifuu_core::PatchExportEntry,
        required_spans: &[ProtectedSpan],
    ) -> Vec<AdapterFailure> {
        let mut failures = Vec::new();
        let mut required_spans_by_raw = BTreeMap::<&str, Vec<&ProtectedSpan>>::new();
        for span in required_spans {
            if span.raw.is_empty() {
                continue;
            }
            required_spans_by_raw
                .entry(span.raw.as_str())
                .or_default()
                .push(span);
        }

        let mut declared_counts = BTreeMap::<&str, usize>::new();
        let mut declared_ranges = BTreeMap::<&str, BTreeSet<(u64, u64)>>::new();
        let mut matched_source_identities = BTreeSet::<String>::new();
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
                continue;
            }
            if let Some(source_spans) = required_spans_by_raw.get(mapping.raw.as_str())
                && !Self::protected_span_mapping_source_identity_matches(
                    mapping,
                    source_spans,
                    &mut matched_source_identities,
                )
            {
                failures.push(Self::patch_failure(
                    "protected_span_mapping_mismatch",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires duplicate protectedSpanMappings to reference a real source protected span identity",
                    format!(
                        "Align sourceSpanId/sourceStartByte/sourceEndByte for protected span {:?} in sourceUnitKey {}",
                        mapping.raw, entry.source_unit_key
                    ),
                ));
                continue;
            }
            if !declared_ranges
                .entry(mapping.raw.as_str())
                .or_default()
                .insert((mapping.target_start, mapping.target_end))
            {
                failures.push(Self::patch_failure(
                    "protected_span_duplicate_mapping",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires duplicate protected spans to use distinct targetText ranges",
                    format!(
                        "Map each protected span {:?} occurrence to a distinct target byte range in sourceUnitKey {}",
                        mapping.raw, entry.source_unit_key
                    ),
                ));
            }
        }

        let mut protected_raws = BTreeSet::new();
        for raw in required_spans_by_raw.keys().chain(declared_counts.keys()) {
            protected_raws.insert(*raw);
        }
        for raw in protected_raws {
            let required_count = required_spans_by_raw.get(raw).map_or(0, std::vec::Vec::len);
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
            let distinct_declared_count = declared_ranges.get(raw).map_or(0, BTreeSet::len);
            if actual_count < required_count || distinct_declared_count < declared_count {
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

    pub(super) fn protected_span_mapping_source_identity_matches(
        mapping: &ProtectedSpanMapping,
        source_spans: &[&ProtectedSpan],
        matched_source_identities: &mut BTreeSet<String>,
    ) -> bool {
        let duplicate_raw = source_spans.len() > 1;
        if duplicate_raw && !mapping.has_source_identity() {
            return false;
        }

        if !mapping.has_source_identity() {
            return true;
        }

        let Some(source_span) = source_spans.iter().find(|source_span| {
            mapping.matches_source_span(
                &source_span.raw,
                Some(source_span.start),
                Some(source_span.end),
                source_span.span_id.as_deref(),
            )
        }) else {
            return false;
        };

        let source_identity_key = if let Some(span_id) = source_span.span_id.as_deref() {
            format!("{span_id}:{}:{}", source_span.start, source_span.end)
        } else {
            format!("{}:{}", source_span.start, source_span.end)
        };
        matched_source_identities.insert(source_identity_key)
    }

    pub(super) fn profile_from_source(
        &self,
        source_text: &str,
        source: &Value,
    ) -> KaifuuResult<GameProfile> {
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

    pub(super) fn asset_from_source(
        &self,
        source_text: &str,
        source: &Value,
    ) -> KaifuuResult<AssetProfile> {
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

    pub(super) fn asset_inventory_from_source(
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

    pub(super) fn asset_inventory_assets_from_source(
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

        for asset in source["assets"].as_array().map_or(&[][..], Vec::as_slice) {
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

    pub(super) fn asset_inventory_surfaces_from_source(
        &self,
        source: &Value,
    ) -> KaifuuResult<Vec<AssetInventorySurface>> {
        source["assetSurfaces"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .enumerate()
            .map(|(index, surface)| {
                let surface_id = surface["surfaceId"]
                    .as_str().map_or_else(|| deterministic_id("asset-surface", index + 1), str::to_string);
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
                    patch_payload: None,
                    metadata_hash: None,
                    notes: surface["notes"]
                        .as_array()
                        .map_or(&[][..], Vec::as_slice)
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect(),
                })
            })
            .collect()
    }

    pub(super) fn asset_inventory_asset_ref(
        surface: &Value,
    ) -> KaifuuResult<AssetInventoryAssetRef> {
        let asset_ref = surface
            .get("sourceAssetRef")
            .ok_or("asset surface missing sourceAssetRef")?;
        Ok(AssetInventoryAssetRef {
            asset_id: require_str(asset_ref, "assetId")?.to_string(),
            asset_key: asset_ref["assetKey"].as_str().map(str::to_string),
        })
    }

    pub(super) fn string_metadata(value: Option<&Value>) -> KaifuuResult<BTreeMap<String, String>> {
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

    pub(super) fn asset_inventory_asset_kind(kind: &str) -> KaifuuResult<AssetInventoryAssetKind> {
        Ok(serde_json::from_value(Value::String(kind.to_string()))?)
    }

    pub(super) fn asset_inventory_surface_kind(
        kind: &str,
    ) -> KaifuuResult<AssetInventorySurfaceKind> {
        Ok(serde_json::from_value(Value::String(kind.to_string()))?)
    }

    pub(super) fn asset_inventory_text_source_kind(
        kind: &str,
    ) -> KaifuuResult<AssetInventoryTextSourceKind> {
        Ok(serde_json::from_value(Value::String(kind.to_string()))?)
    }

    pub(super) fn asset_inventory_patch_mode(kind: &str) -> KaifuuResult<AssetInventoryPatchMode> {
        Ok(serde_json::from_value(Value::String(kind.to_string()))?)
    }

    pub(super) fn protected_spans_for_unit(
        unit: &Value,
        text: &str,
    ) -> KaifuuResult<Vec<ProtectedSpan>> {
        let mut spans = Self::parse_fixture_markup_spans(text)?;
        spans.extend(Self::explicit_protected_spans_for_unit(unit, text)?);
        let mut spans = normalize_protected_spans(text, spans)?;
        for (index, span) in spans.iter_mut().enumerate() {
            if span.span_id.is_none() {
                span.span_id = Some(deterministic_id("span", index + 1));
            }
        }
        Ok(spans)
    }
}
