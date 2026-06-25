//! UTSUSHI-201 — Real Seen.txt 10,000-slot directory parser.
//!
//! This module is the **utsushi-reallive head** of the runtime parsing
//! chain. It owns its own parser for the real RealLive `Seen.txt`
//! envelope: a fixed 10,000-slot directory of `(u32_le byte_offset,
//! u32_le byte_len)` records followed by scene payloads referenced by
//! absolute file offsets.
//!
//! The on-disk layout is **identical** to the one `kaifuu-reallive`
//! recognises; the format is fixed by the engine. What is intentionally
//! **not** shared is the implementation: `utsushi-reallive` does **not**
//! depend on `kaifuu-reallive` (neither as a Cargo dep nor by re-export).
//! That separation is the alpha-gate architectural constraint behind
//! UTSUSHI-201 — every runtime port owns its own parser so a regression
//! in one project cannot quietly poison the other.
//!
//! # Format
//!
//! ```text
//! +-----------+-----------+----- … -----+-----------+-----------+
//! | slot 0    | slot 1    |             | slot 9999 | payload   |
//! | u32 off   | u32 off   |             | u32 off   | bytes …   |
//! | u32 size  | u32 size  |             | u32 size  |           |
//! +-----------+-----------+----- … -----+-----------+-----------+
//! 0x00000000  0x00000008                0x00013878  0x00013880
//! ```
//!
//! - Bytes `0..80_000` are the directory: 10,000 slots × 8 bytes each.
//! - Slot `N` is `(u32_le offset, u32_le length)`.
//! - A zero-slot (both `offset == 0` and `length == 0`) is reserved by
//!   the format. The parser silently omits it — it is **not** a
//!   diagnostic. Sweetie HD has 9802 such slots.
//! - A non-zero slot whose `offset + length > archive_len` is a fatal
//!   [`RealSceneIndexError::TruncatedScene`].
//! - Slot `0` is reserved by RealLive convention: the directory's first
//!   slot is never populated. The parser does not special-case slot 0;
//!   if it were populated the code would report it normally, but real
//!   archives we have audited keep it zeroed.
//! - Scene payloads begin at file offset `10_000 * 8 = 0x0001_3880 =
//!   80_000` and are referenced by absolute file offsets.
//!
//! # Real-bytes anchor
//!
//! The Sweetie HD `REALLIVEDATA/Seen.txt` corpus (audited under
//! `docs/audits/real-bytes-validation-2026-06-24.md` §2.8) contains
//! exactly 198 populated slots, the first being scene 1 at
//! `byte_offset == 0x13880, byte_len == 0x5fa`, the last being scene
//! 9999 at `byte_offset == 0x20423e, byte_len == 0xb42`. The integration
//! test `scene_index_real_bytes.rs` pins those values.
//!
//! # No silent zero-state
//!
//! Empty input (`bytes.is_empty()`) and short input
//! (`bytes.len() < DIRECTORY_BYTE_LEN`) both return
//! [`RealSceneIndexError::TruncatedScene`]. The parser refuses to
//! quietly produce a zero-entry index — that bug class is precisely
//! what the alpha gate forbids.

use serde::{Deserialize, Serialize};

/// Number of slots in the RealLive `Seen.txt` directory. Fixed by the
/// engine and confirmed against the Sweetie HD bytes.
pub const REAL_SCENE_DIRECTORY_SLOT_COUNT: usize = 10_000;

/// Byte size of one directory slot: `u32_le byte_offset + u32_le byte_len`.
pub const REAL_SCENE_DIRECTORY_SLOT_BYTE_LEN: usize = 8;

/// Total byte length of the fixed directory:
/// `REAL_SCENE_DIRECTORY_SLOT_COUNT * REAL_SCENE_DIRECTORY_SLOT_BYTE_LEN`
/// = `80_000` = `0x0001_3880`.
pub const REAL_SCENE_DIRECTORY_BYTE_LEN: usize =
    REAL_SCENE_DIRECTORY_SLOT_COUNT * REAL_SCENE_DIRECTORY_SLOT_BYTE_LEN;

/// Single populated scene entry, keyed by its slot index in the
/// 10,000-slot directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealSceneEntry {
    /// Slot index in the 10,000-slot directory. Matches the historical
    /// `seenNNNN` scene id (e.g. `seen0001`, `seen9999`). The directory
    /// has at most 10,000 slots, so `scene_id` fits in `u16`.
    pub scene_id: u16,
    /// Absolute file offset of the scene payload (the slot's
    /// `u32_le byte_offset` field, widened to `u64` for arithmetic).
    pub byte_offset: u64,
    /// Byte length of the scene payload (the slot's `u32_le byte_len`
    /// field).
    pub byte_len: u32,
}

/// Index of every populated scene in a `Seen.txt` envelope.
///
/// Built by [`RealSceneIndex::parse`]. Entries are stored in slot-
/// ascending order — the parser walks the directory front-to-back and
/// appends every non-zero slot it observes. Callers SHOULD NOT mutate
/// the entries vector directly; the public surface is the constructor
/// plus the [`RealSceneIndex::lookup`] accessor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealSceneIndex {
    /// Populated scene entries in slot-ascending order.
    pub entries: Vec<RealSceneEntry>,
}

/// Fatal errors raised by [`RealSceneIndex::parse`].
///
/// The error surface is intentionally narrow. Both "input shorter than
/// the fixed directory" and "a slot points past the end of the file"
/// land on [`RealSceneIndexError::TruncatedScene`] — the runtime
/// downstream cannot make progress in either case, and the alpha-gate
/// contract requires the parser to refuse silent zero-state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RealSceneIndexError {
    /// The input bytes are too short to be a real `Seen.txt` envelope
    /// (either empty, or shorter than the fixed 80,000-byte directory),
    /// or a populated slot declares a `(byte_offset, byte_len)` range
    /// that runs past the end of the archive.
    TruncatedScene {
        /// Slot index whose declared range overflows. `None` when the
        /// archive itself is shorter than the directory and no slot
        /// could be parsed.
        scene_id: Option<u16>,
        /// Declared start offset for the offending slot, if available.
        declared_offset: Option<u64>,
        /// Declared payload length for the offending slot, if available.
        declared_len: Option<u32>,
        /// Archive byte length observed at parse time.
        archive_len: u64,
        /// Human-readable diagnostic message.
        message: String,
    },
}

impl std::fmt::Display for RealSceneIndexError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RealSceneIndexError::TruncatedScene { message, .. } => {
                write!(formatter, "utsushi.reallive.truncated_scene: {message}")
            }
        }
    }
}

impl std::error::Error for RealSceneIndexError {}

impl RealSceneIndex {
    /// Parse a `Seen.txt` envelope. Returns the [`RealSceneIndex`] on
    /// success, or a single fatal [`RealSceneIndexError`] describing
    /// the envelope failure.
    ///
    /// Empty input and any input shorter than the fixed
    /// [`REAL_SCENE_DIRECTORY_BYTE_LEN`] returns
    /// [`RealSceneIndexError::TruncatedScene`] — never a zero-entry
    /// success.
    pub fn parse(bytes: &[u8]) -> Result<Self, RealSceneIndexError> {
        let archive_len = bytes.len() as u64;

        if bytes.len() < REAL_SCENE_DIRECTORY_BYTE_LEN {
            return Err(RealSceneIndexError::TruncatedScene {
                scene_id: None,
                declared_offset: None,
                declared_len: None,
                archive_len,
                message: format!(
                    "Seen.txt archive length {archive_len} is shorter than the fixed \
                     {REAL_SCENE_DIRECTORY_BYTE_LEN}-byte 10,000-slot directory",
                ),
            });
        }

        let mut entries: Vec<RealSceneEntry> =
            Vec::with_capacity(REAL_SCENE_DIRECTORY_SLOT_COUNT / 32);
        for slot_index in 0..REAL_SCENE_DIRECTORY_SLOT_COUNT {
            let slot_byte_offset = slot_index * REAL_SCENE_DIRECTORY_SLOT_BYTE_LEN;
            // Both reads are bounds-checked above (the directory window
            // is contiguous and we proved `bytes.len() >= DIRECTORY_BYTE_LEN`).
            let byte_offset_u32 = read_u32_le(bytes, slot_byte_offset);
            let byte_len = read_u32_le(bytes, slot_byte_offset + 4);
            let byte_offset = u64::from(byte_offset_u32);

            if byte_offset == 0 && byte_len == 0 {
                // Reserved unused slot — silently omit per the
                // documented layout. Sweetie HD has 9802 such slots.
                continue;
            }

            let declared_end = byte_offset.saturating_add(u64::from(byte_len));
            if declared_end > archive_len {
                let scene_id = slot_index as u16;
                return Err(RealSceneIndexError::TruncatedScene {
                    scene_id: Some(scene_id),
                    declared_offset: Some(byte_offset),
                    declared_len: Some(byte_len),
                    archive_len,
                    message: format!(
                        "scene slot {scene_id} declares (byte_offset={byte_offset}, \
                         byte_len={byte_len}) running to byte {declared_end} past archive \
                         length {archive_len}",
                    ),
                });
            }

            entries.push(RealSceneEntry {
                scene_id: slot_index as u16,
                byte_offset,
                byte_len,
            });
        }

        Ok(RealSceneIndex { entries })
    }

    /// Look up an entry by scene id. Returns `None` when the slot was
    /// reserved (zeroed) in the source directory. The search is a
    /// linear scan — the populated entry count is small relative to the
    /// 10,000-slot envelope (Sweetie HD has 198), and this avoids the
    /// memory cost of a parallel index.
    pub fn lookup(&self, scene_id: u16) -> Option<&RealSceneEntry> {
        self.entries.iter().find(|entry| entry.scene_id == scene_id)
    }

    /// Number of populated entries — convenience wrapper so callers do
    /// not reach through `entries` for the count.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// `true` when no populated entries were observed. The parser never
    /// produces this state on a well-formed archive; it is only
    /// reachable from a synthetic all-zero 80,000-byte buffer (every
    /// slot reserved). Provided as a convenience for tests.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Read a little-endian `u32` from `bytes` at `offset`. Caller is
/// responsible for bounds — every call site in this module is preceded
/// by an `archive_len >= REAL_SCENE_DIRECTORY_BYTE_LEN` guard.
fn read_u32_le(bytes: &[u8], offset: usize) -> u32 {
    let mut buf = [0u8; 4];
    buf.copy_from_slice(&bytes[offset..offset + 4]);
    u32::from_le_bytes(buf)
}

/// Synthetic encoder used by the unit tests in this file (and by the
/// integration tests when they need to build a small archive without a
/// real corpus). Not part of the public surface — `pub(crate)` so
/// `tests/` cannot call it.
///
/// The encoder writes a fixed `REAL_SCENE_DIRECTORY_BYTE_LEN` directory
/// from the provided slots, then appends each slot's payload bytes in
/// the order it observes them. Slots with `(byte_offset, byte_len) ==
/// (0, 0)` are written as reserved (zeroed) slots and contribute no
/// payload. Callers are responsible for keeping the slot's declared
/// `byte_offset` consistent with the payload layout they want.
#[cfg(test)]
pub(crate) fn encode_synthetic_archive(slots: &[SyntheticSlot]) -> Vec<u8> {
    let mut directory = vec![0u8; REAL_SCENE_DIRECTORY_BYTE_LEN];
    let mut payload: Vec<u8> = Vec::new();
    for slot in slots {
        let slot_index = slot.scene_id as usize;
        let slot_offset = slot_index * REAL_SCENE_DIRECTORY_SLOT_BYTE_LEN;
        directory[slot_offset..slot_offset + 4].copy_from_slice(&slot.byte_offset.to_le_bytes());
        directory[slot_offset + 4..slot_offset + 8].copy_from_slice(&slot.byte_len.to_le_bytes());
        if !slot.payload.is_empty() {
            payload.extend_from_slice(&slot.payload);
        }
    }
    let mut archive = directory;
    archive.extend_from_slice(&payload);
    archive
}

/// Synthetic slot description consumed by [`encode_synthetic_archive`].
#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct SyntheticSlot {
    pub scene_id: u16,
    pub byte_offset: u32,
    pub byte_len: u32,
    pub payload: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_returns_truncated_scene_not_zero_state() {
        let err =
            RealSceneIndex::parse(&[]).expect_err("empty input must refuse silent zero-state");
        match err {
            RealSceneIndexError::TruncatedScene {
                scene_id,
                declared_offset,
                declared_len,
                archive_len,
                message,
            } => {
                assert_eq!(scene_id, None);
                assert_eq!(declared_offset, None);
                assert_eq!(declared_len, None);
                assert_eq!(archive_len, 0);
                assert!(
                    message.contains("shorter than the fixed"),
                    "diagnostic must describe envelope shortfall; got: {message}",
                );
            }
        }
    }

    #[test]
    fn under_directory_length_input_returns_truncated_scene() {
        // 79,999 bytes — one byte short of the directory.
        let bytes = vec![0u8; REAL_SCENE_DIRECTORY_BYTE_LEN - 1];
        let err =
            RealSceneIndex::parse(&bytes).expect_err("under-directory input must be truncated");
        match err {
            RealSceneIndexError::TruncatedScene {
                scene_id,
                archive_len,
                ..
            } => {
                assert_eq!(scene_id, None);
                assert_eq!(archive_len, (REAL_SCENE_DIRECTORY_BYTE_LEN - 1) as u64);
            }
        }
    }

    #[test]
    fn all_zero_directory_yields_zero_entries_without_diagnostic() {
        // A perfectly-formed but empty archive: 80,000 bytes of zeros.
        // Every slot is reserved -> no entries, no diagnostic. This is
        // the documented zero-slot policy from
        // `docs/research/reallive-engine.md` §C.
        let bytes = vec![0u8; REAL_SCENE_DIRECTORY_BYTE_LEN];
        let index = RealSceneIndex::parse(&bytes).expect(
            "all-zero directory parses cleanly; reserved slots are not a diagnostic per the \
             documented format",
        );
        assert!(index.is_empty());
        assert_eq!(index.len(), 0);
    }

    #[test]
    fn synthetic_encoder_round_trips_two_populated_slots() {
        let slot_a_offset = REAL_SCENE_DIRECTORY_BYTE_LEN as u32;
        let slot_a_payload = b"scene-1-bytes".to_vec();
        let slot_a_len = slot_a_payload.len() as u32;
        let slot_b_offset = slot_a_offset + slot_a_len;
        let slot_b_payload = b"scene-42-bytes".to_vec();
        let slot_b_len = slot_b_payload.len() as u32;

        let archive = encode_synthetic_archive(&[
            SyntheticSlot {
                scene_id: 1,
                byte_offset: slot_a_offset,
                byte_len: slot_a_len,
                payload: slot_a_payload.clone(),
            },
            SyntheticSlot {
                scene_id: 42,
                byte_offset: slot_b_offset,
                byte_len: slot_b_len,
                payload: slot_b_payload.clone(),
            },
        ]);

        let index =
            RealSceneIndex::parse(&archive).expect("synthetic 2-slot archive parses cleanly");
        assert_eq!(index.len(), 2);

        let first = index.lookup(1).expect("scene 1 lookup succeeds");
        assert_eq!(first.scene_id, 1);
        assert_eq!(first.byte_offset, u64::from(slot_a_offset));
        assert_eq!(first.byte_len, slot_a_len);

        let second = index.lookup(42).expect("scene 42 lookup succeeds");
        assert_eq!(second.scene_id, 42);
        assert_eq!(second.byte_offset, u64::from(slot_b_offset));
        assert_eq!(second.byte_len, slot_b_len);

        // Slot 0 is reserved by convention -> no entry; lookup returns None.
        assert!(index.lookup(0).is_none(), "slot 0 is reserved -> no entry");
        // Unpopulated slot -> None.
        assert!(
            index.lookup(7).is_none(),
            "unpopulated slot returns None, not a diagnostic",
        );
    }

    #[test]
    fn zero_slot_emits_no_entry_even_when_neighbours_are_populated() {
        let populated_offset = REAL_SCENE_DIRECTORY_BYTE_LEN as u32;
        let populated_payload = b"only-real-scene".to_vec();
        let populated_len = populated_payload.len() as u32;

        // Slot 0 left at its default `(0, 0)` — reserved, must not produce
        // an entry.
        let archive = encode_synthetic_archive(&[SyntheticSlot {
            scene_id: 5,
            byte_offset: populated_offset,
            byte_len: populated_len,
            payload: populated_payload,
        }]);

        let index =
            RealSceneIndex::parse(&archive).expect("archive with reserved slot 0 parses cleanly");
        assert_eq!(index.len(), 1);
        assert_eq!(index.entries[0].scene_id, 5);
        assert!(
            index.lookup(0).is_none(),
            "the reserved slot 0 must not show up as a populated entry",
        );
    }

    #[test]
    fn slot_pointing_past_end_of_archive_raises_truncated_scene() {
        // Build a directory where slot 1 declares a payload that runs
        // past the file end. The directory is 80,000 bytes and we add
        // zero payload bytes -> declared `(80_000, 1024)` overshoots by
        // 1024 bytes.
        let mut bytes = vec![0u8; REAL_SCENE_DIRECTORY_BYTE_LEN];
        let slot_one_offset = REAL_SCENE_DIRECTORY_SLOT_BYTE_LEN; // slot 1
        let declared_offset: u32 = REAL_SCENE_DIRECTORY_BYTE_LEN as u32;
        let declared_len: u32 = 1024;
        bytes[slot_one_offset..slot_one_offset + 4].copy_from_slice(&declared_offset.to_le_bytes());
        bytes[slot_one_offset + 4..slot_one_offset + 8]
            .copy_from_slice(&declared_len.to_le_bytes());

        let err = RealSceneIndex::parse(&bytes)
            .expect_err("slot overrunning file end must surface a TruncatedScene diagnostic");
        match err {
            RealSceneIndexError::TruncatedScene {
                scene_id,
                declared_offset: got_offset,
                declared_len: got_len,
                archive_len,
                message,
            } => {
                assert_eq!(scene_id, Some(1));
                assert_eq!(got_offset, Some(u64::from(declared_offset)));
                assert_eq!(got_len, Some(declared_len));
                assert_eq!(archive_len, REAL_SCENE_DIRECTORY_BYTE_LEN as u64);
                assert!(
                    message.contains("scene slot 1"),
                    "diagnostic names the offending scene id; got: {message}",
                );
            }
        }
    }

    #[test]
    fn entries_are_emitted_in_slot_ascending_order() {
        // Populate slots 3 and 7 — the encoder writes directory entries
        // by scene_id, but the parser walks the directory front-to-back
        // regardless of insertion order. The parsed entries must come
        // back in ascending slot order.
        let dir_len = REAL_SCENE_DIRECTORY_BYTE_LEN as u32;
        let archive = encode_synthetic_archive(&[
            SyntheticSlot {
                scene_id: 7,
                byte_offset: dir_len + 4,
                byte_len: 4,
                payload: vec![0xCC, 0xCC, 0xCC, 0xCC],
            },
            SyntheticSlot {
                scene_id: 3,
                byte_offset: dir_len,
                byte_len: 4,
                payload: vec![0xAA, 0xAA, 0xAA, 0xAA],
            },
        ]);
        let index = RealSceneIndex::parse(&archive).expect("two-slot synthetic parses");
        let observed_ids: Vec<u16> = index.entries.iter().map(|entry| entry.scene_id).collect();
        assert_eq!(observed_ids, vec![3, 7]);
    }

    #[test]
    fn display_message_carries_the_typed_error_code_prefix() {
        let err = RealSceneIndex::parse(&[]).unwrap_err();
        let rendered = err.to_string();
        assert!(
            rendered.starts_with("utsushi.reallive.truncated_scene:"),
            "Display rendering must carry the typed error code; got: {rendered}",
        );
    }
}
