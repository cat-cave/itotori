//! Logical-payload Adler proof for real-byte XP3 archives.
//!
//! XP3 stores `adlr` over original member bytes. This helper decodes only for
//! integrity verification; the identity repack continues to preserve compressed
//! payloads verbatim and does not introduce recompression support.

use std::io::Read;

use flate2::read::ZlibDecoder;

use super::{RealBytesXp3Entry, inv_err};
use crate::{PlainXp3InventoryError, PlainXp3WriterError};

pub(super) fn logical_payload_for_adler(
    entry: &RealBytesXp3Entry,
) -> Result<Vec<u8>, PlainXp3WriterError> {
    let capacity = usize::try_from(entry.original_size).map_err(|_| {
        inconsistent(
            entry,
            format!(
                "original_size {} does not fit in usize",
                entry.original_size
            ),
        )
    })?;
    let mut logical = Vec::with_capacity(capacity);
    let mut cursor = 0_usize;
    for segment in &entry.segments {
        let archive_size = usize::try_from(segment.archive_size).map_err(|_| {
            inconsistent(
                entry,
                format!(
                    "segment archive_size {} does not fit in usize",
                    segment.archive_size
                ),
            )
        })?;
        let end = cursor
            .checked_add(archive_size)
            .ok_or_else(|| inconsistent(entry, "segment slice overflows payload"))?;
        let stored = entry.payload.get(cursor..end).ok_or_else(|| {
            inconsistent(
                entry,
                format!(
                    "segment slice {cursor}..{end} exceeds payload length {}",
                    entry.payload.len()
                ),
            )
        })?;
        if segment.is_compressed() {
            let mut decoder = ZlibDecoder::new(stored);
            let before = logical.len();
            decoder.read_to_end(&mut logical).map_err(|error| {
                inv_err(PlainXp3InventoryError::IndexDecompression(format!(
                    "entry {:?} compressed segment: {error}",
                    entry.path
                )))
            })?;
            let logical_size = logical.len() - before;
            if logical_size as u64 != segment.original_size {
                return Err(inconsistent(
                    entry,
                    format!(
                        "decompressed segment size {logical_size} does not match original_size {}",
                        segment.original_size
                    ),
                ));
            }
        } else {
            if segment.archive_size != segment.original_size {
                return Err(inconsistent(
                    entry,
                    format!(
                        "uncompressed segment archive_size {} does not match original_size {}",
                        segment.archive_size, segment.original_size
                    ),
                ));
            }
            logical.extend_from_slice(stored);
        }
        cursor = end;
    }
    if cursor != entry.payload.len() || logical.len() as u64 != entry.original_size {
        return Err(inconsistent(
            entry,
            format!(
                "logical payload size {} does not match original_size {}",
                logical.len(),
                entry.original_size
            ),
        ));
    }
    Ok(logical)
}

fn inconsistent(entry: &RealBytesXp3Entry, detail: impl std::fmt::Display) -> PlainXp3WriterError {
    PlainXp3WriterError::InconsistentManifest(format!("entry {:?} {detail}", entry.path))
}
