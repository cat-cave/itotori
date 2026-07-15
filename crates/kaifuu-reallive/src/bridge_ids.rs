//! Deterministic identifier + hash derivations for the v0.2 Bridge producer.
//!
//! Extracted from `bridge.rs` so the id derivation is a single, small source
//! of truth: the JSON builder and any independent verifier (e.g. the real-byte
//! identity oracle) both derive a `speakerId` through the SAME code path, so a
//! fabricated id cannot pass an identity cross-check.

use std::fmt::Write as _;

use sha2::{Digest, Sha256};

/// Canonical `sha256:<hex>` of the given bytes.
pub(crate) fn sha256_canonical(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in &digest {
        let _ = write!(hex, "{byte:02x}");
    }
    format!("sha256:{hex}")
}

/// Produce a deterministic UUID7-shaped string from `(namespace, role)`.
/// UUID7's structural constraints (`version=7` at byte 14,
/// `variant ∈ {8,9,a,b}` at byte 19) are satisfied by truncating a
/// SHA-256 digest of `namespace || ':' || role` and overlaying the
/// version/variant nibbles. The remaining bytes are random-from-hash
/// hex which is sufficient for our schema-validation needs (UUID7's
/// time-ordered ms-prefix property is not consumed by this producer).
pub(crate) fn deterministic_uuid7(namespace: &str, role: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(namespace.as_bytes());
    hasher.update(b":");
    hasher.update(role.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // Force version=7 at byte 6 (UUID layout: nibble at byte 6 high
    // nibble carries version).
    bytes[6] = (bytes[6] & 0x0F) | 0x70;
    // Force variant = 10xx at byte 8 (top two bits).
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

/// The deterministic bundle namespace for a single-scene bundle produced by
/// `produce_bundle`. Exposed as the single source of truth so a verifier can
/// recompute a bundle's deterministic ids (speaker ids, unit ids) EXACTLY as
/// the producer did, instead of re-deriving the namespace string independently
/// and drifting.
pub fn scene_bundle_namespace(game_id: &str, source_profile_id: &str, scene_id: u16) -> String {
    format!(
        "reallive-bridge:game-id={game_id}:source-profile-id={source_profile_id}:scene={scene_id:04}"
    )
}

/// The deterministic speaker id the producer assigns to a resolved speaker
/// with the given canonical NAMAE ref under `bundle_namespace`. This is the
/// single source of truth for the id derivation — the JSON builder and any
/// verifier both call it, so a fabricated `speakerId` (one not derived from
/// the real canonical ref) cannot survive an identity cross-check.
pub fn deterministic_speaker_id(bundle_namespace: &str, canonical_ref: &str) -> String {
    deterministic_uuid7(bundle_namespace, &format!("speaker-{canonical_ref}"))
}
