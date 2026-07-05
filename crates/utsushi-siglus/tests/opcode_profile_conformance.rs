//! UTSUSHI-036 — integration coverage for the Siglus **opcode-profile
//! scaffold**: the declared manifest, the one golden text-show fixture, the
//! unsupported-opcode diagnostics (no silent pass), and the committed
//! conformance-result fixture.
//!
//! The three `GOLDEN_*` constants are the **committed conformance-result
//! fixtures**: the exact redaction-swept JSON the scaffold emits for the
//! declared manifest and for a covered / unknown run. Because the synthetic
//! program bytes are fixed module constants, the digests (and therefore the
//! whole JSON) are deterministic — any drift in the profile, the runner, or the
//! serialization breaks these assertions.

use utsushi_siglus::opcode_profile::{
    DispatchKind, OpcodeConformanceResult, OpcodeId, OpcodeSupport, UnsupportedBehavior,
    UnsupportedOpcodeDiagnostic, canonical_opcode_profile, fixture_declared_unsupported_program,
    fixture_text_show_program, fixture_unknown_opcode_program, run_opcode_conformance,
};

/// Committed golden: the DECLARED opcode-profile manifest (the coverage surface,
/// before any run).
const GOLDEN_MANIFEST_JSON: &str = r#"{"capabilityId":"utsushi-siglus-opcode-profile","entries":[{"mnemonic":"text.show","opcode":1,"support":{"status":"covered"}},{"mnemonic":"grp.load","opcode":64,"support":{"reason":"graphics-surface dispatch is Research scope (siglus-opcode-dispatch)","status":"declared-unsupported"}}],"profileId":"siglus-opcode-profile-text-show-v1","schemaVersion":"0.1.0","supportBoundary":"Utsushi Siglus opcode profile DECLARES — before any opcode is dispatched — which SYNTHETIC (authored, NOT the real Siglus opcode table) opcodes the scaffold runner covers, which it names-but-refuses (declared-unsupported), and that any opcode outside the declared surface surfaces a structured diagnostic and halts (never a silent skip). A covered opcode produces a deterministic golden trace at the E1 admission tier. It does NOT claim real Siglus opcode-table coverage, real Scene.pck decode, or a rendered frame; the real opcode table is the siglus-opcode-dispatch Research subsystem.","unknownOpcodeBehavior":"surface-diagnostic-and-halt"}"#;

/// Committed golden: the conformance result for the one covered text-show
/// fixture (the golden trace).
const GOLDEN_TEXT_SHOW_JSON: &str = r#"{"capabilityId":"utsushi-siglus-opcode-profile","declaredCoverage":[{"mnemonic":"text.show","opcode":1,"support":{"status":"covered"}},{"mnemonic":"grp.load","opcode":64,"support":{"reason":"graphics-surface dispatch is Research scope (siglus-opcode-dispatch)","status":"declared-unsupported"}}],"evidenceTier":"E1","haltedOnUnsupported":false,"profileId":"siglus-opcode-profile-text-show-v1","programDigest":"dd2e388cc6b602566ba1e3eab56eca092876bf3eac18b6f6cbf641e36b5de076","schemaVersion":"0.1.0","sourceNodeId":"UTSUSHI-036","supportBoundary":"Utsushi Siglus opcode profile DECLARES — before any opcode is dispatched — which SYNTHETIC (authored, NOT the real Siglus opcode table) opcodes the scaffold runner covers, which it names-but-refuses (declared-unsupported), and that any opcode outside the declared surface surfaces a structured diagnostic and halts (never a silent skip). A covered opcode produces a deterministic golden trace at the E1 admission tier. It does NOT claim real Siglus opcode-table coverage, real Scene.pck decode, or a rendered frame; the real opcode table is the siglus-opcode-dispatch Research subsystem.","trace":[{"index":0,"kind":{"emitted_text":"[synthetic-siglus-opcode-text-0]","mnemonic":"text.show","outcome":"dispatched"},"opcode":1}],"unsupportedEncountered":[]}"#;

/// Committed golden: the conformance result for the unknown-opcode fixture —
/// the diagnostic is VISIBLE (`unsupportedEncountered` non-empty), the run
/// halted, and the trace records the refusal (no silent pass).
const GOLDEN_UNKNOWN_JSON: &str = r#"{"capabilityId":"utsushi-siglus-opcode-profile","declaredCoverage":[{"mnemonic":"text.show","opcode":1,"support":{"status":"covered"}},{"mnemonic":"grp.load","opcode":64,"support":{"reason":"graphics-surface dispatch is Research scope (siglus-opcode-dispatch)","status":"declared-unsupported"}}],"evidenceTier":"E1","haltedOnUnsupported":true,"profileId":"siglus-opcode-profile-text-show-v1","programDigest":"9423b17599b433df2edfd6e8cc9e2ce7ce38c9a6dbf42f6a2dcfb648ff47990f","schemaVersion":"0.1.0","sourceNodeId":"UTSUSHI-036","supportBoundary":"Utsushi Siglus opcode profile DECLARES — before any opcode is dispatched — which SYNTHETIC (authored, NOT the real Siglus opcode table) opcodes the scaffold runner covers, which it names-but-refuses (declared-unsupported), and that any opcode outside the declared surface surfaces a structured diagnostic and halts (never a silent skip). A covered opcode produces a deterministic golden trace at the E1 admission tier. It does NOT claim real Siglus opcode-table coverage, real Scene.pck decode, or a rendered frame; the real opcode table is the siglus-opcode-dispatch Research subsystem.","trace":[{"index":0,"kind":{"outcome":"not-in-profile"},"opcode":238}],"unsupportedEncountered":[{"code":"notInProfile","index":0,"opcode":238,"profile_id":"siglus-opcode-profile-text-show-v1"}]}"#;

#[test]
fn manifest_matches_committed_golden() {
    let manifest = canonical_opcode_profile()
        .stable_json()
        .expect("manifest serializes");
    assert_eq!(
        manifest, GOLDEN_MANIFEST_JSON,
        "opcode-profile manifest drifted from the committed golden"
    );
}

#[test]
fn text_show_conformance_matches_committed_golden() {
    let profile = canonical_opcode_profile();
    let json = run_opcode_conformance(&profile, &fixture_text_show_program())
        .stable_json()
        .expect("golden conformance serializes");
    assert_eq!(
        json, GOLDEN_TEXT_SHOW_JSON,
        "text-show conformance result drifted from the committed golden"
    );
}

#[test]
fn unknown_opcode_conformance_matches_committed_golden() {
    let profile = canonical_opcode_profile();
    let json = run_opcode_conformance(&profile, &fixture_unknown_opcode_program())
        .stable_json()
        .expect("unknown conformance serializes");
    assert_eq!(
        json, GOLDEN_UNKNOWN_JSON,
        "unknown-opcode conformance result drifted from the committed golden"
    );
}

#[test]
fn coverage_is_declared_before_run_not_discovered() {
    // The unknown-opcode program presents opcode 0xEE, which the profile never
    // declares. The declared-coverage surface in the result must still be the
    // profile's two pre-declared entries — the run never grows coverage from the
    // program it walked.
    let profile = canonical_opcode_profile();
    let result: OpcodeConformanceResult =
        run_opcode_conformance(&profile, &fixture_unknown_opcode_program());
    assert_eq!(result.declared_coverage.len(), 2);
    assert!(
        result
            .declared_coverage
            .iter()
            .all(|declared| declared.opcode != OpcodeId(0xEE)),
        "an undeclared opcode must never enter the declared coverage surface"
    );
}

#[test]
fn declared_unsupported_opcode_surfaces_diagnostic_not_silent_pass() {
    let profile = canonical_opcode_profile();
    let result = run_opcode_conformance(&profile, &fixture_declared_unsupported_program());

    // The crux: an unsupported opcode CANNOT pass silently. The result must
    // carry a structured diagnostic and record the refusal in the trace.
    assert!(
        result.halted_on_unsupported,
        "a declared-unsupported opcode must halt the run"
    );
    assert_eq!(
        result.unsupported_encountered.len(),
        1,
        "the diagnostic must be VISIBLE in the conformance output"
    );
    match &result.unsupported_encountered[0] {
        UnsupportedOpcodeDiagnostic::DeclaredUnsupported {
            opcode, mnemonic, ..
        } => {
            assert_eq!(*opcode, OpcodeId(0x40));
            assert_eq!(mnemonic, "grp.load");
        }
        other @ UnsupportedOpcodeDiagnostic::NotInProfile { .. } => {
            panic!("expected DeclaredUnsupported diagnostic, got {other:?}")
        }
    }
    assert_eq!(
        result.trace[0].kind,
        DispatchKind::DeclaredUnsupported {
            mnemonic: "grp.load".to_string(),
        },
        "the refusal must be recorded in the trace, not skipped",
    );
    // The diagnostic renders a human-readable, structured message (thiserror).
    let rendered = result.unsupported_encountered[0].to_string();
    assert!(
        rendered.contains("no silent skip"),
        "diagnostic message must state the no-silent-skip law: {rendered}"
    );
}

#[test]
fn unsupported_behavior_has_no_silent_skip_variant() {
    // Type-level proof of the substrate law: the ONLY declared reaction to an
    // unsupported opcode is to surface a diagnostic and halt. There is no
    // silent-skip variant to select.
    let profile = canonical_opcode_profile();
    assert_eq!(
        profile.unknown_opcode_behavior,
        UnsupportedBehavior::SurfaceDiagnosticAndHalt,
        "the only declared unsupported reaction is surface-diagnostic-and-halt"
    );
    // Covered-opcode support is distinct from unsupported.
    assert!(
        matches!(
            profile
                .entry(OpcodeId(0x01))
                .expect("text.show declared")
                .support,
            OpcodeSupport::Covered
        ),
        "text.show must be declared Covered"
    );
}
