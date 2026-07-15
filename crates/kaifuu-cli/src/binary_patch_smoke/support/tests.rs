use super::*;

use kaifuu_reallive::parse_archive;

#[test]
fn map_patchback_error_to_v02_failure_is_exhaustive_over_every_variant() {
    // Exact (variant -> category, diagnosticCode) pairs. Pinning the
    // precise mapping per variant — rather than mere set-membership —
    // means a wrong mapping fails the test. Source-side faults
    // (BundleSchemaInvalid, ProvenanceMismatch) map to
    // `source_incompatible`; every other (write-side) variant maps to
    // `patch_write_failed`.
    let table: Vec<(PatchbackError, &str, &str)> = vec![
        (
            PatchbackError::BundleSchemaInvalid {
                message: "synthetic".into(),
            },
            "source_incompatible",
            PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE,
        ),
        (
            PatchbackError::ArchiveParseFailure {
                message: "synthetic".into(),
            },
            "patch_write_failed",
            PATCHBACK_ARCHIVE_PARSE_FAILURE_CODE,
        ),
        (
            PatchbackError::ProvenanceMismatch {
                bridge_unit_id: "u".into(),
                start_byte: 0,
                end_byte: 1,
                reason: "synthetic".into(),
            },
            "source_incompatible",
            PATCHBACK_PROVENANCE_MISMATCH_CODE,
        ),
        (
            PatchbackError::SceneHeaderInvalid {
                scene_id: 1,
                message: "synthetic".into(),
            },
            "patch_write_failed",
            PATCHBACK_SCENE_HEADER_INVALID_CODE,
        ),
        (
            PatchbackError::DecompressFailure {
                scene_id: 1,
                message: "synthetic".into(),
            },
            "patch_write_failed",
            PATCHBACK_DECOMPRESS_FAILURE_CODE,
        ),
        (
            PatchbackError::CompressFailure {
                scene_id: 1,
                message: "synthetic".into(),
            },
            "patch_write_failed",
            PATCHBACK_COMPRESS_FAILURE_CODE,
        ),
        (
            PatchbackError::TargetEncodeFailure {
                bridge_unit_id: "u".into(),
                message: "synthetic".into(),
            },
            "patch_write_failed",
            PATCHBACK_TARGET_ENCODE_FAILURE_CODE,
        ),
        (
            PatchbackError::ScenePackingOverflow {
                observed_size: 0,
                reason: "synthetic".into(),
            },
            "patch_write_failed",
            PATCHBACK_SCENE_PACKING_OVERFLOW_CODE,
        ),
        (
            PatchbackError::ControlMarkupOnlyTarget {
                bridge_unit_id: "u".into(),
            },
            "source_incompatible",
            PATCHBACK_CONTROL_MARKUP_ONLY_TARGET_CODE,
        ),
    ];

    // Guards exhaustiveness: if a PatchbackError variant is added, this
    // count must be updated alongside a new table row.
    assert_eq!(
        table.len(),
        9,
        "every mapped PatchbackError variant is pinned"
    );

    for (error, expected_category, expected_diagnostic) in &table {
        let value = map_patchback_error_to_v02_failure(error);
        let category = value
            .get("category")
            .and_then(Value::as_str)
            .expect("category present");
        assert_eq!(
            category, *expected_category,
            "category mismatch for {error:?}"
        );
        let diagnostic_code = value
            .get("diagnosticCode")
            .and_then(Value::as_str)
            .expect("diagnosticCode present");
        assert_eq!(
            diagnostic_code, *expected_diagnostic,
            "diagnosticCode mismatch for {error:?}"
        );
    }
}

#[test]
fn build_synthetic_seen_txt_parses_with_one_scene() {
    let archive = build_synthetic_seen_txt();
    let index = parse_archive(&archive).expect("synthetic archive parses");
    assert_eq!(index.entries.len(), 1);
}

/// FIX-1 acceptance: the synthetic scene's decompressed bytecode parses
/// through the CURRENT (post-) parser with **0 unknown
/// opcodes** and exercises the four target roles — Textout, TextDisplay,
/// SetSpeaker (`CharacterTextDisplay`), and Choice. This is the
/// non-tautological guard: it asserts real parser-shape facts, not just
/// "the builder returns bytes".
#[test]
fn synthetic_scene_decodes_four_roles_with_zero_unknown_opcodes() {
    use kaifuu_reallive::{RealLiveOpcode, parse_scene};

    let bytecode = synthetic_scene_bytecode();

    // (1) Decode the real bytecode: ZERO unknown opcodes.
    let opcodes = parse_scene(&bytecode).expect("scene bytecode decodes");
    let unknown: Vec<&RealLiveOpcode> = opcodes.iter().filter(|o| !o.is_recognized()).collect();
    assert!(
        unknown.is_empty(),
        "synthetic scene must decode with 0 unknown opcodes; found {unknown:?}"
    );

    // (2) All four target opcode variants are present.
    assert!(
        opcodes
            .iter()
            .any(|o| matches!(o, RealLiveOpcode::Textout { .. })),
        "Textout role present"
    );
    assert!(
        opcodes
            .iter()
            .any(|o| matches!(o, RealLiveOpcode::TextDisplay { .. })),
        "TextDisplay role present"
    );
    assert!(
        opcodes
            .iter()
            .any(|o| matches!(o, RealLiveOpcode::CharacterTextDisplay)),
        "SetSpeaker (CharacterTextDisplay) role present"
    );
    assert!(
        opcodes
            .iter()
            .any(|o| matches!(o, RealLiveOpcode::Choice { .. })),
        "Choice role present"
    );
}

/// FIX-1 structural faithfulness: the synthetic scene blob is a real
/// scene-header + AVG32 LZSS + XOR compressed frame whose payload
/// round-trips byte-identically back to the authored decompressed
/// bytecode (the same framing a real Seen.txt scene carries, and the
/// shape the bundle_driven patchback decompresses / recompresses).
#[test]
fn synthetic_scene_blob_round_trips_through_avg32_compression_framing() {
    use kaifuu_reallive::{SceneHeader, decompress_avg32, parse_scene};

    let archive = build_synthetic_seen_txt();
    let index = parse_archive(&archive).expect("envelope parses");
    let entry = &index.entries[0];
    let blob = &archive
        [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize];

    let header = SceneHeader::parse(blob).expect("synthetic scene header parses");
    let compressed = &blob[header.bytecode_offset as usize
        ..(header.bytecode_offset + header.bytecode_compressed_size) as usize];
    let decompressed = decompress_avg32(compressed, header.bytecode_uncompressed_size as usize)
        .expect("AVG32 decompresses");
    assert_eq!(
        decompressed,
        synthetic_scene_bytecode(),
        "AVG32 LZSS + XOR round-trips byte-identically to the authored bytecode"
    );
    assert!(
        !parse_scene(&decompressed)
            .expect("decompressed decodes")
            .is_empty(),
        "decompressed bytecode decodes to a non-empty opcode stream"
    );
}
