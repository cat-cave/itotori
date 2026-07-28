use kaifuu_reallive::{
    RealLiveSceneIndex, SceneEntry, SceneHeader, Xor2DecScene, compiler_version_uses_xor2,
    decompress_avg32, recover_archive_cipher,
};

/// Slice a scene's raw blob bytes out of a Seen.txt archive for a given
/// directory entry.
pub(super) fn scene_blob_bytes(seen_bytes: &[u8], entry: &SceneEntry) -> Vec<u8> {
    let start = entry.byte_offset as usize;
    let end = start + entry.byte_len as usize;
    seen_bytes[start..end].to_vec()
}

/// Resolve a scene by id from a Seen.txt archive and return its
/// AVG32-decompressed, `xor_2`-DECRYPTED bytecode (the plaintext layer the
/// opcode parser consumes).
/// primary_corpus HD (compiler_version 110002) is encrypted-at-rest: both the source
/// archive and the patchback output carry the second-level `xor_2` cipher over
/// `[256, 513)` of every `use_xor_2` scene. This helper mirrors the read
/// pipeline — decompress, then decrypt with the per-game key recovered
/// cross-scene from the whole archive — so the byte-fidelity comparison runs on
/// the real plaintext bytecode of both the source and the patched target.
pub(super) fn decompress_scene(
    seen_bytes: &[u8],
    scene_id: u16,
    xor2_cipher: Option<&kaifuu_reallive::Xor2Cipher>,
) -> Vec<u8> {
    let index: RealLiveSceneIndex =
        kaifuu_reallive::parse_archive(seen_bytes).expect("Seen.txt envelope must parse");
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == scene_id)
        .unwrap_or_else(|| panic!("scene {scene_id} must exist in the archive"));
    let blob = scene_blob_bytes(seen_bytes, entry);
    let header = SceneHeader::parse(&blob).expect("scene header must parse");
    let bytecode_start = header.bytecode_offset as usize;
    let bytecode_end = bytecode_start + header.bytecode_compressed_size as usize;
    let mut decompressed = decompress_avg32(
        &blob[bytecode_start..bytecode_end],
        header.bytecode_uncompressed_size as usize,
    )
    .expect("scene bytecode must decompress");

    if compiler_version_uses_xor2(header.compiler_version) {
        xor2_cipher
            .expect("a use_xor_2 scene requires a recovered xor_2 cipher to decrypt")
            .apply_segment(&mut decompressed);
    }
    decompressed
}

/// Recover the validated per-game `xor_2` cipher by decompressing every scene
/// of the archive (the cross-scene known-plaintext key recovery). Returns
/// `None` when the archive carries no `use_xor_2` scenes or no key validates.
pub(super) fn recover_archive_xor2_cipher(
    seen_bytes: &[u8],
    index: &RealLiveSceneIndex,
) -> Result<kaifuu_reallive::Xor2Cipher, kaifuu_reallive::Xor2Report> {
    let mut scenes: Vec<Xor2DecScene> = Vec::with_capacity(index.entries.len());
    for entry in &index.entries {
        let blob = scene_blob_bytes(seen_bytes, entry);
        let Ok(header) = SceneHeader::parse(&blob) else {
            continue;
        };
        let bo = header.bytecode_offset as usize;
        let bc = header.bytecode_compressed_size as usize;
        let bu = header.bytecode_uncompressed_size as usize;
        if bo + bc > blob.len() {
            continue;
        }
        let Ok(decompressed) = decompress_avg32(&blob[bo..bo + bc], bu) else {
            continue;
        };
        scenes.push(Xor2DecScene {
            compiler_version: header.compiler_version,
            bytecode: decompressed,
        });
    }
    recover_archive_cipher(&scenes)
}
