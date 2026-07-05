//! Integration test for the UTSUSHI-133 runtime target profile read
//! model. Loads the committed synthetic fixture
//! `tests/fixtures/conformance/runtime_target_profile/candidate_profiles.json`,
//! validates each candidate is well-formed AND resolves against the bound
//! catalog/corpus/bridge/proof metadata, and asserts the negative profile
//! (an arbitrary unregistered runtime target) is rejected.
//!
//! This is a DATA-ONLY test: it launches no runtime host, opens no
//! browser, and reads no game bytes. It only validates identity bindings.

use std::path::PathBuf;

use utsushi_core::conformance::runtime_target_profile::{
    RUNTIME_TARGET_PROFILE_SCHEMA_VERSION, ReadinessLevel, RuntimeTargetProfileFixture,
    RuntimeTargetResolutionError, resolve_runtime_target_profile,
};

fn load_fixture() -> RuntimeTargetProfileFixture {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("conformance")
        .join("runtime_target_profile")
        .join("candidate_profiles.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("read fixture {}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|_| panic!("parse fixture {}", path.display()))
}

#[test]
fn every_candidate_records_all_required_bindings_and_resolves() {
    let fixture = load_fixture();
    assert!(
        !fixture.candidates.is_empty(),
        "fixture must carry at least one meaningful candidate"
    );

    for candidate in &fixture.candidates {
        // Every required binding is present (well-formed) ...
        candidate
            .validate()
            .unwrap_or_else(|error| panic!("candidate {candidate:?} is not well-formed: {error}"));
        // ... and every id names REAL metadata (a meaningful candidate).
        resolve_runtime_target_profile(candidate, &fixture.metadata)
            .unwrap_or_else(|error| panic!("candidate {candidate:?} did not resolve: {error}"));

        // The recorded identities the acceptance requires.
        assert!(!candidate.work_id.is_empty(), "work id required");
        assert!(
            !candidate.source_revision.is_empty(),
            "source revision required"
        );
        assert!(
            !candidate.bridge_unit_fixture_revision.is_empty(),
            "bridge-unit fixture revision required"
        );
        assert!(
            !candidate.runtime_target_id.is_empty(),
            "runtime target id required"
        );
        assert!(
            !candidate.proof_manifest_id.is_empty(),
            "proof manifest id required"
        );
        let _ = candidate.readiness_level;
        // edition id is optional ("when known").
        let _ = &candidate.edition_id;
        assert_eq!(
            candidate.schema_version,
            RUNTIME_TARGET_PROFILE_SCHEMA_VERSION
        );
    }
}

#[test]
fn candidates_cover_both_bound_edition_and_edition_omitted() {
    let fixture = load_fixture();
    assert!(
        fixture.candidates.iter().any(|c| c.edition_id.is_some()),
        "expected a candidate that binds a known edition"
    );
    assert!(
        fixture.candidates.iter().any(|c| c.edition_id.is_none()),
        "expected a work-only candidate (edition not known)"
    );
    // Both readiness levels represented in the fixture parse to real tiers.
    assert!(
        fixture
            .candidates
            .iter()
            .any(|c| c.readiness_level == ReadinessLevel::Alpha)
    );
    assert!(
        fixture
            .candidates
            .iter()
            .any(|c| c.readiness_level == ReadinessLevel::RealGameTestingReady)
    );
}

#[test]
fn negative_profile_binding_an_arbitrary_fixture_is_rejected() {
    let fixture = load_fixture();
    assert!(
        !fixture.rejected.is_empty(),
        "fixture must carry at least one rejected profile"
    );

    for rejected in &fixture.rejected {
        // The negative is well-formed in SHAPE (proving the rejection is
        // about the binding, not a typo) ...
        rejected
            .validate()
            .expect("negative profile is well-formed in shape");
        // ... yet it does NOT resolve: it names an arbitrary runtime target
        // absent from the metadata catalog.
        let error = resolve_runtime_target_profile(rejected, &fixture.metadata)
            .expect_err("arbitrary-fixture profile must be rejected");
        assert!(
            matches!(
                error,
                RuntimeTargetResolutionError::UnknownRuntimeTarget { .. }
            ),
            "expected UnknownRuntimeTarget, got {error}"
        );
    }
}
