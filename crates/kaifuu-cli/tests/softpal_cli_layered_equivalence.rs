//! Deterministic CLI proof that PAC-contained and loose Softpal sources yield
//! the same bridge units. The source pair is deliberately small but fully
//! valid: a plaintext TEXT.DAT record and its Sv20 TEXT-SHOW command.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use kaifuu_softpal::{
    PAC_COUNT_OFFSET, PAC_ENTRY_NAME_BYTE_LEN, PAC_HEADER_BYTE_LEN, PAC_INDEX_ENTRY_BYTE_LEN,
    PAC_MAGIC, TEXT_SHOW_WORD_HI, TEXTDAT_FLAG_PLAINTEXT, TEXTDAT_MAGIC_TAIL,
};
use serde_json::Value;

fn kaifuu_cli_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"))
}

fn operator(id: u16) -> [u8; 4] {
    let mut token = [0_u8; 4];
    token[..2].copy_from_slice(&id.to_le_bytes());
    token[2..].copy_from_slice(&1_u16.to_le_bytes());
    token
}

fn word(value: u32) -> [u8; 4] {
    value.to_le_bytes()
}

fn call_target(category: u16, function: u16) -> u32 {
    (u32::from(category) << 16) | u32::from(function)
}

fn textdat() -> (Vec<u8>, u32) {
    let mut bytes = vec![TEXTDAT_FLAG_PLAINTEXT];
    bytes.extend_from_slice(TEXTDAT_MAGIC_TAIL);
    bytes.extend_from_slice(&1_u32.to_le_bytes());
    let pointer = u32::try_from(bytes.len()).expect("synthetic pointer fits u32");
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(b"synthetic dialogue\0");
    (bytes, pointer)
}

fn script(text_pointer: u32) -> Vec<u8> {
    let mut bytes = Vec::from(&b"Sv20\0\0\0\0\0\0\0\0"[..]);
    for token in [
        operator(0x1f),
        word(text_pointer),
        operator(0x1f),
        word(0x0fff_ffff),
        operator(0x1f),
        word(0),
        operator(0x17),
        word(call_target(TEXT_SHOW_WORD_HI, 0x0002)),
        word(0),
    ] {
        bytes.extend_from_slice(&token);
    }
    bytes
}

fn pac(files: &[(&str, &[u8])]) -> Vec<u8> {
    let index_end = PAC_HEADER_BYTE_LEN + files.len() * PAC_INDEX_ENTRY_BYTE_LEN;
    let total_size = index_end + files.iter().map(|(_, bytes)| bytes.len()).sum::<usize>();
    let mut bytes = vec![0_u8; total_size];
    bytes[..PAC_MAGIC.len()].copy_from_slice(PAC_MAGIC);
    bytes[PAC_COUNT_OFFSET..PAC_COUNT_OFFSET + 4]
        .copy_from_slice(&(files.len() as u32).to_le_bytes());

    let mut payload_offset = index_end;
    for (index, (name, payload)) in files.iter().enumerate() {
        let entry_offset = PAC_HEADER_BYTE_LEN + index * PAC_INDEX_ENTRY_BYTE_LEN;
        let name_bytes = name.as_bytes();
        assert!(name_bytes.len() < PAC_ENTRY_NAME_BYTE_LEN);
        bytes[entry_offset..entry_offset + name_bytes.len()].copy_from_slice(name_bytes);
        bytes[entry_offset + PAC_ENTRY_NAME_BYTE_LEN..entry_offset + PAC_ENTRY_NAME_BYTE_LEN + 4]
            .copy_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes[entry_offset + PAC_ENTRY_NAME_BYTE_LEN + 4
            ..entry_offset + PAC_ENTRY_NAME_BYTE_LEN + 8]
            .copy_from_slice(&(payload_offset as u32).to_le_bytes());
        bytes[payload_offset..payload_offset + payload.len()].copy_from_slice(payload);
        payload_offset += payload.len();
    }
    bytes
}

fn extract_bundle(game_dir: &Path, bundle_path: &Path) -> Value {
    let output = Command::new(kaifuu_cli_binary())
        .args(["extract", "--engine", "softpal"])
        .arg(game_dir)
        .args(["--bundle-output"])
        .arg(bundle_path)
        .output()
        .expect("kaifuu-cli must run");
    assert!(
        output.status.success(),
        "softpal extraction must succeed: status={:?}\nstderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );
    serde_json::from_slice(&fs::read(bundle_path).expect("bridge output exists"))
        .expect("bridge output is JSON")
}

#[test]
fn cli_extracts_identical_units_from_pac_and_loose_source_pairs() {
    let temp = tempfile::tempdir().expect("tempdir");
    let pac_root = temp.path().join("pac");
    let loose_root = temp.path().join("loose");
    fs::create_dir_all(&pac_root).expect("PAC root");
    fs::create_dir_all(&loose_root).expect("loose root");

    let (textdat, pointer) = textdat();
    let script = script(pointer);
    fs::write(
        pac_root.join("data.pac"),
        pac(&[("SCRIPT.SRC", &script), ("TEXT.DAT", &textdat)]),
    )
    .expect("write PAC source");
    fs::write(loose_root.join("SCRIPT.SRC"), &script).expect("write loose script");
    fs::write(loose_root.join("TEXT.DAT"), &textdat).expect("write loose text pool");

    let pac_bundle = extract_bundle(&pac_root, &temp.path().join("pac.bridge.json"));
    let loose_bundle = extract_bundle(&loose_root, &temp.path().join("loose.bridge.json"));
    let pac_units = pac_bundle["units"].as_array().expect("PAC units array");
    let loose_units = loose_bundle["units"].as_array().expect("loose units array");

    assert_eq!(
        pac_units.len(),
        1,
        "the valid source emits its dialogue unit"
    );
    assert_eq!(
        pac_units, loose_units,
        "PAC and loose pairs produce equal bridge units"
    );
    assert_eq!(pac_units[0]["sourceText"], "synthetic dialogue");
}
