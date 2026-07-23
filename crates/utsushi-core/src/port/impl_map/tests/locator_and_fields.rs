use super::*;

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

// 7.3 Multi-error aggregation.

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

// 7.4 Diagnostic redaction.

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

// 7.5 JSON schema parity.
