//! Deterministic identifier helpers.
//!
//! Uses the exact SHA-256 → UUID7-shaped construction shared by every other
//! kaifuu bridge producer (`kaifuu-reallive` / `kaifuu-rpgmaker` /
//! `kaifuu-kirikiri`) so a TyranoScript unit's `bridgeUnitId` is derived the
//! same way as every other engine family's — one identifier scheme across
//! adapters.

use sha2::{Digest, Sha256};

/// Deterministic UUID7-shaped string from `(namespace, role)`.
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
