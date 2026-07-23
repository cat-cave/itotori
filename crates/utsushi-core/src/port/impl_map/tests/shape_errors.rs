use super::*;

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
