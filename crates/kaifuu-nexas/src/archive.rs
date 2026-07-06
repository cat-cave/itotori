//! NeXAS `PAC\0` container: header + directory index parse, entry enumeration,
//! and per-entry decompression dispatch.
//!
//! # Clean-room provenance
//!
//! The on-disk format and the two index layouts are ported from GARbro's
//! `ArcFormats/Nexas/ArcPAC.cs` (`PacOpener` + `IndexReader`), MIT-licensed,
//! Copyright (C) 2015 by morkt. Independent Rust reimplementation of that
//! documented format; no GARbro binary is bundled or invoked. See the crate root
//! for the full attribution note.
//!
//! # Format (all little-endian)
//!
//! - magic `"PAC\0"` (`50 41 43 00`) @ `0x00` — the trailing byte is **`0x00`**,
//!   which is exactly what distinguishes a NeXAS archive from a Softpal `"PAC "`
//!   (`50 41 43 20`) archive.
//! - file **count** `u32` @ `0x04`
//! - archive-wide **pack_type** `u32` @ `0x08` ([`Compression`])
//! - the directory **index** is stored one of two ways:
//!   - **new layout** (observed on Majikoi): the entry payloads begin right
//!     after the 12-byte header; the index lives at the *tail*. The last `u32`
//!     is the packed index size; the preceding `index_size` bytes are the index
//!     with every byte **bitwise-inverted**, which then Huffman-decodes to
//!     `count * 0x4C` bytes. Each entry is `name[0x40]` + `offset`/`unpacked`/
//!     `size` `u32`s.
//!   - **old layout**: the index sits inline at `0x0C`, entries with a `0x20`-
//!     or `0x40`-byte name field followed by the same three `u32`s.
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
///
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
    ///
    /// Matches GARbro: packed iff `pack_type != 0` and (`pack_type != 4` or the
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
///
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
    ///
    /// Tries the inline index first (GARbro's `ReadOld`), then the tail Huffman
    /// index (`ReadNew`), exactly as GARbro does. Returns a typed [`PacError`]
    /// on malformed input; never panics.
    ///
    /// # Errors
    ///
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
    ///
    /// # Errors
    ///
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
mod tests {
    use super::*;

    // ---- synthetic fixture builders -------------------------------------
    // No real (copyrighted) bytes: every fixture is assembled here so the happy
    // path, both index layouts, and every pack_type variant are exercised
    // deterministically.

    /// MSB-first bit writer matching `huffman`'s reader, plus a complete
    /// depth-8 Huffman tree encoder (every byte -> its 8-bit path). Verbose on
    /// the wire but a valid NeXAS Huffman stream the decoder accepts.
    struct BitWriter {
        bytes: Vec<u8>,
        bit_pos: usize,
    }
    impl BitWriter {
        fn new() -> Self {
            Self {
                bytes: Vec::new(),
                bit_pos: 0,
            }
        }
        fn put_bit(&mut self, bit: u32) {
            if self.bit_pos.is_multiple_of(8) {
                self.bytes.push(0);
            }
            if bit & 1 != 0 {
                let byte = self.bytes.len() - 1;
                let shift = 7 - (self.bit_pos & 7);
                self.bytes[byte] |= 1 << shift;
            }
            self.bit_pos += 1;
        }
        fn put_bits(&mut self, value: u32, count: u32) {
            for i in (0..count).rev() {
                self.put_bit((value >> i) & 1);
            }
        }
    }

    // Emit a balanced Huffman tree over only the DISTINCT symbols present, in
    // GARbro pre-order (1=internal then left,right; 0=leaf then 8-bit symbol),
    // recording each symbol's code path. Keeps the packed index comfortably
    // under GARbro's `index_size <= unpacked*2` sanity bound (a full 256-leaf
    // tree would blow it for small indices).
    fn huff_emit(
        w: &mut BitWriter,
        symbols: &[u8],
        code: u32,
        len: u32,
        codes: &mut std::collections::HashMap<u8, (u32, u32)>,
    ) {
        if symbols.len() == 1 {
            w.put_bit(0);
            w.put_bits(symbols[0] as u32, 8);
            codes.insert(symbols[0], (code, len));
            return;
        }
        w.put_bit(1);
        let mid = symbols.len() / 2;
        huff_emit(w, &symbols[..mid], code << 1, len + 1, codes);
        huff_emit(w, &symbols[mid..], (code << 1) | 1, len + 1, codes);
    }

    fn huffman_encode(data: &[u8]) -> Vec<u8> {
        let mut distinct: Vec<u8> = data.to_vec();
        distinct.sort_unstable();
        distinct.dedup();
        if distinct.is_empty() {
            distinct.push(0);
        }
        let mut w = BitWriter::new();
        let mut codes = std::collections::HashMap::new();
        huff_emit(&mut w, &distinct, 0, 0, &mut codes);
        for &b in data {
            let (code, len) = codes[&b];
            w.put_bits(code, len);
        }
        w.bytes
    }

    /// LZSS encode as all-literals (control bytes all-ones for full chunks).
    fn lzss_encode_all_literals(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for chunk in data.chunks(8) {
            let ctl = if chunk.len() == 8 {
                0xFF
            } else {
                (1u16 << chunk.len()) as u8 - 1
            };
            out.push(ctl);
            out.extend_from_slice(chunk);
        }
        out
    }

    /// zlib stream wrapping a single stored deflate block (RFC 1950/1951).
    fn zlib_stored(payload: &[u8]) -> Vec<u8> {
        fn adler32(data: &[u8]) -> u32 {
            const MOD: u32 = 65521;
            let (mut a, mut b) = (1u32, 0u32);
            for &byte in data {
                a = (a + byte as u32) % MOD;
                b = (b + a) % MOD;
            }
            (b << 16) | a
        }
        let mut out = vec![0x78, 0x01, 0x01];
        let len = payload.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(payload);
        out.extend_from_slice(&adler32(payload).to_be_bytes());
        out
    }

    /// Encode a single entry payload under `pack_type`, returning the on-disk
    /// (possibly compressed) bytes.
    fn encode_payload(pack_type: Compression, payload: &[u8]) -> Vec<u8> {
        match pack_type {
            Compression::None => payload.to_vec(),
            Compression::Lzss => lzss_encode_all_literals(payload),
            Compression::Huffman => huffman_encode(payload),
            Compression::Deflate | Compression::DeflateOrNone | Compression::Other(_) => {
                zlib_stored(payload)
            }
        }
    }

    /// Build a NeXAS PAC with the tail Huffman ("new") index layout.
    fn build_pac_tail(pack_type: Compression, files: &[(&str, &[u8])]) -> Vec<u8> {
        let count = files.len();
        // Entry payloads begin right after the 12-byte header.
        let mut buf = Vec::new();
        buf.extend_from_slice(NEXAS_PAC_MAGIC);
        buf.extend_from_slice(&(count as u32).to_le_bytes());
        buf.extend_from_slice(&pack_type.as_u32().to_le_bytes());

        let mut records = Vec::new();
        for (name, payload) in files {
            let on_disk = encode_payload(pack_type, payload);
            let offset = buf.len() as u32;
            let size = on_disk.len() as u32;
            let unpacked = payload.len() as u32;
            buf.extend_from_slice(&on_disk);

            let mut name_field = vec![0u8; NEXAS_NEW_INDEX_NAME_BYTE_LEN];
            let nb = name.as_bytes();
            name_field[..nb.len()].copy_from_slice(nb);
            records.extend_from_slice(&name_field);
            records.extend_from_slice(&offset.to_le_bytes());
            records.extend_from_slice(&unpacked.to_le_bytes());
            records.extend_from_slice(&size.to_le_bytes());
        }
        // Tail index: huffman-encode the records, invert every byte, then append
        // the 4-byte packed size.
        let packed = huffman_encode(&records);
        let inverted: Vec<u8> = packed.iter().map(|&b| !b).collect();
        buf.extend_from_slice(&inverted);
        buf.extend_from_slice(&(inverted.len() as u32).to_le_bytes());
        buf
    }

    /// Build a NeXAS PAC with the inline ("old") index at `0x0C`.
    fn build_pac_inline(
        pack_type: Compression,
        name_length: usize,
        files: &[(&str, &[u8])],
    ) -> Vec<u8> {
        let count = files.len();
        let record_len = name_length + 12;
        let index_end = NEXAS_HEADER_BYTE_LEN + count * record_len;

        let mut payload_region = Vec::new();
        let mut records = Vec::new();
        for (name, payload) in files {
            let on_disk = encode_payload(pack_type, payload);
            let offset = (index_end + payload_region.len()) as u32;
            let size = on_disk.len() as u32;
            let unpacked = payload.len() as u32;
            payload_region.extend_from_slice(&on_disk);

            let mut name_field = vec![0u8; name_length];
            let nb = name.as_bytes();
            name_field[..nb.len()].copy_from_slice(nb);
            records.extend_from_slice(&name_field);
            records.extend_from_slice(&offset.to_le_bytes());
            records.extend_from_slice(&unpacked.to_le_bytes());
            records.extend_from_slice(&size.to_le_bytes());
        }

        let mut buf = Vec::new();
        buf.extend_from_slice(NEXAS_PAC_MAGIC);
        buf.extend_from_slice(&(count as u32).to_le_bytes());
        buf.extend_from_slice(&pack_type.as_u32().to_le_bytes());
        buf.extend_from_slice(&records);
        buf.extend_from_slice(&payload_region);
        buf
    }

    const SAMPLE: &[(&str, &[u8])] = &[
        ("system.dat", b"NeXAS system payload bytes"),
        (
            "script0001.bin",
            b"another entry, longer payload for coverage 0123456789",
        ),
        (
            "face_a.grp",
            &[0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x11, 0x22, 0x33],
        ),
    ];

    fn assert_round_trip(pac: &[u8], files: &[(&str, &[u8])], layout: IndexLayout) {
        let arc = PacArchive::parse(pac).expect("well-formed synthetic PAC must parse");
        assert_eq!(arc.len(), files.len());
        assert_eq!(arc.index_layout(), layout);
        let names: Vec<&str> = arc.entries().iter().map(|e| e.name.as_str()).collect();
        let want: Vec<&str> = files.iter().map(|(n, _)| *n).collect();
        assert_eq!(names, want);
        for (name, payload) in files {
            let entry = arc.find(name).expect("entry present");
            assert_eq!(entry.unpacked_size as usize, payload.len());
            let got = arc.extract(pac, entry).expect("extract + decompress");
            assert_eq!(&got, payload, "round-trip bytes for {name}");
        }
    }

    #[test]
    fn tail_index_stored_round_trips() {
        let pac = build_pac_tail(Compression::None, SAMPLE);
        assert_round_trip(&pac, SAMPLE, IndexLayout::TailHuffman);
    }

    #[test]
    fn tail_index_lzss_round_trips() {
        let pac = build_pac_tail(Compression::Lzss, SAMPLE);
        assert_round_trip(&pac, SAMPLE, IndexLayout::TailHuffman);
    }

    #[test]
    fn tail_index_huffman_round_trips() {
        let pac = build_pac_tail(Compression::Huffman, SAMPLE);
        assert_round_trip(&pac, SAMPLE, IndexLayout::TailHuffman);
    }

    #[test]
    fn tail_index_deflate_round_trips() {
        // Mirrors Majikoi: pack_type=3, tail Huffman index, zlib entries.
        let pac = build_pac_tail(Compression::Deflate, SAMPLE);
        assert_round_trip(&pac, SAMPLE, IndexLayout::TailHuffman);
    }

    #[test]
    fn deflate_or_none_stores_equal_size_entries() {
        // pack_type=4: an entry whose size == unpacked is stored verbatim.
        let files: &[(&str, &[u8])] = &[("verbatim.bin", b"stored under mode 4")];
        // Build tail index but force the payload stored (size == unpacked).
        let count = files.len();
        let mut buf = Vec::new();
        buf.extend_from_slice(NEXAS_PAC_MAGIC);
        buf.extend_from_slice(&(count as u32).to_le_bytes());
        buf.extend_from_slice(&Compression::DeflateOrNone.as_u32().to_le_bytes());
        let payload = files[0].1;
        let offset = buf.len() as u32;
        buf.extend_from_slice(payload);
        let mut records = vec![0u8; NEXAS_NEW_INDEX_NAME_BYTE_LEN];
        records[..files[0].0.len()].copy_from_slice(files[0].0.as_bytes());
        records.extend_from_slice(&offset.to_le_bytes());
        records.extend_from_slice(&(payload.len() as u32).to_le_bytes()); // unpacked
        records.extend_from_slice(&(payload.len() as u32).to_le_bytes()); // size == unpacked
        let packed = huffman_encode(&records);
        let inverted: Vec<u8> = packed.iter().map(|&b| !b).collect();
        buf.extend_from_slice(&inverted);
        buf.extend_from_slice(&(inverted.len() as u32).to_le_bytes());

        let arc = PacArchive::parse(&buf).expect("parse");
        let entry = &arc.entries()[0];
        assert!(!entry.is_packed, "mode 4 with size==unpacked is stored");
        let got = arc.extract(&buf, entry).expect("extract");
        assert_eq!(got, payload);
    }

    #[test]
    fn inline_index_name20_round_trips() {
        let pac = build_pac_inline(Compression::None, 0x20, SAMPLE);
        assert_round_trip(&pac, SAMPLE, IndexLayout::Inline);
    }

    #[test]
    fn inline_index_name40_deflate_round_trips() {
        // Force the 0x20 attempt to fail (a name longer than 0x20) so the parser
        // falls through to the 0x40 name-length attempt.
        let files: &[(&str, &[u8])] = &[(
            "a_rather_long_entry_name_over_thirty_two_bytes.bin",
            b"payload",
        )];
        let pac = build_pac_inline(Compression::Deflate, 0x40, files);
        assert_round_trip(&pac, files, IndexLayout::Inline);
    }

    // ---- magic-byte discrimination: NeXAS vs Softpal --------------------

    #[test]
    fn rejects_softpal_pac_space_magic() {
        // Softpal magic is "PAC " (0x20 at byte 3). It must NOT parse as NeXAS.
        let mut pac = build_pac_tail(Compression::Deflate, SAMPLE);
        pac[3] = 0x20; // "PAC " instead of "PAC\0"
        let err = PacArchive::parse(&pac).expect_err("Softpal magic must be rejected");
        assert!(matches!(err, PacError::BadMagic { .. }));
    }

    #[test]
    fn nexas_magic_byte3_is_nul_not_space() {
        // Positive discrimination anchor: the NeXAS magic's 4th byte is 0x00.
        assert_eq!(NEXAS_PAC_MAGIC, b"PAC\0");
        assert_eq!(NEXAS_PAC_MAGIC[3], 0x00);
        assert_ne!(NEXAS_PAC_MAGIC[3], b' '); // 0x20 is Softpal
    }

    // ---- malformed-input typed errors -----------------------------------

    #[test]
    fn truncated_header_is_typed_error() {
        let err = PacArchive::parse(&[0x50, 0x41, 0x43]).expect_err("too short");
        assert!(matches!(err, PacError::TruncatedHeader { observed_len: 3 }));
        assert!(err.to_string().starts_with(crate::NEXAS_PAC_ERROR_MARKER));
    }

    #[test]
    fn bad_magic_is_typed_error() {
        let mut pac = build_pac_tail(Compression::None, SAMPLE);
        pac[0] = b'X';
        let err = PacArchive::parse(&pac).expect_err("bad magic");
        assert!(matches!(err, PacError::BadMagic { .. }));
    }

    #[test]
    fn zero_count_is_insane() {
        let mut pac = build_pac_tail(Compression::None, SAMPLE);
        pac[NEXAS_COUNT_OFFSET..NEXAS_COUNT_OFFSET + 4].copy_from_slice(&0u32.to_le_bytes());
        let err = PacArchive::parse(&pac).expect_err("zero count");
        assert!(matches!(err, PacError::InsaneCount { count: 0 }));
    }

    #[test]
    fn huge_count_is_insane() {
        let mut pac = build_pac_tail(Compression::None, SAMPLE);
        pac[NEXAS_COUNT_OFFSET..NEXAS_COUNT_OFFSET + 4]
            .copy_from_slice(&(NEXAS_PAC_MAX_ENTRIES + 1).to_le_bytes());
        let err = PacArchive::parse(&pac).expect_err("huge count");
        assert!(matches!(err, PacError::InsaneCount { .. }));
    }

    #[test]
    fn corrupt_index_is_unreadable() {
        let mut pac = build_pac_tail(Compression::None, SAMPLE);
        // Corrupt the tail index-size dword so neither layout can parse.
        let n = pac.len();
        pac[n - 4..].copy_from_slice(&0x7FFF_FFFFu32.to_le_bytes());
        let err = PacArchive::parse(&pac).expect_err("corrupt index");
        assert!(matches!(err, PacError::IndexUnreadable { .. }));
    }

    #[test]
    fn extract_rejects_mismatched_buffer() {
        let pac = build_pac_tail(Compression::None, SAMPLE);
        let arc = PacArchive::parse(&pac).unwrap();
        let entry = arc.entries()[0].clone();
        let mut other = pac.clone();
        other.push(0);
        let err = arc.extract(&other, &entry).expect_err("length mismatch");
        assert!(matches!(err, PacError::ArchiveLenMismatch { .. }));
    }
}
