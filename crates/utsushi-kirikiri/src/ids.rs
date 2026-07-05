//! Deterministic bridge-unit identifier helpers for the UTSUSHI-008 KAG
//! command trace.
//!
//! A `[speaker]`/`[branch]` trace row links back to the KAIFUU-009 extraction
//! bridge unit for the same source text. To make that link the ACTUAL
//! extraction identity (not a parallel invented one), this module re-derives
//! the exact identifier scheme `kaifuu_kirikiri` uses:
//!
//! - `source_unit_key` = `kirikiri-kag:<file>#L<line>#seg<seg>#<role>`
//! - `bridge_unit_id`   = SHA-256 → UUID7-shaped digest of
//!   `(namespace, "unit-<source_unit_key>")`, where
//!   `namespace = "kirikiri-kag-bridge:source-file=<file>"`.
//!
//! Re-derived rather than imported, matching this crate's regression-isolation
//! posture (KAIFUU-009 is a dev-dependency ORACLE only). The
//! `command_trace_bridge` oracle test proves these ids are byte-identical to
//! `kaifuu_kirikiri::parse_ks`'s own `bridge_unit_id` / `source_unit_key` for
//! every speaker/branch/message row, so the linkage is provably the real
//! extraction identity.

use sha2::{Digest, Sha256};

/// The `role` label KAIFUU-009 stamps into a `source_unit_key` / uses to pick
/// which units carry which text. Mirrors `kaifuu_kirikiri::TextRole`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BridgeRole {
    /// A run of on-screen message / choice-option text.
    Dialogue,
    /// The display-name portion of a `#name` line.
    SpeakerName,
}

impl BridgeRole {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Dialogue => "dialogue",
            Self::SpeakerName => "speaker_name",
        }
    }
}

/// The `kirikiri-kag-bridge:source-file=<file>` namespace KAIFUU-009 derives
/// its `bridge_unit_id` under.
pub(crate) fn bridge_namespace(source_file: &str) -> String {
    format!("kirikiri-kag-bridge:source-file={source_file}")
}

/// `kirikiri-kag:<file>#L<line>#seg<seg>#<role>` — the stable, human-readable
/// bridge-unit key KAIFUU-009 stamps on every extraction unit.
pub(crate) fn source_unit_key(
    source_file: &str,
    line_index: usize,
    segment_index: usize,
    role: BridgeRole,
) -> String {
    format!(
        "kirikiri-kag:{source_file}#L{line_index}#seg{segment_index}#{}",
        role.as_str()
    )
}

/// Deterministic UUID7-shaped id from `(namespace, role)`. Byte-identical to
/// `kaifuu_kirikiri`'s `deterministic_uuid7` (the shared cross-adapter scheme).
pub(crate) fn deterministic_uuid7(namespace: &str, role: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(namespace.as_bytes());
    hasher.update(b":");
    hasher.update(role.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0F) | 0x70;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

/// Build the `(bridge_unit_id, source_unit_key)` pair for a source-text unit,
/// exactly as KAIFUU-009 would for the same `(file, line, seg, role)`.
pub(crate) fn bridge_ids(
    source_file: &str,
    line_index: usize,
    segment_index: usize,
    role: BridgeRole,
) -> (String, String) {
    let key = source_unit_key(source_file, line_index, segment_index, role);
    let id = deterministic_uuid7(&bridge_namespace(source_file), &format!("unit-{key}"));
    (id, key)
}
