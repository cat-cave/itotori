use super::*;

#[test]
fn encoded_string_slot_validates_utf8_and_shift_jis_fixture_budgets() {
    for name in [
        "utf8_fixed",
        "utf8_null",
        "shift_jis_fixed",
        "shift_jis_null",
        "protected_token",
        "protected_token_duplicate",
    ] {
        let report = run_string_slot_fixture(name);
        assert_eq!(report.status, OperationStatus::Passed, "{name}: {report:?}");
    }
}

/// two identical source protected tokens require EXACTLY two
/// valid target mappings and occurrences. Under-count (collapsed/missing)
/// and over-count (extra target occurrence) both fail loud. Distinct-token
/// fixture still passes.
#[test]
fn encoded_string_slot_duplicate_raw_token_fixture_requires_multiplicity() {
    let pass = run_string_slot_fixture("protected_token_duplicate");
    assert_eq!(pass.status, OperationStatus::Passed, "{pass:?}");

    let distinct = run_string_slot_fixture("protected_token");
    assert_eq!(distinct.status, OperationStatus::Passed, "{distinct:?}");

    let collapsed = run_string_slot_fixture("protected_token_duplicate_collapsed");
    assert_eq!(collapsed.status, OperationStatus::Failed);
    assert_eq!(
        collapsed.diagnostics[0].code,
        STRING_SLOT_PROTECTED_SPAN_MUTATION
    );
    assert_eq!(
        collapsed.diagnostics[0].slot_id,
        "duplicate-raw-token-collapsed"
    );
    assert!(
        collapsed.diagnostics[0].message.contains("expected 2"),
        "{collapsed:?}"
    );
    assert!(
        collapsed.diagnostics[0].message.contains("sha256"),
        "{collapsed:?}"
    );
    assert_eq!(
        collapsed.diagnostics[0].remediation_code,
        "restore_protected_span"
    );

    let missing = run_string_slot_fixture("protected_token_duplicate_missing");
    assert_eq!(missing.status, OperationStatus::Failed);
    assert_eq!(
        missing.diagnostics[0].code,
        STRING_SLOT_PROTECTED_SPAN_MUTATION
    );
    assert_eq!(
        missing.diagnostics[0].slot_id,
        "duplicate-raw-token-missing"
    );
    assert!(
        missing.diagnostics[0].message.contains("expected 2"),
        "{missing:?}"
    );
    assert!(
        missing.diagnostics[0].message.contains("sha256"),
        "{missing:?}"
    );
    assert_eq!(
        missing.diagnostics[0].remediation_code,
        "restore_protected_span"
    );

    // Over-count: two required source tokens, three target occurrences, two
    // otherwise-valid mappings — must fail loud (exact multiplicity).
    let extra = run_string_slot_fixture("protected_token_duplicate_extra");
    assert_eq!(extra.status, OperationStatus::Failed);
    assert_eq!(
        extra.diagnostics[0].code,
        STRING_SLOT_PROTECTED_SPAN_MUTATION
    );
    assert_eq!(extra.diagnostics[0].slot_id, "duplicate-raw-token-extra");
    assert!(
        extra.diagnostics[0].message.contains("expected 2"),
        "{extra:?}"
    );
    assert!(extra.diagnostics[0].message.contains("sha256"), "{extra:?}");
    assert!(
        extra.diagnostics[0]
            .message
            .contains("3 target occurrence(s)"),
        "{extra:?}"
    );
    assert_eq!(
        extra.diagnostics[0].remediation_code,
        "restore_protected_span"
    );
}

#[test]
fn encoded_string_slot_reports_overflow_with_slot_range_and_remediation_code() {
    let mut value = string_slot_fixture("utf8_fixed");
    value["targetText"] = serde_json::json!("this text is too long for the slot");
    let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

    let report = slot.preflight(value["targetText"].as_str().unwrap(), &[], None);

    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.diagnostics[0].code, STRING_SLOT_OVERFLOW);
    assert_eq!(report.diagnostics[0].slot_id, "utf8-fixed-line");
    assert_eq!(
        report.diagnostics[0].byte_range,
        ByteSpan::new(16, 32).unwrap()
    );
    assert_eq!(
        report.diagnostics[0].remediation_code,
        "shorten_translation"
    );
}

#[test]
fn encoded_string_slot_reports_shift_jis_invalid_character() {
    let value = string_slot_fixture("shift_jis_fixed");
    let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

    let report = slot.preflight("hello 🚀", &[], None);

    assert_eq!(report.status, OperationStatus::Failed);
    let diagnostic = &report.diagnostics[0];
    assert_eq!(diagnostic.code, STRING_SLOT_INVALID_ENCODING);
    assert_eq!(diagnostic.remediation_code, "replace_unencodable_character");
    // Typed diagnostic names the slot id and byte range (the crux).
    assert_eq!(diagnostic.slot_id, "sjis-fixed-line");
    assert_eq!(diagnostic.byte_range, ByteSpan::new(128, 140).unwrap());
    // The message pinpoints the offending character and its encoded offset:
    // "hello " is 6 ASCII bytes, so the emoji is char index 6 at byte offset 6.
    assert!(
        diagnostic.message.contains("char index 6"),
        "message should name the offending char index: {}",
        diagnostic.message
    );
    assert!(
        diagnostic.message.contains("encoded byte offset 6"),
        "message should name the encoded byte offset: {}",
        diagnostic.message
    );
}

#[test]
fn encoded_string_slot_accepts_common_shift_jis_kanji_within_budget() {
    // Regression: the hand-coded subset had no
    // kanji, so common game text like 日本語 was wrongly rejected. The
    // encoding_rs Shift-JIS codec maps it to 6 bytes, which fits the
    // 12-byte (128..140) sjis-fixed-line budget.
    let value = string_slot_fixture("shift_jis_fixed");
    let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

    let report = slot.preflight("日本語", &[], None);

    assert_eq!(report.status, OperationStatus::Passed, "{report:?}");
    assert!(report.diagnostics.is_empty(), "{report:?}");
    assert_eq!(encode_shift_jis("日本語").unwrap().len(), 6);
}

#[test]
fn encoded_string_slot_accepts_fullwidth_shift_jis_within_budget() {
    // Fullwidth punctuation / ideographic space were also outside the
    // hand-coded subset. ！？　 is three double-byte characters (6 bytes),
    // fitting the 12-byte budget.
    let value = string_slot_fixture("shift_jis_fixed");
    let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

    let report = slot.preflight("！？　", &[], None);

    assert_eq!(report.status, OperationStatus::Passed, "{report:?}");
    assert!(report.diagnostics.is_empty(), "{report:?}");
    let encoded = encode_shift_jis("！？　").unwrap();
    assert_eq!(encoded.len(), 6);
    // Canonical JIS X 0208 byte sequences (predictable contract).
    assert_eq!(encoded, vec![0x81, 0x49, 0x81, 0x48, 0x81, 0x40]);
}

#[test]
fn encoded_string_slot_rejects_unmappable_shift_jis_with_slot_id_and_byte_range() {
    // U+20BB7 (𠮷, a CJK Extension B ideograph) is a valid Unicode scalar
    // but is not in the Shift-JIS repertoire, so it must reject with a
    // typed diagnostic naming the slot id + byte range, not silently pass.
    let value = string_slot_fixture("shift_jis_fixed");
    let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

    let report = slot.preflight("日\u{20BB7}", &[], None);

    assert_eq!(report.status, OperationStatus::Failed);
    let diagnostic = &report.diagnostics[0];
    assert_eq!(diagnostic.code, STRING_SLOT_INVALID_ENCODING);
    assert_eq!(diagnostic.slot_id, "sjis-fixed-line");
    assert_eq!(diagnostic.byte_range, ByteSpan::new(128, 140).unwrap());
    // 日 encodes to 2 Shift-JIS bytes, so the offending char is index 1 at
    // encoded byte offset 2.
    assert!(
        diagnostic.message.contains("char index 1"),
        "{}",
        diagnostic.message
    );
    assert!(
        diagnostic.message.contains("encoded byte offset 2"),
        "{}",
        diagnostic.message
    );
}

#[test]
fn encoded_string_slot_distinguishes_over_budget_mappable_from_unmappable() {
    // Mappable-but-over-budget must fail on the *budget* (overflow), which
    // is a distinct failure mode from unmappable (invalid encoding). Seven
    // kanji encode to 14 bytes, exceeding the 12-byte fixed-width budget.
    let value = string_slot_fixture("shift_jis_fixed");
    let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

    let report = slot.preflight("日本語日本語日", &[], None);

    assert_eq!(report.status, OperationStatus::Failed);
    let diagnostic = &report.diagnostics[0];
    assert_eq!(diagnostic.code, STRING_SLOT_OVERFLOW);
    assert_eq!(diagnostic.remediation_code, "shorten_translation");
    assert_eq!(diagnostic.slot_id, "sjis-fixed-line");
    assert_eq!(encode_shift_jis("日本語日本語日").unwrap().len(), 14);
}

#[test]
fn encoded_string_slot_reports_terminator_loss() {
    let value = string_slot_fixture("utf8_null");
    let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

    let report = slot.preflight("1234567890123456", &[], Some(b"unterminated"));

    let codes = report
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.as_str())
        .collect::<Vec<_>>();
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(codes.contains(&STRING_SLOT_TERMINATOR_LOSS));
    assert!(
        report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.remediation_code == "preserve_terminator")
    );
}

#[test]
fn encoded_string_slot_reports_protected_span_mutation() {
    let value = string_slot_fixture("protected_token");
    let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

    let report = slot.preflight("Hello, player.", &[], None);

    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(
        report.diagnostics[0].code,
        STRING_SLOT_PROTECTED_SPAN_MUTATION
    );
    assert_eq!(report.diagnostics[0].slot_id, "protected-token-line");
    assert_eq!(
        report.diagnostics[0].remediation_code,
        "restore_protected_span"
    );
}

#[test]
fn encoded_string_slot_allows_reordered_distinct_protected_span_mappings() {
    let slot = EncodedStringSlot {
        slot_id: "reordered-placeholders".to_string(),
        encoding: SourceEncoding::Utf8,
        byte_range: ByteSpan::new(0, 64).unwrap(),
        layout: EncodedStringSlotLayout::FixedWidth,
        protected_spans: vec![
            EncodedStringSlotProtectedSpan::new("{item}"),
            EncodedStringSlotProtectedSpan::new("{player}"),
        ],
    };

    let report = slot.preflight(
        "{player} gets {item}",
        &[
            ProtectedSpanMapping::new("{player}", 0, 8),
            ProtectedSpanMapping::new("{item}", 14, 20),
        ],
        None,
    );

    assert_eq!(report.status, OperationStatus::Passed, "{report:?}");
}

#[test]
fn encoded_string_slot_requires_distinct_target_ranges_for_duplicate_raw_spans() {
    let slot = EncodedStringSlot {
        slot_id: "duplicate-placeholders".to_string(),
        encoding: SourceEncoding::Utf8,
        byte_range: ByteSpan::new(0, 64).unwrap(),
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
    };

    let collapsed = slot.preflight(
        "{name} speaks.",
        &[
            ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                Some("source-span-1"),
                0,
                6,
            ),
            ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                Some("source-span-2"),
                13,
                19,
            ),
        ],
        None,
    );
    let explicit = slot.preflight(
        "{name} and {name}",
        &[
            ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                Some("source-span-1"),
                0,
                6,
            ),
            ProtectedSpanMapping::new("{name}", 11, 17).with_source_identity(
                Some("source-span-2"),
                13,
                19,
            ),
        ],
        None,
    );

    assert_eq!(collapsed.status, OperationStatus::Failed);
    assert!(collapsed.diagnostics[0].message.contains("expected 2"));
    assert_eq!(explicit.status, OperationStatus::Passed, "{explicit:?}");
}

#[test]
fn encoded_string_slot_rejects_duplicate_raw_protected_spans_without_source_identity() {
    let slot = EncodedStringSlot {
        slot_id: "duplicate-placeholders".to_string(),
        encoding: SourceEncoding::Utf8,
        byte_range: ByteSpan::new(0, 64).unwrap(),
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
    };

    let missing_identity = slot.preflight(
        "{name} and {name}",
        &[
            ProtectedSpanMapping::new("{name}", 0, 6),
            ProtectedSpanMapping::new("{name}", 11, 17),
        ],
        None,
    );
    let reused_source_identity = slot.preflight(
        "{name} and {name}",
        &[
            ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                Some("source-span-1"),
                0,
                6,
            ),
            ProtectedSpanMapping::new("{name}", 11, 17).with_source_identity(
                Some("source-span-1"),
                0,
                6,
            ),
        ],
        None,
    );
    let wrong_source_identity = slot.preflight(
        "{name} and {name}",
        &[
            ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                Some("source-span-1"),
                0,
                6,
            ),
            ProtectedSpanMapping::new("{name}", 11, 17).with_source_identity(
                Some("source-span-2"),
                20,
                26,
            ),
        ],
        None,
    );

    assert_eq!(missing_identity.status, OperationStatus::Failed);
    assert_eq!(reused_source_identity.status, OperationStatus::Failed);
    assert_eq!(wrong_source_identity.status, OperationStatus::Failed);
}
