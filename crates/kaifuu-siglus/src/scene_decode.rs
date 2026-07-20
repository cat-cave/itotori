//! `Scene.pck` payload decode + sanitized reporting.
//! Ties the envelope reader ([`crate::archive`]), the constant-table + gated
//! second-layer strip ([`crate::decrypt`]) and the proprietary LZSS
//! decompressor ([`crate::decompress`]) into the full per-scene decode:
//! ```text
//! raw chunk -> [second-layer XOR?] -> constant-256 XOR -> [u32 comp][u32 org] -> LZSS -> scene bytecode
//! ```
//! # Semantic gating (before any output)
//! The container's `extra_key_use` flag and the caller's key presence must
//! agree, and the decrypted `compressed_size` header field must equal the
//! chunk's on-disk length. Both checks fire **before** any decompressed byte is
//! produced — a missing/spurious key or a wrong cipher (garbage size header)
//! is a typed diagnostic, never a partial or silent output.
//! # Sanitized reporting (no raw scene bytes)
//! [`decode_scene_pack`] returns a [`SiglusScenePackReport`] carrying only scene
//! counts, a decompressed-size histogram, per-scene names + **sha256 prefixes**,
//! and (when a key was used) the key's secret-ref + a one-way commitment. Raw
//! decompressed scene bytes and raw key bytes never enter the report.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::archive::{SiglusArchiveError, SiglusSceneEntry, parse_scene_pck};
use crate::decompress::{SiglusDecompressError, decompress_siglus_lzss};
use crate::decrypt::{SiglusSecondLayerMaterial, apply_xor_table};

/// Byte length of the LZSS size header (`[u32 comp_size][u32 decomp_size]`).
const LZSS_SIZE_HEADER_LEN: usize = 8;

/// Fatal errors raised when decoding one packed scene payload.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SceneDecodeError {
    /// The container marks the payloads as second-layer masked (`extra_key_use`)
    /// but no key material was supplied. The per-game key is the key-discovery
    /// layer's (siglus-04) deliverable; without it these scenes cannot decode.
    #[error(
        "kaifuu.siglus.scene.second_layer_key_required: scene {scene_id} payload is masked with \
         the per-game second-layer key (extra_key_use set) but no resolved key material was \
         supplied"
    )]
    SecondLayerKeyRequired { scene_id: u32 },
    /// Key material was supplied but the container is not second-layer masked.
    #[error(
        "kaifuu.siglus.scene.second_layer_key_unexpected: scene {scene_id} payload is not \
         second-layer masked (extra_key_use clear) but key material was supplied"
    )]
    SecondLayerKeyUnexpected { scene_id: u32 },
    /// The chunk is shorter than the fixed 8-byte LZSS size header.
    #[error(
        "kaifuu.siglus.scene.truncated_chunk: scene {scene_id} chunk length {observed_len} is \
         shorter than the {LZSS_SIZE_HEADER_LEN}-byte size header"
    )]
    TruncatedChunk { scene_id: u32, observed_len: usize },
    /// The decrypted `compressed_size` field does not equal the chunk length —
    /// the tell-tale of a wrong constant table or wrong/absent second-layer key.
    #[error(
        "kaifuu.siglus.scene.compressed_size_mismatch: scene {scene_id} decrypted compressed_size \
         {declared} != chunk length {actual} (wrong key or cipher method)"
    )]
    CompressedSizeMismatch {
        scene_id: u32,
        declared: u32,
        actual: usize,
    },
    /// LZSS decompression failed after a valid header.
    #[error("kaifuu.siglus.scene.decompress: scene {scene_id}: {source}")]
    Decompress {
        scene_id: u32,
        #[source]
        source: SiglusDecompressError,
    },
}

/// Decode a single packed scene chunk to its decompressed bytecode.
/// `raw_chunk` is the on-disk payload (`entry.byte_len` bytes at
/// `entry.byte_offset`). `extra_key_use` is the container flag; `second_layer`
/// is the resolved per-game key material (or `None`). All gating happens before
/// any decompressed byte is produced.
pub fn decode_scene_chunk(
    scene_id: u32,
    raw_chunk: &[u8],
    extra_key_use: bool,
    second_layer: Option<&SiglusSecondLayerMaterial>,
) -> Result<Vec<u8>, SceneDecodeError> {
    match (extra_key_use, second_layer.is_some()) {
        (true, false) => return Err(SceneDecodeError::SecondLayerKeyRequired { scene_id }),
        (false, true) => return Err(SceneDecodeError::SecondLayerKeyUnexpected { scene_id }),
        _ => {}
    }

    if raw_chunk.len() < LZSS_SIZE_HEADER_LEN {
        return Err(SceneDecodeError::TruncatedChunk {
            scene_id,
            observed_len: raw_chunk.len(),
        });
    }

    let decrypted = apply_xor_table(raw_chunk, second_layer);
    let compressed_size =
        u32::from_le_bytes([decrypted[0], decrypted[1], decrypted[2], decrypted[3]]);
    let decompressed_size =
        u32::from_le_bytes([decrypted[4], decrypted[5], decrypted[6], decrypted[7]]) as usize;

    // The engine stores the whole chunk length in compressed_size. A mismatch
    // means the cipher/key is wrong — reject before decompressing.
    if compressed_size as usize != raw_chunk.len() {
        return Err(SceneDecodeError::CompressedSizeMismatch {
            scene_id,
            declared: compressed_size,
            actual: raw_chunk.len(),
        });
    }

    decompress_siglus_lzss(&decrypted[LZSS_SIZE_HEADER_LEN..], decompressed_size)
        .map_err(|source| SceneDecodeError::Decompress { scene_id, source })
}

/// Sanitized per-scene digest: name + size + sha256 prefix only. No raw bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusSceneDigest {
    pub scene_id: String,
    pub scene_name: Option<String>,
    pub decompressed_len: usize,
    pub sha256_prefix: String,
}

/// A recorded per-scene decode failure (semantic code only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusSceneFailure {
    pub scene_id: String,
    pub scene_name: Option<String>,
    pub diagnostic: String,
}

/// Sanitized `Scene.pck` decode report. Carries counts, a decompressed-size
/// histogram, per-scene sha256 prefixes and names, and (when used) the key
/// secret-ref + commitment. Never raw scene bytes or raw key bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusScenePackReport {
    pub scene_count: usize,
    pub extra_key_use: bool,
    pub decoded_count: usize,
    pub failed_count: usize,
    pub size_histogram: BTreeMap<String, usize>,
    pub scene_digests: Vec<SiglusSceneDigest>,
    pub failures: Vec<SiglusSceneFailure>,
    pub second_layer_secret_ref: Option<String>,
    pub second_layer_key_sha256_prefix: Option<String>,
}

impl SiglusScenePackReport {
    /// True when every scene decoded (the acceptance shape for a fully-keyed
    /// title).
    pub fn fully_decoded(&self) -> bool {
        self.failed_count == 0 && self.scene_count > 0
    }
}

fn sha256_prefix(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    Sha256::digest(bytes)
        .iter()
        .take(8)
        .fold(String::new(), |mut acc, byte| {
            let _ = write!(acc, "{byte:02x}");
            acc
        })
}

fn histogram_bucket(len: usize) -> &'static str {
    match len {
        0..=1023 => "0..1KiB",
        1024..=4095 => "1..4KiB",
        4096..=16383 => "4..16KiB",
        16384..=65535 => "16..64KiB",
        _ => ">=64KiB",
    }
}

/// Parse and decode every scene in a `Scene.pck` archive, producing a sanitized
/// report. Envelope failures are fatal ([`SiglusArchiveError`]); per-scene
/// decode failures (e.g. a required-but-absent second-layer key) are recorded
/// in the report rather than aborting, so a partially-keyable archive still
/// yields an honest per-scene accounting.
pub fn decode_scene_pack(
    archive_bytes: &[u8],
    second_layer: Option<&SiglusSecondLayerMaterial>,
) -> Result<SiglusScenePackReport, SiglusArchiveError> {
    let index = parse_scene_pck(archive_bytes)?;
    let mut digests = Vec::new();
    let mut failures = Vec::new();
    let mut histogram: BTreeMap<String, usize> = BTreeMap::new();

    for entry in &index.entries {
        let chunk = scene_chunk(archive_bytes, entry);
        match decode_scene_chunk(entry.scene_id, chunk, index.extra_key_use, second_layer) {
            Ok(decompressed) => {
                *histogram
                    .entry(histogram_bucket(decompressed.len()).to_string())
                    .or_insert(0) += 1;
                digests.push(SiglusSceneDigest {
                    scene_id: entry.scene_id_str(),
                    scene_name: entry.scene_name.clone(),
                    decompressed_len: decompressed.len(),
                    sha256_prefix: sha256_prefix(&decompressed),
                });
            }
            Err(error) => failures.push(SiglusSceneFailure {
                scene_id: entry.scene_id_str(),
                scene_name: entry.scene_name.clone(),
                diagnostic: error.to_string(),
            }),
        }
    }

    Ok(SiglusScenePackReport {
        scene_count: index.entries.len(),
        extra_key_use: index.extra_key_use,
        decoded_count: digests.len(),
        failed_count: failures.len(),
        size_histogram: histogram,
        scene_digests: digests,
        failures,
        second_layer_secret_ref: second_layer.map(|material| material.secret_ref().to_string()),
        second_layer_key_sha256_prefix: second_layer
            .map(SiglusSecondLayerMaterial::material_sha256_prefix),
    })
}

/// Borrow a scene's on-disk chunk from the archive bytes. The envelope reader
/// already bounds-checked `(byte_offset, byte_len)`, so this cannot panic.
fn scene_chunk<'a>(archive_bytes: &'a [u8], entry: &SiglusSceneEntry) -> &'a [u8] {
    let start = entry.byte_offset as usize;
    let end = start + entry.byte_len as usize;
    &archive_bytes[start..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decrypt::{SiglusSecondLayerKey, apply_xor_table};

    /// Hand-build one packed scene: header + LZSS-compressed all-literal
    /// bytecode, masked with the constant table + a known 16-byte key.
    fn build_masked_chunk(bytecode: &[u8], key: &SiglusSecondLayerMaterial) -> Vec<u8> {
        // All-literal LZSS: one flag byte per 8 literals.
        let mut stream = Vec::new();
        for group in bytecode.chunks(8) {
            let flag = if group.len() == 8 {
                0xFFu8
            } else {
                (1u16 << group.len()) as u8 - 1
            };
            stream.push(flag);
            stream.extend_from_slice(group);
        }
        let mut plain = Vec::new();
        // compressed_size = whole chunk length (filled after we know it).
        plain.extend_from_slice(&0u32.to_le_bytes());
        plain.extend_from_slice(&(bytecode.len() as u32).to_le_bytes());
        plain.extend_from_slice(&stream);
        let chunk_len = plain.len() as u32;
        plain[0..4].copy_from_slice(&chunk_len.to_le_bytes());
        // Re-mask (constant + second layer) — apply_xor_table is its own inverse.
        apply_xor_table(&plain, Some(key))
    }

    #[test]
    fn synthetic_round_trip_with_known_key() {
        let key_ref = SiglusSecondLayerKey::from_secret_ref("secret://test/scene-key");
        let material = SiglusSecondLayerMaterial::resolve(&key_ref, vec![0x3Cu8; 16]).unwrap();
        let bytecode: Vec<u8> = (0u8..37).collect();
        let chunk = build_masked_chunk(&bytecode, &material);
        let out = decode_scene_chunk(0, &chunk, true, Some(&material)).expect("keyed decode");
        assert_eq!(out, bytecode);
    }

    #[test]
    fn missing_required_key_fails_before_output() {
        let key_ref = SiglusSecondLayerKey::from_secret_ref("secret://test/scene-key");
        let material = SiglusSecondLayerMaterial::resolve(&key_ref, vec![0x3Cu8; 16]).unwrap();
        let chunk = build_masked_chunk(&[1, 2, 3, 4], &material);
        let err = decode_scene_chunk(5, &chunk, true, None).expect_err("key required");
        assert_eq!(
            err,
            SceneDecodeError::SecondLayerKeyRequired { scene_id: 5 }
        );
    }

    #[test]
    fn wrong_key_trips_compressed_size_guard_before_output() {
        let key_ref = SiglusSecondLayerKey::from_secret_ref("secret://test/scene-key");
        let right = SiglusSecondLayerMaterial::resolve(&key_ref, vec![0x3Cu8; 16]).unwrap();
        let wrong = SiglusSecondLayerMaterial::resolve(&key_ref, vec![0x99u8; 16]).unwrap();
        let chunk = build_masked_chunk(&[1, 2, 3, 4, 5, 6, 7, 8], &right);
        let err = decode_scene_chunk(9, &chunk, true, Some(&wrong)).expect_err("wrong key");
        assert!(matches!(
            err,
            SceneDecodeError::CompressedSizeMismatch { scene_id: 9, .. }
        ));
    }
}
