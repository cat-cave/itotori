//! MV/MZ database + `System.json` terms extract & trivial patch.
//! The database / System-terms analogue of the map / common-event
//! slice ([`crate::map_common_event`]). It consumes the fixture
//! profile's `Database`, `System`, and `Terms` surfaces
//! (`MvMzFixtureProfile` consumers ``/``; surface globs
//! `www/data/{Actors,Classes,Items,Weapons,Armors,Skills,Enemies,States,Troops}.json`
//! and `www/data/System.json`). It emits **stable database/term units** and
//! writes a **byte-preserving** patch back into the same JSON, reusing the
//! crate's proven byte-surgical splice and stale-source gate.
//! # Declared translatable string fields (schema-enumerated, never a blind
//! all-strings sweep)
//! Every field below is a DECLARED player-facing string field of the real
//! MV/MZ database schema; developer `note` fields, numeric ids, icon/price
//! numbers, switch/element ids and every other non-text field are left
//! untouched (see [`db_fields_for`] + the negative-fixture tests). The MV and
//! MZ database/term string-field schema is identical — no MV-vs-MZ divergence
//! in this surface set (the MV/MZ speaker difference lives in the 101 command
//! surface, which is [`crate::map_common_event`], not here).
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
//!   `pages.list`.
//! - **`System.json`** — `gameTitle`, `currencyUnit`, the
//!   `equipTypes`/`skillTypes`/`weaponTypes`/`armorTypes`/`elements` type
//!   lists, and `terms.{basic,params,commands,messages}`.
//! # Stable unit fields (acceptance)
//! Every [`StableDatabaseUnit`] carries `source_file`, the container
//! (database entry **id** + array **index**, or the System **section**), the
//! **field key**, the **text role**, and the **fixture-profile id**
//! ([`FIXTURE_PROFILE_ID`]). Its stable `rpgmaker:<file>#<json-pointer>`
//! [`StableDatabaseUnit::source_unit_key`] and deterministic
//! [`StableDatabaseUnit::bridge_unit_id`] (UUID7-shaped) make re-extraction
//! and patchback target the same surface — the same scheme the
//! slice uses.
//! # Byte-preserving patch
//! [`patch_file`] reuses the crate's byte-surgical splice
//! ([`crate::patchback::patch_file_bytes`]): only the located string literal
//! for each declared unit is replaced; every other byte (structure, key
//! order, whitespace, numbers, `note`/id/switch fields, untouched strings) is
//! preserved verbatim. An untranslated patch (`target == source`) is a
//! byte-identical no-op, and the stale-source hash gate rejects a patch
//! whose on-disk literal drifted since extraction.
//! # Semantic diagnostics before any write
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

mod extraction;

pub use extraction::*;

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

#[cfg(test)]
mod tests;
