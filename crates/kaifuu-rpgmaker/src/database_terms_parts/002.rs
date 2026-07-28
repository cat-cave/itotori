/// Walk a troop's `pages.list` battle-event commands, extracting the
/// `Show Text` (401) and `Show Scrolling Text` (405) battle messages. An
/// unrecognised command code is a `MalformedContainer`-free
/// [`DatabaseDiagnosticKind::UnsupportedCommand`] diagnostic (no silent drop).
fn walk_troop_battle_messages(
    acc: &mut DatabaseExtraction,
    source_file: &str,
    entry_id: i64,
    troop_index: usize,
    troop: &serde_json::Map<String, Value>,
) {
    let Some(pages) = troop.get("pages").and_then(Value::as_array) else {
        return;
    };
    for (page_index, page) in pages.iter().enumerate() {
        let Some(list) = page.get("list").and_then(Value::as_array) else {
            continue;
        };
        for (command_index, entry) in list.iter().enumerate() {
            let Some(code) = entry.get("code").and_then(Value::as_i64) else {
                continue;
            };
            let base = || {
                vec![
                    troop_index.to_string(),
                    "pages".to_string(),
                    page_index.to_string(),
                    "list".to_string(),
                    command_index.to_string(),
                ]
            };
            // No-silent-skip: an unrecognised catalogue code is a diagnostic.
            if classify(code) == CodeClass::Unknown {
                acc.diagnostics.push(DatabaseDiagnostic {
                    kind: DatabaseDiagnosticKind::UnsupportedCommand,
                    source_file: source_file.to_string(),
                    pointer: base(),
                    command_code: Some(code),
                    detail:
                        "unrecognised troop battle-event command code; may carry untracked text"
                            .to_string(),
                });
                continue;
            }
            // Only the Show Text (401) / Show Scrolling Text (405) body lines
            // carry a translatable battle message (params[0]).
            if (code == 401 || code == 405)
                && let Some(text) = entry
                    .get("parameters")
                    .and_then(Value::as_array)
                    .and_then(|p| p.first())
                    .and_then(Value::as_str)
            {
                let mut pointer = base();
                pointer.push("parameters".to_string());
                pointer.push("0".to_string());
                push_unit(
                    acc,
                    source_file,
                    UnitContainer::DatabaseEntry {
                        entry_id,
                        entry_index: troop_index,
                    },
                    "battleMessage".to_string(),
                    Some(command_index),
                    DatabaseTermRole::BattleMessage,
                    pointer,
                    text,
                );
            }
        }
    }
}

// Extraction — System.json

/// Extract declared string units from a parsed `System.json` value:
/// `gameTitle`, `currencyUnit`, the type lists, and the `terms` labels.
#[must_use]
pub fn extract_system(source_file: &str, system: &Value) -> DatabaseExtraction {
    let mut acc = DatabaseExtraction::default();
    let Some(object) = system.as_object() else {
        acc.diagnostics.push(DatabaseDiagnostic {
            kind: DatabaseDiagnosticKind::MalformedContainer,
            source_file: source_file.to_string(),
            pointer: Vec::new(),
            command_code: None,
            detail: "System.json top level is not a JSON object".to_string(),
        });
        return acc;
    };

    // Scalar metadata fields.
    for (field, role) in [
        ("gameTitle", DatabaseTermRole::GameTitle),
        ("currencyUnit", DatabaseTermRole::CurrencyUnit),
    ] {
        if let Some(raw) = object.get(field) {
            match raw.as_str() {
                Some(text) => push_unit(
                    &mut acc,
                    source_file,
                    UnitContainer::SystemSection { section: field },
                    field.to_string(),
                    None,
                    role,
                    vec![field.to_string()],
                    text,
                ),
                None => acc.diagnostics.push(DatabaseDiagnostic {
                    kind: DatabaseDiagnosticKind::UnsupportedFieldType,
                    source_file: source_file.to_string(),
                    pointer: vec![field.to_string()],
                    command_code: None,
                    detail: format!("System `{field}` is present but not a JSON string"),
                }),
            }
        }
    }

    // Top-level string-array type lists (each carries a leading empty slot).
    for section in [
        "equipTypes",
        "skillTypes",
        "weaponTypes",
        "armorTypes",
        "elements",
    ] {
        push_string_array(
            &mut acc,
            source_file,
            object.get(section),
            section,
            section,
            &[section],
            DatabaseTermRole::TypeName,
        );
    }

    // terms.{basic,params,commands} string arrays + terms.messages object.
    match object.get("terms") {
        Some(Value::Object(terms)) => {
            for section in ["basic", "params", "commands"] {
                push_string_array(
                    &mut acc,
                    source_file,
                    terms.get(section),
                    "terms",
                    section,
                    &["terms", section],
                    DatabaseTermRole::Term,
                );
            }
            match terms.get("messages") {
                Some(Value::Object(messages)) => {
                    // serde_json (no preserve_order) sorts object keys, so
                    // iteration order is already deterministic.
                    for (msg_key, item) in messages {
                        match item.as_str() {
                            Some(text) if !text.is_empty() => push_unit(
                                &mut acc,
                                source_file,
                                UnitContainer::SystemSection { section: "terms" },
                                msg_key.clone(),
                                None,
                                DatabaseTermRole::Term,
                                vec!["terms".to_string(), "messages".to_string(), msg_key.clone()],
                                text,
                            ),
                            Some(_) => {}
                            None => acc.diagnostics.push(DatabaseDiagnostic {
                                kind: DatabaseDiagnosticKind::UnsupportedFieldType,
                                source_file: source_file.to_string(),
                                pointer: vec![
                                    "terms".to_string(),
                                    "messages".to_string(),
                                    msg_key.clone(),
                                ],
                                command_code: None,
                                detail: "terms.messages entry is present but not a JSON string"
                                    .to_string(),
                            }),
                        }
                    }
                }
                Some(_) => acc.diagnostics.push(DatabaseDiagnostic {
                    kind: DatabaseDiagnosticKind::MalformedContainer,
                    source_file: source_file.to_string(),
                    pointer: vec!["terms".to_string(), "messages".to_string()],
                    command_code: None,
                    detail: "terms.messages is not a JSON object".to_string(),
                }),
                None => {}
            }
        }
        Some(_) => acc.diagnostics.push(DatabaseDiagnostic {
            kind: DatabaseDiagnosticKind::MalformedContainer,
            source_file: source_file.to_string(),
            pointer: vec!["terms".to_string()],
            command_code: None,
            detail: "System `terms` is not a JSON object".to_string(),
        }),
        None => {}
    }

    acc
}

// reason: cohesive per-array-list extractor over distinct positional fields.
#[allow(clippy::too_many_arguments)]
fn push_string_array(
    acc: &mut DatabaseExtraction,
    source_file: &str,
    raw: Option<&Value>,
    section: &'static str,
    field_key: &str,
    pointer_base: &[&str],
    role: DatabaseTermRole,
) {
    let Some(raw) = raw else {
        return;
    };
    let Some(array) = raw.as_array() else {
        acc.diagnostics.push(DatabaseDiagnostic {
            kind: DatabaseDiagnosticKind::MalformedContainer,
            source_file: source_file.to_string(),
            pointer: pointer_base.iter().map(|s| (*s).to_string()).collect(),
            command_code: None,
            detail: format!("System `{field_key}` is not a JSON array"),
        });
        return;
    };
    for (index, item) in array.iter().enumerate() {
        // Type lists / terms arrays carry empty-string padding slots that are
        // not translatable surfaces; a non-string entry is a diagnostic.
        match item {
            Value::String(text) if !text.is_empty() => {
                let mut pointer: Vec<String> =
                    pointer_base.iter().map(|s| (*s).to_string()).collect();
                pointer.push(index.to_string());
                push_unit(
                    acc,
                    source_file,
                    UnitContainer::SystemSection { section },
                    field_key.to_string(),
                    Some(index),
                    role,
                    pointer,
                    text,
                );
            }
            Value::String(_) | Value::Null => {}
            _ => {
                let mut pointer: Vec<String> =
                    pointer_base.iter().map(|s| (*s).to_string()).collect();
                pointer.push(index.to_string());
                acc.diagnostics.push(DatabaseDiagnostic {
                    kind: DatabaseDiagnosticKind::UnsupportedFieldType,
                    source_file: source_file.to_string(),
                    pointer,
                    command_code: None,
                    detail: format!("System `{field_key}` entry is not a JSON string"),
                });
            }
        }
    }
}

// File-level extraction

/// Read + parse a database file and extract its units. `MissingFile` /
/// `MalformedJson` are typed semantic errors surfaced before any write.
pub fn extract_database_file(path: &Path) -> Result<DatabaseExtraction, DatabaseExtractError> {
    let (file, value) = read_json(path)?;
    Ok(extract_database(&file, &value))
}

/// Read + parse `System.json` and extract its units.
pub fn extract_system_file(path: &Path) -> Result<DatabaseExtraction, DatabaseExtractError> {
    let (file, value) = read_json(path)?;
    Ok(extract_system(&file, &value))
}

fn read_json(path: &Path) -> Result<(String, Value), DatabaseExtractError> {
    let file = path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Err(DatabaseExtractError::MissingFile { file });
        }
        Err(source) => return Err(DatabaseExtractError::Io { file, source }),
    };
    let value =
        serde_json::from_slice(crate::json_locate::strip_utf8_bom(&bytes)).map_err(|source| {
            DatabaseExtractError::MalformedJson {
                file: file.clone(),
                source,
            }
        })?;
    Ok((file, value))
}

// Byte-preserving patch

/// One reviewed translation: the stable unit + its target text.
#[derive(Debug, Clone)]
pub struct DatabaseTranslation<'a> {
    pub unit: &'a StableDatabaseUnit,
    pub target_text: String,
}

/// Patch one file's raw JSON bytes with the reviewed translations for its
/// declared database/term units, preserving every other byte.
/// Reuses the crate's proven byte-surgical splice + stale-source gate
/// ([`crate::patchback::patch_file_bytes`]): the located literal for each
/// unit must hash to the unit's `source_text` (else
/// [`PatchbackError::StaleSource`]), a no-op edit (`target == source`) leaves
/// the bytes untouched, and only the located string literals ever change.
/// Every `translation.unit.source_file` must equal `source_file`.
pub fn patch_file(
    source_file: &str,
    original: &[u8],
    translations: &[DatabaseTranslation<'_>],
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


