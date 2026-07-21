//! NeXAS `PAC\0` container: header + directory index parse, entry enumeration,
//! and per-entry decompression dispatch.
//! # Clean-room provenance
//! The on-disk format and the two index layouts are ported from GARbro's
//! `ArcFormats/Nexas/ArcPAC.cs` (`PacOpener` + `IndexReader`), MIT-licensed,
//! Copyright (C) 2015 by morkt. Independent Rust reimplementation of that
//! documented format; no GARbro binary is bundled or invoked. See the crate root
//! for the full attribution note.
//! # Format (all little-endian)
//! - magic `"PAC\0"` (`50 41 43 00`) @ `0x00` — the trailing byte is **`0x00`**,
//!   which is exactly what distinguishes a NeXAS archive from a Softpal `"PAC "`
//!   (`50 41 43 20`) archive.
//! - file **count** `u32` @ `0x04`
//! - archive-wide **pack_type** `u32` @ `0x08` ([`Compression`])
//! - the directory **index** is stored one of two ways:
//! - **new layout** (observed on Majikoi): the entry payloads begin right
//!   after the 12-byte header; the index lives at the *tail*. The last `u32`
//!   is the packed index size; the preceding `index_size` bytes are the index
//!   with every byte **bitwise-inverted**, which then Huffman-decodes to
//!   `count * 0x4C` bytes. Each entry is `name[0x40]` + `offset`/`unpacked`/
//!   `size` `u32`s.
//! - **old layout**: the index sits inline at `0x0C`, entries with a `0x20`-
//!   or `0x40`-byte name field followed by the same three `u32`s.
//! - each entry's payload is decompressed per the archive `pack_type`: stored,
//!   LZSS, Huffman, or zlib-Deflate.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{huffman, inflate, lzss};

/// The 4-byte NeXAS archive magic — `"PAC"` followed by a **NUL** byte.
pub const NEXAS_PAC_MAGIC: &[u8; 4] = b"PAC\0";

/// Byte offset of the little-endian `u32` file **count**.
pub const NEXAS_COUNT_OFFSET: usize = 0x04;

/// Byte offset of the little-endian `u32` archive-wide **pack_type**.
pub const NEXAS_PACK_TYPE_OFFSET: usize = 0x08;

/// Length of the fixed 12-byte header (magic + count + pack_type). In the "new"
/// index layout the first entry payload begins here.
pub const NEXAS_HEADER_BYTE_LEN: usize = 0x0C;

/// Per-entry index-record length in the Huffman-decoded "new" index:
/// `name[0x40]` + three `u32`s = `0x4C` (76) bytes.
pub const NEXAS_NEW_INDEX_ENTRY_BYTE_LEN: usize = 0x4C;

/// Name-field length used by the "new" index layout.
pub const NEXAS_NEW_INDEX_NAME_BYTE_LEN: usize = 0x40;

/// The two name-field lengths GARbro tries for the inline "old" index.
pub const NEXAS_OLD_INDEX_NAME_LENGTHS: [usize; 2] = [0x20, 0x40];

/// Sanity bound on the entry count. A file that merely opens with `"PAC\0"`
/// cannot pass with a garbage count.
pub const NEXAS_PAC_MAX_ENTRIES: u32 = 1_000_000;

/// Archive-wide compression mode, from the `u32` @ `0x08`.
/// Mirrors GARbro's `NeXAS.Compression` enum, keeping unrecognised values as
/// [`Compression::Other`] (which GARbro treats as Deflate in its default arm).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Compression {
    /// `0` — payloads are stored verbatim.
    None,
    /// `1` — LZSS ([`crate::lzss`]).
    Lzss,
    /// `2` — canonical-tree Huffman ([`crate::huffman`]).
    Huffman,
    /// `3` — zlib/Deflate ([`crate::inflate`]).
    Deflate,
    /// `4` — Deflate, but an entry whose `size == unpacked` is stored verbatim.
    DeflateOrNone,
    /// Any other value; decompressed as Deflate, matching GARbro's default arm.
    Other(u32),
}

impl Compression {
    /// Decode the raw `pack_type` word.
    pub fn from_u32(value: u32) -> Self {
        match value {
            0 => Compression::None,
            1 => Compression::Lzss,
            2 => Compression::Huffman,
            3 => Compression::Deflate,
            4 => Compression::DeflateOrNone,
            other => Compression::Other(other),
        }
    }

    /// The raw `pack_type` word this variant represents.
    pub fn as_u32(self) -> u32 {
        match self {
            Compression::None => 0,
            Compression::Lzss => 1,
            Compression::Huffman => 2,
            Compression::Deflate => 3,
            Compression::DeflateOrNone => 4,
            Compression::Other(value) => value,
        }
    }

    /// Whether an entry with `(size, unpacked)` is compressed under this mode.
    /// Matches GARbro: packed iff `pack_type!= 0` and (`pack_type!= 4` or the
    /// on-disk and unpacked sizes differ).
    fn entry_is_packed(self, size: u32, unpacked: u32) -> bool {
        match self {
            Compression::None => false,
            Compression::DeflateOrNone => size != unpacked,
            _ => true,
        }
    }
}

/// A single directory entry recovered from the PAC index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PacEntry {
    /// Entry name, decoded from the null-terminated (Shift-JIS) name field.
    pub name: String,
    /// Absolute byte offset of the entry payload within the archive.
    pub offset: u32,
    /// Decompressed byte length.
    pub unpacked_size: u32,
    /// On-disk (possibly compressed) byte length.
    pub size: u32,
    /// Whether this entry's payload is compressed (per the archive pack_type).
    pub is_packed: bool,
}

/// A parsed NeXAS PAC directory plus the archive-wide compression mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PacArchive {
    entries: Vec<PacEntry>,
    pack_type: Compression,
    /// Which index layout the directory was recovered from (diagnostic).
    index_layout: IndexLayout,
    archive_len: usize,
}

/// Which of the two index layouts a [`PacArchive`] was parsed from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexLayout {
    /// Inline index at `0x0C` (GARbro's `ReadOld`).
    Inline,
    /// Tail Huffman-packed, bitwise-inverted index (GARbro's `ReadNew`).
    TailHuffman,
}

/// Fatal errors raised while parsing or extracting from a NeXAS PAC archive.
/// Every display string begins with the `kaifuu.nexas.pac` namespace marker
/// (see [`crate::NEXAS_PAC_ERROR_MARKER`]).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PacError {
    /// The buffer is shorter than the fixed 12-byte header.
    #[error(
        "kaifuu.nexas.pac.truncated_header: archive length {observed_len} is shorter than the \
         fixed {NEXAS_HEADER_BYTE_LEN}-byte header"
    )]
    TruncatedHeader { observed_len: usize },
    /// The first four bytes are not `"PAC\0"`.
    #[error(
        "kaifuu.nexas.pac.bad_magic: expected magic {expected:02X?} (\"PAC\\0\") at offset 0, \
         found {found:02X?}"
    )]
    BadMagic { expected: [u8; 4], found: [u8; 4] },
    /// The count `@0x04` is zero or exceeds [`NEXAS_PAC_MAX_ENTRIES`].
    #[error(
        "kaifuu.nexas.pac.insane_count: file count {count} at offset {NEXAS_COUNT_OFFSET:#x} is \
         zero or exceeds the sanity bound {NEXAS_PAC_MAX_ENTRIES}"
    )]
    InsaneCount { count: u32 },
    /// Neither the inline nor the tail index layout produced a valid directory.
    #[error(
        "kaifuu.nexas.pac.index_unreadable: neither the inline ({NEXAS_HEADER_BYTE_LEN:#x}) nor the \
         tail Huffman index yielded {count} well-formed entries"
    )]
    IndexUnreadable { count: u32 },
    /// The caller passed [`PacArchive::extract`] a buffer whose length differs
    /// from the one the index was validated against.
    #[error(
        "kaifuu.nexas.pac.archive_len_mismatch: extract buffer length {given_len} differs from the \
         {expected_len} the index was validated against"
    )]
    ArchiveLenMismatch {
        given_len: usize,
        expected_len: usize,
    },
    /// An entry's `[offset, offset+size)` payload runs past the archive end.
    #[error(
        "kaifuu.nexas.pac.entry_out_of_bounds: entry {name:?} payload (offset={offset}, \
         size={size}) runs past archive length {archive_len}"
    )]
    EntryOutOfBounds {
        name: String,
        offset: u32,
        size: u32,
        archive_len: usize,
    },
    /// Decompressing an entry failed.
    #[error("kaifuu.nexas.pac.decompress_failed: entry {name:?} ({mode:?}): {source_message}")]
    DecompressFailed {
        name: String,
        mode: Compression,
        source_message: String,
    },
    /// A decompressed entry did not produce exactly its declared unpacked size.
    #[error(
        "kaifuu.nexas.pac.unpacked_size_mismatch: entry {name:?} decompressed to {produced} bytes \
         but the index declared {expected}"
    )]
    UnpackedSizeMismatch {
        name: String,
        produced: usize,
        expected: usize,
    },
}

fn read_u32_le(bytes: &[u8], off: usize) -> Option<u32> {
    let slice = bytes.get(off..off + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// Decode a fixed-width name field: bytes up to the first NUL (or the whole
/// field), Shift-JIS decoded, required non-empty and not all-whitespace (mirrors
/// GARbro's `string.IsNullOrWhiteSpace` guard). Returns `None` to reject the
/// current index layout, never panicking.
fn decode_name(field: &[u8]) -> Option<String> {
    let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    let name_bytes = &field[..end];
    if name_bytes.is_empty() {
        return None;
    }
    let (decoded, _, had_errors) = encoding_rs::SHIFT_JIS.decode(name_bytes);
    if had_errors {
        return None;
    }
    if decoded.trim().is_empty() {
        return None;
    }
    Some(decoded.into_owned())
}

/// Read `count` entries out of `index` (a directory buffer) using `name_length`
/// name fields, validating each payload placement against `archive_len`.
/// Returns `None` on any malformed record so the caller can try another layout.
fn read_entries(
    index: &[u8],
    count: usize,
    name_length: usize,
    pack_type: Compression,
    archive_len: usize,
) -> Option<Vec<PacEntry>> {
    let record_len = name_length + 12;
    let mut entries = Vec::with_capacity(count);
    for i in 0..count {
        let base = i.checked_mul(record_len)?;
        let name_field = index.get(base..base + name_length)?;
        let name = decode_name(name_field)?;
        let offset = read_u32_le(index, base + name_length)?;
        let unpacked_size = read_u32_le(index, base + name_length + 4)?;
        let size = read_u32_le(index, base + name_length + 8)?;

        // CheckPlacement: payload must lie within the archive.
        let end = (offset as u64).checked_add(size as u64)?;
        if end > archive_len as u64 {
            return None;
        }
        let is_packed = pack_type.entry_is_packed(size, unpacked_size);
        entries.push(PacEntry {
            name,
            offset,
            unpacked_size,
            size,
            is_packed,
        });
    }
    Some(entries)
}

/// Attempt GARbro's inline "old" index at `0x0C`, trying both name lengths.
fn read_inline_index(bytes: &[u8], count: usize, pack_type: Compression) -> Option<Vec<PacEntry>> {
    let index = bytes.get(NEXAS_HEADER_BYTE_LEN..)?;
    for &name_length in &NEXAS_OLD_INDEX_NAME_LENGTHS {
        if let Some(entries) = read_entries(index, count, name_length, pack_type, bytes.len()) {
            return Some(entries);
        }
    }
    None
}

/// Attempt GARbro's tail Huffman "new" index.
fn read_tail_index(bytes: &[u8], count: usize, pack_type: Compression) -> Option<Vec<PacEntry>> {
    let archive_len = bytes.len();
    if archive_len < 4 {
        return None;
    }
    let index_size = read_u32_le(bytes, archive_len - 4)? as usize;
    let unpacked_size = count.checked_mul(NEXAS_NEW_INDEX_ENTRY_BYTE_LEN)?;
    if index_size >= archive_len || index_size > unpacked_size.checked_mul(2)? {
        return None;
    }
    let packed_start = archive_len.checked_sub(4)?.checked_sub(index_size)?;
    let packed = bytes.get(packed_start..archive_len - 4)?;
    // Every byte of the stored index is bitwise-inverted before Huffman decode.
    let inverted: Vec<u8> = packed.iter().map(|&b| !b).collect();
    let index = huffman::decode(&inverted, unpacked_size).ok()?;
    read_entries(
        &index,
        count,
        NEXAS_NEW_INDEX_NAME_BYTE_LEN,
        pack_type,
        archive_len,
    )
}

impl PacArchive {
    /// Parse a NeXAS PAC archive's header + directory index from `bytes`.
    /// Tries the inline index first (GARbro's `ReadOld`), then the tail Huffman
    /// index (`ReadNew`), exactly as GARbro does. Returns a typed [`PacError`]
    /// on malformed input; never panics.
    /// # Errors
    /// [`PacError::TruncatedHeader`], [`PacError::BadMagic`],
    /// [`PacError::InsaneCount`], or [`PacError::IndexUnreadable`] when no layout
    /// yields a well-formed directory.
    pub fn parse(bytes: &[u8]) -> Result<Self, PacError> {
        let archive_len = bytes.len();
        if archive_len < NEXAS_HEADER_BYTE_LEN {
            return Err(PacError::TruncatedHeader {
                observed_len: archive_len,
            });
        }
        let magic: [u8; 4] = [bytes[0], bytes[1], bytes[2], bytes[3]];
        if &magic != NEXAS_PAC_MAGIC {
            return Err(PacError::BadMagic {
                expected: *NEXAS_PAC_MAGIC,
                found: magic,
            });
        }
        let count = read_u32_le(bytes, NEXAS_COUNT_OFFSET).expect("header length checked");
        if count == 0 || count > NEXAS_PAC_MAX_ENTRIES {
            return Err(PacError::InsaneCount { count });
        }
        let pack_type =
            Compression::from_u32(read_u32_le(bytes, NEXAS_PACK_TYPE_OFFSET).expect("checked"));

        let (entries, index_layout) = match read_inline_index(bytes, count as usize, pack_type) {
            Some(entries) => (entries, IndexLayout::Inline),
            None => match read_tail_index(bytes, count as usize, pack_type) {
                Some(entries) => (entries, IndexLayout::TailHuffman),
                None => return Err(PacError::IndexUnreadable { count }),
            },
        };

        Ok(Self {
            entries,
            pack_type,
            index_layout,
            archive_len,
        })
    }

    /// The validated directory entries, in on-disk index order.
    pub fn entries(&self) -> &[PacEntry] {
        &self.entries
    }

    /// Number of entries in the archive.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the archive has zero entries. (A valid NeXAS PAC always has at
    /// least one; provided for symmetry.)
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The archive-wide compression mode.
    pub fn pack_type(&self) -> Compression {
        self.pack_type
    }

    /// Which index layout the directory was recovered from.
    pub fn index_layout(&self) -> IndexLayout {
        self.index_layout
    }

    /// The first entry whose name equals `name` (case-sensitive).
    pub fn find(&self, name: &str) -> Option<&PacEntry> {
        self.entries.iter().find(|e| e.name == name)
    }

    /// Extract and (if packed) decompress an entry's payload from `bytes` — the
    /// same buffer the index was parsed from.
    /// # Errors
    /// [`PacError::ArchiveLenMismatch`] for a different buffer,
    /// [`PacError::EntryOutOfBounds`] if the payload runs past `bytes`,
    /// [`PacError::DecompressFailed`] on a codec error, and
    /// [`PacError::UnpackedSizeMismatch`] if a decompressed entry does not
    /// produce exactly its declared unpacked size.
    pub fn extract(&self, bytes: &[u8], entry: &PacEntry) -> Result<Vec<u8>, PacError> {
        if bytes.len() != self.archive_len {
            return Err(PacError::ArchiveLenMismatch {
                given_len: bytes.len(),
                expected_len: self.archive_len,
            });
        }
        let start = entry.offset as usize;
        let end = start
            .checked_add(entry.size as usize)
            .filter(|&e| e <= bytes.len())
            .ok_or_else(|| PacError::EntryOutOfBounds {
                name: entry.name.clone(),
                offset: entry.offset,
                size: entry.size,
                archive_len: bytes.len(),
            })?;
        let raw = &bytes[start..end];

        if !entry.is_packed {
            return Ok(raw.to_vec());
        }

        let unpacked = entry.unpacked_size as usize;
        let decoded = match self.pack_type {
            Compression::None => raw.to_vec(),
            Compression::Lzss => lzss::decode(raw, unpacked),
            Compression::Huffman => {
                huffman::decode(raw, unpacked).map_err(|e| PacError::DecompressFailed {
                    name: entry.name.clone(),
                    mode: self.pack_type,
                    source_message: e.to_string(),
                })?
            }
            Compression::Deflate | Compression::DeflateOrNone | Compression::Other(_) => {
                inflate::zlib_decompress(raw).map_err(|e| PacError::DecompressFailed {
                    name: entry.name.clone(),
                    mode: self.pack_type,
                    source_message: e.to_string(),
                })?
            }
        };
        if decoded.len() != unpacked {
            return Err(PacError::UnpackedSizeMismatch {
                name: entry.name.clone(),
                produced: decoded.len(),
                expected: unpacked,
            });
        }
        Ok(decoded)
    }
}

#[cfg(test)]
#[path = "archive_tests.rs"]
mod tests;
