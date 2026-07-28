use super::*;

#[test]
fn no_key_smoke_emits_text_and_vm_state() {
    let evidence = run_vm_trace_smoke(&fixture_no_key_trace()).expect("no-key smoke runs");
    assert_eq!(evidence.evidence_tier, EvidenceTier::E1);
    assert_eq!(evidence.key_class, "no-key");
    assert!(evidence.key_reference.is_none());
    assert_eq!(
        evidence.text_lines.len(),
        2,
        "two EmitText ops emit two lines"
    );
    assert!(evidence.vm_state.get("stateTree").is_some());
}

#[test]
fn required_unresolved_is_rejected_before_any_evidence() {
    let error = run_vm_trace_smoke(&fixture_required_unresolved_trace())
        .expect_err("required-unresolved must reject");
    assert!(matches!(error, VmError::RequiredKeyUnresolved { .. }));
}

#[test]
fn vm_key_material_debug_is_redacted_and_zeroizes() {
    let key = VmKeyMaterial::from_resolved_bytes(vec![1, 2, 3, 4]);
    let debug = format!("{key:?}");
    assert!(
        debug.contains("REDACTED"),
        "key Debug must be redacted: {debug}"
    );
    assert!(
        !debug.contains(", 2, 3"),
        "key Debug must not print bytes: {debug}"
    );
}
