//! Softpal `TEXT.DAT` string-pool codec: 16-byte header parse, flag-gated
//! **keyless** decrypt / re-encrypt, and the record (index + cp932 text + NUL)
//! parser that exposes each record's absolute byte offset.
//! See the crate-level docs for the container envelope; this module owns the
//! `TEXT.DAT` **inner file** (extracted from the PAC via [`crate::PacArchive`]).
//! # On-disk layout
//! ```text
//! offset 0: 16-byte header
//! byte 0: encryption flag ('$' = encrypted, '_' = plaintext)
//! bytes 1..12: magic tail ("TEXT_LIST__", 11 bytes)
//! bytes 12..16: record count (u32, little-endian)
//! offset 16: record pool (one contiguous run of `count` records)
//! record = [ 4-byte index (u32 LE) ][ cp932 text bytes ][ 0x00 terminator ]
//! A record is addressed by its **absolute byte offset** within the (decrypted)
//! pool — that is the pointer a `SCRIPT.SRC` string reference resolves to, which
//! is why [`TextRecord`] carries both [`TextRecord::offset`] (start of the
//! 4-byte index) and [`TextRecord::text_offset`] (start of the text bytes).
//! # Keyless decryption (flag-gated, deterministic)
//! When byte 0 is `'$'` the pool is obfuscated by a fixed, keyless scheme that
//! transforms one little-endian dword at a time, starting at offset 16, stride
//! 4. For the *k*-th dword (k = 0 at offset 16) with `shift = 4 + k`:
//! - decrypt: `b[0] = rol8(b[0], shift)`, then `dword ^= 0x084DF873 ^ 0xFF987DEE`
//! - encrypt: `dword ^= 0x084DF873 ^ 0xFF987DEE`, then `b[0] = ror8(b[0], shift)`
//!   The 16-byte header is never transformed, and — matching the Softpal engine /
//!   the SoftPal-Tool `pal_file_decrypt.py` oracle — the trailing bytes at
//!   `file_len - 4..` are left untouched (the loop stops before the final dword).
//!   The transform is a pure permutation, so [`encrypt`] is the exact inverse of
//!   [`decrypt`]: `encrypt(decrypt(x)) == x` byte-for-byte (round-trip proof in
//!   the tests).
//! # Honest scope
//! This is the `TEXT.DAT` **codec only**: header + flag-gated cipher + record
//! framing + cp932 decode. Resolving which string a line of dialogue uses
//! (the `SCRIPT.SRC` `Sv`-version disassembler) and writing edited text back
//! into a repacked pool (patch-back) are **separate Softpal nodes**.
//! # Determinism / no shell-outs
//! Pure functions of the input `&[u8]`; the oracle is a reference only. No
//! `Command::new`. Malformed input never panics: every failure is a typed
//! [`TextDatError`].

use encoding_rs::SHIFT_JIS;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Length of the fixed `TEXT.DAT` header. The record pool begins here.
pub const TEXTDAT_HEADER_BYTE_LEN: usize = 16;

/// The 11-byte magic tail occupying header bytes `1..12`. Byte 0 (the
/// encryption flag) is deliberately excluded — it varies per file.
pub const TEXTDAT_MAGIC_TAIL: &[u8; 11] = b"TEXT_LIST__";

/// Header byte 0 when the record pool is encrypted (`b'$'`, `0x24`).
pub const TEXTDAT_FLAG_ENCRYPTED: u8 = b'$';

/// Header byte 0 when the record pool is stored in the clear (`b'_'`, `0x5F`).
pub const TEXTDAT_FLAG_PLAINTEXT: u8 = b'_';

/// Byte offset of the little-endian `u32` record **count** within the header.
pub const TEXTDAT_COUNT_OFFSET: usize = 12;

/// Byte length of a record's leading index field (`u32`, little-endian).
pub const TEXTDAT_RECORD_INDEX_BYTE_LEN: usize = 4;

/// The two 32-bit constants XOR-folded into every transformed dword. Kept as a
/// declared pair (rather than the pre-folded value) to mirror the format /
/// oracle exactly; the effective mask is their XOR.
pub const TEXTDAT_XOR_A: u32 = 0x084D_F873;
/// See [`TEXTDAT_XOR_A`].
pub const TEXTDAT_XOR_B: u32 = 0xFF98_7DEE;

/// The per-dword rotate amount for the first transformed dword (offset 16); it
/// increments by one for each subsequent dword.
pub const TEXTDAT_INITIAL_SHIFT: u32 = 4;

/// Whether a `TEXT.DAT`'s record pool is encrypted, per header byte 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EncFlag {
    /// Byte 0 is `'$'`: the pool is obfuscated by the keyless cipher.
    Encrypted,
    /// Byte 0 is `'_'`: the pool is stored in the clear.
    Plaintext,
}

impl EncFlag {
    /// The header byte 0 value this flag corresponds to.
    #[must_use]
    pub const fn as_byte(self) -> u8 {
        match self {
            EncFlag::Encrypted => TEXTDAT_FLAG_ENCRYPTED,
            EncFlag::Plaintext => TEXTDAT_FLAG_PLAINTEXT,
        }
    }
}

/// The parsed 16-byte `TEXT.DAT` header.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDatHeader {
    /// Encryption flag decoded from byte 0.
    pub flag: EncFlag,
    /// Declared record count (`u32` @ [`TEXTDAT_COUNT_OFFSET`]).
    pub record_count: u32,
}

/// One record recovered from the (decrypted) pool.
/// [`raw_text`](Self::raw_text) holds the cp932 bytes as stored (terminator
/// excluded); [`text`](Self::text) is the lossy UTF-8 decoding. Both byte
/// offsets are absolute within the pool buffer so a `SCRIPT.SRC` pointer can
/// resolve straight to a record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRecord {
    /// The record's leading 4-byte index field (`u32`, little-endian).
    pub index: u32,
    /// Absolute byte offset of the record (start of the 4-byte index field).
    pub offset: usize,
    /// Absolute byte offset of the first text byte (== `offset + 4`).
    pub text_offset: usize,
    /// The record's cp932 text bytes, terminator excluded.
    #[serde(skip)]
    pub raw_text: Vec<u8>,
    /// The text decoded cp932 → UTF-8 (lossy: undecodable bytes become U+FFFD).
    pub text: String,
}

/// A fully parsed `TEXT.DAT`: header plus the decoded record pool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDat {
    /// The parsed header.
    pub header: TextDatHeader,
    /// The records, in pool order. `records.len == header.record_count`.
    pub records: Vec<TextRecord>,
}

/// Fatal errors raised while parsing / transforming a `TEXT.DAT`.
/// Every display string begins with the `kaifuu.softpal.textdat` namespace
/// marker (see [`crate::SOFTPAL_TEXTDAT_ERROR_MARKER`]).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TextDatError {
    /// The buffer is shorter than the fixed 16-byte header.
    #[error(
        "kaifuu.softpal.textdat.truncated_header: length {observed_len} is shorter than the fixed \
         {TEXTDAT_HEADER_BYTE_LEN}-byte header"
    )]
    TruncatedHeader { observed_len: usize },
    /// Header bytes `1..12` are not `"TEXT_LIST__"`.
    #[error(
        "kaifuu.softpal.textdat.bad_magic: expected magic tail {expected:02X?} (\"TEXT_LIST__\") \
         at offset 1, found {found:02X?}"
    )]
    BadMagic { expected: [u8; 11], found: [u8; 11] },
    /// Header byte 0 is neither `'$'` nor `'_'`.
    #[error(
        "kaifuu.softpal.textdat.invalid_flag: header byte 0 is {found:#04x}, expected \
         {enc:#04x} ('$') or {plain:#04x} ('_')"
    )]
    InvalidFlag { found: u8, enc: u8, plain: u8 },
    /// A record's 4-byte index field runs past the end of the pool.
    #[error(
        "kaifuu.softpal.textdat.truncated_record_index: record {record} at offset {offset} needs \
         a 4-byte index but only {available} bytes remain"
    )]
    TruncatedRecordIndex {
        record: usize,
        offset: usize,
        available: usize,
    },
    /// A record's text has no `0x00` terminator before the end of the pool.
    #[error(
        "kaifuu.softpal.textdat.unterminated_record: record {record} text starting at offset \
         {text_offset} has no NUL terminator before end of pool"
    )]
    UnterminatedRecord { record: usize, text_offset: usize },
    /// The number of records recovered from the pool differs from the header's
    /// declared count.
    #[error(
        "kaifuu.softpal.textdat.record_count_mismatch: header declares {header_count} records but \
         the pool yielded {parsed_count}"
    )]
    RecordCountMismatch {
        header_count: u32,
        parsed_count: u32,
    },
}

/// Rotate a byte left by `shift & 7` bits.
#[inline]
fn rol8(byte: u8, shift: u32) -> u8 {
    byte.rotate_left(shift % 8)
}

/// Rotate a byte right by `shift & 7` bits (inverse of [`rol8`]).
#[inline]
fn ror8(byte: u8, shift: u32) -> u8 {
    byte.rotate_right(shift % 8)
}

impl TextDatHeader {
    /// Parse the 16-byte header from the front of `bytes`.
    /// # Errors
    /// [`TextDatError::TruncatedHeader`] for a short buffer,
    /// [`TextDatError::BadMagic`] for a wrong magic tail, or
    /// [`TextDatError::InvalidFlag`] for an unrecognised byte 0.
    pub fn parse(bytes: &[u8]) -> Result<Self, TextDatError> {
        if bytes.len() < TEXTDAT_HEADER_BYTE_LEN {
            return Err(TextDatError::TruncatedHeader {
                observed_len: bytes.len(),
            });
        }
        let mut tail = [0u8; 11];
        tail.copy_from_slice(&bytes[1..12]);
        if &tail != TEXTDAT_MAGIC_TAIL {
            return Err(TextDatError::BadMagic {
                expected: *TEXTDAT_MAGIC_TAIL,
                found: tail,
            });
        }
        let flag = match bytes[0] {
            TEXTDAT_FLAG_ENCRYPTED => EncFlag::Encrypted,
            TEXTDAT_FLAG_PLAINTEXT => EncFlag::Plaintext,
            found => {
                return Err(TextDatError::InvalidFlag {
                    found,
                    enc: TEXTDAT_FLAG_ENCRYPTED,
                    plain: TEXTDAT_FLAG_PLAINTEXT,
                });
            }
        };
        let mut cnt = [0u8; 4];
        cnt.copy_from_slice(&bytes[TEXTDAT_COUNT_OFFSET..TEXTDAT_COUNT_OFFSET + 4]);
        Ok(Self {
            flag,
            record_count: u32::from_le_bytes(cnt),
        })
    }
}

/// The set of `(offset, shift)` dword slots the cipher touches, matching the
/// oracle's `range(16, len - 4, 4)`: from offset 16, stride 4, stopping before
/// the final 4 bytes so the trailing dword is left untouched.
fn transformed_slots(file_len: usize) -> impl Iterator<Item = (usize, u32)> {
    // Upper bound (exclusive) on the *start* offset of a transformed dword.
    let limit = file_len.saturating_sub(4);
    (TEXTDAT_HEADER_BYTE_LEN..limit)
        .step_by(4)
        .enumerate()
        .map(|(k, off)| (off, TEXTDAT_INITIAL_SHIFT + k as u32))
}

/// Read/modify/write one little-endian dword at `off` under `op`.
fn map_dword(buf: &mut [u8], off: usize, op: impl FnOnce(u32) -> u32) {
    let mut d = [0u8; 4];
    d.copy_from_slice(&buf[off..off + 4]);
    let out = op(u32::from_le_bytes(d)).to_le_bytes();
    buf[off..off + 4].copy_from_slice(&out);
}

/// Apply the in-place decrypt transform to `buf` (the whole file; the header is
/// not touched). Caller ensures `buf`'s byte 0 was `'$'`.
fn transform_decrypt(buf: &mut [u8]) {
    let mask = TEXTDAT_XOR_A ^ TEXTDAT_XOR_B;
    for (off, shift) in transformed_slots(buf.len()) {
        buf[off] = rol8(buf[off], shift);
        map_dword(buf, off, |d| d ^ mask);
    }
}

/// Apply the in-place encrypt transform to `buf` — the exact inverse of
/// [`transform_decrypt`] (XOR first, then rotate the low byte right).
fn transform_encrypt(buf: &mut [u8]) {
    let mask = TEXTDAT_XOR_A ^ TEXTDAT_XOR_B;
    for (off, shift) in transformed_slots(buf.len()) {
        map_dword(buf, off, |d| d ^ mask);
        buf[off] = ror8(buf[off], shift);
    }
}

/// Decrypt a `TEXT.DAT` into its plaintext form.
/// Flag-gated and idempotent: if byte 0 is `'$'` the pool is decrypted and byte
/// 0 is rewritten to `'_'`; if it is already `'_'` an unchanged copy is
/// returned. The returned buffer always has a `'_'` (plaintext) header.
/// # Errors
/// Propagates [`TextDatHeader::parse`] errors (bad length / magic / flag).
pub fn decrypt(bytes: &[u8]) -> Result<Vec<u8>, TextDatError> {
    let header = TextDatHeader::parse(bytes)?;
    let mut out = bytes.to_vec();
    if header.flag == EncFlag::Encrypted {
        transform_decrypt(&mut out);
        out[0] = TEXTDAT_FLAG_PLAINTEXT;
    }
    Ok(out)
}

/// Encrypt a plaintext `TEXT.DAT` — the exact inverse of [`decrypt`].
/// Flag-gated and idempotent: if byte 0 is `'_'` the pool is encrypted and byte
/// 0 is rewritten to `'$'`; if it is already `'$'` an unchanged copy is
/// returned. Thus `encrypt(decrypt(x)) == x` byte-for-byte for any well-formed
/// `TEXT.DAT`.
/// # Errors
/// Propagates [`TextDatHeader::parse`] errors (bad length / magic / flag).
pub fn encrypt(bytes: &[u8]) -> Result<Vec<u8>, TextDatError> {
    let header = TextDatHeader::parse(bytes)?;
    let mut out = bytes.to_vec();
    if header.flag == EncFlag::Plaintext {
        transform_encrypt(&mut out);
        out[0] = TEXTDAT_FLAG_ENCRYPTED;
    }
    Ok(out)
}

/// Parse the records out of an already-**plaintext** pool.
/// `plaintext` is a full `TEXT.DAT` buffer whose header/pool are in the clear
/// (typically the output of [`decrypt`]). The pool (offset 16 onward) is parsed
/// **greedily to its end** — every byte after the header belongs to exactly one
/// record — and the recovered record count is then asserted against the
/// header's declared count. A record that begins but cannot complete (no room
/// for its 4-byte index, or no `0x00` terminator) is a precise typed error,
/// distinct from a whole-pool count mismatch.
/// # Errors
/// [`TextDatError::TruncatedRecordIndex`] if the trailing bytes are too short
/// for another record's index, [`TextDatError::UnterminatedRecord`] if a
/// record's text has no terminator, [`TextDatError::RecordCountMismatch`] if the
/// number of records the pool actually holds differs from the header's count,
/// plus any header-parse error.
pub fn parse_records(plaintext: &[u8]) -> Result<Vec<TextRecord>, TextDatError> {
    let header = TextDatHeader::parse(plaintext)?;
    let mut records = Vec::with_capacity(header.record_count as usize);
    let mut cursor = TEXTDAT_HEADER_BYTE_LEN;

    // Every byte past the header is part of some record: keep consuming records
    // until the pool is exactly exhausted.
    while cursor < plaintext.len() {
        let record = records.len();
        if cursor + TEXTDAT_RECORD_INDEX_BYTE_LEN > plaintext.len() {
            return Err(TextDatError::TruncatedRecordIndex {
                record,
                offset: cursor,
                available: plaintext.len() - cursor,
            });
        }
        let mut idx = [0u8; 4];
        idx.copy_from_slice(&plaintext[cursor..cursor + TEXTDAT_RECORD_INDEX_BYTE_LEN]);
        let index = u32::from_le_bytes(idx);

        let text_offset = cursor + TEXTDAT_RECORD_INDEX_BYTE_LEN;
        let nul = plaintext[text_offset..]
            .iter()
            .position(|&b| b == 0)
            .map(|p| text_offset + p)
            .ok_or(TextDatError::UnterminatedRecord {
                record,
                text_offset,
            })?;

        let raw_text = plaintext[text_offset..nul].to_vec();
        let text = SHIFT_JIS.decode(&raw_text).0.into_owned();
        records.push(TextRecord {
            index,
            offset: cursor,
            text_offset,
            raw_text,
            text,
        });
        cursor = nul + 1;
    }

    // The pool held exactly `records.len` records; the header must agree.
    if records.len() as u32 != header.record_count {
        return Err(TextDatError::RecordCountMismatch {
            header_count: header.record_count,
            parsed_count: records.len() as u32,
        });
    }
    Ok(records)
}

impl TextDat {
    /// Parse a raw `TEXT.DAT` (as extracted from the PAC) end to end: read the
    /// header, [`decrypt`] the pool if the flag says so, then [`parse_records`].
    /// # Errors
    /// Any [`TextDatError`] from header parse, decrypt, or record parse.
    pub fn parse(bytes: &[u8]) -> Result<Self, TextDatError> {
        let header = TextDatHeader::parse(bytes)?;
        let plaintext = decrypt(bytes)?;
        let records = parse_records(&plaintext)?;
        Ok(Self { header, records })
    }
}

#[cfg(test)]
#[path = "textdat_tests.rs"]
mod tests;
