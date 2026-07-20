//! `utsushi-cli replay --engine <adapter>` command.
//!
//! The command parses only the generic adapter id, artifact root, opaque
//! descriptor, and output path. The selected CLI adapter parses its descriptor
//! and constructs the typed request passed to the core runtime registry.

use std::error::Error;
use std::fs;
use std::path::PathBuf;

use utsushi_core::RuntimeAdapterRegistry;

use crate::replay_cli_registry::{
    ReplayCliOperation, default_cli_registry, parse_generic_request, run_selected_replay,
};
use crate::replay_registry::replay_log_json;

pub fn run_replay_command(
    args: &[String],
    registry: &RuntimeAdapterRegistry<'_>,
) -> Result<(), Box<dyn Error>> {
    let (adapter_id, request) = parse_generic_request(args, "utsushi.cli.replay")?;
    let output_path = PathBuf::from(required_flag(args, "--output")?);
    if args.iter().any(|arg| arg == "--snapshot-output") {
        return Err(
            "utsushi.cli.replay.snapshot_output_unsupported: EnginePort replay-review does not publish snapshot JSON; omit --snapshot-output"
                .into(),
        );
    }

    let cli_registry = default_cli_registry();
    let result = run_selected_replay(
        registry,
        &cli_registry,
        &adapter_id,
        &request,
        ReplayCliOperation::Replay,
        "utsushi.cli.replay",
    )?;
    let replay_json = replay_log_json(&result, "utsushi.cli.replay")?;
    fs::write(&output_path, replay_json)
        .map_err(|err| format!("utsushi.cli.replay.write: {err}"))?;
    Ok(())
}

fn required_flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn Error>> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
        .ok_or_else(|| format!("utsushi.cli.replay.missing_flag: {name}").into())
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
    fn unsupported_adapter_fails_before_adapter_descriptor_parsing() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "siglus".into(),
            "--artifact-root".into(),
            "/tmp/nothing".into(),
            "--launch-descriptor".into(),
            "{}".into(),
            "--output".into(),
            "/tmp/out.json".into(),
        ];
        let registry = replay_registry();
        let err = run_replay_command(&args, &registry).expect_err("adapter must be selected first");
        assert!(err.to_string().contains("registry_adapter_not_found"));
    }

    #[test]
    fn rejects_missing_generic_artifact_root() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--launch-descriptor".into(),
            "{}".into(),
            "--output".into(),
            "/tmp/out.json".into(),
        ];
        let registry = replay_registry();
        let err = run_replay_command(&args, &registry).expect_err("artifact root is generic input");
        assert!(err.to_string().contains("--artifact-root"));
    }

    #[test]
    fn selected_adapter_owns_descriptor_validation() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--artifact-root".into(),
            "/tmp/nothing".into(),
            "--launch-descriptor".into(),
            "{}".into(),
            "--output".into(),
            "/tmp/out.json".into(),
        ];
        let registry = replay_registry();
        let err =
            run_replay_command(&args, &registry).expect_err("selected adapter parses descriptor");
        assert!(err.to_string().contains("registry.launch_descriptor"));
    }

    #[test]
    fn rejects_unpublished_snapshot_output_explicitly() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--artifact-root".into(),
            "/tmp/nothing".into(),
            "--launch-descriptor".into(),
            r#"{"scene":1,"gameexePath":"/tmp/gameexe.ini","g00Dir":"/tmp/g00"}"#.into(),
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
    fn generic_invocation_reaches_registry_dispatched_driver() {
        let missing_root = std::env::temp_dir().join(format!(
            "utsushi-cli-replay-missing-root-{}",
            std::process::id()
        ));
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--artifact-root".into(),
            missing_root.display().to_string(),
            "--launch-descriptor".into(),
            r#"{"scene":1,"gameexePath":"/tmp/missing-gameexe.ini","g00Dir":"/tmp/missing-g00"}"#
                .into(),
            "--output".into(),
            missing_root.with_extension("json").display().to_string(),
        ];

        let registry = replay_registry();
        let err = run_replay_command(&args, &registry)
            .expect_err("missing artifact should fail in the replay driver");
        assert!(
            err.to_string().contains("utsushi.cli.replay.driver"),
            "generic invocation should reach the registry-dispatched driver, got: {err}"
        );
    }
}
