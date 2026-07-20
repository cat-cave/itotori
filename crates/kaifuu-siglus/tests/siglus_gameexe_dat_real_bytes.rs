//! Env-gated real-bytes proof for the `Gameexe.dat` reader + decode gating.
//!
//! Copyrighted title bytes stay outside this repository, so the two roots are
//! supplied via environment variables. When either root is absent the test
//! reports a skip and succeeds; when present it reads each real `Gameexe.dat`,
//! proving the outer-header reader recovers `version` + `exe_angou_mode` from
//! real bytes and that the body decode applies its semantic gating BEFORE any
//! output.
//!
//! Both target titles set `exe_angou_mode = 1`: their `Gameexe.dat` body is
//! masked with a per-game exe-angou key recovered from the packed executable by
//! the key-discovery layer. That key is not statically locatable in
//! the executable as a table and is not available in-process here, so — per the
//! honest "prove or record the expected failure" contract — this test proves the
//! outer-header read succeeds and the body decode fails with the typed
//! `exe_angou_key_required` diagnostic (never garbage, never a partial output).
//! Set the env var to either the game directory or its `Gameexe.dat` file.

use std::path::{Path, PathBuf};

use kaifuu_siglus::{GameexeDatError, decode_gameexe_dat, read_gameexe_header};

const FIRST_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

fn gameexe_path(variable: &str) -> Option<PathBuf> {
    let value = std::env::var_os(variable).or_else(|| {
        eprintln!("SKIP siglus Gameexe.dat real bytes: {variable} is unset");
        None
    })?;
    let path = PathBuf::from(value);
    let candidate = if path.is_dir() {
        path.join("Gameexe.dat")
    } else {
        path
    };
    if candidate.is_file() {
        Some(candidate)
    } else {
        eprintln!(
            "SKIP siglus Gameexe.dat real bytes: {variable} has no readable Gameexe.dat at {}",
            candidate.display()
        );
        None
    }
}

fn exercise_title(path: &Path, label: &str) {
    let bytes = std::fs::read(path).expect("read real Gameexe.dat");

    // Outer-header reader: version + exe_angou_mode recovered from real bytes.
    let header = read_gameexe_header(&bytes).expect("real Gameexe.dat outer header parses");
    eprintln!(
        "REAL {label}: bytes={} version={} exe_angou_mode={}",
        bytes.len(),
        header.version,
        header.exe_angou_mode
    );
    assert_eq!(
        header.version, 0,
        "{label}: expected classic headered layout"
    );
    assert_eq!(
        header.exe_angou_mode, 1,
        "{label}: target title is expected to set exe_angou_mode"
    );

    // These titles are exe-angou masked; the per-game key is the key-discovery layer's
    // (blocked) deliverable. The body decode must gate BEFORE any output.
    let err = decode_gameexe_dat(&bytes, None).expect_err("exe-angou key required");
    assert_eq!(
        err,
        GameexeDatError::ExeAngouKeyRequired {
            exe_angou_mode: header.exe_angou_mode
        },
        "{label}: expected typed exe-angou-key-required gate, got {err}"
    );

    eprintln!(
        "REAL {label}: outer header OK; Gameexe.dat body decode correctly gated on the \
         key-discovery exe-angou key (blocked in-process)"
    );
}

#[test]
fn two_real_siglus_gameexe_dats_read_and_gate() {
    let Some(first) = gameexe_path(FIRST_TITLE_ENV) else {
        return;
    };
    let Some(second) = gameexe_path(SECOND_TITLE_ENV) else {
        return;
    };
    exercise_title(&first, "siglus-title-one");
    exercise_title(&second, "siglus-title-two");
}
