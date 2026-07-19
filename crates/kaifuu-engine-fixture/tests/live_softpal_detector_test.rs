//! Live Softpal detector proof against two owned, read-only titles.
//! The Softpal ADV (Amuse Craft / "Pal") detector is validated on the real
//! bytes of two titles confirmed to be the same engine:
//! * v21465 — Kizuna Kirameku Koi Iroha (ships `dll/Pal.dll`, `data.pac`,
//!   `csv.pac`, `system.pac`; TEXT.DAT enc flag `$` = encrypted).
//! * v60663 — Dimension Totsu Lovers (ships only `data.pac`; TEXT.DAT enc
//!   flag `_` = plaintext).
//!   Together they exercise both TEXT.DAT encryption-flag states and both the
//!   Pal.dll and PAC-only detection paths.
//!   `#[ignore]`d by default; run explicitly against the read-only corpus:
//!   ```text
//!   ITOTORI_SOFTPAL_RESEARCH_ROOT=/scratch/softpal-research \
//!   cargo test -p kaifuu-engine-fixture \
//!   --test live_softpal_detector_test -- --ignored --nocapture
//!   NEVER prints raw copyrighted bytes: file names, counts, sizes, container
//!   magics, and the single-byte TEXT.DAT enc flag (a format field) only.

use std::path::{Path, PathBuf};

use kaifuu_core::{DetectRequest, EngineAdapter};
use kaifuu_engine_fixture::SoftpalProfileDetectorAdapter;

/// Root that holds the two extracted titles (`v21465/`, `v60663/`). Gated on an
/// explicit env var so nothing runs against the corpus unless a human opts in.
fn require_corpus_root() -> Option<PathBuf> {
    let root = std::env::var("ITOTORI_SOFTPAL_RESEARCH_ROOT").ok()?;
    let path = PathBuf::from(root);
    path.is_dir().then_some(path)
}

/// Recursively find the directory under `root` that best represents the real
/// Softpal game install. A dir carrying `data.pac` or `dll/Pal.dll` (the real
/// install) is preferred over one that merely holds extracted loose
/// `SCRIPT.SRC`/`TEXT.DAT` artifacts, so v21465 exercises the definitive
/// Pal.dll path rather than the research `scripts/` extraction.
fn find_softpal_game_dir(root: &Path) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    let mut loose_fallback: Option<PathBuf> = None;
    while let Some(dir) = stack.pop() {
        if dir.join("data.pac").is_file() || dir.join("dll").join("Pal.dll").is_file() {
            return Some(dir);
        }
        if loose_fallback.is_none() && dir.join("SCRIPT.SRC").is_file() {
            loose_fallback = Some(dir.clone());
        }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                }
            }
        }
    }
    loose_fallback
}

fn count_regular_files(root: &Path) -> u64 {
    let mut stack = vec![root.to_path_buf()];
    let mut count = 0u64;
    while let Some(dir) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    count += 1;
                }
            }
        }
    }
    count
}

/// Confirm a single title classifies as `engine=softpal` and report facts only.
fn confirm_softpal(label: &str, title_root: &Path) {
    let game_dir = find_softpal_game_dir(title_root).unwrap_or_else(|| {
        panic!(
            "[{label}] no Softpal game dir under {}",
            title_root.display()
        )
    });

    let detection = SoftpalProfileDetectorAdapter
        .detect(DetectRequest {
            game_dir: &game_dir,
        })
        .expect("Softpal detector must run against the real tree");

    eprintln!("[{label}] softpal game dir = {}", game_dir.display());
    eprintln!(
        "[{label}] regular file count under game dir = {}",
        count_regular_files(&game_dir)
    );
    for evidence in &detection.evidence {
        eprintln!(
            "[{label}] evidence: {} kind={} status={:?} — {}",
            evidence.path, evidence.kind, evidence.status, evidence.detail
        );
    }
    eprintln!(
        "[{label}] detector: adapter_id={}, detected={}, engine_family={:?}, variant={:?}",
        detection.adapter_id,
        detection.detected,
        detection.engine_family,
        detection.detected_variant
    );

    assert!(
        detection.detected,
        "[{label}] real Softpal title must be detected"
    );
    assert_eq!(
        detection.engine_family.as_deref(),
        Some("softpal"),
        "[{label}] engine family must be `softpal`"
    );
    // First-class extraction on real bytes: the kaifuu-softpal reader must
    // recover the dialogue + choice text surface into a BridgeBundle with units.
    let extraction = SoftpalProfileDetectorAdapter
        .extract(kaifuu_core::ExtractRequest {
            game_dir: &game_dir,
        })
        .unwrap_or_else(|error| panic!("[{label}] real Softpal extract must succeed: {error}"));
    eprintln!(
        "[{label}] extract: units={} warnings={}",
        extraction.bridge.units.len(),
        extraction.warnings.len()
    );
    assert!(
        !extraction.bridge.units.is_empty(),
        "[{label}] real Softpal extract must recover dialogue/choice units"
    );
    assert!(
        extraction.warnings.is_empty(),
        "[{label}] real Softpal decode must be clean (0 dangling pointers)"
    );

    // Verify must pass the 0-dangling-pointer decode-integrity bar on real bytes.
    let verification = SoftpalProfileDetectorAdapter
        .verify(kaifuu_core::VerifyRequest {
            game_dir: &game_dir,
        })
        .expect("Softpal verify must run against the real tree");
    assert_eq!(
        verification.status,
        kaifuu_core::OperationStatus::Passed,
        "[{label}] real Softpal decode-integrity verify must pass"
    );
}

#[test]
#[ignore = "requires ITOTORI_SOFTPAL_RESEARCH_ROOT=/scratch/softpal-research (read-only owned Softpal corpus)"]
fn v21465_kizuna_kirameku_koi_iroha_detects_softpal() {
    let Some(root) = require_corpus_root() else {
        eprintln!("skipping: set ITOTORI_SOFTPAL_RESEARCH_ROOT to run this proof");
        return;
    };
    confirm_softpal("v21465", &root.join("v21465"));
}

#[test]
#[ignore = "requires ITOTORI_SOFTPAL_RESEARCH_ROOT=/scratch/softpal-research (read-only owned Softpal corpus)"]
fn v60663_dimension_totsu_lovers_detects_softpal() {
    let Some(root) = require_corpus_root() else {
        eprintln!("skipping: set ITOTORI_SOFTPAL_RESEARCH_ROOT to run this proof");
        return;
    };
    confirm_softpal("v60663", &root.join("v60663"));
}
