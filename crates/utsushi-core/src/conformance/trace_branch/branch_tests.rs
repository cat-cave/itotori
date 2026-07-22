use super::*;

fn baseline_golden() -> Vec<GoldenBranch> {
    vec![
        GoldenBranch {
            branch_id: "branch-001".to_string(),
            choice_index_path: vec![ChoiceIndex(0), ChoiceIndex(1)],
            expected_outcome: "happy_end".to_string(),
        },
        GoldenBranch {
            branch_id: "branch-002".to_string(),
            choice_index_path: vec![ChoiceIndex(1), ChoiceIndex(0)],
            expected_outcome: "true_route".to_string(),
        },
        GoldenBranch {
            branch_id: "branch-003".to_string(),
            choice_index_path: vec![ChoiceIndex(0), ChoiceIndex(0), ChoiceIndex(2)],
            expected_outcome: "branch_to_chapter_2".to_string(),
        },
    ]
}

fn baseline_observed() -> Vec<ObservedBranch> {
    vec![
        ObservedBranch {
            branch_id: "branch-001".to_string(),
            choice_index_path: vec![ChoiceIndex(0), ChoiceIndex(1)],
            observed_outcome: "happy_end".to_string(),
        },
        ObservedBranch {
            branch_id: "branch-002".to_string(),
            choice_index_path: vec![ChoiceIndex(1), ChoiceIndex(0)],
            observed_outcome: "true_route".to_string(),
        },
        ObservedBranch {
            branch_id: "branch-003".to_string(),
            choice_index_path: vec![ChoiceIndex(0), ChoiceIndex(0), ChoiceIndex(2)],
            observed_outcome: "branch_to_chapter_2".to_string(),
        },
    ]
}

fn baseline_check() -> BranchConformanceCheck {
    BranchConformanceCheck::new(
        "utsushi-synthetic",
        baseline_golden(),
        baseline_observed(),
        BranchCheckOptions::default(),
    )
    .expect("baseline constructs")
}

#[test]
fn branch_check_new_accepts_well_formed_input() {
    baseline_check();
}

#[test]
fn branch_check_new_rejects_empty_golden_branches() {
    let error = BranchConformanceCheck::new(
        "utsushi-synthetic",
        Vec::new(),
        Vec::new(),
        BranchCheckOptions::default(),
    )
    .expect_err("empty golden rejected");
    assert!(matches!(
        error,
        ConformanceError::EvidenceRefInvalid {
            artifact_kind: "branch",
            ..
        }
    ));
}

#[test]
fn branch_check_new_rejects_duplicate_golden_branch_id() {
    let mut golden = baseline_golden();
    golden[1].branch_id = golden[0].branch_id.clone();
    let error = BranchConformanceCheck::new(
        "utsushi-synthetic",
        golden,
        baseline_observed(),
        BranchCheckOptions::default(),
    )
    .expect_err("duplicate rejected");
    assert!(matches!(
        error,
        ConformanceError::EvidenceRefInvalid {
            artifact_kind: "branch",
            ..
        }
    ));
}

#[test]
fn branch_check_new_rejects_empty_choice_path_in_golden() {
    let mut golden = baseline_golden();
    golden[0].choice_index_path.clear();
    let error = BranchConformanceCheck::new(
        "utsushi-synthetic",
        golden,
        baseline_observed(),
        BranchCheckOptions::default(),
    )
    .expect_err("empty path rejected");
    assert!(matches!(
        error,
        ConformanceError::EvidenceRefInvalid {
            artifact_kind: "branch",
            ..
        }
    ));
}

#[test]
fn branch_check_new_rejects_outcome_label_with_uppercase() {
    let mut golden = baseline_golden();
    golden[0].expected_outcome = "BadOutcome".to_string();
    let error = BranchConformanceCheck::new(
        "utsushi-synthetic",
        golden,
        baseline_observed(),
        BranchCheckOptions::default(),
    )
    .expect_err("uppercase outcome rejected");
    assert!(matches!(
        error,
        ConformanceError::EvidenceRefInvalid {
            artifact_kind: "branch",
            ..
        }
    ));
}

#[test]
fn branch_check_run_passes_with_matching_branches_in_same_order() {
    assert!(matches!(
        baseline_check().run(),
        BranchCheckResult::Pass { .. }
    ));
}

#[test]
fn branch_check_run_passes_with_matching_branches_in_reversed_order() {
    let mut observed = baseline_observed();
    observed.reverse();
    let check = BranchConformanceCheck::new(
        "utsushi-synthetic",
        baseline_golden(),
        observed,
        BranchCheckOptions::default(),
    )
    .expect("constructs");
    assert!(matches!(check.run(), BranchCheckResult::Pass { .. }));
}

#[test]
fn branch_check_run_pass_emits_replay_log_ref_when_options_set() {
    let check = BranchConformanceCheck::new(
        "utsushi-synthetic",
        baseline_golden(),
        baseline_observed(),
        BranchCheckOptions {
            replay_log_run_id: Some("run-001".to_string()),
        },
    )
    .expect("constructs");
    let BranchCheckResult::Pass { evidence_refs } = check.run() else {
        panic!("expected Pass");
    };
    assert!(
        evidence_refs
            .iter()
            .any(|e| matches!(e, EvidenceRef::ReplayLogRef { .. })),
        "{evidence_refs:?}"
    );
}

#[test]
fn branch_check_run_pass_omits_replay_log_ref_when_options_none() {
    let BranchCheckResult::Pass { evidence_refs } = baseline_check().run() else {
        panic!("expected Pass");
    };
    assert!(
        !evidence_refs
            .iter()
            .any(|e| matches!(e, EvidenceRef::ReplayLogRef { .. }))
    );
}

#[test]
fn branch_check_run_fails_with_missing_branch() {
    let mut observed = baseline_observed();
    observed.pop();
    let check = BranchConformanceCheck::new(
        "utsushi-synthetic",
        baseline_golden(),
        observed,
        BranchCheckOptions::default(),
    )
    .expect("constructs");
    let BranchCheckResult::Fail { mismatches, .. } = check.run() else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, BranchMismatchKind::Missing))
    );
}

#[test]
fn branch_check_run_fails_with_unexpected_branch() {
    let mut observed = baseline_observed();
    observed.push(ObservedBranch {
        branch_id: "branch-extra".to_string(),
        choice_index_path: vec![ChoiceIndex(9)],
        observed_outcome: "extra".to_string(),
    });
    let check = BranchConformanceCheck::new(
        "utsushi-synthetic",
        baseline_golden(),
        observed,
        BranchCheckOptions::default(),
    )
    .expect("constructs");
    let BranchCheckResult::Fail { mismatches, .. } = check.run() else {
        panic!("expected Fail");
    };
    let unexpected = mismatches
        .iter()
        .find(|m| matches!(m.kind, BranchMismatchKind::Unexpected))
        .expect("Unexpected present");
    assert_eq!(unexpected.expected_branch_id, UNKNOWN_GOLDEN_SENTINEL);
}

#[test]
fn branch_check_run_fails_with_choice_path_divergence_on_length() {
    let mut observed = baseline_observed();
    observed[0].choice_index_path.push(ChoiceIndex(5));
    let check = BranchConformanceCheck::new(
        "utsushi-synthetic",
        baseline_golden(),
        observed,
        BranchCheckOptions::default(),
    )
    .expect("constructs");
    let BranchCheckResult::Fail { mismatches, .. } = check.run() else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, BranchMismatchKind::ChoicePathDivergent))
    );
}

#[test]
fn branch_check_run_fails_with_choice_path_divergence_on_element() {
    let mut observed = baseline_observed();
    observed[0].choice_index_path[0] = ChoiceIndex(99);
    let check = BranchConformanceCheck::new(
        "utsushi-synthetic",
        baseline_golden(),
        observed,
        BranchCheckOptions::default(),
    )
    .expect("constructs");
    let BranchCheckResult::Fail { mismatches, .. } = check.run() else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, BranchMismatchKind::ChoicePathDivergent))
    );
}

#[test]
fn branch_check_run_fails_with_outcome_difference() {
    let mut observed = baseline_observed();
    observed[0].observed_outcome = "other_end".to_string();
    let check = BranchConformanceCheck::new(
        "utsushi-synthetic",
        baseline_golden(),
        observed,
        BranchCheckOptions::default(),
    )
    .expect("constructs");
    let BranchCheckResult::Fail { mismatches, .. } = check.run() else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, BranchMismatchKind::OutcomeDifference))
    );
}

#[test]
fn branch_check_run_collects_all_mismatches_not_only_the_first() {
    let mut observed = baseline_observed();
    observed[0].choice_index_path[0] = ChoiceIndex(99);
    observed[0].observed_outcome = "other_end".to_string();
    observed.pop(); // remove branch-003
    observed.push(ObservedBranch {
        branch_id: "branch-extra".to_string(),
        choice_index_path: vec![ChoiceIndex(0)],
        observed_outcome: "extra".to_string(),
    });
    let check = BranchConformanceCheck::new(
        "utsushi-synthetic",
        baseline_golden(),
        observed,
        BranchCheckOptions::default(),
    )
    .expect("constructs");
    let BranchCheckResult::Fail { mismatches, .. } = check.run() else {
        panic!("expected Fail");
    };
    let kinds: std::collections::HashSet<BranchMismatchKind> =
        mismatches.iter().map(|m| m.kind).collect();
    assert!(kinds.contains(&BranchMismatchKind::ChoicePathDivergent));
    assert!(kinds.contains(&BranchMismatchKind::OutcomeDifference));
    assert!(kinds.contains(&BranchMismatchKind::Missing));
    assert!(kinds.contains(&BranchMismatchKind::Unexpected));
}

#[test]
fn branch_mismatch_kind_to_code_is_exhaustive_over_enum_variants() {
    for kind in [
        BranchMismatchKind::Missing,
        BranchMismatchKind::Unexpected,
        BranchMismatchKind::ChoicePathDivergent,
        BranchMismatchKind::OutcomeDifference,
    ] {
        let code = branch_mismatch_code(kind);
        assert!(code.starts_with("utsushi.conformance."));
    }
}

#[test]
fn branch_mismatch_codes_are_all_members_of_codes_all() {
    let all: std::collections::HashSet<&'static str> = codes::ALL.iter().copied().collect();
    for kind in [
        BranchMismatchKind::Missing,
        BranchMismatchKind::Unexpected,
        BranchMismatchKind::ChoicePathDivergent,
        BranchMismatchKind::OutcomeDifference,
    ] {
        assert!(all.contains(branch_mismatch_code(kind)));
    }
}

#[test]
fn branch_into_conformance_result_emits_pass_with_bridge_unit_evidence() {
    let result = baseline_check().run();
    let lowered = result
        .into_conformance_result(
            "utsushi-synthetic",
            EvidenceTier::E1,
            "2026-06-23T12:00:00Z",
        )
        .expect("lowers");
    assert_eq!(lowered.profile_id, ProfileId::BranchCapture);
    assert!(matches!(lowered.outcome, ResultOutcome::Pass { .. }));
    assert!(
        lowered
            .evidence
            .iter()
            .any(|e| matches!(e, EvidenceRef::BridgeUnit { .. }))
    );
}

#[test]
fn branch_into_conformance_result_rejects_evidence_tier_above_e1() {
    let result = baseline_check().run();
    let error = result
        .into_conformance_result(
            "utsushi-synthetic",
            EvidenceTier::E2,
            "2026-06-23T12:00:00Z",
        )
        .expect_err("rejected");
    assert!(matches!(
        error,
        ConformanceError::EvidenceTierAboveProfileCeiling { .. }
    ));
}

#[test]
fn branch_into_conformance_result_rejects_screenshot_runtime_artifact() {
    let uri =
        crate::runtime_artifact_uri("synthetic-run", RuntimeArtifactKind::Screenshot, "shot-001")
            .expect("uri");
    let result = BranchCheckResult::Pass {
        evidence_refs: vec![EvidenceRef::RuntimeArtifact {
            kind: RuntimeArtifactKind::Screenshot,
            uri,
            artifact_id: Some("shot-001".to_string()),
        }],
    };
    let error = result
        .into_conformance_result(
            "utsushi-synthetic",
            EvidenceTier::E1,
            "2026-06-23T12:00:00Z",
        )
        .expect_err("rejected");
    assert!(matches!(
        error,
        ConformanceError::MalformedSemanticCode { ref code, .. }
            if code == codes::TRACE_EVIDENCE_TIER_OVERCLAIM
    ));
}

#[test]
fn branch_pass_result_round_trips_through_conformance_schema_v0_1() {
    let lowered = baseline_check()
        .run()
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
fn accepts_branch_capture_evidence_rejects_frame_artifact() {
    let evidence = EvidenceRef::FrameArtifactRef {
        frame_id: "frame-1".to_string(),
    };
    assert!(!accepts_branch_capture_evidence(&evidence));
}
