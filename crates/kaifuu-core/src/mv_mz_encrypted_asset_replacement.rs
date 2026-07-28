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

use serde::{Deserialize, Serialize};

use crate::mv_mz_asset_xor::RPGMAKER_ASSET_XOR_PREFIX_LEN;
use crate::mv_mz_encrypted_audio::{OGG_SIGNATURE, SYNTHETIC_OGG};
use crate::mv_mz_encrypted_image::{PNG_SIGNATURE, SYNTHETIC_PNG};
use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult, KeyMaterialKind,
    KeyValidationProof, OperationStatus, PartialDiagnosticSeverity, PatchBackTransform, ProofHash,
    RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER, SecretRef, SurfaceTransform, redact_for_log_or_report,
    sha256_hash_bytes, stable_json,
};

pub const MV_MZ_ASSET_REPLACEMENT_SCHEMA_VERSION: &str = "0.1.0";

pub const MV_MZ_ASSET_REPLACEMENT_ENGINE_FAMILY: &str = "rpg_maker_mv_mz";
pub const MV_MZ_ASSET_REPLACEMENT_VARIANT: &str = "mv_or_mz";
pub const MV_MZ_ASSET_REPLACEMENT_FIXTURE_ID: &str = "kaifuu-rpgmaker-mv-mz-asset-replacement";
/// The MV/MZ asset-XOR scheme id — shared verbatim with the image/audio paths.
pub const MV_MZ_ASSET_REPLACEMENT_CRYPTO_PROFILE_ID: &str = "rpgmaker/mv_mz/asset_xor_v1";
/// The single secret requirement: the `System.json` asset key — the same key
/// requirement the image/audio paths declare (one project key masks all media).
pub const MV_MZ_ASSET_REPLACEMENT_REQUIREMENT_ID: &str = "rpgmaker-mv-mz-asset-key";

pub const MV_MZ_ASSET_REPLACEMENT_SUPPORT_BOUNDARY: &str = "Kaifuu RPG Maker MV/MZ encrypted-asset replacement is in-process Rust (the shared RPGMV-header XOR-with-System.json-key scheme; image MV .rpgmvp / MZ .png_, audio MV .rpgmvo / MZ .ogg_); it never shells out. A new synthetic media asset is encrypted with the resolved key and patched in, then the patch is verified: decrypt(patched)==replacement, the RPGMV header and non-replaced tail bytes are exact, and the patch differs from the original. A consumable patch is published only after the resolved key's sha256 matches the declared key commitment, the replacement is valid media, and every verify check passes; wrong-key, tampered, missing-key, unsupported-surface, and non-media-replacement entries are rejected with typed findings before any consumable patch. Raw key bytes are never logged, serialized, or returned — the manifest and reports carry secret-refs + sha256 commitments only.";

pub const SEMANTIC_REPLACEMENT_REPLACED: &str = "kaifuu.rpgmaker.asset_replacement.replaced";
pub const SEMANTIC_REPLACEMENT_WRONG_KEY: &str = "kaifuu.rpgmaker.asset_replacement.wrong_key";
pub const SEMANTIC_REPLACEMENT_TAMPERED: &str = "kaifuu.rpgmaker.asset_replacement.tampered";
pub const SEMANTIC_REPLACEMENT_MISSING_KEY: &str = "kaifuu.rpgmaker.asset_replacement.missing_key";
pub const SEMANTIC_REPLACEMENT_UNSUPPORTED_SURFACE: &str =
    "kaifuu.rpgmaker.asset_replacement.unsupported_surface";
pub const SEMANTIC_REPLACEMENT_NOT_MEDIA: &str =
    "kaifuu.rpgmaker.asset_replacement.replacement_not_media";

const FINDING_WRONG_KEY: &str = "rpgmaker.asset_replacement.wrong_key";
const FINDING_TAMPERED: &str = "rpgmaker.asset_replacement.tampered";
const FINDING_MISSING_KEY: &str = "rpgmaker.asset_replacement.missing_key";
const FINDING_UNSUPPORTED_SURFACE: &str = "rpgmaker.asset_replacement.unsupported_surface";
const FINDING_NOT_MEDIA: &str = "rpgmaker.asset_replacement.replacement_not_media";
const FINDING_OUTCOME_MISMATCH: &str = "rpgmaker.asset_replacement.outcome_mismatch";
const FINDING_INTERNAL: &str = "rpgmaker.asset_replacement.internal";

/// The synthetic "correct" 16-byte asset key. Clearly fake fixture material.
/// Its sha256 is the manifest's declared `keyCommitmentSha256`.
const SYNTHETIC_KEY_CORRECT: &[u8; 16] = b"ITOTORIFIXTUREK0";
/// A synthetic key whose commitment does NOT match — drives wrong-key rejection.
const SYNTHETIC_KEY_WRONG: &[u8; 16] = b"XXXXXXXXXXXXXXXX";

/// The synthetic replacement IMAGE plaintext: the PNG signature followed by a
/// clearly-fake payload. Signature-bearing synthetic media (the same
/// signature-based bar the image/audio paths use); NOT a retail asset.
fn replacement_image() -> Vec<u8> {
    let mut bytes = PNG_SIGNATURE.to_vec();
    bytes.extend_from_slice(b"itotori-replacement-image-payload-0001");
    bytes
}

/// The synthetic replacement AUDIO plaintext: the `OggS` capture pattern
/// followed by a clearly-fake payload.
fn replacement_audio() -> Vec<u8> {
    let mut bytes = OGG_SIGNATURE.to_vec();
    bytes.extend_from_slice(b"itotori-replacement-audio-payload-0001");
    bytes
}

/// A blob carrying NEITHER media signature — drives the `replacement_not_media`
/// scenario.
fn replacement_not_media_blob() -> Vec<u8> {
    b"itotori-not-valid-media-replacement-blob".to_vec()
}

mod path;
pub use path::*;

mod model;
pub use model::*;

mod run;

pub use run::{MvMzAssetReplacementRequest, run_mv_mz_asset_replacement};

#[cfg(test)]
#[path = "mv_mz_encrypted_asset_replacement_tests.rs"]
mod tests;
