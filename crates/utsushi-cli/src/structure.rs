//! Narrative-structure export built from the replayed archive.
//!
//! RealLive exports require the exact bridge used for localization, producing
//! the evidence-complete v2 artifact and its stronger coverage checks.

mod bridge;
mod coverage;
mod expanded;
mod graph;
mod output;
mod reallive_extension;
mod softpal;

use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use kaifuu_reallive::parse_archive;
use serde_json::Value;
use utsushi_reallive::Gameexe;

use self::bridge::BridgeIndex;
use self::coverage::reject_truncating_limit;
use self::expanded::ExpandedInput;
use crate::staged_replay::staged_archive;

pub(crate) fn run_structure_command(args: &[String]) -> Result<(), Box<dyn Error>> {
    let mut engine = None;
    let mut gameexe = None;
    let mut seen = None;
    let mut scene = None;
    let mut output = None;
    let mut bridge = None;
    let mut game_root = None;
    let mut entry = None;
    let mut max_scenes = None;

    let mut index = 0;
    while index < args.len() {
        let flag = &args[index];
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--engine" => engine = Some(value.clone()),
            "--gameexe" => gameexe = Some(PathBuf::from(value)),
            "--seen" => seen = Some(PathBuf::from(value)),
            "--scene" => scene = Some(PathBuf::from(value)),
            "--output" => output = Some(PathBuf::from(value)),
            "--bridge" => bridge = Some(PathBuf::from(value)),
            "--game-root" => game_root = Some(PathBuf::from(value)),
            "--entry-scene" => entry = Some(value.parse::<u32>()?),
            "--max-scenes" => max_scenes = Some(value.parse::<usize>()?),
            _ => return Err(format!("unknown structure flag: {flag}").into()),
        }
        index += 2;
    }

    let engine = engine.ok_or("missing --engine")?;
    let provider = structure_provider(&engine)?;
    let output = output.ok_or("missing --output")?;
    let structure = provider(StructureCommandInput {
        gameexe,
        seen,
        scene,
        game_root,
        bridge,
        entry,
        max_scenes,
    })?;

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output, serde_json::to_vec_pretty(&structure)?)?;
    Ok(())
}

struct StructureCommandInput {
    gameexe: Option<PathBuf>,
    seen: Option<PathBuf>,
    scene: Option<PathBuf>,
    game_root: Option<PathBuf>,
    bridge: Option<PathBuf>,
    entry: Option<u32>,
    max_scenes: Option<usize>,
}

type StructureProvider = fn(StructureCommandInput) -> Result<Value, Box<dyn Error>>;

const STRUCTURE_PROVIDERS: &[(&str, StructureProvider)] = &[
    ("reallive", build_reallive_structure),
    ("softpal", softpal::build_softpal_structure),
    ("siglus", build_siglus_structure),
];

fn structure_provider(engine: &str) -> Result<StructureProvider, Box<dyn Error>> {
    STRUCTURE_PROVIDERS
        .iter()
        .find_map(|(id, provider)| (*id == engine).then_some(*provider))
        .ok_or_else(|| format!("unregistered structure provider: {engine}").into())
}

fn build_reallive_structure(input: StructureCommandInput) -> Result<Value, Box<dyn Error>> {
    let bridge_path = input.bridge.as_deref().ok_or("missing --bridge")?;
    let gameexe_path = input.gameexe.as_deref().ok_or("missing --gameexe")?;
    let seen_path = input.seen.as_deref().ok_or("missing --seen")?;
    let entry_scene = input.entry;
    let max_scenes = input.max_scenes;
    let seen_bytes = fs::read(seen_path)?;
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
    if let Some(limit) = max_scenes {
        reject_truncating_limit(limit, archive_scene_ids.len())?;
    }

    let gameexe = Gameexe::parse(&fs::read(gameexe_path)?)?;
    let seen_start = gameexe.get_int("SEEN_START").unwrap_or(0).max(0) as u32;
    let resolver = gameexe.namae_resolver();
    let staged = staged_archive(seen_path)?;
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
    let entry_scene = entry_scene.unwrap_or_else(|| {
        if bridge.source_scope["kind"] == "whole_archive" {
            seen_start
        } else {
            u32::from(
                *selected_scene_ids
                    .first()
                    .expect("scoped bridge has an asset"),
            )
        }
    });
    let entry_scene = u16::try_from(entry_scene)
        .map_err(|err| format!("entry scene is outside the RealLive scene range: {err}"))?;
    let selected_scenes = staged
        .scenes
        .iter()
        .filter(|scene| selected_scene_ids.contains(&scene.scene_id))
        .cloned()
        .collect::<Vec<_>>();
    let structure = expanded::build(ExpandedInput {
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

fn build_siglus_structure(input: StructureCommandInput) -> Result<Value, Box<dyn Error>> {
    let scene_path = input.scene.as_deref().ok_or("missing --scene")?;
    let gameexe_path = input.gameexe.as_deref().ok_or("missing --gameexe")?;
    utsushi_siglus::build_siglus_structure(scene_path, gameexe_path).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reallive_structure_requires_a_bridge_before_reading_game_inputs() {
        let error = build_reallive_structure(StructureCommandInput {
            gameexe: None,
            seen: None,
            scene: None,
            game_root: None,
            bridge: None,
            entry: None,
            max_scenes: None,
        })
        .expect_err("the v2-only RealLive exporter must require --bridge");

        assert_eq!(error.to_string(), "missing --bridge");
    }
}
