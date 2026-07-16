use super::*;

#[test]
fn string_relocation_rejects_duplicate_raw_protected_spans_without_source_identity() {
    let request = StringTableRebuildRequest {
        fixture_id: "duplicate-protected-relocation".to_string(),
        source_bytes_hex: "00".repeat(32),
        slots: vec![StringRelocationSlot {
            slot_id: "line-1".to_string(),
            encoding: SourceEncoding::Utf8,
            old_byte_range: ByteSpan::new(0, 32).unwrap(),
            layout: EncodedStringSlotLayout::FixedWidth,
            protected_spans: vec![
                EncodedStringSlotProtectedSpan::new("{name}").with_source_identity(
                    Some("source-span-1"),
                    0,
                    6,
                ),
                EncodedStringSlotProtectedSpan::new("{name}").with_source_identity(
                    Some("source-span-2"),
                    13,
                    19,
                ),
            ],
        }],
        replacements: vec![StringRelocationTarget {
            slot_id: "line-1".to_string(),
            target_text: "{name} and {name}".to_string(),
            protected_span_mappings: vec![
                ProtectedSpanMapping::new("{name}", 0, 6),
                ProtectedSpanMapping::new("{name}", 11, 17),
            ],
        }],
        references: vec![],
        string_slot_diagnostics: vec![],
    };

    let report = plan_string_table_rebuild(&request);

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.string_slot_diagnostics.iter().any(|diagnostic| {
        diagnostic.code == STRING_SLOT_PROTECTED_SPAN_MUTATION
            && diagnostic.message.contains("expected 2")
    }));
}

#[test]
fn string_relocation_pointer_table_rebuilds_expanded_shortened_and_shared_slots() {
    let (request, expected_output) = typed_string_relocation_fixture("pointer_table");

    let report = plan_string_table_rebuild(&request);

    assert_eq!(report.status, OperationStatus::Passed, "{report:?}");
    assert_eq!(
        report.output_bytes_hex.as_deref(),
        Some(expected_output.as_str())
    );
    assert_eq!(report.relocated_strings.len(), 2);
    assert_eq!(
        report.relocated_strings[0].old_byte_range,
        ByteSpan::new(16, 20).unwrap()
    );
    assert_eq!(
        report.relocated_strings[0].new_byte_range,
        ByteSpan::new(16, 22).unwrap()
    );
    assert_eq!(
        report.relocated_strings[1].old_byte_range,
        ByteSpan::new(20, 26).unwrap()
    );
    assert_eq!(
        report.relocated_strings[1].new_byte_range,
        ByteSpan::new(22, 25).unwrap()
    );

    let shared_targets = report
        .relocated_references
        .iter()
        .filter(|reference| reference.slot_id == "line.shared")
        .map(|reference| reference.target_new_byte_range)
        .collect::<Vec<_>>();
    assert_eq!(
        shared_targets,
        vec![
            ByteSpan::new(22, 25).unwrap(),
            ByteSpan::new(22, 25).unwrap()
        ]
    );
    assert!(report.relocated_references.iter().all(|reference| {
        reference.relocation_kind == StringReferenceRelocationKind::PointerTable
            && reference
                .output_hash_inputs
                .iter()
                .any(|input| input.starts_with("targetNew="))
    }));
    assert!(report.relocated_strings.iter().all(|relocated| {
        relocated
            .output_hash_inputs
            .iter()
            .any(|input| input.starts_with("encodedHash="))
    }));
}

#[test]
fn string_relocation_index_table_rebuilds_same_size_fixture_deterministically() {
    let (request, expected_output) = typed_string_relocation_fixture("index_table");

    let first = plan_string_table_rebuild(&request);
    let second = plan_string_table_rebuild(&request);

    assert_eq!(first.status, OperationStatus::Passed, "{first:?}");
    assert_eq!(first, second);
    assert_eq!(
        first.output_bytes_hex.as_deref(),
        Some(expected_output.as_str())
    );
    assert_eq!(first.relocated_strings.len(), 2);
    assert!(first.relocated_references.iter().all(
        |reference| reference.relocation_kind == StringReferenceRelocationKind::IndexTable
    ));
}

#[test]
fn string_relocation_unsupported_pointer_format_fails_before_output_materialization() {
    let (mut request, _) = typed_string_relocation_fixture("pointer_table");
    request.references[0].format = StringReferenceFormat::Unsupported {
        format_id: "relative24".to_string(),
    };

    let report = plan_string_table_rebuild(&request);

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.output_bytes_hex.is_none());
    assert_eq!(
        report.relocation_diagnostics[0].code,
        STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT
    );
}

#[test]
fn string_relocation_unresolved_reference_fails_before_output_materialization() {
    let (mut request, _) = typed_string_relocation_fixture("pointer_table");
    request.references[0].slot_id = "missing.slot".to_string();

    let report = plan_string_table_rebuild(&request);

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.output_bytes_hex.is_none());
    assert!(
        report
            .relocation_diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == STRING_RELOCATION_UNRESOLVED_REFERENCE)
    );
}

#[test]
fn string_relocation_overlapping_writes_fail_before_output_materialization() {
    let (mut request, _) = typed_string_relocation_fixture("pointer_table");
    request.references[0].byte_range = ByteSpan::new(16, 20).unwrap();

    let report = plan_string_table_rebuild(&request);

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.output_bytes_hex.is_none());
    assert!(
        report
            .relocation_diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == STRING_RELOCATION_OVERLAPPING_WRITES)
    );
}

/// Regression: a genuinely EMPTY source (`sourceBytesHex == ""`) parses
/// to a zero-length byte vector, which previously gated OFF the slot
/// bounds check (`source_len!= 0`). A positive-offset slot then slipped
/// through validation into `plan_string_table_rebuild`, where the gap
/// copy `source_bytes[gap_start..gap_end]` indexed the empty slice and
/// panicked (OOB). It must now fail with a typed bounds diagnostic
/// (`kaifuu-offset-map-empty-source-bypasses-bounds-then-oob-panic`).
#[test]
fn string_relocation_empty_source_with_positive_offset_slot_fails_typed_not_oob_panic() {
    let (mut request, _) = typed_string_relocation_fixture("pointer_table");
    // Slots in this fixture start at byte offset 16; an empty source can
    // not contain them.
    request.source_bytes_hex = String::new();

    let report = plan_string_table_rebuild(&request);

    assert_eq!(report.status, OperationStatus::Failed, "{report:?}");
    assert!(report.output_bytes_hex.is_none());
    assert!(
        report
            .relocation_diagnostics
            .iter()
            .any(
                |diagnostic| diagnostic.code == STRING_RELOCATION_UNRESOLVED_REFERENCE
                    && diagnostic.message == "slot byte range exceeds source bytes"
            ),
        "expected a typed slot-bounds diagnostic, got {:?}",
        report.relocation_diagnostics
    );
}

/// Regression: a hex PARSE FAILURE must surface its own typed diagnostic
/// and must NOT collapse to `source_len = 0` (which would disable bounds
/// checks and risk the empty-source OOB path above). The parse-failure
/// case is kept distinct from a genuinely empty source.
#[test]
fn string_relocation_unparseable_source_fails_typed_distinct_from_empty() {
    let (mut request, _) = typed_string_relocation_fixture("pointer_table");
    // Odd-length, non-hex garbage: cannot parse as hex bytes.
    request.source_bytes_hex = "zz".to_string();

    let report = plan_string_table_rebuild(&request);

    assert_eq!(report.status, OperationStatus::Failed, "{report:?}");
    assert!(report.output_bytes_hex.is_none());
    assert!(
        report
            .relocation_diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == STRING_RELOCATION_INVALID_SOURCE_BYTES),
        "expected a typed invalid-source-bytes diagnostic, got {:?}",
        report.relocation_diagnostics
    );
    // A parse failure must NOT be reported as an in-bounds-only success,
    // and must NOT masquerade as a genuinely empty source (no spurious
    // bounds bypass).
    assert!(
        report
            .relocation_diagnostics
            .iter()
            .all(|diagnostic| diagnostic.message != "slot byte range exceeds source bytes"),
        "parse failure must not also emit empty-source bounds diagnostics: {:?}",
        report.relocation_diagnostics
    );
}

#[test]
fn string_relocation_pointer_table_wrong_source_target_fails_before_output_materialization() {
    let request = invalid_string_relocation_fixture("pointer_table_wrong_target");

    let report = plan_string_table_rebuild(&request);

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.output_bytes_hex.is_none());
    assert!(report.output_hash.is_none());
    assert!(
        report.relocation_diagnostics.iter().any(|diagnostic| {
            diagnostic.code == STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH
                && diagnostic.reference_id.as_deref() == Some("ptr.line.001")
                && diagnostic.slot_id.as_deref() == Some("line.001")
                && diagnostic
                    .message
                    .contains("source reference decodes to old target 20")
        }),
        "{report:?}"
    );
    assert!(report.relocated_references.is_empty());
}

#[test]
fn string_relocation_index_table_wrong_source_target_fails_before_output_materialization() {
    let request = invalid_string_relocation_fixture("index_table_wrong_target");

    let report = plan_string_table_rebuild(&request);

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.output_bytes_hex.is_none());
    assert!(report.output_hash.is_none());
    assert!(
        report.relocation_diagnostics.iter().any(|diagnostic| {
            diagnostic.code == STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH
                && diagnostic.reference_id.as_deref() == Some("idx.menu.001")
                && diagnostic.slot_id.as_deref() == Some("menu.001")
                && diagnostic
                    .message
                    .contains("index_le_u16 table entries encode")
        }),
        "{report:?}"
    );
    assert!(report.relocated_references.is_empty());
}

#[test]
fn string_relocation_report_composes_with_encoded_string_slot_preflight_diagnostics() {
    let (mut request, _) = typed_string_relocation_fixture("pointer_table");
    request
        .string_slot_diagnostics
        .push(EncodedStringSlotDiagnostic {
            code: STRING_SLOT_OVERFLOW.to_string(),
            slot_id: "line.001".to_string(),
            byte_range: ByteSpan::new(16, 20).unwrap(),
            message: "encoded target exceeded in-place slot budget".to_string(),
            remediation_code: "shorten_translation".to_string(),
            remediation: "shorten the translation or relocate the string".to_string(),
        });

    let report = plan_string_table_rebuild(&request);

    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.string_slot_diagnostics.len(), 1);
    assert!(report.output_bytes_hex.is_none());
}

#[test]
fn string_relocation_diagnostic_maps_to_preflight_blocking_adapter_failure() {
    let (mut request, _) = typed_string_relocation_fixture("pointer_table");
    request.references[0].format = StringReferenceFormat::Unsupported {
        format_id: "relative24".to_string(),
    };
    let report = plan_string_table_rebuild(&request);
    let failure = crate::AdapterFailure::string_relocation_preflight(
        "kaifuu.fixture",
        "fixture",
        "string-relocation",
        "asset-redacted",
        report.relocation_diagnostics[0].clone(),
    );

    assert_eq!(
        failure.error_code,
        STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT
    );
    assert!(failure.is_preflight_blocking());
    assert_eq!(
        failure.required_capability,
        Some(crate::Capability::PatchBack)
    );
}
