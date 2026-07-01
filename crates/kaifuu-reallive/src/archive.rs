//! SEEN.TXT archive envelope decoder.
//!
//! This module parses the **real RealLive 10,000-slot fixed-offset-table
//! envelope** used by every RealLive title since AVG32, as documented at
//! `docs/research/reallive-engine.md` §C and confirmed against the
//! Sweetie HD `REALLIVEDATA/Seen.txt` bytes supplied via
//! `ITOTORI_REAL_GAME_ROOT` per
//! `docs/audits/real-bytes-validation-2026-06-24.md` §2.8.
//!
//! Layout (KAIFUU-188):
//!
//! ```text
//! +-----------+-----------+----- … -----+-----------+-----------+-----------+
//! | slot 0    | slot 1    |             | slot 9999 | scene     | scene     |
//! | u32 off   | u32 off   |             | u32 off   | payload   | payload   |
//! | u32 size  | u32 size  |             | u32 size  | bytes …   | bytes …   |
//! +-----------+-----------+----- … -----+-----------+-----------+-----------+
//! 0x00000000  0x00000008                0x0001_3878  0x0001_3880
//! ```
//!
//! - Bytes `0..80_000` are the directory: 10,000 slots × 8 bytes each.
//! - Slot `N` is `(u32_le offset, u32_le length)`.
//! - A zero-slot (both `offset == 0` and `length == 0`) is reserved; the
//!   parser silently omits it (no diagnostic, no error). Sweetie HD has
//!   198 populated slots in a 10,000-slot table.
//! - A non-zero slot whose `offset + length > archive_len` is a fatal
//!   `kaifuu.reallive.truncated_scene` error.
//! - Scene payloads begin at file offset `10_000 * 8 = 0x0001_3880 =
//!   80_000` and are referenced by absolute file offsets in the slot
//!   table.
//!
//! No legacy compat: the synthetic "u32 count + (offset, size) entries"
//! envelope is deleted, not aliased. See KAIFUU-188 in the spec DAG.

use serde::{Deserialize, Serialize};

use crate::diagnostics::{ParseDiagnostic, ParseDiagnosticCode};

/// Number of slots in the RealLive SEEN.TXT directory. Fixed by the
/// engine (rlvm's `archive.cc:` `for (int i = 0; i < 10000; ++i, idx += 8)`
/// — research anchor only, not source-of-truth) and confirmed by reading
/// Sweetie HD's real bytes.
pub const REALLIVE_SEEN_TXT_SLOT_COUNT: usize = 10_000;

/// Total byte length of the fixed directory: `REALLIVE_SEEN_TXT_SLOT_COUNT
/// * 8 = 80_000 = 0x0001_3880`.
pub const REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN: u64 = (REALLIVE_SEEN_TXT_SLOT_COUNT as u64) * 8;

/// Maximum bytes captured into [`ParseDiagnostic::raw_bytes_hex`].
const DIAGNOSTIC_HEX_PREVIEW_LEN: usize = 16;

/// Index of every populated scene in a SEEN.TXT archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealLiveSceneIndex {
    pub entries: Vec<SceneEntry>,
}

/// Single populated scene entry, keyed by its slot index in the 10,000-slot
/// directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneEntry {
    /// Slot index in the 10,000-slot directory. Matches the historical
    /// `seenNNNN` scene id (e.g. `seen0001`, `seen9999`).
    pub scene_id: u16,
    /// Absolute file offset of the scene payload (read directly from the
    /// slot's `u32_le offset` field).
    pub byte_offset: u64,
    /// Byte length of the scene payload (read directly from the slot's
    /// `u32_le length` field).
    pub byte_len: u32,
}

impl SceneEntry {
    /// Stable string form of the scene id, formatted as
    /// `reallive:scene-{scene_id:04}`. Used by the patchback planner and
    /// the per-scene AST surface to anchor downstream string-keyed
    /// matching against an opaque, stable id.
    pub fn scene_id_str(&self) -> String {
        scene_id_string(self.scene_id)
    }
}

/// Format the canonical stable string scene-id (`reallive:scene-NNNN`) for
/// a directory slot index.
pub(crate) fn scene_id_string(scene_id: u16) -> String {
    format!("reallive:scene-{scene_id:04}")
}

/// Parse a SEEN.TXT archive envelope. Returns the [`RealLiveSceneIndex`]
/// on success, or a single fatal [`ParseDiagnostic`] describing the
/// envelope failure.
///
/// The expected layout is the fixed 10,000-slot directory documented at
/// the top of this module. A file shorter than the directory itself is a
/// hard envelope failure. A non-zero slot whose declared
/// `(offset, length)` runs past the file end yields a
/// `kaifuu.reallive.truncated_scene` error. Zero slots (both fields zero)
/// are silently skipped — they are reserved in the on-disk layout, not a
/// diagnostic.
pub fn parse_archive(bytes: &[u8]) -> Result<RealLiveSceneIndex, ParseDiagnostic> {
    let archive_len = bytes.len() as u64;

    if archive_len < REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN {
        return Err(out_of_profile(
            0,
            Some(archive_len),
            preview_hex(bytes, 0),
            format!(
                "SEEN.TXT archive length {archive_len} is shorter than the fixed \
                 {REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN}-byte 10,000-slot directory"
            ),
        ));
    }

    let mut entries = Vec::new();
    for slot_index in 0..REALLIVE_SEEN_TXT_SLOT_COUNT {
        let slot_byte_offset = slot_index * 8;
        let byte_offset = u64::from(read_u32_le(bytes, slot_byte_offset));
        let byte_len = read_u32_le(bytes, slot_byte_offset + 4);

        if byte_offset == 0 && byte_len == 0 {
            // Reserved unused slot — silently omit per the documented
            // layout. Sweetie HD has 9802 such slots.
            continue;
        }

        let end = byte_offset.saturating_add(u64::from(byte_len));
        if end > archive_len {
            // Scene id matches the slot index (0..=9999, u16-safe by
            // construction).
            let scene_id = slot_index as u16;
            return Err(ParseDiagnostic::fatal(
                ParseDiagnosticCode::TruncatedScene,
                slot_byte_offset as u64,
                Some(8),
                preview_hex(bytes, slot_byte_offset),
                format!(
                    "scene slot {scene_id} declares (offset={byte_offset}, len={byte_len}) \
                     running to byte {end} past archive length {archive_len}"
                ),
            )
            .with_remediation(
                "Reject the archive at the adapter boundary; map to \
                 kaifuu.unknown_engine_variant per the KAIFUU-174 contract.",
            ));
        }

        entries.push(SceneEntry {
            scene_id: slot_index as u16,
            byte_offset,
            byte_len,
        });
    }

    Ok(RealLiveSceneIndex { entries })
}

fn read_u32_le(bytes: &[u8], offset: usize) -> u32 {
    let mut buf = [0u8; 4];
    buf.copy_from_slice(&bytes[offset..offset + 4]);
    u32::from_le_bytes(buf)
}

pub(crate) fn preview_hex(bytes: &[u8], start: usize) -> Option<String> {
    use std::fmt::Write as _;
    if start >= bytes.len() {
        return None;
    }
    let end = (start + DIAGNOSTIC_HEX_PREVIEW_LEN).min(bytes.len());
    let mut hex = String::with_capacity((end - start) * 2);
    for byte in &bytes[start..end] {
        let _ = write!(hex, "{byte:02X}");
    }
    Some(hex)
}

fn out_of_profile(
    byte_offset: u64,
    byte_len: Option<u64>,
    raw_bytes_hex: Option<String>,
    message: impl Into<String>,
) -> ParseDiagnostic {
    ParseDiagnostic::fatal(
        ParseDiagnosticCode::OutOfProfileInput,
        byte_offset,
        byte_len,
        raw_bytes_hex,
        message,
    )
    .with_remediation(
        "Confirm the input is a RealLive SEEN.TXT archive (the KAIFUU-172 \
         detector is the canonical front door).",
    )
}
