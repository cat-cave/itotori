use serde_json::json;

use crate::bridge::{BridgeOpts, produce_bundle};
use crate::compress::compress_siglus_lzss;
use crate::decrypt::apply_xor_table;
use crate::expression::FM_STR;
use crate::gameexe::GameexeDatReport;
use crate::scene_decode::decode_scene_chunk;

use super::{PatchbackError, PatchbackOpts, TranslatedBundleV02, apply_translated_bundle};

#[test]
fn patchback_preserves_identity_splices_a_string_and_gates_stale_source() {
    let source = "source literal";
    let target = "a longer translated literal";
    let (archive, decoded, chunk) = archive_with_one_scene(source);
    let bridge = produce_bridge(&chunk, &decoded);
    let source_key = bridge.bundle.units[0].source_unit_key.clone();

    let identity = translated_json(&bridge.json, None);
    let identity_bundle = TranslatedBundleV02::from_json(&identity).expect("identity bundle");
    assert_eq!(
        apply_translated_bundle(&archive, &identity_bundle, &PatchbackOpts::utf16le())
            .expect("identity patch"),
        archive,
        "all identity targets keep Scene.pck byte-identical"
    );

    let changed = translated_json(&bridge.json, Some(("0", target)));
    let changed_bundle = TranslatedBundleV02::from_json(&changed).expect("changed bundle");
    let patched = apply_translated_bundle(&archive, &changed_bundle, &PatchbackOpts::utf16le())
        .expect("length-changing patch");
    let index = crate::archive::parse_scene_pck(&patched).expect("patched archive parses");
    let entry = &index.entries[0];
    let raw =
        &patched[entry.byte_offset as usize..entry.byte_offset as usize + entry.byte_len as usize];
    let after = decode_scene_chunk(entry.scene_id, raw, index.extra_key_use, None)
        .expect("patched scene decodes");
    let reparsed = produce_bridge(raw, &after);
    assert_eq!(
        reparsed
            .bundle
            .units
            .iter()
            .find(|unit| unit.source_unit_key == source_key)
            .expect("same text surface")
            .source_text,
        target
    );

    let mut stale = identity;
    stale["units"][0]["sourceHash"] = json!(format!("sha256:{}", "0".repeat(64)));
    let stale_bundle = TranslatedBundleV02::from_json(&stale).expect("stale schema remains valid");
    assert!(matches!(
        apply_translated_bundle(&archive, &stale_bundle, &PatchbackOpts::utf16le()),
        Err(PatchbackError::StaleSource { .. })
    ));
}

#[test]
fn patchback_rebases_later_string_table_entries_after_a_longer_target() {
    let first = "first literal";
    let second = "second literal";
    let target = "a substantially longer first literal";
    let decoded = decoded_two_strings(first, second);
    let (archive, chunk) = archive_with_decoded(&decoded);
    let bridge = produce_bridge(&chunk, &decoded);
    let first_key = bridge.bundle.units[0].source_unit_key.clone();
    let second_key = bridge.bundle.units[1].source_unit_key.clone();
    let changed = translated_json(&bridge.json, Some(("0", target)));
    let bundle = TranslatedBundleV02::from_json(&changed).expect("changed bundle");
    let patched = apply_translated_bundle(&archive, &bundle, &PatchbackOpts::utf16le())
        .expect("patch a first string");
    let index = crate::archive::parse_scene_pck(&patched).expect("patched archive parses");
    let entry = &index.entries[0];
    let raw =
        &patched[entry.byte_offset as usize..entry.byte_offset as usize + entry.byte_len as usize];
    let after = decode_scene_chunk(entry.scene_id, raw, false, None).expect("patched decode");
    let reparsed = produce_bridge(raw, &after);
    let text_for = |key: &str| {
        reparsed
            .bundle
            .units
            .iter()
            .find(|unit| unit.source_unit_key == key)
            .expect("surface remains readable")
            .source_text
            .as_str()
    };
    assert_eq!(text_for(&first_key), target);
    assert_eq!(text_for(&second_key), second);
}

#[test]
fn patchback_relocates_every_section_after_a_resized_string_table() {
    let first = "first literal";
    let second = "second literal";
    let target = "a substantially longer first literal";
    let decoded = decoded_strings_before_sections(first, second);
    let (archive, chunk) = archive_with_decoded(&decoded);
    let bridge = produce_bridge(&chunk, &decoded);
    let changed = translated_json(&bridge.json, Some(("0", target)));
    let bundle = TranslatedBundleV02::from_json(&changed).expect("changed bundle");

    let patched = apply_translated_bundle(&archive, &bundle, &PatchbackOpts::utf16le())
        .expect("patch a string before the bytecode section");
    let index = crate::archive::parse_scene_pck(&patched).expect("patched archive parses");
    let entry = &index.entries[0];
    let raw =
        &patched[entry.byte_offset as usize..entry.byte_offset as usize + entry.byte_len as usize];
    let after = decode_scene_chunk(entry.scene_id, raw, false, None).expect("patched decode");

    let delta =
        ((target.encode_utf16().count() + 1) - (first.encode_utf16().count() + 1)) as i32 * 2;
    for field in [1, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31] {
        assert_eq!(
            header_i32(&after, field),
            header_i32(&decoded, field) + delta,
            "section offset field {field} must move with the enlarged string table"
        );
    }
    assert_eq!(header_i32(&after, 3), header_i32(&decoded, 3));
    assert_eq!(header_i32(&after, 5), header_i32(&decoded, 5));
    assert_eq!(header_i32(&after, 2), header_i32(&decoded, 2));
    assert!(
        crate::partition_scene(&after)
            .expect("relocated bytecode partitions")
            .fully_partitioned,
        "the relocated bytecode must remain an exact instruction stream"
    );
}

fn produce_bridge(chunk: &[u8], decoded: &[u8]) -> crate::bridge::ProducedBundle {
    let opts = BridgeOpts {
        game_id: "synthetic-siglus",
        game_version: "test",
        source_profile_id: "synthetic-profile",
        source_locale: "ja-JP",
        extractor_name: "patchback-test",
        extractor_version: "test",
    };
    produce_bundle(
        0,
        chunk,
        decoded,
        &GameexeDatReport { entries: vec![] },
        &opts,
    )
    .expect("synthetic scene bridges")
}

fn translated_json(source: &serde_json::Value, changed: Option<(&str, &str)>) -> serde_json::Value {
    let mut value = source.clone();
    for unit in value["units"]
        .as_array_mut()
        .expect("bridge units")
        .iter_mut()
    {
        let string_index = unit["sourceLocation"]["entryPath"][3]
            .as_str()
            .expect("string index");
        let text = if changed.is_some_and(|(changed_index, _)| changed_index == string_index) {
            changed.expect("checked some").1
        } else {
            unit["sourceText"].as_str().expect("source text")
        };
        unit["target"] = json!({ "locale": "en-US", "text": text });
    }
    value
}

fn archive_with_one_scene(text: &str) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let decoded = decoded_scene(text);
    let (archive, chunk) = archive_with_decoded(&decoded);
    (archive, decoded, chunk)
}

fn archive_with_decoded(decoded: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let lzss = compress_siglus_lzss(decoded).expect("compress synthetic scene");
    let mut plaintext_chunk = Vec::with_capacity(lzss.len() + 8);
    plaintext_chunk.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
    plaintext_chunk.extend_from_slice(&(decoded.len() as u32).to_le_bytes());
    plaintext_chunk.extend_from_slice(&lzss);
    let chunk = apply_xor_table(&plaintext_chunk, None);

    let header_len = crate::archive::SCENE_PCK_HEADER_BYTE_LEN;
    let name_index = header_len;
    let name_list = name_index + 8;
    let data_index = name_list + 8;
    let data_list = data_index + 8;
    let mut archive = vec![0u8; data_list];
    put_u32(&mut archive, 0, header_len as u32);
    put_u32(&mut archive, 13, name_index as u32);
    put_u32(&mut archive, 14, 1);
    put_u32(&mut archive, 15, name_list as u32);
    put_u32(&mut archive, 16, 1);
    put_u32(&mut archive, 17, data_index as u32);
    put_u32(&mut archive, 18, 1);
    put_u32(&mut archive, 19, data_list as u32);
    put_u32(&mut archive, 20, 1);
    archive[name_index + 4..name_index + 8].copy_from_slice(&4u32.to_le_bytes());
    for (index, unit) in "0000".encode_utf16().enumerate() {
        archive[name_list + index * 2..name_list + index * 2 + 2]
            .copy_from_slice(&unit.to_le_bytes());
    }
    archive[data_index + 4..data_index + 8].copy_from_slice(&(chunk.len() as u32).to_le_bytes());
    archive.extend_from_slice(&chunk);
    (archive, chunk)
}

fn decoded_scene(text: &str) -> Vec<u8> {
    decoded_two_strings(text, "")
}

fn decoded_two_strings(first: &str, second: &str) -> Vec<u8> {
    let mut bytecode = vec![0x02];
    bytecode.extend_from_slice(&FM_STR.to_le_bytes());
    bytecode.extend_from_slice(&0i32.to_le_bytes());
    bytecode.push(0x31);
    bytecode.extend_from_slice(&0i32.to_le_bytes());
    bytecode.push(0x02);
    bytecode.extend_from_slice(&FM_STR.to_le_bytes());
    bytecode.extend_from_slice(&1i32.to_le_bytes());
    bytecode.push(0x31);
    bytecode.extend_from_slice(&0i32.to_le_bytes());
    bytecode.push(0x16);

    let header_len = crate::opcode::SCN_HEADER_BYTE_LEN;
    let index_list = header_len + bytecode.len();
    let string_list = index_list + 16;
    let mut payload = vec![0u8; header_len];
    put_i32(&mut payload, 0, crate::opcode::SCN_HEADER_DECLARED_SIZE);
    put_i32(&mut payload, 1, header_len as i32);
    put_i32(&mut payload, 2, bytecode.len() as i32);
    put_i32(&mut payload, 3, index_list as i32);
    put_i32(&mut payload, 4, 2);
    put_i32(&mut payload, 5, string_list as i32);
    put_i32(&mut payload, 6, 2);
    payload.extend_from_slice(&bytecode);
    let first_len = first.encode_utf16().count() + 1;
    let second_len = second.encode_utf16().count() + 1;
    payload.extend_from_slice(&0i32.to_le_bytes());
    payload.extend_from_slice(&(first_len as i32).to_le_bytes());
    payload.extend_from_slice(&(first_len as i32).to_le_bytes());
    payload.extend_from_slice(&(second_len as i32).to_le_bytes());
    for (index, text) in [first, second].into_iter().enumerate() {
        let key = 28_807u16.wrapping_mul(index as u16);
        for unit in text.encode_utf16().chain(std::iter::once(0)) {
            payload.extend_from_slice(&(unit ^ key).to_le_bytes());
        }
    }
    payload
}

/// A scene where the string data precedes every other payload section. This is
/// the layout that catches a length-changing splice which fails to rewrite the
/// header's absolute section offsets.
fn decoded_strings_before_sections(first: &str, second: &str) -> Vec<u8> {
    let mut bytecode = vec![0x02];
    bytecode.extend_from_slice(&FM_STR.to_le_bytes());
    bytecode.extend_from_slice(&0i32.to_le_bytes());
    bytecode.push(0x31);
    bytecode.extend_from_slice(&0i32.to_le_bytes());
    bytecode.push(0x02);
    bytecode.extend_from_slice(&FM_STR.to_le_bytes());
    bytecode.extend_from_slice(&1i32.to_le_bytes());
    bytecode.push(0x31);
    bytecode.extend_from_slice(&0i32.to_le_bytes());
    bytecode.push(0x16);

    let header_len = crate::opcode::SCN_HEADER_BYTE_LEN;
    let index_list = header_len;
    let string_list = index_list + 16;
    let mut payload = vec![0u8; header_len];
    payload.extend_from_slice(&0i32.to_le_bytes());
    payload.extend_from_slice(&((first.encode_utf16().count() + 1) as i32).to_le_bytes());
    payload.extend_from_slice(&((first.encode_utf16().count() + 1) as i32).to_le_bytes());
    payload.extend_from_slice(&((second.encode_utf16().count() + 1) as i32).to_le_bytes());
    for (index, text) in [first, second].into_iter().enumerate() {
        let key = 28_807u16.wrapping_mul(index as u16);
        for unit in text.encode_utf16().chain(std::iter::once(0)) {
            payload.extend_from_slice(&(unit ^ key).to_le_bytes());
        }
    }

    let mut offsets = [0i32; crate::opcode::SCN_HEADER_BYTE_LEN / 4];
    for field in [7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31] {
        offsets[field] = payload.len() as i32;
        payload.extend_from_slice(&0i32.to_le_bytes());
    }
    let scn_ofs = payload.len() as i32;
    payload.extend_from_slice(&bytecode);

    put_i32(&mut payload, 0, crate::opcode::SCN_HEADER_DECLARED_SIZE);
    put_i32(&mut payload, 1, scn_ofs);
    put_i32(&mut payload, 2, bytecode.len() as i32);
    put_i32(&mut payload, 3, index_list as i32);
    put_i32(&mut payload, 4, 2);
    put_i32(&mut payload, 5, string_list as i32);
    put_i32(&mut payload, 6, 2);
    for field in [7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31] {
        put_i32(&mut payload, field, offsets[field]);
    }
    put_i32(&mut payload, 8, 1);
    put_i32(&mut payload, 20, 1);
    payload
}

fn header_i32(bytes: &[u8], field: usize) -> i32 {
    let start = field * 4;
    i32::from_le_bytes(bytes[start..start + 4].try_into().expect("header field"))
}

fn put_u32(bytes: &mut [u8], field: usize, value: u32) {
    bytes[field * 4..field * 4 + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_i32(bytes: &mut [u8], field: usize, value: i32) {
    bytes[field * 4..field * 4 + 4].copy_from_slice(&value.to_le_bytes());
}
