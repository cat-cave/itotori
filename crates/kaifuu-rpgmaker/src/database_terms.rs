//! KAIFUU-110 — MV/MZ database + `System.json` terms extract & trivial patch.
//!
//! The database / System-terms analogue of the KAIFUU-109 map / common-event
//! slice ([`crate::map_common_event`]). It consumes the KAIFUU-108 fixture
//! profile's `Database`, `System`, and `Terms` surfaces
//! (`MvMzFixtureProfile` consumers `KAIFUU-110`/`KAIFUU-111`; surface globs
//! `www/data/{Actors,Classes,Items,Weapons,Armors,Skills,Enemies,States,Troops}.json`
//! and `www/data/System.json`). It emits **stable database/term units** and
//! writes a **byte-preserving** patch back into the same JSON, reusing the
//! crate's proven byte-surgical splice and stale-source gate.
//!
//! # Declared translatable string fields (schema-enumerated, never a blind
//! all-strings sweep)
//!
//! Every field below is a DECLARED player-facing string field of the real
//! MV/MZ database schema; developer `note` fields, numeric ids, icon/price
//! numbers, switch/element ids and every other non-text field are left
//! untouched (see [`db_fields_for`] + the negative-fixture tests). The MV and
//! MZ database/term string-field schema is identical — no MV-vs-MZ divergence
//! in this surface set (the MV/MZ speaker difference lives in the 101 command
//! surface, which is [`crate::map_common_event`], not here).
//!
//! - **`Actors.json`** — `name`, `nickname`, `profile`.
//! - **`Classes.json`** — `name`.
//! - **`Items.json` / `Weapons.json` / `Armors.json`** — `name`,
//!   `description`.
//! - **`Skills.json`** — `name`, `description`, `message1`, `message2`
//!   (the skill-use battle lines).
//! - **`Enemies.json`** — `name`.
//! - **`States.json`** — `name`, `message1`..`message4` (the state
//!   onset/persist/removal/action battle lines).
//! - **`Troops.json`** — `name` (the troop label) plus its **battle-event
//!   messages**: `Show Text` (401) and `Show Scrolling Text` (405) lines in
//!   `pages[].list[]`.
//! - **`System.json`** — `gameTitle`, `currencyUnit`, the
//!   `equipTypes`/`skillTypes`/`weaponTypes`/`armorTypes`/`elements` type
//!   lists, and `terms.{basic,params,commands,messages}`.
//!
//! # Stable unit fields (KAIFUU-110 acceptance)
//!
//! Every [`StableDatabaseUnit`] carries `source_file`, the container
//! (database entry **id** + array **index**, or the System **section**), the
//! **field key**, the **text role**, and the **fixture-profile id**
//! ([`FIXTURE_PROFILE_ID`]). Its stable `rpgmaker:<file>#<json-pointer>`
//! [`StableDatabaseUnit::source_unit_key`] and deterministic
//! [`StableDatabaseUnit::bridge_unit_id`] (UUID7-shaped) make re-extraction
//! and patchback target the same surface — the same scheme the KAIFUU-109
//! slice uses.
//!
//! # Byte-preserving patch
//!
//! [`patch_file`] reuses the crate's byte-surgical splice
//! ([`crate::patchback::patch_file_bytes`]): only the located string literal
//! for each declared unit is replaced; every other byte (structure, key
//! order, whitespace, numbers, `note`/id/switch fields, untouched strings) is
//! preserved verbatim. An untranslated patch (`target == source`) is a
//! byte-identical no-op, and the stale-source hash gate rejects a patch
//! whose on-disk literal drifted since extraction.
//!
//! # Semantic diagnostics before any write
//!
//! Extraction records a structural, no-retail-text [`DatabaseDiagnostic`] for
//! a malformed container (a database file whose top level is not an array, a
//! System type-list / terms field of the wrong shape), a declared field
//! present but of an unsupported (non-string) type, and — inside a troop
//! battle event — an event-command code the shared [`classify`] catalogue
//! does not recognise. The file-level [`extract_database_file`] /
//! [`extract_system_file`] return a typed [`DatabaseExtractError`]
//! (`MissingFile` / `MalformedJson`) — all before any patch byte is written.

use std::path::Path;

use serde_json::Value;
use thiserror::Error;

use kaifuu_core::sha256_hash_bytes;

use crate::codes::{CodeClass, classify};
use crate::ids::deterministic_uuid7;
use crate::patchback::{FileEdit, PatchbackError, patch_file_bytes};

/// The KAIFUU-108 fixture-profile id every KAIFUU-110 unit is stamped with.
pub const FIXTURE_PROFILE_ID: &str = "KAIFUU-110";

// ---------------------------------------------------------------------------
// Roles + containers
// ---------------------------------------------------------------------------

/// The declared KAIFUU-110 database / term text role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseTermRole {
    /// A database entry `name` (Actors/Classes/Items/…/Troops).
    Name,
    /// An actor `nickname`.
    Nickname,
    /// An actor `profile` (multi-line bio).
    Profile,
    /// An item/skill/equipment `description`.
    Description,
    /// A skill `message1`/`message2` or state `message1`..`message4` battle
    /// line.
    Message,
    /// A `Troops[].pages[].list[]` `Show Text`/`Show Scrolling Text` battle
    /// message.
    BattleMessage,
    /// `System.json` `gameTitle`.
    GameTitle,
    /// `System.json` `currencyUnit`.
    CurrencyUnit,
    /// A `System.json` type-list entry
    /// (`equipTypes`/`skillTypes`/`weaponTypes`/`armorTypes`/`elements`).
    TypeName,
    /// A `System.json` `terms.{basic,params,commands,messages}` label.
    Term,
}

impl DatabaseTermRole {
    /// Stable snake-case tag (bridge / report friendly).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Name => "name",
            Self::Nickname => "nickname",
            Self::Profile => "profile",
            Self::Description => "description",
            Self::Message => "message",
            Self::BattleMessage => "battle_message",
            Self::GameTitle => "game_title",
            Self::CurrencyUnit => "currency_unit",
            Self::TypeName => "type_name",
            Self::Term => "term",
        }
    }
}

/// Where a declared string lives — a database entry, or a `System.json`
/// section (which has no per-entry id).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnitContainer {
    /// A `<Database>.json[entry_index]` object. `entry_id` is the entry's own
    /// `id` field (the human-facing id); `entry_index` is its array position
    /// (what the JSON pointer navigates).
    DatabaseEntry { entry_id: i64, entry_index: usize },
    /// A `System.json` section (`gameTitle`, `terms`, a type list, …). The
    /// `section` is the top-level key the surface lives under.
    SystemSection { section: &'static str },
}

// ---------------------------------------------------------------------------
// Stable unit
// ---------------------------------------------------------------------------

/// A stable KAIFUU-110 database / System-term text unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StableDatabaseUnit {
    /// Source file name (e.g. `Actors.json`, `System.json`).
    pub source_file: String,
    /// Which database entry or System section the string belongs to.
    pub container: UnitContainer,
    /// The declared schema field key (`name`, `description`, `message1`,
    /// `gameTitle`, `equipTypes`, `commands`, `possession`, …).
    pub field_key: String,
    /// For an array-element surface (type lists, `terms.basic`, a troop
    /// battle-message command), the element's array index; `None` for a
    /// scalar field.
    pub array_index: Option<usize>,
    /// The declared text role.
    pub text_role: DatabaseTermRole,
    /// The KAIFUU-108 fixture-profile id ([`FIXTURE_PROFILE_ID`]).
    pub fixture_profile_id: &'static str,
    /// RFC6901 pointer tokens locating the string literal in `source_file`.
    pub pointer: Vec<String>,
    /// The decoded source text (the raw JSON string value).
    pub source_text: String,
}

impl StableDatabaseUnit {
    /// The database entry id, or `None` for a `System.json` section.
    #[must_use]
    pub const fn entry_id(&self) -> Option<i64> {
        match self.container {
            UnitContainer::DatabaseEntry { entry_id, .. } => Some(entry_id),
            UnitContainer::SystemSection { .. } => None,
        }
    }

    /// The database entry array index, or `None` for a `System.json` section.
    #[must_use]
    pub const fn entry_index(&self) -> Option<usize> {
        match self.container {
            UnitContainer::DatabaseEntry { entry_index, .. } => Some(entry_index),
            UnitContainer::SystemSection { .. } => None,
        }
    }

    /// RFC6901 pointer string (`/1/name`, `/terms/messages/possession`).
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
    /// the KAIFUU-109 slice, so [`crate::patchback`] resolves both.
    #[must_use]
    pub fn source_unit_key(&self) -> String {
        format!("rpgmaker:{}#{}", self.source_file, self.pointer_string())
    }

    /// Deterministic bridge-unit id derived from the fixture profile +
    /// surface key (UUID7-shaped; identical construction to the crate's
    /// bridge producer and the KAIFUU-109 slice).
    #[must_use]
    pub fn bridge_unit_id(&self) -> String {
        deterministic_uuid7(
            &format!("rpgmaker-k110:{}", self.fixture_profile_id),
            &format!("unit-{}", self.source_unit_key()),
        )
    }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/// Category of a [`DatabaseDiagnostic`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseDiagnosticKind {
    /// A container was not the expected JSON shape (a database file whose top
    /// level is not an array, a System type-list / terms field that is not an
    /// array/object).
    MalformedContainer,
    /// A declared string field was present but not a JSON string (e.g. a
    /// number placed in a `name`); it is NOT extracted.
    UnsupportedFieldType,
    /// A troop battle-event command code the shared [`classify`] catalogue
    /// does not recognise; it may carry untracked translatable text.
    UnsupportedCommand,
}

/// A structural, no-retail-text diagnostic recorded during extraction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseDiagnostic {
    pub kind: DatabaseDiagnosticKind,
    pub source_file: String,
    /// RFC6901 pointer tokens to the offending surface.
    pub pointer: Vec<String>,
    /// The offending event-command code, for [`DatabaseDiagnosticKind::UnsupportedCommand`].
    pub command_code: Option<i64>,
    /// Structural description only — never retail string content.
    pub detail: String,
}

/// Output of the pure per-value extractors.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DatabaseExtraction {
    pub units: Vec<StableDatabaseUnit>,
    pub diagnostics: Vec<DatabaseDiagnostic>,
}

/// Typed, semantic errors raised by the file-level extractors *before any
/// write* — the KAIFUU-110 "malformed JSON / missing file" diagnostics.
#[derive(Debug, Error)]
pub enum DatabaseExtractError {
    #[error("kaifuu.rpgmaker.k110.missing_file: {file} does not exist")]
    MissingFile { file: String },
    #[error("kaifuu.rpgmaker.k110.io: {file}: {source}")]
    Io {
        file: String,
        #[source]
        source: std::io::Error,
    },
    #[error("kaifuu.rpgmaker.k110.malformed_json: {file}: {source}")]
    MalformedJson {
        file: String,
        #[source]
        source: serde_json::Error,
    },
}

// ---------------------------------------------------------------------------
// Declared field catalogue (schema-enumerated)
// ---------------------------------------------------------------------------

/// A declared database string field + its role.
struct DbField {
    field: &'static str,
    role: DatabaseTermRole,
}

/// The declared translatable string fields for a database file, or an empty
/// slice for a file this slice does not own. Enumerated against the MV/MZ
/// database schema — never a blind "all strings" sweep. `Troops.json` `name`
/// is declared here; its battle-message command text is walked separately
/// (see [`walk_troop_battle_messages`]).
fn db_fields_for(file: &str) -> &'static [DbField] {
    use DatabaseTermRole::{Description, Message, Name, Nickname, Profile};
    match file {
        "Actors.json" => &[
            DbField {
                field: "name",
                role: Name,
            },
            DbField {
                field: "nickname",
                role: Nickname,
            },
            DbField {
                field: "profile",
                role: Profile,
            },
        ],
        // Classes/Enemies expose only `name`; Troops likewise here — its
        // battle-message command text is walked by walk_troop_battle_messages.
        "Classes.json" | "Enemies.json" | "Troops.json" => &[DbField {
            field: "name",
            role: Name,
        }],
        "Items.json" | "Weapons.json" | "Armors.json" => &[
            DbField {
                field: "name",
                role: Name,
            },
            DbField {
                field: "description",
                role: Description,
            },
        ],
        "Skills.json" => &[
            DbField {
                field: "name",
                role: Name,
            },
            DbField {
                field: "description",
                role: Description,
            },
            DbField {
                field: "message1",
                role: Message,
            },
            DbField {
                field: "message2",
                role: Message,
            },
        ],
        "States.json" => &[
            DbField {
                field: "name",
                role: Name,
            },
            DbField {
                field: "message1",
                role: Message,
            },
            DbField {
                field: "message2",
                role: Message,
            },
            DbField {
                field: "message3",
                role: Message,
            },
            DbField {
                field: "message4",
                role: Message,
            },
        ],
        _ => &[],
    }
}

/// True for a database file this slice extracts direct string fields from.
#[must_use]
pub fn is_database_file(file: &str) -> bool {
    !db_fields_for(file).is_empty()
}

// ---------------------------------------------------------------------------
// Extraction — database files
// ---------------------------------------------------------------------------

/// Read the object's `id` field (fallback to the array `index`).
fn object_id(entry: &Value, index: usize) -> i64 {
    entry
        .get("id")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| i64::try_from(index).unwrap_or(i64::MAX))
}

// reason: cohesive stable-unit constructor over distinct positional fields.
#[allow(clippy::too_many_arguments)]
fn push_unit(
    acc: &mut DatabaseExtraction,
    source_file: &str,
    container: UnitContainer,
    field_key: String,
    array_index: Option<usize>,
    role: DatabaseTermRole,
    pointer: Vec<String>,
    text: &str,
) {
    // Empty strings are not translatable surfaces (matches the KAIFUU-109
    // slice); skipping one is not a silent drop of translatable text.
    if text.is_empty() {
        return;
    }
    acc.units.push(StableDatabaseUnit {
        source_file: source_file.to_string(),
        container,
        field_key,
        array_index,
        text_role: role,
        fixture_profile_id: FIXTURE_PROFILE_ID,
        pointer,
        source_text: text.to_string(),
    });
}

/// Extract declared string units from a parsed database array file
/// (`Actors.json`, `Items.json`, …, `Troops.json`).
#[must_use]
pub fn extract_database(source_file: &str, value: &Value) -> DatabaseExtraction {
    let mut acc = DatabaseExtraction::default();
    let Some(array) = value.as_array() else {
        acc.diagnostics.push(DatabaseDiagnostic {
            kind: DatabaseDiagnosticKind::MalformedContainer,
            source_file: source_file.to_string(),
            pointer: Vec::new(),
            command_code: None,
            detail: "database file top level is not a JSON array".to_string(),
        });
        return acc;
    };
    let fields = db_fields_for(source_file);
    for (index, entry) in array.iter().enumerate() {
        // RPG Maker database arrays carry a leading `null` placeholder at
        // index 0; non-object entries are skipped (not a malformed-container
        // error — the leading null is the documented schema shape).
        let Some(object) = entry.as_object() else {
            continue;
        };
        let entry_id = object_id(entry, index);
        let container = UnitContainer::DatabaseEntry {
            entry_id,
            entry_index: index,
        };
        for field in fields {
            let Some(raw) = object.get(field.field) else {
                continue;
            };
            match raw.as_str() {
                Some(text) => push_unit(
                    &mut acc,
                    source_file,
                    container.clone(),
                    field.field.to_string(),
                    None,
                    field.role,
                    vec![index.to_string(), field.field.to_string()],
                    text,
                ),
                None => acc.diagnostics.push(DatabaseDiagnostic {
                    kind: DatabaseDiagnosticKind::UnsupportedFieldType,
                    source_file: source_file.to_string(),
                    pointer: vec![index.to_string(), field.field.to_string()],
                    command_code: None,
                    detail: format!(
                        "declared string field `{}` is present but not a JSON string; not extracted",
                        field.field
                    ),
                }),
            }
        }
        // Troops carry their battle messages as event-command text.
        if source_file == "Troops.json" {
            walk_troop_battle_messages(&mut acc, source_file, entry_id, index, object);
        }
    }
    acc
}

/// Walk a troop's `pages[].list[]` battle-event commands, extracting the
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

// ---------------------------------------------------------------------------
// Extraction — System.json
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// File-level extraction
// ---------------------------------------------------------------------------

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
        serde_json::from_slice(&bytes).map_err(|source| DatabaseExtractError::MalformedJson {
            file: file.clone(),
            source,
        })?;
    Ok((file, value))
}

// ---------------------------------------------------------------------------
// Byte-preserving patch
// ---------------------------------------------------------------------------

/// One reviewed translation: the stable unit + its target text.
#[derive(Debug, Clone)]
pub struct DatabaseTranslation<'a> {
    pub unit: &'a StableDatabaseUnit,
    pub target_text: String,
}

/// Patch one file's raw JSON bytes with the reviewed translations for its
/// declared database/term units, preserving every other byte.
///
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


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn actors_declared_fields_extract_numeric_and_note_do_not() {
        let actors = json!([
            null,
            {
                "id": 1,
                "name": "Ariel",
                "nickname": "The Bold",
                "profile": "A wandering knight.",
                "note": "<dev tag>",
                "initialLevel": 1,
                "characterIndex": 0
            }
        ]);
        let out = extract_database("Actors.json", &actors);
        assert!(out.diagnostics.is_empty());
        let roles: Vec<&str> = out.units.iter().map(|u| u.text_role.as_str()).collect();
        assert_eq!(roles, vec!["name", "nickname", "profile"]);
        // note / initialLevel / characterIndex are never surfaced.
        for unit in &out.units {
            assert_ne!(unit.field_key, "note");
            assert_eq!(unit.entry_id(), Some(1));
            assert_eq!(unit.entry_index(), Some(1));
            assert_eq!(unit.fixture_profile_id, "KAIFUU-110");
        }
        assert_eq!(
            out.units[0].source_unit_key(),
            "rpgmaker:Actors.json#/1/name"
        );
    }

    #[test]
    fn skills_and_states_messages_are_declared() {
        let skills = json!([
            null,
            {"id": 1, "name": "Fire", "description": "Burns.", "message1": " chants!", "message2": ""}
        ]);
        let out = extract_database("Skills.json", &skills);
        // Empty message2 is not a unit.
        let keys: Vec<&str> = out.units.iter().map(|u| u.field_key.as_str()).collect();
        assert_eq!(keys, vec!["name", "description", "message1"]);
        assert_eq!(out.units[2].text_role, DatabaseTermRole::Message);

        let states = json!([
            null,
            {"id": 1, "name": "Poison", "message1": " is poisoned!", "message2": "", "message3": "", "message4": " recovers."}
        ]);
        let out = extract_database("States.json", &states);
        let keys: Vec<&str> = out.units.iter().map(|u| u.field_key.as_str()).collect();
        assert_eq!(keys, vec!["name", "message1", "message4"]);
    }

    #[test]
    fn troop_name_and_battle_messages_extract_unknown_code_is_diagnostic() {
        let troops = json!([
            null,
            {
                "id": 1,
                "name": "Slime*2",
                "members": [{"enemyId": 1, "x": 100, "y": 200}],
                "pages": [
                    {"list": [
                        {"code": 101, "parameters": ["", 0, 0, 2]},
                        {"code": 401, "parameters": ["The slimes attack!"]},
                        {"code": 405, "parameters": ["A hush falls over the field."]},
                        {"code": 12345, "parameters": []}
                    ]}
                ]
            }
        ]);
        let out = extract_database("Troops.json", &troops);
        let roles: Vec<&str> = out.units.iter().map(|u| u.text_role.as_str()).collect();
        assert_eq!(roles, vec!["name", "battle_message", "battle_message"]);
        // Troop name pointer, then the two battle messages.
        assert_eq!(
            out.units[0].source_unit_key(),
            "rpgmaker:Troops.json#/1/name"
        );
        assert_eq!(
            out.units[1].source_unit_key(),
            "rpgmaker:Troops.json#/1/pages/0/list/1/parameters/0"
        );
        assert_eq!(out.units[1].array_index, Some(1));
        // The unknown battle-event code is a diagnostic, never a silent drop.
        assert_eq!(out.diagnostics.len(), 1);
        assert_eq!(out.diagnostics[0].command_code, Some(12345));
        assert_eq!(
            out.diagnostics[0].kind,
            DatabaseDiagnosticKind::UnsupportedCommand
        );
    }

    #[test]
    fn numeric_in_string_field_is_unsupported_field_diagnostic() {
        // A number placed where a declared string field is expected must NOT
        // be extracted, and is flagged as an unsupported field type.
        let items = json!([null, {"id": 1, "name": 42, "description": "ok"}]);
        let out = extract_database("Items.json", &items);
        assert_eq!(out.units.len(), 1, "only the string description extracts");
        assert_eq!(out.units[0].field_key, "description");
        assert_eq!(out.diagnostics.len(), 1);
        assert_eq!(
            out.diagnostics[0].kind,
            DatabaseDiagnosticKind::UnsupportedFieldType
        );
        assert_eq!(out.diagnostics[0].pointer, vec!["1", "name"]);
    }

    #[test]
    fn malformed_database_container_is_diagnostic() {
        let out = extract_database("Items.json", &json!({"not": "an array"}));
        assert!(out.units.is_empty());
        assert_eq!(
            out.diagnostics[0].kind,
            DatabaseDiagnosticKind::MalformedContainer
        );
    }

    #[test]
    fn system_terms_and_types_extract_with_stable_pointers() {
        let system = json!({
            "gameTitle": "My Game",
            "currencyUnit": "G",
            "versionId": 12345,
            "equipTypes": ["", "Weapon", "Shield"],
            "elements": ["", "Fire", "Ice"],
            "terms": {
                "basic": ["Level", "Lv"],
                "commands": ["Fight", "", "Escape"],
                "params": ["Max HP"],
                "messages": {"possession": "Possession", "level": "%1 Lv."}
            }
        });
        let out = extract_system("System.json", &system);
        assert!(
            out.diagnostics.is_empty(),
            "clean System has no diagnostics"
        );

        let key = |k: &str| out.units.iter().any(|u| u.source_unit_key() == k);
        assert!(key("rpgmaker:System.json#/gameTitle"));
        assert!(key("rpgmaker:System.json#/currencyUnit"));
        // Empty type-list slot 0 is not a unit; slot 1 is.
        assert!(key("rpgmaker:System.json#/equipTypes/1"));
        assert!(!key("rpgmaker:System.json#/equipTypes/0"));
        assert!(key("rpgmaker:System.json#/elements/1"));
        assert!(key("rpgmaker:System.json#/terms/basic/0"));
        // Empty commands slot 1 skipped; slot 2 kept.
        assert!(key("rpgmaker:System.json#/terms/commands/2"));
        assert!(!key("rpgmaker:System.json#/terms/commands/1"));
        assert!(key("rpgmaker:System.json#/terms/messages/level"));
        assert!(key("rpgmaker:System.json#/terms/messages/possession"));

        // gameTitle is metadata; a type list is a type_name; a term is a term.
        let title = out
            .units
            .iter()
            .find(|u| u.field_key == "gameTitle")
            .unwrap();
        assert_eq!(title.text_role, DatabaseTermRole::GameTitle);
        assert!(matches!(
            title.container,
            UnitContainer::SystemSection {
                section: "gameTitle"
            }
        ));
        // versionId (a number) is never surfaced.
        assert!(!out.units.iter().any(|u| u.field_key == "versionId"));
    }

    #[test]
    fn deterministic_reextraction_yields_identical_units() {
        let system = json!({
            "gameTitle": "T",
            "terms": {"messages": {"b": "B", "a": "A", "c": "C"}}
        });
        let first = extract_system("System.json", &system);
        let second = extract_system("System.json", &system);
        assert_eq!(first, second);
        assert_eq!(
            first.units[0].bridge_unit_id(),
            second.units[0].bridge_unit_id()
        );
    }
}
