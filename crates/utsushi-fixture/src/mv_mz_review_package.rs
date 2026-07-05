//! UTSUSHI-010: export an MV/MZ **review-package manifest** — the capstone
//! that aggregates the just-merged MV/MZ alpha-proof surfaces into a single
//! reviewer-facing evidence manifest.
//!
//! The manifest is an *evidence-surface* document: it NAMES the artifacts that
//! prove an MV/MZ localized run, plus the honest limits of that proof. It does
//! not embed raw copyrighted bytes or pixels — it references artifacts by id,
//! uri, and content hash only. It is deliberately standalone: building it needs
//! NO annotation handling and NO feedback import (see
//! [`build_mv_mz_review_package_manifest`]); it merely names
//! `import_runtime_feedback` among the SUPPORTED review actions a reviewer may
//! later take against the package.
//!
//! ## What it aggregates
//!
//! ```text
//! patch artifacts            KAIFUU PatchExport            -> patchArtifacts[]
//! runtime trace evidence     UTSUSHI-006 observation +     -> runtimeTraceEvidence
//!                            UTSUSHI-033 replay pack
//! screenshot artifact refs   UTSUSHI-065 capture evidence  -> screenshotArtifactRefs
//!                            (WHEN the host can capture)
//! ```
//!
//! Every surface the manifest names is one of the freshly-merged MV/MZ proof
//! surfaces:
//! - **Patch artifacts** — the KAIFUU MV/MZ patch-back output ([`PatchExport`]),
//!   named by `patchExportId`, locales, entry count, and a content hash.
//! - **Runtime trace evidence** — the UTSUSHI-006 observation-hook trace events
//!   embedded in the runtime evidence report, and the UTSUSHI-033 message +
//!   choice **replay pack** trace, named by counts.
//! - **Screenshot artifact refs** — the UTSUSHI-065 screenshot captures, whose
//!   `artifactRef`s (id + uri + hash-bearing coordinates) are surfaced **only
//!   when the host can produce them**.
//!
//! ## Honest host diagnostics
//!
//! Screenshot (and thus browser) evidence is host-gated: a host with no
//! Chromium / no screenshot support cannot produce it. When that evidence is
//! unavailable the manifest does NOT silently omit it — it records the
//! screenshot section with `availability: "unavailable"`, a human-readable
//! reason, a machine-readable **semantic diagnostic** in the
//! `utsushi.review_package.*` namespace, and a matching limitation. A run that
//! *claims* screenshot capability but produced no captures is a contradiction
//! that surfaces as an `error`-severity diagnostic — it cannot pass silently.
//!
//! [`PatchExport`]: https://example.invalid/kaifuu-core

use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use utsushi_core::UtsushiResult;

use crate::mv_mz_screenshot_evidence::deterministic_uuid7;

/// Schema version of the review-package manifest wire shape.
pub const REVIEW_PACKAGE_MANIFEST_SCHEMA_VERSION: &str = "0.1.0";

/// Kind discriminant stamped on every manifest.
pub const REVIEW_PACKAGE_MANIFEST_KIND: &str = "utsushi.mvmz.review_package_manifest";

/// Namespace the manifest mints its deterministic ids under.
const REVIEW_PACKAGE_UUID_NAMESPACE: &str = "utsushi-u010:mvmz-review-package";

/// Fallback creation timestamp used when the runtime evidence report carries
/// none. Deterministic so the manifest bytes stay stable in goldens.
const FALLBACK_CREATED_AT: &str = "2026-06-17T00:00:00.000Z";

/// The review actions this manifest advertises as supported against an MV/MZ
/// runtime-evidence review package. This is a NAMING surface only: the manifest
/// records that these actions are available to a reviewer, and does not itself
/// execute any of them (in particular naming `import_runtime_feedback` does not
/// couple manifest export to feedback import). The values mirror the itotori
/// reviewer-queue action vocabulary (`reviewerQueueActionValues`).
const SUPPORTED_REVIEW_ACTIONS: &[(&str, &str)] = &[
    ("approve", "Approve"),
    ("reject", "Reject"),
    ("defer", "Defer"),
    ("escalate", "Escalate"),
    ("request_repair", "Request repair"),
    ("import_runtime_feedback", "Import runtime feedback"),
];

/// Host capabilities that gate what runtime evidence a real run could produce.
///
/// A supported MV/MZ alpha host provides a Chromium-compatible browser and can
/// capture screenshots; a host missing either cannot produce screenshot
/// evidence, and the manifest records that honestly rather than omitting the
/// surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostCapabilities {
    /// Whether a Chromium-compatible browser is available on the host.
    pub browser_available: bool,
    /// Whether the host can capture screenshots (requires a browser).
    pub screenshot_capture: bool,
}

impl HostCapabilities {
    /// A fully-supported alpha host: browser present, screenshots capturable.
    pub fn supported() -> Self {
        Self {
            browser_available: true,
            screenshot_capture: true,
        }
    }

    fn to_json(self) -> Value {
        json!({
            "browserAvailable": self.browser_available,
            "screenshotCapture": self.screenshot_capture,
        })
    }
}

/// The evidence surfaces aggregated into one review-package manifest.
///
/// These are exactly the freshly-merged MV/MZ proof surfaces — a patch
/// artifact, a runtime evidence report (UTSUSHI-006 traces + UTSUSHI-065
/// captures), and an optional UTSUSHI-033 replay-pack trace — plus the host
/// capabilities. There is deliberately NO annotation or feedback-import input.
pub struct ReviewPackageInputs<'a> {
    /// A KAIFUU MV/MZ `PatchExport` document (the patch-back output).
    pub patch_export: &'a Value,
    /// A UTSUSHI-065 runtime evidence report: it embeds the UTSUSHI-006
    /// observation-hook trace events and the screenshot captures.
    pub runtime_evidence_report: &'a Value,
    /// An optional UTSUSHI-033 replay-pack trace (`PackOutcome::to_trace_json`).
    pub replay_pack_trace: Option<&'a Value>,
    /// The host capabilities gating screenshot/browser evidence availability.
    pub host: HostCapabilities,
}

/// A semantic diagnostic — a machine-readable, non-silent record that a piece of
/// evidence is or isn't available. Collected while building the manifest.
struct Diagnostic {
    semantic_code: &'static str,
    severity: &'static str,
    surface: &'static str,
    message: String,
}

impl Diagnostic {
    fn to_json(&self) -> Value {
        json!({
            "semanticCode": self.semantic_code,
            "severity": self.severity,
            "surface": self.surface,
            "message": self.message,
            // A review-package diagnostic is always semantic: it can never be a
            // silent omission of a missing evidence surface.
            "semantic": true,
        })
    }
}

/// Build the MV/MZ review-package manifest from its evidence surfaces.
///
/// The manifest names, in order: **patch artifacts**, **runtime trace
/// evidence** (UTSUSHI-006 observation + UTSUSHI-033 replay pack), **screenshot
/// artifact refs** (when the host can produce them), **limitations**, and
/// **supported review actions**. Unsupported host capabilities become semantic
/// diagnostics + recorded limitations, never silent omissions.
///
/// This function takes only evidence surfaces — no annotation handling and no
/// feedback import — so a manifest can always be exported standalone.
pub fn build_mv_mz_review_package_manifest(inputs: &ReviewPackageInputs) -> UtsushiResult<Value> {
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let mut limitations: Vec<String> = Vec::new();

    let patch_artifact = patch_artifact_ref(inputs.patch_export)?;
    let patch_export_id = patch_artifact["patchExportId"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let source_locale = patch_artifact["sourceLocale"]
        .as_str()
        .unwrap_or("und")
        .to_string();
    let target_locale = patch_artifact["targetLocale"]
        .as_str()
        .unwrap_or("und")
        .to_string();

    let report = inputs.runtime_evidence_report;
    let runtime_report_id = report
        .get("runtimeReportId")
        .and_then(Value::as_str)
        .ok_or("runtime evidence report missing runtimeReportId")?;
    let created_at = report
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or(FALLBACK_CREATED_AT);

    let runtime_trace_evidence = runtime_trace_evidence_section(
        report,
        inputs.replay_pack_trace,
        &mut diagnostics,
        &mut limitations,
    );

    let screenshot_section =
        screenshot_artifact_refs_section(report, inputs.host, &mut diagnostics, &mut limitations)?;

    // Carry the runtime report's own limitations through — the manifest does
    // not hide the narrow-evidence caveats the report already declared.
    if let Some(report_limitations) = report.get("limitations").and_then(Value::as_array) {
        for limitation in report_limitations {
            if let Some(text) = limitation.as_str() {
                limitations.push(text.to_string());
            }
        }
    }
    limitations.push(
        "Review-package manifest is an evidence-surface index: it names patch, trace, and \
         screenshot artifacts by id/uri/hash and does not embed raw game bytes or pixels."
            .to_string(),
    );

    let supported_review_actions: Vec<Value> = SUPPORTED_REVIEW_ACTIONS
        .iter()
        .map(|(action, label)| json!({ "action": action, "label": label }))
        .collect();

    let review_package_id = deterministic_uuid7(
        REVIEW_PACKAGE_UUID_NAMESPACE,
        &format!("manifest-{patch_export_id}-{runtime_report_id}"),
    );

    let diagnostics_json: Vec<Value> = diagnostics.iter().map(Diagnostic::to_json).collect();

    Ok(json!({
        "schemaVersion": REVIEW_PACKAGE_MANIFEST_SCHEMA_VERSION,
        "manifestKind": REVIEW_PACKAGE_MANIFEST_KIND,
        "reviewPackageId": review_package_id,
        "engine": "rpg_maker_mv_mz",
        "createdAt": created_at,
        "sourceLocale": source_locale,
        "targetLocale": target_locale,
        "host": inputs.host.to_json(),
        "patchArtifacts": [patch_artifact],
        "runtimeTraceEvidence": runtime_trace_evidence,
        "screenshotArtifactRefs": screenshot_section,
        "supportedReviewActions": supported_review_actions,
        "limitations": limitations,
        "diagnostics": diagnostics_json,
    }))
}

/// Name a KAIFUU MV/MZ patch artifact: its export id, locales, entry count, and
/// a content hash over the canonical patch bytes. The hash lets a reviewer
/// verify the referenced patch without the manifest embedding its contents.
fn patch_artifact_ref(patch_export: &Value) -> UtsushiResult<Value> {
    let patch_export_id = patch_export
        .get("patchExportId")
        .and_then(Value::as_str)
        .ok_or("patch export missing patchExportId")?;
    let source_locale = patch_export
        .get("sourceLocale")
        .and_then(Value::as_str)
        .ok_or("patch export missing sourceLocale")?;
    let target_locale = patch_export
        .get("targetLocale")
        .and_then(Value::as_str)
        .ok_or("patch export missing targetLocale")?;
    let entries = patch_export
        .get("entries")
        .and_then(Value::as_array)
        .ok_or("patch export missing entries array")?;

    // serde_json `Value` maps are sorted, so the canonical serialization — and
    // therefore the hash — is deterministic across runs.
    let canonical = serde_json::to_vec(patch_export)?;
    let content_hash = sha256_hex(&canonical);

    Ok(json!({
        "artifactKind": "kaifuu_patch_export",
        "patchExportId": patch_export_id,
        "sourceLocale": source_locale,
        "targetLocale": target_locale,
        "entryCount": entries.len(),
        "contentHash": format!("sha256:{content_hash}"),
    }))
}

/// Build the runtime-trace-evidence section: the UTSUSHI-006 observation-hook
/// trace events embedded in the report, plus the UTSUSHI-033 replay-pack trace
/// when one was supplied. A missing replay pack is recorded honestly (a
/// diagnostic + `available: false`), never silently dropped.
fn runtime_trace_evidence_section(
    report: &Value,
    replay_pack_trace: Option<&Value>,
    diagnostics: &mut Vec<Diagnostic>,
    limitations: &mut Vec<String>,
) -> Value {
    let runtime_report_id = report
        .get("runtimeReportId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let evidence_tier = report
        .get("evidenceTier")
        .and_then(Value::as_str)
        .unwrap_or("E1");
    let trace_event_count = report
        .get("traceEvents")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let observation_event_count = report
        .get("observationHookEvents")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);

    let replay_pack = if let Some(trace) = replay_pack_trace {
        let linked_event_count = trace
            .get("linkedEvents")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let diagnostic_count = trace
            .get("diagnostics")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let observation_source = trace
            .get("observationSource")
            .and_then(Value::as_str)
            .unwrap_or("static_replay");
        json!({
            "source": "UTSUSHI-033",
            "available": true,
            "observationSource": observation_source,
            "linkedEventCount": linked_event_count,
            "diagnosticCount": diagnostic_count,
        })
    } else {
        diagnostics.push(Diagnostic {
            semantic_code: "utsushi.review_package.replay_pack_absent",
            severity: "warning",
            surface: "runtime_trace_evidence.replay_pack",
            message: "No UTSUSHI-033 replay-pack trace was supplied; runtime trace evidence \
                      is limited to the UTSUSHI-006 observation-hook trace events."
                .to_string(),
        });
        limitations.push(
            "No UTSUSHI-033 replay-pack trace attached; message + choice replay evidence is \
             absent from this package."
                .to_string(),
        );
        json!({
            "source": "UTSUSHI-033",
            "available": false,
        })
    };

    json!({
        "runtimeReportId": runtime_report_id,
        "evidenceTier": evidence_tier,
        "observation": {
            "source": "UTSUSHI-006",
            "traceEventCount": trace_event_count,
            "observationHookEventCount": observation_event_count,
        },
        "replayPack": replay_pack,
    })
}

/// Build the screenshot-artifact-refs section from the UTSUSHI-065 captures in
/// the report, gated by host capability.
///
/// The refs are surfaced ONLY when the host can produce them (browser present,
/// screenshot capture supported, and captures actually present). Otherwise the
/// section records `availability: "unavailable"` with a reason, and a semantic
/// diagnostic + limitation are pushed — the manifest never silently omits the
/// screenshot surface.
fn screenshot_artifact_refs_section(
    report: &Value,
    host: HostCapabilities,
    diagnostics: &mut Vec<Diagnostic>,
    limitations: &mut Vec<String>,
) -> UtsushiResult<Value> {
    let captures = report
        .get("captures")
        .and_then(Value::as_array)
        .ok_or("runtime evidence report missing captures array")?;

    // Extract the screenshot refs the report links to its trace events. Each ref
    // carries the artifact id/uri (hash-bearing coordinates) plus the linkage
    // keys (bridgeUnitRef + frame + evidencesTraceEventId) so a reviewer can
    // trace screenshot -> trace event -> source command.
    let refs: Vec<Value> = captures
        .iter()
        .map(|capture| {
            json!({
                "artifactRef": capture.get("artifactRef").cloned().unwrap_or(Value::Null),
                "bridgeUnitRef": capture.get("bridgeUnitRef").cloned().unwrap_or(Value::Null),
                "frame": capture.get("frame").cloned().unwrap_or(Value::Null),
                "evidencesTraceEventId": capture
                    .get("evidencesTraceEventId")
                    .cloned()
                    .unwrap_or(Value::Null),
            })
        })
        .collect();

    if !host.browser_available {
        let reason = "Host has no Chromium-compatible browser available; MV/MZ screenshot evidence \
             cannot be captured.";
        diagnostics.push(Diagnostic {
            semantic_code: "utsushi.review_package.browser_unavailable",
            severity: "warning",
            surface: "screenshot_artifact_refs",
            message: reason.to_string(),
        });
        limitations.push(format!("Screenshot evidence unavailable: {reason}"));
        return Ok(json!({
            "availability": "unavailable",
            "reason": reason,
            "refs": [],
        }));
    }

    if !host.screenshot_capture {
        let reason = "Host browser does not support screenshot capture; MV/MZ screenshot \
                      evidence is unavailable for this package.";
        diagnostics.push(Diagnostic {
            semantic_code: "utsushi.review_package.screenshot_capture_unsupported",
            severity: "warning",
            surface: "screenshot_artifact_refs",
            message: reason.to_string(),
        });
        limitations.push(format!("Screenshot evidence unavailable: {reason}"));
        return Ok(json!({
            "availability": "unavailable",
            "reason": reason,
            "refs": [],
        }));
    }

    if refs.is_empty() {
        // The host CLAIMS screenshot capture but the report carries no captures.
        // That contradiction must not silently pass — it is an error-severity
        // semantic diagnostic.
        let reason = "Host advertises screenshot capture but the runtime evidence report \
                      contains no screenshot captures.";
        diagnostics.push(Diagnostic {
            semantic_code: "utsushi.review_package.screenshot_evidence_missing",
            severity: "error",
            surface: "screenshot_artifact_refs",
            message: reason.to_string(),
        });
        limitations.push(format!("Screenshot evidence expected but absent: {reason}"));
        return Ok(json!({
            "availability": "unavailable",
            "reason": reason,
            "refs": [],
        }));
    }

    Ok(json!({
        "availability": "available",
        "refs": refs,
    }))
}

/// Read the review-package inputs from files and build the manifest.
///
/// This is the IO shell the CLI uses: it reads the KAIFUU patch export, the
/// UTSUSHI-065 runtime evidence report, and the optional UTSUSHI-033 replay-pack
/// trace, then delegates to the pure [`build_mv_mz_review_package_manifest`].
pub fn mv_mz_review_package_manifest_from_paths(
    patch_export_path: &Path,
    runtime_evidence_path: &Path,
    replay_pack_trace_path: Option<&Path>,
    host: HostCapabilities,
) -> UtsushiResult<Value> {
    let patch_export: Value = serde_json::from_str(&fs::read_to_string(patch_export_path)?)?;
    let runtime_evidence_report: Value =
        serde_json::from_str(&fs::read_to_string(runtime_evidence_path)?)?;
    let replay_pack_trace: Option<Value> = match replay_pack_trace_path {
        Some(path) => Some(serde_json::from_str(&fs::read_to_string(path)?)?),
        None => None,
    };

    build_mv_mz_review_package_manifest(&ReviewPackageInputs {
        patch_export: &patch_export,
        runtime_evidence_report: &runtime_evidence_report,
        replay_pack_trace: replay_pack_trace.as_ref(),
        host,
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().fold(String::new(), |mut acc, byte| {
        let _ = write!(acc, "{byte:02x}");
        acc
    })
}
