use super::*;
use crate::compressor::compress_avg32_literal;
use serde_json::json;

/// Build the smallest viable synthetic Seen.txt with one scene
/// whose decompressed bytecode starts with one Shift-JIS Textout
/// run (`ハ` = `0x83 0x6E`) followed by a MetaLine terminator.
pub(super) fn build_synthetic_archive() -> SyntheticArchive {
    // Decompressed bytecode: SJIS for "ハ" (0x83 0x6E), then a
    // MetaLine to terminate the textout run.
    let plaintext = vec![0x83u8, 0x6E, 0x0A, 0x05, 0x00];
    let compressed = compress_avg32_literal(&plaintext).expect("compress synthetic");

    // Synthesize a scene header pointing at the compressed payload
    // immediately after the 0x1d0-byte header.
    let mut header = vec![0u8; SCENE_HEADER_BYTE_LEN];
    header[0..4].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
    // Plaintext synthetic scene -> NON-`xor_2` compiler version (110001,
    // not 110002/1110002): an `xor_2` version makes patchback try to
    // recover a key from unencrypted bytes and abort. Real `xor_2` is
    // covered by the real-corpus tests.
    header[4..8].copy_from_slice(&110_001u32.to_le_bytes()); // compiler version (non-xor_2)
    // bytecode_offset at 0x20.
    header[0x20..0x24].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
    // bytecode_uncompressed_size at 0x24.
    header[0x24..0x28].copy_from_slice(&(plaintext.len() as u32).to_le_bytes());
    // bytecode_compressed_size at 0x28.
    header[0x28..0x2c].copy_from_slice(&(compressed.len() as u32).to_le_bytes());

    let mut scene_blob = Vec::with_capacity(header.len() + compressed.len());
    scene_blob.extend_from_slice(&header);
    scene_blob.extend_from_slice(&compressed);

    // Build the 80,000-byte directory with scene 1 sitting at file
    // offset 0x13880.
    let scene_offset = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN;
    let mut archive = vec![0u8; REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize + scene_blob.len()];
    // Scene 1's slot is at directory byte offset 1 * 8 == 8.
    let slot_byte_start = 8;
    archive[slot_byte_start..slot_byte_start + 4]
        .copy_from_slice(&(scene_offset as u32).to_le_bytes());
    archive[slot_byte_start + 4..slot_byte_start + 8]
        .copy_from_slice(&(scene_blob.len() as u32).to_le_bytes());
    archive[REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize..].copy_from_slice(&scene_blob);

    // Decompressed-byte-offset of the Textout run inside the
    // decompressed bytecode: position 0 (starts immediately).
    let _ = scene_offset;
    SyntheticArchive { archive }
}

pub(super) struct SyntheticArchive {
    archive: Vec<u8>,
}

pub(super) fn make_bundle_json(
    scene_blob_file_offset: u64,
    decompressed_byte_offset: u64,
    decompressed_byte_len: u64,
    target_text: &str,
) -> Value {
    let bridge_id = "01970000-0000-7000-8000-000000000001";
    let revision_id = "01970000-0000-7000-8000-000000000002";
    let asset_id = "01970000-0000-7000-8000-000000000003";
    let bridge_unit_id = "01970000-0000-7000-8000-000000000004";
    let surface_id = "01970000-0000-7000-8000-000000000005";
    let span_id_unused = "01970000-0000-7000-8000-000000000006";
    let _ = span_id_unused;
    let source_profile_revision_id = "01970000-0000-7000-8000-000000000007";

    let scene_blob_hash = kaifuu_core::sha256_hash_bytes(b"synthetic-scene-1-placeholder-content");
    let source_hash = kaifuu_core::sha256_hash_bytes("Synthetic source text".as_bytes());
    let source_profile_hash = kaifuu_core::sha256_hash_bytes(b"kaifuu-reallive-observed");

    let start_byte = scene_blob_file_offset + decompressed_byte_offset;
    let end_byte = start_byte + decompressed_byte_len;

    json!({
        "schemaVersion": "0.2.0",
        "bridgeId": bridge_id,
        "sourceGame": {
            "gameId": "observed-reallive",
            "gameVersion": "1.0.0",
            "sourceProfileId": "kaifuu-reallive-observed",
            "sourceProfileRevision": {
                "revisionId": source_profile_revision_id,
                "revisionKind": "content_hash",
                "value": source_profile_hash,
            },
        },
        "sourceBundleHash": scene_blob_hash,
        "sourceBundleRevision": {
            "revisionId": revision_id,
            "revisionKind": "content_hash",
            "value": scene_blob_hash,
        },
        "sourceLocale": "ja-JP",
        "hashStrategy": {
            "sourceProfile": {
                "scope": "source_profile",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
            "sourceBundle": {
                "scope": "source_bundle",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
            "sourceAsset": {
                "scope": "source_asset",
                "algorithm": "sha256",
                "normalization": "bytes",
            },
            "sourceUnit": {
                "scope": "source_unit",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
                "fields": ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
            },
            "patchExport": {
                "scope": "patch_export",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
            "deltaPackage": {
                "scope": "delta_package",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
        },
        "extractor": {
            "name": "kaifuu-reallive-bridge",
            "version": "0.1.0",
        },
        "assets": [
            {
                "assetId": asset_id,
                "assetKey": "reallive:scene-0001",
                "assetKind": "script",
                "sourceHash": scene_blob_hash,
                "sourceRevision": {
                    "revisionId": revision_id,
                    "revisionKind": "content_hash",
                    "value": scene_blob_hash,
                },
                "path": "REALLIVEDATA/Seen.txt#scene-0001",
            }
        ],
        "units": [
            {
                "bridgeUnitId": bridge_unit_id,
                "surfaceId": surface_id,
                "surfaceKind": "dialogue",
                "sourceUnitKey": "reallive:scene-0001#0000",
                "occurrenceId": "scene-0001-occ-0000",
                "sourceLocale": "ja-JP",
                "sourceText": "Synthetic source text",
                "sourceHash": source_hash,
                "sourceRevision": {
                    "revisionId": revision_id,
                    "revisionKind": "content_hash",
                    "value": scene_blob_hash,
                },
                "sourceAssetRef": {
                    "assetId": asset_id,
                    "assetKey": "reallive:scene-0001",
                },
                "sourceLocation": {
                    "containerKey": "reallive:scene-0001",
                    "entryPath": ["scene", "0001", "units", "0000"],
                    "range": {
                        "startByte": start_byte,
                        "endByte": end_byte,
                    },
                },
                "speaker": {"knowledgeState": "not_applicable"},
                "context": {
                    "route": {
                        "sceneKey": "scene-0001",
                        "position": "line-0000",
                    },
                },
                "spans": [],
                "patchRef": {
                    "assetId": asset_id,
                    "writeMode": "replace",
                    "sourceUnitKey": "reallive:scene-0001#0000",
                    "sourceRevision": {
                        "revisionId": revision_id,
                        "revisionKind": "content_hash",
                        "value": scene_blob_hash,
                    },
                },
                "runtimeExpectation": {
                    "expectationKind": "trace_text",
                    "traceKey": "scene-0001-occ-0000",
                },
                "target": {
                    "locale": "en-US",
                    "text": target_text,
                }
            }
        ],
        "policyRecords": [],
    })
}

/// Assemble a Seen.txt archive from `(scene_id, scene_blob)` pairs,
/// laid out sequentially after the 80,000-byte directory.
pub(super) fn assemble_archive(scenes: &[(u16, Vec<u8>)]) -> Vec<u8> {
    let mut directory = vec![0u8; REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize];
    let mut payload: Vec<u8> = Vec::new();
    let mut cursor = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN;
    for (scene_id, blob) in scenes {
        let slot = *scene_id as usize * 8;
        directory[slot..slot + 4].copy_from_slice(&(cursor as u32).to_le_bytes());
        directory[slot + 4..slot + 8].copy_from_slice(&(blob.len() as u32).to_le_bytes());
        payload.extend_from_slice(blob);
        cursor += blob.len() as u64;
    }
    let mut archive = directory;
    archive.extend_from_slice(&payload);
    archive
}

/// Build one scene blob (`header || compressed-bytecode`) from
/// decompressed plaintext bytecode.
pub(super) fn scene_blob_from_plaintext(plaintext: &[u8]) -> Vec<u8> {
    let compressed = compress_avg32_literal(plaintext).expect("compress scene");
    let mut header = vec![0u8; SCENE_HEADER_BYTE_LEN];
    header[0..4].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
    // Plaintext scene -> NON-`xor_2` compiler version (110001, not
    // 110002/1110002): an `xor_2` version would make patchback try to
    // recover a key from unencrypted bytes and abort. The real `xor_2`
    // round-trip is covered by the real-corpus tests.
    header[4..8].copy_from_slice(&110_001u32.to_le_bytes());
    header[0x20..0x24].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
    header[0x24..0x28].copy_from_slice(&(plaintext.len() as u32).to_le_bytes());
    header[0x28..0x2c].copy_from_slice(&(compressed.len() as u32).to_le_bytes());
    let mut blob = header;
    blob.extend_from_slice(&compressed);
    blob
}

/// Decompress a scene's bytecode out of an assembled archive.
pub(super) fn decompress_scene(archive: &[u8], scene_id: u16) -> Vec<u8> {
    let index = parse_archive(archive).expect("archive parses");
    let entry = index
        .entries
        .iter()
        .find(|e| e.scene_id == scene_id)
        .expect("scene present");
    let blob = &archive
        [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
    let header = SceneHeader::parse(blob).expect("header");
    let bc_start = header.bytecode_offset as usize;
    let bc_end = bc_start + header.bytecode_compressed_size as usize;
    decompress_avg32(
        &blob[bc_start..bc_end],
        header.bytecode_uncompressed_size as usize,
    )
    .expect("decompress")
}

/// Return a scene blob using the parsed archive directory's offset/length.
pub(super) fn scene_blob(archive: &[u8], scene_id: u16) -> &[u8] {
    let index = parse_archive(archive).expect("archive parses");
    let entry = index
        .entries
        .iter()
        .find(|e| e.scene_id == scene_id)
        .expect("scene present");
    &archive[entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize]
}

/// Build a synthetic single-scene archive whose bytecode is
/// `Textout("ハ") · goto(@target) · MetaLine`, where the `goto` pointer
/// targets the trailing MetaLine (an element boundary AFTER the edited
/// dialogue). Returns `(archive, goto_target_offset, metaline_offset)`.
pub(super) fn build_archive_with_goto() -> (Vec<u8>, i32, usize) {
    let mut plaintext: Vec<u8> = Vec::new();
    // occ0 dialogue "ハ" at decompressed offset 0..2.
    plaintext.extend_from_slice(&[0x83, 0x6E]);
    // `goto` command (command_id 0x0001_0000): 0x23 opener, module_type=0,
    // module_id=1 (JMP), opcode=0, argc=0, overload=0, then one i32 target.
    // Header occupies offset 2..10; the i32 pointer occupies 10..14.
    plaintext.extend_from_slice(&[0x23, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
    let metaline_offset: usize = 14;
    plaintext.extend_from_slice(&(metaline_offset as i32).to_le_bytes());
    // The jump target: the MetaLine at offset 14.
    plaintext.extend_from_slice(&[0x0A, 0x05, 0x00]);
    assert_eq!(plaintext.len(), 17);

    let blob = scene_blob_from_plaintext(&plaintext);
    let archive = assemble_archive(&[(1, blob)]);
    (archive, metaline_offset as i32, metaline_offset)
}

/// A length-changing dialogue edit (both longer and shorter) re-bases the
/// trailing `goto` pointer so it still targets the MetaLine at its NEW
/// offset — never a stale offset that would land mid-command.
mod archive;
mod core;
