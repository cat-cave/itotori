//! UTSUSHI-220 — `utsushi-cli replay --engine reallive` command.
//!
//! Drives [`utsushi_reallive::replay_scene`] against a Seen.txt path
//! and writes a typed [`utsushi_reallive::ReplayLog`] JSON. Optional
//! `--snapshot-output` flag drives
//! [`utsushi_reallive::replay_until_first_pause`] and writes the
//! captured snapshot as a separate JSON file.

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use utsushi_reallive::{ReplayOpts, replay_scene, replay_until_first_pause};

/// Stable string naming the engine the replay command targets. Only
/// `reallive` is supported today; a typed error fires for any other
/// value (no silent fallback).
const SUPPORTED_ENGINE: &str = "reallive";

/// Execute the `replay` subcommand. The argv layout is:
///
/// ```text
/// utsushi-cli replay --engine reallive --seen <PATH> --scene <N>
///                    --output <PATH> [--snapshot-output <PATH>]
/// ```
///
/// Every flag is required except `--snapshot-output`. The function
/// returns a typed error so the caller can render it through the
/// existing `Box<dyn Error>` discipline.
pub fn run_replay_command(args: &[String]) -> Result<(), Box<dyn Error>> {
    let engine = required_flag(args, "--engine")?;
    if engine != SUPPORTED_ENGINE {
        return Err(format!(
            "utsushi.cli.replay.unsupported_engine: engine={engine}; only {SUPPORTED_ENGINE} is \
             supported",
        )
        .into());
    }
    let seen_path = PathBuf::from(required_flag(args, "--seen")?);
    let scene_id: u16 = required_flag(args, "--scene")?
        .parse()
        .map_err(|err| format!("utsushi.cli.replay.scene_parse: --scene must be a u16: {err}"))?;
    let output_path = PathBuf::from(required_flag(args, "--output")?);
    let snapshot_output_path = optional_flag(args, "--snapshot-output").map(PathBuf::from);

    if let Some(snapshot_path) = snapshot_output_path.as_deref() {
        run_replay_with_snapshot(&seen_path, scene_id, &output_path, snapshot_path)
    } else {
        run_replay_log_only(&seen_path, scene_id, &output_path)
    }
}

fn run_replay_log_only(
    seen_path: &Path,
    scene_id: u16,
    output_path: &Path,
) -> Result<(), Box<dyn Error>> {
    let opts = ReplayOpts::default();
    let log = replay_scene(seen_path, scene_id, &opts)
        .map_err(|err| format!("utsushi.cli.replay.driver: {err}"))?;
    let json = log
        .to_deterministic_json()
        .map_err(|err| format!("utsushi.cli.replay.serialise: {err}"))?;
    fs::write(output_path, json).map_err(|err| format!("utsushi.cli.replay.write: {err}"))?;
    Ok(())
}

fn run_replay_with_snapshot(
    seen_path: &Path,
    scene_id: u16,
    output_path: &Path,
    snapshot_output_path: &Path,
) -> Result<(), Box<dyn Error>> {
    let (log, snapshot) = replay_until_first_pause(seen_path, scene_id)
        .map_err(|err| format!("utsushi.cli.replay.driver: {err}"))?;
    let json = log
        .to_deterministic_json()
        .map_err(|err| format!("utsushi.cli.replay.serialise: {err}"))?;
    fs::write(output_path, json).map_err(|err| format!("utsushi.cli.replay.write: {err}"))?;
    let snapshot_value = snapshot
        .to_json_value()
        .map_err(|err| format!("utsushi.cli.replay.snapshot_serialise: {err}"))?;
    let snapshot_json = serde_json::to_string_pretty(&snapshot_value)
        .map_err(|err| format!("utsushi.cli.replay.snapshot_json: {err}"))?;
    fs::write(snapshot_output_path, snapshot_json)
        .map_err(|err| format!("utsushi.cli.replay.snapshot_write: {err}"))?;
    Ok(())
}

fn required_flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn Error>> {
    optional_flag(args, name)
        .ok_or_else(|| format!("utsushi.cli.replay.missing_flag: {name}").into())
}

fn optional_flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_replay_command_rejects_unsupported_engine() {
        let args: Vec<String> = vec![
            "--engine".to_string(),
            "siglus".to_string(),
            "--seen".to_string(),
            "/tmp/nothing".to_string(),
            "--scene".to_string(),
            "1".to_string(),
            "--output".to_string(),
            "/tmp/out.json".to_string(),
        ];
        let err = run_replay_command(&args).expect_err("siglus is not supported");
        assert!(err.to_string().contains("unsupported_engine"));
    }

    #[test]
    fn run_replay_command_rejects_missing_required_flag() {
        let args: Vec<String> = vec![
            "--engine".to_string(),
            "reallive".to_string(),
            "--scene".to_string(),
            "1".to_string(),
            "--output".to_string(),
            "/tmp/out.json".to_string(),
        ];
        let err = run_replay_command(&args).expect_err("missing --seen");
        assert!(err.to_string().contains("--seen"));
    }

    #[test]
    fn run_replay_command_rejects_unparseable_scene_id() {
        let args: Vec<String> = vec![
            "--engine".to_string(),
            "reallive".to_string(),
            "--seen".to_string(),
            "/tmp/nothing".to_string(),
            "--scene".to_string(),
            "notanint".to_string(),
            "--output".to_string(),
            "/tmp/out.json".to_string(),
        ];
        let err = run_replay_command(&args).expect_err("scene parse must fail");
        assert!(err.to_string().contains("scene_parse"));
    }
}
