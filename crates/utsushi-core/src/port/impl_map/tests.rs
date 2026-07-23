//! Comprehensive test suite for the implementation-map module.

use super::*;
use crate::looks_like_local_path;
use crate::port::impl_map::diagnostics::REDACTED_LOCAL_PATH_TOKEN;
use crate::port::impl_map::json_schema::build_schema;

// Builders for well-formed and negative fixtures.

fn baseline_map() -> ImplementationMap {
    ImplementationMap {
        schema_version: IMPL_MAP_SCHEMA_VERSION.to_string(),
        port_id: PortId::new("utsushi-reallive"),
        engine_family: EngineFamily::RealLive,
        engine_family_notes: None,
        subsystems: vec![Subsystem {
            id: SubsystemId::new("scene-seen-replay"),
            name: "Scene/SEEN deterministic replay".to_string(),
            status: SubsystemStatus::Supported,
            fixture_ref: FixtureRef {
                id: "reallive-detector/positive-synthetic-triple".to_string(),
                classification: FixtureClassification::Public,
                kind: FixtureKind::Directory,
                kind_notes: None,
                hash: "f".repeat(64),
                byte_count: 4096,
            },
            validation_command_id: ValidationCommandId::new("cargo-test-utsushi-reallive"),
            capabilities: vec!["deterministic-text-trace".to_string()],
            notes: String::new(),
        }],
        validation_commands: vec![ValidationCommand {
            id: ValidationCommandId::new("cargo-test-utsushi-reallive"),
            command: "cargo test -p utsushi-reallive scene_seen_replay".to_string(),
            expected_outcome: ExpectedOutcome::Pass,
            caption: "Deterministic Scene/SEEN replay smoke.".to_string(),
        }],
        reference_behavior: ReferenceBehavior {
            engine_runtime: "rlvm (research anchor; clean-room; behavior-only)".to_string(),
            observable_signal: "deterministic text trace per scene id".to_string(),
            capture_method: CaptureMethod::TraceLog,
        },
        status: Status::Draft,
        status_disclaimer: None,
        generated_at: "2026-06-23T17:00:00Z".to_string(),
    }
}

// 7.1 Positive shape.

#[test]
fn validates_well_formed_engine_neutral_impl_map() {
    let map = baseline_map();
    let report = validate(&map).expect("baseline map validates");
    assert_eq!(report.schema_version, IMPL_MAP_SCHEMA_VERSION);
    assert!(report.warnings.is_empty());
}

#[test]
fn roundtrips_json_for_well_formed_map_preserving_field_order() {
    let map = baseline_map();
    let json = serde_json::to_string(&map).expect("serializes");
    let parsed: ImplementationMap = serde_json::from_str(&json).expect("deserializes");
    assert_eq!(parsed, map);
    // schemaVersion is the first field.
    assert!(
        json.starts_with("{\"schemaVersion\""),
        "schemaVersion must serialize first; got: {json}"
    );
}

#[test]
fn accepts_supported_partial_unsupported_and_research_subsystem_variants_in_one_map() {
    let mut map = baseline_map();
    map.subsystems[0].id = SubsystemId::new("supported-sub");
    map.subsystems.push(Subsystem {
        id: SubsystemId::new("partial-sub"),
        name: "Partial".to_string(),
        status: SubsystemStatus::Partial {
            limitations: vec!["scene-id 0x4000 is not handled".to_string()],
        },
        fixture_ref: map.subsystems[0].fixture_ref.clone(),
        validation_command_id: map.validation_commands[0].id.clone(),
        capabilities: vec!["partial-coverage".to_string()],
        notes: String::new(),
    });
    map.subsystems.push(Subsystem {
        id: SubsystemId::new("unsupported-sub"),
        name: "Unsupported".to_string(),
        status: SubsystemStatus::Unsupported {
            reason: UnsupportedReason::SemanticCode("utsushi.capability.unsupported".to_string()),
        },
        fixture_ref: map.subsystems[0].fixture_ref.clone(),
        validation_command_id: map.validation_commands[0].id.clone(),
        capabilities: vec!["out-of-scope".to_string()],
        notes: String::new(),
    });
    map.subsystems.push(Subsystem {
        id: SubsystemId::new("research-sub"),
        name: "Research".to_string(),
        status: SubsystemStatus::Research {
            evidence_refs: vec![EvidenceRef {
                kind: EvidenceKind::RoadmapNode,
                locator: "UTSUSHI-146".to_string(),
                caption: "Reference vm research anchor".to_string(),
            }],
        },
        fixture_ref: map.subsystems[0].fixture_ref.clone(),
        validation_command_id: map.validation_commands[0].id.clone(),
        capabilities: vec!["research-only".to_string()],
        notes: String::new(),
    });
    let report = validate(&map).expect("mixed-status map validates");
    // Research should produce a warning.
    assert!(
        report
            .warnings
            .iter()
            .any(|w| matches!(w, ValidationWarning::ResearchSubsystemPresent { .. })),
        "research subsystem should produce a warning",
    );
}

#[test]
fn promotes_status_to_validated_when_all_invariants_hold() {
    let mut map = baseline_map();
    assert_eq!(map.status, Status::Draft);
    let report = validate_and_promote(&mut map).expect("validates");
    assert_eq!(map.status, Status::Validated);
    assert_eq!(
        map.status_disclaimer.as_deref(),
        Some(report.status_disclaimer)
    );
}

#[test]
fn surfaces_status_disclaimer_string_when_status_is_validated() {
    let mut map = baseline_map();
    let _ = validate_and_promote(&mut map).expect("validates");
    let json = serde_json::to_string(&map).expect("serializes");
    assert!(
        json.contains("statusDisclaimer"),
        "disclaimer field must surface in JSON: {json}"
    );
    assert!(
        json.contains("NOT alpha-readiness evidence"),
        "disclaimer string must contain the audit warning"
    );
}

#[test]
fn accepts_synthetic_inline_classification_when_kind_is_synthetic_inline() {
    let mut map = baseline_map();
    map.subsystems[0].fixture_ref.classification = FixtureClassification::SyntheticInline;
    map.subsystems[0].fixture_ref.kind = FixtureKind::SyntheticInline;
    map.subsystems[0].fixture_ref.byte_count = 0;
    map.subsystems[0].fixture_ref.id = "in-test-builder".to_string();
    validate(&map).expect("synthetic-inline validates");
}

#[test]
fn accepts_research_subsystem_with_roadmap_node_evidence_ref() {
    let mut map = baseline_map();
    map.subsystems[0].status = SubsystemStatus::Research {
        evidence_refs: vec![EvidenceRef {
            kind: EvidenceKind::RoadmapNode,
            locator: "UTSUSHI-146".to_string(),
            caption: "Reference vm research anchor".to_string(),
        }],
    };
    let report = validate(&map).expect("research validates");
    assert!(
        report
            .warnings
            .iter()
            .any(|w| matches!(w, ValidationWarning::ResearchSubsystemPresent { .. }))
    );
}

#[test]
fn accepts_reference_behavior_no_reference_comparison_as_warning_not_error() {
    let mut map = baseline_map();
    map.reference_behavior.capture_method = CaptureMethod::NoReferenceComparison;
    let report = validate(&map).expect("no-reference-comparison validates");
    assert!(
        report
            .warnings
            .contains(&ValidationWarning::NoReferenceComparison),
        "no-reference-comparison must emit warning"
    );
}

// 7.2 Negative shape — one test per error variant.

fn assert_has_error<F: Fn(&ImplMapError) -> bool>(errors: &[ImplMapError], pred: F, label: &str) {
    assert!(
        errors.iter().any(pred),
        "expected error matching {label}, got {errors:?}"
    );
}

#[path = "tests/shape_errors.rs"]
mod shape_errors;

#[test]
fn rejects_research_subsystem_with_empty_evidence_refs() {
    let mut map = baseline_map();
    map.subsystems[0].status = SubsystemStatus::Research {
        evidence_refs: vec![],
    };
    let errors = validate(&map).expect_err("empty research must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::ResearchEvidenceMissing { .. }),
        "ResearchEvidenceMissing",
    );
}

#[test]
fn rejects_research_evidence_ref_with_empty_caption() {
    let mut map = baseline_map();
    map.subsystems[0].status = SubsystemStatus::Research {
        evidence_refs: vec![EvidenceRef {
            kind: EvidenceKind::RoadmapNode,
            locator: "UTSUSHI-146".to_string(),
            caption: "  ".to_string(),
        }],
    };
    let errors = validate(&map).expect_err("empty caption must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::ResearchEvidenceCaptionEmpty { .. }),
        "ResearchEvidenceCaptionEmpty",
    );
}

#[test]
fn rejects_research_evidence_locator_not_matching_kind_shape() {
    let mut map = baseline_map();
    map.subsystems[0].status = SubsystemStatus::Research {
        evidence_refs: vec![EvidenceRef {
            kind: EvidenceKind::RoadmapNode,
            locator: "not-a-node-id".to_string(),
            caption: "Caption".to_string(),
        }],
    };
    let errors = validate(&map).expect_err("bad locator must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::ResearchEvidenceLocatorMalformed { .. }),
        "ResearchEvidenceLocatorMalformed",
    );
}

fn research_map_with_evidence(kind: EvidenceKind, locator: &str) -> ImplementationMap {
    let mut map = baseline_map();
    map.subsystems[0].status = SubsystemStatus::Research {
        evidence_refs: vec![EvidenceRef {
            kind,
            locator: locator.to_string(),
            caption: "Caption".to_string(),
        }],
    };
    map
}

fn assert_locator_rejected(kind: EvidenceKind, locator: &str) {
    let map = research_map_with_evidence(kind, locator);
    let errors = validate(&map).expect_err("malformed locator must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::ResearchEvidenceLocatorMalformed { .. }),
        "ResearchEvidenceLocatorMalformed",
    );
}

fn assert_locator_accepted(kind: EvidenceKind, locator: &str) {
    let map = research_map_with_evidence(kind, locator);
    // `validate` returns `Ok` only when the map has zero errors, so a
    // successful result is itself proof the locator was not rejected.
    validate(&map)
        .unwrap_or_else(|errors| panic!("valid {kind:?} locator {locator:?} rejected: {errors:?}"));
}

#[path = "tests/locator_and_fields.rs"]
mod locator_and_fields;

#[path = "tests/schema_and_manifest.rs"]
mod schema_and_manifest;

#[path = "tests/hash_and_serialization.rs"]
mod hash_and_serialization;

mod corpus {
    use super::*;
    use std::path::Path;

    fn fixtures_root() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR"))
    }

    fn read_fixture(rel: &str) -> serde_json::Value {
        let path = fixtures_root().join("src/port/impl_map/fixtures").join(rel);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read fixture {}: {e}", path.display()));
        serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("parse fixture {}: {e}", path.display()))
    }

    #[test]
    fn positive_fixtures_validate_via_rust_validator() {
        let names = [
            "positive/minimal-supported.json",
            "positive/mixed-status.json",
            "positive/engine-family-other-with-notes.json",
            "positive/synthetic-inline.json",
        ];
        for name in names {
            let value = read_fixture(name);
            let map: ImplementationMap =
                serde_json::from_value(value).unwrap_or_else(|e| panic!("{name}: deserialize {e}"));
            validate(&map).unwrap_or_else(|errors| panic!("{name}: validate {errors:?}"));
        }
    }

    #[test]
    fn positive_fixtures_validate_via_json_schema() {
        let schema = build_schema();
        let validator = jsonschema::draft202012::new(&schema).expect("compile schema");
        let names = [
            "positive/minimal-supported.json",
            "positive/mixed-status.json",
            "positive/engine-family-other-with-notes.json",
            "positive/synthetic-inline.json",
        ];
        for name in names {
            let value = read_fixture(name);
            let errors: Vec<_> = validator.iter_errors(&value).collect();
            assert!(
                errors.is_empty(),
                "json schema rejects positive fixture {name}: {errors:?}"
            );
        }
    }

    #[test]
    fn negative_fixtures_are_rejected_by_rust_validator() {
        // Each negative fixture must EITHER:
        //   (a) parse + fail Rust validation, OR
        //   (b) fail to parse altogether (typed enum mismatch, etc).
        let names = [
            "negative/empty-subsystems.json",
            "negative/missing-fixture-hash.json",
            "negative/orphan-command.json",
            "negative/partial-without-limitations.json",
            "negative/validation-command-pipe.json",
            "negative/engine-family-other-no-notes.json",
        ];
        for name in names {
            let value = read_fixture(name);
            if let Ok(map) = serde_json::from_value::<ImplementationMap>(value) {
                let _ = validate(&map).expect_err(&format!(
                    "negative fixture {name} unexpectedly passed Rust validation"
                ));
            } else {
                // Acceptable: schema rejection at deserialize time.
            }
        }
    }
}
