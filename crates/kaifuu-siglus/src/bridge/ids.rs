//! Deterministic identifiers and canonical hashes for Siglus bridge output.

use std::fmt::Write as _;

use sha2::{Digest, Sha256};

pub(crate) fn sha256_canonical(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    format!("sha256:{hex}")
}

/// Build a deterministic UUIDv7-shaped identifier from a bundle namespace and
/// a role.  The shared bridge contract validates the UUID shape; derivation
/// from stable source coordinates makes repeated extraction byte-for-byte
/// deterministic.
pub(crate) fn deterministic_uuid7(namespace: &str, role: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(namespace.as_bytes());
    hasher.update(b":");
    hasher.update(role.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
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

pub(crate) fn scene_namespace(game_id: &str, source_profile_id: &str, scene_name: &str) -> String {
    format!(
        "siglus-bridge:game-id={game_id}:source-profile-id={source_profile_id}:scene={scene_name}"
    )
}

pub(crate) fn speaker_id(namespace: &str, canonical_ref: &str) -> String {
    deterministic_uuid7(namespace, &format!("speaker-{canonical_ref}"))
}
