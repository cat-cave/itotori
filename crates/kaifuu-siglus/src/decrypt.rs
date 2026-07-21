//! Siglus scene payload decryption — constant-table strip + gated second layer.
//! A packed Siglus scene chunk is masked with up to two XOR layers before the
//! LZSS header:
//! 1. a **constant 256-byte table** applied byte-periodically
//!    (`data[i] ^= table[i % 256]`) — a documented engine constant, the same
//!    for every Siglus title (the *easy angou* / *base code* table), NOT a
//!    per-game secret; and
//! 2. an **optional per-game 16-byte second-layer key** applied byte-periodically
//!    (`data[i] ^= key[i % 16]`), gated by the container's `extra_key_use`
//!    flag. This key is recovered from the packed `SiglusEngine` executable by
//!    the key-discovery layer (`kaifuu_core::siglus_static_key`) and handed
//!    here as an opaque, resolved secret — never a raw literal in this crate.
//! # Provenance of the constant table
//! [`SIGLUS_CONSTANT_XOR_TABLE`] is a **datum re-derived from publicly archived
//! Siglus format documentation** and independently corroborated across two
//! research anchors, then **re-validated against real Siglus title bytes**: for
//! every packed scene the table (composed with the game's second-layer key)
//! makes the leading `u32 compressed_size` field decrypt to exactly the scene
//! chunk's on-disk length, and the whole chunk LZSS-decompresses cleanly. A
//! wrong table produces immediate size garbage / LZSS overruns, so the table is
//! validated by construction rather than asserted. No reference source is
//! vendored, linked, or mechanically translated (see the crate clean-room note).
//! # Honesty contract
//! Raw second-layer key material is never logged, serialized, or returned:
//! [`SiglusSecondLayerKey`] carries only a structured secret-ref, and
//! [`SiglusSecondLayerMaterial`] holds the bytes behind a redacting `Debug`,
//! a zeroizing `Drop`, and a byte-free public surface (only the key byte length
//! and a one-way sha256 commitment are disclosed).

use thiserror::Error;

/// Length of the constant Siglus XOR table (256 bytes).
pub const SIGLUS_XOR_TABLE_LEN: usize = 256;

/// Length of the per-game second-layer key (16 bytes).
pub const SIGLUS_SECOND_LAYER_KEY_BYTE_LEN: usize = 16;

/// The documented constant 256-byte Siglus scene XOR table (first layer).
/// Engine-wide constant (not a per-game secret). See the module provenance note.
pub const SIGLUS_CONSTANT_XOR_TABLE: [u8; SIGLUS_XOR_TABLE_LEN] = [
    0x70, 0xF8, 0xA6, 0xB0, 0xA1, 0xA5, 0x28, 0x4F, 0xB5, 0x2F, 0x48, 0xFA, 0xE1, 0xE9, 0x4B, 0xDE,
    0xB7, 0x4F, 0x62, 0x95, 0x8B, 0xE0, 0x03, 0x80, 0xE7, 0xCF, 0x0F, 0x6B, 0x92, 0x01, 0xEB, 0xF8,
    0xA2, 0x88, 0xCE, 0x63, 0x04, 0x38, 0xD2, 0x6D, 0x8C, 0xD2, 0x88, 0x76, 0xA7, 0x92, 0x71, 0x8F,
    0x4E, 0xB6, 0x8D, 0x01, 0x79, 0x88, 0x83, 0x0A, 0xF9, 0xE9, 0x2C, 0xDB, 0x67, 0xDB, 0x91, 0x14,
    0xD5, 0x9A, 0x4E, 0x79, 0x17, 0x23, 0x08, 0x96, 0x0E, 0x1D, 0x15, 0xF9, 0xA5, 0xA0, 0x6F, 0x58,
    0x17, 0xC8, 0xA9, 0x46, 0xDA, 0x22, 0xFF, 0xFD, 0x87, 0x12, 0x42, 0xFB, 0xA9, 0xB8, 0x67, 0x6C,
    0x91, 0x67, 0x64, 0xF9, 0xD1, 0x1E, 0xE4, 0x50, 0x64, 0x6F, 0xF2, 0x0B, 0xDE, 0x40, 0xE7, 0x47,
    0xF1, 0x03, 0xCC, 0x2A, 0xAD, 0x7F, 0x34, 0x21, 0xA0, 0x64, 0x26, 0x98, 0x6C, 0xED, 0x69, 0xF4,
    0xB5, 0x23, 0x08, 0x6E, 0x7D, 0x92, 0xF6, 0xEB, 0x93, 0xF0, 0x7A, 0x89, 0x5E, 0xF9, 0xF8, 0x7A,
    0xAF, 0xE8, 0xA9, 0x48, 0xC2, 0xAC, 0x11, 0x6B, 0x2B, 0x33, 0xA7, 0x40, 0x0D, 0xDC, 0x7D, 0xA7,
    0x5B, 0xCF, 0xC8, 0x31, 0xD1, 0x77, 0x52, 0x8D, 0x82, 0xAC, 0x41, 0xB8, 0x73, 0xA5, 0x4F, 0x26,
    0x7C, 0x0F, 0x39, 0xDA, 0x5B, 0x37, 0x4A, 0xDE, 0xA4, 0x49, 0x0B, 0x7C, 0x17, 0xA3, 0x43, 0xAE,
    0x77, 0x06, 0x64, 0x73, 0xC0, 0x43, 0xA3, 0x18, 0x5A, 0x0F, 0x9F, 0x02, 0x4C, 0x7E, 0x8B, 0x01,
    0x9F, 0x2D, 0xAE, 0x72, 0x54, 0x13, 0xFF, 0x96, 0xAE, 0x0B, 0x34, 0x58, 0xCF, 0xE3, 0x00, 0x78,
    0xBE, 0xE3, 0xF5, 0x61, 0xE4, 0x87, 0x7C, 0xFC, 0x80, 0xAF, 0xC4, 0x8D, 0x46, 0x3A, 0x5D, 0xD0,
    0x36, 0xBC, 0xE5, 0x60, 0x77, 0x68, 0x08, 0x4F, 0xBB, 0xAB, 0xE2, 0x78, 0x07, 0xE8, 0x73, 0xBF,
];

/// The documented constant 256-byte Siglus **`Gameexe.dat`** XOR table.
/// This is a *distinct* engine-wide constant from [`SIGLUS_CONSTANT_XOR_TABLE`]
/// (which masks packed scene chunks): `Gameexe.dat` is masked with this table,
/// scene chunks with the other. Both are engine constants, not per-game secrets.
/// # Provenance
/// Re-derived as a datum from publicly archived Siglus format documentation and
/// then **corroborated against real title bytes**: this exact 256-byte table is
/// present verbatim inside both owned titles' real `SiglusEngine.exe` (in
/// `.rdata`, immediately preceding [`SIGLUS_CONSTANT_XOR_TABLE`]), and composing
/// it with a title's exe-angou key makes the real `Gameexe.dat` body's leading
/// `u32 arc_size` decrypt to exactly the body length. A wrong table yields an
/// immediate size/LZSS mismatch, so the table is validated by construction. No
/// reference source is vendored, linked, or mechanically translated.
pub const SIGLUS_GAMEEXE_XOR_TABLE: [u8; SIGLUS_XOR_TABLE_LEN] = [
    0xD8, 0x29, 0xB9, 0x16, 0x3D, 0x1A, 0x76, 0xD0, 0x87, 0x9B, 0x2D, 0x0C, 0x7B, 0xD1, 0xA9, 0x19,
    0x22, 0x9F, 0x91, 0x73, 0x6A, 0x35, 0xB1, 0x7E, 0xD1, 0xB5, 0xE7, 0xE6, 0xD5, 0xF5, 0x06, 0xD6,
    0xBA, 0xBF, 0xF3, 0x45, 0x3F, 0xF1, 0x61, 0xDD, 0x4C, 0x67, 0x6A, 0x6F, 0x74, 0xEC, 0x7A, 0x6F,
    0x26, 0x74, 0x0E, 0xDB, 0x27, 0x4C, 0xA5, 0xF1, 0x0E, 0x2D, 0x70, 0xC4, 0x40, 0x5D, 0x4F, 0xDA,
    0x9E, 0xC5, 0x49, 0x7B, 0xBD, 0xE8, 0xDF, 0xEE, 0xCA, 0xF4, 0x92, 0xDE, 0xE4, 0x76, 0x10, 0xDD,
    0x2A, 0x52, 0xDC, 0x73, 0x4E, 0x54, 0x8C, 0x30, 0x3D, 0x9A, 0xB2, 0x9B, 0xB8, 0x93, 0x29, 0x55,
    0xFA, 0x7A, 0xC9, 0xDA, 0x10, 0x97, 0xE5, 0xB6, 0x23, 0x02, 0xDD, 0x38, 0x4C, 0x9B, 0x1F, 0x9A,
    0xD5, 0x49, 0xE9, 0x34, 0x0F, 0x28, 0x2D, 0x1B, 0x52, 0x39, 0x5C, 0x36, 0x89, 0x56, 0xA7, 0x96,
    0x14, 0xBE, 0x2E, 0xC5, 0x3E, 0x08, 0x5F, 0x47, 0xA9, 0xDF, 0x88, 0x9F, 0xD4, 0xCC, 0x69, 0x1F,
    0x30, 0x9F, 0xE7, 0xCD, 0x80, 0x45, 0xF3, 0xE7, 0x2A, 0x1D, 0x16, 0xB2, 0xF1, 0x54, 0xC8, 0x6C,
    0x2B, 0x0D, 0xD4, 0x65, 0xF7, 0xE3, 0x36, 0xD4, 0xA5, 0x3B, 0xD1, 0x79, 0x4C, 0x54, 0xF0, 0x2A,
    0xB4, 0xB2, 0x56, 0x45, 0x2E, 0xAB, 0x7B, 0x88, 0xC5, 0xFA, 0x74, 0xAD, 0x03, 0xB8, 0x9E, 0xD5,
    0xF5, 0x6F, 0xDC, 0xFA, 0x44, 0x49, 0x31, 0xF6, 0x83, 0x32, 0xFF, 0xC2, 0xB1, 0xE9, 0xE1, 0x98,
    0x3D, 0x6F, 0x31, 0x0D, 0xAC, 0xB1, 0x08, 0x83, 0x9D, 0x0D, 0x10, 0xD1, 0x41, 0xF9, 0x00, 0xBA,
    0x1A, 0xCF, 0x13, 0x71, 0xE4, 0x86, 0x21, 0x2F, 0x23, 0x65, 0xC3, 0x45, 0xA0, 0xC3, 0x92, 0x48,
    0x9D, 0xEA, 0xDD, 0x31, 0x2C, 0xE9, 0xE2, 0x10, 0x22, 0xAA, 0xE1, 0xAD, 0x2C, 0xC4, 0x2D, 0x7F,
];

/// Opaque handle to a recovered per-game second-layer key, published as a
/// structured secret-ref only (never raw bytes). The key-discovery layer
/// constructs this from its validated `secret-ref + proof hash`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusSecondLayerKey {
    secret_ref: String,
}

impl SiglusSecondLayerKey {
    /// Construct from the structured secret-ref the key is published under.
    pub fn from_secret_ref(secret_ref: impl Into<String>) -> Self {
        Self {
            secret_ref: secret_ref.into(),
        }
    }

    /// The structured secret-ref this key is published under. Never the raw
    /// 16-byte material.
    pub fn secret_ref(&self) -> &str {
        &self.secret_ref
    }
}

/// Resolved second-layer key material: the actual 16 key bytes, held behind a
/// redacting `Debug`, a zeroizing `Drop`, and a byte-free public surface. The
/// bytes are reachable only through [`SiglusSecondLayerMaterial::xor_in_place`];
/// they are never logged, serialized, cloned into a report, or returned.
/// Constructed from material the key-discovery layer resolved for a secret-ref.
pub struct SiglusSecondLayerMaterial {
    secret_ref: String,
    bytes: Vec<u8>,
}

impl std::fmt::Debug for SiglusSecondLayerMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SiglusSecondLayerMaterial")
            .field("secret_ref", &self.secret_ref)
            .field("byte_len", &self.bytes.len())
            .field("bytes", &"[REDACTED:kaifuu.secret_redacted]")
            .finish()
    }
}

impl Drop for SiglusSecondLayerMaterial {
    fn drop(&mut self) {
        for byte in &mut self.bytes {
            *byte = 0;
        }
    }
}

impl SiglusSecondLayerMaterial {
    /// Bind resolved key material to the secret-ref it was published under.
    /// The material must be the documented [`SIGLUS_SECOND_LAYER_KEY_BYTE_LEN`]
    /// length; any other length is a typed error before any decode proceeds.
    pub fn resolve(
        key: &SiglusSecondLayerKey,
        material: Vec<u8>,
    ) -> Result<Self, SiglusDecryptError> {
        if material.len() != SIGLUS_SECOND_LAYER_KEY_BYTE_LEN {
            return Err(SiglusDecryptError::InvalidKeyLength {
                observed_len: material.len(),
            });
        }
        Ok(Self {
            secret_ref: key.secret_ref().to_string(),
            bytes: material,
        })
    }

    /// The structured secret-ref this material resolves.
    pub fn secret_ref(&self) -> &str {
        &self.secret_ref
    }

    /// Disclosed key byte length (the bytes themselves are not).
    pub fn key_byte_len(&self) -> usize {
        self.bytes.len()
    }

    /// One-way sha256 commitment to the key bytes (a proof handle, never the
    /// bytes). Lets a report attest which key was used without disclosing it.
    pub fn material_sha256_prefix(&self) -> String {
        use sha2::{Digest, Sha256};
        use std::fmt::Write as _;
        Sha256::digest(&self.bytes)
            .iter()
            .take(8)
            .fold(String::new(), |mut acc, byte| {
                let _ = write!(acc, "{byte:02x}");
                acc
            })
    }

    /// Apply the second-layer key byte-periodically to `data` in place.
    fn xor_in_place(&self, data: &mut [u8]) {
        for (index, byte) in data.iter_mut().enumerate() {
            *byte ^= self.bytes[index % self.bytes.len()];
        }
    }
}

/// Fatal errors raised by the Siglus decrypt transform.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SiglusDecryptError {
    /// The supplied second-layer key was not the documented 16-byte length.
    #[error(
        "kaifuu.siglus.decrypt.invalid_key_length: second-layer key must be \
         {SIGLUS_SECOND_LAYER_KEY_BYTE_LEN} bytes, got {observed_len}"
    )]
    InvalidKeyLength { observed_len: usize },
}

/// Strip the constant 256-byte XOR table off an encrypted Siglus chunk, first
/// applying the optional per-game second-layer key when supplied.
/// The two layers commute (both are XOR), but the second layer is applied first
/// to mirror the engine's compose order. Returns the decrypted chunk (still
/// carrying its 8-byte LZSS size header). This is a pure, deterministic XOR
/// pass; it neither reads nor validates the header (that is the scene decoder's
/// job).
pub fn apply_xor_table(
    encrypted: &[u8],
    second_layer: Option<&SiglusSecondLayerMaterial>,
) -> Vec<u8> {
    let mut data = encrypted.to_vec();
    if let Some(material) = second_layer {
        material.xor_in_place(&mut data);
    }
    for (index, byte) in data.iter_mut().enumerate() {
        *byte ^= SIGLUS_CONSTANT_XOR_TABLE[index % SIGLUS_XOR_TABLE_LEN];
    }
    data
}

/// Strip the constant 256-byte **`Gameexe.dat`** XOR table
/// ([`SIGLUS_GAMEEXE_XOR_TABLE`]) off a `Gameexe.dat` body, first applying the
/// optional per-game exe-angou key when supplied. Mirrors [`apply_xor_table`]
/// but uses the `Gameexe.dat` constant table instead of the scene table. The
/// two layers commute (both XOR); the exe key is applied first to mirror the
/// engine's compose order. Returns the decrypted body (still carrying its
/// 8-byte `[u32 arc_size][u32 org_size]` LZSS header). Pure, deterministic.
pub fn apply_gameexe_xor_table(
    encrypted: &[u8],
    exe_key: Option<&SiglusSecondLayerMaterial>,
) -> Vec<u8> {
    let mut data = encrypted.to_vec();
    if let Some(material) = exe_key {
        material.xor_in_place(&mut data);
    }
    for (index, byte) in data.iter_mut().enumerate() {
        *byte ^= SIGLUS_GAMEEXE_XOR_TABLE[index % SIGLUS_XOR_TABLE_LEN];
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_table_is_involutive_without_second_layer() {
        let plain = [0x11u8, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99];
        let masked = apply_xor_table(&plain, None);
        let recovered = apply_xor_table(&masked, None);
        assert_eq!(recovered, plain);
        assert_ne!(masked.as_slice(), plain.as_slice());
    }

    #[test]
    fn second_layer_round_trips_and_is_length_checked() {
        let key = SiglusSecondLayerKey::from_secret_ref("secret://test/siglus-second-layer");
        let material = SiglusSecondLayerMaterial::resolve(&key, vec![0xABu8; 16])
            .expect("16-byte material resolves");
        let plain: Vec<u8> = (0u8..64).collect();
        let masked = apply_xor_table(&plain, Some(&material));
        let recovered = apply_xor_table(&masked, Some(&material));
        assert_eq!(recovered, plain);

        let bad = SiglusSecondLayerMaterial::resolve(&key, vec![0u8; 8]);
        assert!(matches!(
            bad,
            Err(SiglusDecryptError::InvalidKeyLength { observed_len: 8 })
        ));
    }

    #[test]
    fn material_debug_redacts_bytes() {
        let key = SiglusSecondLayerKey::from_secret_ref("secret://test/redaction");
        let material = SiglusSecondLayerMaterial::resolve(&key, vec![0x5Au8; 16]).unwrap();
        let rendered = format!("{material:?}");
        assert!(rendered.contains("REDACTED"));
        assert!(!rendered.contains("5a5a"));
        assert_eq!(material.key_byte_len(), 16);
    }
}
