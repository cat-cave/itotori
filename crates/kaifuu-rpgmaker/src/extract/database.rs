use super::*;

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
