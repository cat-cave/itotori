//! Real Softpal extract / patch-back / verify, wiring the deterministic
//! `kaifuu-softpal` reader (PAC container + `TEXT.DAT` codec + `SCRIPT.SRC`
//! disassembler + patch-back) into the [`SoftpalProfileDetectorAdapter`] so the
//! registry adapter is a **first-class extract/patch engine**, not identify-only.
//!
//! Scope (config-driven, dialogue + choices — the alpha default): the two
//! text-bearing `SCRIPT.SRC` surfaces the disassembler recovers — TEXT-SHOW
//! (dialogue, with its resolved speaker attached as context) and text-bearing
//! SELECT (choice labels). Every unit keys by its decrypted-`TEXT.DAT` record
//! **pointer** (`softpal:dialogue:<ptr>` / `softpal:choice:<ptr>`), the exact
//! record patch-back rebuilds, so a `PatchExport` round-trips back to the same
//! record with no id drift. Non-text SELECTs (system/branch immediates), the
//! full `Sv20` opcode table, and PAC repack stay out of scope (separate nodes).
//!
//! Real bytes, no shell-outs: everything runs in-process over the extracted
//! `SCRIPT.SRC` / `TEXT.DAT` byte slices via `kaifuu-softpal`.

use std::path::PathBuf;

use std::collections::BTreeMap;

use kaifuu_core::{
    ASSET_INVENTORY_SCHEMA_VERSION, AdapterWarning, AssetInventoryAsset, AssetInventoryAssetKind,
    AssetInventoryManifest, AssetKind, AssetList, AssetProfile, BridgeBundle, BridgeUnit,
    CapabilityReport, PatchRef, TextSurface, sha256_hash_bytes,
};
use kaifuu_softpal::{PacArchive, ScriptScan, TextDat, TranslationMap, patchback};

use super::*;

/// The `SCRIPT.SRC` + `TEXT.DAT` raw byte pair for a Softpal title, plus a
/// short human-readable note of where they were sourced (a loose pair or the
/// PAC archive that carried them).
pub(super) struct SoftpalScripts {
    pub script: Vec<u8>,
    pub textdat: Vec<u8>,
    pub source_ref: String,
}

/// `source_unit_key` prefix for a TEXT-SHOW dialogue record.
const DIALOGUE_KEY_PREFIX: &str = "softpal:dialogue:";
/// `source_unit_key` prefix for a text-bearing SELECT (choice label) record.
const CHOICE_KEY_PREFIX: &str = "softpal:choice:";
/// The stable bridge asset id every Softpal text unit patches back through.
const SCRIPT_ASSET_ID: &str = "softpal:SCRIPT.SRC";

impl SoftpalProfileDetectorAdapter {
    /// Resolve the title's `SCRIPT.SRC` + `TEXT.DAT` raw bytes from `game_dir`:
    /// a loose pair if both are present, otherwise the `data.pac` (or any
    /// `.pac` whose table names them). Deterministic; never shells out.
    /// # Errors
    /// [`std::io::Error`] on read failure, or a typed diagnostic when no
    /// Softpal script pair can be located / extracted.
    pub(super) fn resolve_scripts(game_dir: &Path) -> KaifuuResult<SoftpalScripts> {
        let loose_script =
            case_insensitive_find(game_dir, SOFTPAL_SCRIPT_SRC_NAME).filter(|path| path.is_file());
        let loose_text =
            case_insensitive_find(game_dir, SOFTPAL_TEXT_DAT_NAME).filter(|path| path.is_file());
        if let (Some(script_path), Some(text_path)) = (&loose_script, &loose_text) {
            let script = fs::read(script_path)?;
            let textdat = fs::read(text_path)?;
            // The loose pair only wins when it decodes; otherwise fall through
            // to the PAC (a stray same-named file is never trusted blindly).
            if ScriptScan::parse(&script).is_ok() && TextDat::parse(&textdat).is_ok() {
                return Ok(SoftpalScripts {
                    script,
                    textdat,
                    source_ref: SOFTPAL_SCRIPT_SRC_NAME.to_string(),
                });
            }
        }

        if let Some(scripts) = Self::pac_scripts_bytes(game_dir)? {
            return Ok(scripts);
        }

        Err(Self::diagnostic_error(Self::unsupported_failure(
            SemanticErrorCode::MissingContainerCapability,
            Capability::ContainerAccess,
            "softpal",
            SOFTPAL_DATA_PAC_NAME,
            "no loose SCRIPT.SRC/TEXT.DAT pair and no PAC archive listing them was found",
            "run extract against a Softpal title root containing data.pac (or a loose SCRIPT.SRC + TEXT.DAT)",
        )))
    }

    /// Locate a `.pac` whose file table names both `SCRIPT.SRC` and `TEXT.DAT`,
    /// parse it, and slice the two entries' bytes out. `data.pac` is probed
    /// first. Returns `None` when no PAC carries the script pair.
    fn pac_scripts_bytes(game_dir: &Path) -> KaifuuResult<Option<SoftpalScripts>> {
        let Ok(entries) = fs::read_dir(game_dir) else {
            return Ok(None);
        };
        let mut pac_paths: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.is_file()
                    && path
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("pac"))
            })
            .collect();
        pac_paths.sort();
        pac_paths.sort_by_key(|path| {
            !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case(SOFTPAL_DATA_PAC_NAME))
        });

        for path in pac_paths {
            let bytes = fs::read(&path)?;
            let Ok(archive) = PacArchive::parse(&bytes) else {
                continue;
            };
            let (Some(script_entry), Some(text_entry)) = (
                archive.find(SOFTPAL_SCRIPT_SRC_NAME),
                archive.find(SOFTPAL_TEXT_DAT_NAME),
            ) else {
                continue;
            };
            let script = archive
                .extract(&bytes, script_entry)
                .map_err(|err| -> Box<dyn std::error::Error> {
                    format!("kaifuu.softpal.pac.extract SCRIPT.SRC: {err}").into()
                })?
                .to_vec();
            let textdat = archive
                .extract(&bytes, text_entry)
                .map_err(|err| -> Box<dyn std::error::Error> {
                    format!("kaifuu.softpal.pac.extract TEXT.DAT: {err}").into()
                })?
                .to_vec();
            let source_ref = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(SOFTPAL_DATA_PAC_NAME)
                .to_string();
            return Ok(Some(SoftpalScripts {
                script,
                textdat,
                source_ref,
            }));
        }
        Ok(None)
    }

    /// Disassemble the resolved scripts and assemble the localization
    /// [`BridgeBundle`]: one unit per unique resolved `TEXT.DAT` record for the
    /// dialogue + text-bearing-choice surfaces, keyed by pointer for patch-back.
    pub(super) fn build_bridge(
        scripts: &SoftpalScripts,
    ) -> KaifuuResult<(BridgeBundle, Vec<AdapterWarning>)> {
        let scan =
            ScriptScan::parse(&scripts.script).map_err(|err| -> Box<dyn std::error::Error> {
                format!("kaifuu.softpal.script.parse: {err}").into()
            })?;
        let textdat =
            TextDat::parse(&scripts.textdat).map_err(|err| -> Box<dyn std::error::Error> {
                format!("kaifuu.softpal.textdat.parse: {err}").into()
            })?;
        let disassembly = scan.resolve(&textdat);

        let mut units: Vec<BridgeUnit> = Vec::new();
        let mut seen: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
        for dialogue in &disassembly.dialogue {
            let Some(text) = dialogue.text.resolved_text() else {
                continue;
            };
            if !seen.insert(dialogue.text.pointer) {
                continue;
            }
            let speaker = dialogue
                .speaker
                .as_ref()
                .and_then(|s| s.resolved_text())
                .unwrap_or_default()
                .to_string();
            units.push(Self::text_unit(
                DIALOGUE_KEY_PREFIX,
                dialogue.text.pointer,
                text,
                speaker,
                "dialogue",
            ));
        }
        let mut choice_seen: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
        for choice in &disassembly.choices {
            let Some(text) = choice.text.resolved_text() else {
                continue;
            };
            if !choice_seen.insert(choice.text.pointer) {
                continue;
            }
            units.push(Self::text_unit(
                CHOICE_KEY_PREFIX,
                choice.text.pointer,
                text,
                String::new(),
                "choice_label",
            ));
        }

        // A dangling pointer (inside the pool, off a record boundary) is a
        // decode-integrity failure; on real bytes it is 0. Surface it as a
        // warning rather than silently dropping the affected line.
        let mut warnings = Vec::new();
        let dangling = disassembly.dangling_pointer_count();
        if dangling > 0 {
            warnings.push(AdapterWarning {
                code: "kaifuu.softpal.dangling_pointers".to_string(),
                message: format!(
                    "{dangling} TEXT.DAT pointer(s) fell inside the record pool but missed a \
                     record boundary; those lines were not emitted as units"
                ),
            });
        }

        let bridge = BridgeBundle {
            schema_version: "0.1.0".to_string(),
            bridge_id: deterministic_id("softpal-bridge", units.len()),
            source_bundle_hash: sha256_hash_bytes(&scripts.script),
            source_locale: "ja-JP".to_string(),
            extractor_name: "kaifuu-softpal".to_string(),
            extractor_version: env!("CARGO_PKG_VERSION").to_string(),
            units,
        };
        Ok((bridge, warnings))
    }

    fn text_unit(
        prefix: &str,
        pointer: u32,
        text: &str,
        speaker: String,
        text_surface: &str,
    ) -> BridgeUnit {
        let source_unit_key = format!("{prefix}{pointer}");
        BridgeUnit {
            bridge_unit_id: deterministic_id(&source_unit_key, pointer as usize),
            occurrence_id: source_unit_key.clone(),
            source_hash: content_hash(text),
            source_locale: "ja-JP".to_string(),
            source_text: text.to_string(),
            speaker,
            text_surface: text_surface.to_string(),
            protected_spans: vec![],
            patch_ref: PatchRef {
                asset_id: SCRIPT_ASSET_ID.to_string(),
                write_mode: "replace".to_string(),
                source_unit_key: source_unit_key.clone(),
            },
            source_unit_key,
        }
    }

    /// Parse a `softpal:dialogue:<ptr>` / `softpal:choice:<ptr>` unit key back to
    /// its `TEXT.DAT` record pointer.
    fn pointer_from_key(source_unit_key: &str) -> Option<u32> {
        source_unit_key
            .strip_prefix(DIALOGUE_KEY_PREFIX)
            .or_else(|| source_unit_key.strip_prefix(CHOICE_KEY_PREFIX))
            .and_then(|rest| rest.parse::<u32>().ok())
    }

    /// Run the real dialogue/choice patch-back: map every `PatchExport` entry
    /// back to its `TEXT.DAT` record pointer, rebuild `TEXT.DAT` + repoint
    /// `SCRIPT.SRC` via `kaifuu-softpal`, and drop both as loose files into
    /// `output_dir`. Unknown/stale entries are typed failures, never silent.
    pub(super) fn run_patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let patch_export_id = request.patch_export.patch_export_id.clone();
        let scripts = Self::resolve_scripts(request.game_dir)?;
        let textdat =
            TextDat::parse(&scripts.textdat).map_err(|err| -> Box<dyn std::error::Error> {
                format!("kaifuu.softpal.textdat.parse: {err}").into()
            })?;
        let valid_offsets: std::collections::BTreeSet<u32> = textdat
            .records
            .iter()
            .filter_map(|record| u32::try_from(record.offset).ok())
            .collect();

        let failed = |failures: Vec<AdapterFailure>| PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("softpal-patch", 12),
            patch_export_id: patch_export_id.clone(),
            status: OperationStatus::Failed,
            output_hash: content_hash(SOFTPAL_SUPPORT_BOUNDARY),
            failures,
        };

        let mut translations = TranslationMap::new();
        let mut failures = Vec::new();
        for entry in &request.patch_export.entries {
            match Self::pointer_from_key(&entry.source_unit_key) {
                Some(pointer) if valid_offsets.contains(&pointer) => {
                    translations.insert(pointer, entry.target_text.clone());
                }
                _ => failures.push(Self::unsupported_failure(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    Capability::PatchBack,
                    "softpal",
                    entry.source_unit_key.clone(),
                    "PatchExportEntry sourceUnitKey does not resolve to a TEXT.DAT record pointer in this title",
                    "re-extract the bridge bundle before re-applying this patch",
                )),
            }
        }
        if !failures.is_empty() {
            return Ok(failed(failures));
        }

        let produced = match patchback(&scripts.textdat, &scripts.script, &translations) {
            Ok(produced) => produced,
            Err(err) => {
                return Ok(failed(vec![Self::unsupported_failure(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    Capability::PatchBack,
                    "softpal",
                    SOFTPAL_SCRIPT_SRC_NAME,
                    format!("kaifuu.softpal.patchback failed: {err}"),
                    "verify every replacement encodes in cp932/Shift-JIS",
                )]));
            }
        };
        produced.write_loose_files(request.output_dir).map_err(
            |err| -> Box<dyn std::error::Error> {
                format!("kaifuu.softpal.patchback.write: {err}").into()
            },
        )?;

        let mut hash_input = produced.textdat.clone();
        hash_input.extend_from_slice(&produced.script);
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("softpal-patch", 12),
            patch_export_id,
            status: OperationStatus::Passed,
            output_hash: sha256_hash_bytes(&hash_input),
            failures: vec![],
        })
    }

    /// Re-decode the resolved scripts and assert the decode-integrity bar
    /// (0 dangling pointers, every dialogue line + present speaker resolved).
    pub(super) fn run_verify(
        &self,
        request: VerifyRequest<'_>,
    ) -> KaifuuResult<VerificationResult> {
        let scripts = Self::resolve_scripts(request.game_dir)?;
        let scan =
            ScriptScan::parse(&scripts.script).map_err(|err| -> Box<dyn std::error::Error> {
                format!("kaifuu.softpal.script.parse: {err}").into()
            })?;
        let textdat =
            TextDat::parse(&scripts.textdat).map_err(|err| -> Box<dyn std::error::Error> {
                format!("kaifuu.softpal.textdat.parse: {err}").into()
            })?;
        let disassembly = scan.resolve(&textdat);
        let dangling = disassembly.dangling_pointer_count();
        let unresolved_dialogue = disassembly.unresolved_dialogue_text_count();
        let unresolved_speaker = disassembly.unresolved_speaker_count();
        let mut failures = Vec::new();
        if dangling > 0 || unresolved_dialogue > 0 || unresolved_speaker > 0 {
            failures.push(Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::Verification,
                "softpal",
                scripts.source_ref.clone(),
                format!(
                    "decode-integrity check failed: {dangling} dangling pointer(s), \
                     {unresolved_dialogue} unresolved dialogue line(s), \
                     {unresolved_speaker} unresolved speaker name(s)"
                ),
                "re-extract from an intact Softpal title; the disassembler expects 0 on real bytes",
            ));
        }
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("softpal-verify", 12),
            status: if failures.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            output_hash: sha256_hash_bytes(&scripts.script),
            failures,
        })
    }

    /// Enumerate the title's assets: the full PAC entry table when a `.pac`
    /// carries the scripts, otherwise the loose `SCRIPT.SRC` + `TEXT.DAT` pair.
    /// Each is `(entry_name, kind)`. Deterministic; never shells out.
    fn asset_entries(game_dir: &Path) -> KaifuuResult<Vec<(String, AssetInventoryAssetKind)>> {
        if let Ok(entries) = fs::read_dir(game_dir) {
            let mut pac_paths: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.is_file()
                        && path
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("pac"))
                })
                .collect();
            pac_paths.sort();
            pac_paths.sort_by_key(|path| {
                !path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case(SOFTPAL_DATA_PAC_NAME))
            });
            for path in pac_paths {
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
    pub(super) fn build_asset_list(&self, game_dir: &Path) -> KaifuuResult<AssetList> {
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
                        vec![TextSurface::Dialogue, TextSurface::ChoiceLabel, TextSurface::SpeakerName]
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
    pub(super) fn build_asset_inventory(
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
