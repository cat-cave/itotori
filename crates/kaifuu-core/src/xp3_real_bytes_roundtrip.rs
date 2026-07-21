//! Byte-exact plain-XP3 round-trip over real licensed archives.
//!
//! The plain-XP3 reader (`read_plain_xp3_inventory`) and the
//! existing source-fidelity writer (`read_plain_xp3_archive` + `encode_xp3`)
//! cover every public *synthetic* plain-XP3 fixture byte-for-byte. Real
//! licensed archives — the metadata-only `kaifuu-xp3-plain-profile-a`
//! fixture being the canonical example — use the KiriKiri *zlib index*
//! encoding (`index_encoding == 1`), which the existing writer does not
//! preserve: re-compressing the decoded index with `flate2` is not
//! guaranteed to reproduce the original compressed bytes.
//!
//! This module is the **real-bytes** round-trip surface. It reads a plain
//! XP3 archive into a structural model that ALSO carries the original
//! encoded index bytes verbatim (raw or zlib-compressed), then re-emits
//! the archive with payloads laid out back-to-back in entry order and the
//! original encoded index re-appended as-is. The result is byte-identical
//! to the source for any archive whose data area is the standard packed
//! layout — which is the only layout the licensed KiriKiri English
//! releases actually emit.
//!
//! The structural model is intentionally narrow: identity repack only. It
//! is NOT a general patch-back surface (payload mutation + recompression
//! stays on the existing raw-index writer path). The point is to PROVE the
//! parse/repack pipeline is faithful for the real corpus shape, including
//! per-member adler32 integrity, without redistributing any copyrighted
//! archive bytes.

use std::collections::HashSet;
use std::io::Read;

use flate2::read::ZlibDecoder;
use serde::{Deserialize, Serialize};

use crate::{
    PlainXp3InventoryError, PlainXp3WriterError, XP3_PLAIN_MAGIC, checked_end,
    has_legacy_xp3_encrypted_marker, parse_xp3_file_chunk, read_chunk_name, read_le_u64,
    validate_safe_relative_path,
};

#[path = "xp3_real_bytes_roundtrip_adler.rs"]
mod xp3_real_bytes_roundtrip_adler;

/// Index encoding byte for an uncompressed (raw) XP3 index segment table.
pub const XP3_INDEX_ENCODING_RAW: u8 = 0;
/// Index encoding byte for a zlib-compressed XP3 index segment table.
pub const XP3_INDEX_ENCODING_ZLIB: u8 = 1;

/// Schema version of the real-bytes round-trip archive model.
pub const REAL_BYTES_XP3_SCHEMA_VERSION: &str = "0.1.0";
/// Variant string written into the real-bytes archive model.
pub const REAL_BYTES_XP3_VARIANT: &str = "plain";

/// Per-entry adler32 recomputed from the rebuilt payload, paired with the
/// source-stored value so the round-trip report can prove the integrity
/// checksum still matches after the repack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealBytesXp3AdlerProof {
    pub recomputed: u32,
    pub stored: Option<u32>,
}

/// Source-fidelity archive structure used by the real-bytes round-trip.
/// Preserves the source's encoded index bytes verbatim so a rebuild of an
/// unchanged archive is byte-identical for BOTH the raw and zlib index
/// encodings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealBytesXp3Archive {
    pub schema_version: String,
    pub variant: String,
    pub entries: Vec<RealBytesXp3Entry>,
    /// The source index encoding byte (`0` raw, `1` zlib).
    pub index_encoding: u8,
    /// Encoded index bytes carried verbatim from the source: for `0` the
    /// raw index content; for `1` the zlib-compressed bytes (NOT including
    /// the 8-byte `decoded_size` prefix that precedes them in the file).
    pub encoded_index: Vec<u8>,
    /// Declared decoded index size for encoding `1`; `None` for raw.
    pub decoded_index_size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealBytesXp3Entry {
    pub path: String,
    pub original_size: u64,
    pub archive_size: u64,
    pub stored_adler32: Option<u32>,
    pub segments: Vec<RealBytesXp3Segment>,
    /// Concatenated raw segment payloads in source order. The repack
    /// slices this back into segments by
    /// [`RealBytesXp3Segment::archive_size`].
    #[serde(with = "real_bytes_xp3_payload_serde")]
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealBytesXp3Segment {
    pub flags: u32,
    pub original_size: u64,
    pub archive_size: u64,
}

impl RealBytesXp3Segment {
    /// Whether the segment is marked zlib-compressed (low bit of `flags`).
    pub fn is_compressed(&self) -> bool {
        self.flags & 1 != 0
    }
}

/// Read a plain XP3 archive into a source-fidelity [`RealBytesXp3Archive`]
/// suitable for byte-identical rebuild of either raw-index OR zlib-index
/// sources. Refuses encrypted inputs at the magic check.
pub fn read_real_bytes_xp3_archive(
    bytes: &[u8],
) -> Result<RealBytesXp3Archive, PlainXp3WriterError> {
    if !bytes.starts_with(XP3_PLAIN_MAGIC) {
        if has_legacy_xp3_encrypted_marker(bytes) {
            return Err(PlainXp3WriterError::UnsupportedEncrypted);
        }
        return Err(PlainXp3WriterError::UnsupportedProtectedExecutable);
    }

    let index_offset = read_le_u64(bytes, XP3_PLAIN_MAGIC.len(), "index offset")
        .map_err(PlainXp3WriterError::InventoryError)?;
    let index_offset = usize::try_from(index_offset)
        .map_err(|_| inv_err(PlainXp3InventoryError::InvalidOffset("index")))?;
    if index_offset >= bytes.len() {
        return Err(inv_err(PlainXp3InventoryError::InvalidOffset("index")));
    }

    let index_encoding = *bytes
        .get(index_offset)
        .ok_or(inv_err(PlainXp3InventoryError::Truncated("index encoding")))?;
    if index_encoding != XP3_INDEX_ENCODING_RAW && index_encoding != XP3_INDEX_ENCODING_ZLIB {
        return Err(inv_err(PlainXp3InventoryError::UnsupportedIndexEncoding(
            index_encoding,
        )));
    }

    let encoded_size = read_le_u64(bytes, index_offset + 1, "index size")
        .map_err(PlainXp3WriterError::InventoryError)?;
    let encoded_size = usize::try_from(encoded_size)
        .map_err(|_| inv_err(PlainXp3InventoryError::InvalidOffset("index size")))?;
    let encoded_start =
        index_offset
            .checked_add(9)
            .ok_or(inv_err(PlainXp3InventoryError::InvalidOffset(
                "index start",
            )))?;

    let (encoded_index, decoded_index_size, decoded_index) =
        if index_encoding == XP3_INDEX_ENCODING_RAW {
            let encoded_end = checked_end(
                encoded_start,
                encoded_size,
                bytes.len(),
                "index raw content",
            )
            .map_err(PlainXp3WriterError::InventoryError)?;
            (
                bytes[encoded_start..encoded_end].to_vec(),
                None,
                bytes[encoded_start..encoded_end].to_vec(),
            )
        } else {
            let decoded_size = read_le_u64(bytes, encoded_start, "decoded index size")
                .map_err(PlainXp3WriterError::InventoryError)?;
            let decoded_size_usize = usize::try_from(decoded_size).map_err(|_| {
                inv_err(PlainXp3InventoryError::InvalidOffset("decoded index size"))
            })?;
            let compressed_start = encoded_start.checked_add(8).ok_or(inv_err(
                PlainXp3InventoryError::InvalidOffset("compressed index start"),
            ))?;
            let compressed_end = checked_end(
                compressed_start,
                encoded_size,
                bytes.len(),
                "compressed index",
            )
            .map_err(PlainXp3WriterError::InventoryError)?;
            let encoded_index = bytes[compressed_start..compressed_end].to_vec();
            let mut decoder = ZlibDecoder::new(&encoded_index[..]);
            let mut decoded = Vec::with_capacity(decoded_size_usize);
            decoder.read_to_end(&mut decoded).map_err(|error| {
                inv_err(PlainXp3InventoryError::IndexDecompression(
                    error.to_string(),
                ))
            })?;
            if decoded.len() != decoded_size_usize {
                return Err(inv_err(PlainXp3InventoryError::IndexDecompression(
                    format!(
                        "decoded index size {} did not match declared size {decoded_size_usize}",
                        decoded.len()
                    ),
                )));
            }
            (encoded_index, Some(decoded_size), decoded)
        };

    let entries = parse_real_bytes_entries(bytes, &decoded_index)?;

    Ok(RealBytesXp3Archive {
        schema_version: REAL_BYTES_XP3_SCHEMA_VERSION.to_string(),
        variant: REAL_BYTES_XP3_VARIANT.to_string(),
        entries,
        index_encoding,
        encoded_index,
        decoded_index_size,
    })
}

fn inv_err(error: PlainXp3InventoryError) -> PlainXp3WriterError {
    PlainXp3WriterError::InventoryError(error)
}

fn parse_real_bytes_entries(
    bytes: &[u8],
    index: &[u8],
) -> Result<Vec<RealBytesXp3Entry>, PlainXp3WriterError> {
    let mut cursor = 0_usize;
    let mut entries: Vec<RealBytesXp3Entry> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    while cursor < index.len() {
        let chunk_name = read_chunk_name(index, cursor, "index chunk name").map_err(inv_err)?;
        let chunk_size = read_le_u64(index, cursor + 4, "index chunk size").map_err(inv_err)?;
        let content_start = cursor + 12;
        let content_size = usize::try_from(chunk_size)
            .map_err(|_| inv_err(PlainXp3InventoryError::InvalidOffset("index chunk size")))?;
        let content_end = checked_end(content_start, content_size, index.len(), "index chunk")
            .map_err(inv_err)?;
        if chunk_name == *b"File" {
            let chunk = parse_xp3_file_chunk(index, content_start, content_end).map_err(inv_err)?;
            entries.push(entry_from_chunk(bytes, chunk, &mut seen_paths)?);
        }
        cursor = content_end;
    }
    Ok(entries)
}

fn entry_from_chunk(
    bytes: &[u8],
    chunk: crate::PlainXp3FileChunk,
    seen_paths: &mut HashSet<String>,
) -> Result<RealBytesXp3Entry, PlainXp3WriterError> {
    let path = chunk.path.ok_or_else(|| {
        inv_err(PlainXp3InventoryError::InvalidChunk(
            "File chunk missing info path".to_string(),
        ))
    })?;
    if !seen_paths.insert(path.clone()) {
        return Err(inv_err(PlainXp3InventoryError::DuplicateEntry(path)));
    }
    let original_size = chunk.original_size.ok_or_else(|| {
        inv_err(PlainXp3InventoryError::InvalidChunk(
            "File chunk missing info original size".to_string(),
        ))
    })?;
    let archive_size = chunk.archive_size.ok_or_else(|| {
        inv_err(PlainXp3InventoryError::InvalidChunk(
            "File chunk missing info archive size".to_string(),
        ))
    })?;
    let mut payload: Vec<u8> = Vec::new();
    let mut segments: Vec<RealBytesXp3Segment> = Vec::new();
    for segment in &chunk.segments {
        let offset = usize::try_from(segment.offset)
            .map_err(|_| inv_err(PlainXp3InventoryError::InvalidOffset("segment")))?;
        let size = usize::try_from(segment.archive_size)
            .map_err(|_| inv_err(PlainXp3InventoryError::InvalidOffset("segment size")))?;
        let end = checked_end(offset, size, bytes.len(), "segment payload").map_err(inv_err)?;
        payload.extend_from_slice(&bytes[offset..end]);
        segments.push(RealBytesXp3Segment {
            flags: segment.flags,
            original_size: segment.original_size,
            archive_size: segment.archive_size,
        });
    }
    let stored_adler32 = match chunk.stored_adler32.as_deref() {
        Some(formatted) => {
            let hex = formatted.strip_prefix("adler32:").ok_or_else(|| {
                inv_err(PlainXp3InventoryError::InvalidChunk(format!(
                    "adlr chunk had unexpected format {formatted:?}"
                )))
            })?;
            Some(u32::from_str_radix(hex, 16).map_err(|_| {
                inv_err(PlainXp3InventoryError::InvalidChunk(format!(
                    "adlr chunk had non-hex value {hex:?}"
                )))
            })?)
        }
        None => None,
    };
    Ok(RealBytesXp3Entry {
        path,
        original_size,
        archive_size,
        stored_adler32,
        segments,
        payload,
    })
}

/// Re-emit a [`RealBytesXp3Archive`] as a deterministic XP3 byte stream,
/// byte-identical to the source for an unchanged manifest. The data area is
/// rebuilt by laying each entry's segments back-to-back in entry order; the
/// encoded index is re-appended verbatim so raw AND zlib source encodings
/// round-trip exactly.
pub fn repack_real_bytes_xp3_archive(
    archive: &RealBytesXp3Archive,
) -> Result<Vec<u8>, PlainXp3WriterError> {
    if archive.variant != REAL_BYTES_XP3_VARIANT {
        return Err(PlainXp3WriterError::UnsupportedVariant(
            archive.variant.clone(),
        ));
    }
    if archive.index_encoding != XP3_INDEX_ENCODING_RAW
        && archive.index_encoding != XP3_INDEX_ENCODING_ZLIB
    {
        return Err(inv_err(PlainXp3InventoryError::UnsupportedIndexEncoding(
            archive.index_encoding,
        )));
    }

    let mut bytes = Vec::new();
    bytes.extend_from_slice(XP3_PLAIN_MAGIC);
    bytes.extend_from_slice(&0_u64.to_le_bytes());

    emit_payloads(&mut bytes, &archive.entries)?;

    let index_offset = bytes.len() as u64;
    bytes.push(archive.index_encoding);
    // Encoded-size covers ONLY the (raw or compressed) index bytes. For
    // zlib, the 8-byte decoded-size prefix is written separately below.
    bytes.extend_from_slice(&(archive.encoded_index.len() as u64).to_le_bytes());
    if archive.index_encoding == XP3_INDEX_ENCODING_ZLIB {
        let declared = archive.decoded_index_size.ok_or_else(|| {
            PlainXp3WriterError::InconsistentManifest(
                "zlib-encoded archive is missing its declared decoded index size".to_string(),
            )
        })?;
        bytes.extend_from_slice(&declared.to_le_bytes());
    }
    bytes.extend_from_slice(&archive.encoded_index);

    bytes[XP3_PLAIN_MAGIC.len()..XP3_PLAIN_MAGIC.len() + 8]
        .copy_from_slice(&index_offset.to_le_bytes());

    Ok(bytes)
}

fn emit_payloads(
    bytes: &mut Vec<u8>,
    entries: &[RealBytesXp3Entry],
) -> Result<(), PlainXp3WriterError> {
    for entry in entries {
        validate_safe_relative_path(&entry.path)
            .map_err(|_| PlainXp3WriterError::UnsafeRelativePath(entry.path.clone()))?;
        let total_archive_size: u64 = entry.segments.iter().map(|s| s.archive_size).sum();
        if total_archive_size != entry.archive_size {
            return Err(PlainXp3WriterError::InconsistentManifest(format!(
                "entry {:?} segment archive_size sum {} does not match recorded archive_size {}",
                entry.path, total_archive_size, entry.archive_size
            )));
        }
        if (entry.payload.len() as u64) != total_archive_size {
            return Err(PlainXp3WriterError::InconsistentManifest(format!(
                "entry {:?} payload length {} does not match segment archive_size sum {}",
                entry.payload.len(),
                total_archive_size,
                entry.archive_size
            )));
        }
        let mut payload_cursor = 0_usize;
        for segment in &entry.segments {
            let segment_len = usize::try_from(segment.archive_size).map_err(|_| {
                PlainXp3WriterError::InconsistentManifest(format!(
                    "entry {:?} segment archive_size {} does not fit in usize",
                    entry.path, segment.archive_size
                ))
            })?;
            let segment_end = payload_cursor.checked_add(segment_len).ok_or_else(|| {
                PlainXp3WriterError::InconsistentManifest(format!(
                    "entry {:?} segment slice overflows payload",
                    entry.path
                ))
            })?;
            if segment_end > entry.payload.len() {
                return Err(PlainXp3WriterError::InconsistentManifest(format!(
                    "entry {:?} segment slice {}..{} exceeds payload length {}",
                    entry.path,
                    payload_cursor,
                    segment_end,
                    entry.payload.len()
                )));
            }
            bytes.extend_from_slice(&entry.payload[payload_cursor..segment_end]);
            payload_cursor = segment_end;
        }
    }
    Ok(())
}

/// Recompute each entry's Adler-32 over its logical (decompressed when needed)
/// payload and pair it with the source-stored value. XP3 records `adlr` over
/// the original member bytes, not the raw bytes stored in a compressed segment.
/// The identity repack still preserves those stored segment bytes verbatim.
pub fn real_bytes_xp3_adler_proof(
    archive: &RealBytesXp3Archive,
) -> Result<Vec<(String, RealBytesXp3AdlerProof)>, PlainXp3WriterError> {
    let mut out = Vec::with_capacity(archive.entries.len());
    for entry in &archive.entries {
        let recomputed = crate::compute_adler32(
            &xp3_real_bytes_roundtrip_adler::logical_payload_for_adler(entry)?,
        );
        out.push((
            entry.path.clone(),
            RealBytesXp3AdlerProof {
                recomputed,
                stored: entry.stored_adler32,
            },
        ));
    }
    Ok(out)
}

mod real_bytes_xp3_payload_serde {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex_encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let hex = String::deserialize(deserializer)?;
        hex_decode(&hex).map_err(serde::de::Error::custom)
    }

    fn hex_encode(bytes: &[u8]) -> String {
        use std::fmt::Write as _;
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            let _ = write!(output, "{byte:02x}");
        }
        output
    }

    fn hex_decode(input: &str) -> Result<Vec<u8>, String> {
        if !input.len().is_multiple_of(2) {
            return Err("hex payload length must be even".to_string());
        }
        let mut output = Vec::with_capacity(input.len() / 2);
        for index in (0..input.len()).step_by(2) {
            let pair = &input[index..index + 2];
            output.push(
                u8::from_str_radix(pair, 16)
                    .map_err(|_| format!("invalid hex byte at offset {index}"))?,
            );
        }
        Ok(output)
    }
}

#[cfg(test)]
#[path = "xp3_real_bytes_roundtrip_tests.rs"]
mod tests;
