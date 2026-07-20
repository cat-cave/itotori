//! No-leak contract for the `Scene.pck` decode report.
//!
//! The sanitized report must persist only counts, a size histogram, per-scene
//! names + sha256 prefixes, and the key's secret-ref + one-way commitment.
//! Raw decompressed scene bytes and raw second-layer key bytes must never
//! appear. This mirrors the known-key smoke's no-raw-key posture and needs no
//! retail bytes: it decodes a clearly-synthetic one-scene archive built from a
//! distinctive fake key and a distinctive fake bytecode, then asserts neither
//! appears in the serialized report.

use kaifuu_siglus::{
    SCENE_PCK_HEADER_BYTE_LEN, SiglusSecondLayerKey, SiglusSecondLayerMaterial, apply_xor_table,
    decode_scene_pack,
};

/// Distinctive fake key + bytecode so a leak would be unmistakable in the JSON.
const FAKE_KEY: [u8; 16] = [
    0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF,
];
const FAKE_BYTECODE: &[u8] = &[
    0xCA, 0xFE, 0xF0, 0x0D, 0xCA, 0xFE, 0xF0, 0x0D, 0xCA, 0xFE, 0xF0, 0x0D, 0x11, 0x22, 0x33,
];

fn masked_chunk(bytecode: &[u8], key: &SiglusSecondLayerMaterial) -> Vec<u8> {
    // All-literal LZSS stream: one flag byte per (up to) 8 literals.
    let mut stream = Vec::new();
    for group in bytecode.chunks(8) {
        let flag = if group.len() == 8 {
            0xFFu8
        } else {
            ((1u16 << group.len()) - 1) as u8
        };
        stream.push(flag);
        stream.extend_from_slice(group);
    }
    let mut plain = Vec::new();
    plain.extend_from_slice(&0u32.to_le_bytes()); // compressed_size (patched below)
    plain.extend_from_slice(&(bytecode.len() as u32).to_le_bytes());
    plain.extend_from_slice(&stream);
    let chunk_len = plain.len() as u32;
    plain[0..4].copy_from_slice(&chunk_len.to_le_bytes());
    apply_xor_table(&plain, Some(key))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut acc, byte| {
        let _ = write!(acc, "{byte:02x}");
        acc
    })
}

fn put(bytes: &mut [u8], field: usize, value: u32) {
    bytes[field * 4..field * 4 + 4].copy_from_slice(&value.to_le_bytes());
}

fn synthetic_archive(chunk: &[u8]) -> Vec<u8> {
    // header | name-index pair | "seen" | data-index pair | payload
    let name_index_ofs = SCENE_PCK_HEADER_BYTE_LEN;
    let name_list_ofs = name_index_ofs + 8;
    let data_index_ofs = name_list_ofs + 8; // "seen" = 4 UTF-16LE units = 8 bytes
    let data_list_ofs = data_index_ofs + 8;
    let mut bytes = vec![0u8; data_list_ofs + chunk.len()];
    put(&mut bytes, 0, SCENE_PCK_HEADER_BYTE_LEN as u32);
    put(&mut bytes, 13, name_index_ofs as u32); // scn_name_index_list_ofs
    put(&mut bytes, 14, 1); // scn_name_index_cnt
    put(&mut bytes, 15, name_list_ofs as u32); // scn_name_list_ofs
    put(&mut bytes, 16, 1); // scn_name_cnt
    put(&mut bytes, 17, data_index_ofs as u32); // scn_data_index_list_ofs
    put(&mut bytes, 18, 1); // scn_data_index_cnt
    put(&mut bytes, 19, data_list_ofs as u32); // scn_data_list_ofs
    put(&mut bytes, 20, 1); // scn_data_cnt
    put(&mut bytes, 21, 1); // extra_key_use
    // name-index pair (char_offset=0, char_count=4)
    bytes[name_index_ofs + 4..name_index_ofs + 8].copy_from_slice(&4u32.to_le_bytes());
    // "seen" UTF-16LE
    for (i, ch) in b"seen".iter().enumerate() {
        bytes[name_list_ofs + i * 2] = *ch;
    }
    // data-index pair (data_offset=0, data_len=chunk.len())
    bytes[data_index_ofs + 4..data_index_ofs + 8]
        .copy_from_slice(&(chunk.len() as u32).to_le_bytes());
    bytes[data_list_ofs..].copy_from_slice(chunk);
    bytes
}

#[test]
fn report_carries_no_raw_key_or_scene_bytes() {
    let key_ref = SiglusSecondLayerKey::from_secret_ref("secret://test/no-leak-scene-key");
    let material = SiglusSecondLayerMaterial::resolve(&key_ref, FAKE_KEY.to_vec()).unwrap();
    let chunk = masked_chunk(FAKE_BYTECODE, &material);
    let archive = synthetic_archive(&chunk);

    let report = decode_scene_pack(&archive, Some(&material)).expect("synthetic decode");
    assert!(report.fully_decoded());
    assert_eq!(report.decoded_count, 1);
    assert_eq!(report.scene_digests.len(), 1);
    let digest = &report.scene_digests[0];
    assert_eq!(digest.scene_name.as_deref(), Some("seen"));
    assert_eq!(digest.decompressed_len, FAKE_BYTECODE.len());
    assert_eq!(
        report.second_layer_secret_ref.as_deref(),
        Some("secret://test/no-leak-scene-key")
    );
    assert!(report.second_layer_key_sha256_prefix.is_some());

    let json = serde_json::to_string(&report).expect("report serializes");

    // The sha256 prefix (a one-way commitment) IS present...
    assert!(json.contains(&digest.sha256_prefix));
    // ...but neither the raw key bytes nor the raw scene bytecode leak.
    let key_hex = hex(&FAKE_KEY);
    let bytecode_hex = hex(FAKE_BYTECODE);
    assert!(
        !json.contains("deadbeef"),
        "raw key bytes leaked into the report"
    );
    assert!(
        !json.contains(&key_hex),
        "raw key bytes leaked into the report"
    );
    assert!(
        !json.contains("cafef00d"),
        "raw scene bytecode leaked into the report"
    );
    assert!(
        !json.contains(&bytecode_hex),
        "raw scene bytecode leaked into the report"
    );

    // Debug of the resolved material also redacts the bytes.
    let debug = format!("{material:?}");
    assert!(debug.contains("REDACTED"));
    assert!(!debug.contains("deadbeef"));
}
