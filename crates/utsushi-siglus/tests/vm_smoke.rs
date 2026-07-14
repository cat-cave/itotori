//! Siglus VM text-trace smoke integration test.
//!
//! Proves the acceptance criteria:
//!
//! 1. The synthetic fixture emits **text** + **VM-state** evidence through the
//!    Utsushi runtime-evidence contracts at the E1 admission tier.
//! 2. The smoke consumes local-only key references (secret-refs) with **NO** raw
//!    key material serialized (asserted against the raw key bytes AND their hex).
//! 3. Reject-before-claim: a required-unresolved key posture emits no evidence.
//! 4. The implementation map names concrete Siglus follow-ups without claiming
//!    broad compatibility (no `Supported` subsystem; validates + promotes).

use std::fmt::Write as _;

use utsushi_core::EvidenceTier;
use utsushi_core::port::impl_map::{Status, SubsystemStatus, validate_and_promote};

use utsushi_siglus::vm::{
    VM_TRACE_SMOKE_CAPABILITY_ID, VmError, VmTraceEvidence, fixture_local_key_trace,
    fixture_no_key_trace, fixture_required_unresolved_trace, run_vm_trace_smoke,
    synthetic_local_key_for_test_assertions,
};
use utsushi_siglus::vm_impl_map::build_siglus_vm_impl_map;

/// The synthetic descrambled dialogue must appear in the emitted evidence — the
/// text-evidence side of the contract.
const EXPECTED_LINE: &str = "[synthetic-siglus-vm-line-1]";

#[test]
fn no_key_fixture_emits_text_and_vm_state_evidence_at_e1() {
    let evidence = run_vm_trace_smoke(&fixture_no_key_trace()).expect("no-key smoke runs");

    assert_eq!(evidence.evidence_tier, EvidenceTier::E1);
    assert_eq!(evidence.capability_id, VM_TRACE_SMOKE_CAPABILITY_ID);
    assert_eq!(evidence.source_node_id, VmTraceEvidence::SOURCE_NODE_ID);
    assert_eq!(evidence.key_class, "no-key");
    assert!(
        evidence.key_reference.is_none(),
        "no-key carries no key ref"
    );

    // Text evidence: two EmitText ops -> two E1 lines, all at E1.
    assert_eq!(evidence.text_lines.len(), 2);
    assert!(
        evidence
            .text_lines
            .iter()
            .all(|line| line.evidence_tier == EvidenceTier::E1)
    );
    assert!(
        evidence
            .text_lines
            .iter()
            .any(|line| line.text == EXPECTED_LINE),
        "descrambled dialogue must surface as text evidence"
    );

    // VM-state evidence: the captured snapshot carries the flag + int banks + PC.
    let state_tree = evidence
        .vm_state
        .get("stateTree")
        .expect("snapshot carries a stateTree");
    assert!(
        state_tree.get("port.halted").is_some(),
        "VM-state evidence exposes the halted flag"
    );
    assert!(
        state_tree.get("port.flag.intro-seen").is_some(),
        "VM-state evidence exposes the flag bank"
    );
    assert!(
        state_tree.get("port.int.affection").is_some(),
        "VM-state evidence exposes the variable bank"
    );

    // The whole claim passes the substrate redaction sweep.
    evidence
        .stable_json()
        .expect("no-key evidence is redaction-clean");
}

#[test]
fn local_key_fixture_consumes_secret_ref_without_serializing_raw_key() {
    let evidence = run_vm_trace_smoke(&fixture_local_key_trace()).expect("local-key smoke runs");

    assert_eq!(evidence.key_class, "local-key");
    let key_ref = evidence
        .key_reference
        .as_ref()
        .expect("local-key carries a key reference");
    assert_eq!(
        key_ref.secret_ref.as_str(),
        "local-secret:siglus.vm.local-key.v1"
    );
    assert_eq!(key_ref.key_byte_len, 16);

    // The descrambled dialogue still surfaces (the key was actually consumed).
    assert!(
        evidence
            .text_lines
            .iter()
            .any(|line| line.text == EXPECTED_LINE)
    );

    let json = evidence
        .stable_json()
        .expect("local-key evidence is redaction-clean");

    // The one-way key commitment IS present; the raw key bytes are NOT.
    assert!(
        json.contains(key_ref.key_commitment.as_str()),
        "the one-way key commitment must be present in the evidence"
    );

    let raw_key = synthetic_local_key_for_test_assertions();
    // Raw byte window absent.
    assert!(
        !json.as_bytes().windows(raw_key.len()).any(|w| w == raw_key),
        "raw key bytes must NOT appear in serialized evidence"
    );
    // Hex encoding of the raw key absent (defence in depth).
    let raw_key_hex = raw_key.iter().fold(String::new(), |mut acc, byte| {
        let _ = write!(acc, "{byte:02x}");
        acc
    });
    assert!(
        !json.contains(&raw_key_hex),
        "hex-encoded raw key must NOT appear in serialized evidence"
    );
    // The secret-ref name string is present (the reference is what we carry).
    assert!(json.contains("local-secret:siglus.vm.local-key.v1"));
}

#[test]
fn required_unresolved_posture_is_rejected_before_any_evidence() {
    let error = run_vm_trace_smoke(&fixture_required_unresolved_trace())
        .expect_err("required-unresolved must reject");
    match error {
        VmError::RequiredKeyUnresolved { secret_ref, .. } => {
            assert_eq!(
                secret_ref.as_str(),
                "local-secret:siglus.vm.required-key.v1"
            );
        }
        other => panic!("expected RequiredKeyUnresolved, got {other:?}"),
    }
}

#[test]
fn smoke_is_deterministic() {
    let first = run_vm_trace_smoke(&fixture_local_key_trace()).expect("run 1");
    let second = run_vm_trace_smoke(&fixture_local_key_trace()).expect("run 2");
    assert_eq!(
        first.stable_json().expect("json 1"),
        second.stable_json().expect("json 2"),
        "the smoke must be byte-for-byte deterministic"
    );
}

#[test]
fn impl_map_names_concrete_follow_ups_without_overclaiming() {
    let mut map = build_siglus_vm_impl_map();

    // No subsystem overclaims `Supported` on the first smoke.
    for subsystem in &map.subsystems {
        assert!(
            !matches!(subsystem.status, SubsystemStatus::Supported),
            "subsystem {} must not claim Supported",
            subsystem.id.as_str()
        );
    }

    // The concrete real-VM follow-ups are all present as Research subsystems.
    let ids: Vec<&str> = map.subsystems.iter().map(|s| s.id.as_str()).collect();
    for expected in [
        "scene-pck-bytecode-decode",
        "siglus-opcode-dispatch",
        "siglus-string-table-utf16",
        "gameexe-namespace-resolution",
        "siglus-lzss-decompression",
        "siglus-flag-and-variable-banks",
        "siglus-selbtn-choices",
    ] {
        assert!(
            ids.contains(&expected),
            "follow-up {expected} must be named"
        );
    }

    // Validates + promotes (stamps the audit disclaimer).
    let report = validate_and_promote(&mut map).expect("impl map validates");
    assert_eq!(map.status, Status::Validated);
    assert_eq!(report.schema_version, "0.1.0");
}
