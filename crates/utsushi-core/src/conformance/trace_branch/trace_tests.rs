use super::*;

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
