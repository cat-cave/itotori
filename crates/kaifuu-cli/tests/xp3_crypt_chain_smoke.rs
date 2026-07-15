//! CLI command-contract smoke for the profiled XP3 **crypt-chain**
//! command.
//! Spawns `kaifuu xp3 crypt-smoke` against the committed synthetic fixture +
//! trivial replacement manifest and proves the whole chain runs, in order,
//! through the keyRef-bound crypt profile: detect (magic-byte) -> profile/key
//! resolve -> extract -> patch -> rebuild -> verify -> delta. The emitted report
//! is redaction-clean: the secret ref is disclosed but the raw key, the
//! decrypted plaintext, and local paths never appear. Engine-general: the crypt
//! profile + keyRef are data, not a per-game code path.

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

fn kaifuu_cli_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"))
}

fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn kirikiri_dir() -> PathBuf {
    test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/kirikiri")
}

fn run_smoke(report_path: &std::path::Path) -> Value {
    let output = Command::new(kaifuu_cli_binary())
        .arg("xp3")
        .arg("crypt-smoke")
        .arg("--fixture")
        .arg(kirikiri_dir().join("xp3-crypt-chain.json"))
        .arg("--manifest")
        .arg(kirikiri_dir().join("xp3-patch-manifest.json"))
        .arg("--output")
        .arg(report_path)
        .output()
        .expect("spawn kaifuu xp3 crypt-smoke");
    assert!(
        output.status.success(),
        "crypt-smoke exited non-zero: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    kaifuu_core::read_json(report_path).expect("read redacted report")
}

#[test]
fn crypt_chain_runs_every_stage_in_order_through_keyref() {
    let work = tempfile::tempdir().unwrap();
    let report_path = work.path().join("report.json");
    let report = run_smoke(&report_path);

    assert_eq!(report["status"], "passed");
    assert_eq!(
        report["capabilityId"],
        "kaifuu-kirikiri-xp3-crypt-chain-smoke"
    );
    assert_eq!(report["sourceNodeId"], "KAIFUU-072");
    assert_eq!(report["engineFamily"], "kirikiri");
    assert_eq!(report["container"], "xp3");

    // The stage ledger carries all seven stages, in order, all passed.
    let stages = report["stages"].as_array().expect("stages array");
    let stage_names: Vec<&str> = stages
        .iter()
        .map(|outcome| outcome["stage"].as_str().unwrap())
        .collect();
    assert_eq!(
        stage_names,
        vec![
            "detect",
            "profile-resolve",
            "extract",
            "patch",
            "rebuild",
            "verify",
            "delta"
        ]
    );
    assert!(stages.iter().all(|outcome| outcome["status"] == "passed"));

    // Detect is by magic-byte signature, not by filename.
    assert_eq!(report["detect"]["detectedBy"], "magic-byte-signature");
    assert_eq!(report["detect"]["magicMatched"], true);

    // The keyRef resolved the crypt profile + key; only a one-way commitment +
    // length are disclosed.
    assert_eq!(report["profileResolve"]["resolved"], true);
    assert_eq!(
        report["profileResolve"]["secretRequirementId"],
        "kaifuu-k100-xp3-crypt-key"
    );
    assert_eq!(report["profileResolve"]["keyBytes"], 16);

    // Delta records the change (one member replaced, one byte-preserved) and a
    // real repack (source vs rebuilt container hashes differ).
    let delta = &report["delta"];
    assert_eq!(delta["membersChanged"], 1);
    assert_eq!(delta["membersUnchanged"], 1);
    assert_ne!(delta["sourceContainerHash"], delta["rebuiltContainerHash"]);
    assert_eq!(delta["format"], "kaifuu-xp3-crypt-delta-evidence");
}

#[test]
fn crypt_chain_report_is_redaction_clean() {
    let work = tempfile::tempdir().unwrap();
    let report_path = work.path().join("report.json");
    let _ = run_smoke(&report_path);

    let raw = std::fs::read_to_string(&report_path).expect("read report bytes");

    // The secret ref is disclosed (safe); the raw fixture keys never appear.
    assert!(raw.contains("local-secret:kaifuu-kirikiri-crypt-fixture-key"));
    assert!(!raw.contains("K100-XP3-XORKEY1"));
    assert!(!raw.contains("K100-XP3-WRONGKY"));

    // The decrypted synthetic plaintext (old + new text) never appears verbatim.
    assert!(!raw.contains("[synthetic-kirikiri-xp3-crypt-line-0]"));
    assert!(!raw.contains("[localized-kirikiri-xp3-patch-back-line-0-JA]"));

    // No local path leaks into the committed proof.
    assert!(!raw.contains("/scratch/"));
    assert!(!raw.contains(env!("CARGO_MANIFEST_DIR")));
}
