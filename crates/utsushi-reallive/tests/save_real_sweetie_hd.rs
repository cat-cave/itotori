//! UTSUSHI-218 — real-bytes integration test for the AVG-derived save
//! format against Sweetie HD's `SAVEDATA/` directory.
//!
//! This file is **env-gated**: the assertions only run when the
//! environment variable `ITOTORI_REAL_GAME_ROOT` is set, pointing
//! at the audit-grade Sweetie HD extraction root (the parent of the
//! game-title directory, e.g.
//! `/scratch/itotori-research/sweetie-hd/extracted`). The presence of
//! that env var is the same gate used elsewhere in the workspace for
//! "real Shift-JIS save bytes are available locally".
//!
//! # Audit focus
//!
//! - **Writing to the read-only research mount must be banned at the
//!   test layer.** The Sweetie HD `SAVEDATA/` directory is mounted
//!   read-only (`dr-x------`, `-r--r--r--` for the `.sav` files). A
//!   regression that introduced a `fs::write` against the research
//!   mount would silently fail at runtime (because the mount is
//!   read-only) but the regression itself would land. To catch the
//!   regression at **review** time, this file deliberately contains
//!   **zero** `fs::write` / `fs::create_dir_all` / `OpenOptions::write`
//!   calls. The audit grep `tests/save_real_sweetie_hd.rs` keeps this
//!   invariant pinned.
//!
//!   In addition, the test does **not** accept a `ITOTORI_REAL_GAME_ROOT`
//!   override that points at a writable directory — every read goes
//!   through the path the audit doc declares, with no fall-back.
//!
//! - **Endianness flips between read and write.** Both directions go
//!   through `u32::from_le_bytes` / `u32::to_le_bytes`; a regression
//!   would produce a `PreambleFileSizeMismatch` against the documented
//!   24 876-byte file size.
//!
//! - **Silently truncating slots.** The `SystemSave` decode validates
//!   `preamble.leading_u32 == bytes.len()`, so a partial read of
//!   `REALLIVE.sav` cannot decode without raising
//!   `PreambleFileSizeMismatch`.
//!
//! Two `#[test]` entrypoints exist per assertion body so the spec's
//! verification filters all match a name:
//!
//! - `cargo test -p utsushi-reallive save_reads_avg_system_save`
//! - `cargo test -p utsushi-reallive save_reads_avg_global_save`
//! - `cargo test -p utsushi-reallive save_read_flags_decodes_title`

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use utsushi_reallive::{
    GLOBAL_SAVE_MAGIC, GlobalSave, ReadFlags, SWEETIE_HD_COMPILER_VERSION, SYSTEM_SAVE_MAGIC,
    SystemSave,
};

/// Default name of the Sweetie HD title directory inside the
/// extraction root.

/// Documented Sweetie HD `REALLIVE.sav` size (audit doc § J).
const SWEETIE_HD_SYSTEM_SAVE_BYTES: usize = 24_876;

/// Documented Sweetie HD `save999.sav` size (audit doc § J).
const SWEETIE_HD_GLOBAL_SAVE_BYTES: usize = 6_748;

/// Documented Sweetie HD `read.sav` size (audit doc § J).
const SWEETIE_HD_READ_FLAGS_BYTES: usize = 44_495;

/// UTF-8 form of the Sweetie HD title (`オシオキSweetie＋Sweets!! HD Edition`
/// plus IDEOGRAPHIC SPACE U+3000). The spec acceptance criterion writes
/// the trailing code as the literal `\u{8140}` escape; on disk the two
/// bytes are `81 40`, which is the Shift-JIS encoding of U+3000.
/// `encoding_rs` round-trips the pair via U+3000, not U+8140.
const SWEETIE_HD_TITLE_UTF8: &str = "オシオキSweetie＋Sweets!! HD Edition\u{3000}";

fn resolve_savedata_path(file_name: &str) -> Option<PathBuf> {
    real_corpus::save_file_path(file_name)
}

fn load_or_skip(file_name: &str) -> Option<Vec<u8>> {
    let path = resolve_savedata_path(file_name)?;
    let bytes = fs::read(&path).unwrap_or_else(|err| {
        panic!(
            "ITOTORI_REAL_GAME_ROOT is set but SAVEDATA/{file_name} could not be read at {}: {err}",
            path.display(),
        )
    });
    Some(bytes)
}

// ---------------------------------------------------------------------
// `REALLIVE.sav` — system save (`AVG_SYSTEM_SAVE`).
// ---------------------------------------------------------------------

fn verify_system_save() {
    let Some(bytes) = load_or_skip("REALLIVE.sav") else {
        eprintln!(
            "ITOTORI_REAL_GAME_ROOT not set or no SAVEDATA file found — verify_system_save is a no-op."
        );
        return;
    };
    assert_eq!(
        bytes.len(),
        SWEETIE_HD_SYSTEM_SAVE_BYTES,
        "Sweetie HD REALLIVE.sav is documented as {SWEETIE_HD_SYSTEM_SAVE_BYTES} bytes"
    );

    // Audit-focus: leading u32 must read as 24 876 / 0x0000_612C.
    assert_eq!(
        &bytes[0x00..0x04],
        &[0x2C, 0x61, 0x00, 0x00],
        "leading u32 must be the documented 2C 61 00 00 file-size stamp"
    );

    let save = SystemSave::decode(&bytes).expect("REALLIVE.sav must decode");
    assert_eq!(
        save.preamble.leading_u32 as usize,
        SWEETIE_HD_SYSTEM_SAVE_BYTES
    );
    assert_eq!(save.preamble.compiler_version, SWEETIE_HD_COMPILER_VERSION);
    // Engine timestamp documented: 2025-03-02 11:18:39.
    assert_eq!(
        save.preamble.timestamp,
        [0x07E9, 0x0003, 0x0002, 0x000B, 0x0012, 0x0027]
    );

    // Acceptance criterion: produces a `SystemSave { magic, slots }`
    // with the declared file size.
    assert_eq!(
        save.preamble.leading_u32 as usize,
        bytes.len(),
        "file-size cross-check must hold against documented {SWEETIE_HD_SYSTEM_SAVE_BYTES}"
    );

    // Audit-focus: writing a freshly-snapshotted save produces
    // byte-identical output.
    let re_encoded = save.encode();
    assert_eq!(
        re_encoded, bytes,
        "REALLIVE.sav real-bytes round-trip must be byte-identical"
    );

    // Magic string at offset 0x18 must match the documented pin.
    assert_eq!(
        &bytes[0x18..0x18 + SYSTEM_SAVE_MAGIC.len()],
        SYSTEM_SAVE_MAGIC.as_bytes(),
        "magic string at offset 0x18 must match {SYSTEM_SAVE_MAGIC}"
    );
}

#[test]
fn save_reads_avg_system_save_real_sweetie_hd_bytes() {
    verify_system_save();
}

#[test]
fn save_real_sweetie_hd_system_save_round_trips() {
    verify_system_save();
}

// ---------------------------------------------------------------------
// `save999.sav` — global save (`AVG_GLOBAL_SAVE`).
// ---------------------------------------------------------------------

fn verify_global_save() {
    let Some(bytes) = load_or_skip("save999.sav") else {
        eprintln!(
            "ITOTORI_REAL_GAME_ROOT not set or no SAVEDATA file found — verify_global_save is a no-op."
        );
        return;
    };
    assert_eq!(bytes.len(), SWEETIE_HD_GLOBAL_SAVE_BYTES);

    let save = GlobalSave::decode(&bytes).expect("save999.sav must decode");
    // Sweetie HD's documented leading u32 is `A4 00 00 00`.
    assert_eq!(
        save.preamble.leading_u32, 0x0000_00A4,
        "save999.sav leading u32 is a per-format constant (0xA4), not the file size"
    );
    assert_eq!(save.preamble.compiler_version, SWEETIE_HD_COMPILER_VERSION);

    let re_encoded = save.encode();
    assert_eq!(
        re_encoded, bytes,
        "save999.sav real-bytes round-trip must be byte-identical"
    );

    assert_eq!(
        &bytes[0x18..0x18 + GLOBAL_SAVE_MAGIC.len()],
        GLOBAL_SAVE_MAGIC.as_bytes(),
        "magic string at offset 0x18 must match {GLOBAL_SAVE_MAGIC}"
    );
}

#[test]
fn save_reads_avg_global_save_real_sweetie_hd_bytes() {
    verify_global_save();
}

#[test]
fn save_real_sweetie_hd_global_save_round_trips() {
    verify_global_save();
}

// ---------------------------------------------------------------------
// `read.sav` — read flags (Shift-JIS title at offset 0x18).
// ---------------------------------------------------------------------

fn verify_read_flags() {
    let Some(bytes) = load_or_skip("read.sav") else {
        eprintln!(
            "ITOTORI_REAL_GAME_ROOT not set or no SAVEDATA file found — verify_read_flags is a no-op."
        );
        return;
    };
    assert_eq!(bytes.len(), SWEETIE_HD_READ_FLAGS_BYTES);

    let flags = ReadFlags::decode(&bytes).expect("read.sav must decode");
    assert_eq!(flags.preamble.compiler_version, SWEETIE_HD_COMPILER_VERSION);
    // Acceptance criterion: title decodes to the documented UTF-8
    // string (Shift-JIS `81 40` round-trips through `encoding_rs` as
    // U+3000 IDEOGRAPHIC SPACE).
    assert_eq!(
        flags.title, SWEETIE_HD_TITLE_UTF8,
        "Shift-JIS title must decode to the documented UTF-8 string"
    );

    // Byte-identical write round-trip — the raw Shift-JIS title bytes
    // are preserved verbatim, even though the UTF-8 form rounds the
    // trailing `0x8140` to U+3000.
    let re_encoded = flags.encode();
    assert_eq!(
        re_encoded, bytes,
        "read.sav real-bytes round-trip must be byte-identical"
    );
}

#[test]
fn save_read_flags_decodes_title_real_sweetie_hd_bytes() {
    verify_read_flags();
}

#[test]
fn save_real_sweetie_hd_read_flags_round_trips() {
    verify_read_flags();
}
