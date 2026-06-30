//! KAIFUU-054 — CLI command-contract smoke for the KiriKiri XP3
//! capability-profile generator and validator.
//!
//! Spawns `kaifuu xp3 capability-profile` against the committed synthetic
//! manifest and asserts the generated report is evidence-driven: only the
//! plain XP3 entry is `claimed`, every encrypted / helper-required /
//! protected-executable / universal-dump entry is `research`-tier with no
//! patch-back claim, and plaintext `.ks` is the `null_container` special case.
//! A manifest that declares a patch claim on an encrypted variant fails with a
//! structured overclaim finding rather than a panic. No private corpora are
//! used; the report carries only counts and hashes.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn kaifuu_cli_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"))
}

fn kirikiri_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/kaifuu/kirikiri")
}

fn manifest() -> PathBuf {
    kirikiri_dir().join("xp3-capability-profile.json")
}

fn entry<'a>(report: &'a Value, entry_id: &str) -> &'a Value {
    report["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["entryId"] == entry_id)
        .unwrap_or_else(|| panic!("entry {entry_id} missing"))
}

#[test]
fn capability_profile_is_generated_from_evidence_and_passes() {
    let work = tempfile::tempdir().unwrap();
    let report_path = work.path().join("report.json");

    let output = Command::new(kaifuu_cli_binary())
        .arg("xp3")
        .arg("capability-profile")
        .arg("--fixture")
        .arg(manifest())
        .arg("--output")
        .arg(&report_path)
        .output()
        .expect("kaifuu-cli should run");

    assert!(
        output.status.success(),
        "expected success; stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );

    let report: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["sourceNodeId"], "KAIFUU-054");
    assert_eq!(report["entries"].as_array().unwrap().len(), 6);

    // Plain XP3 is the only claimed-support concern.
    let plain = entry(&report, "plain-xp3");
    assert_eq!(plain["capabilityTuple"]["supportTier"], "claimed");
    assert_eq!(plain["capabilityTuple"]["patchCapability"], "patch_back");
    assert_eq!(plain["archiveProfile"]["entryCount"], 3);

    // Plaintext .ks is the null-container special case, not the baseline.
    let ks = entry(&report, "plaintext-ks-null-container");
    assert_eq!(ks["capabilityTuple"]["supportTier"], "null_container");

    // Every non-plain variant is research-tier, never a patch claim.
    for entry_id in [
        "encrypted-xp3",
        "helper-required-xp3",
        "protected-executable",
        "universal-dump",
    ] {
        let entry = entry(&report, entry_id);
        assert_eq!(
            entry["capabilityTuple"]["supportTier"], "research",
            "{entry_id} must be research-tier"
        );
        assert_ne!(
            entry["capabilityTuple"]["patchCapability"], "patch_back",
            "{entry_id} must not claim patch-back"
        );
        // Provenance tuple is recorded.
        assert_eq!(entry["redactionStatus"], "redacted");
        assert!(
            entry["validationCommand"]
                .as_str()
                .unwrap()
                .starts_with("kaifuu xp3 capability-profile --fixture")
        );
    }
}

#[test]
fn encrypted_patch_overclaim_fails_with_structured_finding_not_panic() {
    let tmp = tempfile::tempdir().unwrap();
    // Copy the manifest and flip the encrypted entry to claim patch-back.
    let mut value: Value = serde_json::from_slice(&fs::read(manifest()).unwrap()).unwrap();
    for entry in value["entries"].as_array_mut().unwrap() {
        if entry["entryId"] == "encrypted-xp3" {
            entry["expected"]["supportTier"] = Value::String("claimed".to_string());
            entry["expected"]["patchCapability"] = Value::String("patch_back".to_string());
        }
    }
    // Write the mutated manifest beside the real one so its relative evidence
    // paths still resolve.
    let drifted = kirikiri_dir().join(format!(
        ".tmp-xp3-capability-overclaim-{}.json",
        std::process::id()
    ));
    fs::write(&drifted, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    let _guard = RemoveOnDrop(drifted.clone());

    let report_path = tmp.path().join("report.json");
    let output = Command::new(kaifuu_cli_binary())
        .arg("xp3")
        .arg("capability-profile")
        .arg("--fixture")
        .arg(&drifted)
        .arg("--output")
        .arg(&report_path)
        .output()
        .expect("kaifuu-cli should run");

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "overclaim must fail validation");
    assert!(!stderr.contains("panicked"), "must not panic: {stderr}");
    assert!(
        stderr.contains("XP3 capability profile validation failed")
            && stderr.contains("encrypted-xp3"),
        "stderr missing structured failure: {stderr}"
    );

    let report: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    assert_eq!(report["status"], "failed");
    let encrypted = entry(&report, "encrypted-xp3");
    assert_eq!(encrypted["status"], "failed");
    // The generated tuple still refuses the claim — research-tier, no patch.
    assert_eq!(encrypted["capabilityTuple"]["supportTier"], "research");
    assert_ne!(
        encrypted["capabilityTuple"]["patchCapability"],
        "patch_back"
    );
    let has_overclaim = encrypted["findings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|finding| finding["code"] == "xp3.capability.encrypted_patch_overclaim");
    assert!(has_overclaim, "missing overclaim finding: {encrypted}");
}

struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
