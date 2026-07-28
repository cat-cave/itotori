use std::fmt;

use encoding_rs::SHIFT_JIS;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use utsushi_core::substrate::{
    Inspectable, Restorable, RestoreReport, SnapshotError, StatePath, StateTree, StateValue,
};

/// Byte length of the AVG-derived preamble (everything before the
/// variable-length null-terminated magic string).
pub const AVG_SAVE_PREAMBLE_BYTE_LEN: usize = 0x18;

/// Magic string of the per-slot system save (`REALLIVE.sav`). Pinned as
/// a `&str` so the audit grep can match the literal without scraping a
/// `Display` body.
pub const SYSTEM_SAVE_MAGIC: &str = "AVG_SYSTEM_SAVE";

/// Magic string of the global save (`save999.sav`).
pub const GLOBAL_SAVE_MAGIC: &str = "AVG_GLOBAL_SAVE";

/// Documented `SAVE_FORMAT` Gameexe value the AVG-derived save format
/// declares (`#SAVE_FORMAT=3`). Carried as a typed `u32` so a future
/// schema bump can be detected at parse time.
pub const SAVE_FORMAT_AVG_DERIVED: u32 = 3;

/// Default compiler-version stamp carried at preamble offset `0x04`
/// (`0x00002712 = 10002`) for the AVG-derived save format. This is the
/// engine-format default the synthetic save builders stamp when a caller
/// does not supply an explicit `compiler_version`; the real per-title
/// value is read from (and asserted against) the game's own save bytes.
pub const AVG_DERIVED_COMPILER_VERSION: u32 = 10_002;

/// Stable Utsushi save semantic codes. Used by the audit grep so a
/// `Display`-rendered error can be matched without parsing the variant
/// list.
pub mod codes {
    /// The preamble's leading u32 (file size, for `REALLIVE.sav`) did
    /// not match the actual length of the supplied byte slice.
    pub const PREAMBLE_FILE_SIZE_MISMATCH: &str =
        "utsushi.reallive.save.preamble_file_size_mismatch";
    /// The byte slice was shorter than the 24-byte preamble.
    pub const PREAMBLE_TRUNCATED: &str = "utsushi.reallive.save.preamble_truncated";
    /// The magic string at offset 0x18 did not match the expected pin
    /// (`SYSTEM_SAVE_MAGIC` / `GLOBAL_SAVE_MAGIC`).
    pub const MAGIC_MISMATCH: &str = "utsushi.reallive.save.magic_mismatch";
    /// The magic string at offset 0x18 was not null-terminated within
    /// the supplied byte slice.
    pub const MAGIC_UNTERMINATED: &str = "utsushi.reallive.save.magic_unterminated";
    /// The magic string at offset 0x18 contained Shift-JIS bytes that
    /// `encoding_rs` could not decode without a replacement.
    pub const SHIFT_JIS_DECODE_FAILURE: &str = "utsushi.reallive.save.shift_jis_decode_failure";
    /// `SaveState` restore observed an unknown state path under the
    /// `port.save_state.*` namespace.
    pub const STATE_PATH_UNKNOWN: &str = "utsushi.reallive.save.state_path_unknown";
    /// `SaveState` restore observed a hex payload that did not parse.
    pub const STATE_HEX_DECODE_FAILURE: &str = "utsushi.reallive.save.state_hex_decode_failure";

    /// Full additive code registry. Used by audit tooling that needs to
    /// pin "every save-format semantic code is in this list".
    pub const ALL: &[&str] = &[
        PREAMBLE_FILE_SIZE_MISMATCH,
        PREAMBLE_TRUNCATED,
        MAGIC_MISMATCH,
        MAGIC_UNTERMINATED,
        SHIFT_JIS_DECODE_FAILURE,
        STATE_PATH_UNKNOWN,
        STATE_HEX_DECODE_FAILURE,
    ];
}

/// Typed error surface for the save decoders. Every failure is a named
/// variant; the parsers never return `Ok(None)` and never silently
/// pad / truncate.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SaveDecodeError {
    /// The supplied byte slice is shorter than the 24-byte preamble.
    #[error("utsushi.reallive.save.preamble_truncated: have={have} need={need}")]
    PreambleTruncated {
        /// Bytes actually supplied.
        have: usize,
        /// Bytes required ([`AVG_SAVE_PREAMBLE_BYTE_LEN`]).
        need: usize,
    },
    /// The preamble's leading u32 (declared file size) did not match
    /// the actual length of the supplied byte slice. This is the
    /// audit-focus "silently truncating slots" guard for
    /// `REALLIVE.sav`.
    #[error(
        "utsushi.reallive.save.preamble_file_size_mismatch: declared={declared} actual={actual}"
    )]
    PreambleFileSizeMismatch {
        /// File size declared in the preamble (`leading_u32`).
        declared: u32,
        /// Actual length of the supplied byte slice.
        actual: usize,
    },
    /// The magic string at offset 0x18 was not null-terminated within
    /// the supplied byte slice.
    #[error("utsushi.reallive.save.magic_unterminated: search_len={search_len}")]
    MagicUnterminated {
        /// Number of bytes searched before EOF was hit.
        search_len: usize,
    },
    /// The magic string at offset 0x18 did not match the expected pin
    /// (`SYSTEM_SAVE_MAGIC` for `SystemSave::decode`
    /// `GLOBAL_SAVE_MAGIC` for `GlobalSave::decode`).
    #[error("utsushi.reallive.save.magic_mismatch: observed={observed:?} expected={expected:?}")]
    MagicMismatch {
        /// Magic string the parser observed at offset 0x18.
        observed: String,
        /// Magic string the parser expected.
        expected: &'static str,
    },
    /// `encoding_rs` reported a replacement byte while decoding the
    /// Shift-JIS title in `ReadFlags::decode`.
    #[error("utsushi.reallive.save.shift_jis_decode_failure: byte_len={byte_len}")]
    ShiftJisDecodeFailure {
        /// Length of the title byte slice that failed to decode.
        byte_len: usize,
    },
}

impl SaveDecodeError {
    /// Stable `utsushi.reallive.save.*` semantic code for this variant.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::PreambleTruncated { .. } => codes::PREAMBLE_TRUNCATED,
            Self::PreambleFileSizeMismatch { .. } => codes::PREAMBLE_FILE_SIZE_MISMATCH,
            Self::MagicUnterminated { .. } => codes::MAGIC_UNTERMINATED,
            Self::MagicMismatch { .. } => codes::MAGIC_MISMATCH,
            Self::ShiftJisDecodeFailure { .. } => codes::SHIFT_JIS_DECODE_FAILURE,
        }
    }
}

/// Typed reader/writer for the 24-byte AVG-derived save preamble. The
/// `leading_u32` is the file size for `REALLIVE.sav`; for the other
/// two saves it is a per-format constant whose semantics we do not
/// interpret here (it round-trips verbatim).
///
/// The six u16 timestamp fields are stored verbatim so an observed
/// save written by `RealLive.exe` on 2025-03-02 11:18:39 round-trips
/// byte-identically through `encode`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AvgSavePreamble {
    /// File size in bytes (for `REALLIVE.sav`) or a per-format
    /// constant (for `save999.sav` / `read.sav`). At offset `0x00..0x04`.
    pub leading_u32: u32,
    /// Compiler-version stamp (default
    /// [`AVG_DERIVED_COMPILER_VERSION`] = 10 002). At offset
    /// `0x04..0x08`; the real per-title value is read from the game's
    /// own save bytes.
    pub compiler_version: u32,
    /// Engine timestamp (year, month, day, hour, minute, second) as
    /// six little-endian u16s. At offset `0x08..0x14`.
    pub timestamp: [u16; 6],
    /// Reserved u16 at offset `0x14..0x16`. Zero on every observed
    /// observed save; round-tripped verbatim.
    pub padding_a: u16,
    /// Trailing u16 at offset `0x16..0x18` (`0x02DC` for
    /// `REALLIVE.sav`, `0x02E0` for `save999.sav`, `0x02E7` for
    /// `read.sav` per the audit doc). Round-tripped verbatim.
    pub tail: u16,
}

impl AvgSavePreamble {
    /// Decode the 24-byte preamble from `bytes[0..0x18]`. Returns
    /// [`SaveDecodeError::PreambleTruncated`] when `bytes.len() < 0x18`.
    pub fn decode(bytes: &[u8]) -> Result<Self, SaveDecodeError> {
        if bytes.len() < AVG_SAVE_PREAMBLE_BYTE_LEN {
            return Err(SaveDecodeError::PreambleTruncated {
                have: bytes.len(),
                need: AVG_SAVE_PREAMBLE_BYTE_LEN,
            });
        }
        let leading_u32 =
            u32::from_le_bytes(bytes[0x00..0x04].try_into().expect("preamble u32 #0"));
        let compiler_version =
            u32::from_le_bytes(bytes[0x04..0x08].try_into().expect("preamble u32 #1"));
        let mut timestamp = [0u16; 6];
        for (idx, slot) in timestamp.iter_mut().enumerate() {
            let off = 0x08 + idx * 2;
            *slot = u16::from_le_bytes(bytes[off..off + 2].try_into().expect("preamble u16"));
        }
        let padding_a = u16::from_le_bytes(bytes[0x14..0x16].try_into().expect("preamble u16 pad"));
        let tail = u16::from_le_bytes(bytes[0x16..0x18].try_into().expect("preamble u16 tail"));
        Ok(Self {
            leading_u32,
            compiler_version,
            timestamp,
            padding_a,
            tail,
        })
    }

    /// Encode the preamble back into a 24-byte little-endian buffer.
    /// The encode / decode pair is byte-identical (audit-focus
    /// "endianness flips between read and write").
    pub fn encode(&self) -> [u8; AVG_SAVE_PREAMBLE_BYTE_LEN] {
        let mut out = [0u8; AVG_SAVE_PREAMBLE_BYTE_LEN];
        out[0x00..0x04].copy_from_slice(&self.leading_u32.to_le_bytes());
        out[0x04..0x08].copy_from_slice(&self.compiler_version.to_le_bytes());
        for (idx, value) in self.timestamp.iter().enumerate() {
            let off = 0x08 + idx * 2;
            out[off..off + 2].copy_from_slice(&value.to_le_bytes());
        }
        out[0x14..0x16].copy_from_slice(&self.padding_a.to_le_bytes());
        out[0x16..0x18].copy_from_slice(&self.tail.to_le_bytes());
        out
    }
}

/// Read a null-terminated byte slice at `offset`. Returns the bytes up
/// to (but not including) the null, plus the byte index of the null.
/// Returns [`SaveDecodeError::MagicUnterminated`] when EOF is reached
/// without a null.
fn read_nul_terminated(bytes: &[u8], offset: usize) -> Result<(&[u8], usize), SaveDecodeError> {
    let tail = bytes
        .get(offset..)
        .ok_or(SaveDecodeError::MagicUnterminated {
            search_len: bytes.len().saturating_sub(offset),
        })?;
    for (idx, byte) in tail.iter().enumerate() {
        if *byte == 0 {
            return Ok((&tail[..idx], offset + idx));
        }
    }
    Err(SaveDecodeError::MagicUnterminated {
        search_len: tail.len(),
    })
}

/// Typed reader/writer for `REALLIVE.sav` (per-slot system save).
///
/// The "leading_u32 cross-checks against the actual file size"
/// invariant the spec acceptance criterion names is enforced at
/// `decode` time: a mismatch returns
/// [`SaveDecodeError::PreambleFileSizeMismatch`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemSave {
    /// 24-byte preamble. `preamble.leading_u32 == bytes.len()` always
    /// holds for a `decode`d value.
    pub preamble: AvgSavePreamble,
    /// Variable-length payload after `AVG_SYSTEM_SAVE\0`. Held as
    /// `Vec<u8>` so the per-slot record layout (which we do not
    /// interpret here) round-trips verbatim.
    pub payload: Vec<u8>,
}

impl SystemSave {
    /// Decode a `REALLIVE.sav` from a byte slice. Validates the
    /// preamble file-size cross-check + the magic string at offset
    /// `0x18`.
    pub fn decode(bytes: &[u8]) -> Result<Self, SaveDecodeError> {
        let preamble = AvgSavePreamble::decode(bytes)?;
        if preamble.leading_u32 as usize != bytes.len() {
            return Err(SaveDecodeError::PreambleFileSizeMismatch {
                declared: preamble.leading_u32,
                actual: bytes.len(),
            });
        }
        let (magic_bytes, nul_offset) = read_nul_terminated(bytes, AVG_SAVE_PREAMBLE_BYTE_LEN)?;
        if magic_bytes != SYSTEM_SAVE_MAGIC.as_bytes() {
            return Err(SaveDecodeError::MagicMismatch {
                observed: String::from_utf8_lossy(magic_bytes).into_owned(),
                expected: SYSTEM_SAVE_MAGIC,
            });
        }
        let payload_start = nul_offset + 1;
        Ok(Self {
            preamble,
            payload: bytes[payload_start..].to_vec(),
        })
    }

    /// Encode the system save back to a byte vector. Byte-identical to
    /// the input when the preamble was `decode`d from the same bytes.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            AVG_SAVE_PREAMBLE_BYTE_LEN + SYSTEM_SAVE_MAGIC.len() + 1 + self.payload.len(),
        );
        out.extend_from_slice(&self.preamble.encode());
        out.extend_from_slice(SYSTEM_SAVE_MAGIC.as_bytes());
        out.push(0u8);
        out.extend_from_slice(&self.payload);
        out
    }
}

/// Typed reader/writer for `save999.sav` (global save).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GlobalSave {
    /// 24-byte preamble. The leading u32 is a per-format constant
    /// (`0x000000A4` in the observed corpus); the file-size cross-check from
    /// [`SystemSave`] does **not** apply here, so the parser does not
    /// enforce it.
    pub preamble: AvgSavePreamble,
    /// Variable-length payload after `AVG_GLOBAL_SAVE\0`.
    pub payload: Vec<u8>,
}

impl GlobalSave {
    /// Decode a `save999.sav` from a byte slice.
    ///
    /// **Slot-end safety asymmetry (by design).** Unlike
    /// [`SystemSave::decode`], this format's `leading_u32` is a
    /// per-format constant (`0xA4`), *not* the file size, so the
    /// `leading_u32 == bytes.len()` cross-check that guards `SystemSave`
    /// against a truncated payload does **not** apply here. Slot-end
    /// safety therefore rests entirely on the null-terminated magic-string
    /// check below: a truncation that severs the payload but leaves the
    /// `AVG_GLOBAL_SAVE\0` magic intact decodes without a diagnostic. This
    /// is intentional — there is no cross-check available to add without a
    /// per-format payload-length field, which the on-disk format does not
    /// carry. Documented so the audit-focus "silently truncating slots"
    /// pin is not re-flagged against `GlobalSave`.
    pub fn decode(bytes: &[u8]) -> Result<Self, SaveDecodeError> {
        let preamble = AvgSavePreamble::decode(bytes)?;
        let (magic_bytes, nul_offset) = read_nul_terminated(bytes, AVG_SAVE_PREAMBLE_BYTE_LEN)?;
        if magic_bytes != GLOBAL_SAVE_MAGIC.as_bytes() {
            return Err(SaveDecodeError::MagicMismatch {
                observed: String::from_utf8_lossy(magic_bytes).into_owned(),
                expected: GLOBAL_SAVE_MAGIC,
            });
        }
        let payload_start = nul_offset + 1;
        Ok(Self {
            preamble,
            payload: bytes[payload_start..].to_vec(),
        })
    }

    /// Encode the global save back to a byte vector.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            AVG_SAVE_PREAMBLE_BYTE_LEN + GLOBAL_SAVE_MAGIC.len() + 1 + self.payload.len(),
        );
        out.extend_from_slice(&self.preamble.encode());
        out.extend_from_slice(GLOBAL_SAVE_MAGIC.as_bytes());
        out.push(0u8);
        out.extend_from_slice(&self.payload);
        out
    }
}

/// Typed reader/writer for `read.sav` (per-line read flags).
///
/// The magic field is **the game's display title** in Shift-JIS, not a
/// fixed ASCII tag. The decoder carries both the **raw Shift-JIS
/// bytes** (so the encode path is byte-identical) and the **decoded
/// UTF-8 string** (so the consumer can read the title without
/// re-decoding).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadFlags {
    /// 24-byte preamble.
    pub preamble: AvgSavePreamble,
    /// Raw Shift-JIS title bytes (the variable-length null-terminated
    /// field at offset 0x18). Round-tripped verbatim through `encode`.
    pub title_bytes: Vec<u8>,
    /// UTF-8 decoded title. For an observed title, the bytes
    /// `83 65 83 58 83 67 81 40` decode to `"テスト\u{3000}"` (the trailing
    /// `0x8140` is Shift-JIS code point for IDEOGRAPHIC SPACE, which
    /// maps to `U+3000`).
    pub title: String,
    /// Variable-length payload after the null terminator.
    pub payload: Vec<u8>,
}

impl ReadFlags {
    /// Decode a `read.sav` from a byte slice. Decodes the Shift-JIS
    /// title field strictly: a replacement byte raises
    /// [`SaveDecodeError::ShiftJisDecodeFailure`].
    ///
    /// **Slot-end safety asymmetry (by design).** As with
    /// [`GlobalSave::decode`], this format's `leading_u32` is a
    /// per-format constant (`0x98`), not the file size, so the
    /// `SystemSave` file-size cross-check does **not** apply. Slot-end
    /// safety rests on the null-terminated Shift-JIS title field plus the
    /// strict (no-replacement-byte) decode: a truncation that severs the
    /// trailing payload but leaves a well-formed null-terminated title
    /// intact decodes without a diagnostic. Documented so the audit-focus
    /// "silently truncating slots" pin is not re-flagged against
    /// `ReadFlags`.
    pub fn decode(bytes: &[u8]) -> Result<Self, SaveDecodeError> {
        let preamble = AvgSavePreamble::decode(bytes)?;
        let (title_bytes_slice, nul_offset) =
            read_nul_terminated(bytes, AVG_SAVE_PREAMBLE_BYTE_LEN)?;
        let (decoded, _, had_replacement) = SHIFT_JIS.decode(title_bytes_slice);
        if had_replacement {
            return Err(SaveDecodeError::ShiftJisDecodeFailure {
                byte_len: title_bytes_slice.len(),
            });
        }
        let payload_start = nul_offset + 1;
        Ok(Self {
            preamble,
            title_bytes: title_bytes_slice.to_vec(),
            title: decoded.into_owned(),
            payload: bytes[payload_start..].to_vec(),
        })
    }

    /// Encode the read-flags save back to a byte vector. Uses the raw
    /// [`Self::title_bytes`] (not the decoded UTF-8 string) so the
    /// round-trip is byte-identical.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            AVG_SAVE_PREAMBLE_BYTE_LEN + self.title_bytes.len() + 1 + self.payload.len(),
        );
        out.extend_from_slice(&self.preamble.encode());
        out.extend_from_slice(&self.title_bytes);
        out.push(0u8);
        out.extend_from_slice(&self.payload);
        out
    }
}

/// Stable identifier of the [`SaveState`] inspectable surface. Used by
/// the substrate facade so two snapshots from different ports cannot
/// be accidentally diffed.
pub const SAVE_STATE_INSPECTABLE_ID: &str = "utsushi-reallive-save-state";

/// State-path leaf for the manifest entry. Used so a completely-empty
/// `SaveState` still produces a non-empty `StateTree` (the substrate
/// rejects empty trees with [`SnapshotError::EmptyStateTree`]).
const MANIFEST_PATH: &str = "port.save_state.manifest";

/// State-path leaves for each on-disk slot. The substrate's
/// `StatePath` parser rejects uppercase ASCII, so the canonical names
/// are lower-snake.
const SYSTEM_SAVE_PATH: &str = "port.save_state.system_save";
const GLOBAL_SAVE_PATH: &str = "port.save_state.global_save";
const READ_FLAGS_PATH: &str = "port.save_state.read_flags";

/// Stable manifest string written under [`MANIFEST_PATH`]. Carries the
/// schema label so a future schema bump can be detected at restore
/// time.
const SAVE_STATE_MANIFEST: &str = "utsushi-reallive-save-state/0.1.0-alpha";

/// In-memory backing for the save state — the substrate's
/// [`Inspectable`] / [`Restorable`] integration point. The on-disk
/// `SystemSave` / `GlobalSave` / `ReadFlags` serialisers are
/// **strictly separate** from this struct: writing to bytes never
/// touches the substrate; restoring from the substrate never touches
/// the disk.
///
/// Each on-disk slot is held as an [`Option`] so a snapshot can carry
/// a partial set (e.g. only the system save, with no global save yet
/// loaded). The substrate snapshot serialises each present slot as a
/// hex-encoded byte payload under `port.save_state.*`; the hex
/// round-trip avoids the substrate's redaction filter triggering on
/// raw high-bit bytes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SaveState {
    system_save: Option<SystemSave>,
    global_save: Option<GlobalSave>,
    read_flags: Option<ReadFlags>,
}


