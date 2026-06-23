//! SEEN.TXT archive envelope decoder.
//!
//! See `lib.rs` for the clean-room provenance posture and the envelope
//! layout. This module produces a [`SceneIndex`] of `(byte_offset,
//! byte_len)` ranges keyed by stable [`SceneId`]s derived from the
//! archive-index position.

use serde::{Deserialize, Serialize};

use crate::ast::SCHEMA_VERSION;
use crate::diagnostics::{ParseDiagnostic, ParseDiagnosticCode};

/// Sanity ceiling on the number of scenes in a SEEN.TXT archive.
///
/// Matches the ceiling used by the KAIFUU-172 detector at
/// `crates/kaifuu-engine-fixture/src/lib.rs:reallive_seen_txt_envelope_ok`
/// so the parser-boundary and detector-boundary agree on what shape
/// should reach the parser.
pub const REALLIVE_SEEN_TXT_MAX_SCENE_COUNT: u32 = 1 << 17;

/// Maximum bytes captured into [`ParseDiagnostic::raw_bytes_hex`].
const DIAGNOSTIC_HEX_PREVIEW_LEN: usize = 16;

/// Index of every scene in a SEEN.TXT archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneIndex {
    pub schema_version: String,
    pub source_archive_byte_len: u64,
    pub entries: Vec<SceneEntry>,
}

/// Single scene entry, keyed by archive-position-derived id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneEntry {
    pub scene_id: SceneId,
    pub archive_index: u32,
    pub byte_offset: u64,
    pub byte_len: u64,
}

/// Stable scene-id wrapper. Format: `reallive:scene-{archive_index:04}`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SceneId(String);

impl SceneId {
    pub fn for_index(archive_index: u32) -> Self {
        Self(format!("reallive:scene-{archive_index:04}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Parse a SEEN.TXT archive envelope. Returns the [`SceneIndex`] on
/// success or a single fatal [`ParseDiagnostic`] describing the envelope
/// failure.
///
/// The expected layout is documented in `lib.rs` (§ "SEEN.TXT envelope"):
/// `u32 LE` scene count at offset 0, followed by per-scene `(u32 LE
/// offset, u32 LE size)` entries, followed by scene payloads at the
/// declared offsets.
pub fn parse_archive(bytes: &[u8]) -> Result<SceneIndex, ParseDiagnostic> {
    let archive_len = bytes.len() as u64;

    if bytes.len() < 4 {
        return Err(out_of_profile(
            0,
            Some(bytes.len() as u64),
            preview_hex(bytes, 0),
            "SEEN.TXT archive too short to contain a scene count u32",
        ));
    }

    let count = read_u32_le(bytes, 0);

    if count > REALLIVE_SEEN_TXT_MAX_SCENE_COUNT {
        return Err(invalid_envelope(
            0,
            Some(4),
            preview_hex(bytes, 0),
            format!(
                "scene count {count} exceeds the documented sanity ceiling \
                 ({REALLIVE_SEEN_TXT_MAX_SCENE_COUNT})"
            ),
        ));
    }

    let table_byte_len = (count as u64).saturating_mul(8);
    let table_end = 4u64.saturating_add(table_byte_len);
    if table_end > archive_len {
        return Err(invalid_envelope(
            0,
            Some(archive_len),
            preview_hex(bytes, 0),
            format!(
                "scene count {count} declares an entry table running to byte {table_end} \
                 past archive length {archive_len}"
            ),
        ));
    }

    let mut entries = Vec::with_capacity(count as usize);
    for index in 0..count {
        let entry_offset = 4 + (index as usize) * 8;
        let byte_offset = u64::from(read_u32_le(bytes, entry_offset));
        let byte_len = u64::from(read_u32_le(bytes, entry_offset + 4));

        // Per §3.1 row 1 of the plan: an entry whose declared (offset,
        // size) does not fit inside the archive is a fatal envelope
        // diagnostic.
        let end = byte_offset.saturating_add(byte_len);
        if byte_offset < table_end || end > archive_len {
            return Err(invalid_envelope(
                entry_offset as u64,
                Some(8),
                preview_hex(bytes, entry_offset),
                format!(
                    "scene[{index}] entry (offset={byte_offset}, len={byte_len}) does not \
                     fit in archive (table ends at {table_end}, archive ends at {archive_len})"
                ),
            ));
        }

        entries.push(SceneEntry {
            scene_id: SceneId::for_index(index),
            archive_index: index,
            byte_offset,
            byte_len,
        });
    }

    Ok(SceneIndex {
        schema_version: SCHEMA_VERSION.to_string(),
        source_archive_byte_len: archive_len,
        entries,
    })
}

fn read_u32_le(bytes: &[u8], offset: usize) -> u32 {
    let mut buf = [0u8; 4];
    buf.copy_from_slice(&bytes[offset..offset + 4]);
    u32::from_le_bytes(buf)
}

pub(crate) fn preview_hex(bytes: &[u8], start: usize) -> Option<String> {
    if start >= bytes.len() {
        return None;
    }
    let end = (start + DIAGNOSTIC_HEX_PREVIEW_LEN).min(bytes.len());
    let mut hex = String::with_capacity((end - start) * 2);
    for byte in &bytes[start..end] {
        hex.push_str(&format!("{byte:02X}"));
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

fn invalid_envelope(
    byte_offset: u64,
    byte_len: Option<u64>,
    raw_bytes_hex: Option<String>,
    message: impl Into<String>,
) -> ParseDiagnostic {
    ParseDiagnostic::fatal(
        ParseDiagnosticCode::InvalidArchiveEnvelope,
        byte_offset,
        byte_len,
        raw_bytes_hex,
        message,
    )
    .with_remediation(
        "Reject the archive at the adapter boundary; map to \
         kaifuu.unknown_engine_variant per the KAIFUU-174 contract.",
    )
}
