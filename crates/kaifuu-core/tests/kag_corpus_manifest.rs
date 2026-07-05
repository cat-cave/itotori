//! KAIFUU-203: invariants for the hand-authored CC0 KAG `.ks` corpus under
//! `fixtures/public/kaifuu-kag-synthetic-corpus/`.
//!
//! Proves, on the committed bytes:
//! - the manifest declares `"SPDX-License-Identifier": "CC0-1.0"` verbatim and
//!   at the fixture level, and every `.ks` carries a per-file CC0 header;
//! - the `tagInventory` drawn from the KAG profile-B inventory has >= 6 distinct
//!   tags, and the recorded per-file / aggregate inventories match a fresh scan
//!   of the committed bytes (the generator recorded them honestly);
//! - each declared sha256 / byte length matches the committed file;
//! - the corpus PARSES with the KAG adapter (`kaifuu_kirikiri::parse_ks`) with
//!   zero unclosed-tag findings — every declared `[tag …]` is recognised as a
//!   well-formed structural tag — and yields dialogue + speaker units plus a
//!   label/jump control-flow pair.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use kaifuu_kirikiri::{KsFindingKind, TextRole, parse_ks};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The canonical KAG profile-B tag inventory (KAIFUU-203 spec).
const PROFILE_B_TAGS: &[&str] = &[
    "r", "l", "p", "cm", "ct", "wait", "jump", "call", "return", "if", "endif", "macro",
    "endmacro", "eval", "image", "playbgm",
];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

fn load_manifest() -> Value {
    let path = repo_root().join("fixtures/public/kaifuu-kag-synthetic-corpus.manifest.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read manifest {}: {e}", path.display()));
    serde_json::from_str(&text).expect("manifest is valid JSON")
}

/// Distinct inline KAG tag names in `text`, mirroring the kaifuu-kirikiri
/// parser: `[[` is the literal-bracket escape (not a tag), and a tag name is
/// `[A-Za-z_][A-Za-z0-9_]*` immediately after `[`.
fn scan_tags(text: &str) -> BTreeSet<String> {
    let bytes = text.as_bytes();
    let mut tags = BTreeSet::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'[' {
            i += 1;
            continue;
        }
        if bytes.get(i + 1) == Some(&b'[') {
            i += 2; // `[[` literal escape.
            continue;
        }
        let name_start = i + 1;
        let mut j = name_start;
        if j < bytes.len() && (bytes[j].is_ascii_alphabetic() || bytes[j] == b'_') {
            j += 1;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
                j += 1;
            }
            tags.insert(String::from_utf8(bytes[name_start..j].to_vec()).unwrap());
        }
        i = name_start;
    }
    tags
}

fn str_array(value: &Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .unwrap_or_else(|| panic!("`{key}` must be an array"))
        .iter()
        .map(|v| v.as_str().expect("array of strings").to_string())
        .collect()
}

#[test]
fn manifest_declares_cc0_verbatim() {
    let manifest = load_manifest();
    assert_eq!(
        manifest["SPDX-License-Identifier"], "CC0-1.0",
        "manifest must declare \"SPDX-License-Identifier\": \"CC0-1.0\" verbatim",
    );
    assert_eq!(
        manifest["fixture"]["license"]["spdx"], "CC0-1.0",
        "fixture license spdx must be CC0-1.0",
    );
    assert_eq!(
        manifest["fixture"]["provenance"]["rawAssetPolicy"],
        "contains-no-copyrighted-game-assets",
    );
}

#[test]
fn tag_inventory_covers_at_least_six_profile_b_tags() {
    let manifest = load_manifest();
    let profile_b = str_array(&manifest, "profileBTagInventory");
    let distinct: BTreeSet<&String> = profile_b.iter().collect();
    assert_eq!(
        distinct.len(),
        profile_b.len(),
        "profileBTagInventory has dupes"
    );
    assert!(
        distinct.len() >= 6,
        "need >= 6 distinct profile-B tags, got {}",
        distinct.len(),
    );
    for tag in &profile_b {
        assert!(
            PROFILE_B_TAGS.contains(&tag.as_str()),
            "`{tag}` is not a KAG profile-B tag",
        );
    }

    // profileBTagInventory must be exactly the intersection of the aggregate
    // tagInventory with the canonical profile-B set.
    let full: BTreeSet<String> = str_array(&manifest, "tagInventory").into_iter().collect();
    let expected: BTreeSet<String> = full
        .iter()
        .filter(|t| PROFILE_B_TAGS.contains(&t.as_str()))
        .cloned()
        .collect();
    let got: BTreeSet<String> = distinct.into_iter().cloned().collect();
    assert_eq!(
        got, expected,
        "profileBTagInventory != tagInventory ∩ profile-B"
    );
    assert!(
        full.len() >= 6,
        "aggregate tagInventory must have >= 6 tags"
    );
}

#[test]
fn recorded_hashes_tags_and_headers_match_committed_bytes() {
    let manifest = load_manifest();
    let root = repo_root();
    let files = manifest["files"].as_array().expect("files array");
    assert!(files.len() >= 6, "corpus must have >= 6 .ks files");

    let mut union: BTreeSet<String> = BTreeSet::new();
    for file in files {
        let rel = file["path"].as_str().expect("file path");
        assert!(
            Path::new(rel)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("ks")),
            "corpus file must be a .ks: {rel}",
        );
        let bytes = std::fs::read(root.join(rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"));
        let text = String::from_utf8(bytes.clone()).expect("corpus is UTF-8");

        // Per-file CC0 declaration in the header comment.
        assert!(
            text.lines()
                .take(6)
                .any(|l| l.contains("SPDX-License-Identifier: CC0-1.0")),
            "{rel} must carry a `; SPDX-License-Identifier: CC0-1.0` header",
        );

        // sha256 + byte length recorded honestly.
        let sha = format!("{:x}", Sha256::digest(&bytes));
        assert_eq!(file["sha256"].as_str().unwrap(), sha, "{rel} sha256 drift");
        assert_eq!(
            file["bytes"].as_u64().unwrap(),
            bytes.len() as u64,
            "{rel} byte count drift",
        );

        // Per-file tag inventory matches a fresh scan.
        let scanned: Vec<String> = scan_tags(&text).into_iter().collect();
        let recorded = str_array(file, "tagInventory");
        assert_eq!(recorded, scanned, "{rel} tagInventory drift");
        union.extend(scanned);
    }

    let aggregate: BTreeSet<String> = str_array(&manifest, "tagInventory").into_iter().collect();
    assert_eq!(
        union, aggregate,
        "aggregate tagInventory != union of per-file"
    );
}

#[test]
fn corpus_parses_with_kag_adapter_and_covers_all_constructs() {
    let manifest = load_manifest();
    let root = repo_root();
    let files = manifest["files"].as_array().expect("files array");

    let mut total_dialogue = 0usize;
    let mut total_speakers = 0usize;
    let mut has_label = false;
    let mut has_jump_tag = false;

    for file in files {
        let rel = file["path"].as_str().unwrap();
        let name = rel.rsplit('/').next().unwrap();
        let bytes = std::fs::read(root.join(rel)).unwrap();
        let doc = parse_ks(name, &bytes);

        // Every `[tag …]` is a recognised, well-formed structural tag.
        for finding in &doc.findings {
            assert_ne!(
                finding.kind,
                KsFindingKind::UnclosedInlineTag,
                "{rel} L{}: unclosed/unrecognised tag `{}`",
                finding.line_index,
                finding.detail,
            );
        }

        total_dialogue += doc
            .units
            .iter()
            .filter(|u| u.role == TextRole::Dialogue)
            .count();
        total_speakers += doc
            .units
            .iter()
            .filter(|u| u.role == TextRole::SpeakerName)
            .count();

        let text = String::from_utf8(bytes).unwrap();
        if text.lines().any(|l| l.starts_with('*')) {
            has_label = true;
        }
        if text.contains("[jump") {
            has_jump_tag = true;
        }

        // Deterministic: parsing twice yields identical units.
        let doc2 = parse_ks(name, &std::fs::read(root.join(rel)).unwrap());
        assert_eq!(doc.units, doc2.units, "{rel} parse is non-deterministic");
    }

    assert!(total_dialogue > 0, "corpus must yield dialogue units");
    assert!(total_speakers > 0, "corpus must yield speaker-name units");
    assert!(has_label, "corpus must contain at least one *label");
    assert!(
        has_jump_tag,
        "corpus must contain at least one [jump] (label/jump pair)"
    );

    // Every declared profile-B tag actually appears as a well-formed `[tag` in
    // the committed corpus (adapter-recognised structure).
    let all_text: String = files
        .iter()
        .map(|f| std::fs::read_to_string(root.join(f["path"].as_str().unwrap())).unwrap())
        .collect();
    for tag in str_array(&manifest, "profileBTagInventory") {
        assert!(
            all_text.contains(&format!("[{tag}")),
            "declared profile-B tag `{tag}` not present in corpus",
        );
    }
}
