//! `Scene.pck` container reader.
//! Siglus packs every compiled scene into a single `Scene.pck` archive:
//! a fixed **`0x5C`-byte header** — a table of `(offset, count)` `HeaderPair`
//! records pointing at the global-variable, global-function and **SceneList**
//! directories — followed by the per-scene payloads. This module owns the
//! envelope decode only: it walks the header + SceneList and yields each
//! scene's on-disk `(offset, length)` and packed name. It does **not** decrypt
//! or decompress payloads (those are [`crate::decrypt`] / [`crate::decompress`],
//! driven by [`crate::scene_decode`]).
//!
//! # Header layout (little-endian `i32`, mirrors the RealLive envelope idiom)
//!
//! Field 0 is `header_size` (`0x5C`). The remaining fields are `(offset, count)`
//! pairs. The SceneList uses parallel tables: `scn_name_index_list`
//! (`count` × `(char_offset, char_count)`) into the UTF-16LE `scn_name_list`
//! character buffer holds the packed scene names, and `scn_data_index_list`
//! (`count` × `(data_offset, data_len)`) into the `scn_data_list` payload region
//! points at each scene's still-encrypted, still-LZSS chunk at absolute offset
//! `scn_data_list_ofs + data_offset`.
//!
//! The `extra_key_use` field records whether the payloads were masked with the
//! per-game second-layer key (see [`crate::decrypt`]); `original_source_header`
//! being non-zero marks the packed (encrypted + compressed) build. Layout
//! re-derived from public Siglus format documentation and re-tested against real
//! title bytes (see the crate clean-room note).

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Byte length of the fixed `Scene.pck` header (`0x5C`).
pub const SCENE_PCK_HEADER_BYTE_LEN: usize = 0x5C;

/// Number of little-endian `i32` fields in the fixed header.
const HEADER_FIELD_COUNT: usize = SCENE_PCK_HEADER_BYTE_LEN / 4;

/// The fixed `0x5C` header always carries every SceneList field index used
/// below (compile-time guard against a mistyped field constant).
const _: () = assert!(HEADER_FIELD_COUNT > field::SCN_DATA_EXE_ANGOU_MOD);

/// Optional 8-byte signature that precedes the header in newer builds.
const PACK_SCN_SIGNATURE: &[u8; 8] = b"pack_scn";

/// A `(offset, count)` header directory record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HeaderPair {
    offset: u32,
    count: u32,
}

/// Index of every scene packed in a `Scene.pck` archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusSceneIndex {
    pub entries: Vec<SiglusSceneEntry>,
    /// Whether the packed scene payloads were masked with the per-game
    /// second-layer key (the header `extra_key_use` flag). When set, decoding a
    /// payload requires the recovered key material.
    pub extra_key_use: bool,
    /// Absolute byte offset where the scene-data payload region begins.
    pub scene_data_region_offset: u64,
}

/// Single packed-scene directory entry recovered from the `Scene.pck`
/// `SceneList`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusSceneEntry {
    /// Scene index in the `SceneList` (the stable per-scene id).
    pub scene_id: u32,
    /// Scene name from the packed UTF-16LE name table, when present.
    pub scene_name: Option<String>,
    /// Absolute byte offset of the (still-encrypted, still-compressed) scene
    /// payload within `Scene.pck`.
    pub byte_offset: u64,
    /// On-disk byte length of the scene payload.
    pub byte_len: u32,
}

impl SiglusSceneEntry {
    /// Canonical stable string scene-id (`siglus:scene-NNNN`), mirroring the
    /// `kaifuu-reallive` `reallive:scene-NNNN` convention so the shared
    /// bridge/patchback provenance keys are engine-symmetric.
    pub fn scene_id_str(&self) -> String {
        format!("siglus:scene-{:04}", self.scene_id)
    }
}

/// Fatal errors raised by the `Scene.pck` reader.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SiglusArchiveError {
    /// The archive is shorter than the fixed `0x5C`-byte header.
    #[error(
        "kaifuu.siglus.archive.truncated_header: Scene.pck length {observed_len} is shorter than \
         the fixed {SCENE_PCK_HEADER_BYTE_LEN}-byte header"
    )]
    TruncatedHeader { observed_len: usize },
    /// The header did not begin with the expected `header_size` field.
    #[error(
        "kaifuu.siglus.archive.bad_header_size: expected header_size {SCENE_PCK_HEADER_BYTE_LEN}, \
         got {observed}"
    )]
    BadHeaderSize { observed: i64 },
    /// A directory table declares a range past the archive end.
    #[error(
        "kaifuu.siglus.archive.truncated_directory: {table} table (offset={offset}, count={count}) \
         runs past archive length {archive_len}"
    )]
    TruncatedDirectory {
        table: &'static str,
        offset: u64,
        count: u64,
        archive_len: u64,
    },
    /// The parallel SceneList tables disagree on scene count.
    #[error(
        "kaifuu.siglus.archive.scene_count_mismatch: name count {name_count} != data count \
         {data_count}"
    )]
    SceneCountMismatch { name_count: u32, data_count: u32 },
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

/// Fixed-header field indices (post-signature), by name.
mod field {
    pub const SCN_NAME_INDEX_LIST_OFS: usize = 13;
    pub const SCN_NAME_INDEX_CNT: usize = 14;
    pub const SCN_NAME_LIST_OFS: usize = 15;
    pub const SCN_NAME_CNT: usize = 16;
    pub const SCN_DATA_INDEX_LIST_OFS: usize = 17;
    pub const SCN_DATA_INDEX_CNT: usize = 18;
    pub const SCN_DATA_LIST_OFS: usize = 19;
    pub const SCN_DATA_CNT: usize = 20;
    pub const SCN_DATA_EXE_ANGOU_MOD: usize = 21;
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes
        .get(offset..offset + 4)
        .map(|slice| u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_pairs(
    bytes: &[u8],
    list_offset: u32,
    count: u32,
    table: &'static str,
) -> Result<Vec<HeaderPair>, SiglusArchiveError> {
    let archive_len = bytes.len() as u64;
    let base = u64::from(list_offset);
    let span = u64::from(count).saturating_mul(8);
    if base.saturating_add(span) > archive_len {
        return Err(SiglusArchiveError::TruncatedDirectory {
            table,
            offset: base,
            count: u64::from(count),
            archive_len,
        });
    }
    let mut pairs = Vec::with_capacity(count as usize);
    for i in 0..count as usize {
        let at = list_offset as usize + i * 8;
        let offset = read_u32_le(bytes, at).expect("bounds pre-checked");
        let value = read_u32_le(bytes, at + 4).expect("bounds pre-checked");
        pairs.push(HeaderPair {
            offset,
            count: value,
        });
    }
    Ok(pairs)
}

fn read_name(bytes: &[u8], name_list_ofs: u32, entry: HeaderPair) -> Option<String> {
    // Name entries index the UTF-16LE character buffer: `offset` is a char
    // offset, `count` a char length.
    let byte_off = (name_list_ofs as usize).checked_add((entry.offset as usize).checked_mul(2)?)?;
    let byte_end = byte_off.checked_add((entry.count as usize).checked_mul(2)?)?;
    let slice = bytes.get(byte_off..byte_end)?;
    let mut units = Vec::with_capacity(slice.len() / 2);
    for pair in slice.chunks_exact(2) {
        let unit = u16::from_le_bytes([pair[0], pair[1]]);
        if unit == 0 {
            break;
        }
        units.push(unit);
    }
    if units.is_empty() {
        return None;
    }
    Some(String::from_utf16_lossy(&units))
}

/// Parse a `Scene.pck` archive envelope into a [`SiglusSceneIndex`].
/// Walks the `0x5C` header and the parallel `SceneList` name/data tables. It
/// never decrypts or decompresses payloads. Every out-of-bounds directory or
/// scene range is a typed error before any partial index is returned.
pub fn parse_scene_pck(bytes: &[u8]) -> Result<SiglusSceneIndex, SiglusArchiveError> {
    let has_signature = bytes.len() >= 8 && &bytes[0..8] == PACK_SCN_SIGNATURE;
    let header_base = if has_signature { 8 } else { 0 };

    if bytes.len() < header_base + SCENE_PCK_HEADER_BYTE_LEN {
        return Err(SiglusArchiveError::TruncatedHeader {
            observed_len: bytes.len(),
        });
    }

    let field = |index: usize| -> u32 {
        read_u32_le(bytes, header_base + index * 4).expect("header bounds pre-checked")
    };

    let header_size = field(0);
    if header_size as usize != SCENE_PCK_HEADER_BYTE_LEN {
        return Err(SiglusArchiveError::BadHeaderSize {
            observed: i64::from(field(0) as i32),
        });
    }

    let name_index_pairs = read_pairs(
        bytes,
        field(field::SCN_NAME_INDEX_LIST_OFS),
        field(field::SCN_NAME_INDEX_CNT),
        "scene_name_index",
    )?;
    let data_index_pairs = read_pairs(
        bytes,
        field(field::SCN_DATA_INDEX_LIST_OFS),
        field(field::SCN_DATA_INDEX_CNT),
        "scene_data_index",
    )?;

    let name_count = field(field::SCN_NAME_CNT);
    let data_count = field(field::SCN_DATA_CNT);
    if name_count != data_count {
        return Err(SiglusArchiveError::SceneCountMismatch {
            name_count,
            data_count,
        });
    }

    let name_list_ofs = field(field::SCN_NAME_LIST_OFS);
    let data_list_ofs = field(field::SCN_DATA_LIST_OFS);
    let extra_key_use = field(field::SCN_DATA_EXE_ANGOU_MOD) != 0;
    let archive_len = bytes.len() as u64;

    let mut entries = Vec::with_capacity(data_index_pairs.len());
    for (scene_id, data_pair) in data_index_pairs.iter().enumerate() {
        let scene_id = scene_id as u32;
        let byte_offset = u64::from(data_list_ofs) + u64::from(data_pair.offset);
        let byte_len = data_pair.count;
        if byte_offset.saturating_add(u64::from(byte_len)) > archive_len {
            return Err(SiglusArchiveError::TruncatedScene {
                scene_id,
                byte_offset,
                byte_len,
                archive_len,
            });
        }
        let scene_name = name_index_pairs
            .get(scene_id as usize)
            .and_then(|pair| read_name(bytes, name_list_ofs, *pair));
        entries.push(SiglusSceneEntry {
            scene_id,
            scene_name,
            byte_offset,
            byte_len,
        });
    }

    Ok(SiglusSceneIndex {
        entries,
        extra_key_use,
        scene_data_region_offset: u64::from(data_list_ofs),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncated_archive_is_typed_error() {
        let err = parse_scene_pck(&[0u8; 8]).expect_err("too short for header");
        assert!(matches!(err, SiglusArchiveError::TruncatedHeader { .. }));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }

    #[test]
    fn wrong_header_size_is_rejected() {
        let mut bytes = vec![0u8; SCENE_PCK_HEADER_BYTE_LEN];
        bytes[0] = 0x40; // header_size 0x40 != 0x5C
        let err = parse_scene_pck(&bytes).expect_err("bad header size");
        assert!(matches!(err, SiglusArchiveError::BadHeaderSize { .. }));
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

    #[test]
    fn walks_a_minimal_two_scene_archive() {
        // Build a tiny Scene.pck: header + one name-index pair + name buffer +
        // one data-index pair + a 3-byte scene payload.
        let header_len = SCENE_PCK_HEADER_BYTE_LEN;
        let name_index_ofs = header_len; // 0x5C
        let name_list_ofs = name_index_ofs + 8; // one (char_off, char_cnt) pair
        // name "ab" -> 2 UTF-16LE units = 4 bytes
        let data_index_ofs = name_list_ofs + 4;
        let data_list_ofs = data_index_ofs + 8; // one (data_off, data_len) pair
        let total = data_list_ofs + 3;
        let mut bytes = vec![0u8; total];
        let put = |b: &mut [u8], idx: usize, v: u32| {
            b[idx * 4..idx * 4 + 4].copy_from_slice(&v.to_le_bytes());
        };
        put(&mut bytes, 0, header_len as u32);
        put(
            &mut bytes,
            field::SCN_NAME_INDEX_LIST_OFS,
            name_index_ofs as u32,
        );
        put(&mut bytes, field::SCN_NAME_INDEX_CNT, 1);
        put(&mut bytes, field::SCN_NAME_LIST_OFS, name_list_ofs as u32);
        put(&mut bytes, field::SCN_NAME_CNT, 1);
        put(
            &mut bytes,
            field::SCN_DATA_INDEX_LIST_OFS,
            data_index_ofs as u32,
        );
        put(&mut bytes, field::SCN_DATA_INDEX_CNT, 1);
        put(&mut bytes, field::SCN_DATA_LIST_OFS, data_list_ofs as u32);
        put(&mut bytes, field::SCN_DATA_CNT, 1);
        put(&mut bytes, field::SCN_DATA_EXE_ANGOU_MOD, 1);
        // name-index pair: char_offset=0, char_count=2
        bytes[name_index_ofs + 4..name_index_ofs + 8].copy_from_slice(&2u32.to_le_bytes());
        // name buffer "ab" UTF-16LE
        bytes[name_list_ofs..name_list_ofs + 4].copy_from_slice(&[b'a', 0, b'b', 0]);
        // data-index pair: data_offset=0, data_len=3
        bytes[data_index_ofs + 4..data_index_ofs + 8].copy_from_slice(&3u32.to_le_bytes());

        let index = parse_scene_pck(&bytes).expect("minimal archive parses");
        assert_eq!(index.entries.len(), 1);
        assert!(index.extra_key_use);
        assert_eq!(index.scene_data_region_offset, data_list_ofs as u64);
        let entry = &index.entries[0];
        assert_eq!(entry.scene_name.as_deref(), Some("ab"));
        assert_eq!(entry.byte_offset, data_list_ofs as u64);
        assert_eq!(entry.byte_len, 3);
    }
}
