//! MV/MZ branch-coverage GAP FINDING emitter ().
//!
//! A DATA-ONLY job that reads the
//! [`BranchCoverageReadModel`](super::branch_coverage::BranchCoverageReadModel)
//! and emits machine-readable **gap findings**. It is the emitter half of the
//! branch-coverage surface: the branch explorer *browses* the read
//! model as a paginated dashboard; this module instead *judges* it and names
//! the branches that represent real coverage gaps.
//!
//! This module NEVER launches a runtime host, browses a dashboard, or formats
//! an export/report document. It only reshapes the already-derived per-branch
//! coverage view into findings. Its only dependency is `serde`.
//!
//! # What counts as a gap
//!
//! The read model derives a [`CoverageStatus`] per branch. Exactly two of the
//! four states are coverage gaps:
//!
//! coverage status | reachable text | gap? | gap kind
//! ----------------------------------- | -------------- | ----- | --------------------
//! `Unvisited` | `> 0` | YES | `unvisited_reachable`
//! `Unvisited` | `0` | no | —
//! `Ambiguous` | any | YES | `ambiguous_route`
//! `Visited` | any | no | —
//! `Unreachable` | any | no | —
//!
//! - **`Visited`** branches are already covered — not a gap.
//! - **`Unreachable`** branches are legitimately unreachable (no route map
//!   reaches them and they were never observed) — *not* a gap. Emitting a
//!   finding for them would be a false positive, so they are explicitly
//!   excluded.
//! - An **`Unvisited`** branch is a gap ONLY when it exposes reachable text
//!   (`reachable_text_count > 0`): a reachable branch that carries no
//!   translatable text is nothing to cover.
//! - An **`Ambiguous`** branch is always a gap: its route evidence cannot be
//!   uniquely attributed (a dangling route target, or a key resolving to more
//!   than one route map), so coverage cannot be proven either way.

use serde::{Deserialize, Serialize};

use super::branch_coverage::{BranchCoverageReadModel, BranchCoverageRecord, CoverageStatus};

/// Stable schema id for the serialized gap-findings report + findings.
pub const BRANCH_COVERAGE_GAP_FINDINGS_SCHEMA_VERSION: &str = "utsushi.branch_coverage_gaps.v0.1";

/// The kind of coverage gap a finding names. DERIVED from the branch's
/// [`CoverageStatus`]; only the two gap-bearing states have a kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GapKind {
    /// A branch reachable through exactly one route map, exposing reachable
    /// text, that was never observed at runtime (`Unvisited`
    /// `reachable_text_count > 0`).
    UnvisitedReachable,
    /// A branch whose route evidence cannot be uniquely attributed
    /// (`Ambiguous`): a dangling route target or a key resolving to several
    /// route maps.
    AmbiguousRoute,
}

impl GapKind {
    /// Stable snake_case wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnvisitedReachable => "unvisited_reachable",
            Self::AmbiguousRoute => "ambiguous_route",
        }
    }
}

/// Deterministic gap severity. Higher variants are more urgent.
///
/// The ordering derives from `#[derive(PartialOrd, Ord)]` over the declaration
/// order below (`Low < Medium < High`), so it can be compared and sorted
/// directly.
///
/// See [`severity_for`] for the exact assignment rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GapSeverity {
    /// An ambiguous-route gap: a data-quality problem in the route evidence
    /// but not proof of missing coverage.
    Low,
    /// An unvisited-reachable gap that exposes a small amount of reachable
    /// text (below [`HIGH_TEXT_SEVERITY_THRESHOLD`]).
    Medium,
    /// An unvisited-reachable gap that exposes a large amount of reachable
    /// text (>= [`HIGH_TEXT_SEVERITY_THRESHOLD`]): the biggest blind spots.
    High,
}

impl GapSeverity {
    /// Stable snake_case wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

/// Reachable-text count at or above which an unvisited-reachable gap is
/// promoted from [`GapSeverity::Medium`] to [`GapSeverity::High`].
///
/// Chosen so a branch hiding a substantial block of untranslated text ranks
/// above one hiding a stray line. Deterministic and documented; changing it is
/// a schema-visible policy change.
pub const HIGH_TEXT_SEVERITY_THRESHOLD: u32 = 10;

/// Assign the deterministic severity for a gap.
///
/// The rule, in full:
///
/// - `unvisited_reachable` with `reachable_text_count >=`
///   [`HIGH_TEXT_SEVERITY_THRESHOLD`] → [`GapSeverity::High`].
/// - `unvisited_reachable` with a smaller (but non-zero) reachable-text count
///   → [`GapSeverity::Medium`].
/// - `ambiguous_route` → [`GapSeverity::Low`].
///
/// This satisfies the acceptance ordering "an unvisited-reachable gap with a
/// high text count outranks an ambiguous gap" (`High > Low`), and it further
/// ranks *every* unvisited-reachable gap above every ambiguous one
/// (`High, Medium > Low`), reflecting that a proven-missing branch is a
/// stronger signal than merely ambiguous route evidence.
pub fn severity_for(kind: GapKind, reachable_text_count: u32) -> GapSeverity {
    match kind {
        GapKind::UnvisitedReachable => {
            if reachable_text_count >= HIGH_TEXT_SEVERITY_THRESHOLD {
                GapSeverity::High
            } else {
                GapSeverity::Medium
            }
        }
        GapKind::AmbiguousRoute => GapSeverity::Low,
    }
}

/// A managed artifact-store link named by a gap finding.
///
/// Mirrors the branch-explorer artifact links so the two surfaces
/// point at the same managed `/artifact-store/` mount: one `runtime-trace`
/// link per observed trace id, one `route-map` link per route-map id. The
/// `uri` is a managed-mount relative path — never a raw filesystem / `file:`
/// URL.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GapArtifactLink {
    /// Link relation: `runtime-trace` or `route-map`.
    pub rel: String,
    /// The trace id or route-map id the link resolves.
    pub ref_id: String,
    /// Managed artifact-store relative URI.
    pub uri: String,
}

/// One emitted gap finding.
///
/// Names every field the acceptance requires: the branch id, the route-map
/// ids, the observed trace ids, the coverage status, the derived gap kind and
/// severity, and the derived artifact links.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCoverageGapFinding {
    /// Stable, deterministic finding id: `branch-coverage-gap:{kind}:{branch}`.
    pub finding_id: String,
    /// The branch this finding is about.
    pub branch_id: String,
    /// The route key the branch leads to, if any (mirrors the record).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_key: Option<String>,
    /// The route-map ids the branch resolved to (0, 1, or many).
    pub route_map_ids: Vec<String>,
    /// Observed runtime trace event ids on this branch.
    pub observed_trace_ids: Vec<String>,
    /// Reachable runtime-visible text count on the branch.
    pub reachable_text_count: u32,
    /// The branch's derived coverage status.
    pub coverage_status: CoverageStatus,
    /// The kind of gap this finding names.
    pub gap_kind: GapKind,
    /// The deterministic severity.
    pub severity: GapSeverity,
    /// Managed artifact-store links (trace + route-map).
    pub artifact_links: Vec<GapArtifactLink>,
}

/// Per-kind / per-severity aggregate counts for a gap-findings report.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCoverageGapSummary {
    /// Total findings emitted.
    pub gap_count: u32,
    /// Findings with kind `unvisited_reachable`.
    pub unvisited_reachable: u32,
    /// Findings with kind `ambiguous_route`.
    pub ambiguous_route: u32,
    /// Findings at `high` severity.
    pub high_severity: u32,
    /// Findings at `medium` severity.
    pub medium_severity: u32,
    /// Findings at `low` severity.
    pub low_severity: u32,
    /// Sum of `reachable_text_count` over `unvisited_reachable` gaps — the
    /// reachable text that is provably uncovered.
    pub uncovered_reachable_text: u32,
}

/// The emitted gap-findings report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCoverageGapReport {
    pub schema_version: String,
    pub adapter_id: String,
    /// Findings, sorted deterministically by `branch_id` (one finding per
    /// branch at most, since each record has exactly one coverage status).
    pub findings: Vec<BranchCoverageGapFinding>,
    pub summary: BranchCoverageGapSummary,
}

/// Classify a single coverage record into a gap kind, or `None` when the
/// branch is not a gap (`Visited`, `Unreachable`, or `Unvisited` with no
/// reachable text).
fn gap_kind_for(record: &BranchCoverageRecord) -> Option<GapKind> {
    match record.coverage_status {
        // Unvisited is a gap only when it actually exposes reachable text; an
        // unvisited branch with no reachable text is nothing to cover.
        CoverageStatus::Unvisited if record.reachable_text_count > 0 => {
            Some(GapKind::UnvisitedReachable)
        }
        // Ambiguous route evidence is always a gap.
        CoverageStatus::Ambiguous => Some(GapKind::AmbiguousRoute),
        // Everything else is NOT a gap: `Visited` (already covered)
        // `Unreachable` (legitimately unreachable — emitting a finding would
        // be a false positive), and `Unvisited` with no reachable text.
        CoverageStatus::Unvisited | CoverageStatus::Visited | CoverageStatus::Unreachable => None,
    }
}

/// Derive the managed artifact-store links for a record: one `runtime-trace`
/// link per observed trace id, one `route-map` link per route-map id. Pure and
/// deterministic; mirrors the branch-explorer path scheme.
fn derive_artifact_links(adapter_id: &str, record: &BranchCoverageRecord) -> Vec<GapArtifactLink> {
    let base = format!("/artifact-store/artifacts/utsushi/branch-coverage/{adapter_id}");
    let mut links =
        Vec::with_capacity(record.observed_trace_ids.len() + record.route_map_ids.len());
    for trace_id in &record.observed_trace_ids {
        links.push(GapArtifactLink {
            rel: "runtime-trace".to_string(),
            ref_id: trace_id.clone(),
            uri: format!("{base}/traces/{trace_id}.json"),
        });
    }
    for route_map_id in &record.route_map_ids {
        links.push(GapArtifactLink {
            rel: "route-map".to_string(),
            ref_id: route_map_id.clone(),
            uri: format!("{base}/route-maps/{route_map_id}.json"),
        });
    }
    links
}

/// Emit gap findings from a branch-coverage read model.
///
/// Walks the read model's records (already sorted by `branch_id`), keeps only
/// the two gap-bearing states, and produces one [`BranchCoverageGapFinding`]
/// per gap with its derived kind, severity, and artifact links. `Visited` and
/// `Unreachable` branches (and `Unvisited` branches with no reachable text)
/// produce NO finding. Pure — the same read model always yields the same
/// report.
pub fn emit_branch_coverage_gap_findings(
    model: &BranchCoverageReadModel,
) -> BranchCoverageGapReport {
    let mut findings: Vec<BranchCoverageGapFinding> = Vec::new();
    let mut summary = BranchCoverageGapSummary::default();

    for record in &model.records {
        let Some(gap_kind) = gap_kind_for(record) else {
            continue;
        };
        let severity = severity_for(gap_kind, record.reachable_text_count);

        summary.gap_count += 1;
        match gap_kind {
            GapKind::UnvisitedReachable => {
                summary.unvisited_reachable += 1;
                summary.uncovered_reachable_text = summary
                    .uncovered_reachable_text
                    .saturating_add(record.reachable_text_count);
            }
            GapKind::AmbiguousRoute => summary.ambiguous_route += 1,
        }
        match severity {
            GapSeverity::High => summary.high_severity += 1,
            GapSeverity::Medium => summary.medium_severity += 1,
            GapSeverity::Low => summary.low_severity += 1,
        }

        findings.push(BranchCoverageGapFinding {
            finding_id: format!(
                "branch-coverage-gap:{}:{}",
                gap_kind.as_str(),
                record.branch_id
            ),
            branch_id: record.branch_id.clone(),
            route_key: record.route_key.clone(),
            route_map_ids: record.route_map_ids.clone(),
            observed_trace_ids: record.observed_trace_ids.clone(),
            reachable_text_count: record.reachable_text_count,
            coverage_status: record.coverage_status,
            gap_kind,
            severity,
            artifact_links: derive_artifact_links(&model.adapter_id, record),
        });
    }

    // Records arrive sorted by branch_id; keep that order so findings are
    // deterministic regardless of input ordering upstream.
    findings.sort_by(|a, b| a.branch_id.cmp(&b.branch_id));

    BranchCoverageGapReport {
        schema_version: BRANCH_COVERAGE_GAP_FINDINGS_SCHEMA_VERSION.to_string(),
        adapter_id: model.adapter_id.clone(),
        findings,
        summary,
    }
}

#[cfg(test)]
#[path = "branch_coverage_gaps_tests.rs"]
mod tests;
