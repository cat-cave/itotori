//! RPG Maker MV/MZ encrypted-asset decrypt/encrypt round-trip proof.
//!
//! Two independent layers of evidence:
//!
//! 1. `synthetic_*` — an always-run proof of the RPGMV asset-XOR scheme on a
//!    deterministically-built encrypted PNG and OggS asset. No game bytes are
//!    involved, so the algorithm is provably correct in any environment
//!    (including CI where the commercial title is not staged).
//!
//! 2. `real_bytes_*` — the load-bearing proof. When the supplied commercial
//!    RPG Maker MV title (profile B) is staged, this reads the REAL encrypted
//!    `.rpgmvp` image and `.rpgmvo` audio bytes, derives the 16-byte key from
//!    `www/data/System.json`'s `encryptionKey`, and asserts
//!    `decrypt(encrypted) == plaintext` AND `encrypt(plaintext) == encrypted`
//!    for at least one image and one audio asset, cross-checked against the
//!    metadata-only manifest hashes. When the title is absent it SKIPs (prints
//!    a staging hint and returns) — it never panics on an absent corpus.
//!
//! The committed manifest is metadata-only: SHA-256 hashes, byte counts, and
//! the key's one-way SHA-256 commitment. No encrypted bytes, no decrypted
//! bytes, and no key material are ever committed.

use std::env;
use std::path::{Path, PathBuf};

use kaifuu_core::{
    MvMzAssetKey, RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER, decrypt_rpgmaker_asset,
    encrypt_rpgmaker_asset,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

const SOURCE_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ_ENCRYPTED";
const DEFAULT_SOURCE_ROOT: &str = "/scratch/itotori-research/rpg-maker-mv-mz/countryside-life/inakaraifu.rj390522.v1-0.en/countryside-life-2025/www";
const MANIFEST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/public/kaifuu-rpgmaker-mv-mz-profile-b.manifest.json"
));

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Decode hexadecimal text into bytes (the manifest and System.json key are hex).
fn decode_hex(text: &str) -> Vec<u8> {
    let clean: Vec<u8> = text.bytes().filter(u8::is_ascii_hexdigit).collect();
    assert!(
        clean.len().is_multiple_of(2),
        "hex text has an even digit count"
    );
    clean
        .chunks_exact(2)
        .map(|pair| {
            let hi = (pair[0] as char).to_digit(16).expect("hex digit");
            let lo = (pair[1] as char).to_digit(16).expect("hex digit");
            ((hi << 4) | lo) as u8
        })
        .collect()
}

// --- Layer 1: synthetic, always-run algorithm proof ------------------------

/// Build a synthetic encrypted asset deterministically: take a plaintext whose
/// first bytes are a real media magic, XOR the first 16 with the key, and
/// prepend the RPGMV header. This is exactly what the RPG Maker editor emits.
fn synthetic_encrypt(plaintext: &[u8], key: &MvMzAssetKey) -> Vec<u8> {
    encrypt_rpgmaker_asset(plaintext, key)
}

#[test]
fn synthetic_image_and_audio_round_trip_is_byte_correct() {
    // A fixed 16-byte key (never a real game key) so the proof is hermetic.
    let key = MvMzAssetKey::from_bytes(&decode_hex("0f1e2d3c4b5a69788796a5b4c3d2e1f0"));

    // Synthetic PNG: 8-byte PNG signature + deterministic tail.
    let mut png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    png.extend((0u8..48).map(|byte| byte.wrapping_mul(7)));
    // Synthetic OggS: 4-byte Ogg capture pattern + deterministic tail.
    let mut ogg = vec![0x4f, 0x67, 0x67, 0x53];
    ogg.extend((0u8..52).map(|byte| byte.wrapping_add(3)));

    for plaintext in [&png, &ogg] {
        let encrypted = synthetic_encrypt(plaintext, &key);
        assert_eq!(
            &encrypted[..RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()],
            RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER,
            "encrypted asset carries the RPGMV media header"
        );
        // Bytes past the 16-byte XOR prefix survive verbatim.
        let body = &encrypted[RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()..];
        assert_eq!(&body[16..], &plaintext[16..]);

        let decrypted = decrypt_rpgmaker_asset(&encrypted, &key).expect("synthetic decrypts");
        assert_eq!(&decrypted, plaintext, "decrypt(encrypted) == plaintext");

        let reencrypted = encrypt_rpgmaker_asset(&decrypted, &key);
        assert_eq!(reencrypted, encrypted, "encrypt(plaintext) == encrypted");
    }
}

// --- Layer 2: real encrypted game bytes (env-gated, SKIP when absent) -------

struct AssetRow {
    path: String,
    kind: String,
    magic: Vec<u8>,
    encrypted_sha256: String,
    encrypted_bytes: u64,
    decrypted_sha256: String,
    decrypted_bytes: u64,
}

fn manifest() -> Value {
    serde_json::from_str(MANIFEST).expect("profile-B manifest parses")
}

fn manifest_assets(manifest: &Value) -> Vec<AssetRow> {
    manifest["assets"]
        .as_array()
        .expect("assets array")
        .iter()
        .map(|row| AssetRow {
            path: row["path"].as_str().expect("asset path").to_string(),
            kind: row["kind"].as_str().expect("asset kind").to_string(),
            magic: decode_hex(row["mediaMagicHex"].as_str().expect("magic hex")),
            encrypted_sha256: row["encryptedSha256"]
                .as_str()
                .expect("enc sha")
                .to_string(),
            encrypted_bytes: row["encryptedBytes"].as_u64().expect("enc bytes"),
            decrypted_sha256: row["decryptedSha256"]
                .as_str()
                .expect("dec sha")
                .to_string(),
            decrypted_bytes: row["decryptedBytes"].as_u64().expect("dec bytes"),
        })
        .collect()
}

fn source_www_dir() -> Option<PathBuf> {
    let root = env::var_os(SOURCE_ROOT_ENV)
        .map_or_else(|| PathBuf::from(DEFAULT_SOURCE_ROOT), PathBuf::from);
    if root.join("data/System.json").is_file() {
        Some(root)
    } else {
        eprintln!(
            "SKIP: encrypted RPG Maker MV/MZ profile-B title not staged at {}; set {SOURCE_ROOT_ENV} to a www dir",
            root.display()
        );
        None
    }
}

/// Derive the 16-byte asset key from the real `www/data/System.json`.
fn key_from_system_json(www: &Path) -> MvMzAssetKey {
    let raw = std::fs::read(www.join("data/System.json")).expect("read System.json");
    // System.json may carry a UTF-8 BOM; strip it before JSON parsing.
    let text = std::str::from_utf8(&raw)
        .expect("System.json is UTF-8")
        .trim_start_matches('\u{feff}');
    let system: Value = serde_json::from_str(text).expect("System.json parses");
    assert_eq!(
        system["hasEncryptedImages"].as_bool(),
        Some(true),
        "profile-B title declares encrypted images"
    );
    assert_eq!(
        system["hasEncryptedAudio"].as_bool(),
        Some(true),
        "profile-B title declares encrypted audio"
    );
    let key_hex = system["encryptionKey"]
        .as_str()
        .expect("System.json encryptionKey");
    MvMzAssetKey::from_bytes(&decode_hex(key_hex))
}

#[test]
fn real_encrypted_image_and_audio_round_trip_against_supplied_game() {
    let manifest = manifest();
    assert_eq!(
        manifest["SPDX-License-Identifier"].as_str(),
        Some("LicenseRef-Countryside-Life-Commercial-Proprietary"),
        "manifest preserves the proprietary SPDX LicenseRef"
    );
    assert_eq!(
        manifest["fixture"]["provenance"]["rawAssetPolicy"].as_str(),
        Some("contains-no-copyrighted-game-assets"),
        "manifest is metadata-only by policy"
    );
    let rows = manifest_assets(&manifest);

    let Some(www) = source_www_dir() else {
        return;
    };

    let key = key_from_system_json(&www);
    // The manifest commits to the key by SHA-256 only; prove the derived key
    // matches that commitment without ever printing or storing key bytes.
    assert_eq!(
        key.material_hash().expect("key hash").as_str(),
        manifest["encryption"]["keyMaterialSha256"]
            .as_str()
            .expect("key commitment"),
        "the key derived from System.json matches the manifest commitment"
    );

    let mut images_proven = 0usize;
    let mut audio_proven = 0usize;

    for row in &rows {
        let rel = row.path.strip_prefix("www/").unwrap_or(&row.path);
        let encrypted = std::fs::read(www.join(rel)).expect("read encrypted asset");

        // The on-disk encrypted bytes are exactly what the manifest recorded.
        assert_eq!(
            encrypted.len() as u64,
            row.encrypted_bytes,
            "{} encrypted byte count matches manifest",
            row.path
        );
        assert_eq!(
            sha256_hex(&encrypted),
            row.encrypted_sha256,
            "{} encrypted SHA-256 matches manifest",
            row.path
        );
        assert_eq!(
            &encrypted[..RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()],
            RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER,
            "{} carries the RPGMV media header",
            row.path
        );

        // decrypt(encrypted) == plaintext.
        let decrypted = decrypt_rpgmaker_asset(&encrypted, &key)
            .unwrap_or_else(|error| panic!("{} decrypts: {error:?}", row.path));
        assert_eq!(
            &decrypted[..row.magic.len()],
            row.magic.as_slice(),
            "{} decrypts to its declared media magic",
            row.path
        );
        assert_eq!(
            decrypted.len() as u64,
            row.decrypted_bytes,
            "{} decrypted byte count matches manifest",
            row.path
        );
        assert_eq!(
            sha256_hex(&decrypted),
            row.decrypted_sha256,
            "{} decrypted SHA-256 matches manifest",
            row.path
        );

        // encrypt(plaintext) == encrypted (byte-for-byte, the real inverse).
        let reencrypted = encrypt_rpgmaker_asset(&decrypted, &key);
        assert_eq!(
            reencrypted, encrypted,
            "{} re-encrypts byte-for-byte to the original encrypted asset",
            row.path
        );

        match row.kind.as_str() {
            "image" => images_proven += 1,
            "audio" => audio_proven += 1,
            other => panic!("unexpected asset kind {other}"),
        }
    }

    assert!(
        images_proven >= 1,
        "at least one real encrypted image round-tripped"
    );
    assert!(
        audio_proven >= 1,
        "at least one real encrypted audio asset round-tripped"
    );
    eprintln!(
        "REAL-BYTES PASS: images={images_proven} audio={audio_proven} at {}",
        www.display()
    );
}
