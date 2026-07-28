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

include!("database_terms_parts/001.rs");
include!("database_terms_parts/002.rs");
include!("database_terms_parts/003.rs");
