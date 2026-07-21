use kaifuu_core::BridgeBundleV02;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::*;
use crate::{
    FM_INT, FM_STR, GLOBAL_SELBTN_SYSTEM_FUNCTION_ID, GameexeDatEntry, GameexeDatReport,
    GameexeInventory,
};

fn opts() -> BridgeOpts<'static> {
    BridgeOpts {
        game_id: "siglus-test-game",
        game_version: "test",
        source_profile_id: "siglus-test-profile",
        source_locale: "ja-JP",
        extractor_name: "kaifuu-siglus-bridge",
        extractor_version: "test",
    }
}

fn put_i32(bytes: &mut Vec<u8>, value: i32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_str(bytes: &mut Vec<u8>, index: i32) {
    bytes.push(0x02);
    put_i32(bytes, FM_STR);
    put_i32(bytes, index);
}

fn push_int(bytes: &mut Vec<u8>, value: i32) {
    bytes.push(0x02);
    put_i32(bytes, FM_INT);
    put_i32(bytes, value);
}

fn selbtn_target(bytes: &mut Vec<u8>) {
    bytes.push(0x08);
    push_int(bytes, GLOBAL_SELBTN_SYSTEM_FUNCTION_ID);
}

fn command(bytes: &mut Vec<u8>, forms: &[i32], ret_form: i32) {
    bytes.push(0x30);
    put_i32(bytes, 0);
    put_i32(bytes, forms.len() as i32);
    for form in forms {
        put_i32(bytes, *form);
    }
    put_i32(bytes, 0);
    put_i32(bytes, ret_form);
    put_i32(bytes, 0);
}

fn xor_encode_fixture_units(index: usize, units: impl IntoIterator<Item = u16>) -> Vec<u8> {
    let key = 28807u16.wrapping_mul(index as u16);
    units
        .into_iter()
        .flat_map(|unit| (unit ^ key).to_le_bytes())
        .collect()
}

fn scene_payload(bytecode: &[u8], labels: &[i32], strings: &[&str]) -> Vec<u8> {
    let encoded_strings: Vec<_> = strings
        .iter()
        .enumerate()
        .map(|(index, text)| xor_encode_fixture_units(index, text.encode_utf16()))
        .collect();
    scene_payload_with_encoded_strings(bytecode, labels, &encoded_strings)
}

fn scene_payload_with_encoded_strings(
    bytecode: &[u8],
    labels: &[i32],
    encoded_strings: &[Vec<u8>],
) -> Vec<u8> {
    let mut string_data = Vec::new();
    let mut index = Vec::new();
    let mut char_offset = 0_i32;
    for bytes in encoded_strings {
        assert_eq!(
            bytes.len() % 2,
            0,
            "synthetic string bytes are UTF-16-sized"
        );
        let char_len = i32::try_from(bytes.len() / 2).expect("synthetic string length fits i32");
        index.push((char_offset, char_len));
        char_offset += char_len;
        string_data.extend_from_slice(bytes);
    }
    let header = crate::SCN_HEADER_BYTE_LEN as i32;
    let label_offset = header + bytecode.len() as i32;
    let index_offset = label_offset + labels.len() as i32 * 4;
    let string_offset = index_offset + index.len() as i32 * 8;
    let mut out = Vec::new();
    put_i32(&mut out, crate::SCN_HEADER_DECLARED_SIZE);
    put_i32(&mut out, header);
    put_i32(&mut out, bytecode.len() as i32);
    put_i32(&mut out, index_offset);
    put_i32(&mut out, index.len() as i32);
    put_i32(&mut out, string_offset);
    put_i32(&mut out, index.len() as i32);
    put_i32(&mut out, label_offset);
    put_i32(&mut out, labels.len() as i32);
    for _ in 9..33 {
        put_i32(&mut out, 0);
    }
    out.extend_from_slice(bytecode);
    for label in labels {
        put_i32(&mut out, *label);
    }
    for (offset, len) in index {
        put_i32(&mut out, offset);
        put_i32(&mut out, len);
    }
    out.extend_from_slice(&string_data);
    out
}

#[test]
fn assembly_skips_uncategorized_selbtn_string_entries() {
    let mut bytecode = Vec::new();
    push_str(&mut bytecode, 0);
    bytecode.push(0x31); // AddText
    put_i32(&mut bytecode, 4);
    selbtn_target(&mut bytecode);
    push_str(&mut bytecode, 1); // control string, not a linked choice label
    command(&mut bytecode, &[FM_STR], FM_INT);
    bytecode.push(0x16);

    let dialogue = xor_encode_fixture_units(0, "Visible dialogue".encode_utf16());
    // A lone high surrogate is not valid UTF-16.  It is intentionally placed
    // in the table as an unlinked SELBTN argument to prove assembly does not
    // decode every string entry.
    let scene = scene_payload_with_encoded_strings(
        &bytecode,
        &[],
        &[dialogue, xor_encode_fixture_units(1, [0xD800])],
    );

    let bundle = produce_bundle(26, b"packed-scene", &scene, &report(), &opts())
        .expect("uncategorized control bytes must not be decoded as text");
    let units = bundle.json["units"].as_array().expect("units array");
    assert_eq!(
        units
            .iter()
            .filter(|unit| unit["surfaceKind"] == "dialogue")
            .count(),
        1
    );
    assert!(
        units
            .iter()
            .all(|unit| unit["surfaceKind"] != "choice_label"),
        "an unlinked SELBTN argument is not a choice surface"
    );
}

#[test]
fn assembly_decodes_invalid_utf16le_for_a_linked_choice_label_lossily() {
    let mut bytecode = Vec::new();
    selbtn_target(&mut bytecode);
    push_str(&mut bytecode, 0);
    push_str(&mut bytecode, 1);
    command(&mut bytecode, &[FM_STR, FM_STR], FM_INT);
    push_int(&mut bytecode, 1);
    bytecode.push(0x11); // GOTO_TRUE label 0
    put_i32(&mut bytecode, 0);
    push_int(&mut bytecode, 2);
    bytecode.push(0x11); // GOTO_TRUE label 1
    put_i32(&mut bytecode, 1);
    let first_target = bytecode.len() as i32;
    bytecode.push(0x16);
    let second_target = bytecode.len() as i32;
    bytecode.push(0x16);
    let scene = scene_payload_with_encoded_strings(
        &bytecode,
        &[first_target, second_target],
        &[
            xor_encode_fixture_units(0, [0xD800]),
            xor_encode_fixture_units(1, "OK".encode_utf16()),
        ],
    );

    let bundle = produce_bundle(26, b"packed-scene", &scene, &report(), &opts())
        .expect("linked choice labels should decode lossily");
    let labels: Vec<_> = bundle.json["units"]
        .as_array()
        .expect("units array")
        .iter()
        .filter(|unit| unit["surfaceKind"] == "choice_label")
        .map(|unit| unit["sourceText"].as_str().expect("choice source text"))
        .collect();
    assert_eq!(labels, ["\u{FFFD}", "OK"]);
}

fn sample_scene() -> (Vec<u8>, usize, usize) {
    let mut bytecode = Vec::new();
    push_str(&mut bytecode, 0);
    bytecode.push(0x32); // SetName
    push_str(&mut bytecode, 1);
    let text_offset = bytecode.len();
    bytecode.push(0x31); // AddText
    put_i32(&mut bytecode, 4);
    selbtn_target(&mut bytecode);
    push_str(&mut bytecode, 2);
    push_str(&mut bytecode, 3);
    let select_offset = bytecode.len();
    command(&mut bytecode, &[FM_STR, FM_STR], FM_INT);
    push_int(&mut bytecode, 1);
    bytecode.push(0x11);
    put_i32(&mut bytecode, 0);
    push_int(&mut bytecode, 2);
    bytecode.push(0x11);
    put_i32(&mut bytecode, 1);
    let first_target = bytecode.len() as i32;
    bytecode.push(0x16);
    let second_target = bytecode.len() as i32;
    bytecode.push(0x16);
    (
        scene_payload(
            &bytecode,
            &[first_target, second_target],
            &["Narrator", "Hello\\c[2]\\n", "First", "Second"],
        ),
        text_offset,
        select_offset,
    )
}

fn report() -> GameexeDatReport {
    GameexeDatReport {
        entries: vec![GameexeDatEntry {
            key: "NAMAE.001".to_string(),
            value: "\"Narrator\", 1".to_string(),
        }],
    }
}

fn unit<'a>(json: &'a Value, kind: &str) -> &'a Value {
    json["units"]
        .as_array()
        .and_then(|units| units.iter().find(|unit| unit["surfaceKind"] == kind))
        .expect("unit kind exists")
}

#[test]
fn assembly_is_schema_valid_deterministic_and_links_selection_labels() {
    let (scene, text_offset, select_offset) = sample_scene();
    let first = produce_bundle(7, b"packed-scene", &scene, &report(), &opts())
        .expect("synthetic bridge should assemble");
    let second = produce_bundle(7, b"packed-scene", &scene, &report(), &opts())
        .expect("repeated synthetic bridge should assemble");
    assert_eq!(first.json, second.json);
    assert!(BridgeBundleV02::validate_json(&first.json).is_ok());

    let units = first.json["units"].as_array().expect("units array");
    assert_eq!(
        units
            .iter()
            .filter(|unit| unit["surfaceKind"] == "dialogue")
            .count(),
        1
    );
    assert_eq!(
        units
            .iter()
            .filter(|unit| unit["surfaceKind"] == "speaker_name")
            .count(),
        1
    );
    assert_eq!(
        units
            .iter()
            .filter(|unit| unit["surfaceKind"] == "choice_label")
            .count(),
        2
    );

    let dialogue = unit(&first.json, "dialogue");
    assert_eq!(
        dialogue["sourceUnitKey"],
        format!("siglus:scene-0007#{text_offset}")
    );
    assert_eq!(dialogue["speaker"]["knowledgeState"], "known");
    assert_eq!(dialogue["speaker"]["canonicalNameRef"], "NAMAE.001");
    let mut source_hash = Sha256::new();
    source_hash.update(dialogue["sourceText"].as_str().expect("source text"));
    assert_eq!(
        dialogue["sourceHash"],
        format!("sha256:{:x}", source_hash.finalize())
    );
    let raw_spans: Vec<_> = dialogue["spans"]
        .as_array()
        .expect("spans array")
        .iter()
        .filter_map(|span| span["raw"].as_str())
        .collect();
    assert_eq!(raw_spans, ["\\c[2]", "\\n"]);

    for choice in units
        .iter()
        .filter(|unit| unit["surfaceKind"] == "choice_label")
    {
        assert_eq!(
            choice["context"]["choice"]["selectSyscallSite"]["systemFunctionId"],
            76
        );
        assert_eq!(
            choice["context"]["choice"]["selectSyscallSite"]["byteOffset"],
            select_offset
        );
        assert_eq!(
            choice["context"]["choice"]["routeTargetRef"],
            format!("siglus:scene-0007#{select_offset}")
        );
    }
}

#[test]
fn whole_pack_preserves_packed_scene_names_in_unit_keys() {
    let (scene, _, _) = sample_scene();
    let inventory = GameexeInventory::from_report(report());
    let input = BridgeSceneInput {
        scene_id: 7,
        scene_name: Some("opening"),
        scene_bytes: b"packed-scene",
        decoded_scene: &scene,
    };
    let bundle = produce_scene_pack_bundle(b"Scene.pck", &[input], &inventory, &opts())
        .expect("whole pack bridge should assemble");
    assert_eq!(bundle.bundle.assets.len(), 1);
    assert!(
        bundle
            .bundle
            .units
            .iter()
            .all(|unit| unit.source_unit_key.starts_with("siglus:scene-opening#"))
    );
}
