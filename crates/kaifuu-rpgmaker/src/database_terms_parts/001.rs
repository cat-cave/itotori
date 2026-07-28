use std::path::Path;

use serde_json::Value;
use thiserror::Error;

use kaifuu_core::sha256_hash_bytes;

use crate::codes::{CodeClass, classify};
use crate::ids::deterministic_uuid7;
use crate::patchback::{FileEdit, PatchbackError, patch_file_bytes};

/// The fixture-profile id every unit is stamped.
pub const FIXTURE_PROFILE_ID: &str = "synthetic-fixture";

// Roles + containers

/// The declared database / term text role.
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
    /// A `Troops.pages.list` `Show Text`/`Show Scrolling Text` battle
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

// Stable unit

/// A stable database / System-term text unit.
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
    /// The fixture-profile id ([`FIXTURE_PROFILE_ID`]).
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
    /// the slice, so [`crate::patchback`] resolves both.
    #[must_use]
    pub fn source_unit_key(&self) -> String {
        format!("rpgmaker:{}#{}", self.source_file, self.pointer_string())
    }

    /// Deterministic bridge-unit id derived from the fixture profile +
    /// surface key (UUID7-shaped; identical construction to the crate's
    /// bridge producer and the slice).
    #[must_use]
    pub fn bridge_unit_id(&self) -> String {
        deterministic_uuid7(
            &format!("rpgmaker-k110:{}", self.fixture_profile_id),
            &format!("unit-{}", self.source_unit_key()),
        )
    }
}

// Diagnostics

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
/// write* — the "malformed JSON / missing file" diagnostics.
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

// Declared field catalogue (schema-enumerated)

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

// Extraction — database files

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
    // Empty strings are not translatable surfaces (matches the
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


