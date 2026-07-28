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
pub const FIXTURE_PROFILE_ID: &str = "synthetic-fixture";

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

mod extraction;

pub use extraction::*;

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
mod tests;
