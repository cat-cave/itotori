use super::*;

#[test]
fn profile_declares_coverage_before_any_run() {
    // The manifest is fully declared without running anything: two entries
    // one Covered, one DeclaredUnsupported, plus a non-silent unknown policy.
    let profile = canonical_opcode_profile();
    assert_eq!(profile.entries.len(), 2, "narrow scaffold: exactly two");
    assert!(
        profile
            .entry(OpcodeId(OPC_TEXT_SHOW))
            .unwrap()
            .support
            .is_covered(),
        "text.show is covered"
    );
    assert!(
        matches!(
            profile.entry(OpcodeId(OPC_GRP_LOAD)).unwrap().support,
            OpcodeSupport::DeclaredUnsupported { .. }
        ),
        "grp.load is declared-unsupported"
    );
    // The manifest serializes as committable evidence.
    assert!(profile.stable_json().is_ok());
}

#[test]
fn golden_text_show_produces_the_golden_trace() {
    let profile = canonical_opcode_profile();
    let result = run_opcode_conformance(&profile, &fixture_text_show_program());

    assert_eq!(
        result.source_node_id,
        OpcodeConformanceResult::SOURCE_NODE_ID
    );
    assert_eq!(result.evidence_tier, EvidenceTier::E1);
    assert!(!result.halted_on_unsupported, "covered run does not halt");
    assert!(
        result.unsupported_encountered.is_empty(),
        "covered run has no unsupported diagnostics"
    );
    // The golden trace: exactly one dispatched text.show emitting the
    // synthetic line.
    assert_eq!(result.trace.len(), 1);
    assert_eq!(
        result.trace[0].kind,
        DispatchKind::Dispatched {
            mnemonic: "text.show".to_string(),
            emitted_text: Some(FIXTURE_TEXT_SHOW_PAYLOAD.to_string()),
        }
    );
    // Declared coverage is echoed from the profile (both entries), not
    // rebuilt from the one-opcode program.
    assert_eq!(
        result.declared_coverage.len(),
        2,
        "declared coverage is the pre-run profile surface, not the program"
    );
}

#[test]
fn golden_trace_is_deterministic() {
    let profile = canonical_opcode_profile();
    let first = run_opcode_conformance(&profile, &fixture_text_show_program())
        .stable_json()
        .expect("golden serializes");
    let second = run_opcode_conformance(&profile, &fixture_text_show_program())
        .stable_json()
        .expect("golden serializes");
    assert_eq!(first, second, "golden conformance JSON is deterministic");
}

#[test]
fn declared_unsupported_opcode_cannot_pass_silently() {
    let profile = canonical_opcode_profile();
    let result = run_opcode_conformance(&profile, &fixture_declared_unsupported_program());

    // NOT a silent success: the diagnostic is present and the run halted.
    assert!(result.halted_on_unsupported, "unsupported opcode halts");
    assert_eq!(result.unsupported_encountered.len(), 1);
    assert!(matches!(
        result.unsupported_encountered[0],
        UnsupportedOpcodeDiagnostic::DeclaredUnsupported { .. }
    ));
    // The trace records the refusal explicitly — the opcode is NOT absent.
    assert_eq!(
        result.trace[0].kind,
        DispatchKind::DeclaredUnsupported {
            mnemonic: "grp.load".to_string(),
        }
    );
}

#[test]
fn unknown_opcode_cannot_pass_silently() {
    let profile = canonical_opcode_profile();
    let result = run_opcode_conformance(&profile, &fixture_unknown_opcode_program());

    // An opcode the profile never declared must surface a diagnostic, not a
    // silent success.
    assert!(result.halted_on_unsupported);
    assert_eq!(result.unsupported_encountered.len(), 1);
    match &result.unsupported_encountered[0] {
        UnsupportedOpcodeDiagnostic::NotInProfile { opcode, .. } => {
            assert_eq!(*opcode, OpcodeId(0xEE));
        }
        other @ UnsupportedOpcodeDiagnostic::DeclaredUnsupported { .. } => {
            panic!("expected NotInProfile diagnostic, got {other:?}")
        }
    }
    assert_eq!(result.trace[0].kind, DispatchKind::NotInProfile);
    // The undeclared opcode is NOT added to the declared coverage surface.
    assert!(
        !result
            .declared_coverage
            .iter()
            .any(|declared| declared.opcode == OpcodeId(0xEE)),
        "an undeclared opcode must never join the declared coverage surface"
    );
}
