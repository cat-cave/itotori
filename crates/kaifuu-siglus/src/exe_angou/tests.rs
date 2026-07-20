//! Unit tests for exe-angou key recovery (synthetic PE fixtures — no retail bytes).

use super::*;

const SECRET_REF: &str = "secret://siglus/exe-angou-test";

/// Lowercase-hex of `bytes` (fold, not `format!`-collect, per clippy).
fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut acc, byte| {
        let _ = write!(acc, "{byte:02x}");
        acc
    })
}

// A tiny synthetic PE32 that carries the gather cluster: a `.text` section
// with sixteen `A0 <moffs32>` / `88 45 <disp8>` pairs and a `.data` section
// holding the sixteen source bytes. Clearly-fake fixture, not retail bytes.
fn build_synthetic_pe(source_key: &[u8; 16]) -> Vec<u8> {
    const IMAGE_BASE: u32 = 0x0040_0000;
    const TEXT_VA: u32 = 0x1000;
    const DATA_VA: u32 = 0x2000;
    const TEXT_RAW: u32 = 0x400;
    const DATA_RAW: u32 = 0x600;

    // `.text`: sixteen pairs, key slots ebp-0x20 .. ebp-0x11 in order.
    let mut text = Vec::new();
    for (index, _) in source_key.iter().enumerate() {
        let src_va = IMAGE_BASE + DATA_VA + index as u32;
        text.push(OPCODE_MOV_AL_MOFFS32);
        text.extend_from_slice(&src_va.to_le_bytes());
        text.push(OPCODE_MOV_EBP_DISP8_AL[0]);
        text.push(OPCODE_MOV_EBP_DISP8_AL[1]);
        text.push(KEY_SLOT_DISP8_LOW + index as u8);
    }

    let mut pe = vec![0u8; DATA_RAW as usize + source_key.len()];
    pe[0] = b'M';
    pe[1] = b'Z';
    let e_lfanew: u32 = 0x80;
    pe[0x3c..0x40].copy_from_slice(&e_lfanew.to_le_bytes());
    pe[e_lfanew as usize..e_lfanew as usize + 4].copy_from_slice(b"PE\0\0");
    let coff = e_lfanew as usize + 4;
    // machine (i386), num sections = 2.
    pe[coff + 2..coff + 4].copy_from_slice(&2u16.to_le_bytes());
    let size_optional: u16 = 0xE0;
    pe[coff + 16..coff + 18].copy_from_slice(&size_optional.to_le_bytes());
    let optional = coff + 20;
    pe[optional..optional + 2].copy_from_slice(&0x010bu16.to_le_bytes());
    pe[optional + 28..optional + 32].copy_from_slice(&IMAGE_BASE.to_le_bytes());

    let table = optional + size_optional as usize;
    let write_section =
        |pe: &mut Vec<u8>, slot: usize, name: &[u8], vsize: u32, va: u32, rsize: u32, rptr: u32| {
            let base = table + slot * 40;
            pe[base..base + name.len()].copy_from_slice(name);
            pe[base + 8..base + 12].copy_from_slice(&vsize.to_le_bytes());
            pe[base + 12..base + 16].copy_from_slice(&va.to_le_bytes());
            pe[base + 16..base + 20].copy_from_slice(&rsize.to_le_bytes());
            pe[base + 20..base + 24].copy_from_slice(&rptr.to_le_bytes());
        };
    let text_len = text.len() as u32;
    let data_len = source_key.len() as u32;
    write_section(&mut pe, 0, b".text", text_len, TEXT_VA, text_len, TEXT_RAW);
    write_section(&mut pe, 1, b".data", data_len, DATA_VA, data_len, DATA_RAW);

    pe[TEXT_RAW as usize..TEXT_RAW as usize + text.len()].copy_from_slice(&text);
    pe[DATA_RAW as usize..DATA_RAW as usize + source_key.len()].copy_from_slice(source_key);
    pe
}

fn key_ref() -> SiglusSecondLayerKey {
    SiglusSecondLayerKey::from_secret_ref(SECRET_REF)
}

#[test]
fn recovers_scattered_key_from_synthetic_pe() {
    let source = *b"ABCDEFGHIJKLMNOP";
    let pe = build_synthetic_pe(&source);
    let recovery = recover_exe_angou_key(&pe, &key_ref()).expect("synthetic PE yields a key");
    let report = recovery.report();
    assert_eq!(report.key_byte_len, EXE_ANGOU_KEY_BYTE_LEN as u32);
    assert_eq!(report.secret_ref, SECRET_REF);
    assert_eq!(report.material_sha256, hex_sha256(&source));
    assert_eq!(report.gather_site_count, EXE_ANGOU_KEY_BYTE_LEN as u32);
    // Material round-trips against a known XOR of the source key.
    assert_eq!(
        recovery.material().material_sha256_prefix(),
        SiglusSecondLayerMaterial::resolve(&key_ref(), source.to_vec())
            .unwrap()
            .material_sha256_prefix()
    );
}

#[test]
fn report_carries_no_raw_key_bytes() {
    let source = *b"ZYXWVUTSRQPONMLK";
    let pe = build_synthetic_pe(&source);
    let recovery = recover_exe_angou_key(&pe, &key_ref()).expect("recovers");
    let json = serde_json::to_string(recovery.report()).expect("report serializes");
    // Neither the raw bytes (as text) nor their hex may appear.
    assert!(!json.contains(&String::from_utf8_lossy(&source).into_owned()));
    // Raw key as lowercase hex (built without `format!`-collect per clippy).
    let raw_hex = hex_lower(&source);
    assert!(!json.contains(&raw_hex), "raw key hex leaked into report");
    // Only the one-way commitment is present.
    assert!(json.contains(&hex_sha256(&source)));
    // Debug of the recovery is redacted (material Debug hides bytes).
    let debug = format!("{recovery:?}");
    assert!(debug.contains("REDACTED"));
    assert!(!debug.contains(&raw_hex));
}

#[test]
fn non_pe_input_is_typed_not_panic() {
    let err = recover_exe_angou_key(b"not a pe at all", &key_ref()).expect_err("not pe");
    assert!(matches!(
        err,
        ExeAngouKeyError::NotPortableExecutable { .. }
    ));
    assert!(
        err.to_string()
            .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
    );
}

#[test]
fn missing_gather_cluster_is_typed_incomplete() {
    // A valid PE whose `.text` has no gather pairs.
    let mut pe = build_synthetic_pe(b"0123456789ABCDEF");
    // Blank the text section so no A0/88-45 pairs remain.
    for byte in pe.iter_mut().skip(0x400).take(0x80) {
        *byte = 0x90; // nop
    }
    let err = recover_exe_angou_key(&pe, &key_ref()).expect_err("no cluster");
    assert!(matches!(
        err,
        ExeAngouKeyError::KeyClusterIncomplete { recovered: 0 }
    ));
}

#[test]
fn unsupported_pe64_magic_is_typed() {
    let mut pe = build_synthetic_pe(b"FEDCBA9876543210");
    // Flip optional-header magic to PE32+ (0x020b).
    let e_lfanew = read_u32(&pe, 0x3c).unwrap() as usize;
    let optional = e_lfanew + 4 + 20;
    pe[optional..optional + 2].copy_from_slice(&0x020bu16.to_le_bytes());
    let err = recover_exe_angou_key(&pe, &key_ref()).expect_err("pe32+ unsupported");
    assert!(matches!(err, ExeAngouKeyError::UnsupportedPeFormat { .. }));
}
