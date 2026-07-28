//! AVG-derived save format (`SAVE_FORMAT=3`).
//!
//! The observed AVG32 corpus ships three save files under `$GAME/SAVEDATA/`:
//!
//! - `REALLIVE.sav` — per-slot **system save** (24 876 bytes; magic
//!   `AVG_SYSTEM_SAVE`).
//! - `save999.sav` — **global save** (read-text flags, gallery
//!   unlocks; magic `AVG_GLOBAL_SAVE`).
//! - `read.sav` — per-line **read flags** (bitfield keyed by
//!   `(scene_id, kidoku_index)`; magic is the game's display title in
//!   Shift-JIS, e.g. `テスト\u{3000}`).
//!
//! All three share the same 24-byte preamble + null-terminated magic
//! string layout (the **AVG32-derived save format** documented under
//! `docs/research/reallive-engine.md` §J). The preamble has the shape
//! `(u32 leading, u32 compiler_version, [u16; 6] timestamp
//!   u16 padding_a, u16 tail)` and the magic string begins at offset
//! `0x18`. The leading u32 is the file size for `REALLIVE.sav` (the
//! audit-focus item the doc names verbatim); for the other two it is a
//! per-format constant (`0x000000A4` for `save999.sav`
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
//!   `tests/save_real_bytes.rs` reads observed save bytes
//!   from `$private inventory row` (mode 0444, dr-x------) but
//!   the test source has **no** `fs::write` / `fs::create_dir_all`
//!   `OpenOptions::write` calls — the audit grep
//!   `tests/save_real_bytes.rs` keeps the "no writes against the
//!   research mount" invariant pinned.
//! - **Endianness flips between read and write.** Both directions use
//!   little-endian; the [`AvgSavePreamble::encode`] / `decode` pair is
//!   load-bearing for the round-trip test.
//! - **Silently truncating slots.** [`SystemSave::payload`]
//!   [`GlobalSave::payload`] / [`ReadFlags::payload`] carry the
//!   variable-length tail verbatim; the round-trip tests assert
//!   `encoded.len() == decoded.preamble.leading_u32 as usize` for
//!   `REALLIVE.sav` and that the synthetic fixture round-trips
//!   byte-identically.

use std::fmt;

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

mod codec;
mod state;

pub use codec::*;
pub use state::*;

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
        Self::synthetic_with_magic(
            total_byte_len,
            SYSTEM_SAVE_MAGIC.as_bytes(),
            0x02DC,
            AVG_DERIVED_COMPILER_VERSION,
        )
    }

    /// Build a synthetic `save999.sav` byte stream. The leading u32 is
    /// the per-format constant `0x000000A4`.
    pub fn synthetic_global_save(payload_byte_len: usize) -> Vec<u8> {
        let total = AVG_SAVE_PREAMBLE_BYTE_LEN + GLOBAL_SAVE_MAGIC.len() + 1 + payload_byte_len;
        let mut bytes = Self::synthetic_with_magic(
            total,
            GLOBAL_SAVE_MAGIC.as_bytes(),
            0x02E0,
            AVG_DERIVED_COMPILER_VERSION,
        );
        // Global save's leading u32 is a per-format constant (`0xA4`)
        // not the file size; rewrite it after the helper has filled in
        // the rest of the preamble.
        bytes[0x00..0x04].copy_from_slice(&0x0000_00A4u32.to_le_bytes());
        bytes
    }

    /// Build a synthetic `read.sav` byte stream with the supplied
    /// Shift-JIS title bytes.
    pub fn synthetic_read_flags(title_bytes: &[u8], payload_byte_len: usize) -> Vec<u8> {
        let total = AVG_SAVE_PREAMBLE_BYTE_LEN + title_bytes.len() + 1 + payload_byte_len;
        let mut bytes =
            Self::synthetic_with_magic(total, title_bytes, 0x02E7, AVG_DERIVED_COMPILER_VERSION);
        bytes[0x00..0x04].copy_from_slice(&0x0000_0098u32.to_le_bytes());
        bytes
    }

    fn synthetic_with_magic(
        total: usize,
        magic: &[u8],
        tail: u16,
        compiler_version: u32,
    ) -> Vec<u8> {
        let preamble = AvgSavePreamble {
            leading_u32: total as u32,
            compiler_version,
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
    use super::state::{MANIFEST_PATH, SAVE_STATE_MANIFEST, bytes_to_hex, hex_to_bytes};
    use super::*;
    use utsushi_core::substrate::{
        Inspectable, Restorable, SnapshotError, StatePath, StateTree, StateValue,
    };

    #[test]
    fn preamble_round_trips_byte_identically() {
        let preamble = AvgSavePreamble {
            leading_u32: 24_876,
            compiler_version: AVG_DERIVED_COMPILER_VERSION,
            timestamp: [0x07E9, 0x0003, 0x0002, 0x000B, 0x0012, 0x0027],
            padding_a: 0,
            tail: 0x02DC,
        };
        let bytes = preamble.encode();
        // Verify against the documented AVG32 prefix.
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
        // The synthetic global save has leading_u32 = 0xA4 = 164 != actual length
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
        // Shift-JIS title bytes exercise decoding and byte-identical round-tripping.
        let title_bytes = vec![0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x81, 0x40];
        let synthetic = SaveRoundTrip::synthetic_read_flags(&title_bytes, 256);
        let decoded = ReadFlags::decode(&synthetic).expect("decode");
        assert_eq!(decoded.title_bytes, title_bytes);
        assert_eq!(decoded.title, "テスト\u{3000}");
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
