//! Walks parsed `www/data/*.json` values into engine-agnostic
//! [`ProtoUnit`]s + structured [`Finding`]s. Filesystem I/O and bridge
//! JSON assembly live in [`crate::lib`] / [`crate::bridge`]; this module
//! is a pure function over already-parsed [`serde_json::Value`]s so it is
//! unit-testable on synthetic JSON with no disk access.

use serde_json::Value;

use crate::codes::{CodeClass, TextRole, classify};
use crate::escape::{EscapeSpan, scan_escape_spans};
use crate::recognize::{
    OpaqueCommandSpec, PluginCommandRecognition, ScriptCommandRecognition, classify_plugin_command,
    classify_script_command,
};

/// The localization-bridge surface kind a unit maps to, plus the data the
/// bridge layer needs to build that surface's required context object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SurfaceKind {
    /// `Show Text` line. `message_group` ties consecutive 401 lines that
    /// share one `Show Text` window together for downstream regrouping.
    Dialogue { message_group: usize },
    /// `Show Scrolling Text` line.
    Narration,
    /// One `Show Choices` option.
    ChoiceLabel { group: usize, option: usize },
    /// A `Show Text` (MZ) / runtime speaker-name string.
    SpeakerName,
    /// On-screen display text recognized inside a message-bearing plugin
    /// command (e.g. a `D_TEXT` text picture). `plugin_command` records the
    /// recognized command keyword for provenance. The unit text is the full
    /// `parameters[0]` literal; the command's structural tokens are carried
    /// as preserve-exact control-markup spans.
    PluginText { plugin_command: &'static str },
    /// A database name/description/message field.
    Database {
        database_kind: &'static str,
        entry_id: String,
        field_key: String,
    },
    /// A `System.json` term / type / command label.
    UiLabel { ui_area: &'static str },
    /// Package-level metadata text (game title, …).
    MetadataText {
        scope: &'static str,
        field_key: String,
        visibility: &'static str,
    },
}

/// One translatable unit, keyed by a stable file + JSON-pointer surface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtoUnit {
    /// Source file name (e.g. `Map001.json`).
    pub file: String,
    /// RFC6901-style JSON-pointer tokens locating the string in `file`.
    pub pointer: Vec<String>,
    pub surface_kind: SurfaceKind,
    /// Decoded source text (the raw JSON string value).
    pub text: String,
    /// Inline `\`-control-code protected spans within `text`.
    pub spans: Vec<EscapeSpan>,
    /// Raw speaker label attached to a dialogue line, when known.
    pub speaker: Option<String>,
}

impl ProtoUnit {
    /// RFC6901 pointer string (`/events/5/.../parameters/0`).
    pub fn pointer_string(&self) -> String {
        let mut out = String::new();
        for token in &self.pointer {
            out.push('/');
            out.push_str(&token.replace('~', "~0").replace('/', "~1"));
        }
        out
    }

    /// Stable surface id: `rpgmaker:<file>#<pointer>`.
    pub fn source_unit_key(&self) -> String {
        format!("rpgmaker:{}#{}", self.file, self.pointer_string())
    }
}

/// A no-silent-skip structured finding: a surface the adapter recognised
/// but could not safely auto-extract (or did not recognise at all).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub kind: FindingKind,
    pub file: String,
    pub pointer: Vec<String>,
    /// The event-command code that triggered the finding, when applicable.
    pub command_code: Option<i64>,
    /// Human-readable reason. Never contains retail string content — only
    /// structural description — so findings can be serialized into reports
    /// without leaking copyrighted text.
    pub detail: String,
}

impl Finding {
    /// RFC6901 pointer string for the finding surface.
    pub fn pointer_string(&self) -> String {
        let mut out = String::new();
        for token in &self.pointer {
            out.push('/');
            out.push_str(&token.replace('~', "~0").replace('/', "~1"));
        }
        out
    }
}

/// Category of a [`Finding`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FindingKind {
    /// Event-command code not in the known table.
    UnknownCommandCode,
    /// `Script` (355/655) outside the typed text/opaque command tables.
    ScriptCommandText,
    /// `Plugin Command` (356/357) outside the typed text/opaque command tables.
    PluginCommandText,
    /// `Control Variables` (122) with an untyped script-string operand.
    ControlVariableScriptString,
}

/// Which MV/MZ command surface produced an intentionally opaque occurrence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpaqueCommandFamily {
    /// MV `Plugin Command` (356) or MZ `Plugin Command` (357).
    Plugin,
    /// `Script` (355/655).
    Script,
    /// `Control Variables` (122) with its script-string operand.
    ControlVariableScript,
}

/// One occurrence classified by the closed opaque-command tables. This is
/// retained beside the bridge bundle for real-byte reporting; it is not a
/// translatable unit and carries no command arguments or player text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpaqueCommandOccurrence {
    pub family: OpaqueCommandFamily,
    pub command: &'static str,
    pub reason: &'static str,
    pub file: String,
    pub pointer: Vec<String>,
    pub command_code: i64,
}

/// Accumulates units + findings while walking one game's data files.
#[derive(Debug, Default)]
pub struct ExtractAcc {
    pub units: Vec<ProtoUnit>,
    pub findings: Vec<Finding>,
    pub opaque_commands: Vec<OpaqueCommandOccurrence>,
}

impl ExtractAcc {
    fn push_text_unit(
        &mut self,
        file: &str,
        pointer: Vec<String>,
        surface_kind: SurfaceKind,
        text: &str,
        speaker: Option<String>,
    ) {
        // Empty strings are not translatable surfaces (and would fail the
        // v0.2 non-empty `sourceText` contract). Skipping an empty string
        // is not a silent drop of translatable text.
        if text.is_empty() {
            return;
        }
        let spans = scan_escape_spans(text);
        self.units.push(ProtoUnit {
            file: file.to_string(),
            pointer,
            surface_kind,
            text: text.to_string(),
            spans,
            speaker,
        });
    }

    /// Push a unit recognized inside a plugin/script command. `full_text` is
    /// the whole `parameters[0]` literal (so the pointer + sourceHash stay
    /// patchback-targetable); `control_spans` protect the command's
    /// structural tokens. The inline `\`-control codes inside the display
    /// text are scanned and merged, then all spans are sorted ascending by
    /// start byte (the v0.2 non-overlapping-span contract). The recognizer's
    /// structural spans bound the keyword prefix and trailing args, so they
    /// never overlap the escape spans found within the display region.
    fn push_recognized_unit(
        &mut self,
        file: &str,
        pointer: Vec<String>,
        surface_kind: SurfaceKind,
        full_text: &str,
        control_spans: Vec<EscapeSpan>,
    ) {
        if full_text.is_empty() {
            return;
        }
        let mut spans = control_spans;
        spans.extend(scan_escape_spans(full_text));
        spans.sort_by_key(|span| span.start_byte);
        self.units.push(ProtoUnit {
            file: file.to_string(),
            pointer,
            surface_kind,
            text: full_text.to_string(),
            spans,
            speaker: None,
        });
    }

    fn push_opaque_command(
        &mut self,
        file: &str,
        pointer: Vec<String>,
        command_code: i64,
        family: OpaqueCommandFamily,
        spec: &'static OpaqueCommandSpec,
    ) {
        self.opaque_commands.push(OpaqueCommandOccurrence {
            family,
            command: spec.name,
            reason: spec.reason,
            file: file.to_string(),
            pointer,
            command_code,
        });
    }
}

/// Walk a parsed `Map*.json` value.
pub fn walk_map(acc: &mut ExtractAcc, file: &str, map: &Value) {
    if let Some(display) = map.get("displayName").and_then(Value::as_str)
        && !display.is_empty()
    {
        acc.push_text_unit(
            file,
            vec!["displayName".to_string()],
            SurfaceKind::UiLabel { ui_area: "hud" },
            display,
            None,
        );
    }
    let Some(events) = map.get("events").and_then(Value::as_array) else {
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
            let base = vec![
                "events".to_string(),
                event_index.to_string(),
                "pages".to_string(),
                page_index.to_string(),
                "list".to_string(),
            ];
            walk_command_list(acc, file, base, list);
        }
    }
}

/// Walk a parsed `CommonEvents.json` value.
pub fn walk_common_events(acc: &mut ExtractAcc, file: &str, common_events: &Value) {
    let Some(array) = common_events.as_array() else {
        return;
    };
    for (index, entry) in array.iter().enumerate() {
        let Some(list) = entry.get("list").and_then(Value::as_array) else {
            continue;
        };
        let base = vec![index.to_string(), "list".to_string()];
        walk_command_list(acc, file, base, list);
    }
}

/// Walk a parsed `Troops.json` value.
pub fn walk_troops(acc: &mut ExtractAcc, file: &str, troops: &Value) {
    let Some(array) = troops.as_array() else {
        return;
    };
    for (troop_index, troop) in array.iter().enumerate() {
        let Some(pages) = troop.get("pages").and_then(Value::as_array) else {
            continue;
        };
        for (page_index, page) in pages.iter().enumerate() {
            let Some(list) = page.get("list").and_then(Value::as_array) else {
                continue;
            };
            let base = vec![
                troop_index.to_string(),
                "pages".to_string(),
                page_index.to_string(),
                "list".to_string(),
            ];
            walk_command_list(acc, file, base, list);
        }
    }
}

/// Walk one top-level event-command `list` array.
/// State carried across the list: the active `Show Text` speaker (MZ 101
/// param 4) and message-group counter, plus a choice-group counter. Each
/// entry's code is classified; text codes extract, structural codes skip
/// silently, typed opaque commands enter the opaque census, and only unknown
/// command shapes record findings.
fn walk_command_list(acc: &mut ExtractAcc, file: &str, base: Vec<String>, list: &[Value]) {
    let mut current_speaker: Option<String> = None;
    let mut message_group: usize = 0;
    let mut choice_group: usize = 0;

    for (index, entry) in list.iter().enumerate() {
        let Some(code) = entry.get("code").and_then(Value::as_i64) else {
            continue;
        };
        let params = entry.get("parameters").and_then(Value::as_array);
        let entry_pointer = |extra: &[&str]| {
            let mut p = base.clone();
            p.push(index.to_string());
            for token in extra {
                p.push((*token).to_string());
            }
            p
        };

        match classify(code) {
            CodeClass::ShowTextSetup => {
                // 101: face/position context. A new Show Text window starts
                // a new message group. MZ adds a 5th parameter carrying the
                // speaker name; MV has only four (no speaker).
                message_group += 1;
                current_speaker = params
                    .and_then(|p| p.get(4))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                if let Some(speaker) = &current_speaker {
                    acc.push_text_unit(
                        file,
                        entry_pointer(&["parameters", "4"]),
                        SurfaceKind::SpeakerName,
                        speaker,
                        None,
                    );
                }
            }
            CodeClass::Text(TextRole::DialogueLine) => {
                if let Some(text) = params.and_then(|p| p.first()).and_then(Value::as_str) {
                    acc.push_text_unit(
                        file,
                        entry_pointer(&["parameters", "0"]),
                        SurfaceKind::Dialogue { message_group },
                        text,
                        current_speaker.clone(),
                    );
                }
            }
            CodeClass::Text(TextRole::ScrollingLine) => {
                if let Some(text) = params.and_then(|p| p.first()).and_then(Value::as_str) {
                    acc.push_text_unit(
                        file,
                        entry_pointer(&["parameters", "0"]),
                        SurfaceKind::Narration,
                        text,
                        None,
                    );
                }
            }
            CodeClass::Text(TextRole::ChoiceList) => {
                // params[0] is the array of choice option strings. Each
                // non-empty option becomes one choice_label unit keyed by
                // its array index.
                if let Some(options) = params.and_then(|p| p.first()).and_then(Value::as_array) {
                    for (option_index, option) in options.iter().enumerate() {
                        if let Some(text) = option.as_str() {
                            acc.push_text_unit(
                                file,
                                entry_pointer(&["parameters", "0", &option_index.to_string()]),
                                SurfaceKind::ChoiceLabel {
                                    group: choice_group,
                                    option: option_index,
                                },
                                text,
                                None,
                            );
                        }
                    }
                }
                choice_group += 1;
            }
            CodeClass::Text(
                role @ (TextRole::ChangeName | TextRole::ChangeNickname | TextRole::ChangeProfile),
            ) => {
                // 320/324/325: a literal name/nickname/profile string in
                // params[1]. Surface it as a character_bio database field so
                // the runtime-set value is translatable.
                if let Some(text) = params.and_then(|p| p.get(1)).and_then(Value::as_str) {
                    let field_key = match role {
                        TextRole::ChangeName => "changeName",
                        TextRole::ChangeNickname => "changeNickname",
                        _ => "changeProfile",
                    };
                    let entry_id = params
                        .and_then(|p| p.first())
                        .and_then(Value::as_i64)
                        .map_or_else(|| "0".to_string(), |id| id.to_string());
                    acc.push_text_unit(
                        file,
                        entry_pointer(&["parameters", "1"]),
                        SurfaceKind::Database {
                            database_kind: "character_bio",
                            entry_id,
                            field_key: field_key.to_string(),
                        },
                        text,
                        None,
                    );
                }
            }
            CodeClass::ControlVariable => {
                // 122: operand at params[3]; value 4 = script string.
                let operand = params.and_then(|p| p.get(3)).and_then(Value::as_i64);
                if operand == Some(4) {
                    let script = params.and_then(|p| p.get(4)).and_then(Value::as_str);
                    match script.map(classify_script_command) {
                        Some(ScriptCommandRecognition::Opaque(spec)) => {
                            acc.push_opaque_command(
                                file,
                                entry_pointer(&["parameters", "4"]),
                                code,
                                OpaqueCommandFamily::ControlVariableScript,
                                spec,
                            );
                        }
                        _ => {
                            acc.findings.push(Finding {
                                kind: FindingKind::ControlVariableScriptString,
                                file: file.to_string(),
                                pointer: entry_pointer(&["parameters", "4"]),
                                command_code: Some(code),
                                detail: "Control Variables script-string operand is outside the typed script-command set; text semantics are unknown"
                                    .to_string(),
                            });
                        }
                    }
                }
            }
            CodeClass::Script => {
                let script = params.and_then(|p| p.first()).and_then(Value::as_str);
                match script.map(classify_script_command) {
                    Some(ScriptCommandRecognition::Opaque(spec)) => {
                        acc.push_opaque_command(
                            file,
                            entry_pointer(&["parameters", "0"]),
                            code,
                            OpaqueCommandFamily::Script,
                            spec,
                        );
                    }
                    _ => {
                        acc.findings.push(Finding {
                            kind: FindingKind::ScriptCommandText,
                            file: file.to_string(),
                            pointer: entry_pointer(&["parameters", "0"]),
                            command_code: Some(code),
                            detail: "Script command is outside the typed script-command set; text semantics are unknown"
                                .to_string(),
                        });
                    }
                }
            }
            CodeClass::Plugin => {
                // Typed recognizer first: a KNOWN message-bearing plugin
                // command (D_TEXT) extracts its display text as a unit keyed
                // by the same `parameters/0` pointer. Known controls are
                // recorded in the exact opaque census; only a command outside
                // that census becomes a finding.
                let param0 = params.and_then(|p| p.first()).and_then(Value::as_str);
                match param0.map(classify_plugin_command) {
                    Some(PluginCommandRecognition::Translatable(rec)) => {
                        let text = param0.expect("classification came from a string parameter");
                        acc.push_recognized_unit(
                            file,
                            entry_pointer(&["parameters", "0"]),
                            SurfaceKind::PluginText {
                                plugin_command: rec.command,
                            },
                            text,
                            rec.control_spans,
                        );
                    }
                    Some(PluginCommandRecognition::Opaque(spec)) => {
                        acc.push_opaque_command(
                            file,
                            entry_pointer(&["parameters", "0"]),
                            code,
                            OpaqueCommandFamily::Plugin,
                            spec,
                        );
                    }
                    Some(PluginCommandRecognition::Unknown) | None => {
                        acc.findings.push(Finding {
                            kind: FindingKind::PluginCommandText,
                            file: file.to_string(),
                            pointer: entry_pointer(&["parameters"]),
                            command_code: Some(code),
                            detail: "Plugin command is outside the typed message-bearing and opaque command sets; text semantics are unknown"
                                .to_string(),
                        });
                    }
                }
            }
            CodeClass::Structural => {}
            CodeClass::Unknown => {
                acc.findings.push(Finding {
                    kind: FindingKind::UnknownCommandCode,
                    file: file.to_string(),
                    pointer: entry_pointer(&[]),
                    command_code: Some(code),
                    detail:
                        "Unrecognised event-command code; may carry untracked translatable text"
                            .to_string(),
                });
            }
        }
    }
}

/// A database file's extractable field configuration.
struct DbField {
    field: &'static str,
    database_kind: &'static str,
}

fn db_fields_for(file: &str) -> &'static [DbField] {
    match file {
        "Actors.json" => &[
            DbField {
                field: "name",
                database_kind: "character_bio",
            },
            DbField {
                field: "nickname",
                database_kind: "character_bio",
            },
            DbField {
                field: "profile",
                database_kind: "character_bio",
            },
        ],
        "Classes.json" => &[DbField {
            field: "name",
            database_kind: "character_bio",
        }],
        "Items.json" | "Weapons.json" | "Armors.json" => &[
            DbField {
                field: "name",
                database_kind: "item",
            },
            DbField {
                field: "description",
                database_kind: "item",
            },
        ],
        "Skills.json" => &[
            DbField {
                field: "name",
                database_kind: "skill",
            },
            DbField {
                field: "description",
                database_kind: "skill",
            },
            DbField {
                field: "message1",
                database_kind: "skill",
            },
            DbField {
                field: "message2",
                database_kind: "skill",
            },
        ],
        "Enemies.json" => &[DbField {
            field: "name",
            database_kind: "bestiary",
        }],
        "States.json" => &[
            DbField {
                field: "name",
                database_kind: "codex",
            },
            DbField {
                field: "message1",
                database_kind: "codex",
            },
            DbField {
                field: "message2",
                database_kind: "codex",
            },
            DbField {
                field: "message3",
                database_kind: "codex",
            },
            DbField {
                field: "message4",
                database_kind: "codex",
            },
        ],
        _ => &[],
    }
}

/// True for the database files [`walk_database`] understands.
pub fn is_database_file(file: &str) -> bool {
    !db_fields_for(file).is_empty()
}

/// Walk a parsed database array file (`Actors.json`, `Items.json`, …).
pub fn walk_database(acc: &mut ExtractAcc, file: &str, value: &Value) {
    let Some(array) = value.as_array() else {
        return;
    };
    let fields = db_fields_for(file);
    for (index, entry) in array.iter().enumerate() {
        // RPG Maker database arrays carry a leading `null` placeholder at
        // index 0; non-object entries are skipped.
        let Some(object) = entry.as_object() else {
            continue;
        };
        let entry_id = object
            .get("id")
            .and_then(Value::as_i64)
            .map_or_else(|| index.to_string(), |id| id.to_string());
        for field in fields {
            if let Some(text) = object.get(field.field).and_then(Value::as_str) {
                acc.push_text_unit(
                    file,
                    vec![index.to_string(), field.field.to_string()],
                    SurfaceKind::Database {
                        database_kind: field.database_kind,
                        entry_id: entry_id.clone(),
                        field_key: field.field.to_string(),
                    },
                    text,
                    None,
                );
            }
        }
    }
}

/// Walk a parsed `System.json` value: title, currency, terms, type lists.
pub fn walk_system(acc: &mut ExtractAcc, file: &str, system: &Value) {
    if let Some(title) = system.get("gameTitle").and_then(Value::as_str) {
        acc.push_text_unit(
            file,
            vec!["gameTitle".to_string()],
            SurfaceKind::MetadataText {
                scope: "package",
                field_key: "gameTitle".to_string(),
                visibility: "package",
            },
            title,
            None,
        );
    }
    if let Some(currency) = system.get("currencyUnit").and_then(Value::as_str) {
        acc.push_text_unit(
            file,
            vec!["currencyUnit".to_string()],
            SurfaceKind::UiLabel { ui_area: "menu" },
            currency,
            None,
        );
    }

    // Top-level string-array type lists (each carries a leading empty slot).
    for (key, ui_area) in [
        ("equipTypes", "menu"),
        ("skillTypes", "menu"),
        ("weaponTypes", "menu"),
        ("armorTypes", "menu"),
        ("elements", "battle"),
    ] {
        if let Some(array) = system.get(key).and_then(Value::as_array) {
            for (index, item) in array.iter().enumerate() {
                if let Some(text) = item.as_str()
                    && !text.is_empty()
                {
                    acc.push_text_unit(
                        file,
                        vec![key.to_string(), index.to_string()],
                        SurfaceKind::UiLabel { ui_area },
                        text,
                        None,
                    );
                }
            }
        }
    }

    let Some(terms) = system.get("terms") else {
        return;
    };
    for (key, ui_area) in [
        ("basic", "status"),
        ("params", "status"),
        ("commands", "menu"),
    ] {
        if let Some(array) = terms.get(key).and_then(Value::as_array) {
            for (index, item) in array.iter().enumerate() {
                if let Some(text) = item.as_str()
                    && !text.is_empty()
                {
                    acc.push_text_unit(
                        file,
                        vec!["terms".to_string(), key.to_string(), index.to_string()],
                        SurfaceKind::UiLabel { ui_area },
                        text,
                        None,
                    );
                }
            }
        }
    }
    if let Some(messages) = terms.get("messages").and_then(Value::as_object) {
        for (msg_key, item) in messages {
            if let Some(text) = item.as_str()
                && !text.is_empty()
            {
                acc.push_text_unit(
                    file,
                    vec!["terms".to_string(), "messages".to_string(), msg_key.clone()],
                    SurfaceKind::UiLabel { ui_area: "battle" },
                    text,
                    None,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dialogue_choice_scroll_and_unknown_code_are_handled() {
        // Synthetic event list (authored here, not retail bytes):
        // 101 setup (MZ speaker) | 401 line | 102 choices | 405 scroll |
        // 356 plugin | 122 script-operand | 70 unknown.
        let list = json!([
            {"code": 101, "indent": 0, "parameters": ["Face", 0, 0, 2, "Hero"]},
            {"code": 401, "indent": 0, "parameters": ["Hello \\v[1]!"]},
            {"code": 102, "indent": 0, "parameters": [["Yes", "No"], 1, 0, 2, 0]},
            {"code": 105, "indent": 0, "parameters": [2, false]},
            {"code": 405, "indent": 0, "parameters": ["Scrolling line"]},
            {"code": 356, "indent": 0, "parameters": ["SomePlugin arg"]},
            {"code": 122, "indent": 0, "parameters": [1, 1, 0, 4, "code()"]},
            {"code": 70, "indent": 0, "parameters": []}
        ]);
        let mut acc = ExtractAcc::default();
        walk_command_list(
            &mut acc,
            "Map001.json",
            vec!["list".to_string()],
            list.as_array().unwrap(),
        );

        // Units: speaker_name, dialogue, two choices, narration = 5.
        let kinds: Vec<&SurfaceKind> = acc.units.iter().map(|u| &u.surface_kind).collect();
        assert_eq!(acc.units.len(), 5, "got {kinds:?}");
        assert!(matches!(
            acc.units[0].surface_kind,
            SurfaceKind::SpeakerName
        ));
        assert!(matches!(
            acc.units[1].surface_kind,
            SurfaceKind::Dialogue { .. }
        ));
        assert_eq!(acc.units[1].speaker.as_deref(), Some("Hero"));
        // The dialogue line carries a \v[1] protected span.
        assert_eq!(acc.units[1].spans.len(), 1);
        assert_eq!(acc.units[1].spans[0].parsed_name, "rpgmaker.escape.V");
        assert!(matches!(
            acc.units[2].surface_kind,
            SurfaceKind::ChoiceLabel { option: 0, .. }
        ));
        assert!(matches!(
            acc.units[3].surface_kind,
            SurfaceKind::ChoiceLabel { option: 1, .. }
        ));
        assert!(matches!(acc.units[4].surface_kind, SurfaceKind::Narration));

        // Findings: plugin (356), control-variable script (122), unknown (70).
        assert_eq!(acc.findings.len(), 3);
        assert!(
            acc.findings
                .iter()
                .any(|f| f.kind == FindingKind::PluginCommandText)
        );
        assert!(
            acc.findings
                .iter()
                .any(|f| f.kind == FindingKind::ControlVariableScriptString)
        );
        let unknown = acc
            .findings
            .iter()
            .find(|f| f.kind == FindingKind::UnknownCommandCode)
            .expect("unknown-code finding");
        assert_eq!(unknown.command_code, Some(70));
    }

    #[test]
    fn recognized_d_text_plugin_extracts_unit_and_typed_controls_leave_no_finding() {
        // Synthetic event list: a recognized D_TEXT (display text + size),
        // a D_TEXT_SETTING control command, and a screen-shake control
        // command. Only the D_TEXT becomes a translatable unit.
        let list = json!([
            {"code": 356, "indent": 0, "parameters": ["D_TEXT Hello 32"]},
            {"code": 356, "indent": 0, "parameters": ["D_TEXT_SETTING ALIGN CENTER"]},
            {"code": 356, "indent": 0, "parameters": ["P_SHAKE 1 2 3"]}
        ]);
        let mut acc = ExtractAcc::default();
        walk_command_list(
            &mut acc,
            "Map001.json",
            vec!["list".to_string()],
            list.as_array().unwrap(),
        );

        // One recognized plugin-text unit; two control commands enter the
        // exact opaque census rather than a generic finding.
        assert_eq!(acc.units.len(), 1, "only D_TEXT extracts a unit");
        let unit = &acc.units[0];
        assert!(matches!(
            unit.surface_kind,
            SurfaceKind::PluginText {
                plugin_command: "D_TEXT"
            }
        ));
        // The unit text is the FULL parameters[0] literal (patchback-safe);
        // it is keyed by the parameters/0 pointer.
        assert_eq!(unit.text, "D_TEXT Hello 32");
        assert_eq!(
            unit.source_unit_key(),
            "rpgmaker:Map001.json#/list/0/parameters/0"
        );
        // The keyword prefix and trailing size are protected control spans,
        // so only "Hello" is translatable. Every span's byte range must
        // reproduce its raw substring.
        let names: Vec<&str> = unit.spans.iter().map(|s| s.parsed_name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "rpgmaker.plugin.D_TEXT.command",
                "rpgmaker.plugin.D_TEXT.font_size",
            ]
        );
        for span in &unit.spans {
            assert_eq!(&unit.text[span.start_byte..span.end_byte], span.raw);
        }

        // Two control plugin commands are typed opaque, never dropped and
        // never mis-extracted as units.
        assert_eq!(acc.opaque_commands.len(), 2);
        assert!(acc.findings.is_empty());
        assert_eq!(acc.opaque_commands[0].command, "D_TEXT_SETTING");
        assert_eq!(acc.opaque_commands[1].command, "P_SHAKE");
    }

    #[test]
    fn d_text_with_inline_escape_code_merges_spans_in_order() {
        // Display text carries an inline \v[1] code: the keyword prefix, the
        // escape code, and the trailing size must all be protected, sorted
        // ascending by start byte and non-overlapping.
        let list = json!([
            {"code": 356, "indent": 0, "parameters": ["D_TEXT \\v[1]pts 28"]}
        ]);
        let mut acc = ExtractAcc::default();
        walk_command_list(
            &mut acc,
            "Map001.json",
            vec!["list".to_string()],
            list.as_array().unwrap(),
        );
        assert_eq!(acc.units.len(), 1);
        let spans = &acc.units[0].spans;
        let names: Vec<&str> = spans.iter().map(|s| s.parsed_name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "rpgmaker.plugin.D_TEXT.command",
                "rpgmaker.escape.V",
                "rpgmaker.plugin.D_TEXT.font_size",
            ]
        );
        // Ascending + non-overlapping.
        for pair in spans.windows(2) {
            assert!(pair[0].end_byte <= pair[1].start_byte);
        }
        for span in spans {
            assert_eq!(&acc.units[0].text[span.start_byte..span.end_byte], span.raw);
        }
    }

    #[test]
    fn database_name_and_description_surfaces_are_keyed_by_pointer() {
        let items = json!([
            null,
            {"id": 1, "name": "Potion", "description": "Heals \\c[2]HP\\c[0]."}
        ]);
        let mut acc = ExtractAcc::default();
        walk_database(&mut acc, "Items.json", &items);
        assert_eq!(acc.units.len(), 2);
        assert_eq!(
            acc.units[0].source_unit_key(),
            "rpgmaker:Items.json#/1/name"
        );
        assert_eq!(
            acc.units[1].source_unit_key(),
            "rpgmaker:Items.json#/1/description"
        );
        // Description protected spans: two \c[..] runs.
        assert_eq!(acc.units[1].spans.len(), 2);
    }

    #[test]
    fn empty_strings_are_not_emitted_as_units() {
        let actors = json!([null, {"id": 1, "name": "Hero", "nickname": "", "profile": ""}]);
        let mut acc = ExtractAcc::default();
        walk_database(&mut acc, "Actors.json", &actors);
        assert_eq!(
            acc.units.len(),
            1,
            "empty nickname/profile must not emit units"
        );
        assert_eq!(
            acc.units[0].pointer,
            vec!["1".to_string(), "name".to_string()]
        );
    }
}
