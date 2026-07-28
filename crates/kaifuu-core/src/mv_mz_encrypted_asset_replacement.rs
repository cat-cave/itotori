//! RPG Maker MV/MZ encrypted-asset **replacement** patch + verify.
//! Where ([`crate::mv_mz_encrypted_image`]) and
//! ([`crate::mv_mz_encrypted_audio`]) prove a byte-correct *identity*
//! round-trip (`encrypt(decrypt(enc)) == enc`), THIS node proves an actual
//! **replacement**: a NEW synthetic media asset is encrypted with the game's
//! key (resolved via a declared secret ref) and patched in, producing a
//! byte-correct encrypted asset the game would decrypt to the *replacement*
//! (not the original). It then VERIFIES the patch and REJECTS a wrong-key or
//! tampered patch.
//! # The scheme (shared core, native Rust, NO shell-out)
//! The XOR primitive, key type, decrypt, and re-encrypt are the single
//! canonical [`crate::mv_mz_asset_xor`] implementation — image, audio, and this
//! replacement path all consume it; none re-implements the crypto. MV/MZ
//! encrypt image AND audio identically: a 16-byte
//! [`RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER`] is prepended and the first 16 bytes
//! of the media are XOR-masked with the 16-byte `System.json` key. Bytes beyond
//! the 16-byte prefix are stored verbatim.
//! MV vs MZ differ only in file extension, not in the scheme:
//! image MV `.rpgmvp` / MZ `.png_`; audio MV `.rpgmvo` / MZ `.ogg_`. Both route
//! through this path.
//! # The replacement + verify transform (per entry)
//! 1. The surface codec must match the media kind (`png_image` for an image
//!    replacement, `ogg_audio` for an audio replacement); anything else is an
//!    `unsupported_surface` before any byte is touched.
//! 2. The asset key is resolved from the declared **secret ref**. No key →
//!    `missing_key`, no patch produced.
//! 3. **Key-commitment gate (credential posture):** the resolved key's sha256
//!    must equal the manifest's declared `keyCommitmentSha256`. A mismatch is a
//!    WRONG KEY — rejected with a typed finding, no patch produced. This is how
//!    a wrong-key patch is refused without ever embedding the key.
//! 4. The replacement plaintext must carry the declared media signature (PNG /
//!    OggS); otherwise `replacement_not_media`.
//! 5. Encrypt the replacement with the key → the patched asset. For the tamper
//!    scenario a single byte of the patched asset is then corrupted.
//! 6. **Verify:** `decrypt(patched, key) == replacement` (round-trip); the first
//!    16 bytes are exactly the RPGMV header; the non-replaced tail (bytes beyond
//!    the 16-byte XOR prefix) is byte-identical to the replacement; and the
//!    patched asset differs from the original encrypted asset (a real
//!    replacement occurred). A tampered patch fails the round-trip and is
//!    REJECTED. `decrypt(patched)` must also equal the manifest's declared
//!    `replacementSha256`.
//! # THE LINE (mechanical, not prose)
//! - Raw key bytes live only inside the shared [`MvMzAssetKey`] (redacting
//!   `Debug`, zeroizing `Drop`). Reports carry secret-refs + sha256 commitments
//!   hashes / counts only — never the key, never the media bytes.
//! - A consumable replacement proof is produced ONLY after the key commitment
//!   matches, the replacement is valid media, and every verify check passes.
//!   Wrong-key, tampered, missing-key, unsupported-surface, and
//!   non-media-replacement entries fail BEFORE a consumable patch is published —
//!   each is a structured finding, never a silent skip or panic.
//! # Fixtures are synthetic + public
//! Every byte is synthesised in-module: the original in-game plaintext reuses
//! the public synthetic media; the replacement is a
//! clearly-synthetic signature-bearing blob; the key is a clearly-fake 16-byte
//! test key. No retail media and no real keys are ever vendored.

mod run;

#[cfg(test)]
#[path = "mv_mz_encrypted_asset_replacement_tests.rs"]
mod tests;
include!("mv_mz_encrypted_asset_replacement_parts/001.rs");
include!("mv_mz_encrypted_asset_replacement_parts/002.rs");
