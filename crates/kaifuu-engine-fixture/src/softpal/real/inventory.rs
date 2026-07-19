//! Softpal `list-assets` / `asset-inventory`: enumerate the PAC entry table
//! (or the loose `SCRIPT.SRC` + `TEXT.DAT` pair), classified by kind. Text
//! extraction/patch is only claimed for the script/text surfaces; other
//! entries are catalogued only.

use std::collections::BTreeMap;
use std::path::Path;

use kaifuu_core::{
    ASSET_INVENTORY_SCHEMA_VERSION, AssetInventoryAsset, AssetInventoryAssetKind,
    AssetInventoryManifest, AssetKind, AssetList, AssetProfile, CapabilityReport, TextSurface,
};
use kaifuu_softpal::PacArchive;

use super::*;

impl SoftpalProfileDetectorAdapter {
    /// Enumerate the title's assets: the full PAC entry table when a `.pac`
    /// carries the scripts, otherwise the loose `SCRIPT.SRC` + `TEXT.DAT` pair.
    /// Each is `(entry_name, kind)`. Deterministic; never shells out.
    fn asset_entries(game_dir: &Path) -> KaifuuResult<Vec<(String, AssetInventoryAssetKind)>> {
        for path in Self::sorted_pac_paths(game_dir) {
            let bytes = fs::read(&path)?;
            let Ok(archive) = PacArchive::parse(&bytes) else {
                continue;
            };
            if archive.find(SOFTPAL_SCRIPT_SRC_NAME).is_none() {
                continue;
            }
            return Ok(archive
                .entries()
                .iter()
                .map(|entry| (entry.name.clone(), classify_asset_kind(&entry.name)))
                .collect());
        }

        let mut loose = Vec::new();
        if case_insensitive_find(game_dir, SOFTPAL_SCRIPT_SRC_NAME).is_some_and(|p| p.is_file()) {
            loose.push((
                SOFTPAL_SCRIPT_SRC_NAME.to_string(),
                AssetInventoryAssetKind::Script,
            ));
        }
        if case_insensitive_find(game_dir, SOFTPAL_TEXT_DAT_NAME).is_some_and(|p| p.is_file()) {
            loose.push((
                SOFTPAL_TEXT_DAT_NAME.to_string(),
                AssetInventoryAssetKind::Text,
            ));
        }
        Ok(loose)
    }

    /// Build the [`AssetList`] surface: the `SCRIPT.SRC` script asset (dialogue +
    /// choice text surfaces, patch-back Limited) plus the `TEXT.DAT` string pool.
    pub(crate) fn build_asset_list(&self, game_dir: &Path) -> KaifuuResult<AssetList> {
        let entries = Self::asset_entries(game_dir)?;
        let assets = entries
            .iter()
            .filter(|(name, _)| {
                name.eq_ignore_ascii_case(SOFTPAL_SCRIPT_SRC_NAME)
                    || name.eq_ignore_ascii_case(SOFTPAL_TEXT_DAT_NAME)
            })
            .map(|(name, _)| {
                let is_script = name.eq_ignore_ascii_case(SOFTPAL_SCRIPT_SRC_NAME);
                AssetProfile {
                    asset_id: format!("softpal:{name}"),
                    path: name.clone(),
                    asset_kind: AssetKind::Script,
                    text_surfaces: if is_script {
                        vec![
                            TextSurface::Dialogue,
                            TextSurface::ChoiceLabel,
                            TextSurface::SpeakerName,
                        ]
                    } else {
                        vec![TextSurface::Dialogue]
                    },
                    source_hash: None,
                    patching: CapabilityReport::limited(
                        Capability::AssetTextPatching,
                        "dialogue + choice text is patched back by rebuilding TEXT.DAT and repointing SCRIPT.SRC as loose files; PAC repack and non-text surfaces are not claimed",
                    ),
                }
            })
            .collect();
        Ok(AssetList {
            adapter_id: SOFTPAL_DETECTOR_ADAPTER_ID.to_string(),
            assets,
        })
    }

    /// Build the [`AssetInventoryManifest`]: every PAC entry (or the loose script
    /// pair), classified by kind. Text extraction/patch is only claimed for the
    /// `SCRIPT.SRC`/`TEXT.DAT` surfaces; other entries are catalogued only.
    pub(crate) fn build_asset_inventory(
        &self,
        game_dir: &Path,
    ) -> KaifuuResult<AssetInventoryManifest> {
        let entries = Self::asset_entries(game_dir)?;
        let assets = entries
            .iter()
            .map(|(name, kind)| AssetInventoryAsset {
                asset_id: format!("softpal:{name}"),
                asset_key: name.clone(),
                asset_kind: kind.clone(),
                path: Some(name.clone()),
                source_hash: None,
                metadata: BTreeMap::new(),
            })
            .collect();
        let mut metadata = BTreeMap::new();
        metadata.insert("engineFamily".to_string(), "softpal".to_string());
        metadata.insert(
            "supportBoundary".to_string(),
            SOFTPAL_SUPPORT_BOUNDARY.to_string(),
        );
        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("softpal-asset-inventory", 1),
            adapter_id: SOFTPAL_DETECTOR_ADAPTER_ID.to_string(),
            source_locale: "ja-JP".to_string(),
            assets,
            surfaces: vec![],
            capabilities: self.capabilities().reports,
            warnings: vec![],
            metadata,
        };
        manifest.normalize();
        Ok(manifest)
    }
}

/// Classify a Softpal PAC entry name to a coarse inventory kind by extension.
fn classify_asset_kind(name: &str) -> AssetInventoryAssetKind {
    let ext = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_uppercase)
        .unwrap_or_default();
    match ext.as_str() {
        "SRC" => AssetInventoryAssetKind::Script,
        "DAT" => AssetInventoryAssetKind::Text,
        "PGD" | "GRP" | "BMP" => AssetInventoryAssetKind::Image,
        "PGV" | "OGG" | "WAV" => AssetInventoryAssetKind::Audio,
        _ => AssetInventoryAssetKind::Unknown,
    }
}
