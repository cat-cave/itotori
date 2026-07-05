//! KAIFUU-192 regression: nested `REALLIVEDATA/` resolution surfaced as
//! evidence.
//!
//! When a RealLive title ships its engine assets under a nested
//! `REALLIVEDATA/` subdirectory (the observed Sweetie HD shape,
//! `<install-root>/<title subdir>/REALLIVEDATA/`) rather than at the game
//! root, the detector walks past the root to find the SEEN.TXT / Gameexe.ini
//! markers. KAIFUU-192 makes the resolved data dir *observable* in the
//! `kaifuu detect` JSON so downstream `extract` / `profile` / `verify` can
//! read it instead of re-discovering the nesting:
//!
//! - a dedicated evidence row carries the stable code
//!   `kaifuu.reallive.nested_data_dir_resolved` and the resolved subdir as
//!   its `path`, and
//! - every SEEN.TXT / SEEN.GAN / Gameexe.ini evidence row's `path` is
//!   prefixed with the resolved data-dir path (e.g.
//!   `game-install/REALLIVEDATA/SEEN.TXT`).
//!
//! A flat game whose markers live at the game root must NOT emit the
//! `nested_data_dir_resolved` row (no false emission).
//!
//! Fixtures are fully synthetic (a directory tree with the `REALLIVEDATA/`
//! nesting plus minimal RealLive marker files); no copyrighted game bytes
//! are used.

use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_core::{DetectRequest, DetectionResult, EngineAdapter, EvidenceStatus};
use kaifuu_engine_fixture::RealLiveProfileDetectorAdapter;

/// Stable identifier under the `kaifuu.reallive.*` evidence-code namespace
/// for the resolved nested data dir. Downstream tools key off this exact
/// string.
const NESTED_DATA_DIR_RESOLVED_CODE: &str = "kaifuu.reallive.nested_data_dir_resolved";

/// The `RealLiveProfileDetectorAdapter` reports the resolved data dir
/// relative to the game root; a fixed ASCII subdir name keeps the emitted
/// evidence paths (and the JSON snapshot) deterministic.
const TITLE_SUBDIR: &str = "game-install";

fn unique_temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kaifuu-reallive-nested-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A minimal-but-valid RealLive SEEN.TXT envelope: the 10,000-slot
/// directory header (per `kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN`)
/// followed by a single populated scene payload. This is the generic
/// envelope shape the detector accepts as a positive RealLive marker —
/// no game bytes are involved.
fn synthetic_seen_txt_envelope() -> Vec<u8> {
    let directory_byte_len = kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let payload: &[u8] = b"nested-shape-synthetic-payload";
    let payload_offset = directory_byte_len as u32;
    let mut bytes = vec![0u8; directory_byte_len + payload.len()];
    // Populate slot 1 (offset 8): [u32 payload_offset][u32 payload_len].
    let slot1 = 8usize;
    bytes[slot1..slot1 + 4].copy_from_slice(&payload_offset.to_le_bytes());
    bytes[slot1 + 4..slot1 + 8].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes[directory_byte_len..].copy_from_slice(payload);
    bytes
}

const SYNTHETIC_GAMEEXE_INI: &[u8] =
    b"#GAMEEXE_VERSION=1.0\n#REGNAME=KaifuuFixture\\RealLive\n#KOEPAC=koe.ovk\n";

/// Populate a `REALLIVEDATA/` directory with the minimal synthetic RealLive
/// markers (SEEN.TXT envelope, Gameexe.ini, one `.g00` image, one `.koe`
/// voice archive under the observed asset subdirs).
fn populate_reallivedata(reallivedata: &Path) {
    fs::create_dir_all(reallivedata).unwrap();
    fs::write(reallivedata.join("SEEN.TXT"), synthetic_seen_txt_envelope()).unwrap();
    fs::write(reallivedata.join("Gameexe.ini"), SYNTHETIC_GAMEEXE_INI).unwrap();
    fs::create_dir_all(reallivedata.join("g00")).unwrap();
    fs::write(reallivedata.join("g00/image.g00"), b"\0").unwrap();
    fs::create_dir_all(reallivedata.join("koe")).unwrap();
    fs::write(reallivedata.join("koe/voice.koe"), b"\0").unwrap();
}

fn detect(game_dir: &Path) -> DetectionResult {
    RealLiveProfileDetectorAdapter
        .detect(DetectRequest { game_dir })
        .expect("detect must not error on a readable synthetic game dir")
}

/// Positive case: a synthetic game whose RealLive markers live under a
/// nested `<subdir>/REALLIVEDATA/` must emit the
/// `kaifuu.reallive.nested_data_dir_resolved` evidence row pointing at the
/// resolved subdir, and every marker evidence path must carry the resolved
/// data-dir prefix.
#[test]
fn nested_data_dir_resolved_row_and_prefixed_paths() {
    let game_dir = unique_temp_dir("resolved");
    let reallivedata = game_dir.join(TITLE_SUBDIR).join("REALLIVEDATA");
    populate_reallivedata(&reallivedata);

    let detection = detect(&game_dir);
    assert!(
        detection.detected,
        "depth-N descent must find the nested REALLIVEDATA and detect RealLive; got: {detection:#?}"
    );

    // 1. The dedicated nested-data-dir-resolved evidence row.
    let resolved_row = detection
        .evidence
        .iter()
        .find(|row| row.kind == NESTED_DATA_DIR_RESOLVED_CODE)
        .expect("nested REALLIVEDATA must emit the nested_data_dir_resolved evidence row");
    assert_eq!(resolved_row.status, EvidenceStatus::Matched);
    assert!(
        resolved_row.path.ends_with("REALLIVEDATA"),
        "resolved-data-dir evidence path must end with `REALLIVEDATA`, got `{}`",
        resolved_row.path
    );
    assert_eq!(
        resolved_row.path,
        format!("{TITLE_SUBDIR}/REALLIVEDATA"),
        "resolved path must be the game-root-relative subdir with forward slashes"
    );

    // 2. Marker evidence paths carry the resolved data-dir prefix.
    let prefix = format!("{TITLE_SUBDIR}/REALLIVEDATA/");
    for kind in [
        "reallive_seen_txt_envelope",
        "reallive_seen_gan_marker",
        "reallive_gameexe_ini_keys",
    ] {
        let row = detection
            .evidence
            .iter()
            .find(|row| row.kind == kind)
            .unwrap_or_else(|| panic!("evidence row `{kind}` must be present"));
        assert!(
            row.path.starts_with(&prefix),
            "evidence `{kind}` path must start with the resolved prefix `{prefix}`, got `{}`",
            row.path
        );
    }
}

/// Negative case: a flat game whose RealLive markers live at the game root
/// (no nested `REALLIVEDATA/` subdir) must NOT emit the
/// `nested_data_dir_resolved` row, and its marker paths stay as the bare
/// top-level names.
#[test]
fn flat_game_does_not_emit_nested_data_dir_resolved() {
    let game_dir = unique_temp_dir("flat");
    fs::write(game_dir.join("SEEN.TXT"), synthetic_seen_txt_envelope()).unwrap();
    fs::write(game_dir.join("Gameexe.ini"), SYNTHETIC_GAMEEXE_INI).unwrap();
    fs::write(game_dir.join("image.g00"), b"\0").unwrap();
    fs::write(game_dir.join("voice.ovk"), b"\0").unwrap();

    let detection = detect(&game_dir);
    assert!(
        detection.detected,
        "flat synthetic game must still detect RealLive"
    );

    let resolved_row = detection
        .evidence
        .iter()
        .find(|row| row.kind == NESTED_DATA_DIR_RESOLVED_CODE);
    assert!(
        resolved_row.is_none(),
        "a flat game (markers at root) must NOT emit the nested_data_dir_resolved row; got {resolved_row:?}"
    );

    let seen_row = detection
        .evidence
        .iter()
        .find(|row| row.kind == "reallive_seen_txt_envelope")
        .expect("SEEN.TXT envelope row must be present");
    assert_eq!(
        seen_row.path, "SEEN.TXT",
        "flat game must keep the bare marker path (no resolved prefix)"
    );
}

/// Snapshot guard: the full nested-detection JSON is pinned to
/// `tests/fixtures/reallive-nested-detect.json` so the evidence codes,
/// resolved path, and prefixed marker paths cannot silently drift. Set
/// `ITOTORI_UPDATE_SNAPSHOT=1` to regenerate the fixture after an
/// intentional change.
#[test]
fn nested_data_dir_resolved_matches_json_snapshot() {
    let game_dir = unique_temp_dir("snapshot");
    let reallivedata = game_dir.join(TITLE_SUBDIR).join("REALLIVEDATA");
    populate_reallivedata(&reallivedata);

    let detection = detect(&game_dir);
    let actual = serde_json::to_string_pretty(&detection).expect("detection must serialize");

    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/reallive-nested-detect.json");

    if std::env::var_os("ITOTORI_UPDATE_SNAPSHOT").is_some() {
        fs::create_dir_all(fixture.parent().unwrap()).unwrap();
        fs::write(&fixture, format!("{actual}\n")).unwrap();
        return;
    }

    let expected = fs::read_to_string(&fixture).unwrap_or_else(|err| {
        panic!(
            "missing snapshot fixture {} ({err}); regenerate with ITOTORI_UPDATE_SNAPSHOT=1",
            fixture.display()
        )
    });
    assert_eq!(
        actual.trim_end(),
        expected.trim_end(),
        "nested-detection JSON drifted from the pinned snapshot; regenerate with ITOTORI_UPDATE_SNAPSHOT=1 if intentional"
    );
}
