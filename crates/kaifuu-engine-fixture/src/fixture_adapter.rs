use super::*;

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
            AdapterCapabilityMatrix::new(
                FIXTURE_ADAPTER_ID,
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::partial(vec![
                    "writes source.json only; does not rebuild engine archives or binary assets"
                        .to_string(),
                    "requires patch entries to match existing sourceUnitKey values".to_string(),
                ]),
            ),
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
