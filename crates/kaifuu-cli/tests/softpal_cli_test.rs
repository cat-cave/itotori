//! CLI integration test for `kaifuu-cli extract --engine softpal <root>` with
//! the game root passed **positionally** (consistent with the other engines'
//! extract surface). Env-gated on `ITOTORI_SOFTPAL_RESEARCH_ROOT`; runs the
//! kaifuu-cli binary against the real, read-only Softpal corpus. The v60663
//! (Dimension Totsu Lovers, plaintext TEXT.DAT) test asserts the extracted
//! BridgeBundle carries the exact known dialogue+choice unit count (39848 =
//! 39832 dialogue + 16 text-bearing choices), matching kaifuu-softpal's
//! committed real-corpus expectations. The v21465 test extracts a PAC source
//! and its loose `SCRIPT.SRC`/`TEXT.DAT` reference, asserting matching
//! BridgeBundles and the known unit count. Never prints raw copyrighted bytes.
//! Wired into the PERIODIC `ci-real-bytes` lane (the wider
//! `-p kaifuu-cli -- --ignored` invocation already picks this up); soft-skips
//! when `ITOTORI_SOFTPAL_RESEARCH_ROOT` is unset (skip-when-absent is
//! legitimate for the periodic lane).

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

/// v60663 (Dimension Totsu Lovers): 39832 dialogue + 16 text-bearing choices.
const V60663_EXPECTED_UNITS: usize = 39848;

/// v21465: 30,176 dialogue + text-bearing-choice units across both sources.
const V21465_EXPECTED_UNITS: usize = 30_176;

fn kaifuu_cli_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"))
}

/// Locate the v60663 game dir (the one carrying `data.pac`) under the corpus
/// root. Returns `None` when the env var is unset or the title is absent.
fn v60663_game_dir() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var_os("ITOTORI_SOFTPAL_RESEARCH_ROOT")?);
    let candidate = root.join("v60663").join("game");
    candidate.join("data.pac").is_file().then_some(candidate)
}

/// Locate v21465's `data.pac` game root plus its loose script/text reference.
/// Returns `None` when the env var is unset or either source is absent.
fn v21465_source_roots() -> Option<(PathBuf, PathBuf)> {
    let root = PathBuf::from(std::env::var_os("ITOTORI_SOFTPAL_RESEARCH_ROOT")?);
    let title_root = root.join("v21465");
    let loose_root = title_root.join("scripts");
    if !loose_root.join("SCRIPT.SRC").is_file() || !loose_root.join("TEXT.DAT").is_file() {
        return None;
    }

    let mut directories = vec![title_root.join("game")];
    while let Some(directory) = directories.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                directories.push(path);
            } else if path.file_name().is_some_and(|name| name == "data.pac") {
                return Some((path.parent()?.to_path_buf(), loose_root));
            }
        }
    }
    None
}

fn extract_bundle(game_dir: &std::path::Path, bundle_out: &std::path::Path) -> Value {
    let output = Command::new(kaifuu_cli_binary())
        .arg("extract")
        .arg("--engine")
        .arg("softpal")
        .arg(game_dir)
        .arg("--bundle-output")
        .arg(bundle_out)
        .output()
        .expect("kaifuu-cli must run");
    assert!(
        output.status.success(),
        "kaifuu-cli extract --engine softpal <positional root> exited non-zero: status={:?}\nstderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );
    serde_json::from_slice(&std::fs::read(bundle_out).expect("bundle file"))
        .expect("bundle must be valid JSON")
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_SOFTPAL_RESEARCH_ROOT (read-only Softpal corpus)"]
fn cli_extract_engine_softpal_positional_root_writes_bridge_with_expected_units() {
    let Some(game_dir) = v60663_game_dir() else {
        eprintln!("skipping: set ITOTORI_SOFTPAL_RESEARCH_ROOT with a v60663/game/data.pac");
        return;
    };

    let tmp_dir = tempfile::tempdir().expect("tmp dir");
    let bundle_out = tmp_dir.path().join("v60663.bridge.json");

    // Game root passed POSITIONALLY (no --game-dir): this is the contract the
    // audit required — a positional root must work like the other engines.
    let output = Command::new(kaifuu_cli_binary())
        .arg("extract")
        .arg("--engine")
        .arg("softpal")
        .arg(&game_dir)
        .arg("--bundle-output")
        .arg(&bundle_out)
        .output()
        .expect("kaifuu-cli must run");
    assert!(
        output.status.success(),
        "kaifuu-cli extract --engine softpal <positional root> exited non-zero: status={:?}\nstderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );

    let bundle: Value = serde_json::from_slice(&std::fs::read(&bundle_out).expect("bundle file"))
        .expect("bundle must be valid JSON");
    let units = bundle["units"].as_array().expect("units array");
    assert_eq!(
        units.len(),
        V60663_EXPECTED_UNITS,
        "v60663 must extract the known dialogue+choice unit count via the positional root"
    );
    eprintln!("softpal positional extract: units={}", units.len());
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_SOFTPAL_RESEARCH_ROOT (read-only Softpal corpus)"]
fn cli_extract_layered_pac_matches_its_loose_pair_reference() {
    let Some((pac_root, loose_root)) = v21465_source_roots() else {
        eprintln!(
            "skipping: set ITOTORI_SOFTPAL_RESEARCH_ROOT with v21465 data.pac and loose SCRIPT.SRC/TEXT.DAT"
        );
        return;
    };

    let tmp_dir = tempfile::tempdir().expect("tmp dir");
    let pac_bundle = extract_bundle(&pac_root, &tmp_dir.path().join("v21465-pac.bridge.json"));
    let loose_bundle = extract_bundle(
        &loose_root,
        &tmp_dir.path().join("v21465-loose.bridge.json"),
    );
    let pac_units = pac_bundle["units"].as_array().expect("PAC units array");
    let loose_units = loose_bundle["units"].as_array().expect("loose units array");
    assert_eq!(
        pac_units.len(),
        V21465_EXPECTED_UNITS,
        "v21465 PAC must extract the known dialogue+choice unit count"
    );
    assert_eq!(
        pac_units.len(),
        loose_units.len(),
        "layered PAC and loose pair must have matching unit counts"
    );
    assert_eq!(
        pac_units, loose_units,
        "layered PAC and loose pair must produce the same bridge units"
    );
    eprintln!(
        "softpal v21465 PAC/loose extract: units={}",
        pac_units.len()
    );
}
