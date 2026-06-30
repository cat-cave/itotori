//! Walks parsed `www/data/*.json` values into engine-agnostic
//! [`ProtoUnit`]s + structured [`Finding`]s. Filesystem I/O and bridge
//! JSON assembly live in [`crate::lib`] / [`crate::bridge`]; this module
//! is a pure function over already-parsed [`serde_json::Value`]s so it is
//! unit-testable on synthetic JSON with no disk access.

use serde_json::Value;

use crate::codes::{CodeClass, TextRole, classify};
use crate::escape::{EscapeSpan, scan_escape_spans};

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
    /// `Script` (355/655) — may render text via project scripts.
    ScriptCommandText,
    /// `Plugin Command` (356/357) — may render text via a plugin.
    PluginCommandText,
    /// `Control Variables` (122) with a script-string operand.
    ControlVariableScriptString,
}

/// Accumulates units + findings while walking one game's data files.
#[derive(Debug, Default)]
pub struct ExtractAcc {
    pub units: Vec<ProtoUnit>,
    pub findings: Vec<Finding>,
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

/// Walk one top-level event-command `list[]` array.
///
/// State carried across the list: the active `Show Text` speaker (MZ 101
/// param 4) and message-group counter, plus a choice-group counter. Each
/// entry's code is classified; text codes extract, structural codes skip
/// silently, and script/plugin/unknown codes record findings — never a
/// silent drop.
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
                        .map(|id| id.to_string())
                        .unwrap_or_else(|| "0".to_string());
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
                    acc.findings.push(Finding {
                        kind: FindingKind::ControlVariableScriptString,
                        file: file.to_string(),
                        pointer: entry_pointer(&["parameters", "4"]),
                        command_code: Some(code),
                        detail:
                            "Control Variables script-string operand may carry display text; manual review"
                                .to_string(),
                    });
                }
            }
            CodeClass::Script => {
                acc.findings.push(Finding {
                    kind: FindingKind::ScriptCommandText,
                    file: file.to_string(),
                    pointer: entry_pointer(&["parameters", "0"]),
                    command_code: Some(code),
                    detail: "Script command may render text via project scripts; manual review"
                        .to_string(),
                });
            }
            CodeClass::Plugin => {
                acc.findings.push(Finding {
                    kind: FindingKind::PluginCommandText,
                    file: file.to_string(),
                    pointer: entry_pointer(&["parameters"]),
                    command_code: Some(code),
                    detail: "Plugin command may render display text (e.g. a draw-text plugin); manual review"
                        .to_string(),
                });
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
        "Items.json" => &[
            DbField {
                field: "name",
                database_kind: "item",
            },
            DbField {
                field: "description",
                database_kind: "item",
            },
        ],
        "Weapons.json" => &[
            DbField {
                field: "name",
                database_kind: "item",
            },
            DbField {
                field: "description",
                database_kind: "item",
            },
        ],
        "Armors.json" => &[
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
            .map(|id| id.to_string())
            .unwrap_or_else(|| index.to_string());
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
        //   101 setup (MZ speaker) | 401 line | 102 choices | 405 scroll |
        //   356 plugin | 122 script-operand | 70 unknown.
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
