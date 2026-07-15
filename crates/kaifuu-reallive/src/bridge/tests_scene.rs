use super::test_support::*;
use super::*;
use crate::gameexe::parse_gameexe_inventory;

#[test]
fn empty_decompressed_bytecode_raises_typed_empty_scene_not_silent_ok() {
    let report = parse_gameexe_inventory(b"");
    let err = produce_bundle(1, &[0u8; 32], &[], &report, &opts_for_test())
        .expect_err("empty decompressed must error");
    assert!(matches!(
        err,
        BridgeProduceError::EmptyScene { scene_id: 1 }
    ));
}

#[test]
fn meta_only_scene_surfaces_no_text_units_not_empty_bundle() {
    // MetaLine(2), MetaLine(3), MetaEntrypoint(0).
    let bytecode = &[0x0a, 0x02, 0x00, 0x0a, 0x03, 0x00, 0x21, 0x00, 0x00];
    let report = parse_gameexe_inventory(b"");
    let err = produce_bundle(1, &[0u8; 32], bytecode, &report, &opts_for_test())
        .expect_err("meta-only bytecode produces no text units");
    assert!(matches!(err, BridgeProduceError::NoTextUnits { .. }));
}

#[test]
fn shift_jis_textout_emits_dialogue_unit_with_decoded_source_text() {
    // Shift-JIS for "ハ" (0x83 0x6E) followed by MetaLine to bound.
    let bytecode = &[0x83, 0x6E, 0x0a, 0x05, 0x00];
    let report = parse_gameexe_inventory(b"");
    let produced = produce_bundle(1, &[0u8; 32], bytecode, &report, &opts_for_test())
        .expect("textout must produce a dialogue unit");
    assert_eq!(produced.bundle.units.len(), 1);
    let unit = &produced.bundle.units[0];
    assert_eq!(unit.surface_kind, "dialogue");
    assert!(unit.source_text.contains('ハ'));
}

#[test]
fn kidoku_marker_before_textout_emits_protected_span_kind_reallive_kidoku() {
    // MetaKidoku(42), Shift-JIS textout, MetaLine to bound.
    let bytecode = &[0x40, 0x2a, 0x00, 0x83, 0x6E, 0x0a, 0x05, 0x00];
    let report = parse_gameexe_inventory(b"");
    let produced = produce_bundle(1, &[0u8; 32], bytecode, &report, &opts_for_test())
        .expect("kidoku+textout must produce a unit");
    let unit_json = &produced.json["units"][0];
    let spans = unit_json["spans"].as_array().expect("spans array present");
    assert!(
        spans
            .iter()
            .any(|span| { span["parsedName"] == "reallive.kidoku" && span["outOfBand"] == true }),
        "at least one span with parsedName=reallive.kidoku must be emitted; got {spans:?}"
    );
}

#[test]
fn table_kidoku_synthesis_marks_span_out_of_band() {
    // No inline MetaKidoku; the scene header's table count synthesises the
    // structural marker on the first readable text unit.
    let bytecode = &[0x83, 0x6E, 0x0a, 0x05, 0x00];
    let report = parse_gameexe_inventory(b"");
    let mut opts = opts_for_test();
    opts.scene_kidoku_count = 3;
    let produced = produce_bundle(1, &[0u8; 32], bytecode, &report, &opts)
        .expect("table-driven kidoku synthesis must produce a unit");
    let unit = &produced.json["units"][0];
    let spans = unit["spans"].as_array().expect("spans array present");
    let kidoku = spans
        .iter()
        .find(|span| span["parsedName"] == "reallive.kidoku")
        .expect("synthesised kidoku span present");
    assert_eq!(kidoku["outOfBand"], true);
    assert_eq!(unit["sourceText"], "<reallive.kidoku table:3>ハ");
}

#[test]
fn provenance_byte_range_is_a_decompressed_stream_interval_not_a_file_offset() {
    // The first (and only) text unit starts at decompressed offset 0.
    // The range must be a pure decompressed-stream interval — NOT
    // anchored at any scene blob file offset (the prior bug added the
    // file offset, which pushed deep units into a later scene during
    // patchback).
    let bytecode = &[0x83, 0x6E, 0x0a, 0x05, 0x00];
    let report = parse_gameexe_inventory(b"");
    let produced = produce_bundle(1, &[0u8; 32], bytecode, &report, &opts_for_test())
        .expect("textout must produce a dialogue unit");
    let range = &produced.json["units"][0]["sourceLocation"]["range"];
    let start = range["startByte"].as_u64().expect("startByte u64");
    let end = range["endByte"].as_u64().expect("endByte u64");
    assert_eq!(
        start, 0,
        "first unit must start at decompressed offset 0, not a file offset; got {start:#x}"
    );
    assert!(
        end > start && end <= bytecode.len() as u64,
        "range must be a positive-width interval inside the decompressed bytecode; got {start}..{end}"
    );
}

#[test]
fn empty_choice_option_does_not_drift_occurrence_index_of_later_units() {
    // Bytecode: Textout(ハ), select{ "A", <empty>, "B" }, Textout(ニ).
    // The empty option must NOT consume an occurrence_index, so every
    // later unit keeps the same occurrence the patchback re-walk
    // (collect_text_unit_positions) assigns.
    // COMMAND header (8 bytes): 0x23, module_type=0, module_id=SEL(2),
    // opcode=1 (select), argc, overload, reserved; then the
    // SelectElement `{ … }` block. The middle option is an empty entry
    // (a bare `\n`+line marker with no text), which `decode_select`
    // drops — emitting only "A" and "B".
    let mut bytecode: Vec<u8> = Vec::new();
    bytecode.extend_from_slice(&[0x83, 0x6E]); // Textout "ハ" -> occ 0
    bytecode.extend_from_slice(&[0x23, 0x00, 0x02, 0x01, 0x00, 0x02, 0x00, 0x00]);
    bytecode.push(b'{');
    bytecode.extend_from_slice(b"A"); // option A -> occ 1
    bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]);
    bytecode.extend_from_slice(&[0x0a, 0x06, 0x00]); // empty option -> dropped
    bytecode.extend_from_slice(b"B"); // option B -> occ 2
    bytecode.extend_from_slice(&[0x0a, 0x07, 0x00]);
    bytecode.push(b'}');
    bytecode.extend_from_slice(&[0x83, 0x70]); // Textout "ニ" -> occ 3
    bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]); // MetaLine terminator

    let report = parse_gameexe_inventory(b"");
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("scene with empty choice option must produce units");

    // Producer occurrence indices, in encounter order, parsed from
    // the canonical sourceUnitKey `reallive:scene-NNNN#OOOO`.
    let producer: Vec<(usize, String)> = produced
        .bundle
        .units
        .iter()
        .map(|u| {
            let occ = u
                .source_unit_key
                .split('#')
                .nth(1)
                .and_then(|s| s.parse::<usize>().ok())
                .expect("occurrence in sourceUnitKey");
            (occ, u.surface_kind.clone())
        })
        .collect();

    // Exactly four units (the empty option emitted none), and the
    // trailing dialogue unit sits at occurrence 3 (no drift).
    assert_eq!(
        producer,
        vec![
            (0, "dialogue".to_string()),
            (1, "choice_label".to_string()),
            (2, "choice_label".to_string()),
            (3, "dialogue".to_string()),
        ],
        "empty `,,` option must not consume an occurrence_index"
    );
}

#[test]
fn protected_span_failing_validation_surfaces_typed_error_not_silent_drop() {
    // 005 regression: build_unit_json bare-`continue`d on a span that
    // failed its byte-range / raw-bytes equality check, dropping the
    // protected span (and its preserveMode=exact guard) with no error.
    // The contract forbids that — a mismatch must surface a typed
    // BridgeProduceError.
    let base_unit = |spans: Vec<ProtoSpan>| ProtoUnit {
        surface_kind: "dialogue",
        decoded_text: "本文".to_string(),
        control_prefix: String::new(),
        spans,
        raw_speaker: None,
        speaker_from_fallback: false,
        resolution: SpeakerResolution::NotApplicable,
        decompressed_byte_offset: 0,
        decompressed_byte_len: 6,
        voice_archive_id: None,
        voice_sample_id: None,
        occurrence_index: 0,
        choice_group_index: None,
        choice_option_index: None,
    };

    // Raw-bytes mismatch: span claims bytes 0..5 are "#FACE" but the
    // sourceText bytes there are the decoded dialogue.
    let mismatch = base_unit(vec![ProtoSpan {
        parsed_name: "reallive.asset_ref",
        out_of_band: false,
        start_byte: 0,
        end_byte: 5,
        raw: "#FACE".to_string(),
    }]);
    let err = build_unit_json(7, "a", "k", "r", "h", "ns", &opts_for_test(), &mismatch)
        .expect_err("mismatched protected span must error, not be dropped");
    assert!(
        matches!(
            err,
            BridgeProduceError::ProtectedSpanInvalid {
                scene_id: 7,
                parsed_name: "reallive.asset_ref",
                ..
            }
        ),
        "expected ProtectedSpanInvalid"
    );

    // Out-of-range: end_byte past sourceText length.
    let oob = base_unit(vec![ProtoSpan {
        parsed_name: "reallive.font_tone",
        out_of_band: false,
        start_byte: 0,
        end_byte: 999,
        raw: "x".to_string(),
    }]);
    let err = build_unit_json(7, "a", "k", "r", "h", "ns", &opts_for_test(), &oob)
        .expect_err("out-of-range protected span must error, not be dropped");
    assert!(
        matches!(
            err,
            BridgeProduceError::ProtectedSpanInvalid {
                parsed_name: "reallive.font_tone",
                ..
            }
        ),
        "expected ProtectedSpanInvalid"
    );
}

#[test]
fn protected_span_mismatch_redacts_source_content_from_error_renderings() {
    const SOURCE_SENTINEL: &str = "RBH_SOURCE_DIALOGUE_SENTINEL";
    const RAW_SENTINEL: &str = "RBH_PROTECTED_SPAN_SENTINEL";

    let unit = ProtoUnit {
        surface_kind: "dialogue",
        decoded_text: SOURCE_SENTINEL.to_string(),
        control_prefix: String::new(),
        spans: vec![ProtoSpan {
            parsed_name: "reallive.asset_ref",
            out_of_band: false,
            start_byte: 0,
            end_byte: SOURCE_SENTINEL.len() as u64,
            raw: RAW_SENTINEL.to_string(),
        }],
        raw_speaker: None,
        speaker_from_fallback: false,
        resolution: SpeakerResolution::NotApplicable,
        decompressed_byte_offset: 0,
        decompressed_byte_len: SOURCE_SENTINEL.len() as u64,
        voice_archive_id: None,
        voice_sample_id: None,
        occurrence_index: 0,
        choice_group_index: None,
        choice_option_index: None,
    };
    let err = build_unit_json(7, "a", "k", "r", "h", "ns", &opts_for_test(), &unit)
        .expect_err("mismatched protected span must error");
    let display = err.to_string();
    let debug = format!("{err:?}");
    let protected_range = unit.spans[0].start_byte as usize..unit.spans[0].end_byte as usize;
    let protected_range_len = protected_range.len();
    let source_summary =
        RedactedContentSummary::from_bytes(&SOURCE_SENTINEL.as_bytes()[protected_range]);
    let raw_summary = RedactedContentSummary::from_text(RAW_SENTINEL);

    for rendered in [&display, &debug] {
        assert!(
            !rendered.contains(SOURCE_SENTINEL),
            "protected-span errors must not emit source text"
        );
        assert!(
            !rendered.contains(RAW_SENTINEL),
            "protected-span errors must not emit protected-span text"
        );
        assert!(rendered.contains(&source_summary.to_string()));
        assert!(rendered.contains(&raw_summary.to_string()));
        assert!(rendered.contains(source_summary.sha256()));
        assert!(rendered.contains(raw_summary.sha256()));
    }
    assert!(display.contains("scene 7 unit 0 span #0"));
    assert!(display.contains("parsedName=reallive.asset_ref"));
    assert!(display.contains(&source_summary.to_string()));
    assert!(display.contains(&raw_summary.to_string()));
    assert!(debug.contains("scene_id: 7"));
    assert!(debug.contains("occurrence_index: 0"));
    assert!(debug.contains("span_index: 0"));
    assert!(debug.contains("parsed_name: \"reallive.asset_ref\""));
    assert_eq!(source_summary.byte_len(), protected_range_len);
    assert_eq!(raw_summary.byte_len(), unit.spans[0].raw.len());
}

#[test]
fn unit_offset_after_choice_command_tracks_authoritative_decode_width_no_drift() {
    // 004 regression: the unit that follows a Choice command must be
    // anchored at the REAL width `decode_command` consumed, never a
    // hand-reconstructed table. The `module_sel` `SelectElement`
    // `{ … }` block here consumes 18 bytes (8-byte header + `{` + "A" +
    // `\n`+line + "B" + `\n`+line + `}`), so the trailing dialogue must
    // anchor at 2 (first Textout) + 18 = 20.
    // Bytecode: Textout "ハ" (2 bytes) | select{ "A", "B" } (18 bytes)
    // | Textout "ニ" (occurrence 3) | MetaLine terminator.
    let mut bytecode: Vec<u8> = Vec::new();
    bytecode.extend_from_slice(&[0x83, 0x6E]); // Textout "ハ" -> occ 0, offset 0
    bytecode.extend_from_slice(&[0x23, 0x00, 0x02, 0x01, 0x00, 0x02, 0x00, 0x00]);
    bytecode.push(b'{');
    bytecode.extend_from_slice(b"A"); // option A -> occ 1
    bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]);
    bytecode.extend_from_slice(b"B"); // option B -> occ 2
    bytecode.extend_from_slice(&[0x0a, 0x06, 0x00]);
    bytecode.push(b'}');
    bytecode.extend_from_slice(&[0x83, 0x70]); // Textout "ニ" -> occ 3
    bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]); // MetaLine terminator

    let report = parse_gameexe_inventory(b"");
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("scene with choice must produce units");

    // The trailing dialogue unit (occurrence 3) must start at the real
    // cursor: 2 (first Textout) + 18 (select header+block) = 20.
    let trailing = produced
        .json
        .get("units")
        .and_then(|u| u.as_array())
        .and_then(|units| {
            units.iter().find(|u| {
                u["sourceUnitKey"]
                    .as_str()
                    .is_some_and(|k| k.ends_with("#0003"))
            })
        })
        .expect("occurrence-3 dialogue unit present");
    let start = trailing["sourceLocation"]["range"]["startByte"]
        .as_u64()
        .expect("startByte u64");
    assert_eq!(
        start, 20,
        "unit after Choice must anchor at the authoritative decode width (20)"
    );
}

#[test]
fn predicate_classifies_real_binary_block_as_non_translatable_and_real_dialogue_as_translatable() {
    use crate::test_fixtures::{SCENE1_BINARY_BLOCK_214B, SCENE2011_DIALOGUE_SJIS};
    // Real bytes: the Sweetie HD scene-1 214-byte binary data block is
    // NOT translatable; a real scene-2011 Shift-JIS dialogue line IS.
    assert!(
        decode_dialogue_textout(SCENE1_BINARY_BLOCK_214B).is_none(),
        "the 214-byte periodic-binary data block must be excluded from translatable units"
    );
    assert!(
        decode_dialogue_textout(SCENE2011_DIALOGUE_SJIS).is_some(),
        "a real Shift-JIS dialogue line must remain translatable (no false negative)"
    );
}

#[test]
fn binary_catch_all_textout_is_excluded_while_real_sjis_dialogue_is_surfaced() {
    use crate::test_fixtures::{
        SCENE1_BINARY_BLOCK_214B, SCENE2011_DIALOGUE_SJIS, SCENE2011_DIALOGUE_TEXT,
    };
    // A scene whose bytecode is [real dialogue Textout][MetaLine]
    // [214-byte binary Textout][MetaLine]. Both runs parse as a single
    // Textout each (verified against the live corpus). The bridge must
    // surface ONLY the dialogue run as a translatable unit and drop the
    // binary run entirely.
    let mut bytecode: Vec<u8> = Vec::new();
    bytecode.extend_from_slice(SCENE2011_DIALOGUE_SJIS);
    bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]); // MetaLine terminator
    bytecode.extend_from_slice(SCENE1_BINARY_BLOCK_214B);
    bytecode.extend_from_slice(&[0x0a, 0x06, 0x00]); // MetaLine terminator

    // Sanity: the raw bytecode does parse as exactly two Textout runs,
    // so the test is genuinely exercising the surface-selection split
    // (not an artefact of the binary bytes fragmenting).
    let opcodes = crate::opcode::parse_real_bytecode(&bytecode).expect("bytecode parses");
    let textouts: Vec<&[u8]> = opcodes
        .iter()
        .filter_map(|op| match op {
            RealLiveOpcode::Textout { raw_bytes, .. } => Some(raw_bytes.as_slice()),
            _ => None,
        })
        .collect();
    assert_eq!(
        textouts.len(),
        2,
        "fixture must decode to exactly two Textout runs (dialogue + binary)"
    );
    assert!(
        textouts[1] == SCENE1_BINARY_BLOCK_214B,
        "binary block mismatch: actual {}, expected {}",
        RedactedContentSummary::from_bytes(textouts[1]),
        RedactedContentSummary::from_bytes(SCENE1_BINARY_BLOCK_214B),
    );

    let report = parse_gameexe_inventory(b"");
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("dialogue run must produce a bundle");

    // Exactly one translatable unit (the dialogue); the binary run is
    // excluded.
    assert_eq!(
        produced.bundle.units.len(),
        1,
        "only the readable Shift-JIS dialogue run is surfaced; the binary run is excluded"
    );
    let unit = &produced.bundle.units[0];
    assert_eq!(unit.surface_kind, "dialogue");
    assert!(
        unit.source_text.contains(SCENE2011_DIALOGUE_TEXT),
        "the surfaced unit must carry the decoded dialogue text (sourceText {})",
        RedactedContentSummary::from_text(&unit.source_text)
    );
    // No surfaced unit may carry the binary block's decoded form.
    let (binary_decoded, _, _) = encoding_rs::SHIFT_JIS.decode(SCENE1_BINARY_BLOCK_214B);
    assert!(
        !unit.source_text.contains(binary_decoded.as_ref()),
        "no translatable unit may carry the binary data block's bytes"
    );
}
