//! MV/MZ PLUGIN-owned text via declared plugin profiles.
//! RPG Maker MV/MZ games load PLUGINS (`js/plugins/*.js` + the `js/plugins.js`
//! config) that own their own player-facing text through **plugin
//! parameters** (a message-box plugin's window title, a name-input plugin's
//! prompt, …). Those parameters live in `js/plugins.js` as a
//! `var $plugins = [ … ];` array of `{ name, status, description, parameters }`
//! objects. This slice represents that plugin-owned text — but ONLY through a
//! **declared plugin profile**: a plugin parameter is extractable *iff* a
//! profile declares the JSON pointer that holds it.
//! This is the honest boundary. A plugin's parameter object mixes translatable
//! text with configuration, numeric strings, switch/variable ids, colour
//! codes and file names; without a per-plugin profile we cannot know which
//! parameters carry player-facing text. So we DO NOT blind-sweep every plugin
//! string. Instead:
//! - A plugin **with a declared profile** → text is extracted at exactly the
//!   declared parameter pointers as stable units ([`StablePluginTextUnit`]),
//!   and patched back byte-preservingly (reusing the splice).
//! - A plugin **without a declared profile** that carries string parameters →
//!   one typed [`PluginDiagnosticKind::UnsupportedPluginProfile`] diagnostic
//!   (never a silent skip, never a blind all-strings sweep).
//! - A declared pointer that resolves to a **non-text** value (a numeric /
//!   switch string mistake) or does not resolve → a typed
//!   [`PluginDiagnosticKind::UnsupportedDeclaredPointer`] diagnostic; it is
//!   NOT extracted.
//! # `js/plugins.js` shape (no JS execution)
//! `plugins.js` is a JS assignment wrapping a JSON array:
//! `var $plugins =\n[ {…}, {…} ];`. We NEVER execute the plugin JS. We split
//! the file into `(prefix, <JSON array bytes>, suffix)` at the `$plugins`
//! array literal, parse only the array as JSON, and patch only the array bytes
//! — the `var $plugins =` prefix and the trailing `;` suffix are preserved
//! verbatim, so the whole file stays byte-identical outside the declared
//! parameter literals.
//! # Stable unit + profile output (acceptance)
//! Every [`StablePluginTextUnit`] carries `source_file`, the plugin name plus
//! declared id, the plugin array index, the parameter pointer, the text role,
//! the patchability, and the fixture-profile id. Its stable
//! `rpgmaker:plugins.js#<json-pointer>` [`source_unit_key`] and deterministic
//! [`bridge_unit_id`] use the same scheme as the sibling slices. Each
//! profiled plugin also emits a [`ProfiledPlugin`] record with the plugin id,
//! the version-or-fixture-hash (the profile's declared version, plus a content
//! `fixture_hash` over the plugin entry bytes), and the declared parameter
//! pointers — acceptance (2).
//! [`source_unit_key`]: StablePluginTextUnit::source_unit_key
//! [`bridge_unit_id`]: StablePluginTextUnit::bridge_unit_id

use std::path::Path;

use serde_json::Value;
use thiserror::Error;

use kaifuu_core::sha256_hash_bytes;

use crate::ids::deterministic_uuid7;
use crate::patchback::{FileEdit, PatchbackError, patch_file_bytes};

/// The fixture-profile id every unit is stamped.
pub const FIXTURE_PROFILE_ID: &str = "KAIFUU-111";

/// The canonical `js/plugins.js` file name.
pub const PLUGINS_JS_FILE: &str = "plugins.js";

// Declared profile schema

/// The role a declared plugin-parameter's text plays for the player.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginTextRole {
    /// A UI label / window title / button caption owned by the plugin.
    UiLabel,
    /// A message / dialogue / narration line owned by the plugin.
    Message,
    /// A player-facing description / help / caption string.
    Caption,
}

impl PluginTextRole {
    /// Stable snake-case tag (bridge / report friendly).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UiLabel => "ui_label",
            Self::Message => "message",
            Self::Caption => "caption",
        }
    }
}

/// Whether a declared parameter pointer is byte-preserving patchable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Patchability {
    /// The declared text is extracted AND written back by the splice patch.
    Patchable,
    /// The declared text is extracted for reference / context but is NOT
    /// written back (a read-only display the plugin recomputes); a patch that
    /// targets it is rejected rather than silently applied.
    ReadOnly,
}

impl Patchability {
    /// Stable snake-case tag.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Patchable => "patchable",
            Self::ReadOnly => "read_only",
        }
    }
}

/// One declared translatable parameter pointer inside a plugin's `parameters`
/// object. The `pointer` tokens are RFC6901-decoded and navigate *within* the
/// plugin's `parameters` object (e.g. `["windowTitle"]`, or
/// `["messages", "greeting"]` for a nested params object).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginParamPointer {
    /// RFC6901-decoded pointer tokens into the plugin's `parameters` object.
    pub pointer: Vec<String>,
    /// The declared text role.
    pub text_role: PluginTextRole,
    /// Whether the declared pointer is patchable.
    pub patchability: Patchability,
}

/// A declared profile for a single named plugin. DECLARED profiles are the
/// only way plugin text becomes extractable — a plugin without a matching
/// profile is diagnosed, never blind-swept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginProfile {
    /// The plugin `name` exactly as it appears in `plugins.js` (the identity
    /// key the profile is matched by).
    pub plugin_name: String,
    /// A stable declared plugin id (may differ from `plugin_name`; e.g. a
    /// versioned or namespaced id). Recorded on every unit + in the output.
    pub plugin_id: String,
    /// An optional declared plugin version. When present it is the
    /// "version-or-fixture-hash"; the content `fixture_hash` is always also
    /// recorded so the extracted params are pinned either way.
    pub plugin_version: Option<String>,
    /// The declared translatable parameter pointers.
    pub params: Vec<PluginParamPointer>,
}

/// Index a profile set by plugin name (first declaration wins on a duplicate).
fn profile_for<'a>(profiles: &'a [PluginProfile], name: &str) -> Option<&'a PluginProfile> {
    profiles.iter().find(|p| p.plugin_name == name)
}

// Stable unit

/// A stable plugin-parameter text unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StablePluginTextUnit {
    /// Source file name (always [`PLUGINS_JS_FILE`]).
    pub source_file: String,
    /// The plugin `name` from `plugins.js`.
    pub plugin_name: String,
    /// The declared plugin id (from the profile).
    pub plugin_id: String,
    /// The plugin's position in the `$plugins` array (what the pointer
    /// navigates).
    pub plugin_index: usize,
    /// The declared pointer tokens *within* the plugin's `parameters` object.
    pub param_pointer: Vec<String>,
    /// The declared text role.
    pub text_role: PluginTextRole,
    /// The declared patchability.
    pub patchability: Patchability,
    /// The fixture-profile id ([`FIXTURE_PROFILE_ID`]).
    pub fixture_profile_id: &'static str,
    /// Full RFC6901 pointer tokens locating the string literal in the
    /// `$plugins` array: `[<plugin_index>, "parameters", <param_pointer…>]`.
    pub pointer: Vec<String>,
    /// The decoded source text (the raw JSON string value).
    pub source_text: String,
}

impl StablePluginTextUnit {
    /// RFC6901 pointer string (`/1/parameters/windowTitle`).
    #[must_use]
    pub fn pointer_string(&self) -> String {
        let mut out = String::new();
        for token in &self.pointer {
            out.push('/');
            out.push_str(&token.replace('~', "~0").replace('/', "~1"));
        }
        out
    }

    /// Stable surface id: `rpgmaker:plugins.js#<pointer>` — identical scheme to
    /// the sibling slices, so [`crate::patchback`] resolves all three.
    #[must_use]
    pub fn source_unit_key(&self) -> String {
        format!("rpgmaker:{}#{}", self.source_file, self.pointer_string())
    }

    /// Deterministic bridge-unit id derived from the fixture profile + surface
    /// key (UUID7-shaped; identical construction to the sibling slices).
    #[must_use]
    pub fn bridge_unit_id(&self) -> String {
        deterministic_uuid7(
            &format!("rpgmaker-k111:{}", self.fixture_profile_id),
            &format!("unit-{}", self.source_unit_key()),
        )
    }
}

// Profiled-plugin output record (acceptance (2))

/// The per-plugin profile output: records the plugin id, the
/// version-or-fixture-hash, and the extracted parameter pointers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfiledPlugin {
    /// The declared plugin id.
    pub plugin_id: String,
    /// The plugin `name` from `plugins.js`.
    pub plugin_name: String,
    /// The plugin's position in the `$plugins` array.
    pub plugin_index: usize,
    /// The profile's declared version, if any (the "version-or-…" half).
    pub declared_version: Option<String>,
    /// A content hash over the plugin entry's canonical JSON serialization
    /// (the "…-or-fixture-hash" half); pins exactly which plugin fixture was
    /// extracted even when no version is declared.
    pub fixture_hash: String,
    /// The declared parameter pointers that yielded extracted units (RFC6901
    /// pointer strings *within* `parameters`, e.g. `/windowTitle`).
    pub extracted_pointers: Vec<String>,
    /// The fixture-profile id.
    pub fixture_profile_id: &'static str,
}

// Diagnostics

/// Category of a [`PluginDiagnostic`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginDiagnosticKind {
    /// A plugin present in `plugins.js` carries string parameters (so it may
    /// own player-facing text) but has NO declared profile; its parameter text
    /// is not represented. One diagnostic per unprofiled plugin — never a
    /// per-string blind sweep.
    UnsupportedPluginProfile,
    /// A declared profile pointer did not resolve to a non-empty JSON string
    /// in the plugin's parameters (a missing key, or a numeric/switch value):
    /// the declaration is rejected for that pointer and NOT extracted.
    UnsupportedDeclaredPointer,
    /// The `plugins.js` array container was malformed (not a JSON array, or an
    /// array element that is not a plugin object).
    MalformedContainer,
}

/// A structural, no-retail-text diagnostic recorded during extraction. Carries
/// only structural description (plugin name, pointer, kind) — never retail
/// string content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginDiagnostic {
    pub kind: PluginDiagnosticKind,
    pub source_file: String,
    /// The offending plugin's name, when known.
    pub plugin_name: Option<String>,
    /// RFC6901 pointer tokens to the offending surface (within the `$plugins`
    /// array), when applicable.
    pub pointer: Vec<String>,
    /// Structural description only — never retail string content.
    pub detail: String,
}

/// Output of the pure plugin-profile extractor.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PluginExtraction {
    pub units: Vec<StablePluginTextUnit>,
    pub profiled: Vec<ProfiledPlugin>,
    pub diagnostics: Vec<PluginDiagnostic>,
}

/// Typed, semantic errors raised by the file-level extractor / patcher *before
/// any write*.
#[derive(Debug, Error)]
pub enum PluginExtractError {
    #[error("kaifuu.rpgmaker.k111.missing_file: {file} does not exist")]
    MissingFile { file: String },
    #[error("kaifuu.rpgmaker.k111.io: {file}: {source}")]
    Io {
        file: String,
        #[source]
        source: std::io::Error,
    },
    #[error("kaifuu.rpgmaker.k111.malformed_plugins_js: {file}: {reason}")]
    MalformedPluginsJs { file: String, reason: String },
    #[error("kaifuu.rpgmaker.k111.malformed_json: {file}: {source}")]
    MalformedJson {
        file: String,
        #[source]
        source: serde_json::Error,
    },
}

/// Typed errors raised by [`patch_file`].
#[derive(Debug, Error)]
pub enum PluginPatchError {
    #[error("kaifuu.rpgmaker.k111.malformed_plugins_js: {file}: {reason}")]
    MalformedPluginsJs { file: String, reason: String },
    /// A translation targeted a declared pointer whose profile marks it
    /// [`Patchability::ReadOnly`]; it is rejected, never silently applied.
    #[error("kaifuu.rpgmaker.k111.non_patchable_pointer: {source_unit_key} is declared read-only")]
    NonPatchablePointer { source_unit_key: String },
    /// The reused byte-surgical splice failed (stale source, unresolved
    /// surface, overlap, …).
    #[error(transparent)]
    Splice(#[from] PatchbackError),
}

// plugins.js splitter (no JS execution)

/// The three byte ranges of a `plugins.js` file: the `var $plugins =` prefix,
/// the JSON `$plugins` array, and the trailing `;`(+ newline) suffix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PluginsJsSplit {
    array_start: usize,
    array_end: usize,
}

/// Split `plugins.js` bytes at the `$plugins` array literal. Locates the
/// `$plugins` token, the first `[` at/after it, and the matching `]` (bracket
/// matching that respects string literals). NEVER executes the JS.
fn split_plugins_js(file: &str, bytes: &[u8]) -> Result<PluginsJsSplit, String> {
    let anchor = find_subslice(bytes, b"$plugins")
        .ok_or_else(|| format!("{file}: no `$plugins` assignment found"))?;
    // First '[' at or after the anchor is the array opener.
    let array_start = bytes[anchor..]
        .iter()
        .position(|&b| b == b'[')
        .map(|off| anchor + off)
        .ok_or_else(|| format!("{file}: no `[` opening the $plugins array"))?;
    let array_end = match_bracket(bytes, array_start)
        .ok_or_else(|| format!("{file}: unterminated $plugins array literal"))?;
    Ok(PluginsJsSplit {
        array_start,
        array_end,
    })
}

/// Find the first occurrence of `needle` in `haystack`.
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Given the index of an opening `[`, return the index of the matching `]`,
/// respecting nested ``/`{}` and skipping string literals (with escapes).
/// Returns `None` if the bracket is never closed.
fn match_bracket(bytes: &[u8], open: usize) -> Option<usize> {
    debug_assert_eq!(bytes.get(open), Some(&b'['));
    let mut depth = 0usize;
    let mut i = open;
    let mut in_string = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            match c {
                b'\\' => i += 1, // skip the escaped byte
                b'"' => in_string = false,
                _ => {}
            }
        } else {
            match c {
                b'"' => in_string = true,
                b'[' | b'{' => depth += 1,
                b']' | b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

// Extraction — pure

/// Resolve a pointer's tokens against a JSON value (object keys / array
/// indices). Returns `None` if any token does not navigate.
fn resolve_pointer<'a>(value: &'a Value, tokens: &[String]) -> Option<&'a Value> {
    let mut current = value;
    for token in tokens {
        current = match current {
            Value::Object(map) => map.get(token)?,
            Value::Array(arr) => arr.get(token.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

/// Count the non-empty string values reachable one level deep in a plugin's
/// `parameters` object (the "does this plugin carry text?" heuristic used ONLY
/// to decide whether an unprofiled plugin warrants a diagnostic — never to
/// extract). Nested objects/arrays count as potentially-text too.
fn plugin_carries_string_params(parameters: Option<&Value>) -> bool {
    match parameters {
        Some(Value::Object(map)) => map.values().any(value_has_nonempty_string),
        _ => false,
    }
}

fn value_has_nonempty_string(value: &Value) -> bool {
    match value {
        Value::String(s) => !s.is_empty(),
        Value::Array(arr) => arr.iter().any(value_has_nonempty_string),
        Value::Object(map) => map.values().any(value_has_nonempty_string),
        _ => false,
    }
}

/// Extract declared plugin-parameter text units from a parsed `$plugins`
/// array, using the DECLARED profiles. A plugin with no profile that carries
/// string params yields an [`PluginDiagnosticKind::UnsupportedPluginProfile`]
/// diagnostic; a declared pointer that is missing or non-text yields an
/// [`PluginDiagnosticKind::UnsupportedDeclaredPointer`] diagnostic.
#[must_use]
pub fn extract_plugins(
    source_file: &str,
    plugins: &Value,
    profiles: &[PluginProfile],
) -> PluginExtraction {
    let mut acc = PluginExtraction::default();
    let Some(array) = plugins.as_array() else {
        acc.diagnostics.push(PluginDiagnostic {
            kind: PluginDiagnosticKind::MalformedContainer,
            source_file: source_file.to_string(),
            plugin_name: None,
            pointer: Vec::new(),
            detail: "$plugins top level is not a JSON array".to_string(),
        });
        return acc;
    };

    for (plugin_index, entry) in array.iter().enumerate() {
        let Some(object) = entry.as_object() else {
            acc.diagnostics.push(PluginDiagnostic {
                kind: PluginDiagnosticKind::MalformedContainer,
                source_file: source_file.to_string(),
                plugin_name: None,
                pointer: vec![plugin_index.to_string()],
                detail: "$plugins entry is not a plugin object".to_string(),
            });
            continue;
        };
        let plugin_name = object
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let parameters = object.get("parameters");

        let Some(profile) = profile_for(profiles, &plugin_name) else {
            // No declared profile: DO NOT sweep the params. If the plugin
            // carries string params it may own text — one typed diagnostic.
            if plugin_carries_string_params(parameters) {
                acc.diagnostics.push(PluginDiagnostic {
                    kind: PluginDiagnosticKind::UnsupportedPluginProfile,
                    source_file: source_file.to_string(),
                    plugin_name: Some(plugin_name.clone()),
                    pointer: vec![plugin_index.to_string(), "parameters".to_string()],
                    detail:
                        "plugin has string parameters but no declared profile; its parameter text \
                         is not represented (declare a profile to extract it)"
                            .to_string(),
                });
            }
            continue;
        };

        extract_profiled_plugin(
            &mut acc,
            source_file,
            plugin_index,
            &plugin_name,
            entry,
            parameters,
            profile,
        );
    }

    acc
}

// reason: cohesive per-plugin extractor over distinct positional inputs.
#[allow(clippy::too_many_arguments)]
fn extract_profiled_plugin(
    acc: &mut PluginExtraction,
    source_file: &str,
    plugin_index: usize,
    plugin_name: &str,
    entry: &Value,
    parameters: Option<&Value>,
    profile: &PluginProfile,
) {
    let mut extracted_pointers: Vec<String> = Vec::new();

    for spec in &profile.params {
        let mut full_pointer = vec![plugin_index.to_string(), "parameters".to_string()];
        full_pointer.extend(spec.pointer.iter().cloned());

        // Resolve the declared pointer within the plugin's parameters object.
        let resolved = parameters.and_then(|params| resolve_pointer(params, &spec.pointer));
        match resolved {
            Some(Value::String(text)) if !text.is_empty() => {
                acc.units.push(StablePluginTextUnit {
                    source_file: source_file.to_string(),
                    plugin_name: plugin_name.to_string(),
                    plugin_id: profile.plugin_id.clone(),
                    plugin_index,
                    param_pointer: spec.pointer.clone(),
                    text_role: spec.text_role,
                    patchability: spec.patchability,
                    fixture_profile_id: FIXTURE_PROFILE_ID,
                    pointer: full_pointer,
                    source_text: text.clone(),
                });
                extracted_pointers.push(pointer_string_within_params(&spec.pointer));
            }
            // Empty declared string: not a translatable surface, not a
            // diagnostic (matches the empty-string handling).
            Some(Value::String(_)) => {}
            // Present but non-text (a numeric/switch string mistake), or the
            // pointer did not resolve at all → rejected, never extracted.
            _ => acc.diagnostics.push(PluginDiagnostic {
                kind: PluginDiagnosticKind::UnsupportedDeclaredPointer,
                source_file: source_file.to_string(),
                plugin_name: Some(plugin_name.to_string()),
                pointer: full_pointer,
                detail: if resolved.is_none() {
                    "declared parameter pointer did not resolve to a value; not extracted"
                        .to_string()
                } else {
                    "declared parameter pointer is present but not a JSON string \
                     (numeric/switch/structure); not extracted"
                        .to_string()
                },
            }),
        }
    }

    acc.profiled.push(ProfiledPlugin {
        plugin_id: profile.plugin_id.clone(),
        plugin_name: plugin_name.to_string(),
        plugin_index,
        declared_version: profile.plugin_version.clone(),
        fixture_hash: fixture_hash_of(entry),
        extracted_pointers,
        fixture_profile_id: FIXTURE_PROFILE_ID,
    });
}

/// RFC6901 pointer string for a pointer *within* the parameters object.
fn pointer_string_within_params(pointer: &[String]) -> String {
    let mut out = String::new();
    for token in pointer {
        out.push('/');
        out.push_str(&token.replace('~', "~0").replace('/', "~1"));
    }
    out
}

/// Content hash over a plugin entry's canonical JSON serialization. serde_json
/// (no `preserve_order`) sorts object keys, so this is deterministic and pins
/// exactly which plugin fixture was extracted.
fn fixture_hash_of(entry: &Value) -> String {
    let canonical = serde_json::to_vec(entry).unwrap_or_default();
    sha256_hash_bytes(&canonical)
}

// File-level extraction

/// Read `js/plugins.js`, split off its `$plugins` array, parse it, and extract
/// the declared plugin-profile text units. `MissingFile` / `MalformedJson` /
/// `MalformedPluginsJs` are typed semantic errors surfaced before any write.
pub fn extract_plugins_file(
    path: &Path,
    profiles: &[PluginProfile],
) -> Result<PluginExtraction, PluginExtractError> {
    let file = file_name(path);
    let bytes = read_bytes(path, &file)?;
    let split = split_plugins_js(&file, &bytes).map_err(|reason| {
        PluginExtractError::MalformedPluginsJs {
            file: file.clone(),
            reason,
        }
    })?;
    let array_bytes = &bytes[split.array_start..=split.array_end];
    let value: Value = serde_json::from_slice(array_bytes).map_err(|source| {
        PluginExtractError::MalformedJson {
            file: file.clone(),
            source,
        }
    })?;
    Ok(extract_plugins(&file, &value, profiles))
}

fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    )
}

fn read_bytes(path: &Path, file: &str) -> Result<Vec<u8>, PluginExtractError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            Err(PluginExtractError::MissingFile {
                file: file.to_string(),
            })
        }
        Err(source) => Err(PluginExtractError::Io {
            file: file.to_string(),
            source,
        }),
    }
}

// Byte-preserving patch

/// One reviewed translation: the stable unit + its target text.
#[derive(Debug, Clone)]
pub struct PluginTranslation<'a> {
    pub unit: &'a StablePluginTextUnit,
    pub target_text: String,
}

/// Patch a whole `plugins.js` file's raw bytes with reviewed translations for
/// its declared plugin-parameter units, preserving every other byte.
/// The file is split into `(prefix, $plugins array, suffix)`; only the array
/// bytes are spliced (reusing [`crate::patchback::patch_file_bytes`] — the
/// same byte-surgical splice + stale-source gate as the
/// slices), then reassembled. The `var $plugins =` prefix and the trailing
/// `;` suffix are preserved verbatim, so an untranslated patch is a
/// byte-identical no-op and a translated patch changes only the declared
/// parameter literals. A translation targeting a [`Patchability::ReadOnly`]
/// unit is rejected.
pub fn patch_file(
    source_file: &str,
    original: &[u8],
    translations: &[PluginTranslation<'_>],
) -> Result<Vec<u8>, PluginPatchError> {
    for t in translations {
        if t.unit.patchability == Patchability::ReadOnly {
            return Err(PluginPatchError::NonPatchablePointer {
                source_unit_key: t.unit.source_unit_key(),
            });
        }
    }

    let split = split_plugins_js(source_file, original).map_err(|reason| {
        PluginPatchError::MalformedPluginsJs {
            file: source_file.to_string(),
            reason,
        }
    })?;
    let prefix = &original[..split.array_start];
    let array_bytes = &original[split.array_start..=split.array_end];
    let suffix = &original[split.array_end + 1..];

    let edits: Vec<FileEdit> = translations
        .iter()
        .map(|t| FileEdit {
            source_unit_key: t.unit.source_unit_key(),
            tokens: t.unit.pointer.clone(),
            target_text: t.target_text.clone(),
            expected_source_hash: sha256_hash_bytes(t.unit.source_text.as_bytes()),
        })
        .collect();

    let patched_array = patch_file_bytes(source_file, array_bytes, &edits)?;

    let mut out = Vec::with_capacity(prefix.len() + patched_array.len() + suffix.len());
    out.extend_from_slice(prefix);
    out.extend_from_slice(&patched_array);
    out.extend_from_slice(suffix);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message_box_profile() -> PluginProfile {
        PluginProfile {
            plugin_name: "MessageBox".to_string(),
            plugin_id: "com.example.MessageBox".to_string(),
            plugin_version: Some("1.2.0".to_string()),
            params: vec![
                PluginParamPointer {
                    pointer: vec!["windowTitle".to_string()],
                    text_role: PluginTextRole::UiLabel,
                    patchability: Patchability::Patchable,
                },
                PluginParamPointer {
                    pointer: vec!["okButton".to_string()],
                    text_role: PluginTextRole::UiLabel,
                    patchability: Patchability::Patchable,
                },
            ],
        }
    }

    #[test]
    fn declared_pointers_extract_only_and_config_params_do_not() {
        let plugins = json!([
            {
                "name": "MessageBox",
                "status": true,
                "description": "A message box plugin.",
                "parameters": {
                    "windowTitle": "Dialogue",
                    "okButton": "Confirm",
                    "maxWidth": "800",
                    "switchId": "12"
                }
            }
        ]);
        let out = extract_plugins("plugins.js", &plugins, &[message_box_profile()]);
        // Only the two DECLARED pointers extract; maxWidth/switchId do not.
        let keys: Vec<String> = out
            .units
            .iter()
            .map(StablePluginTextUnit::source_unit_key)
            .collect();
        assert_eq!(
            keys,
            vec![
                "rpgmaker:plugins.js#/0/parameters/windowTitle",
                "rpgmaker:plugins.js#/0/parameters/okButton",
            ]
        );
        assert!(
            out.diagnostics.is_empty(),
            "clean profiled plugin: no diags"
        );
        // Profile output records id + declared version + fixture hash + pointers.
        assert_eq!(out.profiled.len(), 1);
        let p = &out.profiled[0];
        assert_eq!(p.plugin_id, "com.example.MessageBox");
        assert_eq!(p.declared_version.as_deref(), Some("1.2.0"));
        assert!(p.fixture_hash.starts_with("sha256:"));
        assert_eq!(p.extracted_pointers, vec!["/windowTitle", "/okButton"]);
        for u in &out.units {
            assert_eq!(u.fixture_profile_id, "KAIFUU-111");
            assert_eq!(u.plugin_id, "com.example.MessageBox");
        }
    }

    #[test]
    fn unprofiled_plugin_with_string_params_is_a_diagnostic() {
        let plugins = json!([
            {
                "name": "MysteryPlugin",
                "status": true,
                "description": "",
                "parameters": {"greeting": "Hello there"}
            }
        ]);
        let out = extract_plugins("plugins.js", &plugins, &[]);
        assert!(out.units.is_empty(), "no profile -> no extraction");
        assert_eq!(out.diagnostics.len(), 1);
        assert_eq!(
            out.diagnostics[0].kind,
            PluginDiagnosticKind::UnsupportedPluginProfile
        );
        assert_eq!(
            out.diagnostics[0].plugin_name.as_deref(),
            Some("MysteryPlugin")
        );
    }

    #[test]
    fn unprofiled_plugin_with_no_string_params_is_silent() {
        // A config-only plugin (numeric strings only would still count as text;
        // here we use a params object with only an empty string) does not warn.
        let plugins = json!([
            {"name": "PurelyNumeric", "status": true, "parameters": {"opacity": ""}}
        ]);
        let out = extract_plugins("plugins.js", &plugins, &[]);
        assert!(out.units.is_empty());
        assert!(
            out.diagnostics.is_empty(),
            "no non-empty string params -> no unsupported-profile noise"
        );
    }

    #[test]
    fn declared_pointer_to_missing_or_nontext_is_rejected() {
        let profile = PluginProfile {
            plugin_name: "Broken".to_string(),
            plugin_id: "broken".to_string(),
            plugin_version: None,
            params: vec![
                // Declares a pointer at a NUMERIC (non-text) value: a mistake.
                PluginParamPointer {
                    pointer: vec!["count".to_string()],
                    text_role: PluginTextRole::Caption,
                    patchability: Patchability::Patchable,
                },
                // Declares a pointer that does not resolve.
                PluginParamPointer {
                    pointer: vec!["ghost".to_string()],
                    text_role: PluginTextRole::Caption,
                    patchability: Patchability::Patchable,
                },
            ],
        };
        let plugins = json!([
            {"name": "Broken", "status": true, "parameters": {"count": 42}}
        ]);
        let out = extract_plugins("plugins.js", &plugins, &[profile]);
        assert!(
            out.units.is_empty(),
            "non-text/missing pointers not extracted"
        );
        assert_eq!(out.diagnostics.len(), 2);
        for d in &out.diagnostics {
            assert_eq!(d.kind, PluginDiagnosticKind::UnsupportedDeclaredPointer);
        }
        // The plugin is still recorded (with no extracted pointers).
        assert_eq!(out.profiled.len(), 1);
        assert!(out.profiled[0].extracted_pointers.is_empty());
    }

    #[test]
    fn split_plugins_js_isolates_the_array() {
        let src = b"// header\nvar $plugins =\n[\n{\"name\":\"A\"}\n];\n";
        let split = split_plugins_js("plugins.js", src).unwrap();
        let array = &src[split.array_start..=split.array_end];
        let value: Value = serde_json::from_slice(array).unwrap();
        assert_eq!(value.as_array().unwrap().len(), 1);
        assert_eq!(&src[..split.array_start], b"// header\nvar $plugins =\n");
        assert_eq!(&src[split.array_end + 1..], b";\n");
    }

    #[test]
    fn match_bracket_respects_strings_and_nesting() {
        let src = br#"[{"a":"]}"},{"b":[1,2]}]TAIL"#;
        let close = match_bracket(src, 0).unwrap();
        assert_eq!(src[close], b']');
        assert_eq!(&src[close + 1..], b"TAIL");
    }

    #[test]
    fn malformed_container_is_a_diagnostic() {
        let out = extract_plugins("plugins.js", &json!({"not": "array"}), &[]);
        assert!(out.units.is_empty());
        assert_eq!(
            out.diagnostics[0].kind,
            PluginDiagnosticKind::MalformedContainer
        );
    }

    #[test]
    fn deterministic_reextraction_and_bridge_ids() {
        let plugins = json!([
            {"name": "MessageBox", "parameters": {"windowTitle": "T", "okButton": "OK"}}
        ]);
        let first = extract_plugins("plugins.js", &plugins, &[message_box_profile()]);
        let second = extract_plugins("plugins.js", &plugins, &[message_box_profile()]);
        assert_eq!(first, second);
        assert_eq!(
            first.units[0].bridge_unit_id(),
            second.units[0].bridge_unit_id()
        );
    }

    #[test]
    fn read_only_pointer_translation_is_rejected() {
        let profile = PluginProfile {
            plugin_name: "RO".to_string(),
            plugin_id: "ro".to_string(),
            plugin_version: None,
            params: vec![PluginParamPointer {
                pointer: vec!["label".to_string()],
                text_role: PluginTextRole::UiLabel,
                patchability: Patchability::ReadOnly,
            }],
        };
        let plugins = json!([{"name": "RO", "parameters": {"label": "Fixed"}}]);
        let out = extract_plugins("plugins.js", &plugins, &[profile]);
        assert_eq!(out.units.len(), 1);
        let src = b"var $plugins =\n[{\"name\":\"RO\",\"parameters\":{\"label\":\"Fixed\"}}];\n";
        let err = patch_file(
            "plugins.js",
            src,
            &[PluginTranslation {
                unit: &out.units[0],
                target_text: "Changed".to_string(),
            }],
        )
        .expect_err("read-only pointer must be rejected");
        assert!(matches!(err, PluginPatchError::NonPatchablePointer { .. }));
    }
}
