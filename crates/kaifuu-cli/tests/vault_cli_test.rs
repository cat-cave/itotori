//! end-to-end tests for the `kaifuu vault` subcommand group.
//! Each test builds a fresh SYNTHETIC vault under a `tempfile::TempDir` (NEVER
//! the real `/archive/vault/`) and drives the compiled `kaifuu` binary against
//! it via `--vault-root` / `--scratch-root`. The synthetic catalog schema is
//! materialised from the tracked synthetic seed the vault-source crate already
//! ships (`kaifuu-vault-source/tests/fixtures/synthetic-vault/seed.sql`), and a
//! single real by-id `.7z` archive is built in-test so `materialize` /
//! `materialize-by-sha` resolve a real artifact end-to-end.
//! Copyright posture: the fake game payload embeds a unique sentinel
//! (`SENTINEL_RAW_GAME_BYTES`); every test asserts that sentinel NEVER appears
//! in any CLI output — the group reports ids / sha256 / paths / redacted
//! metadata only, never raw archive or extracted-file bytes.

use std::io::Cursor;
use std::path::PathBuf;
use std::process::Command;

use rusqlite::Connection;
use sevenz_rust2::{ArchiveEntry, ArchiveWriter};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

/// The stable by-id key + `<canonical_id>/` archive wrapper for the fixture.
const CID: &str = "hello-galaxy.v1234.cli.primary";
/// Release 10 (`Hello Galaxy`, work 1, engine kirikiri) already exists in the
/// synthetic seed; we link our artifact to it.
const RELEASE_ID: i64 = 10;
/// Unique sentinel embedded in the fake game payload. If this ever appears in
/// CLI output, raw archive/extracted bytes leaked.
const SENTINEL_RAW_GAME_BYTES: &str = "SENTINEL-RAW-GAME-BYTES-DO-NOT-LEAK";

struct SyntheticVault {
    _tmp: TempDir,
    vault_root: PathBuf,
    scratch_root: PathBuf,
    canonical_sha256: String,
}

fn manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in &digest {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Build the by-id `.7z`, wrapping every entry under `<CID>/` exactly as the
/// real by-id repack layout does (game tree + `_vault/metadata.json`).
fn build_by_id_archive() -> Vec<u8> {
    let metadata = serde_json::to_vec_pretty(&serde_json::json!({
        "canonical_id": CID,
        "identifiers": [
            { "source": "vndb", "kind": "v", "value": "v1234" },
            { "source": "dlsite", "kind": "rj", "value": "RJ123456" }
        ],
        "engine": "kirikiri",
        "engine_evidence": {
            "evidence": "direct_observation",
            "observed_at": "2026-01-01 00:00:00",
            "source": "synthetic_fixture",
            "value": "kirikiri"
        },
        "engine_source": "synthetic_fixture",
        "work": {
            "age_rating": "all",
            "canonical_title": "Hello Galaxy",
            "original_title": null,
            "series_id": null,
            "series_name": null,
            "work_kind": "vn"
        },
        "release": {
            "drm_model": null,
            "edition_name": null,
            "edition_year": null,
            "is_portable": null,
            "release_date": null,
            "store": null
        },
        "languages": [{
            "evidence_path": null,
            "is_mtl": false,
            "kind": "full",
            "language_code": "ja",
            "source": "synthetic_fixture"
        }],
        "install_manifest": null,
        "containers_json": [{
            "classified": "archive",
            "exit": 0,
            "magic": "sevenz",
            "note": "",
            "produced": ["game/start.exe", "_vault/metadata.json"],
            "stderr": "",
            "tool": "synthetic-7zz"
        }],
        "runnable_from_tree": 1,
        "original_filename": "synthetic-cli-source.7z",
        "original_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "size_bytes": 1,
        "source_fetches": [{
            "fetched_at": "2026-01-01 00:00:00",
            "http_status": 200,
            "ok": true,
            "request_hash": "synthetic-cli-request",
            "source": "synthetic_fixture"
        }],
        "state": "vaulted",
        "version": "v1.0",
        "version_norm": [1, 0]
    }))
    .unwrap();

    let entries: Vec<(String, Vec<u8>)> = vec![
        (format!("{CID}/_vault/metadata.json"), metadata),
        (
            format!("{CID}/game/start.exe"),
            SENTINEL_RAW_GAME_BYTES.as_bytes().to_vec(),
        ),
    ];

    let buf = Cursor::new(Vec::<u8>::new());
    let mut writer = ArchiveWriter::new(buf).unwrap();
    for (name, data) in &entries {
        let entry = ArchiveEntry::new_file(name);
        writer
            .push_archive_entry::<&[u8]>(entry, Some(data.as_slice()))
            .unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn build_synthetic_vault() -> SyntheticVault {
    let tmp = tempfile::tempdir().unwrap();
    let vault_root = tmp.path().join("vault");
    let scratch_root = tmp.path().join("scratch");
    std::fs::create_dir_all(vault_root.join("artifacts/by-id")).unwrap();
    std::fs::create_dir_all(&scratch_root).unwrap();

    // Materialise catalog.db from the tracked synthetic seed (schema parity
    // with the vault-source adapter). The seed leaves artifacts empty; we
    // insert our own artifact + junction rows once the archive sha is known.
    let seed_path =
        manifest_dir().join("../kaifuu-vault-source/tests/fixtures/synthetic-vault/seed.sql");
    let seed_sql = std::fs::read_to_string(&seed_path)
        .unwrap_or_else(|e| panic!("read synthetic seed {}: {e}", seed_path.display()));
    let catalog_path = vault_root.join("catalog.db");
    let conn = Connection::open(&catalog_path).unwrap();
    conn.execute_batch(&seed_sql).unwrap();

    let archive = build_by_id_archive();
    let canonical_sha256 = sha256_hex(&archive);
    let on_disk = vault_root
        .join("artifacts/by-id")
        .join(CID)
        .join(format!("{CID}.7z"));
    std::fs::create_dir_all(on_disk.parent().unwrap()).unwrap();
    std::fs::write(&on_disk, &archive).unwrap();

    conn.execute(
        "INSERT INTO artifacts \
             (id, size_bytes, artifact_kind, vault_path, canonical_id, canonical_sha256, state) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'vaulted')",
        rusqlite::params![
            500_i64,
            archive.len() as i64,
            "portable_tree_packed",
            format!("artifacts/by-id/{CID}/{CID}.7z"),
            CID,
            canonical_sha256,
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO release_artifacts (release_id, artifact_id, role, subpath) \
         VALUES (?1, ?2, 'primary', NULL)",
        rusqlite::params![RELEASE_ID, 500_i64],
    )
    .unwrap();
    drop(conn);

    SyntheticVault {
        _tmp: tmp,
        vault_root,
        scratch_root,
        canonical_sha256,
    }
}

/// Run `kaifuu <args...>` against the synthetic vault. Env vars that would beat
/// the `--vault-root` override (per the adapter's resolution order) are removed
/// from the child so the test is deterministic regardless of the shell.
fn run_kaifuu(vault: &SyntheticVault, args: &[&str]) -> (bool, String, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_kaifuu-cli"));
    cmd.env_remove("ITOTORI_VAULT_ROOT")
        .env_remove("ITOTORI_SCRATCH_ROOT")
        .arg("vault")
        .arg(args[0])
        .arg("--vault-root")
        .arg(&vault.vault_root)
        .arg("--scratch-root")
        .arg(&vault.scratch_root)
        .args(&args[1..]);
    let out = cmd.output().expect("spawn kaifuu binary");
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn assert_no_raw_bytes_leaked(haystack: &str, context: &str) {
    assert!(
        !haystack.contains(SENTINEL_RAW_GAME_BYTES),
        "raw game bytes leaked in {context}: {haystack}"
    );
}

#[test]
fn vault_capabilities_prints_report_in_json_mode() {
    let vault = build_synthetic_vault();
    let (ok, stdout, stderr) = run_kaifuu(&vault, &["capabilities", "--json"]);
    assert!(ok, "capabilities --json failed: {stderr}");
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|e| panic!("capabilities --json not valid JSON ({e}): {stdout}"));
    assert_eq!(value["source_id"], "vault");
    assert_eq!(value["read_only"], true);
    assert_eq!(value["findings_sink_required"], true);
    assert_eq!(value["schema_version"], 1);
    assert_eq!(value["retention_policy_default"], "keep-none");
    assert!(
        value["supported_artifact_roles"]
            .as_array()
            .is_some_and(|roles| roles.iter().any(|r| r == "primary")),
        "expected 'primary' in supported_artifact_roles: {value}"
    );
    // The vault_root is a directory path (not archive bytes) — fine to print.
    assert!(value["vault_root"].is_string());
    assert_no_raw_bytes_leaked(&stdout, "capabilities --json");
}

#[test]
fn vault_capabilities_prints_report_in_human_mode() {
    let vault = build_synthetic_vault();
    let (ok, stdout, stderr) = run_kaifuu(&vault, &["capabilities"]);
    assert!(ok, "capabilities (human) failed: {stderr}");
    assert!(
        stdout.contains("vault capabilities"),
        "human header: {stdout}"
    );
    assert!(
        stdout.contains("source_id: vault"),
        "human source_id: {stdout}"
    );
    assert!(
        stdout.contains("read_only: true"),
        "human read_only: {stdout}"
    );
    assert!(
        stdout.contains("supported_artifact_roles: primary"),
        "human roles: {stdout}"
    );
    assert_no_raw_bytes_leaked(&stdout, "capabilities (human)");
}

#[test]
fn vault_discover_runs_trait_method_and_reports_candidate() {
    let vault = build_synthetic_vault();
    let (ok, stdout, stderr) = run_kaifuu(&vault, &["discover", "--canonical-id", CID, "--json"]);
    assert!(ok, "discover failed: {stderr}");
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|e| panic!("discover --json not valid JSON ({e}): {stdout}"));
    let arr = value.as_array().expect("discover emits a JSON array");
    assert!(
        arr.iter().any(|c| c["release_id"] == RELEASE_ID),
        "expected release {RELEASE_ID} in discover output: {value}"
    );
    assert!(
        arr.iter().any(|c| c["engine"] == "kirikiri"),
        "expected engine kirikiri: {value}"
    );
    assert_no_raw_bytes_leaked(&stdout, "discover --json");
}

#[test]
fn vault_materialize_runs_trait_method_and_reports_sha_without_leaking_bytes() {
    let vault = build_synthetic_vault();
    let (ok, stdout, stderr) = run_kaifuu(
        &vault,
        &[
            "materialize",
            "--canonical-id",
            CID,
            "--retention",
            "keep-all",
            "--json",
        ],
    );
    assert!(ok, "materialize failed: {stderr}");
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|e| panic!("materialize --json not valid JSON ({e}): {stdout}"));
    assert_eq!(value["artifact_canonical_id"], CID);
    assert_eq!(value["release_id"], RELEASE_ID);
    // The report carries the resolved archive sha256 — the "report the sha,
    // not the bytes" contract.
    let reported_sha = value["artifacts"][0]["canonical_sha256"]
        .as_str()
        .expect("materialize reports canonical_sha256");
    assert_eq!(reported_sha, vault.canonical_sha256);
    assert!(
        value["tree_root"].as_str().is_some_and(|p| p.contains(CID)),
        "materialize reports the extracted tree_root path: {value}"
    );
    // Redacted embedded metadata is fine (ids/engine), raw bytes are NOT.
    assert_eq!(value["embedded"]["engine"], "kirikiri");
    assert_no_raw_bytes_leaked(&stdout, "materialize --json stdout");
    assert_no_raw_bytes_leaked(&stderr, "materialize stderr");
}

#[test]
fn vault_materialize_by_sha_runs_trait_method_and_resolves_same_artifact() {
    let vault = build_synthetic_vault();
    let (ok, stdout, stderr) = run_kaifuu(
        &vault,
        &[
            "materialize-by-sha",
            "--sha256",
            &vault.canonical_sha256,
            "--retention",
            "keep-all",
            "--json",
        ],
    );
    assert!(ok, "materialize-by-sha failed: {stderr}");
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|e| panic!("materialize-by-sha --json not valid JSON ({e}): {stdout}"));
    assert_eq!(value["artifact_canonical_id"], CID);
    assert_eq!(value["release_id"], RELEASE_ID);
    assert_eq!(
        value["artifacts"][0]["canonical_sha256"],
        vault.canonical_sha256
    );
    assert_no_raw_bytes_leaked(&stdout, "materialize-by-sha --json stdout");
    assert_no_raw_bytes_leaked(&stderr, "materialize-by-sha stderr");
}

#[test]
fn vault_discover_without_a_claim_flag_errors() {
    let vault = build_synthetic_vault();
    let (ok, _stdout, stderr) = run_kaifuu(&vault, &["discover"]);
    assert!(!ok, "discover without a claim flag must fail");
    assert!(
        stderr.contains("require a claim flag"),
        "expected claim-flag guidance on stderr: {stderr}"
    );
}

#[test]
fn vault_unknown_subcommand_prints_usage() {
    let vault = build_synthetic_vault();
    let (ok, _stdout, stderr) = run_kaifuu(&vault, &["frobnicate"]);
    assert!(!ok, "unknown vault subcommand must fail");
    assert!(
        stderr.contains("usage: kaifuu vault"),
        "expected vault usage on stderr: {stderr}"
    );
}
