use super::*;
use kaifuu_core::{
    PLAIN_XP3_MANIFEST_SCHEMA_VERSION, PLAIN_XP3_MANIFEST_VARIANT, PlainXp3Archive,
    PlainXp3ArchiveEntry, PlainXp3ArchiveSegment, encode_xp3,
};
use std::collections::BTreeSet;

// A distinctive story-prose line the redaction test proves never leaks.
const SECRET_PROSE: &str = "SECRET_STORY_PROSE_DO_NOT_LEAK_UNDER_THE_CHERRY_TREE";
// A distinctive encrypted-payload marker the redaction test proves never leaks.
const SECRET_CIPHERTEXT: &str = "ENCRYPTED_XP3_CIPHERTEXT_BLOB_DO_NOT_LEAK";
// A distinctive member path the redaction test proves never leaks.
const SECRET_MEMBER_PATH: &str = "scenario/true_route_spoiler.ks";

/// Build a plain (encoding-0, uncompressed) XP3 through the authoritative
/// `encode_xp3` writer from `(path, body)` members.
fn build_plain_xp3(members: &[(&str, &[u8])]) -> Vec<u8> {
    let entries: Vec<PlainXp3ArchiveEntry> = members
        .iter()
        .map(|(path, body)| {
            let size = body.len() as u64;
            PlainXp3ArchiveEntry {
                path: (*path).to_string(),
                original_size: size,
                archive_size: size,
                stored_adler32: None,
                segments: vec![PlainXp3ArchiveSegment {
                    flags: 0,
                    original_size: size,
                    archive_size: size,
                }],
                payload: body.to_vec(),
            }
        })
        .collect();
    encode_xp3(&PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries,
    })
    .expect("synthetic plain XP3 encodes")
}

/// A UTF-16LE (BOM) KAG `.ks` body — the real commercial encoding — carrying
/// known tags plus a distinctive story-prose message run.
fn synthetic_ks_body() -> Vec<u8> {
    let script = format!(
        "*start|\n[cm]\n@eval exp=\"f.flag=1\"\n[font size=24]{SECRET_PROSE}[r]\n@jump target=*next\n[[not_a_tag]\n"
    );
    let mut bytes = vec![0xFF, 0xFE];
    for unit in script.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

/// A minimal synthetic private-local XP3 game directory:
/// - one plain archive with two `.ks` scenarios (UTF-16LE KAG bodies), and
/// - one synthetic "encrypted" archive that must never be extracted.
fn stage_synthetic_game(dir: &Path) {
    let ks = synthetic_ks_body();
    let plain = build_plain_xp3(&[
        (SECRET_MEMBER_PATH, ks.as_slice()),
        ("scenario/intro.ks", ks.as_slice()),
        ("image/logo.png", b"\x89PNG not a scenario"),
    ]);
    std::fs::write(dir.join("data.xp3"), &plain).unwrap();

    // Synthetic encrypted container: XP3\r\n marker line + ciphertext blob.
    let mut encrypted = b"XP3\r\nxp3-encrypted\n".to_vec();
    encrypted.extend_from_slice(SECRET_CIPHERTEXT.as_bytes());
    std::fs::write(dir.join("secret.xp3"), &encrypted).unwrap();
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kaifuu-xp3-readiness-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn report_has_exactly_the_six_aggregate_keys() {
    let dir = temp_dir("keys");
    stage_synthetic_game(&dir);
    let report = scan_xp3_readiness_report(&dir).expect("scan");
    let json = report.stable_json().expect("json");
    let value: serde_json::Value = serde_json::from_str(&json).expect("valid json");
    let keys: BTreeSet<String> = value.as_object().expect("object").keys().cloned().collect();
    let expected: BTreeSet<String> = [
        "spec",
        "xp3VariantHistogram",
        "kagTagHistogram",
        "archiveCount",
        "kagScenarioCount",
        "aggregateKagBodyHashSha256",
    ]
    .iter()
    .map(ToString::to_string)
    .collect();
    assert_eq!(keys, expected, "top-level keys must be EXACTLY the six");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn redaction_no_filename_no_body_no_encrypted_material_leaks() {
    let dir = temp_dir("redaction");
    stage_synthetic_game(&dir);
    let report = scan_xp3_readiness_report(&dir).expect("scan");
    let json = report.stable_json().expect("json");

    // NO filename / archive path / member path.
    assert!(!json.contains("data.xp3"), "archive filename must not leak");
    assert!(
        !json.contains("secret.xp3"),
        "archive filename must not leak"
    );
    assert!(
        !json.contains(SECRET_MEMBER_PATH),
        "member path must not leak"
    );
    assert!(!json.contains("scenario/"), "member path must not leak");
    assert!(!json.contains(".ks"), "member filename must not leak");
    // Structural invariant: an aggregate-only report carries no path
    // separator anywhere (the slash-free spec makes this exact).
    assert!(
        !json.contains('/'),
        "no path separator may appear in the report"
    );

    // NO KAG body byte string (message text / attribute values).
    assert!(!json.contains(SECRET_PROSE), "KAG body text must not leak");
    assert!(!json.contains("f.flag=1"), "attribute value must not leak");
    assert!(!json.contains("*next"), "jump target must not leak");

    // NO encrypted-XP3 material.
    assert!(
        !json.contains(SECRET_CIPHERTEXT),
        "encrypted material must not leak"
    );

    // The report DID observe the real structure (histograms/counts only).
    assert_eq!(report.archive_count, 2);
    assert_eq!(report.kag_scenario_count, 2);
    assert_eq!(
        report.xp3_variant_histogram.get("plain_raw_index"),
        Some(&1)
    );
    assert_eq!(report.xp3_variant_histogram.get("encrypted"), Some(&1));
    // KAG tag names present (engine vocabulary), never the escaped `[[`.
    assert_eq!(report.kag_tag_histogram.get("cm"), Some(&2));
    assert_eq!(report.kag_tag_histogram.get("eval"), Some(&2));
    assert_eq!(report.kag_tag_histogram.get("jump"), Some(&2));
    assert_eq!(report.kag_tag_histogram.get("font"), Some(&2));
    assert_eq!(report.kag_tag_histogram.get("r"), Some(&2));
    assert!(
        !report.kag_tag_histogram.contains_key("not_a_tag"),
        "the `[[` escape must not be parsed as a tag"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn scan_is_deterministic_and_hashes_real_bodies() {
    let dir = temp_dir("determinism");
    stage_synthetic_game(&dir);
    let first = scan_xp3_readiness_report(&dir).expect("scan");
    let second = scan_xp3_readiness_report(&dir).expect("scan");
    assert_eq!(first, second, "scan is deterministic");
    assert_eq!(
        first.aggregate_kag_body_hash_sha256.len(),
        64,
        "aggregate hash is a 32-byte sha256 hex digest"
    );
    assert_ne!(
        first.aggregate_kag_body_hash_sha256,
        hex_lower(&Sha256::digest([])),
        "aggregate hash covers real KAG body bytes, not the empty digest"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn empty_directory_renders_valid_empty_report() {
    let dir = temp_dir("empty");
    let report = scan_xp3_readiness_report(&dir).expect("scan");
    assert_eq!(report.archive_count, 0);
    assert_eq!(report.kag_scenario_count, 0);
    assert!(report.kag_tag_histogram.is_empty());
    assert!(report.xp3_variant_histogram.is_empty());
    assert_eq!(report.spec, XP3_READINESS_REPORT_SPEC);
    // Empty aggregate is the empty-input sha256.
    assert_eq!(
        report.aggregate_kag_body_hash_sha256,
        hex_lower(&Sha256::digest([]))
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn missing_directory_errors_without_leaking_the_path() {
    let dir = temp_dir("missing");
    std::fs::remove_dir_all(&dir).ok();
    let secret = dir.join("private-owned-title-name");
    let error = scan_xp3_readiness_report(&secret).expect_err("missing dir errors");
    assert!(!error.to_string().contains("private-owned-title-name"));
}

#[test]
fn classify_covers_plain_and_marker_variants() {
    let plain = build_plain_xp3(&[("scenario/a.ks", b"\xff\xfe")]);
    assert_eq!(classify_xp3_variant(&plain), "plain_raw_index");
    assert_eq!(
        classify_xp3_variant(b"XP3\r\nxp3-encrypted\nblob"),
        "encrypted"
    );
    assert_eq!(
        classify_xp3_variant(b"XP3\r\nxp3-compressed\nblob"),
        "compressed"
    );
    assert_eq!(classify_xp3_variant(b"not an xp3"), "unrecognized");
}

/// Env-gated real-bytes proof. Point `KAIFUU_XP3_READINESS_REAL_GAME_DIR` at
/// a directory of a private-local owned KiriKiri game's `.xp3` archives.
/// SKIPS (does not fail) when the env var is absent, so public CI is green
/// without any private corpus.
#[test]
fn real_private_local_game_readiness_when_present() {
    let Ok(dir) = std::env::var("KAIFUU_XP3_READINESS_REAL_GAME_DIR") else {
        eprintln!("SKIP real_private_local_game_readiness: env var not set");
        return;
    };
    let report = scan_xp3_readiness_report(Path::new(&dir)).expect("real scan");
    let json = report.stable_json().expect("json");
    let value: serde_json::Value = serde_json::from_str(&json).expect("valid json");
    assert_eq!(
        value.as_object().expect("object").len(),
        6,
        "real report is still aggregate-only (exactly six keys)"
    );
    assert!(report.archive_count >= 1, "at least one archive scanned");
    assert!(
        report.kag_scenario_count >= 1,
        "at least one KAG scenario found"
    );
    assert!(
        !report.kag_tag_histogram.is_empty(),
        "real KAG tag histogram populated"
    );
    // The report never carries a filesystem path.
    assert!(!json.contains('/'), "no path separator anywhere in report");
}
