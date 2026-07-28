//! Softpal `FILE.DAT` resource-name table.
//!
//! A file starts with `_$FILE_LIST__` and a little-endian count, followed by
//! fixed 32-byte cp932 slots. `$` files use the same observed dword transform
//! as the encrypted `TEXT.DAT` pool; `_` files store their slots directly.

use encoding_rs::SHIFT_JIS;
use thiserror::Error;

use crate::{TEXTDAT_INITIAL_SHIFT, TEXTDAT_XOR_A, TEXTDAT_XOR_B};

/// Bytes 1 through 11 of a `FILE.DAT` header.
pub const FILEDAT_MAGIC_TAIL: &[u8; 11] = b"FILE_LIST__";
/// `FILE.DAT` header length in bytes.
pub const FILEDAT_HEADER_BYTE_LEN: usize = 16;
/// Width of one NUL-terminated resource-name slot.
pub const FILEDAT_SLOT_BYTE_LEN: usize = 0x20;

/// Parsed resource-name slots from a Softpal `FILE.DAT`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileDat {
    slots: Vec<String>,
}

/// Failures while decoding a resource-name table.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum FileDatError {
    #[error(
        "kaifuu.softpal.filedat.truncated_header: length {observed_len} is shorter than {FILEDAT_HEADER_BYTE_LEN}"
    )]
    TruncatedHeader { observed_len: usize },
    #[error("kaifuu.softpal.filedat.bad_magic: expected FILE_LIST__ at byte 1")]
    BadMagic,
    #[error(
        "kaifuu.softpal.filedat.truncated_slots: header declares {count} slots ({required_len} bytes) but file is {observed_len} bytes"
    )]
    TruncatedSlots {
        count: u32,
        required_len: usize,
        observed_len: usize,
    },
}

impl FileDat {
    /// Decode fixed-width resource slots. Invalid cp932 sequences are decoded
    /// lossily because a caller still needs a deterministic, inspectable slot
    /// value; resource resolution separately rejects non-resource strings.
    pub fn parse(bytes: &[u8]) -> Result<Self, FileDatError> {
        if bytes.len() < FILEDAT_HEADER_BYTE_LEN {
            return Err(FileDatError::TruncatedHeader {
                observed_len: bytes.len(),
            });
        }
        if &bytes[1..12] != FILEDAT_MAGIC_TAIL {
            return Err(FileDatError::BadMagic);
        }
        let count = u32::from_le_bytes(bytes[12..16].try_into().expect("header count"));
        let required_len = FILEDAT_HEADER_BYTE_LEN
            .checked_add((count as usize).saturating_mul(FILEDAT_SLOT_BYTE_LEN))
            .ok_or(FileDatError::TruncatedSlots {
                count,
                required_len: usize::MAX,
                observed_len: bytes.len(),
            })?;
        if bytes.len() < required_len {
            return Err(FileDatError::TruncatedSlots {
                count,
                required_len,
                observed_len: bytes.len(),
            });
        }

        let mut plaintext = bytes[..required_len].to_vec();
        if plaintext[0] == b'$' {
            let mask = TEXTDAT_XOR_A ^ TEXTDAT_XOR_B;
            for (index, offset) in (FILEDAT_HEADER_BYTE_LEN..plaintext.len().saturating_sub(4))
                .step_by(4)
                .enumerate()
            {
                plaintext[offset] =
                    plaintext[offset].rotate_left((TEXTDAT_INITIAL_SHIFT + index as u32) % 8);
                let word = u32::from_le_bytes(
                    plaintext[offset..offset + 4]
                        .try_into()
                        .expect("four-byte encrypted word"),
                ) ^ mask;
                plaintext[offset..offset + 4].copy_from_slice(&word.to_le_bytes());
            }
        } else if plaintext[0] != b'_' {
            return Err(FileDatError::BadMagic);
        }

        let slots = plaintext[FILEDAT_HEADER_BYTE_LEN..]
            .chunks_exact(FILEDAT_SLOT_BYTE_LEN)
            .map(|slot| {
                let end = slot
                    .iter()
                    .position(|byte| *byte == 0)
                    .unwrap_or(slot.len());
                let (decoded, _, _) = SHIFT_JIS.decode(&slot[..end]);
                decoded.into_owned()
            })
            .collect();
        Ok(Self { slots })
    }

    /// Return a resource-name slot by its script-visible index.
    #[must_use]
    pub fn slot(&self, index: usize) -> Option<&str> {
        self.slots.get(index).map(String::as_str)
    }

    /// Number of declared slots.
    #[must_use]
    pub fn len(&self) -> usize {
        self.slots.len()
    }

    /// Whether the table declares no slots.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_dat(flag: u8, slots: &[&str]) -> Vec<u8> {
        let mut bytes = Vec::from([flag]);
        bytes.extend_from_slice(FILEDAT_MAGIC_TAIL);
        bytes.extend_from_slice(&(slots.len() as u32).to_le_bytes());
        for value in slots {
            let mut slot = [0_u8; FILEDAT_SLOT_BYTE_LEN];
            slot[..value.len()].copy_from_slice(value.as_bytes());
            bytes.extend_from_slice(&slot);
        }
        bytes
    }

    #[test]
    fn parses_plaintext_fixed_width_resource_slots() {
        let table = FileDat::parse(&file_dat(b'_', &["FONT.DAT", "ANI_001.ANI"]))
            .expect("well-formed plaintext table");
        assert_eq!(table.len(), 2);
        assert_eq!(table.slot(0), Some("FONT.DAT"));
        assert_eq!(table.slot(1), Some("ANI_001.ANI"));
    }

    #[test]
    fn rejects_a_declared_slot_run_past_eof() {
        let mut bytes = file_dat(b'_', &["FONT.DAT"]);
        bytes.truncate(FILEDAT_HEADER_BYTE_LEN + 3);
        assert!(matches!(
            FileDat::parse(&bytes),
            Err(FileDatError::TruncatedSlots { .. })
        ));
    }
}
