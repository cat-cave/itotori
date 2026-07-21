//! Shared RPG Maker MV/MZ asset-XOR crypto core.
//! RPG Maker MV/MZ encrypts image AND audio assets with one identical scheme:
//! a 16-byte [`RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER`] signature is prepended to
//! the asset, and the first 16 bytes of the original media are XOR-masked with
//! a 16-byte key derived from `System.json`'s `encryptionKey`. Decryption
//! strips the header and XORs the first 16 body bytes back; re-encryption
//! prepends the header and XORs the first 16 plaintext bytes. XOR is
//! involutive, so a correct key yields a **byte-correct** round-trip
//! (`encrypt(decrypt(enc)) == enc`).
//! This module is the single canonical implementation. The encrypted-image
//! path ([`crate::mv_mz_encrypted_image`]), the encrypted-audio
//! path ([`crate::mv_mz_encrypted_audio`]), and the asset
//! *replacement* path ([`crate::mv_mz_encrypted_asset_replacement`],
//! ) all consume it — none re-implements the XOR primitive.
//! # THE LINE (mechanical, not prose)
//! Raw key bytes live **only** inside [`MvMzAssetKey`] (redacting `Debug`,
//! zeroizing `Drop`). They are never serialized, logged, or returned across the
//! module boundary. Callers commit to a key with [`MvMzAssetKey::material_hash`]
//! (a one-way sha256), never the bytes. The implementation is in-process Rust:
//! no `Command::new`, no helper process, no network.

use std::fmt;

use zeroize::Zeroizing;

use crate::{KaifuuResult, ProofHash, RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER, sha256_hash_bytes};

/// The number of leading bytes the RPGMV scheme XOR-masks (the key length).
pub const RPGMAKER_ASSET_XOR_PREFIX_LEN: usize = 16;

/// Why an asset could not be treated as a well-formed RPGMV-header asset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MvMzAssetVariantError {
    /// Asset is shorter than the 16-byte RPGMV header.
    TooShort,
    /// Asset does not begin with the RPGMV header magic.
    MissingHeaderMagic,
}

/// A recovered/candidate 16-byte asset key. Raw bytes are private, never
/// serialized, redacted in `Debug`, and zeroized on drop.
pub struct MvMzAssetKey {
    bytes: Zeroizing<Vec<u8>>,
}

impl MvMzAssetKey {
    /// Wrap raw key bytes. The bytes are held privately and never leave the
    /// type except as a one-way commitment.
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self {
            bytes: Zeroizing::new(bytes.to_vec()),
        }
    }

    pub fn byte_len(&self) -> usize {
        self.bytes.len()
    }

    /// One-way sha256 commitment to the key bytes (never the bytes themselves).
    pub fn material_hash(&self) -> KaifuuResult<ProofHash> {
        Ok(ProofHash::new(sha256_hash_bytes(&self.bytes))?)
    }
}

impl fmt::Debug for MvMzAssetKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MvMzAssetKey")
            .field("bytes", &"[REDACTED:kaifuu.secret_redacted]")
            .field("byte_len", &self.bytes.len())
            .finish()
    }
}

/// XOR the first [`RPGMAKER_ASSET_XOR_PREFIX_LEN`] bytes of `region` with `key`
/// (the MV/MZ asset mask). Bytes beyond the prefix are untouched.
fn xor_asset_prefix(region: &mut [u8], key: &[u8]) {
    if key.is_empty() {
        return;
    }
    let span = region.len().min(RPGMAKER_ASSET_XOR_PREFIX_LEN);
    for (index, byte) in region[..span].iter_mut().enumerate() {
        *byte ^= key[index % key.len()];
    }
}

/// Decrypt an RPGMV-header encrypted asset to its plaintext media bytes. Strips
/// the 16-byte header and unmasks the first 16 body bytes. Returns a structured
/// [`MvMzAssetVariantError`] for any asset that is not a well-formed
/// RPGMV-header asset — no panic, no partial output.
pub fn decrypt_rpgmaker_asset(
    encrypted: &[u8],
    key: &MvMzAssetKey,
) -> Result<Vec<u8>, MvMzAssetVariantError> {
    let header_len = RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len();
    if encrypted.len() < header_len {
        return Err(MvMzAssetVariantError::TooShort);
    }
    if &encrypted[..header_len] != RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER {
        return Err(MvMzAssetVariantError::MissingHeaderMagic);
    }
    let mut plaintext = encrypted[header_len..].to_vec();
    xor_asset_prefix(&mut plaintext, &key.bytes);
    Ok(plaintext)
}

/// Re-encrypt plaintext media bytes into an RPGMV-header encrypted asset:
/// prepend the 16-byte header and mask the first 16 plaintext bytes. The
/// inverse of [`decrypt_rpgmaker_asset`] for the same key.
pub fn encrypt_rpgmaker_asset(plaintext: &[u8], key: &MvMzAssetKey) -> Vec<u8> {
    let header_len = RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len();
    let mut out = Vec::with_capacity(header_len + plaintext.len());
    out.extend_from_slice(RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER);
    out.extend_from_slice(plaintext);
    xor_asset_prefix(&mut out[header_len..], &key.bytes);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8; 16] = b"ITOTORIFIXTUREK0";

    #[test]
    fn encrypt_decrypt_is_byte_correct_round_trip() {
        let key = MvMzAssetKey::from_bytes(KEY);
        let plaintext = b"OggS-synthetic-plaintext-payload".to_vec();
        let encrypted = encrypt_rpgmaker_asset(&plaintext, &key);
        assert_eq!(
            &encrypted[..RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()],
            RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER
        );
        let recovered = decrypt_rpgmaker_asset(&encrypted, &key).expect("decrypts");
        assert_eq!(recovered, plaintext);
        let reencrypted = encrypt_rpgmaker_asset(&recovered, &key);
        assert_eq!(reencrypted, encrypted, "byte-correct");
    }

    #[test]
    fn only_the_first_16_body_bytes_are_masked() {
        let key = MvMzAssetKey::from_bytes(KEY);
        // 40-byte plaintext: bytes beyond the 16-byte prefix must survive raw.
        let plaintext: Vec<u8> = (0u8..40).collect();
        let encrypted = encrypt_rpgmaker_asset(&plaintext, &key);
        let body = &encrypted[RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()..];
        assert_eq!(&body[RPGMAKER_ASSET_XOR_PREFIX_LEN..], &plaintext[16..]);
    }

    #[test]
    fn malformed_header_is_a_variant_error() {
        let key = MvMzAssetKey::from_bytes(KEY);
        assert_eq!(
            decrypt_rpgmaker_asset(b"not-a-header-xxxxxxxx", &key).err(),
            Some(MvMzAssetVariantError::MissingHeaderMagic)
        );
        assert_eq!(
            decrypt_rpgmaker_asset(b"RPGMV", &key).err(),
            Some(MvMzAssetVariantError::TooShort)
        );
    }

    #[test]
    fn decrypt_rpgmaker_asset_with_empty_key_leaves_body_unmasked() {
        let key = MvMzAssetKey::from_bytes(&[]);
        let body = b"unmasked synthetic media";
        let mut encrypted = RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.to_vec();
        encrypted.extend_from_slice(body);

        let decrypted = decrypt_rpgmaker_asset(&encrypted, &key).expect("empty key is accepted");

        assert_eq!(decrypted, body);
    }

    #[test]
    fn key_debug_is_redacted() {
        let key = MvMzAssetKey::from_bytes(KEY);
        let rendered = format!("{key:?}");
        assert!(rendered.contains("REDACTED"));
        assert!(!rendered.contains("ITOTORIFIXTUREK0"));
    }

    #[test]
    fn material_hash_is_the_key_sha256() {
        let key = MvMzAssetKey::from_bytes(KEY);
        assert_eq!(
            key.material_hash().unwrap().as_str(),
            sha256_hash_bytes(KEY)
        );
    }
}
