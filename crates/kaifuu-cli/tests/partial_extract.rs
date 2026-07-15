//! CLI partial-extract regression test.
//! Builds a synthetic fixture that mirrors the canonical failure case from
//! `docs/audits/real-bytes-validation-2026-06-24.md` §2.8: SEEN.TXT
//! envelope is parseable (10,000-slot directory with at least
//! one populated slot) but Gameexe.ini lacks the documented
//! RealLive-specific key prefixes (`#REGNAME`, `#KOE*`, `#SEEN*`,
//! `#GAMEEXE_VERSION`, `#G00*`). The RealLive detector returns
//! `detected == false` but the SEEN.TXT envelope row reports Matched,
//! triggering the partial path.
//! Asserts:
//! - `kaifuu extract <fixture> --output …` exits 0 and writes a
//!   `PartialAdapterReport` envelope (`partial == true`, nonzero
//!   `inventory.entries`).
//! - `kaifuu profile <fixture> --output …` emits the same envelope with
//!   `command: "profile"`, carrying SEEN.TXT envelope evidence plus the
//!   Gameexe.ini key-mismatch diagnostic.
//! - `kaifuu verify <fixture> --output …` exits 0 (no P0/P1 diagnostics)
//!   while still reporting `partial == true`.
//!   No real-bytes dependency: all fixtures are synthetic. The kaifuu-reallive
//!   `parse_archive` is the same code path that consumes the Sweetie HD
//!   Seen.txt in production, so a passing partial smoke here implies the
//!   envelope ingests cleanly for the real game too.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

fn kaifuu_cli_binary() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"));
    assert!(
        path.exists(),
        "kaifuu-cli binary must exist at {}",
        path.display()
    );
    path
}

/// Build a SEEN.TXT byte buffer with the 10,000-slot directory
/// layout. Slot `scene_id` is populated with `(offset, len)` pointing at a
/// non-empty payload appended after the directory. All other slots are
/// zeroed (the "reserved" representation per).
fn synthetic_real_envelope_seen_txt(populated_scene_ids: &[u16]) -> Vec<u8> {
    const SLOT_COUNT: usize = 10_000;
    const DIRECTORY_BYTE_LEN: usize = SLOT_COUNT * 8;

    let mut bytes = vec![0u8; DIRECTORY_BYTE_LEN];
    // Append a single shared payload that every populated slot points at;
    // the partial path only counts populated slot entries, not payload
    // distinctness.
    let payload_offset = DIRECTORY_BYTE_LEN as u32;
    let payload = b"KAIFUU-193 partial-extract synthetic scene payload";
    let payload_len = payload.len() as u32;

    for &scene_id in populated_scene_ids {
        let slot_index = scene_id as usize;
        assert!(slot_index < SLOT_COUNT, "scene id must fit in directory");
        let slot_byte_offset = slot_index * 8;
        bytes[slot_byte_offset..slot_byte_offset + 4]
            .copy_from_slice(&payload_offset.to_le_bytes());
        bytes[slot_byte_offset + 4..slot_byte_offset + 8]
            .copy_from_slice(&payload_len.to_le_bytes());
    }
    bytes.extend_from_slice(payload);
    bytes
}

/// Build a Gameexe.ini with NO RealLive-specific key prefixes. The
/// detector's catalogue (`#REGNAME`, `#GAMEEXE_VERSION`, `#G00*`,
/// `#KOE*`, `#SEEN*`) sees nothing here, so the
/// `reallive_gameexe_ini_keys` evidence row reports `Invalid` (file
/// exists, signature missing).
fn synthetic_unmatched_gameexe_ini() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"# Synthetic Gameexe.ini for KAIFUU-193 partial-extract test\n");
    bytes.extend_from_slice(b"#SOMETHING_NOT_REALLIVE=value\n");
    bytes.extend_from_slice(b"#ANOTHER_KEY=42\n");
    bytes
}

fn build_partial_fixture(name: &str) -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix(name)
        .tempdir()
        .expect("tempdir");
    let data_root = dir.path().join("REALLIVEDATA");
    fs::create_dir_all(&data_root).expect("REALLIVEDATA dir");
    fs::write(
        data_root.join("SEEN.TXT"),
        synthetic_real_envelope_seen_txt(&[1, 7, 42]),
    )
    .expect("write SEEN.TXT");
    fs::write(
        data_root.join("Gameexe.ini"),
        synthetic_unmatched_gameexe_ini(),
    )
    .expect("write Gameexe.ini");
    dir
}

fn run_cli(
    fixture: &std::path::Path,
    command: &[&str],
    output: &std::path::Path,
) -> std::process::Output {
    let mut cmd = Command::new(kaifuu_cli_binary());
    for arg in command {
        cmd.arg(arg);
    }
    cmd.arg(fixture);
    cmd.arg("--output");
    cmd.arg(output);
    cmd.output().expect("kaifuu-cli must run")
}

fn read_partial_report(path: &std::path::Path) -> Value {
    let bytes = fs::read(path).expect("partial report must exist");
    serde_json::from_slice(&bytes).expect("partial report must be valid JSON")
}

#[test]
fn extract_emits_partial_report_when_envelope_ok_but_gameexe_keys_mismatch() {
    let fixture = build_partial_fixture("kaifuu-193-extract");
    let tmp_out = tempfile::tempdir().expect("tmp out");
    let report_path = tmp_out.path().join("extract.json");

    let output = run_cli(fixture.path(), &["extract"], &report_path);
    assert!(
        output.status.success(),
        "kaifuu-cli extract must exit 0 on partial path; status={:?}\nstdout={}\nstderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );

    let report = read_partial_report(&report_path);
    assert_eq!(report["partial"], true, "partial flag must be true");
    assert_eq!(report["detected"], false, "detected must be false");
    assert_eq!(
        report["command"], "extract",
        "command must round-trip as \"extract\""
    );
    assert_eq!(
        report["schemaVersion"], "0.1.0",
        "schemaVersion is the schema-stable v0.1.0 envelope"
    );
    let entries = report["inventory"]["entries"]
        .as_u64()
        .expect("inventory.entries must be a u64");
    assert_eq!(
        entries, 3,
        "partial inventory must count the 3 populated SEEN.TXT slots"
    );
    let severity = &report["severityCounts"];
    assert_eq!(severity["p0"], 0, "no SEEN.TXT envelope failure expected");
    assert_eq!(
        severity["p1"], 0,
        "no scene-index-empty diagnostic expected"
    );
    assert!(
        severity["p2"].as_u64().unwrap_or(0) >= 1,
        "Gameexe.ini key-catalogue mismatch must surface as P2"
    );
}

#[test]
fn profile_emits_partial_report_with_envelope_evidence() {
    let fixture = build_partial_fixture("kaifuu-193-profile");
    let tmp_out = tempfile::tempdir().expect("tmp out");
    let report_path = tmp_out.path().join("profile.json");

    let output = run_cli(fixture.path(), &["profile"], &report_path);
    assert!(
        output.status.success(),
        "kaifuu-cli profile must exit 0 on partial path; status={:?}\nstdout={}\nstderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );

    let report = read_partial_report(&report_path);
    assert_eq!(report["command"], "profile");
    assert_eq!(report["partial"], true);
    let evidence = report["evidence"]
        .as_array()
        .expect("evidence must be an array");
    let envelope_matched = evidence
        .iter()
        .any(|row| row["kind"] == "reallive_seen_txt_envelope" && row["status"] == "matched");
    assert!(
        envelope_matched,
        "SEEN.TXT envelope evidence must be Matched: {evidence:?}"
    );
    let diagnostics = report["diagnostics"]
        .as_array()
        .expect("diagnostics must be an array");
    let has_gameexe_mismatch = diagnostics
        .iter()
        .any(|diag| diag["code"] == "kaifuu.reallive.partial.gameexe_key_catalogue_mismatch");
    assert!(
        has_gameexe_mismatch,
        "Gameexe.ini key-mismatch diagnostic must be present: {diagnostics:?}"
    );
}

#[test]
fn verify_exits_zero_with_partial_status_when_no_blocking_diagnostics() {
    let fixture = build_partial_fixture("kaifuu-193-verify");
    let tmp_out = tempfile::tempdir().expect("tmp out");
    let report_path = tmp_out.path().join("verify.json");

    let output = run_cli(fixture.path(), &["verify"], &report_path);
    assert!(
        output.status.success(),
        "kaifuu-cli verify must exit 0 when only P2/P3 diagnostics fire; status={:?}\nstdout={}\nstderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );

    let report = read_partial_report(&report_path);
    assert_eq!(report["partial"], true);
    assert_eq!(report["command"], "verify");
    let severity = &report["severityCounts"];
    assert_eq!(severity["p0"], 0);
    assert_eq!(severity["p1"], 0);
}

#[test]
fn verify_exits_nonzero_when_seen_txt_envelope_fails() {
    // Same RealLive marker shape, but SEEN.TXT is too short to satisfy the
    // 10,000-slot directory contract. The partial extractor must surface a
    // P0 diagnostic and `kaifuu verify` must exit 1.
    let dir = tempfile::Builder::new()
        .prefix("kaifuu-193-verify-blocking")
        .tempdir()
        .expect("tempdir");
    let data_root = dir.path().join("REALLIVEDATA");
    fs::create_dir_all(&data_root).expect("REALLIVEDATA dir");
    // Truncated SEEN.TXT (way under the 80,000-byte directory minimum):
    // the partial path classifies this as P0
    // `kaifuu.reallive.partial.out_of_profile_input`.
    fs::write(data_root.join("SEEN.TXT"), b"too-short-seen-txt").expect("write SEEN.TXT");
    fs::write(
        data_root.join("Gameexe.ini"),
        synthetic_unmatched_gameexe_ini(),
    )
    .expect("write Gameexe.ini");
    // The detector requires at least one RealLive marker; SEEN.TXT
    // existence alone is enough to trigger the `UnknownEngineVariant` row
    // and the partial path. SEEN.TXT envelope parse failure produces P0.

    let tmp_out = tempfile::tempdir().expect("tmp out");
    let report_path = tmp_out.path().join("verify-blocking.json");
    let output = run_cli(dir.path(), &["verify"], &report_path);
    assert!(
        !output.status.success(),
        "kaifuu-cli verify must exit non-zero on P0 SEEN.TXT envelope failure; status={:?}\nstdout={}\nstderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    let report = read_partial_report(&report_path);
    assert_eq!(report["partial"], true);
    assert!(
        report["severityCounts"]["p0"].as_u64().unwrap_or(0) >= 1,
        "expected ≥1 P0 SEEN.TXT envelope failure: {report}"
    );
}
