use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use kaifuu_reallive::{
    REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, SCENE_HEADER_BYTE_LEN, compress_avg32_literal,
};
use serde_json::Value;

/// Resolve this crate's manifest directory (runtime `CARGO_MANIFEST_DIR`).
///
/// `env!("CARGO_MANIFEST_DIR")` is baked at COMPILE time, so a test binary
/// reused from a different (since-removed) worktree would resolve to a dead
/// path. `cargo test` sets `CARGO_MANIFEST_DIR` in the RUNTIME environment to
/// the LIVE crate directory; prefer that, falling back to the compile-time
/// constant only outside cargo.
fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn kaifuu_cli_binary() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"));
    if path.exists() {
        return path;
    }
    path = test_manifest_dir()
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("target/debug/kaifuu-cli"))
        .expect("workspace root");
    path
}

fn write_synthetic_reallive_project(root: &Path) {
    let reallive_data = root.join("REALLIVEDATA");
    fs::create_dir_all(&reallive_data).expect("create REALLIVEDATA");
    fs::write(reallive_data.join("Seen.txt"), synthetic_seen_txt()).expect("write Seen.txt");
    fs::write(reallive_data.join("Gameexe.ini"), b"#WINTITLE=Synthetic\n")
        .expect("write Gameexe.ini");
}

fn synthetic_seen_txt() -> Vec<u8> {
    let plaintext = vec![0x83u8, 0x6E, 0x0A, 0x05, 0x00];
    let compressed = compress_avg32_literal(&plaintext).expect("compress synthetic bytecode");

    let mut header = vec![0u8; SCENE_HEADER_BYTE_LEN];
    header[0..4].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
    // Plaintext synthetic bytecode -> use a NON-`xor_2` compiler version
    // (110001, not 110002/1110002): stamping an `xor_2` version would make the
    // extract try to recover an `xor_2` key from unencrypted bytes and abort
    // (`xor2.key_region_unsampled`). The real `xor_2` path is covered by the
    // real Sweetie HD real-bytes tests.
    header[4..8].copy_from_slice(&110_001u32.to_le_bytes());
    header[0x20..0x24].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
    header[0x24..0x28].copy_from_slice(&(plaintext.len() as u32).to_le_bytes());
    header[0x28..0x2c].copy_from_slice(&(compressed.len() as u32).to_le_bytes());

    let mut scene_blob = Vec::with_capacity(header.len() + compressed.len());
    scene_blob.extend_from_slice(&header);
    scene_blob.extend_from_slice(&compressed);

    let scene_offset = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN;
    let mut archive = vec![0u8; REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize + scene_blob.len()];
    archive[8..12].copy_from_slice(&(scene_offset as u32).to_le_bytes());
    archive[12..16].copy_from_slice(&(scene_blob.len() as u32).to_le_bytes());
    archive[REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize..].copy_from_slice(&scene_blob);
    archive
}

fn run_extract(
    game_root: &Path,
    bundle_out: &Path,
    game_id: &str,
    game_version: &str,
    source_profile_id: &str,
    source_locale: &str,
) -> std::process::Output {
    Command::new(kaifuu_cli_binary())
        .arg("extract")
        .arg("--engine")
        .arg("reallive")
        .arg("--scene")
        .arg("1")
        .arg("--bundle-output")
        .arg(bundle_out)
        .arg("--game-root")
        .arg(game_root)
        .arg("--game-id")
        .arg(game_id)
        .arg("--game-version")
        .arg(game_version)
        .arg("--source-profile-id")
        .arg(source_profile_id)
        .arg("--source-locale")
        .arg(source_locale)
        .output()
        .expect("kaifuu-cli must run")
}

#[test]
fn reallive_project_metadata_flags_produce_distinct_bridge_metadata() {
    let tmp = tempfile::tempdir().expect("tmp dir");
    let project_a = tmp.path().join("project-a");
    let project_b = tmp.path().join("project-b");
    write_synthetic_reallive_project(&project_a);
    write_synthetic_reallive_project(&project_b);

    let bundle_a = tmp.path().join("project-a.bridge.json");
    let bundle_b = tmp.path().join("project-b.bridge.json");

    let output_a = run_extract(
        &project_a,
        &bundle_a,
        "synthetic-a",
        "2026.06-a",
        "kaifuu-reallive-synthetic-a",
        "ja-JP",
    );
    assert!(
        output_a.status.success(),
        "project A extract failed: status={:?}\nstdout={}\nstderr={}",
        output_a.status,
        String::from_utf8_lossy(&output_a.stdout),
        String::from_utf8_lossy(&output_a.stderr),
    );

    let output_b = run_extract(
        &project_b,
        &bundle_b,
        "synthetic-b",
        "2026.06-b",
        "kaifuu-reallive-synthetic-b",
        "en-US",
    );
    assert!(
        output_b.status.success(),
        "project B extract failed: status={:?}\nstdout={}\nstderr={}",
        output_b.status,
        String::from_utf8_lossy(&output_b.stdout),
        String::from_utf8_lossy(&output_b.stderr),
    );

    let value_a: Value =
        serde_json::from_slice(&fs::read(&bundle_a).expect("read project A bundle"))
            .expect("project A bundle JSON");
    let value_b: Value =
        serde_json::from_slice(&fs::read(&bundle_b).expect("read project B bundle"))
            .expect("project B bundle JSON");

    assert_eq!(value_a["sourceGame"]["gameId"], "synthetic-a");
    assert_eq!(value_a["sourceGame"]["gameVersion"], "2026.06-a");
    assert_eq!(
        value_a["sourceGame"]["sourceProfileId"],
        "kaifuu-reallive-synthetic-a"
    );
    assert_eq!(value_a["sourceLocale"], "ja-JP");

    assert_eq!(value_b["sourceGame"]["gameId"], "synthetic-b");
    assert_eq!(value_b["sourceGame"]["gameVersion"], "2026.06-b");
    assert_eq!(
        value_b["sourceGame"]["sourceProfileId"],
        "kaifuu-reallive-synthetic-b"
    );
    assert_eq!(value_b["sourceLocale"], "en-US");
    assert_ne!(
        value_a["bridgeId"], value_b["bridgeId"],
        "bridge id must be scoped by caller-supplied metadata"
    );
    assert_ne!(
        value_a["sourceGame"]["sourceProfileRevision"]["revisionId"],
        value_b["sourceGame"]["sourceProfileRevision"]["revisionId"],
        "source profile revision id must be scoped by caller-supplied metadata"
    );
    assert_ne!(
        value_a["sourceGame"]["sourceProfileRevision"]["value"],
        value_b["sourceGame"]["sourceProfileRevision"]["value"],
        "source profile hash must follow caller-supplied source profile id"
    );
}

#[test]
fn reallive_project_metadata_missing_flag_fails_before_writing_bundle() {
    let tmp = tempfile::tempdir().expect("tmp dir");
    let bundle_out = tmp.path().join("missing-metadata.bridge.json");

    let output = Command::new(kaifuu_cli_binary())
        .arg("extract")
        .arg("--engine")
        .arg("reallive")
        .arg("--scene")
        .arg("1")
        .arg("--bundle-output")
        .arg(&bundle_out)
        .arg("--game-root")
        .arg(tmp.path().join("does-not-need-to-exist"))
        .arg("--game-id")
        .arg("synthetic-missing")
        .arg("--game-version")
        .arg("2026.06")
        .arg("--source-profile-id")
        .arg("kaifuu-reallive-synthetic-missing")
        .output()
        .expect("kaifuu-cli must run");

    assert!(
        !output.status.success(),
        "missing metadata must fail extraction"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("missing RealLive bridge metadata flag --source-locale"),
        "stderr did not identify the missing metadata flag: {stderr}"
    );
    assert!(
        !bundle_out.exists(),
        "bundle output must not be written when metadata is incomplete"
    );
}

#[test]
fn reallive_project_metadata_whitespace_flag_fails_before_writing_bundle() {
    let tmp = tempfile::tempdir().expect("tmp dir");
    let bundle_out = tmp.path().join("whitespace-metadata.bridge.json");

    let output = run_extract(
        &tmp.path().join("does-not-need-to-exist"),
        &bundle_out,
        "synthetic-whitespace",
        "   ",
        "kaifuu-reallive-synthetic-whitespace",
        "ja-JP",
    );

    assert!(
        !output.status.success(),
        "whitespace metadata must fail extraction"
    );
    assert!(
        !bundle_out.exists(),
        "bundle output must not be written when metadata is whitespace-only"
    );
}
