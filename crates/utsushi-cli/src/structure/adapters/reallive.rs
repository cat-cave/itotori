//! RealLive narrative-structure provider and its format-root resolution.

use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_reallive::parse_archive;
use serde_json::Value;
use utsushi_reallive::Gameexe;

use super::super::StructureCommandInput;
use super::super::bridge::BridgeIndex;
use super::super::expanded::ExpandedInput;
use super::super::reallive_extension;
use super::validate_empty_adapter_config;
use crate::staged_replay::staged_archive;

pub(super) fn build_structure(input: StructureCommandInput) -> Result<Value, Box<dyn Error>> {
    validate_empty_adapter_config("reallive", &input)?;
    let bridge_path = &input.bridge;
    let (gameexe_path, seen_path) = reallive_paths(&input.game_root)?;
    let seen_bytes = fs::read(&seen_path)?;
    let archive = parse_archive(&seen_bytes)
        .map_err(|diagnostic| format!("utsushi.structure.archive_parse: {diagnostic:?}"))?;
    let archive_scene_ids = archive
        .entries
        .iter()
        .map(|entry| entry.scene_id)
        .collect::<BTreeSet<_>>();
    if archive_scene_ids.len() != archive.entries.len() {
        return Err("SEEN archive contains duplicate scene identifiers".into());
    }

    let gameexe = Gameexe::parse(&fs::read(gameexe_path)?)?;
    let seen_start = gameexe.get_int("SEEN_START").unwrap_or(0).max(0) as u32;
    let resolver = gameexe.namae_resolver();
    let staged = staged_archive(&seen_path)?;
    let decoded_scene_ids = staged
        .scenes
        .iter()
        .map(|scene| scene.scene_id)
        .collect::<BTreeSet<_>>();
    if decoded_scene_ids != archive_scene_ids
        || staged.store_stats.loaded != archive_scene_ids.len()
        || staged.store_stats.skipped != 0
    {
        return Err(format!(
            "incomplete archive decode: archive={} decoded={} loaded={} skipped={}",
            archive_scene_ids.len(),
            decoded_scene_ids.len(),
            staged.store_stats.loaded,
            staged.store_stats.skipped
        )
        .into());
    }

    let engine = staged.engine.with_namae_resolver(resolver);
    let bridge = BridgeIndex::load(bridge_path, &seen_bytes)?;
    if !bridge.asset_scene_ids.is_subset(&archive_scene_ids) {
        return Err(format!(
            "bridge scope names scenes outside archive: archive={} bridge={}",
            archive_scene_ids.len(),
            bridge.asset_scene_ids.len()
        )
        .into());
    }
    let selected_scene_ids = &bridge.asset_scene_ids;
    let entry_scene = {
        if bridge.source_scope["kind"] == "whole_archive" {
            seen_start
        } else {
            u32::from(
                *selected_scene_ids
                    .first()
                    .expect("scoped bridge has an asset"),
            )
        }
    };
    let entry_scene = u16::try_from(entry_scene)
        .map_err(|err| format!("entry scene is outside the RealLive scene range: {err}"))?;
    let selected_scenes = staged
        .scenes
        .iter()
        .filter(|scene| selected_scene_ids.contains(&scene.scene_id))
        .cloned()
        .collect::<Vec<_>>();
    let structure = super::super::expanded::build(ExpandedInput {
        engine,
        decoded_scenes: &selected_scenes,
        loaded_scene_count: selected_scenes.len(),
        archive_scene_ids: selected_scene_ids,
        bridge: &bridge,
        entry: entry_scene,
    })
    .map_err(|error| -> Box<dyn Error> { error.into() })?;
    reallive_extension::common_structure(structure).map_err(Into::into)
}

/// Resolve RealLive's format-defined files from the common project root.
fn reallive_paths(game_root: &Path) -> Result<(PathBuf, PathBuf), Box<dyn Error>> {
    let data_root = kaifuu_reallive::detect_reallive_data_dir(game_root).map_err(
        |error| -> Box<dyn Error> {
            format!("utsushi.structure.reallive.game_root: {error}").into()
        },
    )?;
    if let Some(data_root) = data_root {
        return Ok((
            reallive_gameexe(&data_root.reallive_data_path)?,
            required_data_asset(&data_root.reallive_data_path, "Seen.txt")?,
        ));
    }
    Ok((
        game_root_asset_case_insensitive(game_root, "Gameexe.ini")?,
        game_root_asset_case_insensitive(game_root, "Seen.txt")?,
    ))
}

fn reallive_gameexe(data_root: &Path) -> Result<PathBuf, Box<dyn Error>> {
    if let Some(path) = child_file_case_insensitive(data_root, "Gameexe.ini")? {
        return Ok(path);
    }
    if let Some(game_root) = data_root.parent()
        && let Some(path) = child_file_case_insensitive(game_root, "Gameexe.ini")?
    {
        return Ok(path);
    }
    Err(missing_game_root_asset(data_root, "Gameexe.ini"))
}

fn required_data_asset(data_root: &Path, name: &str) -> Result<PathBuf, Box<dyn Error>> {
    child_file_case_insensitive(data_root, name)?
        .ok_or_else(|| missing_game_root_asset(data_root, name))
}

fn game_root_asset_case_insensitive(
    game_root: &Path,
    name: &str,
) -> Result<PathBuf, Box<dyn Error>> {
    child_file_case_insensitive(game_root, name)
        .map(|path| path.ok_or_else(|| missing_game_root_asset(game_root, name)))?
}

fn child_file_case_insensitive(root: &Path, name: &str) -> Result<Option<PathBuf>, Box<dyn Error>> {
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if path
            .file_name()
            .and_then(|file_name| file_name.to_str())
            .is_some_and(|file_name| file_name.eq_ignore_ascii_case(name))
            && path.is_file()
        {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn missing_game_root_asset(game_root: &Path, name: &str) -> Box<dyn Error> {
    format!(
        "utsushi.structure.reallive.game_root: {} is missing required {name}",
        game_root.display()
    )
    .into()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn game_root_derives_data_files_case_insensitively() {
        let root = TempDir::new().expect("temporary game root");
        let data = root
            .path()
            .join("wrapper")
            .join("title")
            .join("reallivedata");
        fs::create_dir_all(&data).expect("create data directory");
        let gameexe = data.join("GAMEEXE.INI");
        let seen = data.join("SEEN.TXT");
        fs::write(&gameexe, []).expect("write gameexe");
        fs::write(&seen, []).expect("write seen");

        let (resolved_gameexe, resolved_seen) =
            reallive_paths(root.path()).expect("root derives RealLive asset paths");

        assert_eq!(resolved_gameexe, gameexe);
        assert_eq!(resolved_seen, seen);
    }

    #[test]
    fn data_layout_does_not_mix_wrapper_seen_files() {
        let root = TempDir::new().expect("temporary game root");
        let data = root.path().join("REALLIVEDATA");
        fs::create_dir(&data).expect("create data directory");
        fs::write(data.join("Gameexe.ini"), []).expect("write gameexe");
        fs::write(root.path().join("Seen.txt"), []).expect("write unrelated seen");

        let error = reallive_paths(root.path())
            .expect_err("a data-root layout must keep Seen.txt in that data directory");

        assert_eq!(
            error.to_string(),
            format!(
                "utsushi.structure.reallive.game_root: {} is missing required Seen.txt",
                data.display()
            )
        );
    }

    #[test]
    fn game_root_accepts_a_flat_format_layout() {
        let root = TempDir::new().expect("temporary game root");
        let gameexe = root.path().join("Gameexe.ini");
        let seen = root.path().join("Seen.txt");
        fs::write(&gameexe, []).expect("write gameexe");
        fs::write(&seen, []).expect("write seen");

        let (resolved_gameexe, resolved_seen) =
            reallive_paths(root.path()).expect("root derives flat RealLive asset paths");

        assert_eq!(resolved_gameexe, gameexe);
        assert_eq!(resolved_seen, seen);
    }
}
