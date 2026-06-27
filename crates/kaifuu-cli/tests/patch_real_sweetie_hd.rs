//! KAIFUU-211 — CLI integration test for
//! `kaifuu-cli patch --engine reallive --source <readonly> --target <writable> --bundle <translated.json>`.
//!
//! Env-gated on `KAIFUU_REAL_SWEETIE_HD_PATH`. Runs the kaifuu-cli
//! binary against the real Sweetie HD extracted root, asserts:
//!
//! - The command exits 0.
//! - The output `<target>/REALLIVEDATA/Seen.txt` exists, is non-empty,
//!   and starts with the canonical 10,000-slot directory shape (10,000
//!   × 8-byte slot table).
//! - The source root's `Seen.txt` is sha256-unchanged after the run.
//! - The patched archive re-parses with the source's scene count.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const SWEETIE_HD_INNER_DIR: &str = "オシオキSweetie＋Sweets!! HD_DL版";

fn kaifuu_cli_binary() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"));
    if path.exists() {
        return path;
    }
    path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("target/debug/kaifuu-cli"))
        .expect("workspace root");
    path
}

fn resolve_seen_path(root: &Path) -> PathBuf {
    let direct = root.join("REALLIVEDATA").join("Seen.txt");
    if direct.is_file() {
        return direct;
    }
    let inner = root
        .join(SWEETIE_HD_INNER_DIR)
        .join("REALLIVEDATA")
        .join("Seen.txt");
    if inner.is_file() {
        return inner;
    }
    panic!(
        "REALLIVEDATA/Seen.txt not found under {} (expected inner dir {SWEETIE_HD_INNER_DIR})",
        root.display()
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest.iter() {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

#[test]
#[ignore = "real-bytes; requires KAIFUU_REAL_SWEETIE_HD_PATH env var"]
fn cli_patch_engine_reallive_writes_patched_seen_txt_under_writable_target() {
    let Some(root) = env::var_os("KAIFUU_REAL_SWEETIE_HD_PATH") else {
        eprintln!(
            "KAIFUU_REAL_SWEETIE_HD_PATH unset; skipping (re-run with \
             KAIFUU_REAL_SWEETIE_HD_PATH=/scratch/itotori-research/sweetie-hd/extracted)"
        );
        return;
    };
    let source_root = PathBuf::from(root);
    let source_seen_path = resolve_seen_path(&source_root);
    let source_seen_bytes = fs::read(&source_seen_path).expect("read source Seen.txt");
    let source_seen_hash_before = sha256_hex(&source_seen_bytes);

    let tmp = tempfile::tempdir().expect("tmp dir");
    let target_root = tmp.path().join("target-patched");
    let bundle_out = tmp.path().join("bridge-bundle-translated.json");

    // Step 1: extract the source-side bundle via the existing extract
    // CLI to bootstrap a real bundle.
    let extract_status = Command::new(kaifuu_cli_binary())
        .arg("extract")
        .arg("--engine")
        .arg("reallive")
        .arg("--scene")
        .arg("1")
        .arg("--bundle-output")
        .arg(tmp.path().join("scene-1-source.json"))
        .arg("--game-root")
        .arg(&source_root)
        .arg("--game-id")
        .arg("sweetie-hd")
        .arg("--game-version")
        .arg("1.0.0")
        .arg("--source-profile-id")
        .arg("kaifuu-reallive-sweetie-hd")
        .arg("--source-locale")
        .arg("ja-JP")
        .output()
        .expect("kaifuu-cli extract must run");
    assert!(
        extract_status.status.success(),
        "extract failed: {}",
        String::from_utf8_lossy(&extract_status.stderr)
    );

    // Synthesise a translated bundle by reading the source and adding
    // a target.text per unit.
    let source_bundle_bytes =
        fs::read(tmp.path().join("scene-1-source.json")).expect("read source bundle");
    let mut bundle_value: serde_json::Value =
        serde_json::from_slice(&source_bundle_bytes).expect("source bundle JSON parses");
    {
        let units = bundle_value["units"].as_array_mut().expect("units array");
        for unit in units.iter_mut() {
            unit["target"] = serde_json::json!({
                "locale": "en-US",
                "text": "[EN] hello from kaifuu CLI patch",
            });
        }
    }
    fs::write(
        &bundle_out,
        serde_json::to_vec_pretty(&bundle_value).expect("serialize translated bundle"),
    )
    .expect("write translated bundle");

    // Step 2: run the patch command.
    let patch_output = Command::new(kaifuu_cli_binary())
        .arg("patch")
        .arg("--engine")
        .arg("reallive")
        .arg("--source")
        .arg(&source_root)
        .arg("--target")
        .arg(&target_root)
        .arg("--bundle")
        .arg(&bundle_out)
        .output()
        .expect("kaifuu-cli patch must run");
    assert!(
        patch_output.status.success(),
        "patch exited non-zero: status={:?}\nstdout={}\nstderr={}",
        patch_output.status,
        String::from_utf8_lossy(&patch_output.stdout),
        String::from_utf8_lossy(&patch_output.stderr)
    );

    // ---- Acceptance: target Seen.txt exists and is non-empty. ----
    let target_seen_path = resolve_seen_path(&target_root);
    let target_seen_bytes = fs::read(&target_seen_path).expect("read target Seen.txt");
    assert!(
        !target_seen_bytes.is_empty(),
        "patched Seen.txt must be non-empty"
    );
    assert!(
        (target_seen_bytes.len() as u64) >= 80_000,
        "patched Seen.txt must carry the 80,000-byte 10,000-slot directory; got {}",
        target_seen_bytes.len()
    );

    // ---- Acceptance: re-parse with the same scene count. ----
    let source_index = kaifuu_reallive::parse_archive(&source_seen_bytes).expect("source parses");
    let target_index = kaifuu_reallive::parse_archive(&target_seen_bytes).expect("target parses");
    assert_eq!(
        target_index.entries.len(),
        source_index.entries.len(),
        "patched archive must preserve the source's populated-slot count"
    );

    // ---- Acceptance: source sha256-unchanged. ----
    let source_seen_hash_after = sha256_hex(&fs::read(&source_seen_path).expect("re-read source"));
    assert_eq!(
        source_seen_hash_after, source_seen_hash_before,
        "source Seen.txt must be sha256-unchanged after the patch step \
         (before={source_seen_hash_before}, after={source_seen_hash_after})"
    );
}
