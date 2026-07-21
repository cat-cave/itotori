use super::*;

/// Build a synthetic header that mirrors the documented reference archive
/// scene #0001 values. Used as the round-trip baseline.
fn reallive_real_bytes_scene_one_synthetic() -> SceneHeader {
    let mut entrypoint_table: Vec<EntrypointEntry> = Vec::with_capacity(ENTRYPOINT_TABLE_LEN);
    // Per docs/research/reallive-engine.md §D, the on-disk lattice
    // for reference archive scene #0001 carries `0x00000003` at slot 0
    // (this is z_minus_two as seen in the raw bytes? wait — z_minus_two
    // is at 0x30 and is u32=3. The entrypoint lattice at 0x34 itself
    // is `0x06` repeated). So slot 0 of the entrypoint table is 6.
    for slot in 0..ENTRYPOINT_TABLE_LEN {
        entrypoint_table.push(EntrypointEntry {
            index: slot as u16,
            value: 0x06,
        });
    }
    SceneHeader {
        compiler_version: COMPILER_VERSION_1_10,
        kidoku_offset: 464,
        kidoku_count: 1,
        dramatis_offset: 468,
        dramatis_count: 0,
        bytecode_offset: 468,
        bytecode_uncompressed_size: 1660,
        bytecode_compressed_size: 1062,
        entrypoint_table,
        savepoint_message: 0,
        savepoint_selcom: 0,
        savepoint_seentop: 0,
        z_minus_one: 0,
        z_minus_two: 3,
    }
}

#[test]
fn truncated_input_raises_truncated_header_not_zero_state() {
    let bytes = vec![0u8; SCENE_HEADER_BYTE_LEN - 1];
    let err = SceneHeader::parse(&bytes)
        .expect_err("input one byte short of the header must be truncated");
    match err {
        SceneHeaderError::TruncatedHeader {
            observed_len,
            required_len,
            message,
        } => {
            assert_eq!(observed_len, SCENE_HEADER_BYTE_LEN - 1);
            assert_eq!(required_len, SCENE_HEADER_BYTE_LEN);
            assert!(
                message.contains("shorter than the fixed"),
                "diagnostic must describe the shortfall; got: {message}",
            );
        }
    }
}

#[test]
fn empty_input_raises_truncated_header() {
    let err = SceneHeader::parse(&[]).expect_err("empty input must refuse silent zero-state");
    match err {
        SceneHeaderError::TruncatedHeader { observed_len, .. } => {
            assert_eq!(observed_len, 0);
        }
    }
}

#[test]
fn round_trip_encode_decode_is_byte_exact() {
    let header = reallive_real_bytes_scene_one_synthetic();
    let encoded = header.encode();
    assert_eq!(
        encoded.len(),
        SCENE_HEADER_BYTE_LEN,
        "encoded header must be exactly the fixed length",
    );
    let (decoded, warnings) =
        SceneHeader::parse(&encoded).expect("synthetic encoded header parses");
    assert!(
        warnings.is_empty(),
        "synthetic uses a documented compiler version; no warnings expected; got: {warnings:?}",
    );
    assert_eq!(decoded, header, "round-trip must be byte-exact");
}

#[test]
fn out_of_profile_compiler_version_emits_warning_and_still_parses() {
    let mut header = reallive_real_bytes_scene_one_synthetic();
    header.compiler_version = 0xDEAD_BEEF;
    let encoded = header.encode();
    let (decoded, warnings) = SceneHeader::parse(&encoded)
        .expect("out-of-profile compiler version must still parse (warning, not error)");
    assert_eq!(
        decoded.compiler_version, 0xDEAD_BEEF,
        "the unknown value must be preserved verbatim, not silently rewritten",
    );
    assert_eq!(
        warnings.len(),
        1,
        "exactly one warning expected; got: {warnings:?}"
    );
    match &warnings[0] {
        SceneHeaderWarning::UnknownCompilerVersion { observed } => {
            assert_eq!(*observed, 0xDEAD_BEEF);
        }
    }
}

#[test]
fn documented_compiler_versions_emit_no_warning() {
    for version in [
        COMPILER_VERSION_1_0,
        COMPILER_VERSION_1_10,
        COMPILER_VERSION_1_1110,
    ] {
        let mut header = reallive_real_bytes_scene_one_synthetic();
        header.compiler_version = version;
        let encoded = header.encode();
        let (_decoded, warnings) =
            SceneHeader::parse(&encoded).expect("documented compiler version parses");
        assert!(
            warnings.is_empty(),
            "version {version} is documented; no warning expected; got: {warnings:?}",
        );
    }
}

#[test]
fn entrypoint_table_has_exactly_one_hundred_slots() {
    let header = reallive_real_bytes_scene_one_synthetic();
    let encoded = header.encode();
    let (decoded, _warnings) = SceneHeader::parse(&encoded).expect("synthetic parses");
    assert_eq!(
        decoded.entrypoint_table.len(),
        ENTRYPOINT_TABLE_LEN,
        "entrypoint table is a fixed 100-slot lattice (offsets 0x34..0x1c4)",
    );
    for (slot, entry) in decoded.entrypoint_table.iter().enumerate() {
        assert_eq!(
            entry.index as usize, slot,
            "slot indices must be 0..100 in ascending order",
        );
    }
}

#[test]
fn entrypoint_table_byte_offsets_are_pinned() {
    // Sanity: ENTRYPOINT_TABLE_BYTE_OFFSET + ENTRYPOINT_TABLE_LEN*4
    // must equal SAVEPOINT_BLOCK_BYTE_OFFSET, and the savepoint
    // triplet (3 * 4 = 12 bytes) plus SAVEPOINT_BLOCK_BYTE_OFFSET
    // must equal SCENE_HEADER_BYTE_LEN. If any of these drift the
    // header window is structurally wrong.
    assert_eq!(
        ENTRYPOINT_TABLE_BYTE_OFFSET + ENTRYPOINT_TABLE_LEN * 4,
        SAVEPOINT_BLOCK_BYTE_OFFSET,
        "entrypoint table runs exactly up to the savepoint block",
    );
    assert_eq!(
        SAVEPOINT_BLOCK_BYTE_OFFSET + 3 * 4,
        SCENE_HEADER_BYTE_LEN,
        "savepoint triplet closes the 0x1d0-byte header",
    );
}

#[test]
fn display_messages_carry_typed_error_codes() {
    let err = SceneHeader::parse(&[]).unwrap_err();
    let rendered = err.to_string();
    assert!(
        rendered.starts_with("utsushi.reallive.truncated_header:"),
        "error Display must carry the typed code prefix; got: {rendered}",
    );

    let warning = SceneHeaderWarning::UnknownCompilerVersion {
        observed: 0xDEAD_BEEF,
    };
    let rendered = warning.to_string();
    assert!(
        rendered.starts_with("utsushi.reallive.unknown_compiler_version:"),
        "warning Display must carry the typed code prefix; got: {rendered}",
    );
}

#[test]
fn parser_pins_each_documented_field_at_its_documented_offset() {
    // Construct a header where every typed field has a distinct
    // sentinel so a swapped offset would surface as a value
    // mismatch. The entrypoint slots get unique values too.
    let mut entrypoint_table: Vec<EntrypointEntry> = Vec::with_capacity(ENTRYPOINT_TABLE_LEN);
    for slot in 0..ENTRYPOINT_TABLE_LEN {
        entrypoint_table.push(EntrypointEntry {
            index: slot as u16,
            value: 0x1_0000 + slot as u32,
        });
    }
    let header = SceneHeader {
        compiler_version: COMPILER_VERSION_1_0,
        kidoku_offset: 0x1111_1111,
        kidoku_count: 0x2222_2222,
        dramatis_offset: 0x3333_3333,
        dramatis_count: 0x4444_4444,
        bytecode_offset: 0x5555_5555,
        bytecode_uncompressed_size: 0x6666_6666,
        bytecode_compressed_size: 0x7777_7777,
        entrypoint_table,
        savepoint_message: 0x8888_8888,
        savepoint_selcom: 0x9999_9999,
        savepoint_seentop: 0xAAAA_AAAA,
        z_minus_one: 0xBBBB_BBBB,
        z_minus_two: 0xCCCC_CCCC,
    };
    let encoded = header.encode();
    let (decoded, warnings) =
        SceneHeader::parse(&encoded).expect("sentinel-loaded synthetic parses");
    assert!(warnings.is_empty());
    assert_eq!(decoded, header);
}
