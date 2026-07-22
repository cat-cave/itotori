use super::*;

// RealLive detector tests.
// Synthetic fixtures only; no rlvm code is read or linked. The
// `reallive_fixture_dir` helper writes top-level RealLive marker files
// into a fresh temp dir per test. Real-game evidence flows in at
// ALPHA-006.

pub(super) fn synthetic_seen_txt(scene_count: u32) -> Vec<u8> {
    // Concrete public-CI envelope shape: magic + LE count + 8-byte
    // synthetic table-of-contents entry per scene. Derived from
    // Haeleth's RLDEV public format documentation; no rlvm structure
    // is copied.
    let mut bytes = Vec::new();
    bytes.extend_from_slice(REALLIVE_SEEN_TXT_MAGIC);
    bytes.extend_from_slice(&scene_count.to_le_bytes());
    for index in 0..scene_count {
        bytes.extend_from_slice(&(index as u64).to_le_bytes());
    }
    bytes.extend_from_slice(b"synthetic-scene-payload");
    bytes
}

pub(super) fn synthetic_gameexe_ini() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(REALLIVE_GAMEEXE_INI_MAGIC);
    bytes.extend_from_slice(
        b"\n#GAMEEXE_VERSION=1.0\n#REGNAME=KaifuuFixture\\RealLive\n#G00BUF=8\n#KOEPAC=koe.ovk\n",
    );
    bytes
}

pub(super) fn reallive_fixture_dir(name: &str, files: &[(&str, &[u8])]) -> PathBuf {
    let dir = temp_dir(name);
    for (rel_path, bytes) in files {
        let path = dir.join(rel_path);
        fs::write(&path, bytes).unwrap();
    }
    dir
}

// RealLive Scene/SEEN bridge inventory + patch-back
// adapter tests.

pub(super) fn reallive_adapter_fixture_dir(name: &str) -> PathBuf {
    // Build a writable temp dir containing the bridge-inventory-001
    // SEEN.TXT / Gameexe.ini fixtures from the kaifuu-reallive crate.
    let src_dir =
        crate::test_manifest_dir().join("../kaifuu-reallive/tests/fixtures/bridge-inventory-001");
    let seen_bytes = fs::read(src_dir.join("SEEN.TXT")).unwrap();
    let gameexe_bytes = fs::read(src_dir.join("Gameexe.ini")).unwrap();
    let dir = temp_dir(name);
    fs::write(dir.join(REALLIVE_SEEN_TXT_PATH), &seen_bytes).unwrap();
    fs::write(dir.join(REALLIVE_GAMEEXE_INI_PATH), &gameexe_bytes).unwrap();
    dir
}

pub(super) const XOR2_TEST_KEY: [u8; 16] = [
    0x41, 0x52, 0x63, 0x74, 0x15, 0x26, 0x37, 0x48, 0x59, 0x6a, 0x7b, 0x8c, 0x9d, 0xae, 0xbf, 0xd0,
];

pub(super) fn stage_xor2_segment_for_test(bytecode: &mut [u8]) {
    for i in 0..257usize {
        let pos = 256 + i;
        let Some(slot) = bytecode.get_mut(pos) else {
            break;
        };
        *slot ^= XOR2_TEST_KEY[i % XOR2_TEST_KEY.len()];
    }
}

pub(super) fn xor2_scene_blob(plaintext: &[u8]) -> Vec<u8> {
    let mut stored = plaintext.to_vec();
    stage_xor2_segment_for_test(&mut stored);
    let compressed = kaifuu_reallive::compress_avg32_literal(&stored)
        .expect("xor2 synthetic bytecode compresses");
    let header_len = kaifuu_reallive::SCENE_HEADER_BYTE_LEN;
    let mut blob = vec![0u8; header_len];
    blob[0x00..0x04].copy_from_slice(&(header_len as u32).to_le_bytes());
    blob[0x04..0x08].copy_from_slice(&110002u32.to_le_bytes());
    blob[0x08..0x0c].copy_from_slice(&(header_len as u32).to_le_bytes());
    blob[0x0c..0x10].copy_from_slice(&0u32.to_le_bytes());
    blob[0x20..0x24].copy_from_slice(&(header_len as u32).to_le_bytes());
    blob[0x24..0x28].copy_from_slice(&(stored.len() as u32).to_le_bytes());
    blob[0x28..0x2c].copy_from_slice(&(compressed.len() as u32).to_le_bytes());
    blob.extend_from_slice(&compressed);
    blob
}

pub(super) fn xor2_adapter_seen_txt() -> Vec<u8> {
    xor2_adapter_seen_txt_with_scene_len(540)
}

pub(super) fn xor2_adapter_seen_txt_with_scene_len(scene_bytecode_len: usize) -> Vec<u8> {
    let dir_len = kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let mut directory = vec![0u8; dir_len];
    let mut payload = Vec::new();
    for scene_id in 1..=6u16 {
        let mut plaintext = vec![0u8; scene_bytecode_len];
        if scene_id == 1 && plaintext.len() >= 261 {
            plaintext[256..261].copy_from_slice(b"Hello");
        }
        let blob = xor2_scene_blob(&plaintext);
        let file_offset = dir_len + payload.len();
        let slot = scene_id as usize * 8;
        directory[slot..slot + 4].copy_from_slice(&(file_offset as u32).to_le_bytes());
        directory[slot + 4..slot + 8].copy_from_slice(&(blob.len() as u32).to_le_bytes());
        payload.extend_from_slice(&blob);
    }
    directory.extend_from_slice(&payload);
    directory
}

pub(super) fn reallive_xor2_fixture_dir(name: &str) -> PathBuf {
    let dir = temp_dir(name);
    fs::write(dir.join(REALLIVE_SEEN_TXT_PATH), xor2_adapter_seen_txt()).unwrap();
    fs::write(dir.join(REALLIVE_GAMEEXE_INI_PATH), synthetic_gameexe_ini()).unwrap();
    dir
}

// Build a PatchExport that translates EVERY extracted unit (the
// adapter's "no silent partial" rule requires a target per unit in a
// touched scene). `override_dialogue` replaces the "Hello" dialogue
// unit's target; every other unit is carried through identity (source
// text as its own target, which is length-preserving by construction).
pub(super) fn reallive_all_units_export(
    extract: &ExtractionResult,
    override_dialogue: &str,
) -> PatchExport {
    let entries = extract
        .bridge
        .units
        .iter()
        .map(|unit| kaifuu_core::PatchExportEntry {
            bridge_unit_id: unit.bridge_unit_id.clone(),
            source_unit_key: unit.source_unit_key.clone(),
            source_hash: unit.source_hash.clone(),
            target_text: if unit.text_surface == "dialogue" {
                override_dialogue.to_string()
            } else {
                unit.source_text.clone()
            },
            protected_span_mappings: vec![],
        })
        .collect();
    PatchExport {
        patch_export_id: "kaifuu-reallive-all-units".to_string(),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries,
    }
}

// Decompress the AVG32-compressed bytecode of scene 1 from a patched
// SEEN.TXT so a translated sentinel can be asserted on the plaintext
// bytecode (the on-disk archive stores the bytecode compressed, so a raw
// byte search would split the sentinel across LZSS flag bytes).
pub(super) fn reallive_decompressed_scene_1(archive_bytes: &[u8]) -> Vec<u8> {
    let index = kaifuu_reallive::parse_archive(archive_bytes).expect("patched archive parses");
    let entry = index
        .entries
        .iter()
        .find(|e| e.scene_id == 1)
        .expect("scene 1 present");
    let blob = &archive_bytes
        [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
    let header = kaifuu_reallive::SceneHeader::parse(blob).expect("patched scene header parses");
    let start = header.bytecode_offset as usize;
    let end = start + header.bytecode_compressed_size as usize;
    kaifuu_reallive::decompress_avg32(
        &blob[start..end],
        header.bytecode_uncompressed_size as usize,
    )
    .expect("patched bytecode decompresses")
}
