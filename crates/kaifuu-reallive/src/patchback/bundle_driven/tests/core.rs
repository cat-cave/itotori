use super::super::*;
use super::*;
use crate::scope::TranslationScope;

#[test]
fn strip_out_of_band_control_markup_removes_kidoku_keeps_name_and_prose() {
    // Inline (single) kidoku marker + in-body name token + prose.
    assert_eq!(
        strip_out_of_band_control_markup("<reallive.kidoku 1>【和人】「hello」"),
        "【和人】「hello」"
    );
    // Synthesised table-form marker.
    assert_eq!(
        strip_out_of_band_control_markup("<reallive.kidoku table:1>narration"),
        "narration"
    );
    // Multiple markers (Kanon double-kidoku) anywhere in the string.
    assert_eq!(
        strip_out_of_band_control_markup("<reallive.kidoku 26><reallive.kidoku 27>「x」"),
        "「x」"
    );
    // No marker: verbatim.
    assert_eq!(strip_out_of_band_control_markup("「plain」"), "「plain」");
    // Unterminated marker: keep the remainder, never silently truncate.
    assert_eq!(
        strip_out_of_band_control_markup("<reallive.kidoku 1"),
        "<reallive.kidoku 1"
    );
}

#[test]
fn patch_scene_blob_rejects_bytecode_offset_inside_header_region() {
    // 006 regression: patch_scene_blob guarded only the upper bound
    // (bytecode_end > blob.len); a header declaring bytecode_offset
    // < SCENE_HEADER_BYTE_LEN slipped through and re-emitted a corrupt
    // scene (compressed payload at 0x1d0 while the preserved offset
    // points inside the header). It must now surface a typed
    // SceneHeaderInvalid before any mutation.
    let mut blob = vec![0u8; SCENE_HEADER_BYTE_LEN + 16];
    // bytecode_offset (0x20) = 0x20, well inside the 0x1d0 header.
    blob[0x20..0x24].copy_from_slice(&0x20u32.to_le_bytes());
    // compressed_size (0x28) small enough that bytecode_end is in
    // bounds — proving the NEW lower-bound guard is what fires.
    blob[0x28..0x2c].copy_from_slice(&4u32.to_le_bytes());

    let err = patch_scene_blob(42, &blob, &[], None)
        .expect_err("bytecode_offset inside the header must be rejected");
    assert!(
        matches!(err, PatchbackError::SceneHeaderInvalid { scene_id: 42, .. }),
        "expected SceneHeaderInvalid, got {err:?}"
    );
}

#[test]
fn empty_bundle_is_identity_round_trip_through_archive_self_check() {
    let SyntheticArchive { archive, .. } = build_synthetic_archive();
    // A bundle with zero target units is a programming error
    // (validate_json requires `units` to match the source side),
    // but a 1-unit bundle with target_text identical to the source
    // body should still re-emit a parseable archive.
    let bundle_json = make_bundle_json(
        REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
        0, // decompressed_byte_offset: Textout starts at decompressed offset 0
        2,
        "Hi", // 2-byte ASCII fits the source 2-byte SJIS body
    );
    let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
    let patched = apply_translated_bundle(
        &archive,
        &bundle,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect("apply succeeds");
    // Re-parse must yield a directory with the same number of
    // populated entries.
    let reparsed = parse_archive(&patched).expect("patched archive re-parses");
    assert_eq!(reparsed.entries.len(), 1);
}

#[test]
fn source_identical_target_is_a_noop_scene_stays_byte_identical() {
    let SyntheticArchive { archive, .. } = build_synthetic_archive();
    let source_blob = scene_blob(&archive, 1).to_vec();
    let bundle_json = make_bundle_json(
        REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
        0,
        2,
        "Synthetic source text",
    );
    let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");

    let patched = apply_translated_bundle(
        &archive,
        &bundle,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect("source-identical target must be a no-op");

    assert_eq!(
        scene_blob(&patched, 1),
        source_blob.as_slice(),
        "a source-identical target must carry the original scene blob verbatim"
    );
}

#[test]
fn changed_target_still_re_emits_scene() {
    let SyntheticArchive { archive, .. } = build_synthetic_archive();
    let source_blob = scene_blob(&archive, 1).to_vec();
    let bundle_json = make_bundle_json(REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, 0, 2, "Hi");
    let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");

    let patched = apply_translated_bundle(
        &archive,
        &bundle,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect("changed target must re-emit the scene");

    assert_ne!(
        scene_blob(&patched, 1),
        source_blob.as_slice(),
        "a changed target must cause its owning scene to be re-emitted"
    );
}

#[test]
fn target_differing_only_in_kidoku_marker_is_noop() {
    let SyntheticArchive { archive, .. } = build_synthetic_archive();
    let source_blob = scene_blob(&archive, 1).to_vec();
    let bundle_json = make_bundle_json(
        REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
        0,
        2,
        "<reallive.kidoku 1>Synthetic source text",
    );
    let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");

    let patched = apply_translated_bundle(
        &archive,
        &bundle,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect("marker-only difference must be a no-op");

    assert_eq!(
        scene_blob(&patched, 1),
        source_blob.as_slice(),
        "a target differing only by an out-of-band marker must carry the original scene blob verbatim"
    );
}

#[test]
fn apply_strips_out_of_band_kidoku_marker_and_splices_only_the_body() {
    // A target carrying the producer's synthetic `<reallive.kidoku N>`
    // marker (as the translation prompt reproduces it inline) must have
    // that marker STRIPPED before the splice: the literal ASCII bytes of
    // `<reallive.kidoku` must never reach the patched bytecode, and the
    // real body ("Hi") must be spliced.
    let SyntheticArchive { archive, .. } = build_synthetic_archive();
    let bundle_json = make_bundle_json(
        REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
        0,
        2,
        "<reallive.kidoku 1>Hi",
    );
    let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
    let patched = apply_translated_bundle(
        &archive,
        &bundle,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect("apply succeeds after stripping the out-of-band marker");
    let decompressed = decompress_scene(&patched, 1);
    let marker_bytes = REALLIVE_OUT_OF_BAND_MARKER_OPEN.as_bytes();
    assert!(
        !decompressed
            .windows(marker_bytes.len())
            .any(|w| w == marker_bytes),
        "the `<reallive.kidoku ` literal must NOT appear in the patched bytecode"
    );
    let hi = encode_shift_jis_slot("Hi").expect("encode Hi");
    assert!(
        decompressed.windows(hi.len()).any(|w| w == hi.as_slice()),
        "the translated body 'Hi' must be spliced into the patched bytecode"
    );
}

#[test]
fn apply_rejects_target_that_is_only_out_of_band_control_markup() {
    let SyntheticArchive { archive, .. } = build_synthetic_archive();
    let bundle_json = make_bundle_json(
        REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
        0,
        2,
        "<reallive.kidoku 1>",
    );
    let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
    let err = apply_translated_bundle(
        &archive,
        &bundle,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect_err("a control-markup-only target must be rejected");
    assert!(
        matches!(err, PatchbackError::ControlMarkupOnlyTarget { .. }),
        "expected ControlMarkupOnlyTarget, got {err:?}"
    );
}

#[test]
fn unit_naming_a_scene_absent_from_the_archive_emits_typed_mismatch_error() {
    let SyntheticArchive { archive, .. } = build_synthetic_archive();
    // Scene attribution is by scene id (from sourceUnitKey), not by
    // byte containment. Name a scene the archive does not contain.
    let mut bundle_json = make_bundle_json(REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, 0, 2, "Hi");
    bundle_json["units"][0]["sourceUnitKey"] = serde_json::json!("reallive:scene-9999#0000");
    bundle_json["units"][0]["patchRef"]["sourceUnitKey"] =
        serde_json::json!("reallive:scene-9999#0000");
    let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
    let err = apply_translated_bundle(
        &archive,
        &bundle,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect_err("must reject a unit naming an absent scene");
    assert!(
        matches!(err, PatchbackError::ProvenanceMismatch { .. }),
        "expected ProvenanceMismatch, got {err:?}"
    );
}

#[test]
fn schema_invalid_bundle_emits_typed_error_before_any_write() {
    let SyntheticArchive { archive, .. } = build_synthetic_archive();
    // Drop schemaVersion to force v0.2 validation failure.
    let mut bundle_json = make_bundle_json(
        REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
        0, // decompressed_byte_offset: Textout starts at decompressed offset 0
        2,
        "Hi",
    );
    bundle_json
        .as_object_mut()
        .expect("object")
        .remove("schemaVersion");
    let err = TranslatedBundleV02::from_json(&bundle_json)
        .expect_err("schema-invalid bundle must surface typed error");
    assert!(
        matches!(err, PatchbackError::BundleSchemaInvalid { .. }),
        "expected BundleSchemaInvalid, got {err:?}"
    );
    // Sanity: the archive is unchanged.
    let reparsed = parse_archive(&archive).expect("source still parses");
    assert_eq!(reparsed.entries.len(), 1);
}

#[test]
fn missing_target_text_surfaces_typed_schema_invalid() {
    let mut bundle_json = make_bundle_json(
        REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
        0, // decompressed_byte_offset: Textout starts at decompressed offset 0
        2,
        "Hi",
    );
    bundle_json["units"][0]
        .as_object_mut()
        .expect("object")
        .remove("target");
    let err = TranslatedBundleV02::from_json(&bundle_json)
        .expect_err("missing target object must surface typed error");
    assert!(matches!(err, PatchbackError::BundleSchemaInvalid { .. }));
}
