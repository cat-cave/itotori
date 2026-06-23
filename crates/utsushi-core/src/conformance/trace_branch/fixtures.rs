//! Loaders + builders for the trace_branch JSON fixture tree.
//!
//! Public test-aid surface for in-crate integration tests under
//! `crates/utsushi-core/tests/` and for downstream conformance consumers
//! that opt into the `conformance-fixtures` feature.
//!
//! Each loader takes a parsed `serde_json::Value` (the integration test
//! reads the file via `std::fs::read_to_string` and parses) and
//! constructs the appropriate check via `Check::new()`. Construction
//! errors propagate untouched so the integration test can assert on the
//! expected `ConformanceError` shape.

use serde::{Deserialize, Serialize};

use super::super::diagnostics::ConformanceError;
use super::branch::{BranchCheckOptions, BranchConformanceCheck, GoldenBranch, ObservedBranch};
use super::trace::{
    GoldenTextEvent, ObservedTextEvent, TextNormalisation, TraceCheckOptions, TraceConformanceCheck,
};

/// Serializable wrapper for a trace fixture file.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceFixture {
    #[serde(default)]
    pub adapter_id: Option<String>,
    #[serde(default)]
    pub options: Option<TraceFixtureOptions>,
    pub golden_trace: Vec<GoldenTextEvent>,
    pub observed_trace: Vec<ObservedTextEvent>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TraceFixtureOptions {
    #[serde(default)]
    pub text_normalisation: Option<TextNormalisation>,
}

/// Serializable wrapper for a branch fixture file.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchFixture {
    #[serde(default)]
    pub adapter_id: Option<String>,
    #[serde(default)]
    pub options: Option<BranchFixtureOptions>,
    pub golden_branches: Vec<GoldenBranch>,
    pub observed_branches: Vec<ObservedBranch>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BranchFixtureOptions {
    #[serde(default)]
    pub replay_log_run_id: Option<String>,
}

const FIXTURE_ADAPTER_ID: &str = "utsushi-synthetic";

/// Construct a [`TraceConformanceCheck`] from a parsed JSON fixture.
pub fn trace_check_from_json(
    value: serde_json::Value,
) -> Result<TraceConformanceCheck, FixtureError> {
    let fixture: TraceFixture = serde_json::from_value(value).map_err(FixtureError::Parse)?;
    let adapter_id = fixture
        .adapter_id
        .unwrap_or_else(|| FIXTURE_ADAPTER_ID.to_string());
    let options = TraceCheckOptions {
        text_normalisation: fixture
            .options
            .and_then(|o| o.text_normalisation)
            .unwrap_or_default(),
    };
    TraceConformanceCheck::new(
        adapter_id,
        fixture.golden_trace,
        fixture.observed_trace,
        options,
    )
    .map_err(FixtureError::Conformance)
}

/// Construct a [`BranchConformanceCheck`] from a parsed JSON fixture.
pub fn branch_check_from_json(
    value: serde_json::Value,
) -> Result<BranchConformanceCheck, FixtureError> {
    let fixture: BranchFixture = serde_json::from_value(value).map_err(FixtureError::Parse)?;
    let adapter_id = fixture
        .adapter_id
        .unwrap_or_else(|| FIXTURE_ADAPTER_ID.to_string());
    let options = BranchCheckOptions {
        replay_log_run_id: fixture.options.and_then(|o| o.replay_log_run_id),
    };
    BranchConformanceCheck::new(
        adapter_id,
        fixture.golden_branches,
        fixture.observed_branches,
        options,
    )
    .map_err(FixtureError::Conformance)
}

/// Loader error. The two variants distinguish "fixture JSON was
/// malformed" from "fixture JSON parsed but the check rejected it" so
/// integration tests can match precisely.
#[derive(Debug)]
pub enum FixtureError {
    Parse(serde_json::Error),
    Conformance(ConformanceError),
}

impl std::fmt::Display for FixtureError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(error) => write!(formatter, "fixture parse error: {error}"),
            Self::Conformance(error) => write!(formatter, "fixture conformance error: {error}"),
        }
    }
}

impl std::error::Error for FixtureError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn baseline_trace_json() -> serde_json::Value {
        json!({
            "adapterId": "utsushi-synthetic",
            "options": { "textNormalisation": "exact" },
            "goldenTrace": [
                {
                    "eventId": "g-001",
                    "bridgeUnitId": "0190a000-0000-7000-8000-000000000001",
                    "text": "Hello",
                    "orderIndex": 0
                }
            ],
            "observedTrace": [
                {
                    "eventId": "o-001",
                    "bridgeUnitId": "0190a000-0000-7000-8000-000000000001",
                    "text": "Hello",
                    "orderIndex": 0
                }
            ]
        })
    }

    fn baseline_branch_json() -> serde_json::Value {
        json!({
            "adapterId": "utsushi-synthetic",
            "goldenBranches": [
                {
                    "branchId": "branch-001",
                    "choiceIndexPath": [0, 1],
                    "expectedOutcome": "happy_end"
                }
            ],
            "observedBranches": [
                {
                    "branchId": "branch-001",
                    "choiceIndexPath": [0, 1],
                    "observedOutcome": "happy_end"
                }
            ]
        })
    }

    #[test]
    fn trace_check_from_json_loads_baseline() {
        let check = trace_check_from_json(baseline_trace_json()).expect("loads");
        assert_eq!(check.adapter_id(), "utsushi-synthetic");
    }

    #[test]
    fn branch_check_from_json_loads_baseline() {
        let check = branch_check_from_json(baseline_branch_json()).expect("loads");
        assert_eq!(check.adapter_id(), "utsushi-synthetic");
    }
}
