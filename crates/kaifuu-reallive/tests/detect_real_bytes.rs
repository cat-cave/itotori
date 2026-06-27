//! KAIFUU-189 real-bytes integration test for the RealLive `REALLIVEDATA/`
//! detector. Walks the depth-N descent against the actual Sweetie HD
//! installation tree under `$ITOTORI_REAL_GAME_ROOT` and confirms
//! that the resolved path ends with `REALLIVEDATA` on disk. A
//! synthetic-positive companion test exercises depth-2 descent against
//! author-controlled bytes (`tmp/parent/REALLIVEDATA/Seen.txt`), and a
//! negative test confirms the detector does NOT false-positive on an
//! MV/MZ shape (`tmp/data/System.json`) that lacks the RealLive marker.
//!
//! # Multi-game validation status
//!
//! Per the itotori operating model
//! (`docs/orchestration-operating-model.md`), an engine detector that
//! works on game X may fail on game Y; the rule normally requires a
//! second corpus before merging-complete. KAIFUU-189 satisfies the rule
//! **by the engine's hard-coded `REALLIVEDATA/` marker invariant**: the
//! directory name is fixed in the RealLive runtime (Haeleth's RLDEV
//! site, `https://dev.haeleth.net/rldev.shtml`, and every observable
//! RealLive title since AVG32) and is NOT a title-specific token. The
//! depth-N descent contract this test exercises is therefore a
//! structural invariant of the engine family, not a behavioural fact
//! about Sweetie HD specifically. A second RealLive corpus would
//! re-confirm the same invariant; no new bug surface is opened by the
//! single-corpus exercise here.
//!
//! # Three-state contract
//!
//! The detector under test (`kaifuu_reallive::detect_reallive_data_dir`)
//! returns:
//! - `Ok(Some(RealLiveDetectionEvidence))` for a positive identification,
//!   carrying the on-disk path of REALLIVEDATA (case preserved);
//! - `Ok(None)` for a clean negative (root is a readable directory but
//!   no REALLIVEDATA was found within `max_depth`);
//! - `Err(RealLiveDetectError::*)` for I/O failures (missing root,
//!   non-directory root, read errors).
//!
//! This three-state shape is the KAIFUU-189 "no silent zero-state"
//! contract; the test enforces all three outcomes.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::env;
use std::fs;
use std::path::PathBuf;

use kaifuu_reallive::{
    REALLIVE_DATA_DIR_NAME, REALLIVE_DETECTOR_DEFAULT_MAX_DEPTH, RealLiveDetectError,
    detect_reallive_data_dir, detect_reallive_data_dir_with_max_depth,
};

fn unique_temp_dir(label: &str) -> PathBuf {
    let dir = env::temp_dir().join(format!(
        "kaifuu-reallive-detect-real-bytes-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create unique temp dir");
    dir
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn detects_reallivedata_under_sweetie_hd_root_with_resolved_path() {
    let Some(env_path) = env::var_os(real_corpus::REAL_GAME_ROOT_ENV).map(PathBuf::from) else {
        // Visible skip — KAIFUU-189 "no silent zero-state" requires the
        // operator to observe that the real-bytes assertion did not run.
        eprintln!(
            "SKIP detects_reallivedata_under_sweetie_hd_root_with_resolved_path: \
             {} is unset; re-run with \
             {}=/path/to/reallive-game-root \
             to exercise the depth-N descent against the actual install tree",
            real_corpus::REAL_GAME_ROOT_ENV,
            real_corpus::REAL_GAME_ROOT_ENV
        );
        return;
    };

    let evidence = detect_reallive_data_dir(&env_path)
        .expect("readable Sweetie HD root must not error")
        .unwrap_or_else(|| {
            panic!(
                "{} set to {} but depth-N descent failed to locate \
                 a REALLIVEDATA/ subdirectory; the audit (\
                 docs/audits/real-bytes-validation-2026-06-24.md §2.1) confirms it \
                 ships under <root>/REALLIVEDATA or <root>/<one child>/REALLIVEDATA/",
                real_corpus::REAL_GAME_ROOT_ENV,
                env_path.display()
            )
        });

    // Acceptance #1: the reported path ends with the on-disk
    // `REALLIVEDATA` directory name (case-sensitive on the on-disk
    // file_name). Sweetie HD ships the marker upper-cased.
    let file_name = evidence
        .reallive_data_path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("resolved REALLIVEDATA path must have a UTF-8 file name");
    assert_eq!(
        file_name, REALLIVE_DATA_DIR_NAME,
        "Sweetie HD REALLIVEDATA on-disk casing must match the documented marker"
    );

    // Acceptance #2: the reported path is reachable on the filesystem.
    // KAIFUU-189 "no silent zero-state" forbids returning a positive
    // evidence whose path can't be stat()ed.
    let metadata = fs::metadata(&evidence.reallive_data_path).unwrap_or_else(|err| {
        panic!(
            "resolved REALLIVEDATA path {} must be reachable, got {err}",
            evidence.reallive_data_path.display()
        )
    });
    assert!(
        metadata.is_dir(),
        "resolved path {} must be a directory (the engine asset root)",
        evidence.reallive_data_path.display()
    );

    // Acceptance #3: the resolved path is a descendant of the input
    // root. Catches a refactor regression where the walker accidentally
    // escapes the root via a symlink.
    assert!(
        evidence.reallive_data_path.starts_with(&env_path),
        "resolved REALLIVEDATA path {} must descend from input root {}",
        evidence.reallive_data_path.display(),
        env_path.display()
    );

    // Acceptance #4: search depth reports the relative directory depth
    // of the resolved REALLIVEDATA marker. Direct roots
    // (`<game>/REALLIVEDATA`) and shallow wrapper roots
    // (`<parent>/<game>/REALLIVEDATA`) are both valid generic fixture
    // shapes.
    let expected_search_depth = evidence
        .reallive_data_path
        .strip_prefix(&env_path)
        .unwrap_or_else(|_| {
            panic!(
                "resolved REALLIVEDATA path {} must be relative to input root {}",
                evidence.reallive_data_path.display(),
                env_path.display()
            )
        })
        .components()
        .count();
    assert_eq!(
        evidence.search_depth, expected_search_depth,
        "reported search depth must match the resolved REALLIVEDATA path depth from the input root"
    );
    assert!(
        evidence.search_depth <= REALLIVE_DETECTOR_DEFAULT_MAX_DEPTH,
        "reported search depth {} must stay within the detector's default bound {}",
        evidence.search_depth,
        REALLIVE_DETECTOR_DEFAULT_MAX_DEPTH
    );

    // Acceptance #5: corroborating bytes — Seen.txt must live inside
    // the resolved REALLIVEDATA. This catches a false-positive where
    // the detector happens to find any directory named REALLIVEDATA
    // that isn't actually the engine asset root.
    let seen_txt = evidence.reallive_data_path.join("Seen.txt");
    let seen_meta = fs::metadata(&seen_txt).unwrap_or_else(|err| {
        panic!(
            "Sweetie HD REALLIVEDATA must contain Seen.txt; got {err} at {}",
            seen_txt.display()
        )
    });
    assert!(
        seen_meta.is_file() && seen_meta.len() > 0,
        "Seen.txt at {} must be a non-empty file (real RealLive corpus invariant)",
        seen_txt.display()
    );
}

#[test]
fn detects_reallivedata_in_synthetic_nested_layout() {
    // Mirrors Sweetie HD's `<root>/<title subdir>/REALLIVEDATA/Seen.txt`
    // shape using author-controlled bytes. This is the "supplementary
    // synthetic positive" test required by KAIFUU-189: it confirms the
    // depth-N descent contract holds on bytes we constructed, not just
    // on the single real corpus we have access to.
    let root = unique_temp_dir("synthetic-nested-positive");
    let title_subdir = root.join("オシオキSweetie＋Sweets!! HD_DL版");
    let realivedata = title_subdir.join("REALLIVEDATA");
    fs::create_dir_all(&realivedata).expect("create synthetic REALLIVEDATA");
    // Drop a Seen.txt so the test mirrors the real-bytes shape closely.
    fs::write(realivedata.join("Seen.txt"), b"synthetic-seen-txt-bytes")
        .expect("write synthetic Seen.txt");

    let evidence = detect_reallive_data_dir(&root)
        .expect("readable synthetic root must not error")
        .expect("synthetic depth-2 REALLIVEDATA must be detected");

    assert_eq!(evidence.reallive_data_path, realivedata);
    assert_eq!(evidence.search_depth, 2);
    let file_name = evidence
        .reallive_data_path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("synthetic REALLIVEDATA path must have UTF-8 file name");
    assert_eq!(file_name, REALLIVE_DATA_DIR_NAME);

    fs::remove_dir_all(&root).expect("cleanup synthetic root");
}

#[test]
fn negative_rpg_maker_shape_is_not_misidentified_as_reallive() {
    // KAIFUU-189 hard constraint #4: an MV/MZ tree (`data/System.json`)
    // must produce `Ok(None)` — NOT a false-positive RealLive
    // detection. This is the "no false-positive on RealLive when
    // there's only an MV/MZ tree" assertion from the spec.
    let root = unique_temp_dir("negative-mv-mz-shape");
    let data_dir = root.join("data");
    fs::create_dir_all(&data_dir).expect("create data subdir");
    fs::write(
        data_dir.join("System.json"),
        br#"{
  "hasEncryptedImages": true,
  "encryptionKey": "deadbeefdeadbeefdeadbeefdeadbeef"
}"#,
    )
    .expect("write System.json");
    // Throw in a confusingly-named sibling to make sure case-insensitive
    // matching doesn't slip on common false-friends.
    fs::create_dir_all(root.join("reallive")).expect("create reallive-named non-marker");

    let outcome = detect_reallive_data_dir(&root).expect("readable root must not error");
    assert!(
        outcome.is_none(),
        "MV/MZ-shaped tree with a `reallive` (non-REALLIVEDATA) subdir \
         must produce Ok(None); KAIFUU-189 forbids false-positives. \
         Got {outcome:?}"
    );

    fs::remove_dir_all(&root).expect("cleanup negative root");
}

#[test]
fn root_missing_surfaces_typed_error_not_silent_negative() {
    // KAIFUU-189 hard constraint #3: the detector must distinguish
    // "directory exists without REALLIVEDATA" (negative) from
    // "directory doesn't exist" (error). No silent zero-state.
    let parent = unique_temp_dir("root-missing");
    let root = parent.join("does-not-exist");

    let err = detect_reallive_data_dir(&root)
        .expect_err("missing root must surface a typed error, not a swallowed None");
    assert!(
        matches!(err, RealLiveDetectError::RootMissing(_)),
        "expected RootMissing, got {err:?}"
    );

    fs::remove_dir_all(&parent).expect("cleanup root-missing parent");
}

#[test]
fn explicit_max_depth_zero_does_not_descend() {
    // KAIFUU-189 audit-focus: "Recursion bound — the scanner must not
    // descend past depth 2 from the resolved data dir." Generalised
    // here: at max_depth = 0 the walker checks the root itself only.
    let root = unique_temp_dir("explicit-depth-bound");
    fs::create_dir_all(root.join("REALLIVEDATA")).expect("create direct REALLIVEDATA child");

    let outcome = detect_reallive_data_dir_with_max_depth(&root, 0)
        .expect("readable root must not error at max_depth 0");
    assert!(
        outcome.is_none(),
        "max_depth = 0 must NOT descend into the direct REALLIVEDATA child"
    );

    let evidence = detect_reallive_data_dir_with_max_depth(&root, 1)
        .expect("readable root must not error at max_depth 1")
        .expect("max_depth = 1 must reach the direct REALLIVEDATA child");
    assert_eq!(evidence.search_depth, 1);

    fs::remove_dir_all(&root).expect("cleanup explicit-depth root");
}
