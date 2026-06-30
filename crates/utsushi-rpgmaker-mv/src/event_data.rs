//! Clean-room RPG Maker MV/MZ event-command data model and text-stream walk.
//!
//! RPG Maker MV/MZ ships its game database as a directory of JSON files.
//! MV places them under `www/data/`; MZ places them under `data/`. Each
//! map (`MapNNN.json`) and the common-event table (`CommonEvents.json`)
//! carries an ordered list of *event commands* — `{ code, indent,
//! parameters }` objects — and the runtime dispatches them top-to-bottom.
//!
//! This module is the runtime port's own parser. It does **not** depend on
//! `kaifuu-rpgmaker`: the format it recognises is the same, but the
//! implementation stays separate so a regression in one project cannot
//! poison the other. The command-code numbers (`101`, `401`, `405`,
//! `102`, `105`) are public RPG Maker MV/MZ engine constants documented
//! across the community wikis; no game-specific bytes inform this table.
//!
//! The walk is a *static event-stream walk*, not a live interpreter: it
//! visits every command in declaration order and surfaces the text-bearing
//! ones. It does not evaluate conditional branches, choose choice options,
//! or thread variable state. That deliberate limitation is what pins the
//! port at the trace-only / E1 evidence tier (see `port.rs`).

use std::path::{Path, PathBuf};

use serde_json::Value;

/// Where a project keeps its `data/` directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DataLayout {
    /// MV: `www/data/*.json`.
    Mv,
    /// MZ: `data/*.json`.
    Mz,
}

impl DataLayout {
    /// Stable lowercase identifier used in snapshot state and the asset
    /// package id.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mv => "mv",
            Self::Mz => "mz",
        }
    }

    /// The VFS package id the layout's assets are addressed under
    /// (`vfs://www/...` for MV, `vfs://game/...` for MZ).
    pub fn asset_package(self) -> &'static str {
        match self {
            Self::Mv => "www",
            Self::Mz => "game",
        }
    }
}

/// A resolved project data directory.
#[derive(Clone, Debug)]
pub struct DataDir {
    pub layout: DataLayout,
    pub root: PathBuf,
}

impl DataDir {
    /// Resolve a project's data directory from the run's input root.
    ///
    /// MV (`www/data/`) is checked first because an MV export also has a
    /// top-level `www/` directory; MZ (`data/`) is the fallback. Returns
    /// `None` if neither layout is present.
    pub fn discover(input_root: &Path) -> Option<Self> {
        let mv = input_root.join("www").join("data");
        if mv.is_dir() {
            return Some(Self {
                layout: DataLayout::Mv,
                root: mv,
            });
        }
        let mz = input_root.join("data");
        if mz.is_dir() {
            return Some(Self {
                layout: DataLayout::Mz,
                root: mz,
            });
        }
        None
    }
}

/// The translatable role a text-bearing command plays.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextRole {
    /// `Show Text` body line (code 401).
    Dialogue,
    /// `Show Scrolling Text` body line (code 405).
    Scrolling,
    /// One `Show Choices` option (code 102 parameters\[0\]\[i\]).
    Choice,
}

impl TextRole {
    /// Engine-neutral surface label attached to the emitted text line.
    pub fn surface_label(self) -> &'static str {
        match self {
            Self::Dialogue => "event_text",
            Self::Scrolling => "scrolling_text",
            Self::Choice => "choice",
        }
    }
}

/// One observed text line, in the order the runtime would dispatch it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageLine {
    /// Source data file (e.g. `Map001.json`, `CommonEvents.json`).
    pub file: String,
    /// RFC6901-style JSON-pointer tokens locating the string in `file`.
    pub pointer: Vec<String>,
    pub role: TextRole,
    /// Decoded line text exactly as the runtime would emit it.
    pub text: String,
    /// Speaker label, when the preceding `Show Text` setup (code 101,
    /// MZ parameters\[4\]) declared one.
    pub speaker: Option<String>,
    /// Index of the `Show Text` / `Show Choices` window this line belongs
    /// to, monotonically increasing within a file. Groups consecutive 401
    /// lines that share one window.
    pub message_group: usize,
}

impl MessageLine {
    /// RFC6901 pointer string (`/events/5/pages/0/list/12/parameters/0`).
    pub fn pointer_string(&self) -> String {
        let mut out = String::new();
        for token in &self.pointer {
            out.push('/');
            out.push_str(&token.replace('~', "~0").replace('/', "~1"));
        }
        out
    }

    /// Stable cross-reference key into the source data.
    pub fn source_unit_key(&self) -> String {
        format!("rpgmaker-mv:{}#{}", self.file, self.pointer_string())
    }
}

/// Result of walking a whole project: the ordered text stream plus the
/// inventory counts the port exposes through its snapshot surface.
#[derive(Clone, Debug, Default)]
pub struct PlaybackProgram {
    pub lines: Vec<MessageLine>,
    /// Number of data files that contributed at least one parsed event
    /// list (whether or not they yielded text).
    pub files_loaded: usize,
}

/// Error surfaced while loading a project's event data.
#[derive(Debug)]
pub enum EventDataError {
    /// Neither `www/data/` (MV) nor `data/` (MZ) exists under the input
    /// root.
    NoDataDirectory,
    /// A data file could not be read.
    Read { file: String, reason: String },
    /// A data file did not parse as JSON.
    Parse { file: String, reason: String },
    /// The data directory has no recognised event-data files
    /// (`CommonEvents.json` or `MapNNN.json`).
    NoEventFiles,
}

impl std::fmt::Display for EventDataError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoDataDirectory => {
                write!(
                    formatter,
                    "no www/data (MV) or data (MZ) directory under input root"
                )
            }
            Self::Read { file, reason } => write!(formatter, "read {file} failed: {reason}"),
            Self::Parse { file, reason } => write!(formatter, "parse {file} failed: {reason}"),
            Self::NoEventFiles => write!(
                formatter,
                "data directory has no CommonEvents.json or MapNNN.json event files"
            ),
        }
    }
}

impl std::error::Error for EventDataError {}

/// Whether `name` is an `MapNNN.json` map data file.
fn is_map_file(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".json") else {
        return false;
    };
    let Some(digits) = stem.strip_prefix("Map") else {
        return false;
    };
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// Deterministic load order: `CommonEvents.json` first, then every
/// `MapNNN.json` in ascending filename order. MV/MZ zero-pads the map id
/// (`Map001.json`), so lexicographic order matches numeric order.
fn ordered_event_files(dir: &Path) -> Result<Vec<String>, EventDataError> {
    let entries = std::fs::read_dir(dir).map_err(|error| EventDataError::Read {
        file: "data/".to_string(),
        reason: error.to_string(),
    })?;
    let mut common = Vec::new();
    let mut maps = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| EventDataError::Read {
            file: "data/".to_string(),
            reason: error.to_string(),
        })?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "CommonEvents.json" {
            common.push(name);
        } else if is_map_file(&name) {
            maps.push(name);
        }
    }
    maps.sort();
    common.extend(maps);
    if common.is_empty() {
        return Err(EventDataError::NoEventFiles);
    }
    Ok(common)
}

/// Load and walk a project's event data into an ordered playback program.
pub fn load_program(data_dir: &DataDir) -> Result<PlaybackProgram, EventDataError> {
    let files = ordered_event_files(&data_dir.root)?;
    let mut program = PlaybackProgram::default();
    for file in files {
        let path = data_dir.root.join(&file);
        let raw = std::fs::read_to_string(&path).map_err(|error| EventDataError::Read {
            file: file.clone(),
            reason: error.to_string(),
        })?;
        let value: Value = serde_json::from_str(&raw).map_err(|error| EventDataError::Parse {
            file: file.clone(),
            reason: error.to_string(),
        })?;
        let before = program.lines.len();
        if file == "CommonEvents.json" {
            walk_common_events(&file, &value, &mut program.lines);
        } else {
            walk_map(&file, &value, &mut program.lines);
        }
        // A file "loaded" if it parsed; we count every recognised event
        // file even when it carried no text, so the inventory is honest.
        let _ = before;
        program.files_loaded += 1;
    }
    Ok(program)
}

/// Walk `CommonEvents.json` — a top-level array whose index 0 is `null`
/// and whose later entries carry a `list[]`.
fn walk_common_events(file: &str, value: &Value, out: &mut Vec<MessageLine>) {
    let Some(events) = value.as_array() else {
        return;
    };
    for (index, event) in events.iter().enumerate() {
        let Some(list) = event.get("list").and_then(Value::as_array) else {
            continue;
        };
        walk_command_list(file, &[index.to_string(), "list".to_string()], list, out);
    }
}

/// Walk `MapNNN.json` — an object with an `events[]` array (index 0 is
/// `null`); each event has `pages[]`; each page has a `list[]`.
fn walk_map(file: &str, value: &Value, out: &mut Vec<MessageLine>) {
    let Some(events) = value.get("events").and_then(Value::as_array) else {
        return;
    };
    for (event_index, event) in events.iter().enumerate() {
        let Some(pages) = event.get("pages").and_then(Value::as_array) else {
            continue;
        };
        for (page_index, page) in pages.iter().enumerate() {
            let Some(list) = page.get("list").and_then(Value::as_array) else {
                continue;
            };
            let prefix = [
                "events".to_string(),
                event_index.to_string(),
                "pages".to_string(),
                page_index.to_string(),
                "list".to_string(),
            ];
            walk_command_list(file, &prefix, list, out);
        }
    }
}

/// Walk one event-command `list[]` in dispatch order, threading the
/// `Show Text` setup speaker and message-window grouping.
fn walk_command_list(file: &str, prefix: &[String], list: &[Value], out: &mut Vec<MessageLine>) {
    let mut message_group: usize = 0;
    let mut current_speaker: Option<String> = None;
    for (command_index, command) in list.iter().enumerate() {
        let code = command.get("code").and_then(Value::as_i64).unwrap_or(-1);
        let params = command.get("parameters").and_then(Value::as_array);
        match code {
            // `Show Text` setup: opens a new message window. MZ carries the
            // speaker name in parameters[4]; MV has no native speaker param.
            101 => {
                message_group += 1;
                current_speaker = params
                    .and_then(|p| p.get(4))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string);
            }
            // `Show Scrolling Text` setup: open a new window, no speaker.
            105 => {
                message_group += 1;
                current_speaker = None;
            }
            // `Show Text` body line.
            401 => {
                if let Some(text) = params.and_then(|p| p.first()).and_then(Value::as_str) {
                    out.push(MessageLine {
                        file: file.to_string(),
                        pointer: command_pointer(prefix, command_index, 0),
                        role: TextRole::Dialogue,
                        text: text.to_string(),
                        speaker: current_speaker.clone(),
                        message_group,
                    });
                }
            }
            // `Show Scrolling Text` body line.
            405 => {
                if let Some(text) = params.and_then(|p| p.first()).and_then(Value::as_str) {
                    out.push(MessageLine {
                        file: file.to_string(),
                        pointer: command_pointer(prefix, command_index, 0),
                        role: TextRole::Scrolling,
                        text: text.to_string(),
                        speaker: None,
                        message_group,
                    });
                }
            }
            // `Show Choices`: parameters[0] is an array of option strings.
            102 => {
                message_group += 1;
                if let Some(options) = params.and_then(|p| p.first()).and_then(Value::as_array) {
                    for (option_index, option) in options.iter().enumerate() {
                        let Some(text) = option.as_str() else {
                            continue;
                        };
                        let mut pointer = command_pointer(prefix, command_index, 0);
                        pointer.push(option_index.to_string());
                        out.push(MessageLine {
                            file: file.to_string(),
                            pointer,
                            role: TextRole::Choice,
                            text: text.to_string(),
                            speaker: None,
                            message_group,
                        });
                    }
                }
            }
            // Every other code is recognised-or-not but carries no text the
            // static walk can safely surface; skip it. (Script/plugin codes
            // can render text via project plugins — that surface is a
            // deferred follow-up, not silently dropped evidence.)
            _ => {}
        }
    }
}

/// Build the JSON-pointer token vector for `prefix/<command_index>/parameters/<param_index>`.
fn command_pointer(prefix: &[String], command_index: usize, param_index: usize) -> Vec<String> {
    let mut pointer = prefix.to_vec();
    pointer.push(command_index.to_string());
    pointer.push("parameters".to_string());
    pointer.push(param_index.to_string());
    pointer
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_map_files() {
        assert!(is_map_file("Map001.json"));
        assert!(is_map_file("Map12.json"));
        assert!(!is_map_file("CommonEvents.json"));
        assert!(!is_map_file("MapInfos.json"));
        assert!(!is_map_file("Map.json"));
    }

    #[test]
    fn walks_show_text_window_with_mz_speaker() {
        let value = json!({
            "events": [
                null,
                { "pages": [ { "list": [
                    { "code": 101, "indent": 0, "parameters": ["face", 0, 0, 2, "Alice"] },
                    { "code": 401, "indent": 0, "parameters": ["Hello there."] },
                    { "code": 401, "indent": 0, "parameters": ["How are you?"] },
                    { "code": 0, "indent": 0, "parameters": [] }
                ] } ] }
            ]
        });
        let mut out = Vec::new();
        walk_map("Map001.json", &value, &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].text, "Hello there.");
        assert_eq!(out[0].speaker.as_deref(), Some("Alice"));
        assert_eq!(out[0].role, TextRole::Dialogue);
        assert_eq!(out[1].text, "How are you?");
        assert_eq!(out[0].message_group, out[1].message_group);
        assert_eq!(
            out[0].source_unit_key(),
            "rpgmaker-mv:Map001.json#/events/1/pages/0/list/1/parameters/0"
        );
    }

    #[test]
    fn walks_choices_and_scrolling() {
        let value = json!([
            null,
            { "list": [
                { "code": 102, "indent": 0, "parameters": [["Yes", "No"], 1] },
                { "code": 105, "indent": 0, "parameters": [2, false] },
                { "code": 405, "indent": 0, "parameters": ["Scrolling line."] }
            ] }
        ]);
        let mut out = Vec::new();
        walk_common_events("CommonEvents.json", &value, &mut out);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].role, TextRole::Choice);
        assert_eq!(out[0].text, "Yes");
        assert_eq!(out[1].text, "No");
        assert_eq!(out[2].role, TextRole::Scrolling);
        assert_eq!(out[2].text, "Scrolling line.");
    }
}
