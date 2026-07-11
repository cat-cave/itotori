//! UTSUSHI-220 — `utsushi-cli replay --engine <engine>` command.
//!
//! Routes replay through the CLI runtime adapter registry's replay-review
//! capability and writes the selected engine's deterministic replay-log JSON.
//! The RealLive port requires Gameexe and a g00 directory even when the
//! caller only requests text evidence, because those are typed port inputs.

use std::error::Error;
use std::fs;
use std::path::PathBuf;

use serde_json::json;
use utsushi_core::{
    RuntimeAdapter, RuntimeAdapterRegistry, RuntimeCapability, RuntimeOperation, RuntimeRequest,
};

use crate::replay_registry::{replay_log_json, replay_parameters};

/// Execute the `replay` subcommand. The argv layout is:
///
/// ```text
/// utsushi-cli replay --engine reallive --seen <PATH> --scene <N>
///                    --gameexe <PATH> --g00-dir <DIR> --output <PATH>
///                    [--snapshot-output <PATH>]
/// ```
///
/// `--snapshot-output` is retained as a parsed compatibility flag, but is
/// rejected explicitly: the EnginePort replay-review surface self-verifies
/// snapshots and does not publish a snapshot payload.
pub fn run_replay_command(
    args: &[String],
    registry: &RuntimeAdapterRegistry<'_>,
) -> Result<(), Box<dyn Error>> {
    let engine = required_flag(args, "--engine")?;
    let seen_path = PathBuf::from(required_flag(args, "--seen")?);
    let scene_id: u16 = required_flag(args, "--scene")?
        .parse()
        .map_err(|err| format!("utsushi.cli.replay.scene_parse: --scene must be a u16: {err}"))?;
    let gameexe_path = PathBuf::from(required_flag(args, "--gameexe")?);
    let g00_dir = PathBuf::from(required_flag(args, "--g00-dir")?);
    let output_path = PathBuf::from(required_flag(args, "--output")?);
    if args.iter().any(|arg| arg == "--snapshot-output") {
        return Err(
            "utsushi.cli.replay.snapshot_output_unsupported: EnginePort replay-review does not publish snapshot JSON; omit --snapshot-output"
                .into(),
        );
    }

    let result = run_registry_replay(
        registry,
        engine,
        &seen_path,
        replay_parameters(scene_id, &gameexe_path, &g00_dir),
    )?;
    let replay_json = replay_log_json(&result, "utsushi.cli.replay")?;
    fs::write(&output_path, replay_json)
        .map_err(|err| format!("utsushi.cli.replay.write: {err}"))?;
    Ok(())
}

fn run_registry_replay(
    registry: &RuntimeAdapterRegistry<'_>,
    engine: &str,
    seen_path: &std::path::Path,
    parameters: serde_json::Value,
) -> Result<serde_json::Value, Box<dyn Error>> {
    let descriptor = registry.adapter(engine).map(RuntimeAdapter::descriptor);
    let Some(descriptor) = descriptor else {
        return Err(registry_diagnostic(
            "utsushi.cli.replay.registry_adapter_not_found",
            engine,
            "no runtime adapter is registered for the requested replay engine",
            registry,
        )
        .into());
    };
    if !descriptor.supports(RuntimeCapability::ReplayReview) {
        return Err(registry_diagnostic(
            "utsushi.cli.replay.registry_capability_unsupported",
            engine,
            "registered runtime adapter does not support replay_review",
            registry,
        )
        .into());
    }
    let request = RuntimeRequest::new(seen_path).with_parameters(parameters);
    registry.run(engine, RuntimeOperation::ReplayReview, &request)
}

fn registry_diagnostic(
    code: &str,
    engine: &str,
    message: &str,
    registry: &RuntimeAdapterRegistry<'_>,
) -> String {
    json!({
        "diagnostic": {
            "code": code,
            "engine": engine,
            "requiredCapability": RuntimeCapability::ReplayReview.as_str(),
            "message": message,
            "registeredAdapters": registry.descriptors().into_iter().map(|descriptor| {
                let capabilities = descriptor
                    .capabilities
                    .into_iter()
                    .map(RuntimeCapability::as_str)
                    .collect::<Vec<_>>();
                json!({
                    "name": descriptor.name,
                    "capabilities": capabilities,
                })
            }).collect::<Vec<_>>(),
        }
    })
    .to_string()
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
    use crate::replay_registry::RealLiveReplayAdapter;

    fn replay_registry() -> RuntimeAdapterRegistry<'static> {
        static ADAPTER: RealLiveReplayAdapter = RealLiveReplayAdapter::new();
        let mut registry = RuntimeAdapterRegistry::new();
        registry.register(&ADAPTER).expect("register adapter");
        registry
    }

    #[test]
    fn run_replay_command_rejects_unsupported_engine() {
        let args: Vec<String> = vec![
            "--engine".to_string(),
            "siglus".to_string(),
            "--seen".to_string(),
            "/tmp/nothing".to_string(),
            "--scene".to_string(),
            "1".to_string(),
            "--gameexe".to_string(),
            "/tmp/missing-gameexe.ini".to_string(),
            "--g00-dir".to_string(),
            "/tmp/missing-g00".to_string(),
            "--output".to_string(),
            "/tmp/out.json".to_string(),
        ];
        let registry = replay_registry();
        let err = run_replay_command(&args, &registry).expect_err("siglus is not supported");
        assert!(err.to_string().contains("registry_adapter_not_found"));
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
        let registry = replay_registry();
        let err = run_replay_command(&args, &registry).expect_err("missing --seen");
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
        let registry = replay_registry();
        let err = run_replay_command(&args, &registry).expect_err("scene parse must fail");
        assert!(err.to_string().contains("scene_parse"));
    }

    #[test]
    fn run_replay_command_rejects_unpublished_snapshot_output_explicitly() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--seen".into(),
            "/tmp/nothing".into(),
            "--scene".into(),
            "1".into(),
            "--gameexe".into(),
            "/tmp/missing-gameexe.ini".into(),
            "--g00-dir".into(),
            "/tmp/missing-g00".into(),
            "--output".into(),
            "/tmp/out.json".into(),
            "--snapshot-output".into(),
            "/tmp/snapshot.json".into(),
        ];
        let registry = replay_registry();
        let err = run_replay_command(&args, &registry)
            .expect_err("snapshot JSON is not published by replay-review");
        assert!(err.to_string().contains("snapshot_output_unsupported"));
    }

    #[test]
    fn canonical_invocation_reaches_registry_dispatched_reallive_driver() {
        let missing_seen_path = std::env::temp_dir().join(format!(
            "utsushi-cli-replay-missing-seen-{}",
            std::process::id()
        ));
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--seen".into(),
            missing_seen_path.display().to_string(),
            "--scene".into(),
            "1".into(),
            "--gameexe".into(),
            "/tmp/missing-gameexe.ini".into(),
            "--g00-dir".into(),
            "/tmp/missing-g00".into(),
            "--output".into(),
            missing_seen_path
                .with_extension("json")
                .display()
                .to_string(),
        ];

        let registry = replay_registry();
        let err = run_replay_command(&args, &registry)
            .expect_err("missing Seen.txt should fail in the replay driver");
        assert!(
            err.to_string().contains("utsushi.cli.replay.driver"),
            "canonical invocation should parse and reach the registry-dispatched driver, got: {err}"
        );
    }
}
