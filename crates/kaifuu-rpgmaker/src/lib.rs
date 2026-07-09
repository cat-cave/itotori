//! Pure-Rust RPG Maker MV/MZ `www/data/*.json` text-extraction adapter.
//!
//! This is the **real** (non-synthetic) RPG Maker MV/MZ extractor that
//! unblocks the ALPHA-001 second-engine-family vertical slice. It walks a
//! game's `www/data/*.json` corpus and emits a localization-bridge v0.2
//! [`BridgeBundleV02`] of translatable strings, each keyed by a stable
//! `rpgmaker:<file>#<json-pointer>` surface so re-extraction is
//! deterministic and patchback can target the same surface.
//!
//! # Surfaces handled
//!
//! - **Event-command lists** (`Map*.json events[].pages[].list[]`,
//!   `CommonEvents.json`, `Troops.json pages[].list[]`):
//!     * `401` Show Text line → `dialogue`
//!     * `405` Show Scrolling Text line → `narration`
//!     * `102` Show Choices option array → `choice_label`
//!     * `101` Show Text setup → message-group + MZ speaker context (the
//!       MZ 5th param is also emitted as a `speaker_name` unit)
//!     * `320`/`324`/`325` Change Name/Nickname/Profile literals →
//!       `database_entry`
//! - **Database name/description/message surfaces** in `Actors.json`,
//!   `Classes.json`, `Items.json`, `Weapons.json`, `Armors.json`,
//!   `Skills.json`, `Enemies.json`, `States.json` → `database_entry`.
//! - **`System.json`**: `gameTitle` (`metadata_text`), `currencyUnit`,
//!   `terms.{basic,params,commands,messages}`, and the
//!   `equipTypes`/`skillTypes`/`weaponTypes`/`armorTypes`/`elements` type
//!   lists → `ui_label`.
//! - **Inline `\`-control codes** (`\V[n]`, `\C[n]`, `\!`, …) inside every
//!   text surface → `control_markup` protected spans (`preserveMode =
//!   exact`).
//!
//! # 100% / no-silent-skip
//!
//! An event-command code that is recognised-but-non-text is skipped
//! silently (it carries no translatable text). A `Script` (355/655),
//! `Plugin Command` (356/357), or script-operand `Control Variables`
//! (122) entry — which *may* render text via a project plugin — and any
//! **unrecognised** command code are recorded as structured
//! [`Finding`]s, never silently dropped. Findings carry only structural
//! description (file, JSON-pointer, code) — never retail string content.
//!
//! # Determinism / no shell-outs
//!
//! Files are read in sorted order; all identifiers are SHA-256-derived.
//! No `Command::new`, no network, no helper process. Engine identification
//! reuses [`kaifuu_core::ArchiveDetectionReport::scan`]
//! (`detect_rpg_maker_mv_mz`).

mod bridge;
mod codes;
mod database_terms;
mod encrypted_asset_slice;
mod escape;
mod extract;
mod integration;
mod ids;
mod json_locate;
mod map_common_event;
mod media_surface;
mod patchback;
mod plugin_profile;
mod recognize;

use std::fs;
use std::path::Path;

use sha2::{Digest, Sha256};
use thiserror::Error;

use kaifuu_core::{ArchiveDetectionReport, ArchiveEngineFamily};

pub use bridge::{BridgeOpts, BridgeProduceError, FileAsset, ProducedBundle};
pub use codes::{CodeClass, TextRole, classify};
pub use database_terms::{
    DatabaseDiagnostic, DatabaseDiagnosticKind, DatabaseExtractError, DatabaseExtraction,
    DatabaseTermRole, DatabaseTranslation, FIXTURE_PROFILE_ID as K110_FIXTURE_PROFILE_ID,
    StableDatabaseUnit, UnitContainer, extract_database as extract_database_units,
    extract_database_file, extract_system as extract_system_units, extract_system_file,
    is_database_file as is_k110_database_file, patch_file as patch_database_file,
};
pub use encrypted_asset_slice::{
    EncryptedAssetSuffix, MV_MZ_SLICE_CRYPTO_PROFILE_ID, MV_MZ_SLICE_ENGINE_FAMILY,
    MV_MZ_SLICE_FIXTURE_ID, MV_MZ_SLICE_REQUIREMENT_ID, MV_MZ_SLICE_SCHEMA_VERSION,
    MV_MZ_SLICE_SOURCE_NODE_ID, MV_MZ_SLICE_SUPPORT_BOUNDARY, MV_MZ_SLICE_VARIANT, MediaCapability,
    MvMzKeySource, MvMzKeySourceKind, MvMzSliceDiagnostic, MvMzSliceEntryReport, MvMzSliceError,
    MvMzSliceInternalError, MvMzSliceOp, MvMzSliceOutcome, MvMzSliceReport, MvMzSliceVerifyProof,
    SlicePatchProof, SliceReplacement, SliceRoundTripProof, canonical_slice_fixture,
    run_mv_mz_slice, run_slice_op,
};
pub use escape::{EscapeSpan, scan_escape_spans};
pub use extract::{
    ExtractAcc, Finding, FindingKind, ProtoUnit, SurfaceKind, is_database_file, walk_common_events,
    walk_database, walk_map, walk_system, walk_troops,
};
pub use integration::{
    CapabilityLevel, CapabilityScope, ChangedFile, FindingRecord, FullSurfaceError,
    FullSurfaceExtraction, FullSurfaceExtractionManifest, FullSurfacePatch,
    FullSurfacePatchManifest, K112_FIXTURE_PROFILE_ID, K112_FULL_SURFACE_SCHEMA_VERSION,
    MediaAsset, MvMzCapabilityTuple, MvMzSurfaceRole, OutOfScope, PATCH_ESCAPING,
    PluginDiagnosticRecord, SCOPE_ENCRYPTED_MEDIA, SCOPE_JSON_TEXT, SCOPE_PLUGIN_JS_LOGIC,
    SCOPE_PLUGIN_PROFILE, SurfaceCoverage, extract_full_surface, patch_full_surface_trivial,
    role_for_data_key, trivial_target,
};
pub use json_locate::{LocateError, QuotedSpan, Scanner, encode_json_string_ascii_safe};
pub use map_common_event::{
    CommandContainer, CommandDiagnostic, CommandDiagnosticKind, CommandTextRole,
    CommandTranslation, FIXTURE_PROFILE_ID, MapExtractError, MapExtraction, StableCommandUnit,
    extract_common_events as extract_common_event_units, extract_common_events_file,
    extract_map as extract_map_units, extract_map_file, patch_file as patch_command_file,
};
pub use media_surface::{
    FailureClass, MEDIA_SURFACE_ENGINE_FAMILY, MEDIA_SURFACE_SCHEMA_VERSION,
    MEDIA_SURFACE_SOURCE_NODE_ID, MEDIA_SURFACE_SUPPORT_BOUNDARY, MediaAssetDecision,
    MediaAssetSurface, MediaDecryptState, MediaLocalizationRole, MediaManifestError,
    MediaSurfaceError, MediaSurfaceManifest, MediaSurfaceProfile, MediaSurfaceRule, PatchBackMode,
    ReplacementPlan, ReplacementProof, build_media_surface, commitment, plan_replacement,
};
pub use patchback::{
    JsonStringEscaping, PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE, PATCHBACK_DELTA_PRODUCE_CODE,
    PATCHBACK_IO_CODE, PATCHBACK_OVERLAPPING_SURFACES_CODE, PATCHBACK_STALE_SOURCE_CODE,
    PATCHBACK_SURFACE_KEY_MALFORMED_CODE, PATCHBACK_TARGET_EMPTY_CODE,
    PATCHBACK_UNRESOLVED_SURFACE_CODE, PATCHBACK_VERIFICATION_FAILED_CODE, PatchbackError,
    PatchbackOpts, ProducedDelta, TranslatedBundleV02, TranslatedUnitTarget,
    apply_translated_bundle, produce_delta_package,
};
pub use plugin_profile::{
    FIXTURE_PROFILE_ID as K111_FIXTURE_PROFILE_ID, PLUGINS_JS_FILE, Patchability, PluginDiagnostic,
    PluginDiagnosticKind, PluginExtractError, PluginExtraction, PluginParamPointer,
    PluginPatchError, PluginProfile, PluginTextRole, PluginTranslation, ProfiledPlugin,
    StablePluginTextUnit, extract_plugins as extract_plugin_units, extract_plugins_file,
    patch_file as patch_plugins_file,
};
pub use recognize::{RecognizedCommand, recognize_plugin_command};

/// Full result of the canonical game-directory extraction.
///
/// [`extract_game_dir`] is the only whole-game JSON extraction path consumed
/// by the CLI and the KAIFUU-112 full-surface integration. The KAIFUU-109 and
/// KAIFUU-110 APIs are focused, byte-preserving extraction / patch views for
/// individual files, not alternate game-directory bundle producers. This
/// keeps bridge-bundle semantics, findings, and directory traversal in one
/// production path.
#[derive(Debug, Clone)]
pub struct RpgMakerExtraction {
    /// The validated localization-bridge bundle (typed + raw JSON).
    pub bundle: ProducedBundle,
    /// Structured no-silent-skip findings (unknown / script / plugin
    /// surfaces requiring review). Empty if every surface was handled.
    pub findings: Vec<Finding>,
}

/// Fatal errors raised by [`extract_game_dir`].
#[derive(Debug, Error)]
pub enum ExtractError {
    #[error(
        "kaifuu.rpgmaker.not_rpg_maker: {path} is not detected as RPG Maker MV/MZ by archive detection"
    )]
    NotRpgMaker { path: String },
    #[error("kaifuu.rpgmaker.data_dir_missing: {path} has no data/ directory")]
    DataDirMissing { path: String },
    #[error("kaifuu.rpgmaker.io: {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("kaifuu.rpgmaker.json_parse: {file}: {source}")]
    JsonParse {
        file: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("kaifuu.rpgmaker.bridge: {0}")]
    Bridge(#[from] BridgeProduceError),
}

/// Walk a game's `www` directory and produce a bridge extraction bundle.
///
/// `www_dir` is the directory that contains `data/` (the env var
/// `ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ` points here for the LustMemory
/// corpus). Engine identification reuses the shared archive detection; a
/// directory that does not detect as RPG Maker MV/MZ is rejected rather
/// than blindly parsed.
pub fn extract_game_dir(
    www_dir: &Path,
    opts: &BridgeOpts<'_>,
) -> Result<RpgMakerExtraction, ExtractError> {
    let detection = ArchiveDetectionReport::scan(www_dir);
    let detected = detection
        .rows
        .iter()
        .any(|row| row.engine_family == ArchiveEngineFamily::RpgMakerMvMz && row.detected);
    if !detected {
        return Err(ExtractError::NotRpgMaker {
            path: www_dir.display().to_string(),
        });
    }

    let data_dir = www_dir.join("data");
    if !data_dir.is_dir() {
        return Err(ExtractError::DataDirMissing {
            path: www_dir.display().to_string(),
        });
    }

    // Deterministic file ordering.
    let mut json_files: Vec<(String, std::path::PathBuf)> = fs::read_dir(&data_dir)
        .map_err(|source| ExtractError::Io {
            path: data_dir.display().to_string(),
            source,
        })?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                let name = entry.file_name().to_string_lossy().into_owned();
                Some((name, path))
            } else {
                None
            }
        })
        .collect();
    json_files.sort();

    let mut acc = ExtractAcc::default();
    let mut assets: Vec<FileAsset> = Vec::new();

    for (file, path) in &json_files {
        let bytes = fs::read(path).map_err(|source| ExtractError::Io {
            path: path.display().to_string(),
            source,
        })?;
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|source| ExtractError::JsonParse {
                file: file.clone(),
                source,
            })?;
        let source_hash = sha256_canonical(&bytes);

        let units_before = acc.units.len();
        let asset_kind = dispatch_file(&mut acc, file, &value);
        let Some(asset_kind) = asset_kind else {
            continue;
        };
        // Only emit an asset for files that produced at least one unit.
        if acc.units.len() > units_before {
            assets.push(FileAsset {
                file: file.clone(),
                source_hash,
                asset_kind,
            });
        }
    }

    let bundle = bridge::produce_bundle(&acc.units, &assets, opts)?;
    Ok(RpgMakerExtraction {
        bundle,
        findings: acc.findings,
    })
}

/// Dispatch one data file to its walker. Returns the file's bridge asset
/// kind when it is a file the adapter extracts, or `None` to skip
/// (`MapInfos.json`, `Animations.json`, `Tilesets.json`, …).
fn dispatch_file(
    acc: &mut ExtractAcc,
    file: &str,
    value: &serde_json::Value,
) -> Option<&'static str> {
    if is_map_file(file) {
        walk_map(acc, file, value);
        Some("script")
    } else if file == "CommonEvents.json" {
        walk_common_events(acc, file, value);
        Some("script")
    } else if file == "Troops.json" {
        walk_troops(acc, file, value);
        Some("script")
    } else if file == "System.json" {
        walk_system(acc, file, value);
        Some("database")
    } else if is_database_file(file) {
        walk_database(acc, file, value);
        Some("database")
    } else {
        None
    }
}

/// `MapNNN.json` (digits only) — excludes `MapInfos.json`.
fn is_map_file(file: &str) -> bool {
    let Some(stem) = file.strip_suffix(".json") else {
        return false;
    };
    let Some(digits) = stem.strip_prefix("Map") else {
        return false;
    };
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

fn sha256_canonical(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in &digest {
        let _ = write!(hex, "{byte:02x}");
    }
    format!("sha256:{hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_file_name_matcher_excludes_mapinfos() {
        assert!(is_map_file("Map001.json"));
        assert!(is_map_file("Map163.json"));
        assert!(!is_map_file("MapInfos.json"));
        assert!(!is_map_file("CommonEvents.json"));
        assert!(!is_map_file("Map.json"));
    }
}
