//! MV/MZ `Map*.json` + `CommonEvents.json` command-text
//! extract & trivial patch.
//! This is the beta-tier map / common-event slice declared by the
//! fixture profile (`MvMzFixtureProfile` consumer ``
//! surfaces `www/data/Map*.json` + `www/data/CommonEvents.json`). It emits
//! **stable command-text units** and writes a **byte-preserving** patch back
//! into the same JSON.
//! # Declared command-text surfaces
//! The profile declares these event-command text surfaces for the
//! map / common-event slice; each is cross-checked against the shared
//! [`classify`] catalogue (`command_text_role` only ever maps codes the
//! catalogue already recognises — never an [`CodeClass::Unknown`] code):
//! - **Show Text** line — code `401` → [`CommandTextRole::ShowText`].
//! - **Show Choices** options — code `102` (`parameters[0]` string array) →
//!   one [`CommandTextRole::ChoiceOption`] per option, plus the per-branch
//!   **When [choice]** labels — code `402` (`parameters[1]`) →
//!   [`CommandTextRole::ChoiceBranch`].
//! - **Show Scrolling Text** line — code `405` →
//!   [`CommandTextRole::ScrollingText`] (the `105` setup carries no text).
//! - **Comment** — codes `108` (first line) + `408` (continuation) →
//!   [`CommandTextRole::Comment`].
//! # Stable unit fields (acceptance)
//! Every [`StableCommandUnit`] carries `source_file`, the event /
//! common-event **id**, the **page index** (maps only), the **command
//! index**, the **text role**, and the **fixture-profile id**
//! ([`FIXTURE_PROFILE_ID`]). Its stable `rpgmaker:<file>#<json-pointer>`
//! [`StableCommandUnit::source_unit_key`] and deterministic
//! [`StableCommandUnit::bridge_unit_id`] make re-extraction and patchback
//! target the same surface.
//! # Byte-preserving patch
//! [`patch_file`] reuses the crate's proven byte-surgical splice
//! ([`crate::patchback`]): only the located string literal for each declared
//! unit is replaced; every other byte (structure, key order, whitespace,
//! non-text fields, untouched strings) is preserved verbatim. An untranslated
//! patch (`target == source`) is a byte-identical no-op.
//! # Semantic diagnostics before any write
//! Extraction records an [`UnsupportedCommand`](CommandDiagnosticKind) for
//! every event-command code the shared catalogue does not recognise, and the
//! file-level [`extract_map_file`] / [`extract_common_events_file`] return a
//! typed [`MapExtractError`] (`MalformedJson` / `MissingFile`) — all before
//! any patch byte is written.

use std::path::Path;

use serde_json::Value;
use thiserror::Error;

use kaifuu_core::sha256_hash_bytes;

use crate::codes::{CodeClass, classify};
use crate::ids::deterministic_uuid7;
use crate::patchback::{FileEdit, PatchbackError, patch_file_bytes};

/// The fixture-profile id every unit is stamped.
pub const FIXTURE_PROFILE_ID: &str = "KAIFUU-109";

/// Where a declared command lives in the source tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandContainer {
    /// `Map*.json events[…].pages[page_index]`. `event_id` is the event's
    /// own `id` field (the human-facing id); `event_index` is its position
    /// in the `events` array (what the JSON pointer navigates).
    MapEvent {
        event_id: i64,
        event_index: usize,
        page_index: usize,
    },
    /// `CommonEvents.json[…]`. `common_event_id` is the entry's `id` field;
    /// `entry_index` is its array position (what the pointer navigates).
    CommonEvent {
        common_event_id: i64,
        entry_index: usize,
    },
}

/// The declared command-text role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandTextRole {
    /// `Show Text` body line (code `401`).
    ShowText,
    /// One `Show Choices` option (code `102`, `parameters[0][i]`).
    ChoiceOption,
    /// A `When [choice]` branch label (code `402`, `parameters[1]`).
    ChoiceBranch,
    /// `Show Scrolling Text` body line (code `405`).
    ScrollingText,
    /// A `Comment` line (codes `108` / `408`).
    Comment,
}

impl CommandTextRole {
    /// Stable snake-case tag (bridge / report friendly).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ShowText => "show_text",
            Self::ChoiceOption => "choice_option",
            Self::ChoiceBranch => "choice_branch",
            Self::ScrollingText => "scrolling_text",
            Self::Comment => "comment",
        }
    }
}

/// Map an event-command `code` to its declared command-text role
/// or `None` when the code is not a text surface.
/// Every code returned here is a recognised [`classify`] catalogue code (the
/// crate test `every_declared_code_is_catalogue_recognised` pins this), so
/// the surface set never drifts from the shared catalogue.
fn command_text_role(code: i64) -> Option<CommandTextRole> {
    match code {
        401 => Some(CommandTextRole::ShowText),
        102 => Some(CommandTextRole::ChoiceOption),
        402 => Some(CommandTextRole::ChoiceBranch),
        405 => Some(CommandTextRole::ScrollingText),
        108 | 408 => Some(CommandTextRole::Comment),
        _ => None,
    }
}

/// A stable map / common-event command-text unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StableCommandUnit {
    /// Source file name (e.g. `Map001.json`, `CommonEvents.json`).
    pub source_file: String,
    /// Which event / common-event + page the command belongs to.
    pub container: CommandContainer,
    /// Index of the command within its `list`.
    pub command_index: usize,
    /// For [`CommandTextRole::ChoiceOption`], the option's index within the
    /// `Show Choices` array; `None` for every other role.
    pub option_index: Option<usize>,
    /// The declared command-text role.
    pub text_role: CommandTextRole,
    /// The fixture-profile id ([`FIXTURE_PROFILE_ID`]).
    pub fixture_profile_id: &'static str,
    /// RFC6901 pointer tokens locating the string literal in `source_file`.
    pub pointer: Vec<String>,
    /// The decoded source text (the raw JSON string value).
    pub source_text: String,
}

impl StableCommandUnit {
    /// The event id (maps) or common-event id — the
    /// "event/common-event id" acceptance field.
    #[must_use]
    pub const fn container_id(&self) -> i64 {
        match self.container {
            CommandContainer::MapEvent { event_id, .. } => event_id,
            CommandContainer::CommonEvent {
                common_event_id, ..
            } => common_event_id,
        }
    }

    /// The page index (maps only; `None` for common events).
    #[must_use]
    pub const fn page_index(&self) -> Option<usize> {
        match self.container {
            CommandContainer::MapEvent { page_index, .. } => Some(page_index),
            CommandContainer::CommonEvent { .. } => None,
        }
    }

    /// RFC6901 pointer string (`/events/1/pages/0/list/3/parameters/0`).
    #[must_use]
    pub fn pointer_string(&self) -> String {
        let mut out = String::new();
        for token in &self.pointer {
            out.push('/');
            out.push_str(&token.replace('~', "~0").replace('/', "~1"));
        }
        out
    }

    /// Stable surface id: `rpgmaker:<file>#<pointer>` — identical scheme to
    /// the alpha extractor, so patchback resolves both.
    #[must_use]
    pub fn source_unit_key(&self) -> String {
        format!("rpgmaker:{}#{}", self.source_file, self.pointer_string())
    }

    /// Deterministic bridge-unit id derived from the fixture profile +
    /// surface key (UUID7-shaped; identical construction to the crate's
    /// bridge producer).
    #[must_use]
    pub fn bridge_unit_id(&self) -> String {
        deterministic_uuid7(
            &format!("rpgmaker-k109:{}", self.fixture_profile_id),
            &format!("unit-{}", self.source_unit_key()),
        )
    }
}

/// Category of a [`CommandDiagnostic`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandDiagnosticKind {
    /// An event-command code the shared [`classify`] catalogue does not
    /// recognise; it may carry untracked translatable text.
    UnsupportedCommand,
}

/// A structural, no-retail-text diagnostic recorded during extraction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandDiagnostic {
    pub kind: CommandDiagnosticKind,
    pub source_file: String,
    /// The offending command code, when applicable.
    pub command_code: Option<i64>,
    /// RFC6901 pointer tokens to the offending command entry.
    pub pointer: Vec<String>,
    /// Structural description only — never retail string content.
    pub detail: String,
}

/// Output of the pure per-value extractors.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MapExtraction {
    pub units: Vec<StableCommandUnit>,
    pub diagnostics: Vec<CommandDiagnostic>,
}

/// Typed, semantic errors raised by the file-level extractors *before any
/// write* — the "malformed JSON / missing file" diagnostics.
#[derive(Debug, Error)]
pub enum MapExtractError {
    #[error("kaifuu.rpgmaker.k109.missing_file: {file} does not exist")]
    MissingFile { file: String },
    #[error("kaifuu.rpgmaker.k109.io: {file}: {source}")]
    Io {
        file: String,
        #[source]
        source: std::io::Error,
    },
    #[error("kaifuu.rpgmaker.k109.malformed_json: {file}: {source}")]
    MalformedJson {
        file: String,
        #[source]
        source: serde_json::Error,
    },
}

// Extraction

/// Walk one top-level event-command `list`, appending declared units +
/// diagnostics. `pointer_base` is the RFC6901 token prefix to the `list`
/// array; `container` labels each unit's owning event / common-event.
fn walk_list(
    acc: &mut MapExtraction,
    source_file: &str,
    pointer_base: &[String],
    container: &CommandContainer,
    list: &[Value],
) {
    for (command_index, entry) in list.iter().enumerate() {
        let Some(code) = entry.get("code").and_then(Value::as_i64) else {
            continue;
        };
        let params = entry.get("parameters").and_then(Value::as_array);

        // Command-entry pointer prefix: <base>/list/<command_index>.
        let cmd_pointer = |extra: &[&str]| {
            let mut p = pointer_base.to_vec();
            p.push(command_index.to_string());
            for token in extra {
                p.push((*token).to_string());
            }
            p
        };

        // No-silent-skip: an unrecognised catalogue code is a diagnostic.
        if classify(code) == CodeClass::Unknown {
            acc.diagnostics.push(CommandDiagnostic {
                kind: CommandDiagnosticKind::UnsupportedCommand,
                source_file: source_file.to_string(),
                command_code: Some(code),
                pointer: cmd_pointer(&[]),
                detail: "unrecognised event-command code; may carry untracked translatable text"
                    .to_string(),
            });
        }

        let Some(role) = command_text_role(code) else {
            continue;
        };

        match role {
            CommandTextRole::ShowText
            | CommandTextRole::ScrollingText
            | CommandTextRole::Comment => {
                if let Some(text) = params.and_then(|p| p.first()).and_then(Value::as_str) {
                    push_unit(
                        acc,
                        source_file,
                        container,
                        command_index,
                        None,
                        role,
                        cmd_pointer(&["parameters", "0"]),
                        text,
                    );
                }
            }
            CommandTextRole::ChoiceBranch => {
                // 402 `When [choice]`: the branch label is `parameters[1]`.
                if let Some(text) = params.and_then(|p| p.get(1)).and_then(Value::as_str) {
                    push_unit(
                        acc,
                        source_file,
                        container,
                        command_index,
                        None,
                        role,
                        cmd_pointer(&["parameters", "1"]),
                        text,
                    );
                }
            }
            CommandTextRole::ChoiceOption => {
                // 102 `Show Choices`: `parameters[0]` is the option array.
                if let Some(options) = params.and_then(|p| p.first()).and_then(Value::as_array) {
                    for (option_index, option) in options.iter().enumerate() {
                        if let Some(text) = option.as_str() {
                            push_unit(
                                acc,
                                source_file,
                                container,
                                command_index,
                                Some(option_index),
                                role,
                                cmd_pointer(&["parameters", "0", &option_index.to_string()]),
                                text,
                            );
                        }
                    }
                }
            }
        }
    }
}

// reason: cohesive unit constructor over distinct positional fields; a struct would relocate the arity without clarity.
#[allow(clippy::too_many_arguments)]
fn push_unit(
    acc: &mut MapExtraction,
    source_file: &str,
    container: &CommandContainer,
    command_index: usize,
    option_index: Option<usize>,
    text_role: CommandTextRole,
    pointer: Vec<String>,
    text: &str,
) {
    // Empty strings are not translatable surfaces (matches the alpha
    // extractor); skipping one is not a silent drop of translatable text.
    if text.is_empty() {
        return;
    }
    acc.units.push(StableCommandUnit {
        source_file: source_file.to_string(),
        container: container.clone(),
        command_index,
        option_index,
        text_role,
        fixture_profile_id: FIXTURE_PROFILE_ID,
        pointer,
        source_text: text.to_string(),
    });
}

/// Read the object's `id` field (fallback to the array `index`).
fn object_id(entry: &Value, index: usize) -> i64 {
    entry
        .get("id")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| i64::try_from(index).unwrap_or(i64::MAX))
}

/// Extract declared command-text units from a parsed `Map*.json` value.
#[must_use]
pub fn extract_map(source_file: &str, map: &Value) -> MapExtraction {
    let mut acc = MapExtraction::default();
    let Some(events) = map.get("events").and_then(Value::as_array) else {
        return acc;
    };
    for (event_index, event) in events.iter().enumerate() {
        let Some(pages) = event.get("pages").and_then(Value::as_array) else {
            continue;
        };
        let event_id = object_id(event, event_index);
        for (page_index, page) in pages.iter().enumerate() {
            let Some(list) = page.get("list").and_then(Value::as_array) else {
                continue;
            };
            let container = CommandContainer::MapEvent {
                event_id,
                event_index,
                page_index,
            };
            let pointer_base = vec![
                "events".to_string(),
                event_index.to_string(),
                "pages".to_string(),
                page_index.to_string(),
                "list".to_string(),
            ];
            walk_list(&mut acc, source_file, &pointer_base, &container, list);
        }
    }
    acc
}

/// Extract declared command-text units from a parsed `CommonEvents.json`.
#[must_use]
pub fn extract_common_events(source_file: &str, common_events: &Value) -> MapExtraction {
    let mut acc = MapExtraction::default();
    let Some(array) = common_events.as_array() else {
        return acc;
    };
    for (entry_index, entry) in array.iter().enumerate() {
        let Some(list) = entry.get("list").and_then(Value::as_array) else {
            continue;
        };
        let container = CommandContainer::CommonEvent {
            common_event_id: object_id(entry, entry_index),
            entry_index,
        };
        let pointer_base = vec![entry_index.to_string(), "list".to_string()];
        walk_list(&mut acc, source_file, &pointer_base, &container, list);
    }
    acc
}

/// Read + parse a `Map*.json` file and extract its units. `MissingFile` /
/// `MalformedJson` are typed semantic errors surfaced before any write.
pub fn extract_map_file(path: &Path) -> Result<MapExtraction, MapExtractError> {
    let (file, value) = read_json(path)?;
    Ok(extract_map(&file, &value))
}

/// Read + parse a `CommonEvents.json` file and extract its units.
pub fn extract_common_events_file(path: &Path) -> Result<MapExtraction, MapExtractError> {
    let (file, value) = read_json(path)?;
    Ok(extract_common_events(&file, &value))
}

fn read_json(path: &Path) -> Result<(String, Value), MapExtractError> {
    let file = path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Err(MapExtractError::MissingFile { file });
        }
        Err(source) => return Err(MapExtractError::Io { file, source }),
    };
    let value =
        serde_json::from_slice(crate::json_locate::strip_utf8_bom(&bytes)).map_err(|source| {
            MapExtractError::MalformedJson {
                file: file.clone(),
                source,
            }
        })?;
    Ok((file, value))
}

// Byte-preserving patch

/// One reviewed translation: the stable unit + its target text.
#[derive(Debug, Clone)]
pub struct CommandTranslation<'a> {
    pub unit: &'a StableCommandUnit,
    pub target_text: String,
}

/// Patch one file's raw JSON bytes with the reviewed translations for its
/// declared command-text units, preserving every other byte.
/// Reuses the crate's proven byte-surgical splice + stale-source gate
/// ([`crate::patchback`]): the located literal for each unit must hash to the
/// unit's `source_text` (else [`PatchbackError::StaleSource`]), a no-op edit
/// (`target == source`) leaves the bytes untouched, and only the located
/// string literals ever change. Every `translation.unit.source_file` must be
/// `source_file`.
pub fn patch_file(
    source_file: &str,
    original: &[u8],
    translations: &[CommandTranslation<'_>],
) -> Result<Vec<u8>, PatchbackError> {
    let edits: Vec<FileEdit> = translations
        .iter()
        .map(|t| FileEdit {
            source_unit_key: t.unit.source_unit_key(),
            tokens: t.unit.pointer.clone(),
            target_text: t.target_text.clone(),
            expected_source_hash: sha256_hash_bytes(t.unit.source_text.as_bytes()),
        })
        .collect();
    patch_file_bytes(source_file, original, &edits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_declared_code_is_catalogue_recognised() {
        // The surface set never drifts from the shared catalogue
        // every code `command_text_role` handles is a recognised classify
        // code (never Unknown).
        for code in [401, 102, 402, 405, 108, 408] {
            assert!(command_text_role(code).is_some());
            assert_ne!(
                classify(code),
                CodeClass::Unknown,
                "declared code {code} must be catalogue-recognised"
            );
        }
    }

    #[test]
    fn extract_map_covers_all_declared_surfaces_with_stable_fields() {
        let map = json!({
            "displayName": "Town",
            "events": [null, {"id": 7, "pages": [{"list": [
                {"code": 101, "parameters": ["Face", 0, 0, 2, "Hero"]},
                {"code": 401, "parameters": ["Show text line"]},
                {"code": 102, "parameters": [["Yes", "No"], 1, 0, 2, 0]},
                {"code": 402, "parameters": [0, "Yes"]},
                {"code": 404, "parameters": []},
                {"code": 105, "parameters": [2, false]},
                {"code": 405, "parameters": ["Scrolling line"]},
                {"code": 108, "parameters": ["Comment head"]},
                {"code": 408, "parameters": ["Comment tail"]},
                {"code": 999, "parameters": []}
            ]}]}]
        });
        let out = extract_map("Map001.json", &map);

        let roles: Vec<CommandTextRole> = out.units.iter().map(|u| u.text_role).collect();
        assert_eq!(
            roles,
            vec![
                CommandTextRole::ShowText,
                CommandTextRole::ChoiceOption,
                CommandTextRole::ChoiceOption,
                CommandTextRole::ChoiceBranch,
                CommandTextRole::ScrollingText,
                CommandTextRole::Comment,
                CommandTextRole::Comment,
            ]
        );

        // Every stable-unit acceptance field is populated.
        for unit in &out.units {
            assert_eq!(unit.source_file, "Map001.json");
            assert_eq!(unit.container_id(), 7, "event id");
            assert_eq!(unit.page_index(), Some(0), "page index");
            assert_eq!(unit.fixture_profile_id, "KAIFUU-109");
            assert!(!unit.bridge_unit_id().is_empty());
            assert!(unit.source_unit_key().starts_with("rpgmaker:Map001.json#/"));
        }

        // Command indices are the list positions.
        let show_text = &out.units[0];
        assert_eq!(show_text.command_index, 1);
        assert_eq!(
            show_text.source_unit_key(),
            "rpgmaker:Map001.json#/events/1/pages/0/list/1/parameters/0"
        );
        // Choice option pointer indexes into the option array.
        assert_eq!(out.units[2].option_index, Some(1));
        assert_eq!(
            out.units[2].source_unit_key(),
            "rpgmaker:Map001.json#/events/1/pages/0/list/2/parameters/0/1"
        );
        // Choice branch label is parameters[1].
        assert_eq!(
            out.units[3].source_unit_key(),
            "rpgmaker:Map001.json#/events/1/pages/0/list/3/parameters/1"
        );

        // The unrecognised code 999 becomes a semantic diagnostic, never a
        // silent drop.
        assert_eq!(out.diagnostics.len(), 1);
        assert_eq!(out.diagnostics[0].command_code, Some(999));
        assert_eq!(
            out.diagnostics[0].kind,
            CommandDiagnosticKind::UnsupportedCommand
        );
    }

    #[test]
    fn extract_common_events_has_no_page_index() {
        let common = json!([
            null,
            {"id": 3, "name": "CE", "list": [
                {"code": 401, "parameters": ["Common line"]}
            ]}
        ]);
        let out = extract_common_events("CommonEvents.json", &common);
        assert_eq!(out.units.len(), 1);
        assert_eq!(out.units[0].container_id(), 3);
        assert_eq!(out.units[0].page_index(), None);
        assert_eq!(
            out.units[0].source_unit_key(),
            "rpgmaker:CommonEvents.json#/1/list/0/parameters/0"
        );
    }

    #[test]
    fn empty_command_text_is_not_a_unit() {
        let map = json!({"events": [null, {"id": 1, "pages": [{"list": [
            {"code": 401, "parameters": [""]},
            {"code": 108, "parameters": [""]}
        ]}]}]});
        assert!(extract_map("Map001.json", &map).units.is_empty());
    }
}
