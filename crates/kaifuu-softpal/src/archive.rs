//! Softpal `PAC ` container envelope: header + directory index parse, entry
//! enumeration, and deterministic per-entry extraction.
//!
//! See the crate-level docs for the on-disk layout. Everything here is a pure
//! function of the input `&[u8]`; malformed bytes yield a typed [`PacError`],
//! never a panic.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// The 4-byte archive magic. The trailing space **is** part of the magic.
pub const PAC_MAGIC: &[u8; 4] = b"PAC ";

/// Byte offset of the little-endian `u32` file **count**.
pub const PAC_COUNT_OFFSET: usize = 0x08;

/// Length of the fixed reserved header. The directory index begins here.
pub const PAC_HEADER_BYTE_LEN: usize = 0x804;

/// Length of a single directory index entry (`name[32]` + `size` + `offset`).
pub const PAC_INDEX_ENTRY_BYTE_LEN: usize = 40;

/// Length of the fixed `name[32]` field within an index entry.
pub const PAC_ENTRY_NAME_BYTE_LEN: usize = 32;

/// Sanity bound on the entry count read from `@0x08`. A file that merely opens
/// with `PAC ` cannot pass with a garbage count. Mirrors the Softpal detector's
/// `SOFTPAL_PAC_MAX_ENTRIES`.
pub const PAC_MAX_ENTRIES: u32 = 1_000_000;

/// A single directory entry recovered from the PAC index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PacEntry {
    /// Entry name, decoded from the null-terminated ASCII `name[32]` field
    /// (uppercase 8.3-style, e.g. `SCRIPT.SRC`).
    pub name: String,
    /// On-disk byte length of the entry payload.
    pub size: u32,
    /// Absolute byte offset of the entry payload within the archive.
    pub offset: u32,
}

/// A parsed PAC directory: the validated set of [`PacEntry`] records.
///
/// Holds no archive bytes itself — [`PacArchive::extract`] takes the same
/// `&[u8]` the index was parsed from, so the reader is allocation-light and the
/// borrow of the archive buffer stays with the caller.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PacArchive {
    entries: Vec<PacEntry>,
    /// Total archive length the index was validated against (bytes). Recorded
    /// so [`PacArchive::extract`] can reject a mismatched buffer.
    archive_len: usize,
}

/// Fatal errors raised while parsing or extracting from a PAC archive.
///
/// Every display string begins with the `kaifuu.softpal.pac` namespace marker
/// (see [`crate::SOFTPAL_PAC_ERROR_MARKER`]).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PacError {
    /// The buffer is shorter than the fixed `0x804` reserved header, so the
    /// magic / count / index cannot even be located.
    #[error(
        "kaifuu.softpal.pac.truncated_header: archive length {observed_len} is shorter than the \
         fixed {PAC_HEADER_BYTE_LEN}-byte reserved header"
    )]
    TruncatedHeader { observed_len: usize },
    /// The first four bytes are not `"PAC "`.
    #[error(
        "kaifuu.softpal.pac.bad_magic: expected magic {expected:02X?} (\"PAC \") at offset 0, \
         found {found:02X?}"
    )]
    BadMagic { expected: [u8; 4], found: [u8; 4] },
    /// The count `@0x08` exceeds [`PAC_MAX_ENTRIES`].
    #[error(
        "kaifuu.softpal.pac.count_too_large: file count {count} at offset {PAC_COUNT_OFFSET:#x} \
         exceeds the sanity bound {PAC_MAX_ENTRIES}"
    )]
    CountTooLarge { count: u32 },
    /// The declared index (`0x804 + count*40`) runs past the archive end.
    #[error(
        "kaifuu.softpal.pac.truncated_index: index for {count} entries ends at {index_end} but \
         the archive is only {archive_len} bytes"
    )]
    TruncatedIndex {
        count: u32,
        index_end: usize,
        archive_len: usize,
    },
    /// An entry's `name[32]` field is not decodable as a non-empty
    /// null-terminated printable-ASCII string.
    #[error(
        "kaifuu.softpal.pac.invalid_entry_name: entry {index} has a name field that is not a \
         non-empty printable-ASCII (null-terminated) name: {reason}"
    )]
    InvalidEntryName { index: usize, reason: &'static str },
    /// An entry's `[offset, offset+size)` payload runs past the archive end
    /// (or overflows).
    #[error(
        "kaifuu.softpal.pac.entry_out_of_bounds: entry {index} ({name:?}) payload \
         (offset={offset}, size={size}) runs past archive length {archive_len}"
    )]
    EntryOutOfBounds {
        index: usize,
        name: String,
        offset: u32,
        size: u32,
        archive_len: usize,
    },
    /// An entry's payload begins inside the reserved header + index region
    /// (`offset < index_end`), which no real entry ever does.
    #[error(
        "kaifuu.softpal.pac.entry_overlaps_index: entry {index} ({name:?}) offset {offset} falls \
         inside the header+index region (index_end={index_end})"
    )]
    EntryOverlapsIndex {
        index: usize,
        name: String,
        offset: u32,
        index_end: usize,
    },
    /// Entry-0's `offset` (`u32` @ `0x828`, the oracle's `file_list_end`) does
    /// not equal the count-derived `index_end`. The two independent statements
    /// of where the index ends disagree — the header is inconsistent.
    #[error(
        "kaifuu.softpal.pac.index_end_mismatch: entry-0 offset {entry0_offset} (u32 @0x828) does \
         not equal count-derived index_end {index_end} (0x804 + {count}*40)"
    )]
    IndexEndMismatch {
        entry0_offset: u32,
        index_end: usize,
        count: u32,
    },
    /// The caller passed [`PacArchive::extract`] a buffer whose length differs
    /// from the one the index was validated against.
    #[error(
        "kaifuu.softpal.pac.archive_len_mismatch: extract buffer length {given_len} differs from \
         the {expected_len} the index was validated against"
    )]
    ArchiveLenMismatch {
        given_len: usize,
        expected_len: usize,
    },
}

/// Read a little-endian `u32` at `off`. Caller guarantees `off + 4 <= len`.
fn read_u32_le(bytes: &[u8], off: usize) -> u32 {
    let mut buf = [0u8; 4];
    buf.copy_from_slice(&bytes[off..off + 4]);
    u32::from_le_bytes(buf)
}

/// Decode a `name[32]` field: bytes up to the first NUL (or the full field if
/// none), which must be non-empty and all printable ASCII (`0x20..=0x7E`).
fn decode_entry_name(field: &[u8], index: usize) -> Result<String, PacError> {
    let name_bytes = match field.iter().position(|&b| b == 0) {
        Some(nul) => &field[..nul],
        None => field,
    };
    if name_bytes.is_empty() {
        return Err(PacError::InvalidEntryName {
            index,
            reason: "empty name",
        });
    }
    if !name_bytes.iter().all(|&b| (0x20..=0x7E).contains(&b)) {
        return Err(PacError::InvalidEntryName {
            index,
            reason: "non-printable-ASCII byte in name",
        });
    }
    // All bytes are printable ASCII, so this is valid UTF-8 by construction.
    Ok(String::from_utf8_lossy(name_bytes).into_owned())
}

impl PacArchive {
    /// Parse a PAC archive's header + directory index from `bytes`.
    ///
    /// Performs magic, count-sanity, index-bounds, per-entry name/payload, and
    /// the entry-0 `index_end` cross-check. Returns a typed [`PacError`] on any
    /// malformed input; never panics.
    ///
    /// # Errors
    ///
    /// Returns a [`PacError`] variant for a short buffer, wrong magic, an
    /// out-of-range count, a truncated / inconsistent index, or any entry whose
    /// name is undecodable or whose payload runs out of bounds.
    pub fn parse(bytes: &[u8]) -> Result<Self, PacError> {
        let archive_len = bytes.len();
        if archive_len < PAC_HEADER_BYTE_LEN {
            return Err(PacError::TruncatedHeader {
                observed_len: archive_len,
            });
        }
        let magic: [u8; 4] = [bytes[0], bytes[1], bytes[2], bytes[3]];
        if &magic != PAC_MAGIC {
            return Err(PacError::BadMagic {
                expected: *PAC_MAGIC,
                found: magic,
            });
        }
        let count = read_u32_le(bytes, PAC_COUNT_OFFSET);
        if count > PAC_MAX_ENTRIES {
            return Err(PacError::CountTooLarge { count });
        }
        // index_end = 0x804 + count*40, in usize with overflow-safe math.
        let index_bytes = (count as usize)
            .checked_mul(PAC_INDEX_ENTRY_BYTE_LEN)
            .ok_or(PacError::CountTooLarge { count })?;
        let index_end = PAC_HEADER_BYTE_LEN
            .checked_add(index_bytes)
            .ok_or(PacError::CountTooLarge { count })?;
        if index_end > archive_len {
            return Err(PacError::TruncatedIndex {
                count,
                index_end,
                archive_len,
            });
        }

        let mut entries = Vec::with_capacity(count as usize);
        for index in 0..count as usize {
            let entry_off = PAC_HEADER_BYTE_LEN + index * PAC_INDEX_ENTRY_BYTE_LEN;
            let name_field = &bytes[entry_off..entry_off + PAC_ENTRY_NAME_BYTE_LEN];
            let name = decode_entry_name(name_field, index)?;
            let size = read_u32_le(bytes, entry_off + PAC_ENTRY_NAME_BYTE_LEN);
            let offset = read_u32_le(bytes, entry_off + PAC_ENTRY_NAME_BYTE_LEN + 4);

            // Entry-0's offset is the oracle's independent index_end statement.
            if index == 0 && offset as usize != index_end {
                return Err(PacError::IndexEndMismatch {
                    entry0_offset: offset,
                    index_end,
                    count,
                });
            }
            // Payload must sit past the header+index region ...
            if (offset as usize) < index_end {
                return Err(PacError::EntryOverlapsIndex {
                    index,
                    name,
                    offset,
                    index_end,
                });
            }
            // ... and within the archive.
            let end = (offset as usize)
                .checked_add(size as usize)
                .filter(|&e| e <= archive_len)
                .ok_or_else(|| PacError::EntryOutOfBounds {
                    index,
                    name: name.clone(),
                    offset,
                    size,
                    archive_len,
                })?;
            debug_assert!(end <= archive_len);

            entries.push(PacEntry { name, size, offset });
        }

        Ok(Self {
            entries,
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

    /// Whether the archive has zero entries.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The first entry whose name equals `name` (case-sensitive, matching the
    /// on-disk uppercase names).
    pub fn find(&self, name: &str) -> Option<&PacEntry> {
        self.entries.iter().find(|e| e.name == name)
    }

    /// Slice an entry's payload bytes out of `bytes` — the same buffer the
    /// index was parsed from.
    ///
    /// No decompression / decryption: the PAC format stores payloads verbatim,
    /// so this is `bytes[offset .. offset+size]`. The `(offset, size)` bounds
    /// were validated at [`parse`](Self::parse) time; they are re-checked here
    /// against `bytes` so a caller cannot slice out of a different buffer.
    ///
    /// # Errors
    ///
    /// [`PacError::ArchiveLenMismatch`] if `bytes.len()` differs from the length
    /// the index was validated against; [`PacError::EntryOutOfBounds`] if the
    /// (re-checked) payload runs past `bytes` (defence in depth).
    pub fn extract<'a>(&self, bytes: &'a [u8], entry: &PacEntry) -> Result<&'a [u8], PacError> {
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
                index: usize::MAX,
                name: entry.name.clone(),
                offset: entry.offset,
                size: entry.size,
                archive_len: bytes.len(),
            })?;
        Ok(&bytes[start..end])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- synthetic PAC builder ------------------------------------------
    // Build a minimal, well-formed PAC from (name, payload) pairs so the happy
    // path and every malformed-input branch can be exercised without any real
    // (copyrighted) bytes.
    fn build_pac(files: &[(&str, &[u8])]) -> Vec<u8> {
        let count = files.len();
        let index_end = PAC_HEADER_BYTE_LEN + count * PAC_INDEX_ENTRY_BYTE_LEN;
        // Layout payloads back-to-back starting at index_end.
        let mut offsets = Vec::with_capacity(count);
        let mut cursor = index_end;
        for (_, payload) in files {
            offsets.push(cursor);
            cursor += payload.len();
        }
        let total = cursor;
        let mut buf = vec![0u8; total];
        buf[0..4].copy_from_slice(PAC_MAGIC);
        buf[PAC_COUNT_OFFSET..PAC_COUNT_OFFSET + 4].copy_from_slice(&(count as u32).to_le_bytes());
        for (i, (name, payload)) in files.iter().enumerate() {
            let e = PAC_HEADER_BYTE_LEN + i * PAC_INDEX_ENTRY_BYTE_LEN;
            let nb = name.as_bytes();
            buf[e..e + nb.len()].copy_from_slice(nb); // NUL padding already zeroed
            buf[e + PAC_ENTRY_NAME_BYTE_LEN..e + PAC_ENTRY_NAME_BYTE_LEN + 4]
                .copy_from_slice(&(payload.len() as u32).to_le_bytes());
            buf[e + PAC_ENTRY_NAME_BYTE_LEN + 4..e + PAC_ENTRY_NAME_BYTE_LEN + 8]
                .copy_from_slice(&(offsets[i] as u32).to_le_bytes());
            buf[offsets[i]..offsets[i] + payload.len()].copy_from_slice(payload);
        }
        buf
    }

    #[test]
    fn parses_and_extracts_a_synthetic_pac() {
        let files: &[(&str, &[u8])] = &[
            ("SCRIPT.SRC", b"Sv-script-bytes"),
            ("TEXT.DAT", b"$TEXT_LIST__payload"),
            ("BGM_BASE.PGD", &[0xDE, 0xAD, 0xBE, 0xEF]),
        ];
        let pac = build_pac(files);
        let arc = PacArchive::parse(&pac).expect("well-formed synthetic PAC must parse");
        assert_eq!(arc.len(), 3);
        assert!(!arc.is_empty());

        let names: Vec<&str> = arc.entries().iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["SCRIPT.SRC", "TEXT.DAT", "BGM_BASE.PGD"]);

        for (name, payload) in files {
            let entry = arc.find(name).expect("entry present");
            assert_eq!(entry.size as usize, payload.len());
            let got = arc.extract(&pac, entry).expect("extract in-bounds entry");
            assert_eq!(got, *payload, "extracted bytes must equal the payload");
        }
    }

    #[test]
    fn entry0_offset_equals_index_end_invariant_holds() {
        let pac = build_pac(&[("A.ANI", b"aaa"), ("B.ANI", b"bb")]);
        let arc = PacArchive::parse(&pac).unwrap();
        let index_end = PAC_HEADER_BYTE_LEN + 2 * PAC_INDEX_ENTRY_BYTE_LEN;
        assert_eq!(arc.entries()[0].offset as usize, index_end);
    }

    #[test]
    fn truncated_header_is_typed_error() {
        let err = PacArchive::parse(&[0u8; 16]).expect_err("too short for header");
        assert!(matches!(
            err,
            PacError::TruncatedHeader { observed_len: 16 }
        ));
        assert!(err.to_string().starts_with(crate::SOFTPAL_PAC_ERROR_MARKER));
    }

    #[test]
    fn bad_magic_is_typed_error() {
        let mut pac = build_pac(&[("A.ANI", b"aa")]);
        pac[0] = b'X';
        let err = PacArchive::parse(&pac).expect_err("bad magic");
        assert!(matches!(err, PacError::BadMagic { .. }));
    }

    #[test]
    fn count_too_large_is_typed_error() {
        let mut pac = build_pac(&[("A.ANI", b"aa")]);
        pac[PAC_COUNT_OFFSET..PAC_COUNT_OFFSET + 4]
            .copy_from_slice(&(PAC_MAX_ENTRIES + 1).to_le_bytes());
        let err = PacArchive::parse(&pac).expect_err("count over sanity bound");
        assert!(matches!(err, PacError::CountTooLarge { .. }));
    }

    #[test]
    fn truncated_index_is_typed_error() {
        // Claim more entries than the buffer can hold an index for.
        let mut pac = build_pac(&[("A.ANI", b"aa")]);
        pac[PAC_COUNT_OFFSET..PAC_COUNT_OFFSET + 4].copy_from_slice(&9999u32.to_le_bytes());
        let err = PacArchive::parse(&pac).expect_err("index runs past EOF");
        assert!(matches!(err, PacError::TruncatedIndex { count: 9999, .. }));
    }

    #[test]
    fn index_end_mismatch_is_typed_error() {
        // Corrupt entry-0's offset so it no longer equals the count-derived
        // index_end.
        let mut pac = build_pac(&[("A.ANI", b"aaa"), ("B.ANI", b"bb")]);
        let entry0_off_field = PAC_HEADER_BYTE_LEN + PAC_ENTRY_NAME_BYTE_LEN + 4;
        let index_end = (PAC_HEADER_BYTE_LEN + 2 * PAC_INDEX_ENTRY_BYTE_LEN) as u32;
        pac[entry0_off_field..entry0_off_field + 4].copy_from_slice(&(index_end + 1).to_le_bytes());
        let err = PacArchive::parse(&pac).expect_err("entry-0 offset != index_end");
        assert!(matches!(err, PacError::IndexEndMismatch { .. }));
    }

    #[test]
    fn entry_out_of_bounds_is_typed_error() {
        // Blow up entry-1's size so its payload runs past EOF.
        let mut pac = build_pac(&[("A.ANI", b"aaa"), ("B.ANI", b"bb")]);
        let e1_size_field =
            PAC_HEADER_BYTE_LEN + PAC_INDEX_ENTRY_BYTE_LEN + PAC_ENTRY_NAME_BYTE_LEN;
        pac[e1_size_field..e1_size_field + 4].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        let err = PacArchive::parse(&pac).expect_err("payload past EOF");
        assert!(matches!(err, PacError::EntryOutOfBounds { index: 1, .. }));
    }

    #[test]
    fn entry_overlapping_index_is_typed_error() {
        // Point entry-1 at an offset inside the header+index region.
        let mut pac = build_pac(&[("A.ANI", b"aaa"), ("B.ANI", b"bb")]);
        let e1_off_field =
            PAC_HEADER_BYTE_LEN + PAC_INDEX_ENTRY_BYTE_LEN + PAC_ENTRY_NAME_BYTE_LEN + 4;
        pac[e1_off_field..e1_off_field + 4].copy_from_slice(&0x100u32.to_le_bytes());
        let err = PacArchive::parse(&pac).expect_err("offset inside index region");
        assert!(matches!(err, PacError::EntryOverlapsIndex { index: 1, .. }));
    }

    #[test]
    fn empty_entry_name_is_typed_error() {
        // Zero out entry-0's whole name field.
        let mut pac = build_pac(&[("A.ANI", b"aaa")]);
        for b in &mut pac[PAC_HEADER_BYTE_LEN..PAC_HEADER_BYTE_LEN + PAC_ENTRY_NAME_BYTE_LEN] {
            *b = 0;
        }
        let err = PacArchive::parse(&pac).expect_err("empty name");
        assert!(matches!(
            err,
            PacError::InvalidEntryName {
                index: 0,
                reason: "empty name"
            }
        ));
    }

    #[test]
    fn non_ascii_entry_name_is_typed_error() {
        let mut pac = build_pac(&[("A.ANI", b"aaa")]);
        pac[PAC_HEADER_BYTE_LEN] = 0x80; // first name byte non-printable
        let err = PacArchive::parse(&pac).expect_err("non-ascii name");
        assert!(matches!(err, PacError::InvalidEntryName { index: 0, .. }));
    }

    #[test]
    fn extract_rejects_mismatched_buffer() {
        let pac = build_pac(&[("A.ANI", b"aaa")]);
        let arc = PacArchive::parse(&pac).unwrap();
        let entry = arc.entries()[0].clone();
        let mut other = pac.clone();
        other.push(0); // length now differs
        let err = arc
            .extract(&other, &entry)
            .expect_err("buffer length mismatch");
        assert!(matches!(err, PacError::ArchiveLenMismatch { .. }));
    }

    #[test]
    fn zero_entry_archive_parses_empty() {
        // count=0: index_end == header len, entry-0 invariant vacuous.
        let mut buf = vec![0u8; PAC_HEADER_BYTE_LEN];
        buf[0..4].copy_from_slice(PAC_MAGIC);
        // count field already zero
        let arc = PacArchive::parse(&buf).expect("zero-entry PAC is well-formed");
        assert!(arc.is_empty());
        assert_eq!(arc.len(), 0);
    }
}
