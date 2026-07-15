//! Siglus payload decryption — **skeleton** (siglus-05; real key recovery
//! is siglus-04, real strip is siglus-06).
//! Siglus applies two layers before LZSS compression:
//! 1. a **constant 256-byte XOR table** applied byte-periodically, and
//! 2. a **per-game 16-byte second-layer key** recovered from the packed
//!    `SiglusEngine` / `game.exe` (the in-process static-key discovery
//!    seam already lives at `kaifuu_core::siglus_static_key`; siglus-04
//!    grows it to recover the real key from the packed exe).
//!    This module owns the table-strip transform. Skeleton status: the
//!    256-byte table is not vendored here (it is a per-build datum recovered
//!    against real bytes in siglus-06), and [`apply_xor_table`] returns
//!    [`SiglusDecryptError::NotImplemented`]. Raw key material is never
//!    logged, serialized, or returned — [`SiglusSecondLayerKey`] is an
//!    opaque newtype carrying only a structured secret-ref, never bytes.

use thiserror::Error;

/// Length of the constant Siglus XOR table (documented 256 bytes).
pub const SIGLUS_XOR_TABLE_LEN: usize = 256;

/// Length of the per-game second-layer key (documented 16 bytes).
pub const SIGLUS_SECOND_LAYER_KEY_BYTE_LEN: usize = 16;

/// Opaque handle to a recovered per-game second-layer key.
/// Honest-by-construction: this newtype carries ONLY a structured
/// secret-ref string (the same posture as
/// `kaifuu_core::siglus_static_key`), never raw key bytes. The skeleton
/// has no constructor that ingests bytes; siglus-04 publishes a validated
/// `secret-ref + proof hash` and constructs this from the ref.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusSecondLayerKey {
    secret_ref: String,
}

impl SiglusSecondLayerKey {
    /// The structured secret-ref this key is published under. Never the
    /// raw 16-byte material.
    pub fn secret_ref(&self) -> &str {
        &self.secret_ref
    }
}

/// Fatal errors raised by the Siglus decrypt transform.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SiglusDecryptError {
    /// The decrypt transform is not implemented in the skeleton; the real
    /// constant-256-XOR + second-layer-key strip lands in siglus-06 with
    /// the key recovered by siglus-04.
    #[error(
        "kaifuu.siglus.decrypt.not_implemented: constant-256-byte-XOR + per-game second-layer-key \
         strip is a siglus-05 skeleton stub; the real table and key are recovered against real \
         bytes in siglus-04 (key) and siglus-06 (strip)"
    )]
    NotImplemented,
    /// The supplied second-layer key was not the documented 16-byte
    /// length.
    #[error(
        "kaifuu.siglus.decrypt.invalid_key_length: second-layer key must be \
         {SIGLUS_SECOND_LAYER_KEY_BYTE_LEN} bytes, got {observed_len}"
    )]
    InvalidKeyLength { observed_len: usize },
}

/// Strip the constant 256-byte XOR table (and, when supplied, the
/// per-game second-layer key) off an encrypted Siglus payload.
/// Skeleton: always returns [`SiglusDecryptError::NotImplemented`]. The
/// real implementation (siglus-06) recovers the table against real bytes
/// and applies it byte-periodically; the second-layer key comes from
/// siglus-04. The 256-byte table is deliberately NOT a synthetic constant
/// in this skeleton — fabricating one would be a fake-success stub.
pub fn apply_xor_table(
    _encrypted: &[u8],
    _key: Option<&SiglusSecondLayerKey>,
) -> Result<Vec<u8>, SiglusDecryptError> {
    Err(SiglusDecryptError::NotImplemented)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_strip_returns_typed_not_implemented_not_fake_plaintext() {
        let err = apply_xor_table(&[0xAB; 32], None)
            .expect_err("skeleton must not fabricate decrypted plaintext");
        assert!(matches!(err, SiglusDecryptError::NotImplemented));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }
}
