use super::{MediaCapability, MvMzKeySource, MvMzSliceOp, MvMzSliceOutcome, SliceReplacement};
use kaifuu_core::mv_mz_encrypted_audio::{OGG_SIGNATURE, SYNTHETIC_OGG};
use kaifuu_core::mv_mz_encrypted_image::{PNG_SIGNATURE, SYNTHETIC_PNG};
use kaifuu_core::{MvMzAssetKey, SecretRef, encrypt_rpgmaker_asset};

/// Provenance node id stamped into generated reports.
pub const MV_MZ_SLICE_SOURCE_NODE_ID: &str = "rpgmaker-mv-mz-encrypted-asset-slice";

/// The clearly-fake 16-byte fixture key. Its hex is the synthetic `System.json`
/// `encryptionKey`.
const SLICE_KEY_CORRECT: &[u8; 16] = b"ITOTORIFIXTUREK0";
/// A decodable-but-wrong 16-byte key — drives the wrong-key rejection.
const SLICE_KEY_WRONG: &[u8; 16] = b"XXXXXXXXXXXXXXXX";

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap_or('0'));
    }
    out
}

fn slice_secret_ref() -> SecretRef {
    SecretRef::new("local-secret:rpgmaker-mv-mz-asset-key")
        .expect("static local-secret ref is valid")
}

/// A clearly-synthetic replacement image (PNG signature + fake payload).
fn replacement_image() -> Vec<u8> {
    let mut bytes = PNG_SIGNATURE.to_vec();
    bytes.extend_from_slice(b"itotori-k068-replacement-image-0001");
    bytes
}

/// A clearly-synthetic replacement audio (OggS capture pattern + fake payload).
fn replacement_audio() -> Vec<u8> {
    let mut bytes = OGG_SIGNATURE.to_vec();
    bytes.extend_from_slice(b"itotori-k068-replacement-audio-0001");
    bytes
}

/// Encrypt the synthetic PNG with the correct key (a synthetic encrypted image).
fn encrypted_image() -> Vec<u8> {
    encrypt_rpgmaker_asset(SYNTHETIC_PNG, &MvMzAssetKey::from_bytes(SLICE_KEY_CORRECT))
}

/// Encrypt the synthetic OGG with the correct key (a synthetic encrypted audio).
fn encrypted_audio() -> Vec<u8> {
    encrypt_rpgmaker_asset(SYNTHETIC_OGG, &MvMzAssetKey::from_bytes(SLICE_KEY_CORRECT))
}

/// The canonical synthetic slice fixture: the decrypt/round-trip/replace happy
/// paths for image + audio, image-derived key recovery, and one op per typed
/// failure (no-key, bad-key material, wrong-key, unsupported-suffix,
/// capability-diff, replacement-not-media).
#[must_use]
pub fn canonical_slice_fixture() -> Vec<MvMzSliceOp> {
    let key_hex = hex_encode(SLICE_KEY_CORRECT);
    let wrong_hex = hex_encode(SLICE_KEY_WRONG);
    vec![
        // Image decrypt + identity round-trip (System.json encryptionKey).
        MvMzSliceOp {
            entry_id: "image-round-trip".to_string(),
            asset_file_name: "pictures/title.rpgmvp".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(key_hex.clone()),
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: None,
            expected: MvMzSliceOutcome::DecryptedRoundTripped,
        },
        // Audio decrypt + identity round-trip (MZ.ogg_ suffix).
        MvMzSliceOp {
            entry_id: "audio-round-trip".to_string(),
            asset_file_name: "bgm/theme.ogg_".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(key_hex.clone()),
            encrypted_asset: encrypted_audio(),
            known_plaintext: SYNTHETIC_OGG.to_vec(),
            replacement: None,
            expected: MvMzSliceOutcome::DecryptedRoundTripped,
        },
        // Image-derived key recovery (no System.json) + round-trip.
        MvMzSliceOp {
            entry_id: "image-derived-key".to_string(),
            asset_file_name: "pictures/logo.png_".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::ImageDerived,
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: None,
            expected: MvMzSliceOutcome::DecryptedRoundTripped,
        },
        // Trivial replacement patch (image).
        MvMzSliceOp {
            entry_id: "image-replace".to_string(),
            asset_file_name: "pictures/title.rpgmvp".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(key_hex.clone()),
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: Some(SliceReplacement {
                capability: MediaCapability::Image,
                plaintext: replacement_image(),
            }),
            expected: MvMzSliceOutcome::Replaced,
        },
        // Trivial replacement patch (audio, MV.rpgmvo suffix).
        MvMzSliceOp {
            entry_id: "audio-replace".to_string(),
            asset_file_name: "bgm/theme.rpgmvo".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(key_hex.clone()),
            encrypted_asset: encrypted_audio(),
            known_plaintext: SYNTHETIC_OGG.to_vec(),
            replacement: Some(SliceReplacement {
                capability: MediaCapability::Audio,
                plaintext: replacement_audio(),
            }),
            expected: MvMzSliceOutcome::Replaced,
        },
        // Typed: no key.
        MvMzSliceOp {
            entry_id: "no-key".to_string(),
            asset_file_name: "pictures/title.rpgmvp".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::None,
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: None,
            expected: MvMzSliceOutcome::NoKey,
        },
        // Typed: bad key material (undecodable encryptionKey).
        MvMzSliceOp {
            entry_id: "bad-key-material".to_string(),
            asset_file_name: "pictures/title.rpgmvp".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey("not-hex".to_string()),
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: None,
            expected: MvMzSliceOutcome::BadKeyMaterial,
        },
        // Typed: wrong key (decodable hex, decrypt fails the media signature).
        MvMzSliceOp {
            entry_id: "wrong-key".to_string(),
            asset_file_name: "pictures/title.rpgmvp".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(wrong_hex),
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: None,
            expected: MvMzSliceOutcome::WrongKey,
        },
        // Typed: unsupported suffix.
        MvMzSliceOp {
            entry_id: "unsupported-suffix".to_string(),
            asset_file_name: "movies/opening.webm".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(key_hex.clone()),
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: None,
            expected: MvMzSliceOutcome::UnsupportedSuffix,
        },
        // Typed: audio/image capability diff (image blob patched over audio asset).
        MvMzSliceOp {
            entry_id: "capability-diff".to_string(),
            asset_file_name: "bgm/theme.ogg_".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(key_hex.clone()),
            encrypted_asset: encrypted_audio(),
            known_plaintext: SYNTHETIC_OGG.to_vec(),
            replacement: Some(SliceReplacement {
                capability: MediaCapability::Image,
                plaintext: replacement_image(),
            }),
            expected: MvMzSliceOutcome::CapabilityDiff,
        },
        // Typed: replacement is not valid media of the declared kind.
        MvMzSliceOp {
            entry_id: "replacement-not-media".to_string(),
            asset_file_name: "pictures/title.rpgmvp".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(key_hex),
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: Some(SliceReplacement {
                capability: MediaCapability::Image,
                plaintext: b"itotori-not-valid-media-blob".to_vec(),
            }),
            expected: MvMzSliceOutcome::ReplacementNotMedia,
        },
    ]
}

#[cfg(test)]
mod tests;
