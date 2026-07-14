//! RealLive `.ovk` voice archive decoder.
//!
//! Decodes the OVK on-disk layout the Sweetie HD `REALLIVEDATA/koe/`
//! corpus (139 files) ships. Each archive is a 4-byte entry count
//! followed by a flat table of **16-byte** records; the per-record
//! `(offset, length)` pair points into the inline Ogg Vorbis stream
//! body that follows the table. Per the spec the decoder
//! verifies the table decode and exposes the inline `OggS`-prefixed
//! sample bytes — it does **not** invoke a Vorbis decoder.
//!
//! # On-disk layout (16-byte entry records)
//!
//! After byte-level probing of Sweetie HD's `koe/z0001.ovk` (337,086
//! bytes, 2 entries) under `docs/research/reallive-engine.md` § ".ovk
//! (voice archive)", the layout is:
//!
//! ```text
//! @0x00 u32 entry_count (=2 for z0001.ovk)
//! @0x04 Entry[entry_count] (16 bytes each)
//! @... <ogg vorbis stream bodies, OggS-prefixed>
//! ```
//!
//! Each entry is four `u32` LE fields:
//!
//! ```text
//! field_0 u32 data_size (length of the inline Ogg body)
//! field_1 u32 data_offset (byte offset from file start where
//!                                   the Ogg body begins)
//! field_2 u32 sample_num (sample index inside the archive;
//!                                   matches the `koePlay` argument)
//! field_3 u32 reserved_or_unknown (observed as a non-zero u32 in
//!                                   Sweetie HD; treated as opaque
//!                                   metadata)
//! ```
//!
//! The (`field_0`, `field_1`) pair is what the spec calls "data_size
//! data_offset". The table is **not** sorted by `sample_num` — Sweetie
//! HD's `z0001.ovk` carries `sample_num = 46` in entry 0 (at offset 36
//! the file body start, length 176,576) and `sample_num = 52` in
//! entry 1 (at offset 176,612, length 160,474). Entry 1's body
//! `[176_612, 176_612 + 160_474 = 337_086)` exactly fills the file
//! (file size = 337,086 bytes). The decoder preserves the on-disk
//! order.
//!
//! # Spec acceptance vs. real bytes
//!
//! The spec acceptance pins the entries as `(sample_num=46
//! length=36)` and `(sample_num=52, length=183,476)`. The actual byte
//! decoding (`xxd -l 96 z0001.ovk`) shows the four-field record at
//! `@0x04` is `c0 b1 02 00 | 24 00 00 00 | 2e 00 00 00 | 9e fb 05 00`
//! — i.e. `(0x0002B1C0, 0x24, 0x2E, 0x0005FB9E) = (176_576, 36, 46
//! 392_094)`. The spec's `(sample_num=46, length=36)` matches if the
//! second u32 field is interpreted as the "length" the spec quotes;
//! however the actual data body for sample 46 is the 176,576-byte Ogg
//! stream starting at file offset 36 (the first `OggS` magic in the
//! file). The reconciliation: **field_0 is the data size; field_1 is
//! the data offset** — the spec's "length=36" value is in fact the
//! `data_offset` field carrying value `36` (the inline body starts
//! right after the header + entry table). The spec text described
//! field_1's value as "length" because field_1 is the second field of
//! the record; the real-bytes integration test in
//! `tests/ovk_real_bytes.rs` pins **both** interpretations and
//! cross-references against the first-`OggS`-magic-at-`field_1` check
//! the spec also requires.
//!
//! For entry 1 the spec claims `length = 183_476`, but the byte
//! sequence `e4 b1 02 00` decodes to `0x0002B1E4 = 176_612`
//! (`= 36 + 176_576`, i.e. the file offset where the second sample
//! body begins — confirming the field_1 = offset interpretation). The
//! real-bytes test pins the actual decoded value `176_612`; the
//! single-corpus discrepancy is recorded in a typed audit comment
//! alongside the assertion.
//!
//! # Clean-room provenance
//!
//! The 16-byte record layout was re-derived from the `xxd -l 96
//! z0001.ovk` byte sequence cross-referenced against the
//! public-format commentary in `docs/research/reallive-engine.md` §
//! ".ovk". rlvm's `ovk_voice_archive.cc` is a **research anchor only**:
//! its `ReadVisualArtsTable(file, 16, entries_)` call is consulted for
//! the entry size constant (`16`) but no rlvm source is vendored
//! linked, or mechanically translated. See
//! [`crate::RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`].

use serde::{Deserialize, Serialize};

/// On-disk byte width of a single OVK entry record.
pub const OVK_ENTRY_BYTE_LEN: usize = 16;

/// On-disk byte width of the OVK file header (just the u32 entry
/// count).
pub const OVK_HEADER_BYTE_LEN: usize = std::mem::size_of::<u32>();

/// Stable diagnostic codes [`OvkDecodeError`] uses.
pub const OVK_HEADER_TRUNCATED_CODE: &str = "utsushi.reallive.ovk.header_truncated";
pub const OVK_ENTRY_TABLE_TRUNCATED_CODE: &str = "utsushi.reallive.ovk.entry_table_truncated";
pub const OVK_ENTRY_BODY_OUT_OF_BOUNDS_CODE: &str = "utsushi.reallive.ovk.entry_body_out_of_bounds";

/// Ogg Vorbis page magic ("OggS"). Audit-focus pin: the first sample's
/// raw bytes MUST start with this magic.
pub const OGG_PAGE_MAGIC: [u8; 4] = *b"OggS";

/// Typed errors surfaced by [`decode_ovk`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OvkDecodeError {
    /// The byte slice does not carry the 4-byte header.
    #[error("ovk file truncated: need {needed} bytes for header, got {actual} ({code})")]
    HeaderTruncated {
        code: String,
        needed: usize,
        actual: usize,
    },
    /// The entry table is shorter than `entry_count * 16` bytes.
    #[error(
        "ovk entry table truncated: need {needed} bytes for {entry_count} entries, got \
         {actual} ({code})"
    )]
    EntryTableTruncated {
        code: String,
        entry_count: u32,
        needed: usize,
        actual: usize,
    },
    /// An entry's `(data_offset, data_size)` pair points past the end
    /// of the file slice.
    #[error(
        "ovk entry {entry_index} body out of bounds: offset={data_offset} \
         size={data_size} file_size={file_size} ({code})"
    )]
    EntryBodyOutOfBounds {
        code: String,
        entry_index: u32,
        data_offset: u32,
        data_size: u32,
        file_size: usize,
    },
}

/// Decoded OVK entry record. Fields are laid out in the on-disk byte
/// order; see the module docstring for the field-name reconciliation
/// against the spec text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OvkEntry {
    /// Field 0 (`@offset+0`, u32 LE) — byte size of the inline Ogg
    /// Vorbis stream body for this entry.
    pub data_size: u32,
    /// Field 1 (`@offset+4`, u32 LE) — byte offset (from file start)
    /// where the inline Ogg Vorbis stream body begins.
    pub data_offset: u32,
    /// Field 2 (`@offset+8`, u32 LE) — sample index inside the
    /// archive (matches the `koePlay` argument).
    pub sample_num: u32,
    /// Field 3 (`@offset+12`, u32 LE) — engine-opaque metadata field
    /// (observed as a non-zero u32 in Sweetie HD; possibly a hash
    /// possibly a tail size). Recorded verbatim.
    pub reserved: u32,
}

/// Decoded OVK file: the entry table plus a borrowed view of the
/// underlying bytes.
#[derive(Debug, Clone)]
pub struct OvkFile<'a> {
    /// On-disk entries in source order.
    pub entries: Vec<OvkEntry>,
    /// Borrowed file bytes.
    pub bytes: &'a [u8],
}

impl<'a> OvkFile<'a> {
    /// Number of entries.
    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    /// Borrow the inline Ogg Vorbis body bytes for `entry`. Returns
    /// `None` if the entry's `(data_offset, data_size)` does not fit
    /// the file slice — the decoder normally rejects this case
    /// up-front via [`OvkDecodeError::EntryBodyOutOfBounds`], so this
    /// accessor is the post-decode fast path.
    pub fn entry_body(&self, entry: &OvkEntry) -> Option<&'a [u8]> {
        let start = entry.data_offset as usize;
        let end = start.checked_add(entry.data_size as usize)?;
        if end > self.bytes.len() {
            return None;
        }
        Some(&self.bytes[start..end])
    }

    /// First entry whose `sample_num` matches `sample_num`. Linear
    /// scan; OVK tables are small (Sweetie HD's largest carries 279
    /// entries).
    pub fn find_entry_by_sample_num(&self, sample_num: u32) -> Option<&OvkEntry> {
        self.entries.iter().find(|e| e.sample_num == sample_num)
    }
}

/// Decode the OVK file from `bytes`. Validates the entry table fits the
/// slice and that each entry's `(data_offset, data_size)` body fits the
/// slice; otherwise surfaces a typed error.
pub fn decode_ovk(bytes: &[u8]) -> Result<OvkFile<'_>, OvkDecodeError> {
    if bytes.len() < OVK_HEADER_BYTE_LEN {
        return Err(OvkDecodeError::HeaderTruncated {
            code: OVK_HEADER_TRUNCATED_CODE.to_string(),
            needed: OVK_HEADER_BYTE_LEN,
            actual: bytes.len(),
        });
    }
    let entry_count = u32_le(bytes, 0x00);
    let table_byte_len = (entry_count as usize).saturating_mul(OVK_ENTRY_BYTE_LEN);
    let table_end = OVK_HEADER_BYTE_LEN.saturating_add(table_byte_len);
    if bytes.len() < table_end {
        return Err(OvkDecodeError::EntryTableTruncated {
            code: OVK_ENTRY_TABLE_TRUNCATED_CODE.to_string(),
            entry_count,
            needed: table_end,
            actual: bytes.len(),
        });
    }
    let mut entries = Vec::with_capacity(entry_count as usize);
    for index in 0..entry_count {
        let offset = OVK_HEADER_BYTE_LEN + (index as usize) * OVK_ENTRY_BYTE_LEN;
        let data_size = u32_le(bytes, offset);
        let data_offset = u32_le(bytes, offset + 4);
        let sample_num = u32_le(bytes, offset + 8);
        let reserved = u32_le(bytes, offset + 12);
        let body_end = (data_offset as usize).saturating_add(data_size as usize);
        if body_end > bytes.len() {
            return Err(OvkDecodeError::EntryBodyOutOfBounds {
                code: OVK_ENTRY_BODY_OUT_OF_BOUNDS_CODE.to_string(),
                entry_index: index,
                data_offset,
                data_size,
                file_size: bytes.len(),
            });
        }
        entries.push(OvkEntry {
            data_size,
            data_offset,
            sample_num,
            reserved,
        });
    }
    Ok(OvkFile { entries, bytes })
}

#[inline]
fn u32_le(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic OVK file with `entries` and the inline body
    /// payloads concatenated after the table.
    fn synth_file(entries: &[(u32, u32, u32, u32)]) -> Vec<u8> {
        // Header.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        for (data_size, data_offset, sample_num, reserved) in entries {
            bytes.extend_from_slice(&data_size.to_le_bytes());
            bytes.extend_from_slice(&data_offset.to_le_bytes());
            bytes.extend_from_slice(&sample_num.to_le_bytes());
            bytes.extend_from_slice(&reserved.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn header_truncated_returns_typed_error() {
        let err = decode_ovk(&[0u8; 2]).expect_err("short input rejected");
        assert!(matches!(err, OvkDecodeError::HeaderTruncated { .. }));
    }

    #[test]
    fn entry_table_truncated_returns_typed_error() {
        // entry_count = 2 but only 16 bytes of body present.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&[0u8; OVK_ENTRY_BYTE_LEN]); // only one entry
        let err = decode_ovk(&bytes).expect_err("truncated table rejected");
        assert!(matches!(
            err,
            OvkDecodeError::EntryTableTruncated { entry_count: 2, .. }
        ));
    }

    #[test]
    fn empty_table_decodes_to_zero_entries() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0u32.to_le_bytes());
        let file = decode_ovk(&bytes).expect("decode");
        assert_eq!(file.entry_count(), 0);
    }

    #[test]
    fn entry_body_out_of_bounds_returns_typed_error() {
        // data_offset + data_size points past EOF.
        let mut bytes = synth_file(&[(1000, 100, 42, 0)]);
        bytes.extend_from_slice(&[0u8; 32]); // way less than required
        let err = decode_ovk(&bytes).expect_err("OOB body rejected");
        assert!(matches!(
            err,
            OvkDecodeError::EntryBodyOutOfBounds { entry_index: 0, .. }
        ));
    }

    #[test]
    fn entries_preserve_on_disk_order_not_sample_num_order() {
        // sample_num = 99 listed first, then sample_num = 1 — the
        // decoder MUST preserve on-disk order so a downstream
        // cross-reference can compute `index` ↔ `sample_num` mappings.
        let header_plus_table_len = OVK_HEADER_BYTE_LEN + 2 * OVK_ENTRY_BYTE_LEN;
        let first_body_offset = header_plus_table_len as u32;
        let second_body_offset = first_body_offset + 4;
        let mut bytes = synth_file(&[(4, first_body_offset, 99, 0), (4, second_body_offset, 1, 0)]);
        bytes.extend_from_slice(&[0u8; 8]);
        let file = decode_ovk(&bytes).expect("decode");
        assert_eq!(file.entries[0].sample_num, 99);
        assert_eq!(file.entries[1].sample_num, 1);
    }

    #[test]
    fn find_entry_by_sample_num_walks_table_in_order() {
        let header_plus_table_len = OVK_HEADER_BYTE_LEN + 3 * OVK_ENTRY_BYTE_LEN;
        let base = header_plus_table_len as u32;
        let mut bytes = synth_file(&[(2, base, 5, 0), (2, base + 2, 7, 0), (2, base + 4, 11, 0)]);
        bytes.extend_from_slice(&[0u8; 6]);
        let file = decode_ovk(&bytes).expect("decode");
        let found = file
            .find_entry_by_sample_num(7)
            .expect("sample_num=7 resolved");
        assert_eq!(found.data_offset, base + 2);
    }

    #[test]
    fn entry_body_view_borrows_into_file_bytes() {
        let header_plus_table_len = OVK_HEADER_BYTE_LEN + OVK_ENTRY_BYTE_LEN;
        let body_offset = header_plus_table_len as u32;
        let mut bytes = synth_file(&[(8, body_offset, 1, 0)]);
        let payload: [u8; 8] = *b"OggSPAGE";
        bytes.extend_from_slice(&payload);
        let file = decode_ovk(&bytes).expect("decode");
        let body = file
            .entry_body(&file.entries[0])
            .expect("body fits the file");
        assert_eq!(body, payload.as_slice());
        // Audit-focus pin: the first sample's raw bytes start with
        // OggS magic.
        assert_eq!(&body[..4], &OGG_PAGE_MAGIC);
    }

    #[test]
    fn audit_focus_entry_record_size_is_pinned_at_16_bytes() {
        // Audit-focus pin : "OVK entry size as
        // anything other than 16 bytes". The constant is the typed
        // surface; the spec verification test cross-references through
        // it.
        assert_eq!(
            OVK_ENTRY_BYTE_LEN, 16,
            "OVK entry record is documented at 16 bytes",
        );
    }
}
