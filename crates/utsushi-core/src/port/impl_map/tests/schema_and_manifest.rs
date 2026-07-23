use super::*;

#[test]
fn json_schema_under_roadmap_validates_the_example_fixture() {
    let schema = build_schema();
    let map = baseline_map();
    let value = serde_json::to_value(&map).expect("serialize");
    let validator = jsonschema::draft202012::new(&schema).expect("compile schema");
    let errors: Vec<_> = validator.iter_errors(&value).collect();
    assert!(
        errors.is_empty(),
        "schema should accept baseline; got: {errors:?}"
    );
}

#[test]
fn json_schema_rejects_an_otherwise_well_formed_map_missing_fixture_hash() {
    let schema = build_schema();
    let mut map = baseline_map();
    let mut value = serde_json::to_value(&map).expect("serialize");
    // Remove the hash field from the first subsystem's fixtureRef.
    let subsystems = value
        .get_mut("subsystems")
        .and_then(|v| v.as_array_mut())
        .expect("subsystems array");
    let fixture = subsystems[0]
        .get_mut("fixtureRef")
        .and_then(|v| v.as_object_mut())
        .expect("fixtureRef object");
    fixture.remove("hash");
    let validator = jsonschema::draft202012::new(&schema).expect("compile schema");
    let has_errors = !validator.is_valid(&value);
    assert!(has_errors, "schema should reject map missing hash");
    // Sanity: validator still rejects via the Rust validator too.
    map.subsystems[0].fixture_ref.hash.clear();
    let _ = validate(&map).expect_err("map with empty hash must fail");
}

// 7.6 Cross-validation against PortManifest.

fn matching_port_manifest() -> crate::port::PortManifest {
    crate::port::PortManifest {
        id: "utsushi-reallive",
        name: "RealLive (research anchor)",
        version: "0.0.0",
        abi_version: 1,
        capabilities: &[
            crate::port::PortCapability::Launch,
            crate::port::PortCapability::Observe,
            crate::port::PortCapability::Capture,
            crate::port::PortCapability::Shutdown,
        ],
        required_methods: crate::port::REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: crate::FidelityTier::LayoutProbe,
        evidence_tier_max: crate::EvidenceTier::E2,
        limitations: &[],
    }
}

#[test]
fn validate_against_manifest_rejects_port_id_mismatch() {
    let mut map = baseline_map();
    map.port_id = PortId::new("utsushi-other");
    map.engine_family = EngineFamily::Other;
    map.engine_family_notes = Some("disambiguating note".to_string());
    let manifest = matching_port_manifest();
    let mismatches =
        validate_against_manifest(&map, &manifest).expect_err("port id mismatch must fail");
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m, ImplMapManifestMismatch::PortIdMismatch { .. })),
        "PortIdMismatch expected"
    );
}

#[test]
fn validate_against_manifest_accepts_engine_neutral_capability_tags_not_in_manifest() {
    let mut map = baseline_map();
    map.subsystems[0].capabilities = vec!["frame-capture-e2".to_string()];
    let manifest = matching_port_manifest();
    validate_against_manifest(&map, &manifest).expect("engine-neutral tag accepted");
}

#[test]
fn validate_against_manifest_flags_capability_in_map_absent_from_manifest() {
    let mut map = baseline_map();
    map.subsystems[0].capabilities = vec!["jump".to_string()];
    let manifest = matching_port_manifest();
    let mismatches = validate_against_manifest(&map, &manifest)
        .expect_err("jump capability not in manifest must fail");
    assert!(
        mismatches.iter().any(|m| matches!(
            m,
            ImplMapManifestMismatch::CapabilityAbsentFromManifest { .. }
        )),
        "CapabilityAbsentFromManifest expected"
    );
}
