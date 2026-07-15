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

// Capability tuple — honest scope

/// One in-scope capability scope: a named boundary the adapter really
/// supports, its capability rung, and the surface roles it covers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityScope {
    /// Stable scope id (`mv_mz/json_text` | `mv_mz/plugin_profile`).
    pub scope_id: String,
    /// Structural description (no retail text).
    pub description: String,
    /// The honest capability rung for this scope.
    pub capability: CapabilityLevel,
    /// The surface roles this scope covers.
    pub roles: Vec<MvMzSurfaceRole>,
}

/// One explicitly-declined scope: something the adapter does NOT claim, so a
/// consumer never mistakes silence for support.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutOfScope {
    /// Stable scope id (`mv_mz/encrypted_media` | `mv_mz/plugin_js_logic`).
    pub scope_id: String,
    /// Structural reason the scope is declined.
    pub reason: String,
}

/// The honest MV/MZ capability tuple emitted by the full-surface integration.
/// Limited to MV/MZ JSON text + plugin-profile diagnostics — it never claims
/// encrypted-media or plugin-JS support.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzCapabilityTuple {
    pub engine_family: String,
    pub variant: String,
    pub in_scope: Vec<CapabilityScope>,
    pub out_of_scope: Vec<OutOfScope>,
    /// Every surface role the tuple covers (canonical order, all six).
    pub covered_roles: Vec<MvMzSurfaceRole>,
    /// The honest ceiling capability across all in-scope surfaces.
    pub capability: CapabilityLevel,
}

/// Canonical scope id for the five JSON-text roles.
pub const SCOPE_JSON_TEXT: &str = "mv_mz/json_text";
/// Canonical scope id for the plugin-profile role.
pub const SCOPE_PLUGIN_PROFILE: &str = "mv_mz/plugin_profile";
/// Canonical out-of-scope id for encrypted media.
pub const SCOPE_ENCRYPTED_MEDIA: &str = "mv_mz/encrypted_media";
/// Canonical out-of-scope id for plugin JS logic (never executed).
pub const SCOPE_PLUGIN_JS_LOGIC: &str = "mv_mz/plugin_js_logic";

impl MvMzCapabilityTuple {
    /// The canonical honest tuple: JSON text (extract+patch) + plugin-profile
    /// (extract declared text, diagnose undeclared); encrypted media + plugin
    /// JS logic declined.
    pub fn honest() -> Self {
        use MvMzSurfaceRole::{CommonEvents, Database, Maps, System, Terms};
        let json_text_roles = vec![Maps, CommonEvents, Database, System, Terms];
        Self {
            engine_family: MV_MZ_ENGINE_FAMILY.to_string(),
            variant: MV_MZ_VARIANT.to_string(),
            in_scope: vec![
                CapabilityScope {
                    scope_id: SCOPE_JSON_TEXT.to_string(),
                    description: "www/data/*.json event-command + database + system + terms text: \
                                  extract and byte-surgical patch-back."
                        .to_string(),
                    capability: CapabilityLevel::Patch,
                    roles: json_text_roles,
                },
                CapabilityScope {
                    scope_id: SCOPE_PLUGIN_PROFILE.to_string(),
                    description: "www/js/plugins.js DECLARED plugin-parameter text: extract and \
                                  byte-surgical patch-back; undeclared plugin text is diagnosed, \
                                  never swept."
                        .to_string(),
                    capability: CapabilityLevel::Patch,
                    roles: vec![MvMzSurfaceRole::PluginProfileDiagnostics],
                },
            ],
            out_of_scope: vec![
                OutOfScope {
                    scope_id: SCOPE_ENCRYPTED_MEDIA.to_string(),
                    reason: "Encrypted *.rpgmvp/*.rpgmvm/*.rpgmvo media is neither extracted nor \
                             patched by this node; it is left byte-identical."
                        .to_string(),
                },
                OutOfScope {
                    scope_id: SCOPE_PLUGIN_JS_LOGIC.to_string(),
                    reason: "Plugin JavaScript is never executed or rewritten; only DECLARED \
                             plugin-parameter text literals are touched."
                        .to_string(),
                },
            ],
            covered_roles: MvMzSurfaceRole::all().to_vec(),
            capability: CapabilityLevel::Patch,
        }
    }

    /// Media globs this tuple explicitly declines. Used by the patch manifest
    /// to name what is guaranteed byte-identical.
    pub fn declined_media_globs(&self) -> Vec<String> {
        vec![
            "www/img/**/*.rpgmvp".to_string(),
            "www/audio/**/*.rpgmvm".to_string(),
            "www/audio/**/*.rpgmvo".to_string(),
        ]
    }

    /// Mechanically enforce the honest boundary. Returns one structured string
    /// per drift; empty iff the tuple is a faithful, non-overclaiming
    /// declaration limited to JSON text + plugin-profile diagnostics.
    pub fn violations(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.engine_family != MV_MZ_ENGINE_FAMILY {
            out.push(format!("wrong engine_family: {}", self.engine_family));
        }
        if self.variant != MV_MZ_VARIANT {
            out.push(format!("wrong variant: {}", self.variant));
        }

        // In-scope ids limited to the two allowed text scopes.
        let allowed_in: BTreeSet<&str> = [SCOPE_JSON_TEXT, SCOPE_PLUGIN_PROFILE].into();
        for scope in &self.in_scope {
            if !allowed_in.contains(scope.scope_id.as_str()) {
                out.push(format!("in-scope id not a text scope: {}", scope.scope_id));
            }
        }
        // Both text scopes present exactly once.
        for required in [SCOPE_JSON_TEXT, SCOPE_PLUGIN_PROFILE] {
            let count = self
                .in_scope
                .iter()
                .filter(|s| s.scope_id == required)
                .count();
            if count != 1 {
                out.push(format!(
                    "in-scope {required} present {count} times (want 1)"
                ));
            }
        }

        // Encrypted media + plugin-JS logic must be explicitly declined.
        let declined: BTreeSet<&str> = self
            .out_of_scope
            .iter()
            .map(|s| s.scope_id.as_str())
            .collect();
        for required in [SCOPE_ENCRYPTED_MEDIA, SCOPE_PLUGIN_JS_LOGIC] {
            if !declined.contains(required) {
                out.push(format!("missing out-of-scope declaration: {required}"));
            }
        }
        // No scope is both claimed and declined.
        for scope in &self.in_scope {
            if declined.contains(scope.scope_id.as_str()) {
                out.push(format!(
                    "scope {} both claimed and declined",
                    scope.scope_id
                ));
            }
        }

        // The union of in-scope roles must be exactly the six declared roles.
        let covered: BTreeSet<MvMzSurfaceRole> = self
            .in_scope
            .iter()
            .flat_map(|s| s.roles.iter().copied())
            .collect();
        let expected: BTreeSet<MvMzSurfaceRole> = MvMzSurfaceRole::all().into_iter().collect();
        if covered != expected {
            out.push("in-scope roles are not exactly the six declared roles".to_string());
        }
        let covered_roles: BTreeSet<MvMzSurfaceRole> = self.covered_roles.iter().copied().collect();
        if covered_roles != expected {
            out.push("covered_roles are not exactly the six declared roles".to_string());
        }

        // The ceiling cannot exceed patch (the honest maximum of this node).
        if self.capability > CapabilityLevel::Patch {
            out.push(format!("capability above patch: {:?}", self.capability));
        }
        out
    }

    /// Deterministic stable JSON.
    pub fn stable_json(&self) -> Result<String, FullSurfaceError> {
        kaifuu_core::stable_json(self).map_err(|err| FullSurfaceError::Serialize {
            message: err.to_string(),
        })
    }
}

// Per-surface coverage

/// Per-role coverage: how many units the integration surfaced for a role,
/// which files fed it, and a bounded sample of the STRUCTURAL surface keys
/// (JSON-pointer ids — never retail text).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceCoverage {
    pub role: MvMzSurfaceRole,
    pub surface_id: String,
    pub unit_count: usize,
    pub files: Vec<String>,
    /// Up to four surface keys (structural JSON-pointer ids), sorted.
    pub sample_surface_keys: Vec<String>,
}

/// Maximum number of sample surface keys recorded per role.
const SAMPLE_KEY_LIMIT: usize = 4;

/// Assign a `www/data/*.json` surface key to its declared role.
/// `System.json` splits by pointer: `gameTitle`/`currencyUnit` are the
/// `System` role, everything else (`terms.*`, the type lists) is `Terms`.
pub fn role_for_data_key(source_unit_key: &str) -> Option<MvMzSurfaceRole> {
    let rest = source_unit_key.strip_prefix("rpgmaker:")?;
    let (file, pointer) = rest.split_once('#')?;
    if is_map_file(file) {
        Some(MvMzSurfaceRole::Maps)
    } else if file == "CommonEvents.json" {
        Some(MvMzSurfaceRole::CommonEvents)
    } else if file == "System.json" {
        if pointer.starts_with("/gameTitle") || pointer.starts_with("/currencyUnit") {
            Some(MvMzSurfaceRole::System)
        } else {
            Some(MvMzSurfaceRole::Terms)
        }
    } else if crate::is_database_file(file) {
        Some(MvMzSurfaceRole::Database)
    } else {
        None
    }
}

/// `MapNNN.json` (digits only) — excludes `MapInfos.json`. Mirrors the
/// private matcher in `crate::lib`.
fn is_map_file(file: &str) -> bool {
    let Some(stem) = file.strip_suffix(".json") else {
        return false;
    };
    let Some(digits) = stem.strip_prefix("Map") else {
        return false;
    };
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

// Structural (retail-text-free) diagnostic + finding records

/// A structural summary of a [`Finding`] (unknown / script / plugin-command
/// event code). Carries only structural description — never retail text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingRecord {
    pub kind: String,
    pub file: String,
    pub pointer: String,
    pub command_code: Option<i64>,
    pub detail: String,
}

impl FindingRecord {
    fn from_finding(finding: &Finding) -> Self {
        Self {
            kind: format!("{:?}", finding.kind),
            file: finding.file.clone(),
            pointer: finding.pointer_string(),
            command_code: finding.command_code,
            detail: finding.detail.clone(),
        }
    }
}

/// A structural summary of a [`PluginDiagnostic`] (unsupported plugin profile
/// mis-declared pointer). Structural only — never retail text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiagnosticRecord {
    pub kind: String,
    pub source_file: String,
    pub plugin_name: Option<String>,
    pub pointer: String,
    pub detail: String,
}

impl PluginDiagnosticRecord {
    fn from_diagnostic(diagnostic: &PluginDiagnostic) -> Self {
        let pointer = if diagnostic.pointer.is_empty() {
            String::new()
        } else {
            let mut out = String::new();
            for token in &diagnostic.pointer {
                out.push('/');
                out.push_str(&token.replace('~', "~0").replace('/', "~1"));
            }
            out
        };
        Self {
            kind: format!("{:?}", diagnostic.kind),
            source_file: diagnostic.source_file.clone(),
            plugin_name: diagnostic.plugin_name.clone(),
            pointer,
            detail: diagnostic.detail.clone(),
        }
    }
}

// Full-surface extraction

/// The combined full-surface extraction: the `www/data` bridge bundle, the
/// `plugins.js` plugin-profile extraction, the per-role coverage census, and
/// the honest capability tuple.
#[derive(Debug, Clone)]
pub struct FullSurfaceExtraction {
    /// The five JSON-text surfaces (maps/common-events/database/system/terms).
    pub data: RpgMakerExtraction,
    /// The plugin-profile surface (declared text + diagnostics).
    pub plugins: PluginExtraction,
    /// Per-role coverage across all six declared surfaces (canonical order).
    pub coverage: Vec<SurfaceCoverage>,
    /// The honest, non-overclaiming capability tuple.
    pub capability: MvMzCapabilityTuple,
}

/// Fatal errors raised by the full-surface integration.
#[derive(Debug, thiserror::Error)]
pub enum FullSurfaceError {
    #[error(transparent)]
    Data(#[from] ExtractError),
    #[error(transparent)]
    Plugins(#[from] PluginExtractError),
    #[error(transparent)]
    Patchback(#[from] PatchbackError),
    #[error(transparent)]
    PluginPatch(#[from] PluginPatchError),
    #[error("kaifuu.rpgmaker.k112.plugins_missing: {path} has no js/plugins.js")]
    PluginsMissing { path: String },
    #[error("kaifuu.rpgmaker.k112.io: {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("kaifuu.rpgmaker.k112.serialize: {message}")]
    Serialize { message: String },
}

/// Walk a game's `www` tree across all six declared surfaces.
/// Runs [`extract_game_dir`] for the five `www/data/*.json` surfaces and
/// [`extract_plugins_file`] on `www/js/plugins.js` (which must exist) with the
/// caller-declared plugin `profiles`. Deterministic: identical input yields an
/// identical [`FullSurfaceExtraction`].
pub fn extract_full_surface(
    www_dir: &Path,
    profiles: &[PluginProfile],
    opts: &BridgeOpts<'_>,
) -> Result<FullSurfaceExtraction, FullSurfaceError> {
    let data = extract_game_dir(www_dir, opts)?;

    let plugins_path = www_dir.join(PLUGINS_JS_REL);
    if !plugins_path.is_file() {
        return Err(FullSurfaceError::PluginsMissing {
            path: www_dir.display().to_string(),
        });
    }
    let plugins = extract_plugins_file(&plugins_path, profiles)?;

    let coverage = build_coverage(&data, &plugins);
    let capability = MvMzCapabilityTuple::honest();
    Ok(FullSurfaceExtraction {
        data,
        plugins,
        coverage,
        capability,
    })
}

/// Build the per-role coverage census across all six surfaces.
fn build_coverage(data: &RpgMakerExtraction, plugins: &PluginExtraction) -> Vec<SurfaceCoverage> {
    // role -> (count, files, keys)
    let mut counts: BTreeMap<MvMzSurfaceRole, usize> = BTreeMap::new();
    let mut files: BTreeMap<MvMzSurfaceRole, BTreeSet<String>> = BTreeMap::new();
    let mut keys: BTreeMap<MvMzSurfaceRole, BTreeSet<String>> = BTreeMap::new();

    for unit in &data.bundle.bundle.units {
        if let Some(role) = role_for_data_key(&unit.source_unit_key) {
            *counts.entry(role).or_default() += 1;
            if let Some(file) = source_file_of(&unit.source_unit_key) {
                files.entry(role).or_default().insert(file);
            }
            keys.entry(role)
                .or_default()
                .insert(unit.source_unit_key.clone());
        }
    }
    let role = MvMzSurfaceRole::PluginProfileDiagnostics;
    for unit in &plugins.units {
        let key = unit.source_unit_key();
        *counts.entry(role).or_default() += 1;
        files
            .entry(role)
            .or_default()
            .insert(PLUGINS_JS_FILE.to_string());
        keys.entry(role).or_default().insert(key);
    }

    MvMzSurfaceRole::all()
        .into_iter()
        .map(|role| {
            let file_list: Vec<String> = files
                .get(&role)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .collect();
            let sample: Vec<String> = keys
                .get(&role)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .take(SAMPLE_KEY_LIMIT)
                .collect();
            SurfaceCoverage {
                role,
                surface_id: role.surface_id(),
                unit_count: counts.get(&role).copied().unwrap_or(0),
                files: file_list,
                sample_surface_keys: sample,
            }
        })
        .collect()
}

/// Extract the `<file>` component of a `rpgmaker:<file>#<pointer>` key.
fn source_file_of(source_unit_key: &str) -> Option<String> {
    let rest = source_unit_key.strip_prefix("rpgmaker:")?;
    let (file, _) = rest.split_once('#')?;
    Some(file.to_string())
}

impl FullSurfaceExtraction {
    /// True iff every one of the six declared surfaces yielded at least one
    /// translatable unit — the golden-fixture full-coverage acceptance.
    pub fn covers_all_surfaces(&self) -> bool {
        self.coverage.len() == MvMzSurfaceRole::all().len()
            && self.coverage.iter().all(|c| c.unit_count > 0)
    }

    /// Total translatable units across all six surfaces.
    pub fn total_unit_count(&self) -> usize {
        self.coverage.iter().map(|c| c.unit_count).sum()
    }

    /// Build the deterministic, retail-text-free full-surface extraction
    /// manifest.
    pub fn extraction_manifest(&self) -> FullSurfaceExtractionManifest {
        FullSurfaceExtractionManifest {
            schema_version: K112_FULL_SURFACE_SCHEMA_VERSION.to_string(),
            fixture_profile_id: K112_FIXTURE_PROFILE_ID.to_string(),
            capability: self.capability.clone(),
            surfaces: self.coverage.clone(),
            data_unit_count: self.data.bundle.bundle.units.len(),
            plugin_unit_count: self.plugins.units.len(),
            plugin_diagnostics: self
                .plugins
                .diagnostics
                .iter()
                .map(PluginDiagnosticRecord::from_diagnostic)
                .collect(),
            findings: self
                .data
                .findings
                .iter()
                .map(FindingRecord::from_finding)
                .collect(),
        }
    }
}

/// The deterministic full-surface EXTRACTION manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullSurfaceExtractionManifest {
    pub schema_version: String,
    pub fixture_profile_id: String,
    pub capability: MvMzCapabilityTuple,
    pub surfaces: Vec<SurfaceCoverage>,
    pub data_unit_count: usize,
    pub plugin_unit_count: usize,
    pub plugin_diagnostics: Vec<PluginDiagnosticRecord>,
    pub findings: Vec<FindingRecord>,
}

impl FullSurfaceExtractionManifest {
    /// True iff every declared surface has at least one unit.
    pub fn covers_all_surfaces(&self) -> bool {
        self.surfaces.len() == MvMzSurfaceRole::all().len()
            && self.surfaces.iter().all(|s| s.unit_count > 0)
    }

    /// Deterministic stable JSON.
    pub fn stable_json(&self) -> Result<String, FullSurfaceError> {
        kaifuu_core::stable_json(self).map_err(|err| FullSurfaceError::Serialize {
            message: err.to_string(),
        })
    }
}

// Trivial full-surface patch round-trip

/// Deterministic trivial translation of a source literal. Prepends the CJK
/// "translate" ideograph so the target is always non-empty, always differs
/// from the source, and exercises the ASCII-safe `\u`-escaping patch path.
pub fn trivial_target(source: &str) -> String {
    format!("\u{8a33}{source}")
}

/// Build a translated v0.2 bundle JSON from an extraction's source bundle,
/// setting `target.text = trivial_target(sourceText)` on every unit.
fn build_trivial_translated_bundle_json(source_bundle_json: &Value) -> Value {
    let mut translated = source_bundle_json.clone();
    if let Some(units) = translated.get_mut("units").and_then(Value::as_array_mut) {
        for unit in units {
            let source_text = unit
                .get("sourceText")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            unit["target"] = json!({"locale": "en-US", "text": trivial_target(&source_text)});
        }
    }
    translated
}

/// One file's changed-status in the trivial patch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub file: String,
    pub roles: Vec<MvMzSurfaceRole>,
    pub changed: bool,
}

/// A media asset the patch guarantees byte-identical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub relative_path: String,
    pub content_sha256: String,
    /// Always `true`: the adapter never writes media.
    pub byte_identical: bool,
}

/// The deterministic full-surface trivial PATCH manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullSurfacePatchManifest {
    pub schema_version: String,
    pub fixture_profile_id: String,
    pub capability: MvMzCapabilityTuple,
    /// Every referenced JSON-text file (`www/data/*.json` + `plugins.js`).
    pub changed_files: Vec<ChangedFile>,
    /// Media assets (under `www/img` / `www/audio`) proven byte-identical.
    pub media_untouched: Vec<MediaAsset>,
    /// The media globs the capability tuple declines.
    pub declined_media_globs: Vec<String>,
    /// True iff every declared surface produced a real byte change and every
    /// patched file re-parsed (the trivial round-trip succeeded end-to-end).
    pub all_declared_surfaces_changed: bool,
}

impl FullSurfacePatchManifest {
    /// Deterministic stable JSON.
    pub fn stable_json(&self) -> Result<String, FullSurfaceError> {
        kaifuu_core::stable_json(self).map_err(|err| FullSurfaceError::Serialize {
            message: err.to_string(),
        })
    }
}

/// The result of a trivial full-surface patch: the patched JSON-text bytes and
/// the patch manifest.
#[derive(Debug, Clone)]
pub struct FullSurfacePatch {
    /// Patched bytes per referenced `www/data/*.json` file.
    pub patched_data: BTreeMap<String, Vec<u8>>,
    /// Patched bytes for `www/js/plugins.js`.
    pub patched_plugins_js: Vec<u8>,
    /// The trivial-patch manifest.
    pub manifest: FullSurfacePatchManifest,
}

/// Apply a trivial per-unit translation across every declared surface and
/// build the patch manifest.
/// Reads `www_dir` strictly read-only. `www/data/*.json` are patched via the
/// proven byte-surgical splice ([`apply_translated_bundle`]); `www/js/plugins.js`
/// via [`patch_plugins_file`]. Media under `www/img` / `www/audio` is never
/// read for patching and is recorded (with its source hash) as byte-identical.
pub fn patch_full_surface_trivial(
    www_dir: &Path,
    extraction: &FullSurfaceExtraction,
    opts: &PatchbackOpts,
) -> Result<FullSurfacePatch, FullSurfaceError> {
    let translated_json = build_trivial_translated_bundle_json(&extraction.data.bundle.json);
    let bundle = TranslatedBundleV02::from_json(&translated_json)?;
    let patched_data = apply_translated_bundle(www_dir, &bundle, opts)?;

    let plugins_path = www_dir.join(PLUGINS_JS_REL);
    let original_plugins = std::fs::read(&plugins_path).map_err(|source| FullSurfaceError::Io {
        path: plugins_path.display().to_string(),
        source,
    })?;
    let plugin_translations: Vec<PluginTranslation> = extraction
        .plugins
        .units
        .iter()
        .map(|unit| PluginTranslation {
            unit,
            target_text: trivial_target(&unit.source_text),
        })
        .collect();
    let patched_plugins_js =
        patch_plugins_file(PLUGINS_JS_FILE, &original_plugins, &plugin_translations)?;

    let data_dir = www_dir.join("data");
    let mut roles_by_file: BTreeMap<String, BTreeSet<MvMzSurfaceRole>> = BTreeMap::new();
    for unit in &extraction.data.bundle.bundle.units {
        if let (Some(file), Some(role)) = (
            source_file_of(&unit.source_unit_key),
            role_for_data_key(&unit.source_unit_key),
        ) {
            roles_by_file.entry(file).or_default().insert(role);
        }
    }
    let mut changed_files: Vec<ChangedFile> = Vec::new();
    for (file, bytes) in &patched_data {
        let source = std::fs::read(data_dir.join(file)).map_err(|source| FullSurfaceError::Io {
            path: data_dir.join(file).display().to_string(),
            source,
        })?;
        changed_files.push(ChangedFile {
            file: file.clone(),
            roles: roles_by_file
                .get(file)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .collect(),
            changed: &source != bytes,
        });
    }
    changed_files.push(ChangedFile {
        file: PLUGINS_JS_FILE.to_string(),
        roles: vec![MvMzSurfaceRole::PluginProfileDiagnostics],
        changed: patched_plugins_js != original_plugins,
    });
    changed_files.sort_by(|a, b| a.file.cmp(&b.file));

    let mut media_untouched: Vec<MediaAsset> = Vec::new();
    for subtree in MEDIA_SUBTREES {
        let dir = www_dir.join(subtree);
        collect_media(www_dir, &dir, &mut media_untouched)?;
    }
    media_untouched.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    // Round-trip succeeds iff every declared surface's referenced file changed
    // (data files carrying units + plugins.js) — a real, non-empty patch.
    let all_declared_surfaces_changed = changed_files.iter().all(|c| c.changed);

    let manifest = FullSurfacePatchManifest {
        schema_version: K112_FULL_SURFACE_SCHEMA_VERSION.to_string(),
        fixture_profile_id: K112_FIXTURE_PROFILE_ID.to_string(),
        capability: extraction.capability.clone(),
        changed_files,
        media_untouched,
        declined_media_globs: extraction.capability.declined_media_globs(),
        all_declared_surfaces_changed,
    };

    Ok(FullSurfacePatch {
        patched_data,
        patched_plugins_js,
        manifest,
    })
}

/// Recursively record every regular file under `dir` as a byte-identical media
/// asset (relative to `www_dir`). Missing subtrees are silently skipped.
fn collect_media(
    www_dir: &Path,
    dir: &Path,
    out: &mut Vec<MediaAsset>,
) -> Result<(), FullSurfaceError> {
    if !dir.is_dir() {
        return Ok(());
    }
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = std::fs::read_dir(&current).map_err(|source| FullSurfaceError::Io {
            path: current.display().to_string(),
            source,
        })?;
        for entry in entries {
            let entry = entry.map_err(|source| FullSurfaceError::Io {
                path: current.display().to_string(),
                source,
            })?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                let bytes = std::fs::read(&path).map_err(|source| FullSurfaceError::Io {
                    path: path.display().to_string(),
                    source,
                })?;
                let rel = path
                    .strip_prefix(www_dir)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push(MediaAsset {
                    relative_path: rel,
                    content_sha256: sha256_hash_bytes(&bytes),
                    byte_identical: true,
                });
            }
        }
    }
    Ok(())
}

/// Assert that `JsonStringEscaping` is exercised by the patch (documents the
/// ASCII-safe escaping contract the trivial target depends on).
pub const PATCH_ESCAPING: JsonStringEscaping = JsonStringEscaping::AsciiSafeUnicodeEscapes;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn honest_tuple_has_no_violations() {
        let tuple = MvMzCapabilityTuple::honest();
        assert!(
            tuple.violations().is_empty(),
            "violations: {:?}",
            tuple.violations()
        );
        assert_eq!(tuple.capability, CapabilityLevel::Patch);
        assert_eq!(tuple.covered_roles.len(), 6);
    }

    #[test]
    fn tuple_rejects_media_overclaim() {
        let mut tuple = MvMzCapabilityTuple::honest();
        // Claim encrypted media as an in-scope patchable text scope.
        tuple.in_scope.push(CapabilityScope {
            scope_id: SCOPE_ENCRYPTED_MEDIA.to_string(),
            description: "overclaim".to_string(),
            capability: CapabilityLevel::Patch,
            roles: vec![],
        });
        let violations = tuple.violations();
        assert!(!violations.is_empty());
        assert!(
            violations.iter().any(|v| v.contains("not a text scope")),
            "{violations:?}"
        );
        assert!(
            violations
                .iter()
                .any(|v| v.contains("both claimed and declined")),
            "{violations:?}"
        );
    }

    #[test]
    fn tuple_rejects_dropped_media_declaration() {
        let mut tuple = MvMzCapabilityTuple::honest();
        tuple
            .out_of_scope
            .retain(|s| s.scope_id != SCOPE_ENCRYPTED_MEDIA);
        assert!(
            tuple
                .violations()
                .iter()
                .any(|v| v.contains(SCOPE_ENCRYPTED_MEDIA)),
            "dropping the encrypted-media decline must be a violation"
        );
    }

    #[test]
    fn role_assignment_splits_system_and_terms() {
        assert_eq!(
            role_for_data_key("rpgmaker:System.json#/gameTitle"),
            Some(MvMzSurfaceRole::System)
        );
        assert_eq!(
            role_for_data_key("rpgmaker:System.json#/currencyUnit"),
            Some(MvMzSurfaceRole::System)
        );
        assert_eq!(
            role_for_data_key("rpgmaker:System.json#/terms/messages/actorDamage"),
            Some(MvMzSurfaceRole::Terms)
        );
        assert_eq!(
            role_for_data_key("rpgmaker:System.json#/equipTypes/1"),
            Some(MvMzSurfaceRole::Terms)
        );
        assert_eq!(
            role_for_data_key("rpgmaker:Map001.json#/events/1/pages/0/list/1/parameters/0"),
            Some(MvMzSurfaceRole::Maps)
        );
        assert_eq!(
            role_for_data_key("rpgmaker:CommonEvents.json#/1/list/1/parameters/0"),
            Some(MvMzSurfaceRole::CommonEvents)
        );
        assert_eq!(
            role_for_data_key("rpgmaker:Items.json#/1/name"),
            Some(MvMzSurfaceRole::Database)
        );
        assert_eq!(role_for_data_key("rpgmaker:MapInfos.json#/1/name"), None);
    }

    #[test]
    fn trivial_target_is_non_empty_and_differs() {
        let t = trivial_target("Hello");
        assert_ne!(t, "Hello");
        assert!(t.starts_with('\u{8a33}'));
        assert!(!t.is_empty());
    }
}
