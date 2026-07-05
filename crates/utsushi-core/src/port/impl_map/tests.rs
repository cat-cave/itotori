//! Comprehensive test suite for the implementation-map module.

use super::*;
use crate::looks_like_local_path;
use crate::port::impl_map::diagnostics::REDACTED_LOCAL_PATH_TOKEN;
use crate::port::impl_map::json_schema::build_schema;

// ---------------------------------------------------------------------------
// Builders for well-formed and negative fixtures.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 7.1 Positive shape.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 7.2 Negative shape — one test per error variant.
// ---------------------------------------------------------------------------

fn assert_has_error<F: Fn(&ImplMapError) -> bool>(errors: &[ImplMapError], pred: F, label: &str) {
    assert!(
        errors.iter().any(pred),
        "expected error matching {label}, got {errors:?}"
    );
}

#[test]
fn rejects_map_with_empty_subsystems_list_with_no_subsystems_declared() {
    let mut map = baseline_map();
    map.subsystems.clear();
    // Also drop the now-orphan command to keep this test focused.
    map.validation_commands.clear();
    let errors = validate(&map).expect_err("empty subsystems must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::NoSubsystemsDeclared),
        "NoSubsystemsDeclared",
    );
}

#[test]
fn rejects_map_with_empty_validation_commands_list() {
    let mut map = baseline_map();
    map.validation_commands.clear();
    let errors = validate(&map).expect_err("empty validation commands must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::NoValidationCommandsDeclared),
        "NoValidationCommandsDeclared",
    );
}

#[test]
fn rejects_subsystem_missing_fixture_hash_as_missing_fixture_provenance() {
    let mut map = baseline_map();
    map.subsystems[0].fixture_ref.hash = String::new();
    let errors = validate(&map).expect_err("missing hash must fail");
    assert_has_error(
        &errors,
        |e| {
            matches!(
                e,
                ImplMapError::MissingFixtureProvenance {
                    field: ProvenanceField::Hash,
                    ..
                }
            )
        },
        "MissingFixtureProvenance/Hash",
    );
}

#[test]
fn rejects_subsystem_with_placeholder_hash_token_as_missing_fixture_provenance() {
    for placeholder in ["todo", "TBD", "placeholder", "TODO-fill-me-in"] {
        let mut map = baseline_map();
        map.subsystems[0].fixture_ref.hash = placeholder.to_string();
        let errors = validate(&map).expect_err("placeholder must fail");
        assert_has_error(
            &errors,
            |e| {
                matches!(
                    e,
                    ImplMapError::MissingFixtureProvenance {
                        field: ProvenanceField::Hash,
                        ..
                    }
                )
            },
            "MissingFixtureProvenance/Hash for placeholder",
        );
    }
}

#[test]
fn rejects_subsystem_with_all_zero_hash_as_missing_fixture_provenance() {
    let mut map = baseline_map();
    map.subsystems[0].fixture_ref.hash = "0".repeat(64);
    let errors = validate(&map).expect_err("all-zero hash must fail");
    assert_has_error(
        &errors,
        |e| {
            matches!(
                e,
                ImplMapError::MissingFixtureProvenance {
                    field: ProvenanceField::Hash,
                    ..
                }
            )
        },
        "MissingFixtureProvenance/Hash for all-zero",
    );
}

#[test]
fn rejects_subsystem_with_zero_byte_count_unless_synthetic_inline() {
    let mut map = baseline_map();
    map.subsystems[0].fixture_ref.byte_count = 0;
    let errors = validate(&map).expect_err("zero byte_count must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::FixtureByteCountZero { .. }),
        "FixtureByteCountZero",
    );
}

#[test]
fn rejects_subsystem_with_malformed_hex_hash_as_fixture_hash_malformed() {
    let mut map = baseline_map();
    map.subsystems[0].fixture_ref.hash = "Z".repeat(64);
    let errors = validate(&map).expect_err("malformed hex must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::FixtureHashMalformed { .. }),
        "FixtureHashMalformed",
    );
}

#[test]
fn rejects_subsystem_referring_to_unknown_validation_command_id_as_orphan_ref() {
    let mut map = baseline_map();
    map.subsystems[0].validation_command_id = ValidationCommandId::new("does-not-exist");
    let errors = validate(&map).expect_err("orphan ref must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::OrphanValidationCommandRef { .. }),
        "OrphanValidationCommandRef",
    );
}

#[test]
fn rejects_validation_command_unreferenced_by_any_subsystem_as_orphan_command() {
    let mut map = baseline_map();
    map.validation_commands.push(ValidationCommand {
        id: ValidationCommandId::new("orphaned-cmd"),
        command: "cargo test -p utsushi-reallive other_test".to_string(),
        expected_outcome: ExpectedOutcome::Pass,
        caption: "An orphan.".to_string(),
    });
    let errors = validate(&map).expect_err("orphan command must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::OrphanValidationCommand { .. }),
        "OrphanValidationCommand",
    );
}

#[test]
fn rejects_duplicate_subsystem_ids() {
    let mut map = baseline_map();
    let dup = map.subsystems[0].clone();
    map.subsystems.push(dup);
    let errors = validate(&map).expect_err("dup subsystem must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::DuplicateSubsystemId { .. }),
        "DuplicateSubsystemId",
    );
}

#[test]
fn rejects_duplicate_validation_command_ids() {
    let mut map = baseline_map();
    let dup = map.validation_commands[0].clone();
    map.validation_commands.push(dup);
    let errors = validate(&map).expect_err("dup command must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::DuplicateValidationCommandId { .. }),
        "DuplicateValidationCommandId",
    );
}

#[test]
fn rejects_partial_subsystem_with_empty_limitations() {
    let mut map = baseline_map();
    map.subsystems[0].status = SubsystemStatus::Partial {
        limitations: vec![],
    };
    let errors = validate(&map).expect_err("partial w/o limitations must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::PartialWithoutLimitations { .. }),
        "PartialWithoutLimitations",
    );
}

#[test]
fn rejects_unsupported_subsystem_with_free_text_reason() {
    let mut map = baseline_map();
    map.subsystems[0].status = SubsystemStatus::Unsupported {
        reason: UnsupportedReason::SemanticCode("not a code".to_string()),
    };
    let errors = validate(&map).expect_err("free-text reason must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::UnsupportedReasonNotSemantic { .. }),
        "UnsupportedReasonNotSemantic",
    );
}

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

#[test]
fn rejects_fixture_evidence_locator_outside_fixtures_root() {
    assert_locator_rejected(EvidenceKind::Fixture, "corpora/reallive/seen.txt");
    assert_locator_rejected(EvidenceKind::Fixture, "docs/note.md");
    assert_locator_rejected(EvidenceKind::Fixture, "/abs/fixtures/x");
    assert_locator_rejected(EvidenceKind::Fixture, "fixtures/../secret");
}

#[test]
fn accepts_fixture_evidence_locator_under_fixtures_root() {
    assert_locator_accepted(EvidenceKind::Fixture, "fixtures/reallive/seen-triple");
}

#[test]
fn rejects_doc_evidence_locator_outside_docs_root() {
    assert_locator_rejected(EvidenceKind::Doc, "notes/provenance.md");
    assert_locator_rejected(EvidenceKind::Doc, "fixtures/x.md");
    assert_locator_rejected(EvidenceKind::Doc, "/etc/docs/x");
}

#[test]
fn accepts_doc_evidence_locator_under_docs_root() {
    assert_locator_accepted(EvidenceKind::Doc, "docs/utsushi-siglus-vm-provenance.md");
}

#[test]
fn rejects_reference_impl_anchor_without_colon_uri_shape() {
    // No colon at all.
    assert_locator_rejected(EvidenceKind::ReferenceImplAnchor, "siglus_rs");
    // Colon at the very start / end.
    assert_locator_rejected(EvidenceKind::ReferenceImplAnchor, ":path/only");
    assert_locator_rejected(EvidenceKind::ReferenceImplAnchor, "scheme:");
    // Non-letter-led scheme.
    assert_locator_rejected(EvidenceKind::ReferenceImplAnchor, "1scheme:path");
}

#[test]
fn accepts_reference_impl_anchor_with_colon_uri_shape() {
    assert_locator_accepted(
        EvidenceKind::ReferenceImplAnchor,
        "https://github.com/xmoezzz/siglus_rs",
    );
    assert_locator_accepted(
        EvidenceKind::ReferenceImplAnchor,
        "rlvm:src/machine/rlmachine.cc",
    );
}

#[test]
fn malformed_locator_error_redacts_local_path_in_render() {
    let map = research_map_with_evidence(EvidenceKind::Fixture, "/home/trevor/leak/fixtures/x");
    let errors = validate(&map).expect_err("absolute host path must fail");
    let rendered = errors
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        rendered.contains(REDACTED_LOCAL_PATH_TOKEN),
        "expected local path to be redacted, got: {rendered}",
    );
    assert!(
        !rendered.contains("/home/trevor/leak"),
        "raw host path leaked into diagnostic: {rendered}",
    );
}

#[test]
fn rejects_empty_capability_list_on_subsystem() {
    let mut map = baseline_map();
    map.subsystems[0].capabilities.clear();
    let errors = validate(&map).expect_err("empty capabilities must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::EmptyCapabilityList { .. }),
        "EmptyCapabilityList",
    );
}

#[test]
fn rejects_engine_family_other_without_engine_family_notes() {
    let mut map = baseline_map();
    map.engine_family = EngineFamily::Other;
    map.engine_family_notes = None;
    let errors = validate(&map).expect_err("other w/o notes must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::EngineFamilyOtherWithoutNotes),
        "EngineFamilyOtherWithoutNotes",
    );
}

#[test]
fn rejects_fixture_kind_other_without_kind_notes() {
    let mut map = baseline_map();
    map.subsystems[0].fixture_ref.kind = FixtureKind::Other;
    map.subsystems[0].fixture_ref.kind_notes = None;
    let errors = validate(&map).expect_err("kind=other w/o notes must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::FixtureKindOtherWithoutNotes { .. }),
        "FixtureKindOtherWithoutNotes",
    );
}

#[test]
fn rejects_reference_behavior_with_empty_engine_runtime() {
    let mut map = baseline_map();
    map.reference_behavior.engine_runtime = String::new();
    let errors = validate(&map).expect_err("empty engine_runtime must fail");
    assert_has_error(
        &errors,
        |e| {
            matches!(
                e,
                ImplMapError::ReferenceBehaviorMissing {
                    field: ReferenceField::EngineRuntime
                }
            )
        },
        "ReferenceBehaviorMissing/EngineRuntime",
    );
}

#[test]
fn rejects_reference_behavior_with_empty_observable_signal() {
    let mut map = baseline_map();
    map.reference_behavior.observable_signal = String::new();
    let errors = validate(&map).expect_err("empty observable_signal must fail");
    assert_has_error(
        &errors,
        |e| {
            matches!(
                e,
                ImplMapError::ReferenceBehaviorMissing {
                    field: ReferenceField::ObservableSignal
                }
            )
        },
        "ReferenceBehaviorMissing/ObservableSignal",
    );
}

#[test]
fn rejects_validation_command_empty_string() {
    let mut map = baseline_map();
    map.validation_commands[0].command = String::new();
    let errors = validate(&map).expect_err("empty command must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::ValidationCommandEmpty { .. }),
        "ValidationCommandEmpty",
    );
}

#[test]
fn rejects_validation_command_with_shell_pipe() {
    let mut map = baseline_map();
    map.validation_commands[0].command = "cargo test -p foo | grep ok".to_string();
    let errors = validate(&map).expect_err("pipe must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::ValidationCommandUnsafeShape { .. }),
        "ValidationCommandUnsafeShape/pipe",
    );
}

#[test]
fn rejects_validation_command_with_subshell_dollar_paren() {
    let mut map = baseline_map();
    map.validation_commands[0].command = "cargo test $(whoami)".to_string();
    let errors = validate(&map).expect_err("subshell must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::ValidationCommandUnsafeShape { .. }),
        "ValidationCommandUnsafeShape/subshell",
    );
}

#[test]
fn rejects_validation_command_with_backtick() {
    let mut map = baseline_map();
    map.validation_commands[0].command = "cargo test `whoami`".to_string();
    let errors = validate(&map).expect_err("backtick must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::ValidationCommandUnsafeShape { .. }),
        "ValidationCommandUnsafeShape/backtick",
    );
}

#[test]
fn rejects_validation_command_with_redirection() {
    let mut map = baseline_map();
    map.validation_commands[0].command = "cargo test -p foo > out.txt".to_string();
    let errors = validate(&map).expect_err("redirection must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::ValidationCommandUnsafeShape { .. }),
        "ValidationCommandUnsafeShape/redirection",
    );
}

#[test]
fn rejects_validation_command_with_unknown_prefix() {
    let mut map = baseline_map();
    map.validation_commands[0].command = "bash test.sh".to_string();
    let errors = validate(&map).expect_err("unknown prefix must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::ValidationCommandPrefixUnknown { .. }),
        "ValidationCommandPrefixUnknown",
    );
}

#[test]
fn rejects_validation_command_with_empty_caption() {
    let mut map = baseline_map();
    map.validation_commands[0].caption = String::new();
    let errors = validate(&map).expect_err("empty caption must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::ValidationCommandCaptionEmpty { .. }),
        "ValidationCommandCaptionEmpty",
    );
}

#[test]
fn rejects_skip_outcome_with_non_semantic_reason() {
    let mut map = baseline_map();
    map.validation_commands[0].expected_outcome = ExpectedOutcome::Skip {
        reason: "host is busted".to_string(),
    };
    let errors = validate(&map).expect_err("non-semantic skip must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::SkipReasonNotSemantic { .. }),
        "SkipReasonNotSemantic",
    );
}

#[test]
fn rejects_fail_outcome_with_non_semantic_code() {
    let mut map = baseline_map();
    map.validation_commands[0].expected_outcome = ExpectedOutcome::Fail {
        semantic_code: "bad".to_string(),
    };
    let errors = validate(&map).expect_err("non-semantic fail must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::FailSemanticCodeMalformed { .. }),
        "FailSemanticCodeMalformed",
    );
}

#[test]
fn rejects_generated_at_not_rfc3339() {
    let mut map = baseline_map();
    map.generated_at = "yesterday".to_string();
    let errors = validate(&map).expect_err("non-rfc3339 must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::GeneratedAtNotRfc3339 { .. }),
        "GeneratedAtNotRfc3339",
    );
}

#[test]
fn rejects_unsupported_schema_version_major_bump() {
    let mut map = baseline_map();
    map.schema_version = "1.0.0".to_string();
    let errors = validate(&map).expect_err("major bump must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::UnsupportedSchemaVersion { .. }),
        "UnsupportedSchemaVersion",
    );
}

#[test]
fn accepts_minor_schema_version_within_same_major() {
    let mut map = baseline_map();
    map.schema_version = "0.1.5".to_string();
    validate(&map).expect("same-major minor bump validates");
}

#[test]
fn rejects_port_id_with_uppercase() {
    let mut map = baseline_map();
    map.port_id = PortId::new("Utsushi-Reallive");
    let errors = validate(&map).expect_err("uppercase port id must fail");
    assert_has_error(
        &errors,
        |e| matches!(e, ImplMapError::PortIdMalformed { .. }),
        "PortIdMalformed",
    );
}

// ---------------------------------------------------------------------------
// 7.3 Multi-error aggregation.
// ---------------------------------------------------------------------------

#[test]
fn returns_all_validation_errors_in_one_pass_for_a_map_with_three_distinct_violations() {
    let mut map = baseline_map();
    map.subsystems[0].fixture_ref.hash = String::new();
    map.subsystems[0].validation_command_id = ValidationCommandId::new("nope");
    map.subsystems.push(map.subsystems[0].clone());
    let errors = validate(&map).expect_err("multi-error must aggregate");
    assert!(
        errors
            .iter()
            .any(|e| matches!(e, ImplMapError::MissingFixtureProvenance { .. })),
        "missing fixture must be reported"
    );
    assert!(
        errors
            .iter()
            .any(|e| matches!(e, ImplMapError::OrphanValidationCommandRef { .. })),
        "orphan ref must be reported"
    );
    assert!(
        errors
            .iter()
            .any(|e| matches!(e, ImplMapError::DuplicateSubsystemId { .. })),
        "duplicate id must be reported"
    );
}

// ---------------------------------------------------------------------------
// 7.4 Diagnostic redaction.
// ---------------------------------------------------------------------------

#[test]
fn error_display_strings_pass_looks_like_local_path_filter() {
    let errors = vec![
        ImplMapError::PortIdMalformed {
            id: "/home/trevor/secret".to_string(),
        },
        ImplMapError::FixtureHashMalformed {
            subsystem_id: SubsystemId::new("subsys"),
            raw: "/home/trevor/host.txt".to_string(),
        },
        ImplMapError::ValidationCommandUnsafeShape {
            id: ValidationCommandId::new("cmd"),
            offending_token: "/home/trevor/bad".to_string(),
        },
        ImplMapError::UnsupportedReasonNotSemantic {
            subsystem_id: SubsystemId::new("subsys"),
            raw: "/Users/leak/host.txt".to_string(),
        },
        ImplMapError::SkipReasonNotSemantic {
            id: ValidationCommandId::new("cmd"),
            raw: "/tmp/leak".to_string(),
        },
        ImplMapError::GeneratedAtNotRfc3339 {
            raw: "/home/trevor/2026.txt".to_string(),
        },
        ImplMapError::UnsupportedSchemaVersion {
            declared: "/tmp/version".to_string(),
            supported: IMPL_MAP_SCHEMA_VERSION,
        },
    ];
    for error in errors {
        let rendered = format!("{error}");
        assert!(
            !looks_like_local_path(&rendered),
            "rendered diagnostic must not leak local path: {rendered}"
        );
        assert!(
            rendered.contains(REDACTED_LOCAL_PATH_TOKEN),
            "diagnostic should include redaction sentinel: {rendered}",
        );
    }
}

// ---------------------------------------------------------------------------
// 7.5 JSON schema parity.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 7.6 Cross-validation against PortManifest.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 7.7 verify_fixture_hashes helper.
// ---------------------------------------------------------------------------

struct InMemoryStore {
    by_id: std::collections::HashMap<String, Vec<u8>>,
}

impl InMemoryStore {
    fn new() -> Self {
        Self {
            by_id: std::collections::HashMap::new(),
        }
    }

    fn with(mut self, id: &str, bytes: &[u8]) -> Self {
        self.by_id.insert(id.to_string(), bytes.to_vec());
        self
    }
}

impl FixtureStore for InMemoryStore {
    fn read(&self, id: &str) -> Result<Vec<u8>, FixtureStoreError> {
        self.by_id
            .get(id)
            .cloned()
            .ok_or_else(|| FixtureStoreError {
                fixture_id: id.to_string(),
                message: "not in store".to_string(),
            })
    }
}

#[test]
fn verify_fixture_hashes_returns_ok_for_byte_for_byte_match() {
    let mut map = baseline_map();
    let bytes = b"some fixture bytes";
    let expected = sha256_hex(bytes);
    map.subsystems[0].fixture_ref.hash = expected;
    map.subsystems[0].fixture_ref.byte_count = bytes.len() as u64;
    let store = InMemoryStore::new().with(&map.subsystems[0].fixture_ref.id, bytes);
    verify_fixture_hashes(&map, &store).expect("hashes match");
}

#[test]
fn verify_fixture_hashes_returns_mismatch_when_store_bytes_diverge_from_declared_hash() {
    let mut map = baseline_map();
    let declared_bytes = b"declared";
    let observed_bytes = b"divergent";
    map.subsystems[0].fixture_ref.hash = sha256_hex(declared_bytes);
    map.subsystems[0].fixture_ref.byte_count = declared_bytes.len() as u64;
    let store = InMemoryStore::new().with(&map.subsystems[0].fixture_ref.id, observed_bytes);
    let mismatches = verify_fixture_hashes(&map, &store).expect_err("must mismatch");
    assert_eq!(mismatches.len(), 1);
    assert_eq!(mismatches[0].declared_hash, sha256_hex(declared_bytes));
    assert_eq!(mismatches[0].observed_hash, sha256_hex(observed_bytes));
}

// ---------------------------------------------------------------------------
// 7.8 Engine-neutrality discipline.
// ---------------------------------------------------------------------------

#[test]
fn schema_serialization_contains_no_engine_specific_field_names() {
    let banned = [
        "xp3_",
        "kag_",
        "rgss3_",
        "tjs_",
        "seen_",
        "gameexe_",
        "scene_pck_",
        "pixi_",
        "nwjs_",
        "unity_",
    ];
    let families = [
        EngineFamily::RealLive,
        EngineFamily::RpgmakerMv,
        EngineFamily::KirikiriKag,
        EngineFamily::Siglus,
        EngineFamily::Rgss3,
        EngineFamily::Unity,
    ];
    for family in families {
        let mut map = baseline_map();
        map.engine_family = family;
        if matches!(family, EngineFamily::Other) {
            map.engine_family_notes = Some("note".to_string());
        }
        let value = serde_json::to_value(&map).expect("serialize");
        let field_names = collect_field_names(&value);
        for banned_substr in banned {
            for name in &field_names {
                assert!(
                    !name.to_ascii_lowercase().contains(banned_substr),
                    "field name {name} contains engine-specific token {banned_substr} for family {family:?}"
                );
            }
        }
    }
}

fn collect_field_names(value: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    walk(value, &mut out);
    out
}

fn walk(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                out.push(k.clone());
                walk(v, out);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                walk(item, out);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// JSON Schema artifact drift guard. The schema document committed at
// `roadmap/impl-map.schema.json` must be semantically equal to
// `build_schema()` — i.e. the parsed JSON Value of the committed file equals
// the JSON Value emitted by build_schema(). Whitespace/formatting shape is
// owned by the JS-side formatter (vp/prettier) which inlines short arrays in
// a way `serde_json::to_string_pretty` does not; comparing parsed Values
// keeps the drift guard honest about semantic content while letting the
// formatter own surface shape. Set `BLESS_IMPL_MAP_SCHEMA=1` to regenerate
// the artifact (pretty-printed) when intentionally bumping the schema; the
// formatter will reflow it on the next `vp check --fix`.
// ---------------------------------------------------------------------------

#[test]
fn roadmap_schema_artifact_matches_build_schema_output() {
    let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("workspace root");
    let path = workspace_root.join("roadmap/impl-map.schema.json");

    if std::env::var("BLESS_IMPL_MAP_SCHEMA").is_ok() {
        let mut emitted = serde_json::to_string_pretty(&build_schema()).expect("serialize schema");
        emitted.push('\n');
        std::fs::write(&path, emitted.as_bytes()).expect("bless schema");
        return;
    }

    let committed_text = std::fs::read_to_string(&path).expect(
        "roadmap/impl-map.schema.json must exist; run with BLESS_IMPL_MAP_SCHEMA=1 to write it",
    );
    let committed_value: serde_json::Value =
        serde_json::from_str(&committed_text).expect("parse committed schema as JSON");
    let emitted_value = build_schema();
    assert_eq!(
        committed_value, emitted_value,
        "roadmap/impl-map.schema.json drifted from build_schema(); rerun with BLESS_IMPL_MAP_SCHEMA=1 (then `pnpm exec vp check --fix` to reflow)"
    );
}

// ---------------------------------------------------------------------------
// JSON fixture corpus parity tests.
// ---------------------------------------------------------------------------

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
