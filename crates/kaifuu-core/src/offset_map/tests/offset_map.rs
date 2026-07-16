use super::*;

#[test]
fn byte_span_rejects_inverted_offsets() {
    let error = ByteSpan::new(10, 9).unwrap_err();
    assert_eq!(error.diagnostics()[0].code, "kaifuu.invalid_offset");
}

#[test]
fn byte_span_deserialization_rejects_inverted_offsets() {
    let error = serde_json::from_value::<ByteSpan>(serde_json::json!({
        "start": 10,
        "end": 9
    }))
    .unwrap_err();
    assert!(error.to_string().contains("kaifuu.invalid_offset"));
}

#[test]
fn validates_utf8_shift_jis_binary_table_and_sliced_buffer_fixtures() {
    for name in ["utf8", "shift_jis", "binary_table", "sliced_buffer"] {
        let value = fixture(name);
        assert_eq!(
            validate_offset_map_value(&value).status,
            OperationStatus::Passed,
            "{name}"
        );
    }
}

#[test]
fn translates_variable_width_source_bytes_without_rounding() {
    let offset_map = typed_fixture("shift_jis");
    assert_eq!(
        offset_map
            .source_to_decoded(ByteSpan::new(0, 2).unwrap())
            .unwrap(),
        ByteSpan::new(0, 3).unwrap()
    );
    let error = offset_map
        .source_to_decoded(ByteSpan::new(1, 2).unwrap())
        .unwrap_err();
    assert_eq!(error.diagnostics()[0].code, "kaifuu.invalid_offset");
}

#[test]
fn translates_source_decoded_and_patched_ranges() {
    let offset_map = typed_fixture("binary_table");
    assert_eq!(
        offset_map
            .source_to_patched(ByteSpan::new(8, 16).unwrap())
            .unwrap(),
        ByteSpan::new(10, 21).unwrap()
    );
    assert_eq!(
        offset_map
            .patched_to_decoded(ByteSpan::new(10, 21).unwrap())
            .unwrap(),
        ByteSpan::new(5, 10).unwrap()
    );
}

#[test]
fn source_range_validation_checks_identity_and_bounds() {
    let offset_map = typed_fixture("sliced_buffer");
    let range = SourceRange::new(
        "script.ks",
        "rev-2026-06-18",
        SourceEncoding::ShiftJis,
        ByteSpan::new(100, 108).unwrap(),
    )
    .unwrap();
    assert_eq!(
        range.validate_against(&offset_map).status,
        OperationStatus::Passed
    );

    let out_of_range = SourceRange::new(
        "script.ks",
        "rev-2026-06-18",
        SourceEncoding::ShiftJis,
        ByteSpan::new(196, 208).unwrap(),
    )
    .unwrap();
    let validation = out_of_range.validate_against(&offset_map);
    assert_eq!(validation.status, OperationStatus::Failed);
    assert_eq!(
        validation.diagnostics[0].code,
        "kaifuu.out_of_range_source_range"
    );
}

#[test]
fn validator_reports_missing_revision_overlap_and_out_of_range_semantics() {
    let mut value = fixture("utf8");
    value.as_object_mut().unwrap().remove("sourceRevisionId");
    value["segments"][1]["sourceBytes"]["start"] = serde_json::json!(0);
    value["segments"][2]["sourceBytes"]["end"] = serde_json::json!(99);

    let validation = validate_offset_map_value(&value);
    let codes = validation
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.as_str())
        .collect::<Vec<_>>();
    assert!(codes.contains(&"kaifuu.missing_source_revision_id"));
    assert!(codes.contains(&"kaifuu.overlapping_spans"));
    assert!(codes.contains(&"kaifuu.out_of_range_source_range"));
}

#[test]
fn validator_rejects_detached_decoded_source_axes() {
    let mut value = fixture("utf8");
    value["segments"][0]["sourceBytes"] = serde_json::json!({ "start": 0, "end": 0 });

    let validation = validate_offset_map_value(&value);
    assert_eq!(validation.status, OperationStatus::Failed);
    let codes = validation
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.as_str())
        .collect::<Vec<_>>();
    assert!(codes.contains(&"kaifuu.detached_offset_segment"));
}

#[test]
fn offset_map_deserialization_rejects_detached_decoded_source_axes() {
    let mut value = fixture("utf8");
    value["segments"][0]["sourceBytes"] = serde_json::json!({ "start": 0, "end": 0 });

    let error = serde_json::from_value::<OffsetMap>(value).unwrap_err();
    assert!(
        error.to_string().contains("kaifuu.detached_offset_segment"),
        "{error}"
    );
}

#[test]
fn offset_map_segment_constructor_rejects_detached_axes() {
    let error = OffsetMapSegment::new(
        ByteSpan::new(0, 0).unwrap(),
        ByteSpan::new(0, 1).unwrap(),
        ByteSpan::new(0, 1).unwrap(),
    )
    .unwrap_err();
    assert_eq!(
        error.diagnostics()[0].code,
        "kaifuu.detached_offset_segment"
    );
}
