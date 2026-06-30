//! UTSUSHI-218 — AVG-derived save format (`SAVE_FORMAT=3`).
//!
//! Sweetie HD ships three save files under `$GAME/SAVEDATA/`:
//!
//! - `REALLIVE.sav` — per-slot **system save** (24 876 bytes; magic
//!   `AVG_SYSTEM_SAVE`).
//! - `save999.sav` — **global save** (read-text flags, gallery
//!   unlocks; magic `AVG_GLOBAL_SAVE`).
//! - `read.sav` — per-line **read flags** (bitfield keyed by
//!   `(scene_id, kidoku_index)`; magic is the game's display title in
//!   Shift-JIS, e.g. `オシオキSweetie＋Sweets!! HD Edition\u{3000}`).
//!
//! All three share the same 24-byte preamble + null-terminated magic
//! string layout (the **AVG32-derived save format** documented under
//! `docs/research/reallive-engine.md` §J). The preamble has the shape
//! `(u32 leading, u32 compiler_version, [u16; 6] timestamp,
//!   u16 padding_a, u16 tail)` and the magic string begins at offset
//! `0x18`. The leading u32 is the file size for `REALLIVE.sav` (the
//! audit-focus item the doc names verbatim); for the other two it is a
//! per-format constant (`0x000000A4` for `save999.sav`,
//! `0x00000098` for `read.sav`).
//!
//! # Module structure
//!
//! - [`AvgSavePreamble`] — typed reader/writer for the 24-byte preamble.
//!   Endianness is **little-endian** in both directions; the audit-focus
//!   item "endianness flips between read and write" is structurally
//!   impossible because both helpers route through the same
//!   [`u32::from_le_bytes`] / [`u32::to_le_bytes`] pair.
//! - [`SystemSave`], [`GlobalSave`], [`ReadFlags`] — typed wrappers
//!   that pin the magic string and own the variable-length tail
//!   payload bytes verbatim. The `encode_*` helpers are byte-for-byte
//!   round-trips of the corresponding `decode_*` parsers — the
//!   "synthetic round-trip producing byte-identical output" spec
//!   acceptance criterion is enforced by [`SaveRoundTrip`] in the test
//!   suite.
//! - [`SaveState`] / [`Inspectable`] / [`Restorable`] — the substrate
//!   `SnapshotStore` integration. The on-disk serialiser is **strictly
//!   separate** from the in-memory backing: writing a `SystemSave` to
//!   bytes never touches the substrate; restoring a `SaveState` from
//!   the substrate never touches the disk. This is the spec's
//!   "substrate `SnapshotStore` is the in-memory backing for save
//!   state; on-disk serialiser is separate" pin.
//!
//! # Audit focus
//!
//! - **Writing to the read-only research mount must be banned at the
//!   test layer.** The real-bytes test in
//!   `tests/save_real_bytes.rs` reads the Sweetie HD save bytes
//!   from `$ITOTORI_REAL_GAME_ROOT` (mode 0444, dr-x------) but
//!   the test source has **no** `fs::write` / `fs::create_dir_all` /
//!   `OpenOptions::write` calls — the audit grep
//!   `tests/save_real_bytes.rs` keeps the "no writes against the
//!   research mount" invariant pinned.
//! - **Endianness flips between read and write.** Both directions use
//!   little-endian; the [`AvgSavePreamble::encode`] / `decode` pair is
//!   load-bearing for the round-trip test.
//! - **Silently truncating slots.** [`SystemSave::payload`] /
//!   [`GlobalSave::payload`] / [`ReadFlags::payload`] carry the
//!   variable-length tail verbatim; the round-trip tests assert
//!   `encoded.len() == decoded.preamble.leading_u32 as usize` for
//!   `REALLIVE.sav` and that the synthetic fixture round-trips
//!   byte-identically.

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

/// Compiler-version stamp every Sweetie HD save preamble carries at
/// offset `0x04` (`0x00002712 = 10002`). Pinned so the round-trip test
/// can assert against it without re-reading the bytes.
pub const SWEETIE_HD_COMPILER_VERSION: u32 = 10_002;

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
    /// (`SYSTEM_SAVE_MAGIC` for `SystemSave::decode`,
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
/// The six u16 timestamp fields are stored verbatim so a Sweetie HD
/// save written by `RealLive.exe` on 2025-03-02 11:18:39 round-trips
/// byte-identically through `encode`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AvgSavePreamble {
    /// File size in bytes (for `REALLIVE.sav`) or a per-format
    /// constant (for `save999.sav` / `read.sav`). At offset `0x00..0x04`.
    pub leading_u32: u32,
    /// Compiler-version stamp (`SWEETIE_HD_COMPILER_VERSION = 10 002`
    /// for Sweetie HD). At offset `0x04..0x08`.
    pub compiler_version: u32,
    /// Engine timestamp (year, month, day, hour, minute, second) as
    /// six little-endian u16s. At offset `0x08..0x14`.
    pub timestamp: [u16; 6],
    /// Reserved u16 at offset `0x14..0x16`. Zero on every observed
    /// Sweetie HD save; round-tripped verbatim.
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
    /// (`0x000000A4` on Sweetie HD); the file-size cross-check from
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
    /// UTF-8 decoded title. For Sweetie HD, the bytes
    /// `83 49 83 56 83 49 83 4C ... 81 40` decode to
    /// `"オシオキSweetie＋Sweets!! HD Edition\u{3000}"` (the trailing
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

impl SaveState {
    /// Construct an empty `SaveState` (no slots populated).
    pub fn new() -> Self {
        Self::default()
    }

    /// Borrow the system-save slot.
    pub fn system_save(&self) -> Option<&SystemSave> {
        self.system_save.as_ref()
    }

    /// Borrow the global-save slot.
    pub fn global_save(&self) -> Option<&GlobalSave> {
        self.global_save.as_ref()
    }

    /// Borrow the read-flags slot.
    pub fn read_flags(&self) -> Option<&ReadFlags> {
        self.read_flags.as_ref()
    }

    /// Replace the system-save slot. Returns the previous value if any.
    pub fn set_system_save(&mut self, save: SystemSave) -> Option<SystemSave> {
        self.system_save.replace(save)
    }

    /// Replace the global-save slot. Returns the previous value if any.
    pub fn set_global_save(&mut self, save: GlobalSave) -> Option<GlobalSave> {
        self.global_save.replace(save)
    }

    /// Replace the read-flags slot. Returns the previous value if any.
    pub fn set_read_flags(&mut self, flags: ReadFlags) -> Option<ReadFlags> {
        self.read_flags.replace(flags)
    }
}

impl Inspectable for SaveState {
    fn inspectable_id(&self) -> &'static str {
        SAVE_STATE_INSPECTABLE_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse(MANIFEST_PATH)?,
            StateValue::String {
                value: SAVE_STATE_MANIFEST.to_string(),
            },
        )?;
        if let Some(save) = &self.system_save {
            tree.insert(
                StatePath::parse(SYSTEM_SAVE_PATH)?,
                StateValue::String {
                    value: bytes_to_hex(&save.encode()),
                },
            )?;
        }
        if let Some(save) = &self.global_save {
            tree.insert(
                StatePath::parse(GLOBAL_SAVE_PATH)?,
                StateValue::String {
                    value: bytes_to_hex(&save.encode()),
                },
            )?;
        }
        if let Some(flags) = &self.read_flags {
            tree.insert(
                StatePath::parse(READ_FLAGS_PATH)?,
                StateValue::String {
                    value: bytes_to_hex(&flags.encode()),
                },
            )?;
        }
        Ok(tree)
    }
}

impl Restorable for SaveState {
    fn restore_state(&mut self, state: &StateTree) -> Result<RestoreReport, SnapshotError> {
        let mut new_system: Option<SystemSave> = None;
        let mut new_global: Option<GlobalSave> = None;
        let mut new_read: Option<ReadFlags> = None;
        let mut manifest_seen = false;
        let mut consumed = Vec::new();
        for (path, value) in state.iter() {
            match (path.as_str(), value) {
                (MANIFEST_PATH, StateValue::String { value }) => {
                    if value != SAVE_STATE_MANIFEST {
                        return Err(SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: format!(
                                "save_state manifest mismatch: observed={value} expected={SAVE_STATE_MANIFEST}"
                            ),
                        });
                    }
                    manifest_seen = true;
                    consumed.push(path.clone());
                }
                (MANIFEST_PATH, other) => {
                    return Err(SnapshotError::RestoreTypeMismatch {
                        path: path.clone(),
                        expected: "string",
                        found: other.type_tag(),
                    });
                }
                (SYSTEM_SAVE_PATH, StateValue::String { value }) => {
                    let bytes = decode_hex_payload(path, value)?;
                    let save = SystemSave::decode(&bytes).map_err(|err| {
                        SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: err.to_string(),
                        }
                    })?;
                    new_system = Some(save);
                    consumed.push(path.clone());
                }
                (GLOBAL_SAVE_PATH, StateValue::String { value }) => {
                    let bytes = decode_hex_payload(path, value)?;
                    let save = GlobalSave::decode(&bytes).map_err(|err| {
                        SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: err.to_string(),
                        }
                    })?;
                    new_global = Some(save);
                    consumed.push(path.clone());
                }
                (READ_FLAGS_PATH, StateValue::String { value }) => {
                    let bytes = decode_hex_payload(path, value)?;
                    let flags = ReadFlags::decode(&bytes).map_err(|err| {
                        SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: err.to_string(),
                        }
                    })?;
                    new_read = Some(flags);
                    consumed.push(path.clone());
                }
                (SYSTEM_SAVE_PATH | GLOBAL_SAVE_PATH | READ_FLAGS_PATH, other) => {
                    return Err(SnapshotError::RestoreTypeMismatch {
                        path: path.clone(),
                        expected: "string",
                        found: other.type_tag(),
                    });
                }
                _ => {
                    return Err(SnapshotError::RestoreStatePathUnknown { path: path.clone() });
                }
            }
        }
        if !manifest_seen {
            return Err(SnapshotError::RestoreValueOutOfRange {
                path: StatePath::parse(MANIFEST_PATH)?,
                reason: "save_state manifest entry missing from snapshot".to_string(),
            });
        }
        self.system_save = new_system;
        self.global_save = new_global;
        self.read_flags = new_read;
        Ok(RestoreReport {
            consumed_paths: consumed,
            ignored_by_design: Vec::new(),
        })
    }
}

fn decode_hex_payload(path: &StatePath, value: &str) -> Result<Vec<u8>, SnapshotError> {
    hex_to_bytes(value).map_err(|reason| SnapshotError::RestoreValueOutOfRange {
        path: path.clone(),
        reason: format!("{}: {reason}", codes::STATE_HEX_DECODE_FAILURE),
    })
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(nibble_to_hex(byte >> 4));
        out.push(nibble_to_hex(byte & 0x0F));
    }
    out
}

fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    if !hex.len().is_multiple_of(2) {
        return Err("hex payload has odd length".to_string());
    }
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(hex.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_to_nibble(bytes[i])?;
        let lo = hex_to_nibble(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

fn nibble_to_hex(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        10..=15 => (b'a' + (nibble - 10)) as char,
        _ => '?',
    }
}

fn hex_to_nibble(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(10 + (byte - b'a')),
        b'A'..=b'F' => Ok(10 + (byte - b'A')),
        _ => Err(format!("invalid hex byte 0x{byte:02x}")),
    }
}

/// Synthetic fixture builder for the "byte-identical round-trip" test.
/// Produces a minimal valid byte stream for each save kind that can be
/// `decode`d, then `encode`d back to the same bytes.
///
/// Held as a typed builder (not a free function) so the test suite can
/// extend it per audit-focus item without forking the construction
/// surface.
#[derive(Debug, Clone)]
pub struct SaveRoundTrip;

impl SaveRoundTrip {
    /// Build a synthetic `REALLIVE.sav` byte stream of the requested
    /// total `total_byte_len` (must be `>= 0x18 + magic_len + 1`).
    /// The leading u32 is set to `total_byte_len` so the file-size
    /// cross-check passes; the rest of the preamble is filled with
    /// stable, non-zero pinned values.
    pub fn synthetic_system_save(total_byte_len: usize) -> Vec<u8> {
        Self::synthetic_with_magic(total_byte_len, SYSTEM_SAVE_MAGIC.as_bytes(), 0x02DC)
    }

    /// Build a synthetic `save999.sav` byte stream. The leading u32 is
    /// the per-format constant `0x000000A4`.
    pub fn synthetic_global_save(payload_byte_len: usize) -> Vec<u8> {
        let total = AVG_SAVE_PREAMBLE_BYTE_LEN + GLOBAL_SAVE_MAGIC.len() + 1 + payload_byte_len;
        let mut bytes = Self::synthetic_with_magic(total, GLOBAL_SAVE_MAGIC.as_bytes(), 0x02E0);
        // Global save's leading u32 is a per-format constant (`0xA4`),
        // not the file size; rewrite it after the helper has filled in
        // the rest of the preamble.
        bytes[0x00..0x04].copy_from_slice(&0x0000_00A4u32.to_le_bytes());
        bytes
    }

    /// Build a synthetic `read.sav` byte stream with the supplied
    /// Shift-JIS title bytes.
    pub fn synthetic_read_flags(title_bytes: &[u8], payload_byte_len: usize) -> Vec<u8> {
        let total = AVG_SAVE_PREAMBLE_BYTE_LEN + title_bytes.len() + 1 + payload_byte_len;
        let mut bytes = Self::synthetic_with_magic(total, title_bytes, 0x02E7);
        bytes[0x00..0x04].copy_from_slice(&0x0000_0098u32.to_le_bytes());
        bytes
    }

    fn synthetic_with_magic(total: usize, magic: &[u8], tail: u16) -> Vec<u8> {
        let preamble = AvgSavePreamble {
            leading_u32: total as u32,
            compiler_version: SWEETIE_HD_COMPILER_VERSION,
            timestamp: [0x07E9, 0x0003, 0x0002, 0x000B, 0x0012, 0x0027],
            padding_a: 0,
            tail,
        };
        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(&preamble.encode());
        out.extend_from_slice(magic);
        out.push(0u8);
        // The remaining payload bytes are a stable pseudo-random
        // pattern (`(idx % 251) as u8`) so a regression that drops a
        // byte from the round-trip surfaces as a positional mismatch
        // rather than a "all zeros" green test.
        let payload_len = total - AVG_SAVE_PREAMBLE_BYTE_LEN - magic.len() - 1;
        for idx in 0..payload_len {
            out.push((idx % 251) as u8);
        }
        debug_assert_eq!(out.len(), total);
        out
    }
}

impl fmt::Display for SystemSave {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "SystemSave {{ leading_u32={}, payload_bytes={} }}",
            self.preamble.leading_u32,
            self.payload.len()
        )
    }
}

impl fmt::Display for GlobalSave {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "GlobalSave {{ leading_u32={}, payload_bytes={} }}",
            self.preamble.leading_u32,
            self.payload.len()
        )
    }
}

impl fmt::Display for ReadFlags {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "ReadFlags {{ title_bytes={}, title_chars={}, payload_bytes={} }}",
            self.title_bytes.len(),
            self.title.chars().count(),
            self.payload.len()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preamble_round_trips_byte_identically() {
        let preamble = AvgSavePreamble {
            leading_u32: 24_876,
            compiler_version: SWEETIE_HD_COMPILER_VERSION,
            timestamp: [0x07E9, 0x0003, 0x0002, 0x000B, 0x0012, 0x0027],
            padding_a: 0,
            tail: 0x02DC,
        };
        let bytes = preamble.encode();
        // Verify against the documented Sweetie HD prefix.
        assert_eq!(&bytes[0x00..0x04], &[0x2C, 0x61, 0x00, 0x00]);
        assert_eq!(&bytes[0x04..0x08], &[0x12, 0x27, 0x00, 0x00]);
        assert_eq!(
            &bytes[0x08..0x14],
            &[
                0xE9, 0x07, 0x03, 0x00, 0x02, 0x00, 0x0B, 0x00, 0x12, 0x00, 0x27, 0x00
            ]
        );
        assert_eq!(&bytes[0x14..0x16], &[0x00, 0x00]);
        assert_eq!(&bytes[0x16..0x18], &[0xDC, 0x02]);
        let parsed = AvgSavePreamble::decode(&bytes).expect("decode");
        assert_eq!(parsed, preamble);
    }

    #[test]
    fn preamble_decode_rejects_truncated_input() {
        let err = AvgSavePreamble::decode(&[0u8; 0x10]).expect_err("too short");
        assert!(matches!(
            err,
            SaveDecodeError::PreambleTruncated {
                have: 0x10,
                need: 0x18
            }
        ));
        assert_eq!(err.semantic_code(), codes::PREAMBLE_TRUNCATED);
    }

    #[test]
    fn system_save_round_trips_synthetic_bytes_byte_identically() {
        let synthetic = SaveRoundTrip::synthetic_system_save(24_876);
        let decoded = SystemSave::decode(&synthetic).expect("decode");
        assert_eq!(decoded.preamble.leading_u32, 24_876);
        let re_encoded = decoded.encode();
        assert_eq!(re_encoded, synthetic, "round-trip must be byte-identical");
        assert_eq!(re_encoded.len(), 24_876);
    }

    #[test]
    fn system_save_decode_rejects_file_size_mismatch() {
        let synthetic = SaveRoundTrip::synthetic_system_save(1024);
        // Truncate by one byte — the declared file size no longer matches.
        let truncated = &synthetic[..1023];
        let err = SystemSave::decode(truncated).expect_err("truncated");
        assert!(matches!(
            err,
            SaveDecodeError::PreambleFileSizeMismatch {
                declared: 1024,
                actual: 1023
            }
        ));
        assert_eq!(err.semantic_code(), codes::PREAMBLE_FILE_SIZE_MISMATCH);
    }

    #[test]
    fn system_save_decode_rejects_wrong_magic() {
        // A `save999.sav` byte stream with the global-save magic must
        // NOT decode as a `SystemSave`.
        let global = SaveRoundTrip::synthetic_global_save(64);
        let err = SystemSave::decode(&global).expect_err("magic mismatch");
        // The synthetic global save has leading_u32 = 0xA4 = 164 != actual length,
        // so file-size cross-check fires first. That is the system-save's
        // dedicated guard, so synthesise a same-size-but-wrong-magic stream
        // to reach the magic-mismatch branch.
        assert!(matches!(
            err,
            SaveDecodeError::PreambleFileSizeMismatch { .. }
                | SaveDecodeError::MagicMismatch { .. }
        ));
    }

    #[test]
    fn system_save_decode_rejects_wrong_magic_with_matching_file_size() {
        // Construct a byte stream with the global-save magic but a
        // leading u32 that matches the actual length, so the file-size
        // cross-check passes and the magic check fires.
        let mut bytes = SaveRoundTrip::synthetic_global_save(64);
        let actual_len = bytes.len() as u32;
        bytes[0x00..0x04].copy_from_slice(&actual_len.to_le_bytes());
        let err = SystemSave::decode(&bytes).expect_err("wrong magic");
        match err {
            SaveDecodeError::MagicMismatch { observed, expected } => {
                assert_eq!(observed, GLOBAL_SAVE_MAGIC);
                assert_eq!(expected, SYSTEM_SAVE_MAGIC);
            }
            other => panic!("expected MagicMismatch, got {other:?}"),
        }
    }

    #[test]
    fn global_save_round_trips_synthetic_bytes_byte_identically() {
        let synthetic = SaveRoundTrip::synthetic_global_save(128);
        let decoded = GlobalSave::decode(&synthetic).expect("decode");
        let re_encoded = decoded.encode();
        assert_eq!(re_encoded, synthetic, "round-trip must be byte-identical");
    }

    #[test]
    fn read_flags_round_trips_synthetic_bytes_byte_identically() {
        // Sweetie HD title bytes — load-bearing for the spec acceptance criterion.
        let title_bytes = vec![
            0x83, 0x49, 0x83, 0x56, 0x83, 0x49, 0x83, 0x4c, 0x53, 0x77, 0x65, 0x65, 0x74, 0x69,
            0x65, 0x81, 0x7b, 0x53, 0x77, 0x65, 0x65, 0x74, 0x73, 0x21, 0x21, 0x20, 0x48, 0x44,
            0x20, 0x45, 0x64, 0x69, 0x74, 0x69, 0x6f, 0x6e, 0x81, 0x40,
        ];
        let synthetic = SaveRoundTrip::synthetic_read_flags(&title_bytes, 256);
        let decoded = ReadFlags::decode(&synthetic).expect("decode");
        assert_eq!(decoded.title_bytes, title_bytes);
        assert_eq!(
            decoded.title,
            "オシオキSweetie＋Sweets!! HD Edition\u{3000}"
        );
        let re_encoded = decoded.encode();
        assert_eq!(re_encoded, synthetic, "round-trip must be byte-identical");
    }

    #[test]
    fn read_flags_decode_rejects_unterminated_title() {
        let mut bytes = SaveRoundTrip::synthetic_read_flags(b"AVG", 0);
        // Strip the trailing payload + NUL terminator + last title
        // byte; the title field is now unterminated within the slice.
        bytes.truncate(AVG_SAVE_PREAMBLE_BYTE_LEN + 3);
        let err = ReadFlags::decode(&bytes).expect_err("unterminated title");
        assert!(matches!(err, SaveDecodeError::MagicUnterminated { .. }));
        assert_eq!(err.semantic_code(), codes::MAGIC_UNTERMINATED);
    }

    #[test]
    fn save_state_is_inspectable_with_pinned_id() {
        let state = SaveState::new();
        assert_eq!(state.inspectable_id(), SAVE_STATE_INSPECTABLE_ID);
        let tree = state.inspect_state().expect("inspect");
        assert!(!tree.is_empty(), "manifest entry must always be present");
    }

    #[test]
    fn save_state_restore_round_trips_through_state_tree() {
        let mut state = SaveState::new();
        let synthetic = SaveRoundTrip::synthetic_system_save(2048);
        let system = SystemSave::decode(&synthetic).expect("decode");
        state.set_system_save(system.clone());
        let tree = state.inspect_state().expect("inspect");
        let mut restored = SaveState::new();
        let report = restored.restore_state(&tree).expect("restore");
        assert!(report.ignored_by_design.is_empty());
        assert_eq!(restored.system_save(), Some(&system));
        assert_eq!(restored.global_save(), None);
        assert_eq!(restored.read_flags(), None);
    }

    #[test]
    fn save_state_restore_rejects_unknown_state_path() {
        let mut state = SaveState::new();
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse(MANIFEST_PATH).expect("path"),
            StateValue::String {
                value: SAVE_STATE_MANIFEST.to_string(),
            },
        )
        .expect("insert");
        tree.insert(
            StatePath::parse("port.save_state.unknown").expect("path"),
            StateValue::String {
                value: "deadbeef".to_string(),
            },
        )
        .expect("insert");
        let err = state.restore_state(&tree).expect_err("unknown path");
        assert!(matches!(err, SnapshotError::RestoreStatePathUnknown { .. }));
    }

    #[test]
    fn codes_all_lists_every_semantic_code() {
        // Audit grep: this list must cover every code the variant set
        // produces.
        let variants = [
            SaveDecodeError::PreambleTruncated {
                have: 0,
                need: 0x18,
            },
            SaveDecodeError::PreambleFileSizeMismatch {
                declared: 0,
                actual: 0,
            },
            SaveDecodeError::MagicUnterminated { search_len: 0 },
            SaveDecodeError::MagicMismatch {
                observed: "x".to_string(),
                expected: SYSTEM_SAVE_MAGIC,
            },
            SaveDecodeError::ShiftJisDecodeFailure { byte_len: 0 },
        ];
        let all: std::collections::HashSet<&'static str> = codes::ALL.iter().copied().collect();
        for v in &variants {
            assert!(
                all.contains(v.semantic_code()),
                "code {} missing from codes::ALL",
                v.semantic_code()
            );
        }
    }

    #[test]
    fn round_trip_synthetic_global_save_with_zero_payload() {
        let synthetic = SaveRoundTrip::synthetic_global_save(0);
        let decoded = GlobalSave::decode(&synthetic).expect("decode");
        assert!(decoded.payload.is_empty());
        assert_eq!(decoded.encode(), synthetic);
    }

    #[test]
    fn hex_helpers_round_trip_high_bit_bytes() {
        let bytes = vec![0x00, 0x7f, 0x80, 0xff];
        let hex = bytes_to_hex(&bytes);
        assert_eq!(hex, "007f80ff");
        assert_eq!(hex_to_bytes(&hex).expect("parse"), bytes);
    }
}
