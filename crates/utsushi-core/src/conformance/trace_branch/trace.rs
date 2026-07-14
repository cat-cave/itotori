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

impl TraceConformanceCheck {
    /// Build a check. Validates adapter id, non-empty golden trace
    /// monotonic order indices, non-empty bridge unit ids on the golden
    /// side, and event id well-formedness on the golden side.
    pub fn new(
        adapter_id: impl Into<String>,
        golden_trace: Vec<GoldenTextEvent>,
        observed_trace: Vec<ObservedTextEvent>,
        options: TraceCheckOptions,
    ) -> Result<Self, ConformanceError> {
        let adapter_id = adapter_id.into();
        if !is_valid_adapter_id(&adapter_id) {
            return Err(ConformanceError::AdapterIdMalformed { id: adapter_id });
        }
        if golden_trace.is_empty() {
            return Err(ConformanceError::EvidenceRefInvalid {
                artifact_kind: "text_line",
                reason: "golden_trace is empty".to_string(),
            });
        }
        for (index, event) in golden_trace.iter().enumerate() {
            let expected_order =
                u32::try_from(index).map_err(|_| ConformanceError::EvidenceRefInvalid {
                    artifact_kind: "text_line",
                    reason: "golden_trace length exceeds u32".to_string(),
                })?;
            if event.order_index != expected_order {
                return Err(ConformanceError::EvidenceRefInvalid {
                    artifact_kind: "text_line",
                    reason: format!(
                        "golden_trace[{index}].order_index = {} does not match vector index",
                        event.order_index
                    ),
                });
            }
            validate_id_field("text_line", "event_id", &event.event_id)?;
            validate_id_field("bridge_unit", "bridge_unit_id", &event.bridge_unit_id)?;
            if event.text.is_empty() {
                return Err(ConformanceError::EvidenceRefInvalid {
                    artifact_kind: "text_line",
                    reason: format!("golden_trace[{index}].text is empty"),
                });
            }
        }
        Ok(Self {
            profile_id: ProfileId::TextTrace,
            adapter_id,
            golden_trace,
            observed_trace,
            options,
        })
    }

    /// Profile id this check is bound to. Always
    /// [`ProfileId::TextTrace`].
    pub fn profile_id(&self) -> ProfileId {
        self.profile_id
    }

    /// Adapter id from construction time.
    pub fn adapter_id(&self) -> &str {
        &self.adapter_id
    }

    /// Execute the check. Pass / Fail enumerate all mismatches; the
    /// pairing pass never short-circuits inside a single event.
    pub fn run(&self) -> TraceCheckResult {
        let golden_len = self.golden_trace.len();
        let observed_len = self.observed_trace.len();
        let mut mismatches: Vec<TraceMismatch> = Vec::new();

        for index in 0..golden_len.max(observed_len) {
            if index >= observed_len {
                let golden = &self.golden_trace[index];
                mismatches.push(TraceMismatch::new(
                    TraceMismatchKind::Missing,
                    &golden.event_id,
                    None,
                    format!("observed trace ended at index {index}"),
                ));
                continue;
            }
            if index >= golden_len {
                let observed = &self.observed_trace[index];
                mismatches.push(TraceMismatch::new(
                    TraceMismatchKind::Unexpected,
                    BEYOND_GOLDEN_SENTINEL,
                    Some(&observed.event_id),
                    format!("observed extra event at index {index}"),
                ));
                continue;
            }
            let golden = &self.golden_trace[index];
            let observed = &self.observed_trace[index];

            // (1) BridgeUnitUnlinked.
            if observed.bridge_unit_id.is_none() {
                mismatches.push(TraceMismatch::new(
                    TraceMismatchKind::BridgeUnitUnlinked,
                    &golden.event_id,
                    Some(&observed.event_id),
                    "observed event has no bridge_unit_id".to_string(),
                ));
            } else if let Some(observed_id) = observed.bridge_unit_id.as_deref() {
                // (2) BridgeUnitDivergent.
                if observed_id != golden.bridge_unit_id {
                    mismatches.push(TraceMismatch::new(
                        TraceMismatchKind::BridgeUnitDivergent,
                        &golden.event_id,
                        Some(&observed.event_id),
                        format!(
                            "expected bridge_unit_id {} observed {}",
                            golden.bridge_unit_id, observed_id
                        ),
                    ));
                }
            }

            // (3) OrderShift.
            if observed.order_index != golden.order_index {
                mismatches.push(TraceMismatch::new(
                    TraceMismatchKind::OrderShift,
                    &golden.event_id,
                    Some(&observed.event_id),
                    format!(
                        "expected order_index {} observed {}",
                        golden.order_index, observed.order_index
                    ),
                ));
            }

            // (4) TextDifference.
            if !texts_match(
                &golden.text,
                &observed.text,
                self.options.text_normalisation,
            ) {
                mismatches.push(TraceMismatch::new(
                    TraceMismatchKind::TextDifference,
                    &golden.event_id,
                    Some(&observed.event_id),
                    format!(
                        "expected text {:?} observed {:?}",
                        golden.text, observed.text
                    ),
                ));
            }

            // (5) SpeakerMismatch.
            if let Some(expected) = golden.speaker.as_deref() {
                let matches = observed
                    .speaker
                    .as_deref()
                    .is_some_and(|observed_speaker| observed_speaker == expected);
                if !matches {
                    let observed_speaker_token = match observed.speaker.as_deref() {
                        Some(value) => value.to_string(),
                        None => "<none>".to_string(),
                    };
                    mismatches.push(TraceMismatch::new(
                        TraceMismatchKind::SpeakerMismatch,
                        &golden.event_id,
                        Some(&observed.event_id),
                        format!(
                            "expected speaker {expected:?} observed {observed_speaker_token:?}"
                        ),
                    ));
                }
            }
        }

        let evidence_refs = build_trace_evidence(&self.observed_trace);
        if mismatches.is_empty() {
            TraceCheckResult::Pass { evidence_refs }
        } else {
            TraceCheckResult::Fail {
                mismatches,
                evidence_refs,
            }
        }
    }
}

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

impl TraceCheckResult {
    /// Lower this check result into a [`ConformanceResult`] for the
    /// `text-trace` profile. Rejects evidence-tier overclaiming and
    /// frame / screenshot / recording evidence refs.
    pub fn into_conformance_result(
        self,
        adapter_id: &str,
        evidence_tier: EvidenceTier,
        recorded_at: &str,
    ) -> Result<ConformanceResult, ConformanceError> {
        if !is_valid_adapter_id(adapter_id) {
            return Err(ConformanceError::AdapterIdMalformed {
                id: adapter_id.to_string(),
            });
        }
        let ceiling = ProfileId::TextTrace.evidence_tier_ceiling();
        if evidence_tier > ceiling {
            return Err(ConformanceError::EvidenceTierAboveProfileCeiling {
                profile: ProfileId::TextTrace,
                claimed: evidence_tier,
                ceiling,
            });
        }
        let (outcome, evidence) = match self {
            Self::Pass { evidence_refs } => {
                for evidence in &evidence_refs {
                    if !accepts_text_trace_evidence(evidence) {
                        return Err(ConformanceError::MalformedSemanticCode {
                            code: codes::TRACE_EVIDENCE_TIER_OVERCLAIM.to_string(),
                        });
                    }
                }
                (ResultOutcome::Pass { evidence_tier }, evidence_refs)
            }
            Self::Fail {
                mismatches,
                evidence_refs,
            } => {
                for evidence in &evidence_refs {
                    if !accepts_text_trace_evidence(evidence) {
                        return Err(ConformanceError::MalformedSemanticCode {
                            code: codes::TRACE_EVIDENCE_TIER_OVERCLAIM.to_string(),
                        });
                    }
                }
                let (code, detail) = summarise_trace_failure(&mismatches);
                (
                    ResultOutcome::Fail {
                        semantic_code: code,
                        detail,
                    },
                    evidence_refs,
                )
            }
        };

        let result = ConformanceResult {
            schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
            adapter_id: adapter_id.to_string(),
            profile_id: ProfileId::TextTrace,
            outcome,
            evidence,
            recorded_at: recorded_at.to_string(),
        };
        result.validate()?;
        Ok(result)
    }
}

fn summarise_trace_failure(mismatches: &[TraceMismatch]) -> (String, String) {
    let total = mismatches.len();
    let mut text_difference = 0usize;
    let mut order_shift = 0usize;
    let mut bridge_unlinked = 0usize;
    let mut bridge_divergent = 0usize;
    let mut speaker = 0usize;
    let mut missing = 0usize;
    let mut unexpected = 0usize;
    for mismatch in mismatches {
        match mismatch.kind {
            TraceMismatchKind::TextDifference => text_difference += 1,
            TraceMismatchKind::OrderShift => order_shift += 1,
            TraceMismatchKind::BridgeUnitUnlinked => bridge_unlinked += 1,
            TraceMismatchKind::BridgeUnitDivergent => bridge_divergent += 1,
            TraceMismatchKind::SpeakerMismatch => speaker += 1,
            TraceMismatchKind::Missing => missing += 1,
            TraceMismatchKind::Unexpected => unexpected += 1,
        }
    }
    let dominant_code = mismatches
        .first()
        .map_or(codes::TRACE_TEXT_MISMATCH, |first| {
            trace_mismatch_code(first.kind)
        })
        .to_string();
    let mut detail = format!(
        "{total} trace mismatches: text_diff={text_difference} order_shift={order_shift} \
         bridge_unlinked={bridge_unlinked} bridge_divergent={bridge_divergent} \
         speaker={speaker} missing={missing} unexpected={unexpected}"
    );
    truncate_detail(&mut detail);
    (dominant_code, detail)
}

fn build_trace_evidence(observed: &[ObservedTextEvent]) -> Vec<EvidenceRef> {
    let mut refs: Vec<EvidenceRef> = Vec::with_capacity(observed.len());
    let mut seen_bridge: Vec<String> = Vec::new();
    for event in observed {
        refs.push(EvidenceRef::TextLine {
            line_id: event.event_id.clone(),
        });
    }
    for event in observed {
        if let Some(bridge_id) = event.bridge_unit_id.as_deref()
            && !seen_bridge.iter().any(|seen| seen == bridge_id)
        {
            seen_bridge.push(bridge_id.to_string());
        }
    }
    for bridge_id in seen_bridge {
        refs.push(EvidenceRef::BridgeUnit {
            bridge_unit_id: bridge_id,
        });
    }
    refs
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
mod tests {
    use super::*;

    fn bridge_id(suffix: &str) -> String {
        format!("0190a000-0000-7000-8000-000000000{suffix}")
    }

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

    fn baseline_check() -> TraceConformanceCheck {
        TraceConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            baseline_observed(),
            TraceCheckOptions::default(),
        )
        .expect("baseline constructs")
    }

    #[test]
    fn trace_check_new_accepts_well_formed_input() {
        baseline_check();
    }

    #[test]
    fn trace_check_new_rejects_empty_golden_trace() {
        let error = TraceConformanceCheck::new(
            "utsushi-synthetic",
            Vec::new(),
            Vec::new(),
            TraceCheckOptions::default(),
        )
        .expect_err("empty golden rejected");
        assert!(matches!(
            error,
            ConformanceError::EvidenceRefInvalid {
                artifact_kind: "text_line",
                ..
            }
        ));
    }

    #[test]
    fn trace_check_new_rejects_golden_with_non_monotonic_order_indices() {
        let mut golden = baseline_golden();
        golden[1].order_index = 0;
        let error = TraceConformanceCheck::new(
            "utsushi-synthetic",
            golden,
            baseline_observed(),
            TraceCheckOptions::default(),
        )
        .expect_err("non-monotonic golden rejected");
        assert!(matches!(
            error,
            ConformanceError::EvidenceRefInvalid {
                artifact_kind: "text_line",
                ..
            }
        ));
    }

    #[test]
    fn trace_check_new_rejects_golden_with_empty_bridge_unit_id() {
        let mut golden = baseline_golden();
        golden[0].bridge_unit_id.clear();
        let error = TraceConformanceCheck::new(
            "utsushi-synthetic",
            golden,
            baseline_observed(),
            TraceCheckOptions::default(),
        )
        .expect_err("empty bridge unit id rejected");
        assert!(matches!(
            error,
            ConformanceError::EvidenceRefInvalid {
                artifact_kind: "bridge_unit",
                ..
            }
        ));
    }

    #[test]
    fn trace_check_new_rejects_golden_with_bridge_unit_id_local_path_substring() {
        let mut golden = baseline_golden();
        golden[0].bridge_unit_id = "/home/leak/bridge".to_string();
        let error = TraceConformanceCheck::new(
            "utsushi-synthetic",
            golden,
            baseline_observed(),
            TraceCheckOptions::default(),
        )
        .expect_err("local-path bridge unit id rejected");
        assert!(matches!(
            error,
            ConformanceError::EvidenceRefInvalid {
                artifact_kind: "bridge_unit",
                ..
            }
        ));
    }

    #[test]
    fn trace_check_new_rejects_adapter_id_with_uppercase() {
        let error = TraceConformanceCheck::new(
            "Utsushi-Bad",
            baseline_golden(),
            baseline_observed(),
            TraceCheckOptions::default(),
        )
        .expect_err("uppercase adapter id rejected");
        assert!(matches!(error, ConformanceError::AdapterIdMalformed { .. }));
    }

    #[test]
    fn trace_check_run_passes_with_matching_traces() {
        let result = baseline_check().run();
        assert!(matches!(result, TraceCheckResult::Pass { .. }));
    }

    #[test]
    fn trace_check_run_pass_emits_evidence_for_every_observed_event() {
        let result = baseline_check().run();
        let TraceCheckResult::Pass { evidence_refs } = result else {
            panic!("expected Pass");
        };
        let text_lines = evidence_refs
            .iter()
            .filter(|e| matches!(e, EvidenceRef::TextLine { .. }))
            .count();
        assert_eq!(text_lines, 2, "one TextLine per observed event");
    }

    #[test]
    fn trace_check_run_pass_dedupes_bridge_unit_evidence_to_unique_ids() {
        let mut observed = baseline_observed();
        // Both observed events refer to the same bridge unit.
        observed[1].bridge_unit_id = Some(bridge_id("001"));
        let mut golden = baseline_golden();
        golden[1].bridge_unit_id = bridge_id("001");
        let check = TraceConformanceCheck::new(
            "utsushi-synthetic",
            golden,
            observed,
            TraceCheckOptions::default(),
        )
        .expect("constructs");
        let result = check.run();
        let TraceCheckResult::Pass { evidence_refs } = result else {
            panic!("expected Pass, got {result:?}");
        };
        let bridge_evidence: Vec<&str> = evidence_refs
            .iter()
            .filter_map(|e| match e {
                EvidenceRef::BridgeUnit { bridge_unit_id } => Some(bridge_unit_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            bridge_evidence.len(),
            1,
            "duplicate bridge units deduped: {bridge_evidence:?}"
        );
    }

    #[test]
    fn trace_check_run_pass_applies_collapse_whitespace_normalisation() {
        let golden = baseline_golden();
        let mut observed = baseline_observed();
        observed[0].text = "  Hello  ".to_string();
        let check = TraceConformanceCheck::new(
            "utsushi-synthetic",
            golden,
            observed,
            TraceCheckOptions {
                text_normalisation: TextNormalisation::CollapseWhitespace,
            },
        )
        .expect("constructs");
        assert!(matches!(check.run(), TraceCheckResult::Pass { .. }));
    }

    #[test]
    fn trace_check_run_fails_with_text_difference_mismatch() {
        let mut observed = baseline_observed();
        observed[1].text = "Different".to_string();
        let check = TraceConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            TraceCheckOptions::default(),
        )
        .expect("constructs");
        let TraceCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        assert!(
            mismatches
                .iter()
                .any(|m| matches!(m.kind, TraceMismatchKind::TextDifference)),
            "{mismatches:?}"
        );
    }

    #[test]
    fn trace_check_run_fails_with_order_shift_mismatch() {
        let mut observed = baseline_observed();
        observed[1].order_index = 99;
        let check = TraceConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            TraceCheckOptions::default(),
        )
        .expect("constructs");
        let TraceCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        assert!(
            mismatches
                .iter()
                .any(|m| matches!(m.kind, TraceMismatchKind::OrderShift))
        );
    }

    #[test]
    fn trace_check_run_fails_with_bridge_unit_unlinked_mismatch() {
        let mut observed = baseline_observed();
        observed[0].bridge_unit_id = None;
        let check = TraceConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            TraceCheckOptions::default(),
        )
        .expect("constructs");
        let TraceCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        assert!(
            mismatches
                .iter()
                .any(|m| matches!(m.kind, TraceMismatchKind::BridgeUnitUnlinked))
        );
    }

    #[test]
    fn trace_check_run_fails_with_bridge_unit_divergent_mismatch() {
        let mut observed = baseline_observed();
        observed[0].bridge_unit_id = Some(bridge_id("999"));
        let check = TraceConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            TraceCheckOptions::default(),
        )
        .expect("constructs");
        let TraceCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        assert!(
            mismatches
                .iter()
                .any(|m| matches!(m.kind, TraceMismatchKind::BridgeUnitDivergent))
        );
    }

    #[test]
    fn trace_check_run_fails_with_speaker_mismatch_when_golden_speaker_some() {
        let mut golden = baseline_golden();
        golden[0].speaker = Some("Akari".to_string());
        let observed = baseline_observed();
        let check = TraceConformanceCheck::new(
            "utsushi-synthetic",
            golden,
            observed,
            TraceCheckOptions::default(),
        )
        .expect("constructs");
        let TraceCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        assert!(
            mismatches
                .iter()
                .any(|m| matches!(m.kind, TraceMismatchKind::SpeakerMismatch))
        );
    }

    #[test]
    fn trace_check_run_passes_when_golden_speaker_none_regardless_of_observed_speaker() {
        let mut observed = baseline_observed();
        observed[0].speaker = Some("anything".to_string());
        let check = TraceConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            TraceCheckOptions::default(),
        )
        .expect("constructs");
        assert!(matches!(check.run(), TraceCheckResult::Pass { .. }));
    }

    #[test]
    fn trace_check_run_fails_with_missing_event_when_observed_shorter() {
        let mut observed = baseline_observed();
        observed.pop();
        let check = TraceConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            TraceCheckOptions::default(),
        )
        .expect("constructs");
        let TraceCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        assert!(
            mismatches
                .iter()
                .any(|m| matches!(m.kind, TraceMismatchKind::Missing))
        );
    }

    #[test]
    fn trace_check_run_fails_with_unexpected_event_when_observed_longer() {
        let mut observed = baseline_observed();
        observed.push(ObservedTextEvent {
            event_id: "o-extra".to_string(),
            bridge_unit_id: Some(bridge_id("003")),
            text: "Extra".to_string(),
            speaker: None,
            order_index: 2,
        });
        let check = TraceConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            TraceCheckOptions::default(),
        )
        .expect("constructs");
        let TraceCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        let unexpected = mismatches
            .iter()
            .find(|m| matches!(m.kind, TraceMismatchKind::Unexpected))
            .expect("Unexpected mismatch present");
        assert_eq!(unexpected.expected_event_id, BEYOND_GOLDEN_SENTINEL);
    }

    #[test]
    fn trace_check_run_collects_all_per_event_mismatches_not_only_the_first() {
        let mut observed = baseline_observed();
        observed[0].bridge_unit_id = Some(bridge_id("999"));
        observed[0].text = "Other".to_string();
        observed[0].order_index = 99;
        let check = TraceConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            TraceCheckOptions::default(),
        )
        .expect("constructs");
        let TraceCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        let kinds: std::collections::HashSet<TraceMismatchKind> =
            mismatches.iter().map(|m| m.kind).collect();
        assert!(kinds.contains(&TraceMismatchKind::BridgeUnitDivergent));
        assert!(kinds.contains(&TraceMismatchKind::OrderShift));
        assert!(kinds.contains(&TraceMismatchKind::TextDifference));
    }

    #[test]
    fn trace_check_run_orders_mismatches_by_golden_order_index() {
        let mut observed = baseline_observed();
        observed[0].text = "Bad-0".to_string();
        observed[1].text = "Bad-1".to_string();
        let check = TraceConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            TraceCheckOptions::default(),
        )
        .expect("constructs");
        let TraceCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        // First TextDifference references g-001, then g-002.
        let text_diffs: Vec<&TraceMismatch> = mismatches
            .iter()
            .filter(|m| matches!(m.kind, TraceMismatchKind::TextDifference))
            .collect();
        assert_eq!(text_diffs.len(), 2);
        assert_eq!(text_diffs[0].expected_event_id, "g-001");
        assert_eq!(text_diffs[1].expected_event_id, "g-002");
    }

    #[test]
    fn trace_mismatch_kind_to_code_is_exhaustive_over_enum_variants() {
        for kind in [
            TraceMismatchKind::TextDifference,
            TraceMismatchKind::OrderShift,
            TraceMismatchKind::BridgeUnitUnlinked,
            TraceMismatchKind::BridgeUnitDivergent,
            TraceMismatchKind::SpeakerMismatch,
            TraceMismatchKind::Missing,
            TraceMismatchKind::Unexpected,
        ] {
            let code = trace_mismatch_code(kind);
            assert!(code.starts_with("utsushi.conformance."));
        }
    }

    #[test]
    fn trace_mismatch_codes_are_all_members_of_codes_all() {
        let all: std::collections::HashSet<&'static str> = codes::ALL.iter().copied().collect();
        for kind in [
            TraceMismatchKind::TextDifference,
            TraceMismatchKind::OrderShift,
            TraceMismatchKind::BridgeUnitUnlinked,
            TraceMismatchKind::BridgeUnitDivergent,
            TraceMismatchKind::SpeakerMismatch,
            TraceMismatchKind::Missing,
            TraceMismatchKind::Unexpected,
        ] {
            assert!(all.contains(trace_mismatch_code(kind)));
        }
    }

    #[test]
    fn trace_mismatch_detail_truncates_at_256_bytes() {
        let long_text: String = "a".repeat(1024);
        let detail = format!("expected text {long_text:?} observed {long_text:?}");
        let mismatch = TraceMismatch::new(
            TraceMismatchKind::TextDifference,
            "g-001",
            Some("o-001"),
            detail,
        );
        assert!(mismatch.detail.len() <= TRACE_MISMATCH_DETAIL_BYTE_CAP);
    }

    #[test]
    fn trace_mismatch_detail_rejects_local_path_substring() {
        let detail = "expected /home/user/leak observed nothing".to_string();
        let mismatch = TraceMismatch::new(
            TraceMismatchKind::TextDifference,
            "g-001",
            Some("o-001"),
            detail,
        );
        assert!(!mismatch.detail.contains("/home/"));
    }

    #[test]
    fn trace_check_unexpected_mismatch_uses_documented_sentinel_event_id() {
        assert_eq!(BEYOND_GOLDEN_SENTINEL, "<beyond-golden>");
    }

    #[test]
    fn trace_into_conformance_result_emits_pass_with_text_line_evidence() {
        let result = baseline_check().run();
        let lowered = result
            .into_conformance_result(
                "utsushi-synthetic",
                EvidenceTier::E1,
                "2026-06-23T12:00:00Z",
            )
            .expect("lowers");
        assert_eq!(lowered.profile_id, ProfileId::TextTrace);
        assert!(matches!(lowered.outcome, ResultOutcome::Pass { .. }));
    }

    #[test]
    fn trace_into_conformance_result_rejects_evidence_tier_above_e1() {
        let result = baseline_check().run();
        let error = result
            .into_conformance_result(
                "utsushi-synthetic",
                EvidenceTier::E2,
                "2026-06-23T12:00:00Z",
            )
            .expect_err("rejects tier above ceiling");
        assert!(matches!(
            error,
            ConformanceError::EvidenceTierAboveProfileCeiling { .. }
        ));
    }

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
