use super::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryManifest {
    pub schema_version: String,
    pub manifest_id: String,
    pub adapter_id: String,
    pub source_locale: String,
    pub assets: Vec<AssetInventoryAsset>,
    pub surfaces: Vec<AssetInventorySurface>,
    pub capabilities: Vec<CapabilityReport>,
    pub warnings: Vec<AdapterWarning>,
    pub metadata: BTreeMap<String, String>,
}

impl AssetInventoryManifest {
    pub fn normalize(&mut self) {
        self.assets.sort_by_key(|asset| asset.asset_id.clone());
        self.surfaces
            .sort_by_key(|surface| surface.surface_id.clone());
        for surface in &mut self.surfaces {
            surface.notes.sort();
            surface.notes.dedup();
        }
        self.capabilities.sort_by_key(|report| {
            (
                serde_json::to_string(&report.capability).unwrap_or_default(),
                serde_json::to_string(&report.status).unwrap_or_default(),
                report.limitation.clone(),
            )
        });
        self.warnings
            .sort_by_key(|warning| (warning.code.clone(), warning.message.clone()));
    }

    /// Serialize into report-safe, canonical JSON.
    /// Public serialization always routes through the centralized report
    /// redaction policy (`redact_report_value`) so library callers cannot
    /// accidentally leak absolute paths, key material, helper dumps, or
    /// private text into a report/log/fixture. There is no raw public
    /// serialization path for `AssetInventoryManifest`; the redaction cannot
    /// be bypassed through this API.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        let mut normalized = self.clone();
        normalized.normalize();
        let value = redact_report_value(&serde_json::to_value(&normalized)?);
        Ok(format!("{}\n", serde_json::to_string_pretty(&value)?))
    }

    pub fn validate(&self) -> AssetInventoryValidationResult {
        let mut failures = Vec::new();
        if self.schema_version != ASSET_INVENTORY_SCHEMA_VERSION {
            failures.push(AssetInventoryValidationFailure {
                code: "unsupported_schema_version".to_string(),
                field: "schemaVersion".to_string(),
                message: format!(
                    "schemaVersion must be {ASSET_INVENTORY_SCHEMA_VERSION}, got {}",
                    self.schema_version
                ),
            });
        }
        if self.manifest_id.trim().is_empty() {
            failures.push(required_inventory_failure(
                "manifestId",
                "manifestId must not be empty",
            ));
        }
        if self.adapter_id.trim().is_empty() {
            failures.push(required_inventory_failure(
                "adapterId",
                "adapterId must not be empty",
            ));
        }
        if !is_bcp47_like_locale(&self.source_locale) {
            failures.push(AssetInventoryValidationFailure {
                code: "invalid_locale".to_string(),
                field: "sourceLocale".to_string(),
                message: "sourceLocale must be a BCP 47-style locale tag".to_string(),
            });
        }
        if self.assets.is_empty() {
            failures.push(AssetInventoryValidationFailure {
                code: "missing_assets".to_string(),
                field: "assets".to_string(),
                message: "asset inventory must include at least one asset".to_string(),
            });
        }

        let mut asset_ids = HashSet::new();
        let mut asset_keys_by_id = BTreeMap::new();
        for (index, asset) in self.assets.iter().enumerate() {
            let field = format!("assets.{index}");
            if asset.asset_id.trim().is_empty()
                || asset.asset_id.chars().any(char::is_whitespace)
                || asset.asset_id.contains('\0')
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_asset_id".to_string(),
                    field: format!("{field}.assetId"),
                    message:
                        "assetId must not be empty and must not contain whitespace or null bytes"
                            .to_string(),
                });
            }
            if !asset_ids.insert(asset.asset_id.clone()) {
                failures.push(AssetInventoryValidationFailure {
                    code: "duplicate_asset_id".to_string(),
                    field: "assets".to_string(),
                    message: format!("assetId {} appears more than once", asset.asset_id),
                });
            }
            if asset.asset_key.trim().is_empty() {
                failures.push(required_inventory_failure(
                    &format!("{field}.assetKey"),
                    "assetKey must not be empty",
                ));
            }
            if let Some(path) = &asset.path {
                validate_asset_inventory_relative_path(
                    &mut failures,
                    &format!("{field}.path"),
                    path,
                );
            }
            if let Some(source_hash) = &asset.source_hash
                && source_hash.trim().is_empty()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_source_hash".to_string(),
                    field: format!("{field}.sourceHash"),
                    message: "sourceHash must be omitted or non-empty".to_string(),
                });
            }
            asset_keys_by_id.insert(asset.asset_id.clone(), asset.asset_key.clone());
        }

        let mut surface_ids = HashSet::new();
        for (index, surface) in self.surfaces.iter().enumerate() {
            let field = format!("surfaces.{index}");
            if surface.surface_id.trim().is_empty()
                || surface.surface_id.chars().any(char::is_whitespace)
                || surface.surface_id.contains('\0')
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_surface_id".to_string(),
                    field: format!("{field}.surfaceId"),
                    message:
                        "surfaceId must not be empty and must not contain whitespace or null bytes"
                            .to_string(),
                });
            }
            if !surface_ids.insert(surface.surface_id.clone()) {
                failures.push(AssetInventoryValidationFailure {
                    code: "duplicate_surface_id".to_string(),
                    field: "surfaces".to_string(),
                    message: format!("surfaceId {} appears more than once", surface.surface_id),
                });
            }
            if !asset_ids.contains(&surface.source_asset_ref.asset_id) {
                failures.push(AssetInventoryValidationFailure {
                    code: "unknown_asset_ref".to_string(),
                    field: format!("{field}.sourceAssetRef.assetId"),
                    message: format!(
                        "surface references unknown assetId {}",
                        surface.source_asset_ref.asset_id
                    ),
                });
            }
            if let Some(expected_key) = asset_keys_by_id.get(&surface.source_asset_ref.asset_id)
                && let Some(asset_key) = &surface.source_asset_ref.asset_key
                && asset_key != expected_key
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "asset_key_mismatch".to_string(),
                    field: format!("{field}.sourceAssetRef.assetKey"),
                    message: format!(
                        "assetKey {asset_key} does not match referenced asset key {expected_key}"
                    ),
                });
            }
            if let Some(source_location) = &surface.source_location {
                validate_asset_inventory_source_location(
                    &mut failures,
                    &format!("{field}.sourceLocation"),
                    source_location,
                );
            }
            if matches!(
                &surface.text_source_kind,
                AssetInventoryTextSourceKind::NotApplicable
            ) && surface.source_text.is_some()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "unexpected_source_text".to_string(),
                    field: format!("{field}.sourceText"),
                    message: "sourceText must be omitted when textSourceKind is not_applicable"
                        .to_string(),
                });
            }
            if !matches!(
                &surface.text_source_kind,
                AssetInventoryTextSourceKind::NotApplicable
            ) && surface
                .source_text
                .as_deref()
                .map_or("", str::trim)
                .is_empty()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "missing_source_text".to_string(),
                    field: format!("{field}.sourceText"),
                    message: "sourceText is required unless textSourceKind is not_applicable"
                        .to_string(),
                });
            }
            if let Some(source_hash) = &surface.source_hash
                && source_hash.trim().is_empty()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_source_hash".to_string(),
                    field: format!("{field}.sourceHash"),
                    message: "sourceHash must be omitted or non-empty".to_string(),
                });
            }
            if matches!(
                &surface.patching.status,
                CapabilityStatus::Limited
                    | CapabilityStatus::Unsupported
                    | CapabilityStatus::RequiresUserInput
            ) && surface
                .patching
                .limitation
                .as_deref()
                .map_or("", str::trim)
                .is_empty()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "missing_patching_limitation".to_string(),
                    field: format!("{field}.patching.limitation"),
                    message:
                        "limited, unsupported, and user-input patching reports require a limitation"
                            .to_string(),
                });
            }
        }

        AssetInventoryValidationResult {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: Some(self.manifest_id.clone()),
            status: if failures.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            failures,
        }
    }

    /// stamp every surface with its stable metadata hash, making the
    /// manifest's asset identity + patch capability tamper-evident. Adapters call
    /// this before publishing a manifest; the validator later recomputes and
    /// rejects any drift.
    pub fn stamp_asset_metadata_hashes(&mut self) {
        let surfaces = self.surfaces.clone();
        for (index, surface) in surfaces.iter().enumerate() {
            let hash = asset_inventory_surface_metadata_hash(self, surface);
            self.surfaces[index].metadata_hash = Some(hash);
        }
    }

    /// run the patch-capability consistency validator, returning the
    /// typed diagnostics that REJECT the manifest (empty = consistent). See
    /// [`validate_asset_inventory_patch_capability`].
    pub fn validate_patch_capability(&self) -> Result<(), Vec<AssetCapabilityDiagnostic>> {
        let diagnostics = validate_asset_inventory_patch_capability(self);
        if diagnostics.is_empty() {
            Ok(())
        } else {
            Err(diagnostics)
        }
    }
}
