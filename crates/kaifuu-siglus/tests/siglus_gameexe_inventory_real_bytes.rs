//! Env-gated real-bytes proof for the `Gameexe.dat` **inventory reader**.
//!
//! Copyrighted title bytes stay outside this repository, so the two game roots
//! are supplied via environment variables (the same ones the sibling
//! `Gameexe.dat` / exe-angou proofs use). Each root holds both
//! `SiglusEngine.exe` and `Gameexe.dat`. When either root is absent the test
//! reports a skip and succeeds; when present it drives the full reader
//! ([`read_gameexe_inventory`]): recover the per-game exe-angou key in-process
//! from the executable, decode the real `Gameexe.dat`, and lift it into a
//! category-indexed inventory.
//!
//! # What is asserted (structural facts only)
//! Each title's inventory must carry its exact real entry count (the first root
//! is `karetoshi` = 690 entries, the second is `gamekoi` = 689), and the
//! `GAMENAME` category must be present **as a count of 1** — the title text
//! itself is never read or logged. The `NAMAE` speaker-name family (the feed for
//! the downstream speaker-resolution layer) must be present as a category. The
//! sanitized summary is serialized and asserted to be free of any raw value
//! text. A malformed / wrong-key input is proven to fail with the typed
//! semantic diagnostic rather than producing garbage. No copyrighted free-text
//! is read, asserted, or emitted anywhere in this test.

use std::path::{Path, PathBuf};

use kaifuu_siglus::{
    ExeAngouKeyError, GameexeReadError, SiglusSecondLayerKey, read_gameexe_inventory,
};

const FIRST_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

/// Expected real entry count per root: the first root (`karetoshi`) parses 690
/// entries, the second (`gamekoi`) 689. Structural counts, not content.
const EXPECTED_ENTRY_COUNT: [usize; 2] = [690, 689];

/// Resolve a game-root env var to `(SiglusEngine.exe, Gameexe.dat)` paths, or a
/// clean skip when the var is unset / the files are absent.
fn title_paths(variable: &str) -> Option<(PathBuf, PathBuf)> {
    let value = std::env::var_os(variable).or_else(|| {
        eprintln!("SKIP siglus Gameexe.dat inventory real bytes: {variable} is unset");
        None
    })?;
    let root = PathBuf::from(value);
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
            "SKIP siglus Gameexe.dat inventory real bytes: {variable} has no SiglusEngine.exe + \
             Gameexe.dat under {}",
            dir.display()
        );
        None
    }
}

fn exercise_title(exe_path: &Path, gameexe_path: &Path, label: &str, expected_entries: usize) {
    let exe_bytes = std::fs::read(exe_path).expect("read real SiglusEngine.exe");
    let gameexe_bytes = std::fs::read(gameexe_path).expect("read real Gameexe.dat");

    // Full reader: in-process exe-angou key recovery → decode → typed inventory.
    let key_ref =
        SiglusSecondLayerKey::from_secret_ref(format!("secret://siglus/{label}/exe-angou"));
    let inventory = read_gameexe_inventory(&exe_bytes, &gameexe_bytes, &key_ref)
        .unwrap_or_else(|error| panic!("{label}: real Gameexe.dat inventory read failed: {error}"));

    let summary = inventory.summary();
    eprintln!(
        "REAL {label}: {} entries across {} categories",
        summary.entry_count, summary.category_count
    );
    assert_eq!(
        summary.entry_count, expected_entries,
        "{label}: expected {expected_entries} parsed Gameexe.ini entries"
    );
    assert_eq!(inventory.len(), expected_entries, "{label}: inventory len");

    // GAMENAME present — asserted as a CATEGORY COUNT, never by reading the
    // (copyrighted) title text.
    assert_eq!(
        summary.category_counts.get("GAMENAME"),
        Some(&1),
        "{label}: GAMENAME category must be present exactly once"
    );
    assert!(
        inventory.has_category("GAMENAME"),
        "{label}: inventory must expose the GAMENAME category"
    );

    // NAMAE speaker-name family — the feed for the speaker-resolution layer.
    let namae_count = inventory.entries_in_category("NAMAE").count();
    assert!(
        namae_count > 0,
        "{label}: NAMAE speaker-name family must be present for speaker resolution"
    );
    assert_eq!(
        summary.category_counts.get("NAMAE"),
        Some(&namae_count),
        "{label}: NAMAE category count must match the iterated family size"
    );
    eprintln!(
        "REAL {label}: GAMENAME=1, NAMAE={namae_count} (speaker feed); \
         top categories present (counts only, no value text)"
    );

    // The sanitized summary must serialize without any raw value text: it may
    // only carry structural counts + engine config identifiers. Real GAMENAME /
    // NAMAE / DISCMARK values are all double-quoted free-text, so if any leaked
    // into the summary it would appear JSON-escaped as `\"`. Assert none does.
    let json = serde_json::to_string(&summary).expect("summary serializes");
    assert!(
        !json.contains("\\\""),
        "{label}: sanitized summary must not embed quoted free-text values"
    );
}

#[test]
fn two_real_siglus_gameexe_inventories_read_and_summarize() {
    let Some((first_exe, first_gameexe)) = title_paths(FIRST_TITLE_ENV) else {
        return;
    };
    let Some((second_exe, second_gameexe)) = title_paths(SECOND_TITLE_ENV) else {
        return;
    };
    exercise_title(
        &first_exe,
        &first_gameexe,
        "siglus-title-one",
        EXPECTED_ENTRY_COUNT[0],
    );
    exercise_title(
        &second_exe,
        &second_gameexe,
        "siglus-title-two",
        EXPECTED_ENTRY_COUNT[1],
    );

    // Wrong-key / malformed proof through the reader: feeding a non-PE blob as
    // the "executable" for an exe-angou-masked title must fail with the typed
    // key-recovery diagnostic — a semantic failure, never garbage output.
    let gameexe_bytes = std::fs::read(&first_gameexe).expect("read real Gameexe.dat");
    let key_ref = SiglusSecondLayerKey::from_secret_ref("secret://siglus/malformed/exe-angou");
    let err = read_gameexe_inventory(b"not a PE executable", &gameexe_bytes, &key_ref)
        .expect_err("non-PE executable must fail key recovery");
    assert!(
        matches!(
            err,
            GameexeReadError::KeyRecovery {
                source: ExeAngouKeyError::NotPortableExecutable { .. }
            }
        ),
        "expected typed non-PE key-recovery diagnostic, got {err}"
    );
    eprintln!("REAL malformed-exe: reader correctly returned typed diagnostic: {err}");
}
