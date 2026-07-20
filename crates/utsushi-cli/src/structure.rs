//! Narrative-structure export built from the replayed archive.
//!
//! The legacy v1 artifact remains available when no bridge is supplied. Passing
//! the exact bridge used for localization enables the evidence-complete v2
//! artifact and its stronger coverage checks.

mod bridge;
mod coverage;
mod expanded;
mod graph;
mod legacy;
mod output;
mod reallive_extension;

use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

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
    let mut output = None;
    let mut bridge = None;
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
            "--output" => output = Some(PathBuf::from(value)),
            "--bridge" => bridge = Some(PathBuf::from(value)),
            "--entry-scene" => entry = Some(value.parse::<u32>()?),
            "--max-scenes" => max_scenes = Some(value.parse::<usize>()?),
            _ => return Err(format!("unknown structure flag: {flag}").into()),
        }
        index += 2;
    }

    let engine = engine.ok_or("missing --engine")?;
    let provider = structure_provider(&engine)?;
    let gameexe = gameexe.ok_or("missing --gameexe")?;
    let seen = seen.ok_or("missing --seen")?;
    let output = output.ok_or("missing --output")?;
    let structure = reallive_extension::common_structure(provider(
        &gameexe,
        &seen,
        bridge.as_deref(),
        entry,
        max_scenes,
    )?)?;

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output, serde_json::to_vec_pretty(&structure)?)?;
    Ok(())
}

type StructureProvider =
    fn(&Path, &Path, Option<&Path>, Option<u32>, Option<usize>) -> Result<Value, Box<dyn Error>>;

const STRUCTURE_PROVIDERS: &[(&str, StructureProvider)] = &[("reallive", build_reallive_structure)];

fn structure_provider(engine: &str) -> Result<StructureProvider, Box<dyn Error>> {
    STRUCTURE_PROVIDERS
        .iter()
        .find_map(|(id, provider)| (*id == engine).then_some(*provider))
        .ok_or_else(|| format!("unregistered structure provider: {engine}").into())
}

fn build_reallive_structure(
    gameexe_path: &Path,
    seen_path: &Path,
    bridge_path: Option<&Path>,
    entry_scene: Option<u32>,
    max_scenes: Option<usize>,
) -> Result<Value, Box<dyn Error>> {
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
    let entry_scene = u16::try_from(entry_scene.unwrap_or(seen_start))
        .map_err(|err| format!("entry scene is outside the RealLive scene range: {err}"))?;
    match bridge_path {
        Some(path) => {
            let bridge = BridgeIndex::load(path, &seen_bytes)?;
            if bridge.asset_scene_ids != archive_scene_ids {
                return Err(format!(
                    "bridge asset coverage differs from archive: archive={} bridge={}",
                    archive_scene_ids.len(),
                    bridge.asset_scene_ids.len()
                )
                .into());
            }
            expanded::build(ExpandedInput {
                engine,
                decoded_scenes: &staged.scenes,
                loaded_scene_count: staged.store_stats.loaded,
                archive_scene_ids: &archive_scene_ids,
                bridge: &bridge,
                entry: entry_scene,
            })
            .map_err(Into::into)
        }
        None => legacy::build(&engine, &staged.scenes, entry_scene).map_err(Into::into),
    }
}
