//! Public binary integration proof for the common extraction envelope.
//!
//! Each source is a deliberately small, neutral, format-valid synthetic tree.
//! The test invokes the compiled CLI, rather than a Rust handler, so it proves
//! the generic `extract --engine --game-root ... --scope --bundle-output`
//! boundary reaches three independently implemented decoders.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use kaifuu_reallive::{
    REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, SCENE_HEADER_BYTE_LEN, compress_avg32_literal,
};
use kaifuu_siglus::{
    FM_STR, SCENE_PCK_HEADER_BYTE_LEN, SCN_HEADER_BYTE_LEN, SCN_HEADER_DECLARED_SIZE,
    apply_gameexe_xor_table, apply_xor_table, compress_siglus_lzss,
};
use kaifuu_softpal::{TEXT_SHOW_WORD_HI, TEXTDAT_FLAG_PLAINTEXT, TEXTDAT_MAGIC_TAIL};
use serde_json::Value;

fn kaifuu_cli_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"))
}

#[test]
fn generic_extract_envelope_succeeds_for_three_synthetic_engine_sources() {
    let temp = tempfile::tempdir().expect("temporary fixture directory");
    let cases = [
        ("reallive", write_reallive_source(temp.path())),
        ("siglus", write_siglus_source(temp.path())),
        ("softpal", write_softpal_source(temp.path())),
    ];

    for (engine, game_root) in cases {
        let output_path = temp.path().join(format!("{engine}.bridge.json"));
        let output = run_generic_extract(engine, &game_root, &output_path);
        assert!(
            output.status.success(),
            "{engine} generic extract failed: status={:?}\nstdout={}\nstderr={}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );

        let bridge: Value = serde_json::from_slice(&fs::read(&output_path).expect("bridge output"))
            .expect("bridge output must be JSON");
        assert!(
            bridge["units"]
                .as_array()
                .is_some_and(|units| !units.is_empty()),
            "{engine} generic extract must emit a localizable unit",
        );
    }
}

fn run_generic_extract(engine: &str, game_root: &Path, output_path: &Path) -> Output {
    Command::new(kaifuu_cli_binary())
        .args(["extract", "--engine", engine])
        .args(["--game-root"])
        .arg(game_root)
        .args([
            "--game-id",
            "neutral-project",
            "--game-version",
            "1.0",
            "--source-profile-id",
            "neutral-profile",
            "--source-locale",
            "ja-JP",
            "--scope",
            "all",
            "--bundle-output",
        ])
        .arg(output_path)
        .output()
        .expect("kaifuu-cli must run")
}

fn write_reallive_source(root: &Path) -> PathBuf {
    let game_root = root.join("reallive");
    let data_root = game_root.join("REALLIVEDATA");
    fs::create_dir_all(&data_root).expect("RealLive fixture directory");
    fs::write(data_root.join("Seen.txt"), reallive_seen()).expect("RealLive archive");
    fs::write(data_root.join("Gameexe.ini"), b"#SEEN_START=1\n").expect("RealLive inventory");
    game_root
}

fn reallive_seen() -> Vec<u8> {
    // One Shift-JIS Textout run followed by a metadata terminator. This is the
    // smallest archive shape consumed by the real bytecode parser.
    let bytecode = [0x83_u8, 0x6e, 0x0a, 0x05, 0x00];
    let compressed = compress_avg32_literal(&bytecode).expect("compress synthetic bytecode");
    let mut header = vec![0_u8; SCENE_HEADER_BYTE_LEN];
    header[0..4].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
    header[4..8].copy_from_slice(&110_001_u32.to_le_bytes());
    header[0x20..0x24].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
    header[0x24..0x28].copy_from_slice(&(bytecode.len() as u32).to_le_bytes());
    header[0x28..0x2c].copy_from_slice(&(compressed.len() as u32).to_le_bytes());
    header.extend_from_slice(&compressed);

    let directory_len = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let mut seen = vec![0_u8; directory_len + header.len()];
    seen[8..12].copy_from_slice(&(directory_len as u32).to_le_bytes());
    seen[12..16].copy_from_slice(&(header.len() as u32).to_le_bytes());
    seen[directory_len..].copy_from_slice(&header);
    seen
}

fn write_siglus_source(root: &Path) -> PathBuf {
    let game_root = root.join("siglus");
    fs::create_dir_all(&game_root).expect("Siglus fixture directory");
    fs::write(game_root.join("Scene.pck"), siglus_scene_pack()).expect("Siglus scene pack");
    fs::write(game_root.join("Gameexe.dat"), siglus_gameexe()).expect("Siglus inventory");
    // The mode-zero synthetic Gameexe.dat does not need key recovery, but the
    // engine root contract still requires the executable asset to be present.
    fs::write(
        game_root.join("SiglusEngine.exe"),
        b"synthetic executable marker",
    )
    .expect("Siglus executable marker");
    game_root
}

fn siglus_scene_pack() -> Vec<u8> {
    let decoded = siglus_decoded_scene("sample text");
    let lzss = compress_siglus_lzss(&decoded).expect("compress synthetic scene");
    let mut plain_chunk = Vec::with_capacity(lzss.len() + 8);
    plain_chunk.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
    plain_chunk.extend_from_slice(&(decoded.len() as u32).to_le_bytes());
    plain_chunk.extend_from_slice(&lzss);
    let chunk = apply_xor_table(&plain_chunk, None);

    let name = "unit";
    let name_index_offset = SCENE_PCK_HEADER_BYTE_LEN;
    let name_list_offset = name_index_offset + 8;
    let data_index_offset = name_list_offset + name.encode_utf16().count() * 2;
    let data_list_offset = data_index_offset + 8;
    let mut archive = vec![0_u8; data_list_offset];
    put_scene_header_field(&mut archive, 0, SCENE_PCK_HEADER_BYTE_LEN as u32);
    put_scene_header_field(&mut archive, 13, name_index_offset as u32);
    put_scene_header_field(&mut archive, 14, 1);
    put_scene_header_field(&mut archive, 15, name_list_offset as u32);
    put_scene_header_field(&mut archive, 16, 1);
    put_scene_header_field(&mut archive, 17, data_index_offset as u32);
    put_scene_header_field(&mut archive, 18, 1);
    put_scene_header_field(&mut archive, 19, data_list_offset as u32);
    put_scene_header_field(&mut archive, 20, 1);
    archive[name_index_offset + 4..name_index_offset + 8]
        .copy_from_slice(&(name.encode_utf16().count() as u32).to_le_bytes());
    for (index, unit) in name.encode_utf16().enumerate() {
        let offset = name_list_offset + index * 2;
        archive[offset..offset + 2].copy_from_slice(&unit.to_le_bytes());
    }
    archive[data_index_offset + 4..data_index_offset + 8]
        .copy_from_slice(&(chunk.len() as u32).to_le_bytes());
    archive.extend_from_slice(&chunk);
    archive
}

fn siglus_decoded_scene(text: &str) -> Vec<u8> {
    let mut bytecode = vec![0x02];
    bytecode.extend_from_slice(&FM_STR.to_le_bytes());
    bytecode.extend_from_slice(&0_i32.to_le_bytes());
    bytecode.push(0x31);
    bytecode.extend_from_slice(&0_i32.to_le_bytes());
    bytecode.push(0x16);

    let index_offset = SCN_HEADER_BYTE_LEN + bytecode.len();
    let string_offset = index_offset + 8;
    let encoded_text = text
        .encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    let mut scene = vec![0_u8; SCN_HEADER_BYTE_LEN];
    put_i32(&mut scene, 0, SCN_HEADER_DECLARED_SIZE);
    put_i32(&mut scene, 1, SCN_HEADER_BYTE_LEN as i32);
    put_i32(&mut scene, 2, bytecode.len() as i32);
    put_i32(&mut scene, 3, index_offset as i32);
    put_i32(&mut scene, 4, 1);
    put_i32(&mut scene, 5, string_offset as i32);
    put_i32(&mut scene, 6, 1);
    scene.extend_from_slice(&bytecode);
    scene.extend_from_slice(&0_i32.to_le_bytes());
    scene.extend_from_slice(&((encoded_text.len() / 2) as i32).to_le_bytes());
    scene.extend_from_slice(&encoded_text);
    scene
}

fn siglus_gameexe() -> Vec<u8> {
    let mut utf16 = Vec::new();
    for unit in "#NAMAE.000 = \"sample\"\n".encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    let mut lzss = Vec::new();
    for literals in utf16.chunks(8) {
        lzss.push(((1_u16 << literals.len()) - 1) as u8);
        lzss.extend_from_slice(literals);
    }
    let mut plain = Vec::with_capacity(lzss.len() + 8);
    plain.extend_from_slice(&0_u32.to_le_bytes());
    plain.extend_from_slice(&(utf16.len() as u32).to_le_bytes());
    plain.extend_from_slice(&lzss);
    let plain_len = plain.len() as u32;
    plain[0..4].copy_from_slice(&plain_len.to_le_bytes());

    let mut gameexe = Vec::new();
    gameexe.extend_from_slice(&0_i32.to_le_bytes());
    gameexe.extend_from_slice(&0_i32.to_le_bytes());
    gameexe.extend_from_slice(&apply_gameexe_xor_table(&plain, None));
    gameexe
}

fn put_scene_header_field(bytes: &mut [u8], field: usize, value: u32) {
    let offset = field * 4;
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_i32(bytes: &mut [u8], field: usize, value: i32) {
    let offset = field * 4;
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_softpal_source(root: &Path) -> PathBuf {
    let game_root = root.join("softpal");
    fs::create_dir_all(&game_root).expect("Softpal fixture directory");
    let (textdat, pointer) = softpal_textdat();
    fs::write(game_root.join("TEXT.DAT"), textdat).expect("Softpal text pool");
    fs::write(game_root.join("SCRIPT.SRC"), softpal_script(pointer)).expect("Softpal script");
    game_root
}

fn softpal_textdat() -> (Vec<u8>, u32) {
    let mut bytes = vec![TEXTDAT_FLAG_PLAINTEXT];
    bytes.extend_from_slice(TEXTDAT_MAGIC_TAIL);
    bytes.extend_from_slice(&1_u32.to_le_bytes());
    let pointer = u32::try_from(bytes.len()).expect("fixture pointer fits u32");
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(b"sample text\0");
    (bytes, pointer)
}

fn softpal_script(pointer: u32) -> Vec<u8> {
    let mut bytes = Vec::from(&b"Sv20\0\0\0\0\0\0\0\0"[..]);
    for token in [
        softpal_operator(0x1f),
        pointer.to_le_bytes(),
        softpal_operator(0x1f),
        0x0fff_ffff_u32.to_le_bytes(),
        softpal_operator(0x1f),
        0_u32.to_le_bytes(),
        softpal_operator(0x17),
        ((u32::from(TEXT_SHOW_WORD_HI) << 16) | 0x0002).to_le_bytes(),
        0_u32.to_le_bytes(),
    ] {
        bytes.extend_from_slice(&token);
    }
    bytes
}

fn softpal_operator(id: u16) -> [u8; 4] {
    let mut token = [0_u8; 4];
    token[..2].copy_from_slice(&id.to_le_bytes());
    token[2..].copy_from_slice(&1_u16.to_le_bytes());
    token
}
