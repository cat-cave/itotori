//! UTSUSHI-207 real-bytes integration test for
//! [`utsushi_reallive::Gameexe`].
//!
//! This file is **env-gated**: the assertions only run when the
//! environment variable `ITOTORI_REAL_GAME_ROOT` is set, pointing
//! at the audit-grade Sweetie HD extraction root (the parent of the
//! game-title directory). The presence of
//! that env var is the same gate used elsewhere in the workspace for
//! "real Shift-JIS Gameexe.ini bytes are available locally".
//!
//! Two `#[test]` entrypoints exist per assertion body so the same
//! verification matches every named filter in the UTSUSHI-207 spec.
//! The bodies live in private `verify_*` helpers; the entrypoints are
//! thin wrappers whose only purpose is to give cargo's substring
//! filter a name it can match:
//!
//! - `cargo test -p utsushi-reallive gameexe_real_bytes ...` — the
//!   verification command in the worktree dispatch prompt. Matches the
//!   `gameexe_real_bytes_*` names.
//! - `cargo test -p utsushi-reallive gameexe_known_values`
//!   — the first DAG-spec verification filter. Matches the
//!   `gameexe_known_values` name.
//! - `cargo test -p utsushi-reallive gameexe_dotted_path_lookup` — the
//!   second DAG-spec verification filter. Matches the
//!   `gameexe_dotted_path_lookup` name.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use utsushi_reallive::{Gameexe, GameexeValue, SyscomVisibility};

/// Resolve `Gameexe.ini` from the generic RealLive corpus root or
/// return `None` if the input is absent.
fn resolve_gameexe_path() -> Option<PathBuf> {
    real_corpus::gameexe_ini_path()
}

fn load_or_skip() -> Option<Vec<u8>> {
    let path = resolve_gameexe_path()?;
    let bytes = fs::read(&path).unwrap_or_else(|err| {
        panic!(
            "ITOTORI_REAL_GAME_ROOT is set but Gameexe.ini at {} could not be read: {err}",
            path.display(),
        )
    });
    Some(bytes)
}

/// Body of the "known values" assertion suite. Held private so two
/// `#[test]` entrypoints (one per cargo-filter substring the spec
/// names) can call it without forking the assertion list.
fn verify_real_bytes_known_values() {
    let Some(bytes) = load_or_skip() else {
        real_corpus::require_real_bytes("utsushi-reallive verify_real_bytes_known_values");
        return;
    };
    let gameexe = Gameexe::parse(&bytes).expect("real Gameexe.ini must parse without error");

    // Total key count. Sweetie HD's Gameexe.ini has 1,345 `#KEY = …` lines
    // (verified — `crates/kaifuu-reallive/tests/gameexe_real_bytes.rs`).
    // The structural parser collapses duplicates onto a single dotted
    // path, so allow a 1,300–1,400 band rather than pinning a single
    // value; the spec accepts that range explicitly.
    let total = gameexe.len();
    assert!(
        (1_300..=1_400).contains(&total),
        "parsed key count {total} out of the 1,300–1,400 spec band"
    );

    // REGNAME — Sukara registry string. The byte at index 6 is 0x5C
    // (ASCII `\`); Shift-JIS round-trips it as REVERSE SOLIDUS.
    assert_eq!(
        gameexe.get_str("REGNAME"),
        Some("HADASHI\\OSHIOKIHD"),
        "REGNAME must round-trip to the Sukara registry string"
    );

    // SCREENSIZE_MOD — `999, 1280, 720` per spec.
    assert_eq!(
        gameexe.get_int_array("SCREENSIZE_MOD"),
        Some(&[999, 1280, 720][..]),
        "SCREENSIZE_MOD must parse as a three-int array"
    );

    // FOLDNAME.G00 — `("G00", 0, "G00.PAK")` triple per spec.
    assert_eq!(
        gameexe.get_tuple3("FOLDNAME.G00"),
        Some(("G00", 0, "G00.PAK")),
        "FOLDNAME.G00 must parse as the documented triple"
    );

    // Dotted-path lookup must resolve to a typed `SyscomLabel`.
    let syscom_value = gameexe
        .get("SYSCOM.005.000")
        .expect("SYSCOM.005.000 must be reachable by dotted path");
    match syscom_value {
        GameexeValue::SyscomLabel(label) => {
            // The label is the Japanese "fullscreen" string. Visibility
            // is Unspecified because the line lacks a `U:` / `N:`
            // prefix.
            assert_eq!(label.visibility, SyscomVisibility::Unspecified);
            assert!(
                !label.label.is_empty(),
                "SYSCOM.005.000 label must not be empty"
            );
        }
        other => panic!("SYSCOM.005.000 must be a SyscomLabel, got {other:?}"),
    }

    // Cross-check: the parent SYSCOM.005 entry IS the U:-prefixed
    // option group title, so visibility must be User.
    let syscom_parent = gameexe
        .get("SYSCOM.005")
        .expect("SYSCOM.005 must be reachable by dotted path");
    match syscom_parent {
        GameexeValue::SyscomLabel(label) => {
            assert_eq!(label.visibility, SyscomVisibility::User);
        }
        other => panic!("SYSCOM.005 must be a SyscomLabel, got {other:?}"),
    }

    // CAPTION is a quoted string. Pin the trailing ideographic space
    // because lossy trim-on-read is one of the easiest regressions to
    // introduce.
    let caption = gameexe
        .get_str("CAPTION")
        .expect("CAPTION must be present and string-shaped");
    assert!(
        caption.starts_with("オシオキ"),
        "CAPTION must start with the Sweetie HD title prefix; got {caption:?}"
    );
    assert!(
        caption.ends_with('\u{3000}'),
        "CAPTION must preserve the trailing ideographic space; got {caption:?}"
    );

    // SEEN_START — single-int scalar. `#SEEN_START=0001` parses as
    // `1`.
    assert_eq!(
        gameexe.get_int("SEEN_START"),
        Some(1),
        "SEEN_START must parse as the integer 1"
    );

    // CANCELCALL — exactly two ints `(9999, 10)`.
    assert_eq!(
        gameexe.get_int_pair("CANCELCALL"),
        Some((9999, 10)),
        "CANCELCALL must parse as the (scene, entrypoint) pair"
    );

    // MOUSEACTIONCALL.000.AREA — four-int hit region.
    assert_eq!(
        gameexe.get_int_array("MOUSEACTIONCALL.000.AREA"),
        Some(&[1232, 0, 1279, 719][..]),
        "MOUSEACTIONCALL.000.AREA must parse as a four-int hit region"
    );

    // WINDOW_ATTR — five-int colour/attr tuple.
    assert_eq!(
        gameexe.get_int_array("WINDOW_ATTR"),
        Some(&[100, 100, 160, 200, 0][..]),
        "WINDOW_ATTR must parse as a five-int tuple"
    );

    // SYSCOM.* namespace has at least 32 entries per spec.
    let syscom_keys = gameexe.list_namespace("SYSCOM");
    assert!(
        syscom_keys.len() >= 32,
        "SYSCOM namespace must list >= 32 keys, got {} ({:?}…)",
        syscom_keys.len(),
        syscom_keys.iter().take(3).collect::<Vec<_>>()
    );

    // NAMAE namespace has exactly 11 entries (5 named characters
    // × {plain, censored} + the speaker pair).
    let namae_keys = gameexe.list_namespace("NAMAE");
    assert_eq!(
        namae_keys.len(),
        11,
        "NAMAE namespace must list exactly 11 entries, got {} ({:?})",
        namae_keys.len(),
        namae_keys,
    );
}

/// Body of the "dotted-path lookup" assertion suite. Held private so
/// two `#[test]` entrypoints (one per cargo-filter substring the spec
/// names) can call it without forking the assertion list.
fn verify_dotted_path_lookup() {
    let Some(bytes) = load_or_skip() else {
        real_corpus::require_real_bytes("utsushi-reallive verify_dotted_path_lookup");
        return;
    };
    let gameexe = Gameexe::parse(&bytes).expect("real Gameexe.ini must parse without error");

    // String shape.
    assert!(
        matches!(gameexe.get("CAPTION"), Some(GameexeValue::Str(_))),
        "CAPTION must dotted-path-lookup to a Str variant"
    );

    // Integer-array shape (multiple ints).
    assert!(
        matches!(
            gameexe.get("SCREENSIZE_MOD"),
            Some(GameexeValue::IntArray(ints)) if ints.as_slice() == [999, 1280, 720]
        ),
        "SCREENSIZE_MOD must dotted-path-lookup to the expected IntArray"
    );

    // FOLDNAME triple shape, keyed by `FOLDNAME.<KIND>`.
    assert!(
        matches!(
            gameexe.get("FOLDNAME.G00"),
            Some(GameexeValue::Tuple3 { mode: 0, .. })
        ),
        "FOLDNAME.G00 must dotted-path-lookup to a Tuple3 with mode=0"
    );

    // NAMAE quintuple shape, keyed by `NAMAE.<display>`.
    let namae_keys = gameexe.list_namespace("NAMAE");
    let first_namae = namae_keys
        .first()
        .expect("at least one NAMAE entry must be present");
    assert!(
        matches!(gameexe.get(first_namae), Some(GameexeValue::Namae(_))),
        "first NAMAE entry {first_namae} must dotted-path-lookup to a Namae variant"
    );

    // SYSCOM label shape, keyed by `SYSCOM.NNN`.
    assert!(
        matches!(
            gameexe.get("SYSCOM.000"),
            Some(GameexeValue::SyscomLabel(_))
        ),
        "SYSCOM.000 must dotted-path-lookup to a SyscomLabel variant"
    );

    // Missing keys return None.
    assert!(
        gameexe.get("THIS_KEY_DEFINITELY_DOES_NOT_EXIST").is_none(),
        "missing keys must return None"
    );

    // Type-mismatch lookups return None (not a partial answer).
    assert!(
        gameexe.get_int_array("CAPTION").is_none(),
        "get_int_array on a string-shaped key must return None"
    );
    assert!(
        gameexe.get_tuple3("CANCELCALL").is_none(),
        "get_tuple3 on an int-array key must return None"
    );
}

// ---------- `#[test]` entrypoints ----------
//
// Each pair below is an alias-only delegator that runs the same body.
// The duplication is intentional: cargo's substring filter sees each
// entry point under a different name so a single source of truth can
// be selected by every named verification command in the UTSUSHI-207
// spec without surfacing duplicate assertion logic.

/// Worktree-prompt filter: `cargo test ... gameexe_real_bytes ...`.
#[test]
#[ignore = "requires ITOTORI_REAL_GAME_ROOT; opt in with --include-ignored"]
fn gameexe_real_bytes_known_values() {
    verify_real_bytes_known_values();
}

/// Worktree-prompt filter: `cargo test ... gameexe_real_bytes ...`.
#[test]
#[ignore = "requires ITOTORI_REAL_GAME_ROOT; opt in with --include-ignored"]
fn gameexe_real_bytes_dotted_path_lookup() {
    verify_dotted_path_lookup();
}

/// DAG-spec filter: `cargo test ... gameexe_known_values`.
#[test]
#[ignore = "requires ITOTORI_REAL_GAME_ROOT; opt in with --include-ignored"]
fn gameexe_known_values() {
    verify_real_bytes_known_values();
}

/// DAG-spec filter: `cargo test ... gameexe_dotted_path_lookup`.
#[test]
#[ignore = "requires ITOTORI_REAL_GAME_ROOT; opt in with --include-ignored"]
fn gameexe_dotted_path_lookup() {
    verify_dotted_path_lookup();
}
