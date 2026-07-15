//! `Scene.pck` container reader — **skeleton** (siglus-05; real reader is
//! siglus-06).
//! Siglus packs every compiled scene into a single `Scene.pck` archive:
//! an `0x5C`-byte fixed header, a `SceneList` / `HeaderPair` directory
//! table, and per-scene payloads that are first constant-256-byte-XOR
//! masked (see [`crate::decrypt`]) and then Siglus-LZSS compressed (see
//! [`crate::decompress`]). This module owns the envelope decode; it does
//! not decrypt or decompress payloads (those are sibling modules).
//! Skeleton status: [`parse_scene_pck`] returns
//! [`SiglusArchiveError::NotImplemented`]. The 0x5C-header + SceneList
//! walk lands in siglus-06 against real bytes.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Byte length of the fixed `Scene.pck` header (documented `0x5C`).
/// Carried as a `const` anchor for the siglus-06 reader; the skeleton
/// does not yet read past it.
pub const SCENE_PCK_HEADER_BYTE_LEN: usize = 0x5C;

/// Index of every scene packed in a `Scene.pck` archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusSceneIndex {
    pub entries: Vec<SiglusSceneEntry>,
}

/// Single packed-scene directory entry recovered from the `Scene.pck`
/// `SceneList` table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusSceneEntry {
    /// Scene index in the `SceneList` table (the stable per-scene id).
    pub scene_id: u32,
    /// Scene name from the packed name table, when present.
    pub scene_name: Option<String>,
    /// Absolute byte offset of the (still-encrypted, still-compressed)
    /// scene payload within `Scene.pck`.
    pub byte_offset: u64,
    /// On-disk byte length of the scene payload.
    pub byte_len: u32,
}

impl SiglusSceneEntry {
    /// Canonical stable string scene-id (`siglus:scene-NNNN`), mirroring
    /// the `kaifuu-reallive` `reallive:scene-NNNN` convention so the
    /// shared bridge/patchback provenance keys are engine-symmetric.
    pub fn scene_id_str(&self) -> String {
        format!("siglus:scene-{:04}", self.scene_id)
    }
}

/// Fatal errors raised by the `Scene.pck` reader.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SiglusArchiveError {
    /// The `Scene.pck` reader is not implemented in the skeleton; the
    /// real 0x5C-header + SceneList walk lands in siglus-06.
    #[error(
        "kaifuu.siglus.archive.not_implemented: Scene.pck container reader is a siglus-05 \
         skeleton stub; the real 0x5C-header + SceneList/HeaderPair walk lands in siglus-06 \
         against a realized plaintext Siglus tree"
    )]
    NotImplemented,
    /// The archive is shorter than the fixed `0x5C`-byte header.
    #[error(
        "kaifuu.siglus.archive.truncated_header: Scene.pck length {observed_len} is shorter than \
         the fixed {SCENE_PCK_HEADER_BYTE_LEN}-byte header"
    )]
    TruncatedHeader { observed_len: usize },
    /// A `SceneList` entry's `(offset, len)` runs past the archive end.
    #[error(
        "kaifuu.siglus.archive.truncated_scene: scene {scene_id} declares (offset={byte_offset}, \
         len={byte_len}) running past archive length {archive_len}"
    )]
    TruncatedScene {
        scene_id: u32,
        byte_offset: u64,
        byte_len: u32,
        archive_len: u64,
    },
}

/// Parse a `Scene.pck` archive envelope into a [`SiglusSceneIndex`].
/// Skeleton: always returns [`SiglusArchiveError::NotImplemented`]. The
/// real implementation (siglus-06) decodes the `0x5C` header and the
/// `SceneList` / `HeaderPair` directory table; it never decrypts or
/// decompresses payloads (those are [`crate::decrypt`] /
/// [`crate::decompress`]).
pub fn parse_scene_pck(_bytes: &[u8]) -> Result<SiglusSceneIndex, SiglusArchiveError> {
    Err(SiglusArchiveError::NotImplemented)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_reader_returns_typed_not_implemented_not_fake_success() {
        // Honest-stub contract: the skeleton must NOT fabricate an empty
        // (or any) scene index. It returns a typed NotImplemented carrying
        // the kaifuu.siglus namespace marker.
        let err = parse_scene_pck(&[0u8; SCENE_PCK_HEADER_BYTE_LEN])
            .expect_err("skeleton must not fabricate a Scene.pck index");
        assert!(matches!(err, SiglusArchiveError::NotImplemented));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }

    #[test]
    fn scene_id_str_is_engine_symmetric_with_reallive() {
        let entry = SiglusSceneEntry {
            scene_id: 7,
            scene_name: None,
            byte_offset: 0,
            byte_len: 0,
        };
        assert_eq!(entry.scene_id_str(), "siglus:scene-0007");
    }
}
