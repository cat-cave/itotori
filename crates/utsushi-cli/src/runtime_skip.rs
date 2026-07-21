//! Explicit recipe-level acknowledgements for intentionally unavailable
//! runtime capabilities.
//!
//! Adapters remain authoritative about whether their host capability is
//! available. This module only records an operator's explicit decision not to
//! invoke a browser-backed runtime surface, so that decision cannot be
//! confused with a successful runtime probe or evidence-producing smoke run.

use std::path::Path;

use serde_json::{Value, json};
use utsushi_core::{
    RuntimeAdapterDescriptor, RuntimeAdapterDiagnostic, RuntimeAdapterRegistry, RuntimeOperation,
    write_json,
};

pub(crate) const BROWSER_SKIP_FLAG: &str = "--skip-browser";

/// The `--skip-browser` flag is only legal on surfaces that can produce a
/// typed skip report without exercising the browser (currently
/// `capabilities` and `smoke`). Other runtime operations (`trace`,
/// `capture`) reject it as unknown so an alpha evidence path cannot
/// silently lose its probe.
pub(crate) fn browser_skip_flag_for(operation: RuntimeOperation) -> &'static [&'static str] {
    match operation {
        RuntimeOperation::SmokeValidation => &[BROWSER_SKIP_FLAG],
        _ => &[],
    }
}

const BROWSER_HOST_AVAILABILITY_DIAGNOSTIC: &str = "browser_host_availability";
const BROWSER_LAUNCH_CAPABILITY: &str = "browser_launch";
const SKIP_ACKNOWLEDGED_DIAGNOSTIC: &str = "runtime_skip_acknowledged";
const SKIP_ACKNOWLEDGED_ERROR_CODE: &str = "utsushi.runtime.skip_acknowledged";

/// Detect a bare boolean flag in argv. Exposed so the dispatch sites can
/// short-circuit before invoking the browser adapter; there is no
/// environment-variable equivalent, by design (the brief requires the skip
/// to be explicit).
pub(crate) fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|arg| arg == name)
}

/// Whether an adapter registry descriptor advertises the browser-launch
/// capability. The recipe layer uses adapter metadata rather than adapter
/// names, leaving engine selection and registration inside the registry.
pub(crate) fn supports_browser_launch_skip(descriptor: &RuntimeAdapterDescriptor) -> bool {
    descriptor.diagnostics.iter().any(|diagnostic| {
        diagnostic.diagnostic_kind == BROWSER_HOST_AVAILABILITY_DIAGNOSTIC
            && diagnostic.details.iter().any(|(key, value)| {
                key == "capability" && value.as_str() == Some(BROWSER_LAUNCH_CAPABILITY)
            })
    })
}

/// Names of every currently-registered adapter that advertises the
/// browser-launch capability. Empty when the host has no browser-backed
/// runtime surface registered at all, in which case `--skip-browser` is a
/// typed error rather than a silent no-op.
pub(crate) fn browser_launch_adapter_names(registry: &RuntimeAdapterRegistry<'_>) -> Vec<String> {
    registry
        .descriptors()
        .iter()
        .filter(|descriptor| supports_browser_launch_skip(descriptor))
        .map(|descriptor| descriptor.name.clone())
        .collect()
}

/// A typed acknowledgement that records the explicit browser skip and the
/// affected registered adapters. It is intentionally a warning, not a rewrite
/// of the adapter's own host-availability severity.
pub(crate) fn browser_skip_acknowledged_diagnostic(
    surface: &str,
    adapter_names: Vec<String>,
) -> RuntimeAdapterDiagnostic {
    RuntimeAdapterDiagnostic::new(
        SKIP_ACKNOWLEDGED_DIAGNOSTIC,
        "skipped",
        "warning",
        "Browser-backed runtime work was explicitly skipped by this recipe; no browser runtime evidence was produced.",
    )
    .with_detail("errorCode", SKIP_ACKNOWLEDGED_ERROR_CODE)
    .with_detail("skipFlag", BROWSER_SKIP_FLAG)
    .with_detail("capability", BROWSER_LAUNCH_CAPABILITY)
    .with_detail("surface", surface)
    .with_detail_value("affectedAdapters", json!(adapter_names))
    .with_detail_value("alphaEvidenceEstablished", json!(false))
}

/// Augment a capabilities-report envelope with the recipe-level skip
/// acknowledgement. The base report is preserved verbatim; the skip adds
/// top-level `status`, `diagnostics`, and `alphaEvidence` markers so a
/// downstream consumer cannot mistake the report for a successful probe.
///
/// Returns the base report unchanged when `skip_browser` is false. Returns a
/// typed error when the skip is requested but the registry has no
/// browser-backed adapter to skip — the recipe layer refuses to silently
/// degrade.
pub(crate) fn augment_capabilities_with_skip(
    mut base_report: Value,
    skip_browser: bool,
    skipped_adapter_names: Vec<String>,
) -> Result<Value, Box<dyn std::error::Error>> {
    if !skip_browser {
        return Ok(base_report);
    }
    if skipped_adapter_names.is_empty() {
        return Err(format!(
            "{BROWSER_SKIP_FLAG} requires a registered adapter that advertises browser_launch"
        )
        .into());
    }
    base_report["status"] = json!("browser_runtime_skipped");
    base_report["diagnostics"] =
        json!([
            browser_skip_acknowledged_diagnostic("capabilities", skipped_adapter_names,).to_json()
        ]);
    base_report["alphaEvidence"] = json!({
        "status": "not_established",
        "reason": SKIP_ACKNOWLEDGED_DIAGNOSTIC,
    });
    Ok(base_report)
}

/// If `--skip-browser` is present for a `trace`/`capture`/`smoke` invocation,
/// resolve the targeted adapter, validate that it advertises browser_launch,
/// write the typed skip report, and signal that the dispatch is complete.
/// Returns `Ok(true)` when the skip report was written, `Ok(false)` when no
/// skip was requested (and the normal dispatch should proceed), or a typed
/// error when the skip is requested against an adapter that does not
/// advertise browser_launch.
pub(crate) fn try_write_runtime_skip_report(
    args: &[String],
    registry: &RuntimeAdapterRegistry<'_>,
    selected_adapter_name: &str,
    output: &Path,
) -> Result<bool, Box<dyn std::error::Error>> {
    if !has_flag(args, BROWSER_SKIP_FLAG) {
        return Ok(false);
    }
    let descriptor = registry
        .descriptors()
        .into_iter()
        .find(|descriptor| descriptor.name == selected_adapter_name)
        .ok_or_else(|| format!("runtime adapter not registered: {selected_adapter_name}"))?;
    if !supports_browser_launch_skip(&descriptor) {
        return Err(format!(
            "{} requires an adapter that advertises browser_launch; adapter {} does not",
            BROWSER_SKIP_FLAG, descriptor.name,
        )
        .into());
    }
    write_json(output, &skipped_browser_smoke_report(descriptor))?;
    Ok(true)
}

/// A smoke-shaped report for an intentionally skipped browser adapter. Its
/// status is deliberately not `passed`, and its alpha evidence state is
/// explicit so a downstream recipe cannot mistake the report for a runtime
/// observation.
fn skipped_browser_smoke_report(descriptor: RuntimeAdapterDescriptor) -> Value {
    let diagnostic = browser_skip_acknowledged_diagnostic(
        RuntimeOperation::SmokeValidation.as_str(),
        vec![descriptor.name.clone()],
    );

    json!({
        "schemaVersion": "0.2.0",
        "adapterName": descriptor.name,
        "adapterVersion": descriptor.version,
        "operation": RuntimeOperation::SmokeValidation.as_str(),
        "status": "skipped",
        "runtimeCapabilities": descriptor.capability_contract.to_json(),
        "diagnostics": [diagnostic.to_json()],
        "alphaEvidence": {
            "status": "not_established",
            "reason": SKIP_ACKNOWLEDGED_DIAGNOSTIC,
        },
        "limitations": [
            "Browser-backed smoke validation was explicitly skipped; this report does not establish browser runtime evidence or support an alpha claim."
        ]
    })
}
