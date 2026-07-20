//! CLI replay adapter registry.
//!
//! `utsushi-core` remains the generic runtime registry. This companion registry
//! owns only CLI-envelope parsing boundaries: an adapter turns its opaque launch
//! descriptor plus generic artifact root into the core request it needs.

use std::error::Error;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use utsushi_core::{
    RuntimeAdapter, RuntimeAdapterRegistry, RuntimeCapability, RuntimeOperation, RuntimeRequest,
};
use utsushi_reallive::ReplayOpts;

use crate::dispatch_gate::{
    DispatchReport, dispatch_report_from_engine, require_semantic_reached_path,
};
use crate::replay_registry::{replay_parameters, replay_validate_parameters};
use crate::staged_replay::staged_engine;

pub(crate) struct ReplayCliRequest {
    pub(crate) artifact_root: PathBuf,
    pub(crate) launch_descriptor: Value,
}

pub(crate) struct ReplayCliInvocation {
    input_root: PathBuf,
    parameters: Value,
}

#[derive(Clone, Copy)]
pub(crate) enum ReplayCliOperation {
    Replay,
    ReplayValidate,
}

pub(crate) trait ReplayCliAdapter: Sync {
    fn adapter_id(&self) -> &'static str;
    fn invocation(
        &self,
        request: &ReplayCliRequest,
        operation: ReplayCliOperation,
    ) -> Result<ReplayCliInvocation, Box<dyn Error>>;
    fn dispatch_report(&self, request: &ReplayCliRequest)
    -> Result<DispatchReport, Box<dyn Error>>;
}

pub(crate) struct ReplayCliRegistry<'a> {
    adapters: Vec<&'a dyn ReplayCliAdapter>,
}

impl<'a> ReplayCliRegistry<'a> {
    pub(crate) fn new(adapters: Vec<&'a dyn ReplayCliAdapter>) -> Self {
        Self { adapters }
    }

    fn adapter(&self, adapter_id: &str) -> Option<&'a dyn ReplayCliAdapter> {
        self.adapters
            .iter()
            .copied()
            .find(|adapter| adapter.adapter_id() == adapter_id)
    }
}

pub(crate) fn run_selected_replay(
    runtime_registry: &RuntimeAdapterRegistry<'_>,
    cli_registry: &ReplayCliRegistry<'_>,
    adapter_id: &str,
    request: &ReplayCliRequest,
    operation: ReplayCliOperation,
    diagnostic_prefix: &str,
) -> Result<Value, Box<dyn Error>> {
    ensure_replay_capability(runtime_registry, adapter_id, diagnostic_prefix)?;
    let adapter = cli_registry.adapter(adapter_id).ok_or_else(|| {
        registry_diagnostic(
            &format!("{diagnostic_prefix}.registry_cli_adapter_not_found"),
            adapter_id,
            "the selected runtime adapter has no CLI descriptor adapter",
            runtime_registry,
        )
    })?;
    let invocation = adapter.invocation(request, operation)?;
    let runtime_request =
        RuntimeRequest::new(&invocation.input_root).with_parameters(invocation.parameters);
    runtime_registry.run(adapter_id, RuntimeOperation::ReplayReview, &runtime_request)
}

pub(crate) fn selected_dispatch_report(
    runtime_registry: &RuntimeAdapterRegistry<'_>,
    cli_registry: &ReplayCliRegistry<'_>,
    adapter_id: &str,
    request: &ReplayCliRequest,
    diagnostic_prefix: &str,
) -> Result<DispatchReport, Box<dyn Error>> {
    ensure_replay_capability(runtime_registry, adapter_id, diagnostic_prefix)?;
    let adapter = cli_registry.adapter(adapter_id).ok_or_else(|| {
        registry_diagnostic(
            &format!("{diagnostic_prefix}.registry_cli_adapter_not_found"),
            adapter_id,
            "the selected runtime adapter has no CLI dispatch-report adapter",
            runtime_registry,
        )
    })?;
    adapter.dispatch_report(request)
}

pub(crate) fn parse_generic_request(
    args: &[String],
    prefix: &str,
) -> Result<(String, ReplayCliRequest), Box<dyn Error>> {
    let adapter_id = required_flag(args, "--engine", prefix)?.to_string();
    let artifact_root = PathBuf::from(required_flag(args, "--artifact-root", prefix)?);
    let launch_descriptor =
        serde_json::from_str::<Value>(required_flag(args, "--launch-descriptor", prefix)?)
            .map_err(|error| format!("{prefix}.launch_descriptor_parse: {error}"))?;
    if !launch_descriptor.is_object() {
        return Err(format!(
            "{prefix}.launch_descriptor_parse: --launch-descriptor must be a JSON object"
        )
        .into());
    }
    Ok((
        adapter_id,
        ReplayCliRequest {
            artifact_root,
            launch_descriptor,
        },
    ))
}

pub(crate) fn default_cli_registry() -> ReplayCliRegistry<'static> {
    static ADAPTER: RealLiveReplayCliAdapter = RealLiveReplayCliAdapter;
    ReplayCliRegistry::new(vec![&ADAPTER])
}

pub(crate) struct RealLiveReplayCliAdapter;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RealLiveLaunchDescriptor {
    scene: u16,
    gameexe_path: PathBuf,
    g00_dir: PathBuf,
}

impl ReplayCliAdapter for RealLiveReplayCliAdapter {
    fn adapter_id(&self) -> &'static str {
        "reallive"
    }

    fn invocation(
        &self,
        request: &ReplayCliRequest,
        operation: ReplayCliOperation,
    ) -> Result<ReplayCliInvocation, Box<dyn Error>> {
        let descriptor = descriptor(&request.launch_descriptor)?;
        let parameters = match operation {
            ReplayCliOperation::Replay => replay_parameters(
                descriptor.scene,
                &descriptor.gameexe_path,
                &descriptor.g00_dir,
            ),
            ReplayCliOperation::ReplayValidate => replay_validate_parameters(
                descriptor.scene,
                &descriptor.gameexe_path,
                &descriptor.g00_dir,
            ),
        };
        Ok(ReplayCliInvocation {
            input_root: seen_path(&request.artifact_root),
            parameters,
        })
    }

    fn dispatch_report(
        &self,
        request: &ReplayCliRequest,
    ) -> Result<DispatchReport, Box<dyn Error>> {
        let descriptor = descriptor(&request.launch_descriptor)?;
        let engine = staged_engine(&seen_path(&request.artifact_root))?;
        let report = dispatch_report_from_engine(&engine, descriptor.scene, &ReplayOpts::default());
        Ok(report)
    }
}

fn descriptor(value: &Value) -> Result<RealLiveLaunchDescriptor, Box<dyn Error>> {
    serde_json::from_value(value.clone())
        .map_err(|error| format!("utsushi.cli.replay.registry.launch_descriptor: {error}").into())
}

fn seen_path(artifact_root: &Path) -> PathBuf {
    artifact_root.join("REALLIVEDATA").join("Seen.txt")
}

fn ensure_replay_capability(
    registry: &RuntimeAdapterRegistry<'_>,
    adapter_id: &str,
    diagnostic_prefix: &str,
) -> Result<(), Box<dyn Error>> {
    let descriptor = registry.adapter(adapter_id).map(RuntimeAdapter::descriptor);
    let Some(descriptor) = descriptor else {
        return Err(registry_diagnostic(
            &format!("{diagnostic_prefix}.registry_adapter_not_found"),
            adapter_id,
            "no runtime adapter is registered for the requested replay engine",
            registry,
        )
        .into());
    };
    if !descriptor.supports(RuntimeCapability::ReplayReview) {
        return Err(registry_diagnostic(
            &format!("{diagnostic_prefix}.registry_capability_unsupported"),
            adapter_id,
            "registered runtime adapter does not support replay_review",
            registry,
        )
        .into());
    }
    Ok(())
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

fn required_flag<'a>(
    args: &'a [String],
    name: &str,
    prefix: &str,
) -> Result<&'a str, Box<dyn Error>> {
    optional_flag(args, name).ok_or_else(|| format!("{prefix}.missing_flag: {name}").into())
}

fn optional_flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

pub(crate) fn require_semantic_path(report: &DispatchReport) -> Result<(), Box<dyn Error>> {
    require_semantic_reached_path(report).map_err(Into::into)
}
