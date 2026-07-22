use super::*;

fn metadata() -> RuntimeTargetMetadata {
    RuntimeTargetMetadata {
        work_ids: ["fixture-archive#work:2:0".to_string()]
            .into_iter()
            .collect(),
        edition_ids: ["fixture-archive#edition:steam-jp".to_string()]
            .into_iter()
            .collect(),
        source_revisions: ["fixture-source-v0.1".to_string()].into_iter().collect(),
        bridge_unit_fixture_revisions: ["fixture-bridge-rev-v0.1".to_string()]
            .into_iter()
            .collect(),
        runtime_target_ids: ["fixture:mvmz-patched-fixture".to_string()]
            .into_iter()
            .collect(),
        proof_manifest_ids: ["cac432af-03e2-7aa5-955b-bc1d66a3629a".to_string()]
            .into_iter()
            .collect(),
    }
}

fn bound_profile() -> RuntimeTargetProfile {
    RuntimeTargetProfile {
        schema_version: RUNTIME_TARGET_PROFILE_SCHEMA_VERSION.to_string(),
        work_id: "fixture-archive#work:2:0".to_string(),
        edition_id: Some("fixture-archive#edition:steam-jp".to_string()),
        source_revision: "fixture-source-v0.1".to_string(),
        bridge_unit_fixture_revision: "fixture-bridge-rev-v0.1".to_string(),
        runtime_target_id: "fixture:mvmz-patched-fixture".to_string(),
        readiness_level: ReadinessLevel::Alpha,
        proof_manifest_id: "cac432af-03e2-7aa5-955b-bc1d66a3629a".to_string(),
    }
}

#[test]
fn well_formed_bound_profile_validates_and_resolves() {
    let profile = bound_profile();
    profile.validate().expect("well-formed");
    resolve_runtime_target_profile(&profile, &metadata()).expect("binds real metadata");
}

#[test]
fn edition_id_is_optional_when_not_known() {
    let mut profile = bound_profile();
    profile.edition_id = None;
    profile.validate().expect("well-formed without edition");
    resolve_runtime_target_profile(&profile, &metadata())
        .expect("work-only profile still resolves");
}

#[test]
fn missing_required_binding_is_rejected_as_not_well_formed() {
    let mut profile = bound_profile();
    profile.proof_manifest_id = String::new();
    assert_eq!(
        profile.validate(),
        Err(RuntimeTargetProfileError::MissingField {
            field: "proofManifestId"
        })
    );
    assert_eq!(
        resolve_runtime_target_profile(&profile, &metadata()),
        Err(RuntimeTargetResolutionError::Malformed(
            RuntimeTargetProfileError::MissingField {
                field: "proofManifestId"
            }
        ))
    );
}

#[test]
fn local_path_id_is_malformed() {
    let mut profile = bound_profile();
    profile.runtime_target_id = "/home/trevor/scratch/fixture.json".to_string();
    assert!(matches!(
        profile.validate(),
        Err(RuntimeTargetProfileError::FieldMalformed { field, .. }) if field == "runtimeTargetId"
    ));
}

#[test]
fn arbitrary_fixture_target_is_rejected_on_resolution() {
    // Well-formed but binds a runtime target absent from the catalog:
    // an arbitrary fixture, not a meaningful candidate.
    let mut profile = bound_profile();
    profile.runtime_target_id = "fixture:arbitrary-unregistered".to_string();
    profile.validate().expect("still well-formed");
    assert_eq!(
        resolve_runtime_target_profile(&profile, &metadata()),
        Err(RuntimeTargetResolutionError::UnknownRuntimeTarget {
            runtime_target_id: "fixture:arbitrary-unregistered".to_string()
        })
    );
}

#[test]
fn unknown_work_is_rejected() {
    let mut profile = bound_profile();
    profile.work_id = "some-other-archive#work:9:9".to_string();
    assert_eq!(
        resolve_runtime_target_profile(&profile, &metadata()),
        Err(RuntimeTargetResolutionError::UnknownWork {
            work_id: "some-other-archive#work:9:9".to_string()
        })
    );
}

#[test]
fn unknown_edition_when_present_is_rejected() {
    let mut profile = bound_profile();
    profile.edition_id = Some("fixture-archive#edition:unregistered".to_string());
    assert_eq!(
        resolve_runtime_target_profile(&profile, &metadata()),
        Err(RuntimeTargetResolutionError::UnknownEdition {
            edition_id: "fixture-archive#edition:unregistered".to_string()
        })
    );
}

#[test]
fn profile_round_trips_through_json() {
    let profile = bound_profile();
    let bytes = serde_json::to_string(&profile).expect("serialize");
    let restored: RuntimeTargetProfile = serde_json::from_str(&bytes).expect("deserialize");
    assert_eq!(profile, restored);
}

#[test]
fn readiness_level_round_trips_kebab_case() {
    for level in ReadinessLevel::ALL {
        let value = serde_json::to_value(level).expect("serialize");
        assert_eq!(value.as_str().expect("string"), level.as_str());
        let restored: ReadinessLevel = serde_json::from_value(value).expect("deserialize");
        assert_eq!(restored, *level);
    }
    assert_eq!(
        serde_json::to_string(&ReadinessLevel::RealGameTestingReady).expect("serialize"),
        "\"real-game-testing-ready\""
    );
}

#[test]
fn schema_version_defaults_when_absent_from_json() {
    let value = serde_json::json!({
        "workId": "fixture-archive#work:2:0",
        "sourceRevision": "fixture-source-v0.1",
        "bridgeUnitFixtureRevision": "fixture-bridge-rev-v0.1",
        "runtimeTargetId": "fixture:mvmz-patched-fixture",
        "readinessLevel": "alpha",
        "proofManifestId": "cac432af-03e2-7aa5-955b-bc1d66a3629a"
    });
    let profile: RuntimeTargetProfile = serde_json::from_value(value).expect("parse");
    assert_eq!(
        profile.schema_version,
        RUNTIME_TARGET_PROFILE_SCHEMA_VERSION
    );
    assert!(profile.edition_id.is_none());
    resolve_runtime_target_profile(&profile, &metadata()).expect("resolves");
}
