use super::*;

impl EngineAdapter for BgiBytecodeAdapter {
    fn id(&self) -> &'static str {
        BGI_BYTECODE_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "BGI/Ethornell loose bytecode adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        Self::capabilities_for_adapter()
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        let assets = Self::scan_assets(request.game_dir)?;
        let detected = !assets.is_empty();
        let evidence = if let Some(asset) = assets.first() {
            vec![DetectionEvidence {
                path: asset.relative_path.clone(),
                kind: "bgi_bytecode_string_references".to_string(),
                status: EvidenceStatus::Matched,
                detail: format!(
                    "parsed {} Shift-JIS string-reference surface(s)",
                    asset.references.len()
                ),
            }]
        } else {
            vec![DetectionEvidence {
                path: ".".to_string(),
                kind: "bgi_bytecode_string_references".to_string(),
                status: EvidenceStatus::Missing,
                detail: "no loose BGI/Ethornell header or no-header bytecode file parsed"
                    .to_string(),
            }]
        };
        Ok(DetectionResult {
            adapter_id: BGI_BYTECODE_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| BGI_ENGINE_FAMILY.to_string()),
            engine_version: None,
            detected_variant: detected.then(|| Self::detected_variant(&assets).to_string()),
            evidence,
            requirements: Self::requirements(detected),
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        let assets = Self::scan_assets(request.game_dir)?;
        if assets.is_empty() {
            return Err("no loose BGI/Ethornell bytecode files parsed".into());
        }
        Ok(self.profile_from_assets(&assets))
    }

    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        let assets = Self::scan_assets(request.game_dir)?;
        if assets.is_empty() {
            return Err("no loose BGI/Ethornell bytecode files parsed".into());
        }
        Ok(AssetList {
            adapter_id: BGI_BYTECODE_ADAPTER_ID.to_string(),
            assets: assets.iter().map(Self::asset_profile).collect(),
        })
    }

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        let assets = Self::scan_assets(request.game_dir)?;
        if assets.is_empty() {
            return Err("no loose BGI/Ethornell bytecode files parsed".into());
        }
        Ok(self.asset_inventory_from_assets(&assets))
    }

    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        let assets = Self::scan_assets(request.game_dir)?;
        if assets.is_empty() {
            return Err("no loose BGI/Ethornell bytecode files parsed".into());
        }
        let source_bundle_hash =
            sha256_hash_bytes(Self::source_fingerprint_payload(&assets).as_bytes());
        Ok(ExtractionResult {
            adapter_id: BGI_BYTECODE_ADAPTER_ID.to_string(),
            profile: self.profile_from_assets(&assets),
            bridge: BridgeBundle {
                schema_version: "0.1.0".to_string(),
                bridge_id: deterministic_id("bgibridge", 1),
                source_bundle_hash,
                source_locale: "ja-JP".to_string(),
                extractor_name: "kaifuu-bgi-bytecode".to_string(),
                extractor_version: env!("CARGO_PKG_VERSION").to_string(),
                units: Self::bridge_units(&assets),
            },
            warnings: vec![],
        })
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        let assets = Self::scan_assets(request.game_dir)?;
        if assets.is_empty() {
            return Ok(Self::patch_fail(
                &request.patch_export.patch_export_id,
                content_hash("bgi preflight no source"),
                "kaifuu.bgi.patch.no_source_bytecode",
                ".",
                "no loose BGI/Ethornell bytecode files parsed",
            ));
        }
        let source_bundle_hash =
            sha256_hash_bytes(Self::source_fingerprint_payload(&assets).as_bytes());
        let references = assets
            .iter()
            .flat_map(|asset| {
                asset.references.iter().map(move |reference| {
                    (
                        format!("{}#{}", asset.relative_path, reference.reference_id),
                        (asset, reference),
                    )
                })
            })
            .collect::<BTreeMap<_, _>>();
        for entry in &request.patch_export.entries {
            let Some((asset, reference)) = references.get(&entry.source_unit_key).copied() else {
                return Ok(Self::patch_fail(
                    &request.patch_export.patch_export_id,
                    &source_bundle_hash,
                    "kaifuu.bgi.patch.unknown_source_unit_key",
                    &entry.source_unit_key,
                    "patch entry does not target a parsed BGI string reference",
                ));
            };
            if entry.source_hash != content_hash(&reference.decoded_text) {
                return Ok(Self::patch_fail(
                    &request.patch_export.patch_export_id,
                    sha256_hash_bytes(&asset.bytes),
                    "kaifuu.bgi.patch.source_hash_mismatch",
                    &entry.source_unit_key,
                    "patch entry source hash does not match current BGI decoded text",
                ));
            }
        }
        Ok(PatchResult::preflight_pass(request.patch_export))
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let assets = Self::scan_assets(request.game_dir)?;
        if assets.is_empty() {
            return Ok(Self::patch_fail(
                &request.patch_export.patch_export_id,
                content_hash("bgi patch no source"),
                "kaifuu.bgi.patch.no_source_bytecode",
                ".",
                "no loose BGI/Ethornell bytecode files parsed",
            ));
        }

        copy_dir_tree(request.game_dir, request.output_dir)?;
        let mut patched_hashes = Vec::new();
        for asset in &assets {
            let mut patch_cases = Vec::new();
            for entry in &request.patch_export.entries {
                let Some(reference_id) = entry
                    .source_unit_key
                    .strip_prefix(&format!("{}#", asset.relative_path))
                else {
                    continue;
                };
                let Some(reference) = asset
                    .references
                    .iter()
                    .find(|reference| reference.reference_id == reference_id)
                else {
                    return Ok(Self::patch_fail(
                        &request.patch_export.patch_export_id,
                        sha256_hash_bytes(&asset.bytes),
                        "kaifuu.bgi.patch.unknown_source_unit_key",
                        &entry.source_unit_key,
                        "patch entry does not target a parsed BGI string reference",
                    ));
                };
                if entry.source_hash != content_hash(&reference.decoded_text) {
                    return Ok(Self::patch_fail(
                        &request.patch_export.patch_export_id,
                        sha256_hash_bytes(&asset.bytes),
                        "kaifuu.bgi.patch.source_hash_mismatch",
                        &entry.source_unit_key,
                        "patch entry source hash does not match current BGI decoded text",
                    ));
                }
                patch_cases.push(BgiBytecodePatchCase {
                    patch_id: entry.bridge_unit_id.clone(),
                    reference_id: reference.reference_id.clone(),
                    replacement_text: entry.target_text.clone(),
                });
            }
            if patch_cases.is_empty() {
                patched_hashes.push(sha256_hash_bytes(&asset.bytes));
                continue;
            }
            let (_variant, patched, _reports) =
                match patch_bgi_bytecode_bytes(&asset.bytes, &patch_cases) {
                    Ok(result) => result,
                    Err(error) => {
                        return Ok(Self::patch_fail(
                            &request.patch_export.patch_export_id,
                            sha256_hash_bytes(&asset.bytes),
                            "kaifuu.bgi.patch.bytecode_rewrite_failed",
                            &asset.relative_path,
                            format!("BGI bytecode rewrite failed: {error}"),
                        ));
                    }
                };
            parse_bgi_bytecode_bytes(&patched)?;
            let output_path = safe_join_relative(request.output_dir, &asset.relative_path)?;
            atomic_write_bytes(&output_path, &patched)?;
            patched_hashes.push(sha256_hash_bytes(&patched));
        }

        Ok(PatchResult {
            schema_version: kaifuu_core::PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("bgi-patch", 1),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: sha256_hash_bytes(patched_hashes.join("\n").as_bytes()),
            failures: vec![],
        })
    }

    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        let assets = Self::scan_assets(request.game_dir)?;
        if assets.is_empty() {
            return Ok(VerificationResult {
                schema_version: kaifuu_core::PROFILE_SCHEMA_VERSION.to_string(),
                patch_result_id: deterministic_id("bgi-verify", 1),
                status: OperationStatus::Failed,
                output_hash: content_hash("bgi verify no source"),
                failures: vec![AdapterFailure {
                    error_code: "kaifuu.bgi.verify.no_loadable_bytecode".to_string(),
                    adapter: BGI_BYTECODE_ADAPTER_ID.to_string(),
                    engine: Some(BGI_ENGINE_FAMILY.to_string()),
                    detected_variant: None,
                    asset_ref: Some(".".to_string()),
                    required_capability: Some(Capability::Verification),
                    support_boundary: "no loose BGI/Ethornell bytecode files parsed".to_string(),
                    remediation: Some(
                        "verify a directory containing patched loose BGI bytecode".to_string(),
                    ),
                }],
            });
        }
        Ok(VerificationResult {
            schema_version: kaifuu_core::PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("bgi-verify", 1),
            status: OperationStatus::Passed,
            output_hash: sha256_hash_bytes(Self::source_fingerprint_payload(&assets).as_bytes()),
            failures: vec![],
        })
    }
}
