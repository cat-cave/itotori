use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryValidationResult {
    pub schema_version: String,
    pub manifest_id: Option<String>,
    pub status: OperationStatus,
    pub failures: Vec<AssetInventoryValidationFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryValidationFailure {
    pub code: String,
    pub field: String,
    pub message: String,
}

pub(crate) fn required_inventory_failure(
    field: &str,
    message: &str,
) -> AssetInventoryValidationFailure {
    AssetInventoryValidationFailure {
        code: "missing_required_field".to_string(),
        field: field.to_string(),
        message: message.to_string(),
    }
}

pub(crate) fn validate_asset_inventory_relative_path(
    failures: &mut Vec<AssetInventoryValidationFailure>,
    field: &str,
    path: &str,
) {
    let mut profile_failures = Vec::new();
    validate_profile_relative_path(&mut profile_failures, field, path);
    if !profile_failures.is_empty() {
        failures.extend(profile_failures.into_iter().map(|failure| {
            AssetInventoryValidationFailure {
                code: failure.code,
                field: failure.field,
                message: failure.message,
            }
        }));
    }
}

pub(crate) fn validate_asset_inventory_source_location(
    failures: &mut Vec<AssetInventoryValidationFailure>,
    field: &str,
    value: &Value,
) {
    let Some(location) = value.as_object() else {
        failures.push(AssetInventoryValidationFailure {
            code: "invalid_source_location".to_string(),
            field: field.to_string(),
            message: "sourceLocation must be a JSON object".to_string(),
        });
        return;
    };

    for key in location.keys() {
        if !["containerKey", "entryPath", "range", "region"].contains(&key.as_str()) {
            failures.push(AssetInventoryValidationFailure {
                code: "engine_specific_source_location".to_string(),
                field: format!("{field}.{key}"),
                message:
                    "sourceLocation must use neutral fields: containerKey, entryPath, range, region"
                        .to_string(),
            });
        }
    }
    if let Some(container_key) = location.get("containerKey")
        && container_key.as_str().map_or("", str::trim).is_empty()
    {
        failures.push(AssetInventoryValidationFailure {
            code: "invalid_source_location".to_string(),
            field: format!("{field}.containerKey"),
            message: "containerKey must be a non-empty string".to_string(),
        });
    }
    if let Some(entry_path) = location.get("entryPath") {
        let Some(entry_path) = entry_path.as_array() else {
            failures.push(AssetInventoryValidationFailure {
                code: "invalid_source_location".to_string(),
                field: format!("{field}.entryPath"),
                message: "entryPath must be an array of non-empty strings".to_string(),
            });
            return;
        };
        for (index, entry) in entry_path.iter().enumerate() {
            if entry.as_str().map_or("", str::trim).is_empty() {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_source_location".to_string(),
                    field: format!("{field}.entryPath.{index}"),
                    message: "entryPath entries must be non-empty strings".to_string(),
                });
            }
        }
    }
    if let Some(range) = location.get("range") {
        validate_asset_inventory_u64_object_fields(
            failures,
            &format!("{field}.range"),
            range,
            &["startByte", "endByte"],
        );
    }
    if let Some(region) = location.get("region") {
        validate_asset_inventory_u64_object_fields(
            failures,
            &format!("{field}.region"),
            region,
            &["x", "y", "width", "height"],
        );
    }
}

pub(crate) fn validate_asset_inventory_u64_object_fields(
    failures: &mut Vec<AssetInventoryValidationFailure>,
    field: &str,
    value: &Value,
    expected_fields: &[&str],
) {
    let Some(object) = value.as_object() else {
        failures.push(AssetInventoryValidationFailure {
            code: "invalid_source_location".to_string(),
            field: field.to_string(),
            message: format!("{field} must be a JSON object"),
        });
        return;
    };
    for key in object.keys() {
        if !expected_fields.contains(&key.as_str()) {
            failures.push(AssetInventoryValidationFailure {
                code: "invalid_source_location".to_string(),
                field: format!("{field}.{key}"),
                message: format!(
                    "{field} must only contain fields: {}",
                    expected_fields.join(", ")
                ),
            });
        }
    }
    for expected in expected_fields {
        if object.get(*expected).and_then(Value::as_u64).is_none() {
            failures.push(AssetInventoryValidationFailure {
                code: "invalid_source_location".to_string(),
                field: format!("{field}.{expected}"),
                message: format!("{field}.{expected} must be an unsigned integer"),
            });
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryAsset {
    pub asset_id: String,
    pub asset_key: String,
    pub asset_kind: AssetInventoryAssetKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetInventoryAssetKind {
    Script,
    Image,
    Audio,
    Video,
    UiTexture,
    Font,
    Database,
    Metadata,
    Text,
    Archive,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventorySurface {
    pub surface_id: String,
    pub asset_surface_kind: AssetInventorySurfaceKind,
    pub source_asset_ref: AssetInventoryAssetRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
    pub text_source_kind: AssetInventoryTextSourceKind,
    pub patch_mode: AssetInventoryPatchMode,
    pub patching: CapabilityReport,
    /// the patch payload (a translation/edit) this surface advertises
    /// if any. A surface that carries a payload is claiming to edit its backing
    /// asset; the patch-capability validator rejects a payload whose `patching`
    /// capability is unsupported (a manifest cannot patch an asset it declares it
    /// cannot edit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_payload: Option<AssetInventoryPatchPayload>,
    /// stable, tamper-evident hash over this surface's inventory
    /// IDENTITY + PATCH-DECISION fields (see [`asset_inventory_surface_metadata_hash`]).
    /// When present, the patch-capability validator recomputes the hash and emits
    /// a `metadata_hash_mismatch` diagnostic if the declared hash has drifted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_hash: Option<String>,
    pub notes: Vec<String>,
}

/// a patch payload advertised for an asset surface — the concrete
/// translation/edit the manifest claims it will apply to the surface's backing
/// asset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryPatchPayload {
    /// BCP 47-style locale the payload targets (e.g. `en-US`).
    pub target_locale: String,
    /// The translated/edited text the manifest advertises for this surface.
    pub translated_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryAssetRef {
    pub asset_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetInventorySurfaceKind {
    ImageText,
    UiArt,
    SongTitle,
    Font,
    Credits,
    Video,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetInventoryTextSourceKind {
    Metadata,
    ManualTranscription,
    OcrHint,
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetInventoryPatchMode {
    MetadataOnly,
    NoPatchRequired,
    RegionRedrawRequired,
    AssetReplacementRequired,
    FontSubstitutionRequired,
    Unsupported,
}
