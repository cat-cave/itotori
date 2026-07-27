use super::*;

/// a typed diagnostic for a patch-capability inconsistency in an
/// asset inventory manifest. Emitted (never a silent pass or panic) when a
/// manifest would imply an unsupported asset edit or its identity/patch
/// metadata hash has drifted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum AssetCapabilityDiagnostic {
    /// A surface advertises a patch payload (a translation/edit) for an asset
    /// whose patch capability is UNSUPPORTED. The manifest cannot claim to patch
    /// an asset it declares it cannot edit.
    #[serde(rename = "unsupported_asset_patched")]
    UnsupportedAssetPatched {
        surface_id: String,
        asset_id: String,
        asset_ref: String,
        required_capability: Capability,
        support_boundary: String,
    },
    /// A surface's declared metadata hash does not match the hash recomputed from
    /// its identity + patch-decision fields — the identity/patch capability has
    /// been tampered with or has drifted from what was committed.
    #[serde(rename = "metadata_hash_mismatch")]
    MetadataHashMismatch {
        surface_id: String,
        asset_id: String,
        declared_hash: String,
        computed_hash: String,
    },
}

impl AssetCapabilityDiagnostic {
    /// The stable diagnostic code (matches the serde tag).
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedAssetPatched { .. } => "unsupported_asset_patched",
            Self::MetadataHashMismatch { .. } => "metadata_hash_mismatch",
        }
    }

    /// The surface the diagnostic is keyed on.
    pub fn surface_id(&self) -> &str {
        match self {
            Self::UnsupportedAssetPatched { surface_id, .. }
            | Self::MetadataHashMismatch { surface_id, .. } => surface_id,
        }
    }
}

/// whether a surface's declared patch capability forbids editing its
/// backing asset. A surface is unsupported when its `patching` capability status
/// is `Unsupported` OR its `patch_mode` is `Unsupported`.
pub(crate) fn asset_surface_patch_unsupported(surface: &AssetInventorySurface) -> bool {
    surface.patching.status == CapabilityStatus::Unsupported
        || surface.patch_mode == AssetInventoryPatchMode::Unsupported
}

/// the patch-capability consistency validator.
/// Returns one typed [`AssetCapabilityDiagnostic`] per inconsistency:
/// * `unsupported_asset_patched` — a surface advertises a [`AssetInventoryPatchPayload`]
///   for an asset whose patch capability is unsupported (a manifest cannot patch
///   an asset it declares it cannot edit).
/// * `metadata_hash_mismatch` — a surface declares a `metadata_hash` that does
///   not match the hash recomputed from its identity + patch-decision fields.
///   A manifest with a non-empty result is REJECTED (see
///   [`AssetInventoryManifest::validate_patch_capability`]). This is a pure
///   function of the manifest; diagnostics are returned in a deterministic order.
pub fn validate_asset_inventory_patch_capability(
    manifest: &AssetInventoryManifest,
) -> Vec<AssetCapabilityDiagnostic> {
    let asset_key_by_id: BTreeMap<&str, &str> = manifest
        .assets
        .iter()
        .map(|asset| (asset.asset_id.as_str(), asset.asset_key.as_str()))
        .collect();

    let mut diagnostics = Vec::new();
    for surface in &manifest.surfaces {
        let asset_id = surface.source_asset_ref.asset_id.clone();

        if let Some(declared) = &surface.metadata_hash {
            let computed = asset_inventory_surface_metadata_hash(manifest, surface);
            if declared != &computed {
                diagnostics.push(AssetCapabilityDiagnostic::MetadataHashMismatch {
                    surface_id: surface.surface_id.clone(),
                    asset_id: asset_id.clone(),
                    declared_hash: declared.clone(),
                    computed_hash: computed,
                });
            }
        }

        if surface.patch_payload.is_some() && asset_surface_patch_unsupported(surface) {
            let asset_ref = surface
                .source_asset_ref
                .asset_key
                .clone()
                .or_else(|| {
                    asset_key_by_id
                        .get(asset_id.as_str())
                        .map(|key| (*key).to_string())
                })
                .unwrap_or_else(|| asset_id.clone());
            let support_boundary = surface.patching.limitation.clone().unwrap_or_else(|| {
                format!(
                    "adapter reports surface {} as patch-capability-unsupported; it must not advertise a patch payload",
                    surface.surface_id
                )
            });
            diagnostics.push(AssetCapabilityDiagnostic::UnsupportedAssetPatched {
                surface_id: surface.surface_id.clone(),
                asset_id,
                asset_ref,
                required_capability: surface.patching.capability.clone(),
                support_boundary,
            });
        }
    }

    diagnostics.sort_by(|a, b| (a.code(), a.surface_id()).cmp(&(b.code(), b.surface_id())));
    diagnostics
}

/// the two synthetic assets the patch-capability fixtures share
/// a patchable audio asset (a metadata song title) and an unpatchable binary
/// art asset.
pub(crate) fn asset_inventory_patch_capability_fixture_assets() -> Vec<AssetInventoryAsset> {
    vec![
        AssetInventoryAsset {
            asset_id: "asset-song".to_string(),
            asset_key: "audio/theme".to_string(),
            asset_kind: AssetInventoryAssetKind::Audio,
            path: Some("audio/theme.ogg".to_string()),
            source_hash: Some(content_hash("audio/theme")),
            metadata: BTreeMap::new(),
        },
        AssetInventoryAsset {
            asset_id: "asset-logo".to_string(),
            asset_key: "art/logo".to_string(),
            asset_kind: AssetInventoryAssetKind::Image,
            path: Some("art/logo.png".to_string()),
            source_hash: Some(content_hash("art/logo")),
            metadata: BTreeMap::new(),
        },
    ]
}

/// A supported (patchable) song-title surface that advertises a patch payload.
pub(crate) fn asset_inventory_patch_capability_fixture_supported_surface(
    patch_payload: Option<AssetInventoryPatchPayload>,
) -> AssetInventorySurface {
    AssetInventorySurface {
        surface_id: "surface-song-title".to_string(),
        asset_surface_kind: AssetInventorySurfaceKind::SongTitle,
        source_asset_ref: AssetInventoryAssetRef {
            asset_id: "asset-song".to_string(),
            asset_key: Some("audio/theme".to_string()),
        },
        source_location: None,
        source_text: Some("テーマ曲".to_string()),
        source_hash: Some(content_hash("テーマ曲")),
        text_source_kind: AssetInventoryTextSourceKind::Metadata,
        patch_mode: AssetInventoryPatchMode::MetadataOnly,
        patching: CapabilityReport::supported(Capability::AssetTextPatching),
        patch_payload,
        metadata_hash: None,
        notes: vec![],
    }
}

/// An unsupported (unpatchable) binary-art surface. `patch_payload` is populated
/// only by the negative fixture that advertises an edit it cannot honour.
pub(crate) fn asset_inventory_patch_capability_fixture_unsupported_surface(
    patch_payload: Option<AssetInventoryPatchPayload>,
) -> AssetInventorySurface {
    AssetInventorySurface {
        surface_id: "surface-logo-art".to_string(),
        asset_surface_kind: AssetInventorySurfaceKind::UiArt,
        source_asset_ref: AssetInventoryAssetRef {
            asset_id: "asset-logo".to_string(),
            asset_key: Some("art/logo".to_string()),
        },
        source_location: None,
        source_text: None,
        source_hash: Some(content_hash("art/logo")),
        text_source_kind: AssetInventoryTextSourceKind::NotApplicable,
        patch_mode: AssetInventoryPatchMode::AssetReplacementRequired,
        patching: CapabilityReport::unsupported(
            Capability::NonTextSurfaceExtraction,
            "fixture adapter cannot redraw or replace binary art assets",
        ),
        patch_payload,
        metadata_hash: None,
        notes: vec![],
    }
}

pub(crate) fn asset_inventory_patch_capability_fixture_manifest(
    manifest_id: &str,
    surfaces: Vec<AssetInventorySurface>,
) -> AssetInventoryManifest {
    let mut manifest = AssetInventoryManifest {
        schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
        manifest_id: manifest_id.to_string(),
        adapter_id: "kaifuu.fixture.asset-capability".to_string(),
        source_locale: "ja-JP".to_string(),
        assets: asset_inventory_patch_capability_fixture_assets(),
        surfaces,
        capabilities: vec![CapabilityReport::supported(Capability::AssetInventory)],
        warnings: vec![],
        metadata: BTreeMap::new(),
    };
    manifest.normalize();
    manifest.stamp_asset_metadata_hashes();
    manifest
}

/// POSITIVE fixture: a consistent manifest. The supported song-title
/// surface advertises a patch payload (allowed — its capability is supported);
/// the unsupported art surface advertises no payload. Every surface carries a
/// correct, stamped metadata hash. Passes both base validation and the
/// patch-capability validator (zero diagnostics).
pub fn asset_inventory_patch_capability_positive_fixture() -> AssetInventoryManifest {
    asset_inventory_patch_capability_fixture_manifest(
        "asset-capability-positive",
        vec![
            asset_inventory_patch_capability_fixture_supported_surface(Some(
                AssetInventoryPatchPayload {
                    target_locale: "en-US".to_string(),
                    translated_text: "Theme Song".to_string(),
                },
            )),
            asset_inventory_patch_capability_fixture_unsupported_surface(None),
        ],
    )
}

/// NEGATIVE fixture (unsupported-asset-patched): the unsupported art
/// surface advertises a patch payload for an asset it declares it cannot edit.
/// Base validation passes; the patch-capability validator REJECTS it with a
/// typed `unsupported_asset_patched` diagnostic.
pub fn asset_inventory_patch_capability_unsupported_patched_fixture() -> AssetInventoryManifest {
    asset_inventory_patch_capability_fixture_manifest(
        "asset-capability-unsupported-patched",
        vec![
            asset_inventory_patch_capability_fixture_supported_surface(None),
            asset_inventory_patch_capability_fixture_unsupported_surface(Some(
                AssetInventoryPatchPayload {
                    target_locale: "en-US".to_string(),
                    translated_text: "Logo (EN)".to_string(),
                },
            )),
        ],
    )
}

/// NEGATIVE fixture (metadata-hash mismatch): a structurally valid
/// manifest whose supported surface declares a metadata hash that does not match
/// its identity + patch-decision fields (tampered/drifted). Base validation
/// passes; the patch-capability validator REJECTS it with a typed
/// `metadata_hash_mismatch` diagnostic.
pub fn asset_inventory_metadata_hash_mismatch_fixture() -> AssetInventoryManifest {
    let mut manifest = asset_inventory_patch_capability_fixture_manifest(
        "asset-capability-hash-mismatch",
        vec![
            asset_inventory_patch_capability_fixture_supported_surface(None),
            asset_inventory_patch_capability_fixture_unsupported_surface(None),
        ],
    );
    for surface in &mut manifest.surfaces {
        if surface.surface_id == "surface-song-title" {
            surface.metadata_hash = Some(format!("sha256:{}", "0".repeat(64)));
        }
    }
    manifest
}
