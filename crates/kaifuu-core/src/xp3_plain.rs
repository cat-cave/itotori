use std::collections::HashSet;
use std::fmt;
use std::io::Read;

use flate2::read::ZlibDecoder;
use serde::{Deserialize, Serialize};

use crate::{
    XP3_PLAIN_MAGIC, checked_end, has_legacy_xp3_encrypted_marker, hash_xp3_segments,
    parse_xp3_file_chunk, read_chunk_name, read_le_u64,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3Inventory {
    pub entries: Vec<PlainXp3Entry>,
}

impl PlainXp3Inventory {
    pub fn normalize(&mut self) {
        self.entries.sort_by_key(|entry| entry.path.clone());
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3Entry {
    pub path: String,
    pub original_size: u64,
    pub archive_size: u64,
    pub compressed: bool,
    pub segment_count: usize,
    pub payload_hash: Option<String>,
    pub stored_adler32: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlainXp3InventoryError {
    MalformedHeader,
    Truncated(&'static str),
    InvalidOffset(&'static str),
    UnsupportedIndexEncoding(u8),
    IndexDecompression(String),
    UnsupportedEncrypted,
    InvalidChunk(String),
    InvalidUtf16Path,
    DuplicateEntry(String),
}

impl fmt::Display for PlainXp3InventoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MalformedHeader => formatter.write_str("malformed XP3 header"),
            Self::Truncated(field) => write!(formatter, "truncated XP3 {field}"),
            Self::InvalidOffset(field) => write!(formatter, "invalid XP3 {field} offset"),
            Self::UnsupportedIndexEncoding(flag) => {
                write!(formatter, "unsupported XP3 index encoding flag {flag}")
            }
            Self::IndexDecompression(message) => {
                write!(formatter, "could not decompress XP3 index: {message}")
            }
            Self::UnsupportedEncrypted => {
                formatter.write_str("encrypted XP3 inventory requires crypto support")
            }
            Self::InvalidChunk(message) => write!(formatter, "invalid XP3 chunk: {message}"),
            Self::InvalidUtf16Path => formatter.write_str("invalid XP3 UTF-16 path"),
            Self::DuplicateEntry(path) => write!(formatter, "duplicate XP3 file entry {path}"),
        }
    }
}

impl std::error::Error for PlainXp3InventoryError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlainXp3Segment {
    pub(crate) flags: u32,
    pub(crate) offset: u64,
    pub(crate) original_size: u64,
    pub(crate) archive_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlainXp3FileChunk {
    pub(crate) path: Option<String>,
    pub(crate) original_size: Option<u64>,
    pub(crate) archive_size: Option<u64>,
    pub(crate) segments: Vec<PlainXp3Segment>,
    pub(crate) stored_adler32: Option<String>,
}

pub fn read_plain_xp3_inventory(bytes: &[u8]) -> Result<PlainXp3Inventory, PlainXp3InventoryError> {
    if !bytes.starts_with(XP3_PLAIN_MAGIC) {
        if has_legacy_xp3_encrypted_marker(bytes) {
            return Err(PlainXp3InventoryError::UnsupportedEncrypted);
        }
        return Err(PlainXp3InventoryError::MalformedHeader);
    }
    let index_offset = read_le_u64(bytes, XP3_PLAIN_MAGIC.len(), "index offset")?;
    let index_offset = usize::try_from(index_offset)
        .map_err(|_| PlainXp3InventoryError::InvalidOffset("index"))?;
    if index_offset >= bytes.len() {
        return Err(PlainXp3InventoryError::InvalidOffset("index"));
    }

    let index = read_plain_xp3_index(bytes, index_offset)?;

    let mut cursor = 0;
    let mut entries = Vec::new();
    let mut seen_paths = HashSet::new();
    while cursor < index.len() {
        let chunk_name = read_chunk_name(&index, cursor, "index chunk name")?;
        let chunk_size = read_le_u64(&index, cursor + 4, "index chunk size")?;
        let content_start = cursor + 12;
        let content_size = usize::try_from(chunk_size)
            .map_err(|_| PlainXp3InventoryError::InvalidOffset("index chunk size"))?;
        let content_end = checked_end(content_start, content_size, index.len(), "index chunk")?;
        if chunk_name == *b"File" {
            let entry = parse_xp3_file_chunk(&index, content_start, content_end)?;
            let path = entry.path.ok_or_else(|| {
                PlainXp3InventoryError::InvalidChunk("File chunk missing info path".to_string())
            })?;
            if !seen_paths.insert(path.clone()) {
                return Err(PlainXp3InventoryError::DuplicateEntry(path));
            }
            let payload_hash = hash_xp3_segments(bytes, &entry.segments)?;
            entries.push(PlainXp3Entry {
                path,
                original_size: entry.original_size.ok_or_else(|| {
                    PlainXp3InventoryError::InvalidChunk(
                        "File chunk missing info original size".to_string(),
                    )
                })?,
                archive_size: entry.archive_size.ok_or_else(|| {
                    PlainXp3InventoryError::InvalidChunk(
                        "File chunk missing info archive size".to_string(),
                    )
                })?,
                compressed: entry.segments.iter().any(|segment| segment.flags & 1 != 0),
                segment_count: entry.segments.len(),
                payload_hash,
                stored_adler32: entry.stored_adler32,
            });
        }
        cursor = content_end;
    }

    let mut inventory = PlainXp3Inventory { entries };
    inventory.normalize();
    Ok(inventory)
}

/// Read the file-table index from a plain XP3 archive. KiriKiri records index
/// encoding `0` for raw bytes and `1` for a zlib stream; this reader decodes
/// the index only. Member payload bytes remain untouched and are still hashed
/// directly from the source archive.
fn read_plain_xp3_index(
    bytes: &[u8],
    index_offset: usize,
) -> Result<Vec<u8>, PlainXp3InventoryError> {
    let index_encoding = *bytes
        .get(index_offset)
        .ok_or(PlainXp3InventoryError::Truncated("index encoding"))?;
    let encoded_size = read_le_u64(bytes, index_offset + 1, "index size")?;
    let encoded_size = usize::try_from(encoded_size)
        .map_err(|_| PlainXp3InventoryError::InvalidOffset("index size"))?;
    let encoded_start = index_offset
        .checked_add(9)
        .ok_or(PlainXp3InventoryError::InvalidOffset("index start"))?;

    match index_encoding {
        0 => {
            let encoded_end = checked_end(encoded_start, encoded_size, bytes.len(), "index")?;
            Ok(bytes[encoded_start..encoded_end].to_vec())
        }
        1 => {
            let decoded_size = read_le_u64(bytes, encoded_start, "decoded index size")?;
            let decoded_size = usize::try_from(decoded_size)
                .map_err(|_| PlainXp3InventoryError::InvalidOffset("decoded index size"))?;
            let compressed_start =
                encoded_start
                    .checked_add(8)
                    .ok_or(PlainXp3InventoryError::InvalidOffset(
                        "compressed index start",
                    ))?;
            let compressed_end = checked_end(
                compressed_start,
                encoded_size,
                bytes.len(),
                "compressed index",
            )?;
            let mut decoder = ZlibDecoder::new(&bytes[compressed_start..compressed_end]);
            let mut index = Vec::with_capacity(decoded_size);
            decoder
                .read_to_end(&mut index)
                .map_err(|error| PlainXp3InventoryError::IndexDecompression(error.to_string()))?;
            if index.len() != decoded_size {
                return Err(PlainXp3InventoryError::IndexDecompression(format!(
                    "decoded index size {} did not match declared size {decoded_size}",
                    index.len()
                )));
            }
            Ok(index)
        }
        other => Err(PlainXp3InventoryError::UnsupportedIndexEncoding(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{Xp3TestEntry, plain_xp3_fixture};
    use std::io::Write;

    fn zlib_index_xp3_fixture(entries: &[Xp3TestEntry<'_>]) -> Vec<u8> {
        use flate2::{Compression, write::ZlibEncoder};

        let raw_index_fixture = plain_xp3_fixture(entries);
        let index_offset = u64::from_le_bytes(
            raw_index_fixture[XP3_PLAIN_MAGIC.len()..XP3_PLAIN_MAGIC.len() + 8]
                .try_into()
                .unwrap(),
        ) as usize;
        let raw_index = &raw_index_fixture[index_offset + 9..];
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(raw_index).unwrap();
        let compressed_index = encoder.finish().unwrap();

        let mut fixture = raw_index_fixture[..index_offset].to_vec();
        fixture.push(1);
        fixture.extend_from_slice(&(compressed_index.len() as u64).to_le_bytes());
        fixture.extend_from_slice(&(raw_index.len() as u64).to_le_bytes());
        fixture.extend_from_slice(&compressed_index);
        fixture
    }

    #[test]
    fn plain_xp3_inventory_reads_zlib_encoded_index() {
        let raw = plain_xp3_fixture(&[Xp3TestEntry {
            path: "scenario/intro.ks",
            payload: b"profile A zlib index fixture",
            compressed: false,
            adler32: 0x0102_0304,
        }]);
        let zlib_index = zlib_index_xp3_fixture(&[Xp3TestEntry {
            path: "scenario/intro.ks",
            payload: b"profile A zlib index fixture",
            compressed: false,
            adler32: 0x0102_0304,
        }]);

        assert_eq!(
            read_plain_xp3_inventory(&zlib_index).unwrap(),
            read_plain_xp3_inventory(&raw).unwrap(),
            "zlib is an index encoding only; the inventory still hashes source payload bytes"
        );
    }
}
