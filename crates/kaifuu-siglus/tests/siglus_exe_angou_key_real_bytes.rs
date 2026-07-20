//! Env-gated real-bytes proof for **in-process exe-angou key recovery**.
//!
//! Copyrighted title bytes stay outside this repository, so the two game roots
//! are supplied via environment variables (the same ones the `Gameexe.dat`
//! real-bytes proof uses). Each root holds both `SiglusEngine.exe` and
//! `Gameexe.dat`. When either root is absent the test reports a skip and
//! succeeds; when present it:
//!   1. statically recovers the 16-byte exe-angou key from `SiglusEngine.exe`
//!      bytes — no Wine, no running the exe, purely `&[u8]` PE analysis; and
//!   2. wires the recovered key into [`decode_gameexe_dat`] and proves the real
//!      `Gameexe.dat` decrypts to a valid UTF-16LE `Gameexe.ini` inventory.
//!
//! The recovered key's identity is pinned by a **one-way sha256 commitment**
//! (never the raw bytes): the commitment must be one of the two known-good
//! titles', proving the extractor reproduced an exact expected key. Raw key
//! material never appears in this test — only the encapsulated
//! [`SiglusSecondLayerMaterial`] and its sha256 commitment.

use std::path::{Path, PathBuf};

use kaifuu_siglus::{
    EXE_ANGOU_KEY_BYTE_LEN, SiglusSecondLayerKey, decode_gameexe_dat, recover_exe_angou_key,
};

const FIRST_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

/// One-way sha256 commitments to the two known-good exe-angou keys. These are
/// hashes, not keys: they pin *which* key was recovered without disclosing any
/// key byte. (karetoshi, gamekoi respectively.)
const KNOWN_KEY_SHA256: [&str; 2] = [
    "6a58a38a2d8ec8c955fc6f1f38ab4543ddff2512625fc11530d80f2ffa73d136",
    "aeae9a1bc37aa88a9baa545f3efe6fb3bbc115086ce486e5755225f79aab1c0e",
];

/// Resolve a game root env var to `(SiglusEngine.exe, Gameexe.dat)` paths, or a
/// clean skip when the var is unset / the files are absent.
fn title_paths(variable: &str) -> Option<(PathBuf, PathBuf)> {
    let value = std::env::var_os(variable).or_else(|| {
        eprintln!("SKIP siglus exe-angou real bytes: {variable} is unset");
        None
    })?;
    let root = PathBuf::from(value);
    // Accept either the game directory or a direct file inside it.
    let dir = if root.is_dir() {
        root
    } else {
        root.parent().map(Path::to_path_buf).unwrap_or(root)
    };
    let exe = dir.join("SiglusEngine.exe");
    let gameexe = dir.join("Gameexe.dat");
    if exe.is_file() && gameexe.is_file() {
        Some((exe, gameexe))
    } else {
        eprintln!(
            "SKIP siglus exe-angou real bytes: {variable} has no SiglusEngine.exe + Gameexe.dat \
             under {}",
            dir.display()
        );
        None
    }
}

fn exercise_title(exe_path: &Path, gameexe_path: &Path, label: &str) {
    let exe_bytes = std::fs::read(exe_path).expect("read real SiglusEngine.exe");
    let gameexe_bytes = std::fs::read(gameexe_path).expect("read real Gameexe.dat");

    // (1) Static, in-process key recovery — no Wine, no execution.
    let key_ref =
        SiglusSecondLayerKey::from_secret_ref(format!("secret://siglus/{label}/exe-angou"));
    let recovery = recover_exe_angou_key(&exe_bytes, &key_ref)
        .unwrap_or_else(|error| panic!("{label}: exe-angou key recovery failed: {error}"));
    let report = recovery.report();

    eprintln!(
        "REAL {label}: recovered exe-angou key ({} bytes) from {} gather sites; sha256={}",
        report.key_byte_len, report.gather_site_count, report.material_sha256
    );
    assert_eq!(
        report.key_byte_len as usize, EXE_ANGOU_KEY_BYTE_LEN,
        "{label}: recovered key must be 16 bytes"
    );
    // The recovered key is pinned by its one-way commitment — it must be one of
    // the two known-good titles' keys (order-independent across env vars).
    assert!(
        KNOWN_KEY_SHA256.contains(&report.material_sha256.as_str()),
        "{label}: recovered key sha256 {} is not a known-good exe-angou key",
        report.material_sha256
    );

    // (2) Wire the recovered key into the decode pipeline: the real Gameexe.dat
    // must decrypt to a valid UTF-16LE Gameexe.ini inventory.
    let decoded = decode_gameexe_dat(&gameexe_bytes, Some(recovery.material()))
        .unwrap_or_else(|error| panic!("{label}: real Gameexe.dat decode failed: {error}"));
    assert!(
        !decoded.entries.is_empty(),
        "{label}: decoded Gameexe.ini has no entries"
    );
    // A real Gameexe.ini always carries the GAMENAME config key.
    assert!(
        decoded.entries.iter().any(|entry| entry.key == "GAMENAME"),
        "{label}: decoded Gameexe.ini is missing the GAMENAME key"
    );
    eprintln!(
        "REAL {label}: Gameexe.dat decoded to {} Gameexe.ini entries (GAMENAME present)",
        decoded.entries.len()
    );
}

#[test]
fn recovered_key_decodes_two_real_siglus_gameexe_dats() {
    let Some((first_exe, first_gameexe)) = title_paths(FIRST_TITLE_ENV) else {
        return;
    };
    let Some((second_exe, second_gameexe)) = title_paths(SECOND_TITLE_ENV) else {
        return;
    };
    exercise_title(&first_exe, &first_gameexe, "siglus-title-one");
    exercise_title(&second_exe, &second_gameexe, "siglus-title-two");
}
