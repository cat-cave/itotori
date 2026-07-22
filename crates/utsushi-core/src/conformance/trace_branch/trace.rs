//! Trace conformance check ( §3).
//!
//! Index-paired comparison of an ordered golden text trace against an
//! ordered observed text trace, with per-event mismatch diagnostics and
//! typed evidence emission. The audit-focus invariants
//! (no-screenshot-evidence, bridge-unit linkage, exhaustive collection)
//! are enforced structurally by the types in this module.

use serde::{Deserialize, Serialize};

use crate::{EvidenceTier, RuntimeArtifactKind, looks_like_local_path};

use super::super::diagnostics::{ConformanceError, codes};
use super::super::manifest::is_valid_adapter_id;
use super::super::result::{ConformanceResult, EvidenceRef, ResultOutcome};
use super::super::{CONFORMANCE_SCHEMA_VERSION, ProfileId};

/// Sentinel `expected_event_id` used when an observed event has no
/// corresponding golden index (an `Unexpected` mismatch). Exported as a
/// constant so consumers can join on it without grepping for the
/// literal string.
pub const BEYOND_GOLDEN_SENTINEL: &str = "<beyond-golden>";

/// Maximum bytes the `detail` field of a [`TraceMismatch`] may carry.
/// Truncation is one-shot at construction; reviewers see the count of
/// per-event mismatches rather than an unbounded detail string per
/// mismatch.
pub const TRACE_MISMATCH_DETAIL_BYTE_CAP: usize = 256;

/// Comparison-time text normalisation policy.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextNormalisation {
    /// Byte-for-byte equality.
    #[default]
    Exact,
    /// Collapse runs of ASCII whitespace to a single space and trim
    /// leading / trailing whitespace before comparing.
    CollapseWhitespace,
}

/// Comparison-time options for [`TraceConformanceCheck::run`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraceCheckOptions {
    pub text_normalisation: TextNormalisation,
}

impl Default for TraceCheckOptions {
    fn default() -> Self {
        Self {
            text_normalisation: TextNormalisation::Exact,
        }
    }
}

/// Golden expectation for a single text trace event. Engine-neutral.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenTextEvent {
    /// Stable id the golden fixture assigns. Lowered into mismatch
    /// diagnostics as `expected_event_id`. Must be non-empty, contain
    /// no whitespace, and not look like a host path.
    pub event_id: String,
    /// Bridge unit linkage. Required at the type level — the golden
    /// side is committed to a populated id at construction time.
    pub bridge_unit_id: String,
    /// Expected runtime-visible text. Exact-match by default; the
    /// `text_normalisation` option controls whitespace folding.
    pub text: String,
    /// Optional speaker label. `None` means "any observed speaker is
    /// acceptable" — explicit don't-care semantics; the matching
    /// fixture's positive test exercises the speakers-populated path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    /// 0-based ordering claim. Validated at construction to match the
    /// vector index.
    pub order_index: u32,
}

/// Adapter-emitted text trace event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedTextEvent {
    /// Stable id the adapter assigned. Surfaced as `observed_event_id`.
    pub event_id: String,
    /// Bridge-unit linkage from the adapter. `None` surfaces as the
    /// typed `BridgeUnitUnlinked` mismatch — the option asymmetry is
    /// deliberate; the adapter is not forced to lie.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge_unit_id: Option<String>,
    /// Observed text after engine substitution.
    pub text: String,
    /// Observed speaker label, if the adapter saw one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    /// 0-based observed order.
    pub order_index: u32,
}

/// Single trace conformance check.
#[derive(Clone, Debug)]
pub struct TraceConformanceCheck {
    profile_id: ProfileId,
    adapter_id: String,
    golden_trace: Vec<GoldenTextEvent>,
    observed_trace: Vec<ObservedTextEvent>,
    options: TraceCheckOptions,
}

#[path = "trace_logic.rs"]
mod trace_logic;

/// Outcome of a trace conformance check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TraceCheckResult {
    Pass {
        /// One `EvidenceRef::TextLine` per observed event in observed
        /// order, followed by one `EvidenceRef::BridgeUnit` per unique
        /// bridge unit id (first-occurrence order).
        evidence_refs: Vec<EvidenceRef>,
    },
    Fail {
        /// All per-event mismatches in golden order. Never truncated.
        mismatches: Vec<TraceMismatch>,
        /// Evidence cited even on failure — the observed text lines
        /// and bridge units the adapter did produce.
        evidence_refs: Vec<EvidenceRef>,
    },
}

/// Per-event mismatch diagnostic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceMismatch {
    pub kind: TraceMismatchKind,
    /// Expected event id from the golden trace. Always set.
    pub expected_event_id: String,
    /// Observed event id. `None` only for `Missing` (observed trace
    /// shorter than golden).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_event_id: Option<String>,
    /// Short, public-string description. Capped at 256 bytes.
    pub detail: String,
}

impl TraceMismatch {
    fn new(
        kind: TraceMismatchKind,
        expected_event_id: &str,
        observed_event_id: Option<&str>,
        detail: String,
    ) -> Self {
        let mut detail = detail;
        if looks_like_local_path(&detail) {
            detail = format!("<redacted {} bytes>", detail.len());
        }
        truncate_detail(&mut detail);
        Self {
            kind,
            expected_event_id: expected_event_id.to_string(),
            observed_event_id: observed_event_id.map(std::string::ToString::to_string),
            detail,
        }
    }
}

/// Per-event mismatch kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TraceMismatchKind {
    TextDifference,
    OrderShift,
    BridgeUnitUnlinked,
    BridgeUnitDivergent,
    SpeakerMismatch,
    Missing,
    Unexpected,
}

/// Stable `utsushi.conformance.*` semantic code for a trace mismatch kind.
pub fn trace_mismatch_code(kind: TraceMismatchKind) -> &'static str {
    match kind {
        TraceMismatchKind::TextDifference => codes::TRACE_TEXT_MISMATCH,
        TraceMismatchKind::OrderShift => codes::TRACE_ORDER_MISMATCH,
        TraceMismatchKind::BridgeUnitUnlinked => codes::BRIDGE_UNIT_UNLINKED,
        TraceMismatchKind::BridgeUnitDivergent => codes::BRIDGE_UNIT_DIVERGENT,
        TraceMismatchKind::SpeakerMismatch => codes::TRACE_SPEAKER_MISMATCH,
        TraceMismatchKind::Missing => codes::TRACE_EVENT_MISSING,
        TraceMismatchKind::Unexpected => codes::TRACE_EVENT_UNEXPECTED,
    }
}

/// Returns true when an `EvidenceRef` is admissible for a `text-trace`
/// profile result. Used by [`TraceCheckResult::into_conformance_result`]
/// to reject screenshot / frame-capture / recording evidence at lowering
/// time — the audit-focus defense against trace-only profiles claiming
/// rendered-playback evidence.
pub fn accepts_text_trace_evidence(evidence: &EvidenceRef) -> bool {
    match evidence {
        EvidenceRef::TextLine { .. }
        | EvidenceRef::BridgeUnit { .. }
        | EvidenceRef::ReplayLogRef { .. }
        | EvidenceRef::ImplMapFixture { .. } => true,
        // `EvidenceRef::StatePath` () belongs to the
        // snapshot-restore profile only; rejecting it here keeps the
        // text-trace evidence filter narrow.
        EvidenceRef::FrameArtifactRef { .. } | EvidenceRef::StatePath { .. } => false,
        EvidenceRef::RuntimeArtifact { kind, .. } => matches!(
            kind,
            RuntimeArtifactKind::TraceLog | RuntimeArtifactKind::ConformanceReport
        ),
    }
}

fn texts_match(expected: &str, observed: &str, mode: TextNormalisation) -> bool {
    match mode {
        TextNormalisation::Exact => expected == observed,
        TextNormalisation::CollapseWhitespace => collapse_ws(expected) == collapse_ws(observed),
    }
}

fn collapse_ws(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_ws = true;
    for ch in value.chars() {
        if ch.is_ascii_whitespace() {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(ch);
            in_ws = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

fn truncate_detail(detail: &mut String) {
    if detail.len() <= TRACE_MISMATCH_DETAIL_BYTE_CAP {
        return;
    }
    let mut cap = TRACE_MISMATCH_DETAIL_BYTE_CAP;
    while !detail.is_char_boundary(cap) {
        cap -= 1;
    }
    detail.truncate(cap);
}

pub(super) fn validate_id_field(
    artifact_kind: &'static str,
    field: &str,
    value: &str,
) -> Result<(), ConformanceError> {
    if value.is_empty() {
        return Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind,
            reason: format!("{field} is empty"),
        });
    }
    if value.chars().any(char::is_whitespace) {
        return Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind,
            reason: format!("{field} contains whitespace"),
        });
    }
    if looks_like_local_path(value) {
        return Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind,
            reason: format!("{field} looks like a local path"),
        });
    }
    Ok(())
}

#[cfg(test)]
fn bridge_id(suffix: &str) -> String {
    format!("0190a000-0000-7000-8000-000000000{suffix}")
}

#[cfg(test)]
fn baseline_golden() -> Vec<GoldenTextEvent> {
    vec![
        GoldenTextEvent {
            event_id: "g-001".to_string(),
            bridge_unit_id: bridge_id("001"),
            text: "Hello".to_string(),
            speaker: None,
            order_index: 0,
        },
        GoldenTextEvent {
            event_id: "g-002".to_string(),
            bridge_unit_id: bridge_id("002"),
            text: "World".to_string(),
            speaker: None,
            order_index: 1,
        },
    ]
}

#[cfg(test)]
fn baseline_observed() -> Vec<ObservedTextEvent> {
    vec![
        ObservedTextEvent {
            event_id: "o-001".to_string(),
            bridge_unit_id: Some(bridge_id("001")),
            text: "Hello".to_string(),
            speaker: None,
            order_index: 0,
        },
        ObservedTextEvent {
            event_id: "o-002".to_string(),
            bridge_unit_id: Some(bridge_id("002")),
            text: "World".to_string(),
            speaker: None,
            order_index: 1,
        },
    ]
}

#[cfg(test)]
fn baseline_check() -> TraceConformanceCheck {
    TraceConformanceCheck::new(
        "utsushi-synthetic",
        baseline_golden(),
        baseline_observed(),
        TraceCheckOptions::default(),
    )
    .expect("baseline constructs")
}

#[cfg(test)]
#[path = "trace_tests.rs"]
mod tests;

#[cfg(test)]
mod evidence_tests {
    use super::*;

    #[test]
    fn trace_into_conformance_result_rejects_frame_artifact_evidence() {
        let result = TraceCheckResult::Pass {
            evidence_refs: vec![EvidenceRef::FrameArtifactRef {
                frame_id: "frame-1".to_string(),
            }],
        };
        let error = result
            .into_conformance_result(
                "utsushi-synthetic",
                EvidenceTier::E1,
                "2026-06-23T12:00:00Z",
            )
            .expect_err("rejects frame artifact ref");
        assert!(matches!(
            error,
            ConformanceError::MalformedSemanticCode { ref code, .. }
                if code == codes::TRACE_EVIDENCE_TIER_OVERCLAIM
        ));
    }

    #[test]
    fn trace_into_conformance_result_rejects_recording_runtime_artifact() {
        let uri =
            crate::runtime_artifact_uri("synthetic-run", RuntimeArtifactKind::Recording, "rec-001")
                .expect("uri");
        let result = TraceCheckResult::Pass {
            evidence_refs: vec![EvidenceRef::RuntimeArtifact {
                kind: RuntimeArtifactKind::Recording,
                uri,
                artifact_id: Some("rec-001".to_string()),
            }],
        };
        let error = result
            .into_conformance_result(
                "utsushi-synthetic",
                EvidenceTier::E1,
                "2026-06-23T12:00:00Z",
            )
            .expect_err("rejects recording artifact");
        assert!(matches!(
            error,
            ConformanceError::MalformedSemanticCode { ref code, .. }
                if code == codes::TRACE_EVIDENCE_TIER_OVERCLAIM
        ));
    }

    #[test]
    fn trace_pass_result_round_trips_through_conformance_schema_v0_1() {
        let result = baseline_check().run();
        let lowered = result
            .into_conformance_result(
                "utsushi-synthetic",
                EvidenceTier::E1,
                "2026-06-23T12:00:00Z",
            )
            .expect("lowers");
        let value = lowered.to_json_value().expect("serializes");
        let restored = ConformanceResult::from_json_value(value).expect("round-trips");
        assert_eq!(restored, lowered);
    }

    #[test]
    fn accepts_text_trace_evidence_rejects_screenshot_runtime_artifact() {
        let uri = crate::runtime_artifact_uri(
            "synthetic-run",
            RuntimeArtifactKind::Screenshot,
            "shot-001",
        )
        .expect("uri");
        let evidence = EvidenceRef::RuntimeArtifact {
            kind: RuntimeArtifactKind::Screenshot,
            uri,
            artifact_id: Some("shot-001".to_string()),
        };
        assert!(!accepts_text_trace_evidence(&evidence));
    }

    #[test]
    fn accepts_text_trace_evidence_accepts_trace_log_runtime_artifact() {
        let uri = crate::runtime_artifact_uri(
            "synthetic-run",
            RuntimeArtifactKind::TraceLog,
            "trace-001",
        )
        .expect("uri");
        let evidence = EvidenceRef::RuntimeArtifact {
            kind: RuntimeArtifactKind::TraceLog,
            uri,
            artifact_id: Some("trace-001".to_string()),
        };
        assert!(accepts_text_trace_evidence(&evidence));
    }

    #[test]
    fn trace_check_run_fail_evidence_includes_observed_events() {
        let mut observed = baseline_observed();
        observed[0].text = "Different".to_string();
        let check = TraceConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            TraceCheckOptions::default(),
        )
        .expect("constructs");
        let TraceCheckResult::Fail { evidence_refs, .. } = check.run() else {
            panic!("expected Fail");
        };
        assert!(
            evidence_refs
                .iter()
                .any(|e| matches!(e, EvidenceRef::TextLine { .. })),
            "Fail still cites observed text lines"
        );
    }
}
