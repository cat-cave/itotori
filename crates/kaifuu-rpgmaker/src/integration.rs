//! MV/MZ JSON full-surface golden integration.
//! The prior slices each proved a *single* MV/MZ text surface
//! (map + common-event, database + system + terms, plugin-profile). This
//! module is the **integration** that ties all six declared surfaces
//! together into one honest, deterministic pipeline over a whole game tree:
//! 1. [`extract_full_surface`] walks a game's `www` tree
//!    ([`crate::extract_game_dir`] for the five `www/data/*.json` surfaces —
//!    maps, common-events, database, system, terms) **and** its
//!    `www/js/plugins.js` ([`crate::extract_plugins_file`] for the
//!    plugin-profile surface), producing a per-surface coverage census and a
//!    single honest [`MvMzCapabilityTuple`].
//! 2. [`FullSurfaceExtraction::extraction_manifest`] emits a deterministic,
//!    retail-text-free [`FullSurfaceExtractionManifest`] (per-surface unit
//!    counts + structural surface keys + plugin/finding diagnostics).
//! 3. [`patch_full_surface_trivial`] applies a **trivial** per-unit
//!    translation across every declared surface, byte-surgically, and emits a
//!    [`FullSurfacePatchManifest`] proving: only the declared JSON text
//!    changed, every `www/img` / `www/audio` media byte stayed identical, and
//!    the round-trip re-parses.
//! # Honest scope (the capability tuple)
//! [`MvMzCapabilityTuple::honest`] declares support for exactly two scopes —
//! `mv_mz/json_text` (extract + patch the five JSON-text roles) and
//! `mv_mz/plugin_profile` (extract declared plugin text + diagnose undeclared
//! plugin text). Encrypted media (`*.rpgmvp`/`*.rpgmvm`/`*.rpgmvo`) and plugin
//! **JS logic** are recorded as explicitly out-of-scope. There is no overclaim
//! of media or plugin-JS support; [`MvMzCapabilityTuple::violations`]
//! mechanically rejects a tuple that drifts from this boundary.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use kaifuu_core::mv_mz_readiness::{MV_MZ_ENGINE_FAMILY, MV_MZ_VARIANT};
use kaifuu_core::sha256_hash_bytes;

// Re-exported so consumers of the full-surface integration get the capability
// ladder + surface-role vocabulary without a second `kaifuu_core` import.
pub use kaifuu_core::{CapabilityLevel, MvMzSurfaceRole};

use crate::bridge::BridgeOpts;
use crate::patchback::{
    JsonStringEscaping, PatchbackError, PatchbackOpts, TranslatedBundleV02, apply_translated_bundle,
};
use crate::plugin_profile::{
    PLUGINS_JS_FILE, PluginDiagnostic, PluginExtractError, PluginExtraction, PluginPatchError,
    PluginProfile, PluginTranslation, extract_plugins_file, patch_file as patch_plugins_file,
};
use crate::{ExtractError, Finding, RpgMakerExtraction, extract_game_dir};

/// Full-surface integration manifest schema version.
pub const K112_FULL_SURFACE_SCHEMA_VERSION: &str = "0.1.0";
/// fixture-profile id the integration reports under.
pub const K112_FIXTURE_PROFILE_ID: &str = "KAIFUU-112";

/// Relative path (within a `www` dir) of the plugin-config file.
const PLUGINS_JS_REL: &str = "js/plugins.js";
/// Media subtrees the adapter never extracts or patches (out of scope).
const MEDIA_SUBTREES: [&str; 2] = ["img", "audio"];

#[path = "integration/capability.rs"]
mod capability;
pub use capability::*;

#[path = "integration/extraction.rs"]
mod extraction;
pub use extraction::*;

#[path = "integration/patch.rs"]
mod patch;
pub use patch::*;

#[cfg(test)]
#[path = "integration/tests.rs"]
mod tests;
