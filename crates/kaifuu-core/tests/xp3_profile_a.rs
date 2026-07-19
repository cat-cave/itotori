//! Metadata-only licensed plain-XP3 profile A intake.
//!
//! The committed fixture intentionally carries no game bytes, member paths, or
//! scenario prose. Set `KAIFUU_XP3_PROFILE_A_ARCHIVE` to the separately
//! licensed source archive to run the read-side real-byte proof locally.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use kaifuu_core::read_plain_xp3_inventory;
use serde_json::Value;
use sha2::{Digest, Sha256};

const LICENSE_ID: &str = "LicenseRef-MangaGamer-Commercial-EULA";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

fn manifest() -> Value {
    let path = repo_root().join("fixtures/public/kaifuu-xp3-plain-profile-a.manifest.json");
    serde_json::from_slice(
        &std::fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display())),
    )
    .expect("profile-A manifest JSON")
}

fn string_set(value: &Value, field: &str) -> BTreeSet<String> {
    value[field]
        .as_array()
        .unwrap_or_else(|| panic!("{field} must be an array"))
        .iter()
        .map(|item| item.as_str().expect("string array item").to_string())
        .collect()
}

#[test]
fn metadata_only_profile_a_declares_honest_inventory_and_kag_coverage() {
    let manifest = manifest();
    let manifest_text = serde_json::to_string(&manifest).expect("serialize manifest");
    assert_eq!(manifest["SPDX-License-Identifier"], LICENSE_ID);
    assert_eq!(manifest["fixture"]["license"]["spdx"], LICENSE_ID);
    assert_eq!(
        manifest["fixture"]["provenance"]["rawAssetPolicy"],
        "contains-no-copyrighted-game-assets"
    );
    assert!(
        !manifest_text.contains("/scratch/") && !manifest_text.contains("scenario/"),
        "metadata fixture must not retain a local archive path or member path"
    );

    let archive = &manifest["archive"];
    assert_eq!(archive["kind"], "xp3-archive");
    assert_eq!(archive["inventoryReader"], "read_plain_xp3_inventory");
    assert_eq!(archive["inventoryErrors"], 0);
    assert!(
        archive["inventoryEntryCount"].as_u64().unwrap() >= 3,
        "profile A needs a nontrivial real archive inventory"
    );
    assert!(
        archive["sha256"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64)
    );

    let kaifuu203: Value = serde_json::from_slice(
        &std::fs::read(
            repo_root().join("fixtures/public/kaifuu-kag-synthetic-corpus.manifest.json"),
        )
        .expect("kaifuu-kag-synthetic-corpus manifest"),
    )
    .expect("kaifuu-kag-synthetic-corpus manifest JSON");
    let source_tags = string_set(&kaifuu203, "tagInventory");
    let scenario = &manifest["kagScenario"];
    let profile_tags = string_set(scenario, "tagInventory");
    let expected_intersection: BTreeSet<String> =
        source_tags.intersection(&profile_tags).cloned().collect();
    assert_eq!(
        string_set(scenario, "tagInventoryIntersectionWithKaifuu203"),
        expected_intersection
    );
    let expected_ratio = expected_intersection.len() as f64 / source_tags.len() as f64;
    assert_eq!(
        scenario["tagInventoryIntersectionRatioAgainstKaifuu203"]
            .as_f64()
            .unwrap(),
        expected_ratio
    );
    assert!(
        expected_ratio >= 0.5,
        "profile A must cover half of kaifuu-kag-synthetic-corpus tags"
    );
}

#[test]
fn supplied_licensed_archive_matches_profile_a_inventory_metadata() {
    let Some(archive_path) = std::env::var_os("KAIFUU_XP3_PROFILE_A_ARCHIVE") else {
        return;
    };
    let bytes = std::fs::read(archive_path).expect("read supplied licensed archive");
    let inventory = read_plain_xp3_inventory(&bytes).expect("supplied archive must parse cleanly");
    let manifest = manifest();
    let archive = &manifest["archive"];

    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        archive["sha256"].as_str().unwrap(),
        "supplied archive hash must match the metadata-only capture"
    );
    assert_eq!(
        inventory.entries.len() as u64,
        archive["inventoryEntryCount"].as_u64().unwrap(),
        "reader inventory count must match the metadata-only capture"
    );
    assert!(inventory.entries.len() >= 3);
}
