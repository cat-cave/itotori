//! `kaifuu rpg-maker encrypted-smoke --fixture <id>`: a user-shaped smoke that
//! proves the RPG Maker MV/MZ encrypted-asset decrypt/encrypt round-trip on the
//! real supplied game bytes, gated by a metadata-only manifest.
//!
//! For each manifest asset it reads the on-disk encrypted `.rpgmvp`/`.rpgmvo`
//! bytes, derives the 16-byte key from `www/data/System.json`'s `encryptionKey`,
//! decrypts, and checks `decrypt(encrypted) == plaintext` (declared hash + media
//! magic) AND `encrypt(plaintext) == encrypted` (byte-for-byte), printing
//! `PASS <path>` per asset. It exits non-zero if any asset fails to round-trip.
//! When the commercial title is not staged it prints a `SKIP` hint and exits 0
//! rather than fabricating a PASS.

use std::path::{Path, PathBuf};

use kaifuu_core::{
    MvMzAssetKey, RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER, decrypt_rpgmaker_asset,
    encrypt_rpgmaker_asset, sha256_hash_bytes,
};
use serde_json::Value;

use crate::flag;

const PROFILE_B_FIXTURE_ID: &str = "kaifuu-rpgmaker-mv-mz-profile-b";
const PROFILE_B_MANIFEST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/public/kaifuu-rpgmaker-mv-mz-profile-b.manifest.json"
));
const SOURCE_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ_ENCRYPTED";
const DEFAULT_SOURCE_ROOT: &str = "/scratch/itotori-research/rpg-maker-mv-mz/countryside-life/inakaraifu.rj390522.v1-0.en/countryside-life-2025/www";

type CmdResult = Result<(), Box<dyn std::error::Error>>;

fn sha256_hex(bytes: &[u8]) -> String {
    // `sha256_hash_bytes` returns a `sha256:`-prefixed digest; the manifest
    // asset rows record the bare hex, so strip the scheme prefix.
    sha256_hash_bytes(bytes)
        .strip_prefix("sha256:")
        .expect("sha256 digest is scheme-prefixed")
        .to_string()
}

fn decode_hex(text: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let clean: Vec<u8> = text.bytes().filter(u8::is_ascii_hexdigit).collect();
    if !clean.len().is_multiple_of(2) {
        return Err("hex text has an odd digit count".into());
    }
    let mut out = Vec::with_capacity(clean.len() / 2);
    for pair in clean.chunks_exact(2) {
        let hi = (pair[0] as char).to_digit(16).ok_or("bad hex digit")?;
        let lo = (pair[1] as char).to_digit(16).ok_or("bad hex digit")?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

fn source_www_dir() -> PathBuf {
    std::env::var_os(SOURCE_ROOT_ENV)
        .map_or_else(|| PathBuf::from(DEFAULT_SOURCE_ROOT), PathBuf::from)
}

fn key_from_system_json(www: &Path) -> Result<MvMzAssetKey, Box<dyn std::error::Error>> {
    let raw = std::fs::read(www.join("data/System.json"))?;
    let text = std::str::from_utf8(&raw)?.trim_start_matches('\u{feff}');
    let system: Value = serde_json::from_str(text)?;
    let key_hex = system["encryptionKey"]
        .as_str()
        .ok_or("System.json is missing encryptionKey")?;
    Ok(MvMzAssetKey::from_bytes(&decode_hex(key_hex)?))
}

/// Round-trip one manifest asset against the real bytes on disk.
fn prove_asset(www: &Path, key: &MvMzAssetKey, row: &Value) -> Result<(), String> {
    let path = row["path"].as_str().ok_or("asset path")?;
    let rel = path.strip_prefix("www/").unwrap_or(path);
    let magic = decode_hex(row["mediaMagicHex"].as_str().ok_or("magic hex")?)
        .map_err(|error| error.to_string())?;
    let encrypted =
        std::fs::read(www.join(rel)).map_err(|error| format!("read {path}: {error}"))?;

    if sha256_hex(&encrypted) != row["encryptedSha256"].as_str().ok_or("enc sha")? {
        return Err(format!("{path}: encrypted SHA-256 disagrees with manifest"));
    }
    if &encrypted[..RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()] != RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER
    {
        return Err(format!("{path}: missing RPGMV media header"));
    }
    let decrypted =
        decrypt_rpgmaker_asset(&encrypted, key).map_err(|error| format!("{path}: {error:?}"))?;
    if decrypted.get(..magic.len()) != Some(magic.as_slice()) {
        return Err(format!("{path}: decrypted media magic mismatch"));
    }
    if sha256_hex(&decrypted) != row["decryptedSha256"].as_str().ok_or("dec sha")? {
        return Err(format!("{path}: decrypted SHA-256 disagrees with manifest"));
    }
    if encrypt_rpgmaker_asset(&decrypted, key) != encrypted {
        return Err(format!("{path}: re-encrypt is not byte-identical"));
    }
    Ok(())
}

/// The result of a smoke over one staged (or absent) game www tree.
#[derive(Debug, PartialEq, Eq)]
enum SmokeOutcome {
    /// The commercial title is not staged; nothing was proven.
    Skipped,
    /// Every asset round-tripped; at least one image and one audio.
    Proven { images: usize, audio: usize },
}

/// Round-trip every manifest asset against the bytes under `www`, printing a
/// `PASS`/`FAIL`/`SKIP` line per asset. Pure of env and argv so both the staged
/// and absent paths are directly testable.
fn evaluate_smoke(
    manifest: &Value,
    www: &Path,
) -> Result<SmokeOutcome, Box<dyn std::error::Error>> {
    let assets = manifest["assets"]
        .as_array()
        .ok_or("manifest assets array")?;

    if !www.join("data/System.json").is_file() {
        println!(
            "SKIP encrypted-smoke {PROFILE_B_FIXTURE_ID}: title not staged at {}; set {SOURCE_ROOT_ENV}",
            www.display()
        );
        for row in assets {
            println!("SKIP {}", row["path"].as_str().unwrap_or("<asset>"));
        }
        return Ok(SmokeOutcome::Skipped);
    }

    let key = key_from_system_json(www)?;
    let commitment = manifest["encryption"]["keyMaterialSha256"]
        .as_str()
        .ok_or("manifest key commitment")?;
    if key.material_hash()?.as_str() != commitment {
        return Err("System.json key does not match the manifest commitment".into());
    }

    let (mut images, mut audio, mut failures) = (0usize, 0usize, 0usize);
    for row in assets {
        match prove_asset(www, &key, row) {
            Ok(()) => {
                println!("PASS {}", row["path"].as_str().unwrap_or("<asset>"));
                match row["kind"].as_str() {
                    Some("image") => images += 1,
                    Some("audio") => audio += 1,
                    _ => {}
                }
            }
            Err(reason) => {
                println!("FAIL {reason}");
                failures += 1;
            }
        }
    }

    if failures > 0 {
        return Err(format!("{failures} encrypted asset(s) failed to round-trip").into());
    }
    if images == 0 || audio == 0 {
        return Err("smoke requires at least one image and one audio round-trip".into());
    }
    Ok(SmokeOutcome::Proven { images, audio })
}

pub(crate) fn run_rpg_maker_encrypted_smoke(args: &[String]) -> CmdResult {
    let fixture_id = flag(args, "--fixture")?;
    if fixture_id != PROFILE_B_FIXTURE_ID {
        return Err(format!(
            "unknown --fixture {fixture_id}; the only known encrypted fixture is {PROFILE_B_FIXTURE_ID}"
        )
        .into());
    }
    let manifest: Value = serde_json::from_str(PROFILE_B_MANIFEST)?;
    match evaluate_smoke(&manifest, &source_www_dir())? {
        SmokeOutcome::Skipped => {}
        SmokeOutcome::Proven { images, audio } => {
            eprintln!("encrypted-smoke {fixture_id}: PASS images={images} audio={audio}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_embeds_and_lists_image_and_audio_assets() {
        let manifest: Value = serde_json::from_str(PROFILE_B_MANIFEST).expect("manifest parses");
        let assets = manifest["assets"].as_array().expect("assets array");
        assert!(assets.iter().any(|row| row["kind"] == "image"));
        assert!(assets.iter().any(|row| row["kind"] == "audio"));
    }

    #[test]
    fn unknown_fixture_id_is_rejected() {
        let args = vec![
            "encrypted-smoke".to_string(),
            "--fixture".to_string(),
            "not-a-known-fixture".to_string(),
        ];
        assert!(run_rpg_maker_encrypted_smoke(&args).is_err());
    }

    #[test]
    fn hex_decode_round_trips_known_magic() {
        assert_eq!(
            decode_hex("89504e47").unwrap(),
            vec![0x89, 0x50, 0x4e, 0x47]
        );
        assert!(decode_hex("abc").is_err());
    }

    #[test]
    fn absent_title_skips_rather_than_failing() {
        // A directory with no www/data/System.json stands in for an unstaged
        // title; the smoke SKIPs (no env mutation, no panic).
        let tmp = std::env::temp_dir().join("kaifuu-encrypted-smoke-absent-probe");
        std::fs::create_dir_all(&tmp).expect("probe dir");
        let manifest: Value = serde_json::from_str(PROFILE_B_MANIFEST).expect("manifest parses");
        assert_eq!(
            evaluate_smoke(&manifest, &tmp).expect("absent title is not an error"),
            SmokeOutcome::Skipped,
        );
    }
}
