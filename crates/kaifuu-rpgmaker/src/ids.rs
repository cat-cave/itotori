//! Stable identifier helpers shared by every RPG Maker extraction surface.
//!
//! The bridge producer and the focused JSON slices intentionally use the same
//! SHA-256-to-UUID7-shaped construction. Keeping it here prevents a surface
//! from silently drifting its identity scheme while retaining each caller's
//! namespace as part of its public identity contract.

use sha2::{Digest, Sha256};

/// Produce a deterministic UUID7-shaped identifier from a namespace and key.
///
/// This is an identifier shape, rather than a timestamp-bearing UUIDv7: the
/// first 16 SHA-256 bytes provide deterministic identity, then the UUID
/// version and variant bits are set so bridge-contract validation accepts it.
#[must_use]
pub(crate) fn deterministic_uuid7(namespace: &str, key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(namespace.as_bytes());
    hasher.update(b":");
    hasher.update(key.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
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

#[cfg(test)]
mod tests {
    use super::deterministic_uuid7;

    #[test]
    fn preserves_namespace_and_uuid7_shape() {
        let first = deterministic_uuid7("rpgmaker-k109:KAIFUU-109", "unit:Map001");
        let again = deterministic_uuid7("rpgmaker-k109:KAIFUU-109", "unit:Map001");
        let other_namespace = deterministic_uuid7("rpgmaker-k110:KAIFUU-110", "unit:Map001");

        assert_eq!(first, again, "identical input is stable");
        assert_ne!(first, other_namespace, "caller namespace remains part of identity");
        assert_eq!(&first[14..15], "7", "UUID version is 7");
        assert!(matches!(&first[19..20], "8" | "9" | "a" | "b"));
    }
}
