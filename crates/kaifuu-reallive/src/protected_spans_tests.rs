use super::*;

fn detect_for(bytes: &[u8]) -> ProtectedSpanReport {
    let decoded = crate::encoding::decode_shift_jis_slot(bytes).text;
    detect_protected_spans(bytes, &decoded).expect("detection should succeed for this input")
}

/// Regression: a control directive whose argument byte is a Shift-JIS
/// LEAD byte makes the prefix-decode length land *inside* a multi-byte
/// char of the whole-slot decode. Slicing `decoded_text[a..b]` at a
/// non-char-boundary previously panicked and crashed the inventory walk
/// (`protected-span-sjis-prefix-length-index-panic`). It must now return
/// a typed `Err`.
#[test]
fn truncated_sjis_lead_byte_before_color_code_yields_typed_err() {
    // 0x1f color-code control byte; its argument byte 0x83 is a SJIS
    // lead byte that pairs with the following 0x9f as `Α` (U+0391, 2
    // UTF-8 bytes) in the whole-slot decode, while the prefix decode of
    // `[0x1f, 0x83]` yields `\u{1f}` + U+FFFD (4 bytes) — landing the
    // decoded_end at byte 4, mid-`あ`.
    let bytes = &[0x1f, 0x83, 0x9f, 0x82, 0xa0][..];
    let decoded = crate::encoding::decode_shift_jis_slot(bytes).text;
    let result = detect_protected_spans(bytes, &decoded);
    assert!(
        matches!(
            result,
            Err(ProtectedSpanError::DecodedRangeNotCharBoundary { .. })
        ),
        "expected DecodedRangeNotCharBoundary, got {result:?}"
    );
}

#[test]
fn detects_color_code_with_index() {
    let bytes = &[0x1f, 0x03, b'H', b'i'][..];
    let report = detect_for(bytes);
    assert_eq!(report.warnings.len(), 0);
    assert_eq!(report.spans.len(), 1);
    match &report.spans[0].kind {
        ProtectedSpanKind::ColorCode { color_index } => assert_eq!(*color_index, 0x03),
        other => panic!("expected color code, got {other:?}"),
    }
}

#[test]
fn detects_ruby_with_base_and_ruby_text() {
    // `<0x0d>base<0x0a>ruby<0x09>` — all ASCII for testing.
    let mut bytes = vec![0x0d];
    bytes.extend_from_slice(b"base");
    bytes.push(0x0a);
    bytes.extend_from_slice(b"ruby");
    bytes.push(0x09);
    let report = detect_for(&bytes);
    assert_eq!(report.spans.len(), 1);
    match &report.spans[0].kind {
        ProtectedSpanKind::Ruby { base, ruby } => {
            assert_eq!(base, "base");
            assert_eq!(ruby, "ruby");
        }
        other => panic!("expected ruby, got {other:?}"),
    }
}

#[test]
fn detects_name_placeholder() {
    let bytes = b"hi \\{0\\}";
    let report = detect_for(bytes);
    assert_eq!(report.spans.len(), 1);
    match &report.spans[0].kind {
        ProtectedSpanKind::NamePlaceholder { index } => assert_eq!(index, "0"),
        other => panic!("expected name placeholder, got {other:?}"),
    }
}

#[test]
fn detects_choice_token() {
    let bytes = &[0x02, 0x01, b'Y', b'e', b's'][..];
    let report = detect_for(bytes);
    assert_eq!(report.spans.len(), 1);
    match &report.spans[0].kind {
        ProtectedSpanKind::ChoiceToken { choice_index } => assert_eq!(*choice_index, 0x01),
        other => panic!("expected choice token, got {other:?}"),
    }
}

#[test]
fn detects_size_directive_wait_clear_linebreak() {
    let bytes = &[0x1e, 0x05, b'a', 0x10, 0x60, 0x0c, b'b', 0x0a][..];
    let report = detect_for(bytes);
    let kinds: Vec<_> = report.spans.iter().map(|s| s.kind.label()).collect();
    assert_eq!(
        kinds,
        vec![
            "text_size_directive",
            "wait_directive",
            "clear_text_box",
            "line_break"
        ]
    );
}

#[test]
fn detects_variable_placeholder() {
    let bytes = b"name is \\\\character";
    let report = detect_for(bytes);
    assert_eq!(report.spans.len(), 1);
    match &report.spans[0].kind {
        ProtectedSpanKind::VariablePlaceholder { name } => assert_eq!(name, "character"),
        other => panic!("expected variable placeholder, got {other:?}"),
    }
}

#[test]
fn emits_unknown_control_warning_for_unlisted_byte() {
    // 0x05 is not in the catalogue.
    let bytes = &[0x05, b'x'][..];
    let report = detect_for(bytes);
    assert_eq!(report.warnings.len(), 1);
    assert_eq!(report.warnings[0].code, PROTECTED_SPAN_UNKNOWN_CONTROL_CODE);
    // The byte is preserved as an UnknownControl span.
    assert_eq!(report.spans.len(), 1);
    match &report.spans[0].kind {
        ProtectedSpanKind::UnknownControl { byte } => assert_eq!(*byte, 0x05),
        other => panic!("expected unknown control, got {other:?}"),
    }
}
