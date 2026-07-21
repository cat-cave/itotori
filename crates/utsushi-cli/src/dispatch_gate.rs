//! Shared opcode/dispatch COVERAGE gate for the RealLive `replay-validate`
//! and `render-validate` CLI surfaces.
//!
//! Both commands drive a scene through the branch-following VM. A scene that
//! references an unimplemented opcode surfaces it at runtime as
//! [`utsushi_reallive::VmWarning::MissingRlop`], folded into
//! [`BranchReplayReport::unknown_opcode_keys`]. Without a gate a rendered
//! frame (or an emitted replay-log) can be produced while that opcode was
//! silently skipped — a bug-hunting agent then sees a "handled" scene that
//! actually has a coverage hole.
//!
//! This module owns the ONE coverage report + strict semantic-path gate the
//! two surfaces share, so `replay-validate` and `render-validate` enforce
//! IDENTICAL coverage semantics and emit the same machine-readable
//! `missingKeys[]` on a gap. Prefer extending this shared gate over
//! re-deriving coverage in either command.

use std::error::Error;
use std::fmt;
use std::fs;
use std::path::Path;

use serde_json::json;
use utsushi_reallive::{
    BranchReplayReport, BranchTerminus, HeadlessChoicePolicy, ReplayEngine, ReplayOpts,
};

/// Stable schema id for the machine-readable dispatch-coverage report.
pub(crate) const DISPATCH_REPORT_SCHEMA_VERSION: &str = "utsushi.cli.replay-dispatch-report/0.2.0";

/// The branch-following dispatch-coverage evidence for one scene: the
/// terminus it reached, whether it fell back to a linear walk, and the
/// sorted `(module_type, module_id, opcode)` tuples that were unimplemented
/// (`missing_keys`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DispatchReport {
    pub(crate) schema_version: String,
    pub(crate) traversal: &'static str,
    pub(crate) policy: &'static str,
    pub(crate) linear_fallback: bool,
    pub(crate) terminus: &'static str,
    pub(crate) missing_count: usize,
    pub(crate) missing_keys: Vec<(u8, u8, u16)>,
}

impl DispatchReport {
    pub(crate) fn from_branch_report(report: &BranchReplayReport) -> Self {
        Self {
            schema_version: DISPATCH_REPORT_SCHEMA_VERSION.to_string(),
            traversal: "branch_following",
            policy: "always_first",
            linear_fallback: false,
            terminus: branch_terminus_kind(&report.terminus),
            missing_count: report.unknown_opcode_keys.len(),
            missing_keys: report.unknown_opcode_keys.clone(),
        }
    }

    /// The dispatch-coverage subset of a command's JSON evidence report, so a
    /// reader always sees the coverage of the scene the command handled — not
    /// just the artifact it produced. Surfaced even when the strict gate is
    /// not requested (honest by default).
    pub(crate) fn to_json(&self) -> serde_json::Value {
        json!({
            "schemaVersion": self.schema_version,
            "traversal": self.traversal,
            "policy": self.policy,
            "linearFallback": self.linear_fallback,
            "terminus": self.terminus,
            "missingCount": self.missing_count,
            "missingKeys": self.missing_keys,
        })
    }
}

/// Drive `scene_id` branch-following on an already-staged engine and fold the
/// result into a [`DispatchReport`]. This is the SAME branch-following pass
/// `render-validate`'s play-order observation runs (and the one
/// `replay-validate` reports on), so the coverage it records is the coverage
/// of the scene the command actually handled.
pub(crate) fn dispatch_report_from_engine(
    engine: &ReplayEngine,
    scene_id: u16,
    opts: &ReplayOpts,
) -> DispatchReport {
    let report = engine.branch_following_report(scene_id, opts, HeadlessChoicePolicy::AlwaysFirst);
    DispatchReport::from_branch_report(&report)
}

fn branch_terminus_kind(terminus: &BranchTerminus) -> &'static str {
    match terminus {
        BranchTerminus::EndOfScene => "end_of_scene",
        BranchTerminus::ReturnedToCaller => "returned_to_caller",
        BranchTerminus::BudgetExhausted => "budget_exhausted",
        BranchTerminus::SceneNotFound(_) => "scene_not_found",
        BranchTerminus::EntrypointNotFound(_, _) => "entrypoint_not_found",
        BranchTerminus::EventGatedSpin { .. } => "event_gated_spin",
        BranchTerminus::OtherFatal(_) => "other_fatal",
    }
}

/// Write the machine-readable dispatch-coverage report (the `missingKeys[]`
/// evidence) to `path`.
pub(crate) fn write_dispatch_report(
    path: &Path,
    report: &DispatchReport,
) -> Result<(), Box<dyn Error>> {
    let json = serde_json::to_string_pretty(&report.to_json())
        .map_err(|err| format!("utsushi.cli.dispatch_gate.dispatch_report_serialise: {err}"))?;
    fs::write(path, json)
        .map_err(|err| format!("utsushi.cli.dispatch_gate.dispatch_report_write: {err}"))?;
    Ok(())
}

/// Strict-gate failure: the scene did NOT reach a fully-semantic, natural
/// terminus (an unimplemented opcode, a linear fallback, or a non-natural
/// terminus). Carries the tuples so the failure is
/// machine-readable, and — deliberately — never the artifact filesystem
/// paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SemanticPathUnavailable {
    report: DispatchReport,
}

impl fmt::Display for SemanticPathUnavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "utsushi.cli.dispatch_gate.semantic_path_unavailable: terminus={} linear_fallback={} missing_count={} missing_keys={:?}",
            self.report.terminus,
            self.report.linear_fallback,
            self.report.missing_count,
            self.report.missing_keys,
        )
    }
}

impl Error for SemanticPathUnavailable {}

/// The strict coverage gate: succeed iff the scene reached a natural terminus
/// through a fully-semantic, branch-following path with NO missing opcodes
/// and NO linear fallback. Otherwise fail with the
/// machine-readable [`SemanticPathUnavailable`] (`missingKeys[]` included).
pub(crate) fn require_semantic_reached_path(
    report: &DispatchReport,
) -> Result<(), Box<SemanticPathUnavailable>> {
    let natural = matches!(report.terminus, "end_of_scene" | "returned_to_caller");
    if natural && !report.linear_fallback && report.missing_keys.is_empty() {
        return Ok(());
    }
    Err(Box::new(SemanticPathUnavailable {
        report: report.clone(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn synthetic_dispatch_report(
        missing_keys: Vec<(u8, u8, u16)>,
        linear_fallback: bool,
    ) -> DispatchReport {
        DispatchReport {
            schema_version: DISPATCH_REPORT_SCHEMA_VERSION.to_string(),
            traversal: "branch_following",
            policy: "always_first",
            linear_fallback,
            terminus: "end_of_scene",
            missing_count: missing_keys.len(),
            missing_keys,
        }
    }

    #[test]
    fn strict_gate_reports_tuples_not_artifact_paths_on_missing_opcode() {
        let report = synthetic_dispatch_report(vec![(2, 3, 4)], false);
        let error = require_semantic_reached_path(&report).expect_err("missing opcode is a gap");
        let message = error.to_string();
        assert!(message.contains("missing_keys=[(2, 3, 4)]"));
        // The gate error is tuple-only: no artifact filesystem path leaks.
        assert!(!message.contains(".json"));
    }

    #[test]
    fn strict_gate_rejects_linear_fallback_without_missing_tuples() {
        let report = synthetic_dispatch_report(Vec::new(), true);
        let error = require_semantic_reached_path(&report).expect_err("linear-only is unavailable");
        assert!(error.to_string().contains("linear_fallback=true"));
    }

    #[test]
    fn strict_gate_passes_on_fully_semantic_natural_terminus() {
        let report = synthetic_dispatch_report(Vec::new(), false);
        assert!(
            require_semantic_reached_path(&report).is_ok(),
            "a natural terminus with no missing/catalog tuples must pass",
        );
    }

    #[test]
    fn dispatch_report_json_carries_missing_keys() {
        let report = synthetic_dispatch_report(vec![(2, 250, 9)], false);
        let json = report.to_json();
        assert_eq!(json["missingCount"], 1);
        assert_eq!(json["missingKeys"][0][0], 2);
        assert_eq!(json["missingKeys"][0][1], 250);
        assert_eq!(json["missingKeys"][0][2], 9);
        assert_eq!(json["schemaVersion"], DISPATCH_REPORT_SCHEMA_VERSION);
    }
}
