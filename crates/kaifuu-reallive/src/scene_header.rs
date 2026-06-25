//! KAIFUU-210 — parallel scene-header decoder for kaifuu-reallive.
//!
//! Decodes the fixed `0x1d0`-byte (464-byte) scene header that prefixes
//! every populated scene blob in a RealLive `Seen.txt` envelope. The
//! layout is documented in `docs/research/reallive-engine.md` §D and
//! confirmed against Sweetie HD's scene #1 in
//! `docs/research/reallive-sweetie-hd-encryption-mechanism.md` §4.
//!
//! Provenance:
//! - The same on-disk format is decoded by `utsushi-reallive::scene_header`,
//!   but kaifuu-reallive does **not** depend on utsushi-reallive (per
//!   the workspace's "format-identical, implementation-separate" rule).
//!   This module is an independent re-derivation from the same public
//!   format documentation.
//! - No rlvm source is vendored or copied.
//!
//! The decoder is deliberately narrow: only the fields needed by the
//! KAIFUU-210 bridge producer (`bytecode_offset`,
//! `bytecode_uncompressed_size`, `bytecode_compressed_size`,
//! `compiler_version`, `kidoku_offset`, `kidoku_count`) are surfaced as
//! named struct fields. Other documented fields are still parsed for
//! shape correctness but are not exposed as the bridge producer does not
//! consume them.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Fixed byte length of the RealLive scene header (`0x1d0` = 464).
pub const SCENE_HEADER_BYTE_LEN: usize = 0x1d0;

/// Typed decode of the 0x1d0-byte RealLive scene header (subset surface).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneHeader {
    /// Compiler version reported at offset `0x04`.
    pub compiler_version: u32,
    /// Scene-blob offset of the kidoku (read-tracking) table.
    pub kidoku_offset: u32,
    /// Number of entries in the kidoku table.
    pub kidoku_count: u32,
    /// Scene-blob offset where the AVG32-compressed bytecode begins.
    pub bytecode_offset: u32,
    /// Size of the bytecode after AVG32 LZSS + XOR decompression.
    pub bytecode_uncompressed_size: u32,
    /// Size of the on-disk compressed bytecode payload.
    pub bytecode_compressed_size: u32,
}

/// Fatal errors raised by [`SceneHeader::parse`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SceneHeaderError {
    /// Input slice is shorter than the fixed header length.
    #[error(
        "kaifuu.reallive.scene_header.truncated: scene blob length {observed_len} is shorter than the fixed {required_len}-byte header"
    )]
    TruncatedHeader {
        observed_len: usize,
        required_len: usize,
    },
}

impl SceneHeader {
    /// Parse the first [`SCENE_HEADER_BYTE_LEN`] bytes of a scene blob.
    pub fn parse(blob_bytes: &[u8]) -> Result<Self, SceneHeaderError> {
        if blob_bytes.len() < SCENE_HEADER_BYTE_LEN {
            return Err(SceneHeaderError::TruncatedHeader {
                observed_len: blob_bytes.len(),
                required_len: SCENE_HEADER_BYTE_LEN,
            });
        }
        let compiler_version = read_u32_le(blob_bytes, 0x04);
        let kidoku_offset = read_u32_le(blob_bytes, 0x08);
        let kidoku_count = read_u32_le(blob_bytes, 0x0c);
        let bytecode_offset = read_u32_le(blob_bytes, 0x20);
        let bytecode_uncompressed_size = read_u32_le(blob_bytes, 0x24);
        let bytecode_compressed_size = read_u32_le(blob_bytes, 0x28);
        Ok(Self {
            compiler_version,
            kidoku_offset,
            kidoku_count,
            bytecode_offset,
            bytecode_uncompressed_size,
            bytecode_compressed_size,
        })
    }
}

fn read_u32_le(bytes: &[u8], offset: usize) -> u32 {
    let mut buf = [0u8; 4];
    buf.copy_from_slice(&bytes[offset..offset + 4]);
    u32::from_le_bytes(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncated_input_is_typed_error_not_panic() {
        let bytes = vec![0u8; SCENE_HEADER_BYTE_LEN - 1];
        let err = SceneHeader::parse(&bytes).expect_err("short input must error");
        assert!(matches!(err, SceneHeaderError::TruncatedHeader { .. }));
    }

    #[test]
    fn empty_input_rejected() {
        let err = SceneHeader::parse(&[]).expect_err("empty input must error");
        match err {
            SceneHeaderError::TruncatedHeader { observed_len, .. } => {
                assert_eq!(observed_len, 0);
            }
        }
    }

    #[test]
    fn synthetic_header_round_trips_through_pinned_offsets() {
        let mut bytes = vec![0u8; SCENE_HEADER_BYTE_LEN];
        // header_size at 0x00 (informational; not surfaced).
        bytes[0..4].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
        // compiler_version at 0x04.
        bytes[4..8].copy_from_slice(&110002u32.to_le_bytes());
        // kidoku_offset at 0x08.
        bytes[8..12].copy_from_slice(&0x1d0u32.to_le_bytes());
        // kidoku_count at 0x0c.
        bytes[12..16].copy_from_slice(&1u32.to_le_bytes());
        // bytecode_offset at 0x20.
        bytes[0x20..0x24].copy_from_slice(&0x1d4u32.to_le_bytes());
        // bytecode_uncompressed_size at 0x24.
        bytes[0x24..0x28].copy_from_slice(&1660u32.to_le_bytes());
        // bytecode_compressed_size at 0x28.
        bytes[0x28..0x2c].copy_from_slice(&1062u32.to_le_bytes());

        let header = SceneHeader::parse(&bytes).expect("synthetic header parses");
        assert_eq!(header.compiler_version, 110002);
        assert_eq!(header.kidoku_offset, 0x1d0);
        assert_eq!(header.kidoku_count, 1);
        assert_eq!(header.bytecode_offset, 0x1d4);
        assert_eq!(header.bytecode_uncompressed_size, 1660);
        assert_eq!(header.bytecode_compressed_size, 1062);
    }
}
