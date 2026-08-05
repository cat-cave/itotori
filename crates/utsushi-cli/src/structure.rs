//! Engine-agnostic narrative-structure command parsing and artifact writing.
//!
//! Format-specific inputs and behavior live in [`adapters`]. The shared command
//! accepts only the common project transport fields.

mod adapters;
mod bridge;
mod coverage;
mod expanded;
mod graph;
mod output;
mod reallive_extension;
mod softpal;
mod softpal_bridge;

use std::error::Error;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;

pub(crate) fn run_structure_command(args: &[String]) -> Result<(), Box<dyn Error>> {
    let mut engine = None;
    let mut output = None;
    let mut bridge = None;
    let mut game_root = None;
    let mut adapter_config = None;

    let mut index = 0;
    while index < args.len() {
        let flag = &args[index];
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--engine" => engine = Some(value.clone()),
            "--output" => output = Some(PathBuf::from(value)),
            "--bridge" => bridge = Some(PathBuf::from(value)),
            "--game-root" => game_root = Some(PathBuf::from(value)),
            "--adapter-config" => {
                if adapter_config.is_some() {
                    return Err(
                        "utsushi.structure.adapter_config.duplicate: --adapter-config may be supplied once"
                            .into(),
                    );
                }
                adapter_config = Some(parse_adapter_config(value)?);
            }
            _ => return Err(format!("unknown structure flag: {flag}").into()),
        }
        index += 2;
    }

    let engine = engine.ok_or("missing --engine")?;
    let provider = adapters::structure_provider(&engine)?;
    let output = output.ok_or("missing --output")?;
    let game_root = game_root.ok_or("missing --game-root")?;
    let bridge = bridge.ok_or("missing --bridge")?;
    let structure = provider(StructureCommandInput {
        game_root,
        bridge,
        adapter_config,
    })?;

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output, serde_json::to_vec_pretty(&structure)?)?;
    Ok(())
}

fn parse_adapter_config(value: &str) -> Result<Value, Box<dyn Error>> {
    let config: Value = serde_json::from_str(value)
        .map_err(|error| format!("invalid --adapter-config JSON object: {error}"))?;
    config
        .is_object()
        .then_some(config)
        .ok_or_else(|| "--adapter-config must be a JSON object".into())
}

struct StructureCommandInput {
    game_root: PathBuf,
    bridge: PathBuf,
    adapter_config: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_config_must_be_a_json_object() {
        let args = vec![
            "--engine".to_owned(),
            "softpal".to_owned(),
            "--adapter-config".to_owned(),
            "[]".to_owned(),
        ];

        let error = run_structure_command(&args).expect_err("arrays are not adapter configs");

        assert_eq!(error.to_string(), "--adapter-config must be a JSON object");
    }

    #[test]
    fn adapter_config_must_be_valid_json() {
        let args = vec![
            "--engine".to_owned(),
            "softpal".to_owned(),
            "--adapter-config".to_owned(),
            "not-json".to_owned(),
        ];

        let error = run_structure_command(&args).expect_err("invalid JSON must fail");

        assert!(
            error
                .to_string()
                .starts_with("invalid --adapter-config JSON object:"),
            "{error}"
        );
    }

    #[test]
    fn adapter_config_may_be_supplied_once() {
        let args = vec![
            "--engine".to_owned(),
            "softpal".to_owned(),
            "--adapter-config".to_owned(),
            "{}".to_owned(),
            "--adapter-config".to_owned(),
            "{}".to_owned(),
        ];

        let error = run_structure_command(&args).expect_err("duplicate config must fail");

        assert_eq!(
            error.to_string(),
            "utsushi.structure.adapter_config.duplicate: --adapter-config may be supplied once"
        );
    }

    #[test]
    fn adapters_name_an_unsupported_config_key() {
        let args = vec![
            "--engine".to_owned(),
            "softpal".to_owned(),
            "--game-root".to_owned(),
            "source-root".to_owned(),
            "--bridge".to_owned(),
            "bridge.json".to_owned(),
            "--adapter-config".to_owned(),
            r#"{"unknown":true}"#.to_owned(),
            "--output".to_owned(),
            "unused.json".to_owned(),
        ];

        let error = run_structure_command(&args).expect_err("unknown config keys must fail");

        assert_eq!(
            error.to_string(),
            "utsushi.structure.softpal.adapter_config: unsupported key \"unknown\""
        );
    }

    #[test]
    fn rejects_removed_engine_shaped_legacy_flags() {
        let args = vec![
            "--engine".to_owned(),
            "reallive".to_owned(),
            "--game-root".to_owned(),
            "source-root".to_owned(),
            "--bridge".to_owned(),
            "bridge.json".to_owned(),
            "--output".to_owned(),
            "structure.json".to_owned(),
            "--scene".to_owned(),
            "legacy-scene.pck".to_owned(),
        ];

        let error = run_structure_command(&args).expect_err("legacy asset paths are rejected");

        assert_eq!(error.to_string(), "unknown structure flag: --scene");
    }
}
