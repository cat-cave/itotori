//! Deterministic public MV/MZ fixture manifest and materializer.

use std::path::Path;

use crate::{KaifuuResult, atomic_write_text, sha256_hash_bytes};

use super::{model::*, record::*};

/// The synthetic public fixture files, sorted by relative path. Pure /
/// deterministic — no disk access. Each tuple is
fn fixture_files() -> Vec<(&'static str, Option<MvMzSurfaceRole>, String)> {
    // Project-root marker (MV ships `Game.rpgproject` beside `www/`). Public
    // synthetic content; identifies the tree without retail bytes.
    let game_rpgproject = "RPGMV 1.6.2\n".to_string();

    // System.json declares encrypted media exists (so archive detection
    // identifies the tree) but the encrypted bytes are NEVER shipped — the
    // encrypted-media channel is metadata only. `gameTitle`/`currencyUnit`
    // back the System role; `terms`/type-lists back the Terms role.
    let system_json = r#"{
  "gameTitle": "Itotori Public MV/MZ Fixture",
  "currencyUnit": "G",
  "hasEncryptedImages": true,
  "hasEncryptedAudio": true,
  "locale": "en_US",
  "terms": {
    "basic": ["Level", "Lv", "HP", "MP"],
    "params": ["Max HP", "Max MP", "Attack"],
    "commands": [null, "Fight", "Escape", "Item"],
    "messages": {
      "actorDamage": "%1 took %2 damage!",
      "actorRecovery": "%1 recovered %2 HP!"
    }
  },
  "equipTypes": ["", "Weapon", "Shield"],
  "skillTypes": ["", "Magic", "Special"],
  "weaponTypes": ["", "Dagger"],
  "armorTypes": ["", "Light Armor"],
  "elements": ["", "Fire", "Ice"]
}
"#
    .to_string();

    // Map001.json: 101 setup, 401 dialogue (with a \V[n] control span), 102
    // choices, 105/405 scrolling text — the map JSON-text surface.
    let map001_json = r#"{
  "displayName": "Public Fixture Town",
  "events": [null, {"id": 1, "pages": [{"list": [
    {"code": 101, "indent": 0, "parameters": ["Actor1", 0, 0, 2, "Guide"]},
    {"code": 401, "indent": 0, "parameters": ["Welcome \\v[1] to the public fixture."]},
    {"code": 401, "indent": 0, "parameters": ["This text is synthetic."]},
    {"code": 102, "indent": 0, "parameters": [["Continue", "Leave"], 1, 0, 2, 0]},
    {"code": 402, "indent": 0, "parameters": [0, "Continue"]},
    {"code": 404, "indent": 0, "parameters": []},
    {"code": 105, "indent": 0, "parameters": [2, false]},
    {"code": 405, "indent": 0, "parameters": ["Scrolling synthetic narration."]},
    {"code": 356, "indent": 0, "parameters": ["FixturePlugin demo"]},
    {"code": 0, "indent": 0, "parameters": []}
  ]}]}]
}
"#
    .to_string();

    // CommonEvents.json: a single common event with a 401 line.
    let common_events_json =
        r#"[null, {"id": 1, "name": "Intro", "trigger": 0, "switchId": 1, "list": [
  {"code": 101, "indent": 0, "parameters": ["", 0, 0, 2]},
  {"code": 401, "indent": 0, "parameters": ["Common-event synthetic line."]},
  {"code": 0, "indent": 0, "parameters": []}
]}]
"#
        .to_string();

    // Database files: Actors + Items name/description surfaces.
    let actors_json =
        "[null, {\"id\": 1, \"name\": \"Fixture Hero\", \"nickname\": \"Test\", \"profile\": \"A synthetic actor.\"}]\n"
            .to_string();
    let items_json =
        "[null, {\"id\": 1, \"name\": \"Public Potion\", \"description\": \"Restores synthetic HP.\"}]\n"
            .to_string();

    let mut files = vec![
        ("Game.rpgproject", None, game_rpgproject),
        (
            "www/data/System.json",
            Some(MvMzSurfaceRole::System),
            system_json,
        ),
        (
            "www/data/Map001.json",
            Some(MvMzSurfaceRole::Maps),
            map001_json,
        ),
        (
            "www/data/CommonEvents.json",
            Some(MvMzSurfaceRole::CommonEvents),
            common_events_json,
        ),
        (
            "www/data/Actors.json",
            Some(MvMzSurfaceRole::Database),
            actors_json,
        ),
        (
            "www/data/Items.json",
            Some(MvMzSurfaceRole::Database),
            items_json,
        ),
    ];
    files.sort_by(|a, b| a.0.cmp(b.0));
    files
}

/// Build the deterministic public fixture manifest without touching disk.
pub fn mv_mz_fixture_manifest() -> MvMzFixtureManifest {
    let files = fixture_files()
        .into_iter()
        .map(|(relative_path, role, content)| {
            let bytes = content.as_bytes();
            MvMzFixtureFile {
                id: format!("{MV_MZ_FIXTURE_ID}/{relative_path}"),
                relative_path: relative_path.to_string(),
                role,
                content_sha256: sha256_hash_bytes(bytes),
                byte_count: bytes.len() as u64,
            }
        })
        .collect();
    MvMzFixtureManifest {
        schema_version: MV_MZ_FIXTURE_MANIFEST_SCHEMA_VERSION.to_string(),
        fixture_id: MV_MZ_FIXTURE_ID.to_string(),
        files,
    }
}

/// Write the public MV/MZ fixture tree under `root` and return the manifest.
/// Only deterministic public JSON (and the project-root marker) is written;
/// no retail bytes, private paths, screenshots, or encrypted assets. Files
/// are written atomically. The returned manifest is byte-identical to
/// [`mv_mz_fixture_manifest`].
pub fn generate_mv_mz_fixture_tree(root: &Path) -> KaifuuResult<MvMzFixtureManifest> {
    for (relative_path, _role, content) in fixture_files() {
        let target = root.join(relative_path);
        atomic_write_text(&target, &content)?;
    }
    Ok(mv_mz_fixture_manifest())
}
