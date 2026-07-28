//! RPG Maker MV/MZ encrypted-IMAGE decrypt + re-encrypt path.
//! This is the **encrypted-media** path for RPG Maker MV/MZ named image
//! surfaces. It is mechanically separate from two neighbouring nodes:
//! - ([`crate::mv_mz_readiness`]) is JSON-text inventory only and
//!   hard-pins encrypted media `extractable = false` / `patchable = false`.
//!   THIS node never touches a JSON-text surface and never widens that node's
//!   claims.
//! - ([`crate::encrypted_media_proof`]) is a research-only
//!   *readiness* proof that NEVER decrypts. THIS node is the distinct path
//!   that genuinely decrypts AND re-encrypts an image asset, with a
//!   byte-correct round-trip proof.
//! # The scheme (native Rust, NO shell-out)
//! RPG Maker MV/MZ encrypted images are the standard `RPGMV`-header scheme: a
//! 16-byte [`RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER`] signature is prepended to
//! the asset, and the first 16 bytes of the original PNG are XOR-masked with a
//! 16-byte key derived from `System.json`'s `encryptionKey`. Decryption strips
//! the header and XORs the first 16 body bytes back; re-encryption prepends the
//! header and XORs the first 16 plaintext bytes. XOR is involutive, so a
//! correct key yields a **byte-correct** round-trip
//! (`re_encrypt(decrypt(enc)) == enc`). The implementation is in-process Rust:
//! no `Command::new`, no helper process, no network.
//! # THE LINE (mechanical, not prose)
//! - Raw key bytes live **only** inside the module-private [`ImageAssetKey`]
//!   (redacting `Debug`, zeroizing `Drop`). They are never serialized, logged,
//!   or returned across the module boundary. Reports carry structured
//!   **secret-refs + proof hashes / counts** only.
//! - A re-encrypted patch artifact is produced **only** after a candidate key
//!   decrypts the asset to a valid PNG. Wrong-key, missing-key,
//!   unsupported-surface (audio / JSON), and unsupported-variant
//!   (malformed-header) entries fail **before** any re-encryption — every one
//!   is a structured [`MvMzEncryptedImageFinding`], never a silent skip or a
//!   panic.
//! - Audio and JSON surfaces are explicitly out of scope: an entry whose
//!   `surface_codec` is not [`CodecTransform::PngImage`] is rejected with a
//!   structured `unsupported_surface` finding before any byte is decrypted.
//! # Fixtures are synthetic + public
//! Every byte is synthesised in-module: a tiny real 1x1 PNG ([`SYNTHETIC_PNG`])
//! and a clearly-fake 16-byte key. No retail image bytes and no real keys are
//! ever vendored; the report carries only hashes / counts / secret-refs.

mod run;
include!("mv_mz_encrypted_image_parts/001.rs");
include!("mv_mz_encrypted_image_parts/002.rs");
