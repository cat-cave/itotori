//! `Gameexe.dat` → UTF-16LE inventory — **skeleton** (siglus-05).
//!
//! Siglus stores its configuration/name tables in `Gameexe.dat`: a
//! constant-256-byte-XOR-masked, Siglus-LZSS-compressed blob whose
//! plaintext is **UTF-16LE** key/value lines (the analogue of RealLive's
//! Shift-JIS `Gameexe.ini`). The recovered known-plaintext header is also
//! the validation oracle for the siglus-04 second-layer-key recovery.
//!
//! Skeleton status: [`parse_gameexe_dat`] returns
//! [`GameexeDatError::NotImplemented`]. The decrypt → decompress →
//! UTF-16LE decode → key inventory pipeline lands against real bytes
//! downstream.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A single parsed `Gameexe.dat` key/value entry (UTF-16LE-decoded to a
/// UTF-8 [`String`] at the boundary).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeDatEntry {
    /// Configuration key (e.g. a `#NAMAE`-family speaker-table key).
    pub key: String,
    /// Raw value text (UTF-16LE-decoded), preserved verbatim.
    pub value: String,
}

/// Parsed `Gameexe.dat` inventory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeDatReport {
    pub entries: Vec<GameexeDatEntry>,
}

/// Fatal errors raised by the `Gameexe.dat` reader.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GameexeDatError {
    /// The `Gameexe.dat` reader is not implemented in the skeleton.
    #[error(
        "kaifuu.siglus.gameexe.not_implemented: Gameexe.dat reader is a siglus-05 skeleton stub; \
         the real decrypt -> decompress -> UTF-16LE decode -> key inventory pipeline lands against \
         real bytes downstream"
    )]
    NotImplemented,
    /// The decoded plaintext was not valid UTF-16LE.
    #[error(
        "kaifuu.siglus.gameexe.invalid_utf16le: Gameexe.dat plaintext is not valid UTF-16LE at \
         byte {byte_offset}"
    )]
    InvalidUtf16Le { byte_offset: usize },
}

/// Parse a (still-encrypted, still-compressed) `Gameexe.dat` blob into a
/// [`GameexeDatReport`].
///
/// Skeleton: always returns [`GameexeDatError::NotImplemented`]. The real
/// implementation chains [`crate::decrypt`] → [`crate::decompress`] →
/// UTF-16LE decode (via `encoding_rs`) before building the inventory.
pub fn parse_gameexe_dat(_bytes: &[u8]) -> Result<GameexeDatReport, GameexeDatError> {
    Err(GameexeDatError::NotImplemented)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_gameexe_returns_typed_not_implemented_not_fake_inventory() {
        let err = parse_gameexe_dat(&[0u8; 64])
            .expect_err("skeleton must not fabricate a Gameexe.dat inventory");
        assert!(matches!(err, GameexeDatError::NotImplemented));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }
}
