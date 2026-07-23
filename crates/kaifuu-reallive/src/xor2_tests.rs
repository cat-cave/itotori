use super::*;

#[test]
fn compiler_version_gate_matches_rlvm() {
    assert!(compiler_version_uses_xor2(110002));
    assert!(compiler_version_uses_xor2(1110002));
    assert!(!compiler_version_uses_xor2(10002));
    assert!(!compiler_version_uses_xor2(0));
}

#[test]
fn apply_segment_is_self_inverse_and_bounded() {
    let key = [
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
        0x01,
    ];
    // Long enough to cover the whole segment plus tail.
    let mut data: Vec<u8> = (0..700u32).map(|n| (n % 251) as u8).collect();
    let original = data.clone();
    apply_xor2_segment(&mut data, &key);
    // Bytes before the segment and after `offset + length` are untouched.
    assert_eq!(
        &data[..XOR2_SEGMENT_OFFSET],
        &original[..XOR2_SEGMENT_OFFSET]
    );
    assert_eq!(
        &data[XOR2_SEGMENT_OFFSET + XOR2_SEGMENT_LENGTH..],
        &original[XOR2_SEGMENT_OFFSET + XOR2_SEGMENT_LENGTH..]
    );
    // The segment changed.
    assert_ne!(data, original);
    // XOR is self-inverse: applying again restores the plaintext.
    apply_xor2_segment(&mut data, &key);
    assert_eq!(data, original);
}

#[test]
fn short_scene_below_offset_is_untouched() {
    let key = [0xab; XOR2_KEY_LEN];
    let mut data = vec![0x0au8; XOR2_SEGMENT_OFFSET - 1];
    let original = data.clone();
    apply_xor2_segment(&mut data, &key);
    assert_eq!(
        data, original,
        "scene shorter than the segment offset is a no-op"
    );
}

/// Synthetic plaintext: a run of `MetaLine(line=0)` triples (`0a 00 00`),
/// which `parse_real_bytecode` decodes as recognised `MetaLine` opcodes —
/// no real game bytes. Dominant byte is `0x00`, matching the recovery's
/// known-plaintext assumption.
fn synthetic_clean_scene(triples: usize) -> Vec<u8> {
    let mut v = Vec::with_capacity(triples * 3);
    for _ in 0..triples {
        v.extend_from_slice(&[0x0a, 0x00, 0x00]);
    }
    v
}

#[test]
fn recovers_and_decrypts_synthetic_corpus_then_validates() {
    use std::fmt::Write as _;
    let planted = [
        0x97, 0x02, 0xcb, 0x5a, 0x83, 0x0f, 0x5e, 0x30, 0xa7, 0x66, 0xe5, 0x37, 0x62, 0x3f, 0x9a,
        0xdc,
    ];
    // Several long scenes so every lane is well sampled.
    let mut scenes: Vec<Xor2DecScene> = (0..6)
        .map(|n| {
            let mut bytecode = synthetic_clean_scene(220 + n * 7);
            apply_xor2_segment(&mut bytecode, &planted); // "encrypt"
            Xor2DecScene {
                compiler_version: 110002,
                bytecode,
            }
        })
        .collect();

    let report = recover_and_decrypt_archive(&mut scenes);
    assert!(report.validated, "candidate must validate: {report:?}");
    assert_eq!(report.scenes_eligible, 6);
    assert_eq!(report.scenes_decrypted, 6);
    assert_eq!(report.after_clean, 6);
    // The published commitment is the sha256 of the planted key — proving
    // recovery without revealing bytes.
    let mut hasher = Sha256::new();
    hasher.update(planted);
    let expected: String = hasher.finalize().iter().fold(String::new(), |mut acc, b| {
        let _ = write!(acc, "{b:02x}");
        acc
    });
    assert_eq!(report.key_sha256.as_deref(), Some(expected.as_str()));
    // Every scene is now the original plaintext (decrypted in place).
    for scene in &scenes {
        assert!(decodes_clean(&scene.bytecode));
    }
}

#[test]
fn cipher_round_trips_decrypt_then_reencrypt() {
    let planted = [
        0x97, 0x02, 0xcb, 0x5a, 0x83, 0x0f, 0x5e, 0x30, 0xa7, 0x66, 0xe5, 0x37, 0x62, 0x3f, 0x9a,
        0xdc,
    ];
    let scenes: Vec<Xor2DecScene> = (0..6)
        .map(|n| {
            let mut bytecode = synthetic_clean_scene(220 + n * 7);
            apply_xor2_segment(&mut bytecode, &planted); // "encrypt"
            Xor2DecScene {
                compiler_version: 110002,
                bytecode,
            }
        })
        .collect();

    // Recover the cipher WITHOUT mutating the scenes (unlike
    // recover_and_decrypt_archive).
    let cipher = recover_archive_cipher(&scenes).expect("cipher must recover");
    assert!(cipher.report().validated);
    assert!(cipher.report().key_sha256.is_some());
    // The cipher does not consume the input: the scenes handed in are
    // untouched (recover_archive_cipher takes `&[..]`).
    let encrypted = scenes[0].bytecode.clone();

    // Decrypt one scene in a copy: the xor_2 segment must actually change
    // and the result must decode clean.
    let mut scene = encrypted.clone();
    cipher.apply_segment(&mut scene); // decrypt
    assert_ne!(scene, encrypted, "decrypt must transform the xor_2 segment");
    assert!(decodes_clean(&scene), "decrypted scene must decode clean");

    // Re-encrypt (self-inverse): must reproduce the original ciphertext
    // exactly — the patchback round-trip's correctness contract.
    cipher.apply_segment(&mut scene);
    assert_eq!(scene, encrypted, "re-encrypt must restore the ciphertext");
}

#[test]
fn cipher_recovery_fails_on_non_eligible_corpus() {
    let scenes = vec![Xor2DecScene {
        compiler_version: 10002,
        bytecode: synthetic_clean_scene(300),
    }];
    let err = recover_archive_cipher(&scenes)
        .expect_err("a corpus with no use_xor_2 scenes must not yield a cipher");
    assert_eq!(err.scenes_eligible, 0);
    assert!(!err.validated);
}

#[test]
fn non_eligible_corpus_is_a_no_op() {
    let mut scenes = vec![
        Xor2DecScene {
            compiler_version: 10002,
            bytecode: synthetic_clean_scene(300),
        },
        Xor2DecScene {
            compiler_version: 10002,
            bytecode: synthetic_clean_scene(10),
        },
    ];
    let before = scenes.clone();
    let report = recover_and_decrypt_archive(&mut scenes);
    assert_eq!(report.scenes_eligible, 0);
    assert!(!report.validated);
    assert!(report.finding.is_none());
    assert!(report.key_sha256.is_none());
    assert_eq!(
        scenes.iter().map(|s| &s.bytecode).collect::<Vec<_>>(),
        before.iter().map(|s| &s.bytecode).collect::<Vec<_>>(),
        "non-use_xor_2 scenes must be byte-identical (untouched)"
    );
}

#[test]
fn wrong_shaped_corpus_does_not_fake_success() {
    // Eligible scenes whose segment is high-entropy noise that no 16-byte
    // key can turn into clean bytecode: recovery must NOT validate, must
    // surface a finding, and must leave the bytes untouched.
    let mut scenes: Vec<Xor2DecScene> = (0..3)
        .map(|n| {
            let bytecode: Vec<u8> = (0..600u32)
                .map(|i| ((i.wrapping_mul(2654435761).wrapping_add(n * 7)) >> 13) as u8)
                .collect();
            Xor2DecScene {
                compiler_version: 110002,
                bytecode,
            }
        })
        .collect();
    let before = scenes.clone();
    let report = recover_and_decrypt_archive(&mut scenes);
    assert!(!report.validated, "noise must not validate: {report:?}");
    assert!(report.finding.is_some());
    assert!(report.key_sha256.is_none());
    assert_eq!(report.scenes_decrypted, 0);
    assert_eq!(
        scenes.iter().map(|s| &s.bytecode).collect::<Vec<_>>(),
        before.iter().map(|s| &s.bytecode).collect::<Vec<_>>(),
        "a non-validated candidate must never mutate the corpus"
    );
}

/// Build a synthetic SEEN.TXT archive with the given scenes. Each tuple is
/// `(scene_id, compiler_version, bytecode_offset, plaintext)`. A
/// `bytecode_offset` inside the header region models a malformed scene.
fn build_archive(scenes: &[(u16, u32, u32, Vec<u8>)]) -> Vec<u8> {
    use crate::archive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN;
    use crate::compressor::compress_avg32_literal;

    let dir_len = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let mut directory = vec![0u8; dir_len];
    let mut payload: Vec<u8> = Vec::new();
    for (scene_id, compiler_version, bytecode_offset, plaintext) in scenes {
        let compressed = compress_avg32_literal(plaintext).expect("compress synthetic");
        let mut header = vec![0u8; SCENE_HEADER_BYTE_LEN];
        header[0x04..0x08].copy_from_slice(&compiler_version.to_le_bytes());
        header[0x20..0x24].copy_from_slice(&bytecode_offset.to_le_bytes());
        header[0x24..0x28].copy_from_slice(&(plaintext.len() as u32).to_le_bytes());
        header[0x28..0x2c].copy_from_slice(&(compressed.len() as u32).to_le_bytes());
        // The compressed payload is placed at SCENE_HEADER_BYTE_LEN; a
        // malformed `bytecode_offset` (inside the header) still parses but
        // must be rejected by the shared helper's lower-bound guard.
        let mut blob = header;
        blob.extend_from_slice(&compressed);

        let file_offset = dir_len + payload.len();
        let slot = (*scene_id as usize) * 8;
        directory[slot..slot + 4].copy_from_slice(&(file_offset as u32).to_le_bytes());
        directory[slot + 4..slot + 8].copy_from_slice(&(blob.len() as u32).to_le_bytes());
        payload.extend_from_slice(&blob);
    }
    let mut archive = directory;
    archive.extend_from_slice(&payload);
    archive
}

#[test]
fn decompress_archive_scenes_is_the_single_shared_corpus_source() {
    use crate::archive::parse_archive;

    // Scenes 1 & 2 are well-formed (bytecode after the 0x1d0 header).
    // Scene 3 is malformed: bytecode_offset = 0x20 sits INSIDE the header
    // region — the corrected lower-bound guard must exclude it. This is
    // exactly the guard the extract path previously LACKED, so before the
    // dedup extract and patchback disagreed on scene 3's membership.
    let archive = build_archive(&[
        (
            1,
            110002,
            SCENE_HEADER_BYTE_LEN as u32,
            synthetic_clean_scene(220),
        ),
        (
            2,
            110002,
            SCENE_HEADER_BYTE_LEN as u32,
            synthetic_clean_scene(230),
        ),
        (3, 110002, 0x20, synthetic_clean_scene(10)),
    ]);
    let index = parse_archive(&archive).expect("archive must parse");
    assert_eq!(index.entries.len(), 3, "all three slots are populated");

    let corpus = decompress_archive_scenes(&archive, &index);

    // The malformed scene 3 is excluded; only the two well-formed scenes
    // feed key recovery.
    assert_eq!(
        corpus.scene_ids,
        vec![1, 2],
        "bytecode_offset inside the header must be excluded from the corpus"
    );
    assert_eq!(corpus.scenes.len(), 2);
    assert_eq!(corpus.position_of(1), Some(0));
    assert_eq!(corpus.position_of(2), Some(1));
    assert_eq!(
        corpus.position_of(3),
        None,
        "excluded scene has no position"
    );
    assert_eq!(
        corpus.position_of(999),
        None,
        "absent scene has no position"
    );

    // The extract path (whole-archive corpus, target lookup) and the
    // patchback path (whole-archive corpus, cipher recovery) build the
    // corpus through this SAME call — assert the two invocations produce
    // byte-identical corpora so the divergence cannot recur.
    let extract_corpus = decompress_archive_scenes(&archive, &index);
    let patchback_corpus = decompress_archive_scenes(&archive, &index);
    assert_eq!(extract_corpus.scene_ids, patchback_corpus.scene_ids);
    assert_eq!(
        extract_corpus
            .scenes
            .iter()
            .map(|s| (s.compiler_version, &s.bytecode))
            .collect::<Vec<_>>(),
        patchback_corpus
            .scenes
            .iter()
            .map(|s| (s.compiler_version, &s.bytecode))
            .collect::<Vec<_>>(),
        "extract and patchback must build an identical shared corpus"
    );
}

#[test]
fn key_debug_is_redacted() {
    let key = Xor2Key { bytes: [0x42; 16] };
    let rendered = format!("{key:?}");
    assert!(rendered.contains("REDACTED"));
    assert!(!rendered.contains("42424242"));
}
