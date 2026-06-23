//! Integration tests for [`utsushi_core::cross_validate_results_against_manifest`]
//! and [`utsushi_core::cross_validate_conformance_manifest_against_port_manifest`].
//!
//! Each test pairs a synthetic manifest with one or more synthetic
//! results to exercise the join rules in plan §7.2 and §7.3.

use utsushi_core::conformance::fixtures::{
    SYNTHETIC_ADAPTER_ID, synthetic_frame_capture_manifest, synthetic_frame_capture_pass_result,
    synthetic_text_trace_manifest, synthetic_text_trace_pass_result,
};
use utsushi_core::port::{
    EnvFieldSchema, LifecycleStage, PortCapability, PortManifest, REQUIRED_LIFECYCLE_STAGES,
};
use utsushi_core::{
    CONFORMANCE_SCHEMA_VERSION, ConformanceError, ConformanceProfile, ConformanceResult,
    EvidenceRef, EvidenceTier, FidelityTier, ProfileId, ResultOutcome, SubsystemRequirement,
    cross_validate_conformance_manifest_against_port_manifest,
    cross_validate_results_against_manifest,
};

fn pass_result_with(
    adapter_id: &str,
    profile_id: ProfileId,
    tier: EvidenceTier,
) -> ConformanceResult {
    ConformanceResult {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: adapter_id.to_string(),
        profile_id,
        outcome: ResultOutcome::Pass {
            evidence_tier: tier,
        },
        evidence: vec![EvidenceRef::TextLine {
            line_id: "trace-line-001".to_string(),
        }],
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    }
}

fn skip_result_for_profile(profile_id: ProfileId) -> ConformanceResult {
    ConformanceResult {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        profile_id,
        outcome: ResultOutcome::Skip {
            semantic_code: "utsushi.conformance.profile_not_reported".to_string(),
            reason: "suite filter excluded".to_string(),
        },
        evidence: Vec::new(),
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    }
}

fn unsupported_result(profile_id: ProfileId, declared_in_manifest: bool) -> ConformanceResult {
    ConformanceResult {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        profile_id,
        outcome: ResultOutcome::Unsupported {
            semantic_code: "utsushi.conformance.profile_not_declared".to_string(),
            declared_in_manifest,
        },
        evidence: Vec::new(),
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    }
}

#[test]
fn cross_validate_accepts_manifest_and_matching_pass_result() {
    let manifest = synthetic_text_trace_manifest();
    let results = vec![synthetic_text_trace_pass_result()];
    cross_validate_results_against_manifest(&manifest, &results).expect("validates");
}

#[test]
fn cross_validate_rejects_declared_profile_reported_as_skip() {
    let manifest = synthetic_text_trace_manifest();
    let results = vec![skip_result_for_profile(ProfileId::TextTrace)];
    let error = cross_validate_results_against_manifest(&manifest, &results)
        .expect_err("must reject Skip for declared profile");
    assert!(matches!(
        error,
        ConformanceError::DeclaredProfileSkipped {
            profile: ProfileId::TextTrace
        }
    ));
}

#[test]
fn cross_validate_rejects_declared_profile_reported_as_unsupported_via_result_validate() {
    let manifest = synthetic_text_trace_manifest();
    // Cross-validator first runs ConformanceResult::validate, which
    // rejects declared_in_manifest=true immediately.
    let results = vec![unsupported_result(ProfileId::TextTrace, true)];
    let error = cross_validate_results_against_manifest(&manifest, &results)
        .expect_err("must reject Unsupported with declared_in_manifest=true");
    assert!(matches!(
        error,
        ConformanceError::DeclaredProfileReportedAsUnsupported {
            profile: ProfileId::TextTrace
        }
    ));

    // declared_in_manifest=false but profile IS declared -> caught by
    // cross-check (the symmetric path the validator alone can't see).
    let results = vec![unsupported_result(ProfileId::TextTrace, false)];
    // To exercise the cross-check we must also satisfy ProfileNotReported
    // for any missing declared profile, but TextTrace is the only one
    // here so the unsupported result satisfies the "is reported" check.
    let error = cross_validate_results_against_manifest(&manifest, &results)
        .expect_err("must reject Unsupported for declared profile");
    assert!(matches!(
        error,
        ConformanceError::DeclaredProfileReportedAsUnsupported {
            profile: ProfileId::TextTrace
        }
    ));
}

#[test]
fn cross_validate_rejects_undeclared_profile_with_unsupported_declared_in_manifest_true() {
    let manifest = synthetic_text_trace_manifest();
    // The standalone ConformanceResult::validate (called by the cross-
    // checker before any join rules run) always rejects
    // declared_in_manifest=true as an immediate
    // DeclaredProfileReportedAsUnsupported. This guards the symmetric
    // false-claim path: even when the profile is NOT in the manifest,
    // the result payload's self-claim of "declared" is treated as a
    // structural lie and rejected on the result alone, no join needed.
    let results = vec![
        synthetic_text_trace_pass_result(),
        unsupported_result(ProfileId::FrameCapture, true),
    ];
    let error = cross_validate_results_against_manifest(&manifest, &results)
        .expect_err("must reject false declared_in_manifest claim");
    assert!(
        matches!(
            error,
            ConformanceError::DeclaredProfileReportedAsUnsupported {
                profile: ProfileId::FrameCapture
            }
        ),
        "expected DeclaredProfileReportedAsUnsupported, got {error:?}"
    );
}

#[test]
fn cross_validate_rejects_result_with_adapter_id_not_matching_manifest() {
    let manifest = synthetic_text_trace_manifest();
    let results = vec![pass_result_with(
        "utsushi-other",
        ProfileId::TextTrace,
        EvidenceTier::E1,
    )];
    let error = cross_validate_results_against_manifest(&manifest, &results)
        .expect_err("must reject adapter id mismatch");
    assert!(matches!(error, ConformanceError::AdapterIdMismatch { .. }));
}

#[test]
fn cross_validate_rejects_pass_tier_above_manifest_profile_ceiling() {
    let mut manifest = synthetic_text_trace_manifest();
    // Lower the manifest's per-profile ceiling so a result that would
    // be otherwise legal exceeds it.
    manifest.supported_profiles[0].evidence_tier_ceiling = EvidenceTier::E0;
    let results = vec![pass_result_with(
        SYNTHETIC_ADAPTER_ID,
        ProfileId::TextTrace,
        EvidenceTier::E1,
    )];
    let error = cross_validate_results_against_manifest(&manifest, &results)
        .expect_err("must reject Pass tier above manifest ceiling");
    assert!(matches!(
        error,
        ConformanceError::PassAboveManifestCeiling { .. }
    ));
}

#[test]
fn cross_validate_rejects_manifest_profile_missing_from_results() {
    let mut manifest = synthetic_text_trace_manifest();
    manifest.supported_profiles.push(ConformanceProfile {
        id: ProfileId::FrameCapture,
        required_subsystems: vec![
            SubsystemRequirement::FrameSink,
            SubsystemRequirement::ArtifactStore,
        ],
        evidence_tier_ceiling: EvidenceTier::E2,
    });
    let results = vec![synthetic_text_trace_pass_result()];
    let error = cross_validate_results_against_manifest(&manifest, &results)
        .expect_err("must reject missing reported profile");
    assert!(matches!(
        error,
        ConformanceError::ProfileNotReported {
            profile: ProfileId::FrameCapture
        }
    ));
}

#[test]
fn cross_validate_rejects_result_profile_not_in_manifest() {
    let manifest = synthetic_text_trace_manifest();
    let results = vec![
        synthetic_text_trace_pass_result(),
        pass_result_with(
            SYNTHETIC_ADAPTER_ID,
            ProfileId::FrameCapture,
            EvidenceTier::E2,
        ),
    ];
    let error = cross_validate_results_against_manifest(&manifest, &results)
        .expect_err("must reject undeclared reported profile");
    assert!(matches!(
        error,
        ConformanceError::ProfileNotDeclared {
            profile: ProfileId::FrameCapture
        }
    ));
}

const TEXT_TRACE_PORT: PortManifest = PortManifest {
    id: "utsushi-synthetic",
    name: "Synthetic Port",
    version: "0.0.0",
    abi_version: 1,
    capabilities: &[
        PortCapability::Launch,
        PortCapability::Observe,
        PortCapability::Capture,
        PortCapability::Shutdown,
    ],
    required_methods: REQUIRED_LIFECYCLE_STAGES,
    optional_methods: &[],
    env_schema: &[] as &[EnvFieldSchema],
    fidelity_tier_max: FidelityTier::TraceOnly,
    evidence_tier_max: EvidenceTier::E0,
    limitations: &[],
};

const _: LifecycleStage = LifecycleStage::Observe;

#[test]
fn cross_validate_with_port_manifest_rejects_evidence_tier_above_port_max() {
    // The conformance manifest claims E1 for text-trace, but the port
    // manifest caps the adapter at E0. The pairing helper rejects.
    let conformance = synthetic_text_trace_manifest();
    let error =
        cross_validate_conformance_manifest_against_port_manifest(&conformance, &TEXT_TRACE_PORT)
            .expect_err("must reject tier above port max");
    assert!(matches!(
        error,
        ConformanceError::EvidenceTierAboveProfileCeiling { .. }
    ));
}

#[test]
fn cross_validate_with_port_manifest_returns_ok_when_port_manifest_absent() {
    // The helper is opt-in (plan §10.1). Adapters without a port
    // manifest skip it entirely; the helper has no "absent" overload
    // because there is no PortManifest value to pass. This test
    // documents the no-op case by exercising the matching-id, matching-
    // ceiling pairing and confirming success.
    let conformance = synthetic_frame_capture_manifest();
    let port = PortManifest {
        evidence_tier_max: EvidenceTier::E2,
        fidelity_tier_max: FidelityTier::LayoutProbe,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        ..TEXT_TRACE_PORT
    };
    cross_validate_conformance_manifest_against_port_manifest(&conformance, &port)
        .expect("matching ceilings validate");

    // Sanity: a paired frame-capture result still validates separately.
    let results = vec![synthetic_frame_capture_pass_result()];
    cross_validate_results_against_manifest(&conformance, &results)
        .expect("result side validates independently");
}
