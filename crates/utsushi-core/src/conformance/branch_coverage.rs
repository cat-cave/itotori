//! MV/MZ branch coverage read model ().
//!
//! A DATA-ONLY read model that JOINS three existing surfaces into a
//! per-branch coverage view:
//!
//! - **MV/MZ runtime trace observations** — the observation
//!   events + replay pack. Each observed branch carries the
//!   `route_key` its choice option leads to
//!   (`crates/utsushi-rpgmaker-mv` `LinkedChoiceOption.route_key`
//!   `ReplayPack.route_alignments`), the set of observed runtime trace
//!   event ids seen on that branch (`ObservedTextEvent.event_id`), and
//!   the count of reachable runtime-visible text events.
//! - **Itotori route maps** — the route-choice-map `RouteMap` records
//!   keyed by `route_key` (`apps/itotori` route-choice-map), each with a
//!   `route_map_id`. `route_key` is the join column.
//! - **Coverage status** — DERIVED per branch from the join (see
//!   [`CoverageStatus`] / [`derive_coverage_status`]).
//!
//! This module NEVER launches a runtime host, plays back a browser
//! captures a screenshot, or imports annotations. It only reshapes data
//! that other nodes already produced. Its only dependency is `serde`.
//!
//! The read model records exactly the fields the acceptance requires:
//! branch ids, route-map ids, observed runtime trace ids, reachable text
//! counts, and a per-branch coverage status.

use serde::{Deserialize, Serialize};

use super::manifest::is_valid_adapter_id;
use crate::looks_like_local_path;

/// Stable schema id for the serialized read model + fixtures.
pub const BRANCH_COVERAGE_READ_MODEL_SCHEMA_VERSION: &str = "utsushi.branch_coverage.v0.1";

/// A single MV/MZ runtime-trace branch observation (join INPUT A).
///
/// Models the observation event + replay-pack
/// view of one discovered branch: which route it leads to, the runtime
/// trace ids that were actually observed on it, and how much reachable
/// text it exposes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchTraceObservation {
    /// Stable branch identifier (mirrors `ObservedBranch.branch_id`).
    pub branch_id: String,
    /// The route key the branch's choice option leads to
    /// (`LinkedChoiceOption.route_key`). `None` when the observed branch
    /// carries no route-key linkage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_key: Option<String>,
    /// Observed runtime trace event ids seen on this branch
    /// (`ObservedTextEvent.event_id`). Empty = the branch was never
    /// observed at runtime.
    #[serde(default)]
    pub observed_trace_ids: Vec<String>,
    /// Count of reachable runtime-visible text events on this branch.
    pub reachable_text_count: u32,
}

/// One Itotori route-map entry (join INPUT B).
///
/// Models the route-choice-map `RouteMap`: a `route_map_id` reachable
/// through a `route_key`. `route_key` is the join column against
/// [`BranchTraceObservation::route_key`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteMapEntry {
    /// `RouteMap.id` — the route-map id surfaced in the read model.
    pub route_map_id: String,
    /// `RouteMap.route_key` — the join column.
    pub route_key: String,
}

/// Per-branch coverage status. DERIVED, never observed directly.
///
/// The four MV/MZ branch states the acceptance enumerates. See
/// [`derive_coverage_status`] for the exact rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverageStatus {
    /// Reachable through exactly one route map AND observed at runtime.
    Visited,
    /// Reachable through exactly one route map but never observed.
    Unvisited,
    /// The join cannot attribute the branch to a single route: it was
    /// observed at runtime yet resolves to NO route map (a dangling
    /// route target), or it resolves to MORE THAN ONE route map.
    Ambiguous,
    /// No route map reaches the branch AND it was never observed.
    Unreachable,
}

impl CoverageStatus {
    /// Stable snake_case wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Visited => "visited",
            Self::Unvisited => "unvisited",
            Self::Ambiguous => "ambiguous",
            Self::Unreachable => "unreachable",
        }
    }
}

/// Derive the per-branch coverage status from the JOIN result.
///
/// The rule is deterministic and depends only on (a) how many route
/// maps the branch's `route_key` resolves to and (b) whether the branch
/// has at least one observed runtime trace id:
///
/// route-map ids | observed | status
/// ------------- | -------- | ------------
/// 1 | yes | `Visited`
/// 1 | no | `Unvisited`
/// 0 | yes | `Ambiguous`
/// 0 | no | `Unreachable`
/// >1 | any | `Ambiguous`
///
/// `Ambiguous` covers the two cases where coverage cannot be uniquely
/// attributed: an observed branch whose route key does not resolve to
/// any route map (a dangling target, matching Itotori's
/// `unknown_route_target` staleness), and a branch whose route key
/// resolves to several route maps.
pub fn derive_coverage_status(route_map_id_count: usize, observed: bool) -> CoverageStatus {
    match (route_map_id_count, observed) {
        (1, true) => CoverageStatus::Visited,
        (1, false) => CoverageStatus::Unvisited,
        (0, false) => CoverageStatus::Unreachable,
        // The remaining cases cannot be attributed to a single route:
        // (0, true) is an observed branch with no route home (a dangling
        // target), and (>1, _) resolves to several route maps.
        _ => CoverageStatus::Ambiguous,
    }
}

/// One joined branch-coverage record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCoverageRecord {
    /// The branch id (join key on the observation side).
    pub branch_id: String,
    /// The route key the branch leads to, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_key: Option<String>,
    /// The route-map ids the branch resolved to (0, 1, or many).
    pub route_map_ids: Vec<String>,
    /// Observed runtime trace event ids on this branch.
    pub observed_trace_ids: Vec<String>,
    /// Reachable runtime-visible text count.
    pub reachable_text_count: u32,
    /// Derived coverage status.
    pub coverage_status: CoverageStatus,
}

/// Per-status aggregate counts for the whole read model.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCoverageSummary {
    pub branch_count: u32,
    pub visited: u32,
    pub unvisited: u32,
    pub ambiguous: u32,
    pub unreachable: u32,
    /// Sum of `reachable_text_count` over every branch.
    pub total_reachable_text: u32,
    /// Sum of `reachable_text_count` over `Visited` branches only.
    pub covered_reachable_text: u32,
}

/// The joined branch-coverage read model.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCoverageReadModel {
    pub schema_version: String,
    pub adapter_id: String,
    /// Records sorted by `branch_id` for deterministic output.
    pub records: Vec<BranchCoverageRecord>,
    pub summary: BranchCoverageSummary,
}

/// Read-model construction error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BranchCoverageError {
    AdapterIdMalformed { id: String },
    DuplicateBranchId { branch_id: String },
    BranchIdMalformed { branch_id: String },
    RouteKeyMalformed { route_key: String },
    RouteMapIdMalformed { route_map_id: String },
    TraceIdMalformed { branch_id: String, trace_id: String },
}

impl std::fmt::Display for BranchCoverageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AdapterIdMalformed { id } => write!(formatter, "adapter id {id:?} is malformed"),
            Self::DuplicateBranchId { branch_id } => {
                write!(formatter, "duplicate branch id {branch_id:?}")
            }
            Self::BranchIdMalformed { branch_id } => {
                write!(formatter, "branch id {branch_id:?} is malformed")
            }
            Self::RouteKeyMalformed { route_key } => {
                write!(formatter, "route key {route_key:?} is malformed")
            }
            Self::RouteMapIdMalformed { route_map_id } => {
                write!(formatter, "route map id {route_map_id:?} is malformed")
            }
            Self::TraceIdMalformed {
                branch_id,
                trace_id,
            } => write!(
                formatter,
                "observed trace id {trace_id:?} on branch {branch_id:?} is malformed"
            ),
        }
    }
}

impl std::error::Error for BranchCoverageError {}

fn validate_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.chars().all(|c| !c.is_whitespace())
        && !looks_like_local_path(value)
}

/// Join MV/MZ trace observations against the Itotori route map into the
/// branch-coverage read model.
///
/// The join is a pure data reshape: it groups the route map by
/// `route_key`, resolves each observation's `route_key` to its set of
/// `route_map_id`s, derives the per-branch [`CoverageStatus`], and emits
/// records sorted by `branch_id`. No runtime host is launched.
pub fn join_branch_coverage(
    adapter_id: impl Into<String>,
    observations: &[BranchTraceObservation],
    route_map: &[RouteMapEntry],
) -> Result<BranchCoverageReadModel, BranchCoverageError> {
    let adapter_id = adapter_id.into();
    if !is_valid_adapter_id(&adapter_id) {
        return Err(BranchCoverageError::AdapterIdMalformed { id: adapter_id });
    }

    // route_key -> sorted, de-duplicated route-map ids.
    let mut route_index: std::collections::BTreeMap<&str, std::collections::BTreeSet<&str>> =
        std::collections::BTreeMap::new();
    for entry in route_map {
        if !validate_token(&entry.route_key) {
            return Err(BranchCoverageError::RouteKeyMalformed {
                route_key: entry.route_key.clone(),
            });
        }
        if !validate_token(&entry.route_map_id) {
            return Err(BranchCoverageError::RouteMapIdMalformed {
                route_map_id: entry.route_map_id.clone(),
            });
        }
        route_index
            .entry(entry.route_key.as_str())
            .or_default()
            .insert(entry.route_map_id.as_str());
    }

    let mut seen_branches: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut records: Vec<BranchCoverageRecord> = Vec::with_capacity(observations.len());
    let mut summary = BranchCoverageSummary::default();

    for observation in observations {
        if !validate_token(&observation.branch_id) {
            return Err(BranchCoverageError::BranchIdMalformed {
                branch_id: observation.branch_id.clone(),
            });
        }
        if !seen_branches.insert(observation.branch_id.as_str()) {
            return Err(BranchCoverageError::DuplicateBranchId {
                branch_id: observation.branch_id.clone(),
            });
        }
        if let Some(route_key) = observation.route_key.as_deref()
            && !validate_token(route_key)
        {
            return Err(BranchCoverageError::RouteKeyMalformed {
                route_key: route_key.to_string(),
            });
        }
        for trace_id in &observation.observed_trace_ids {
            if !validate_token(trace_id) {
                return Err(BranchCoverageError::TraceIdMalformed {
                    branch_id: observation.branch_id.clone(),
                    trace_id: trace_id.clone(),
                });
            }
        }

        let route_map_ids: Vec<String> = observation
            .route_key
            .as_deref()
            .and_then(|key| route_index.get(key))
            .map(|ids| ids.iter().map(|id| (*id).to_string()).collect())
            .unwrap_or_default();

        // De-duplicate observed trace ids while preserving first-seen order.
        let mut observed_trace_ids: Vec<String> = Vec::new();
        let mut trace_seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for trace_id in &observation.observed_trace_ids {
            if trace_seen.insert(trace_id.as_str()) {
                observed_trace_ids.push(trace_id.clone());
            }
        }

        let observed = !observed_trace_ids.is_empty();
        let coverage_status = derive_coverage_status(route_map_ids.len(), observed);

        summary.branch_count += 1;
        summary.total_reachable_text = summary
            .total_reachable_text
            .saturating_add(observation.reachable_text_count);
        match coverage_status {
            CoverageStatus::Visited => {
                summary.visited += 1;
                summary.covered_reachable_text = summary
                    .covered_reachable_text
                    .saturating_add(observation.reachable_text_count);
            }
            CoverageStatus::Unvisited => summary.unvisited += 1,
            CoverageStatus::Ambiguous => summary.ambiguous += 1,
            CoverageStatus::Unreachable => summary.unreachable += 1,
        }

        records.push(BranchCoverageRecord {
            branch_id: observation.branch_id.clone(),
            route_key: observation.route_key.clone(),
            route_map_ids,
            observed_trace_ids,
            reachable_text_count: observation.reachable_text_count,
            coverage_status,
        });
    }

    records.sort_by(|a, b| a.branch_id.cmp(&b.branch_id));

    Ok(BranchCoverageReadModel {
        schema_version: BRANCH_COVERAGE_READ_MODEL_SCHEMA_VERSION.to_string(),
        adapter_id,
        records,
        summary,
    })
}

/// Serializable wrapper for a branch-coverage fixture file. Mirrors the
/// `trace_branch::fixtures` convention so reviewers can read the join
/// inputs as committed data and a TypeScript dashboard seed can consume
/// the identical bytes.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCoverageFixture {
    #[serde(default)]
    pub adapter_id: Option<String>,
    pub observations: Vec<BranchTraceObservation>,
    #[serde(default)]
    pub route_map: Vec<RouteMapEntry>,
}

const FIXTURE_ADAPTER_ID: &str = "utsushi-synthetic";

/// Build a [`BranchCoverageReadModel`] from a parsed JSON fixture.
pub fn read_model_from_json(
    value: serde_json::Value,
) -> Result<BranchCoverageReadModel, BranchCoverageFixtureError> {
    let fixture: BranchCoverageFixture =
        serde_json::from_value(value).map_err(BranchCoverageFixtureError::Parse)?;
    let adapter_id = fixture
        .adapter_id
        .unwrap_or_else(|| FIXTURE_ADAPTER_ID.to_string());
    join_branch_coverage(adapter_id, &fixture.observations, &fixture.route_map)
        .map_err(BranchCoverageFixtureError::Join)
}

/// Loader error distinguishing malformed fixture JSON from a fixture
/// that parsed but the join rejected.
#[derive(Debug)]
pub enum BranchCoverageFixtureError {
    Parse(serde_json::Error),
    Join(BranchCoverageError),
}

impl std::fmt::Display for BranchCoverageFixtureError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(error) => write!(formatter, "fixture parse error: {error}"),
            Self::Join(error) => write!(formatter, "fixture join error: {error}"),
        }
    }
}

impl std::error::Error for BranchCoverageFixtureError {}

#[cfg(test)]
#[path = "branch_coverage_tests.rs"]
mod tests;
