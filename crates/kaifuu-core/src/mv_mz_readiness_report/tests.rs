use super::*;
use std::collections::BTreeSet;
use std::time::{SystemTime, UNIX_EPOCH};

const SECRET_KEY: &str = "deadbeefcafebabe0123456789abcdef";
const SECRET_DIALOGUE: &str = "SECRET_MAP_DIALOGUE_DO_NOT_LEAK_UNDER_THE_CHERRY_TREE";
const SECRET_FILENAME: &str = "SecretOwnedTitleBanner";

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kaifuu-mvmz-readiness-{tag}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Stage a synthetic private-local MV/MZ `www/` tree with a distinctive
/// key, dialogue line, and asset basename that redaction must never leak.
fn stage_synthetic_game(dir: &Path, with_key: bool) {
    let data = dir.join("data");
    let img = dir.join("img").join("pictures");
    let audio = dir.join("audio").join("bgm");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&img).unwrap();
    std::fs::create_dir_all(&audio).unwrap();

    let system = if with_key {
        serde_json::json!({
            "gameTitle": "SyntheticPrivateTitle",
            "encryptionKey": SECRET_KEY,
            "hasEncryptedImages": true,
            "hasEncryptedAudio": true
        })
    } else {
        serde_json::json!({
            "gameTitle": "SyntheticPrivateTitle",
            "hasEncryptedImages": true,
            "hasEncryptedAudio": true
        })
    };
    std::fs::write(
        data.join("System.json"),
        serde_json::to_vec_pretty(&system).unwrap(),
    )
    .unwrap();

    let map = serde_json::json!({
        "id": 1,
        "events": [
            null,
            {
                "id": 1,
                "pages": [{
                    "list": [
                        { "code": 101, "parameters": ["", 0, 0, 2] },
                        { "code": 401, "parameters": [SECRET_DIALOGUE] },
                        { "code": 102, "parameters": [["Yes", "No"], 1, 0, 2, 0] },
                        { "code": 402, "parameters": [0, "Yes"] },
                        { "code": 0, "parameters": [] }
                    ]
                }]
            }
        ]
    });
    std::fs::write(data.join("Map001.json"), serde_json::to_vec(&map).unwrap()).unwrap();
    std::fs::write(
        data.join("MapInfos.json"),
        b"[null,{\"id\":1,\"name\":\"Town\"}]",
    )
    .unwrap();

    // Distinctive basenames + encrypted suffixes.
    std::fs::write(
        img.join(format!("{SECRET_FILENAME}.rpgmvp")),
        b"RPGMV\0fake",
    )
    .unwrap();
    std::fs::write(audio.join("BattleThemeSecret.rpgmvo"), b"RPGMV\0fake").unwrap();
    std::fs::write(dir.join("index.html"), b"<html></html>").unwrap();
}

#[test]
fn report_has_exactly_the_six_aggregate_keys() {
    let dir = temp_dir("keys");
    stage_synthetic_game(&dir, true);
    let report = scan_mv_mz_readiness_report(&dir).expect("scan");
    let json = report.stable_json().expect("json");
    let value: serde_json::Value = serde_json::from_str(&json).expect("valid json");
    let keys: BTreeSet<String> = value.as_object().expect("object").keys().cloned().collect();
    let expected: BTreeSet<String> = [
        "spec",
        "assetSuffixHistogram",
        "systemJsonHasEncryptionKey",
        "mapTextSurfaceCounts",
        "helperRequirements",
        "aggregateDataHashSha256",
    ]
    .iter()
    .map(ToString::to_string)
    .collect();
    assert_eq!(keys, expected, "top-level keys must be EXACTLY the six");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn encryption_key_is_boolean_only_and_key_bytes_never_leak() {
    let dir = temp_dir("key-bool");
    stage_synthetic_game(&dir, true);
    let report = scan_mv_mz_readiness_report(&dir).expect("scan");
    let json = report.stable_json().expect("json");
    assert!(report.system_json_has_encryption_key);
    assert!(
        !json.contains(SECRET_KEY),
        "encryptionKey bytes must not leak"
    );
    assert!(!json.contains("deadbeef"), "key hex prefix must not leak");
    assert_eq!(report.helper_requirements, vec![HELPER_NONE.to_string()]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn missing_key_with_encrypted_media_requires_helper() {
    let dir = temp_dir("key-missing");
    stage_synthetic_game(&dir, false);
    let report = scan_mv_mz_readiness_report(&dir).expect("scan");
    assert!(!report.system_json_has_encryption_key);
    assert_eq!(
        report.helper_requirements,
        vec![HELPER_ASSET_ENCRYPTION_KEY.to_string()]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn redaction_no_filename_no_path_no_dialogue() {
    let dir = temp_dir("redaction");
    stage_synthetic_game(&dir, true);
    let report = scan_mv_mz_readiness_report(&dir).expect("scan");
    let json = report.stable_json().expect("json");

    assert!(
        !json.contains(SECRET_FILENAME),
        "asset basename must not leak"
    );
    assert!(!json.contains("Map001"), "map filename must not leak");
    assert!(
        !json.contains("System.json"),
        "system filename must not leak"
    );
    assert!(
        !json.contains("BattleThemeSecret"),
        "audio basename must not leak"
    );
    assert!(
        !json.contains(SECRET_DIALOGUE),
        "dialogue text must not leak"
    );
    assert!(!json.contains(SECRET_KEY), "key bytes must not leak");
    assert!(
        !json.contains('/'),
        "no path separator may appear in the report"
    );

    // Observed structure only.
    assert!(
        report
            .asset_suffix_histogram
            .get("rpgmvp")
            .copied()
            .unwrap_or(0)
            >= 1
    );
    assert!(
        report
            .asset_suffix_histogram
            .get("json")
            .copied()
            .unwrap_or(0)
            >= 2
    );
    assert_eq!(report.map_text_surface_counts.get("show_text"), Some(&1));
    assert_eq!(
        report.map_text_surface_counts.get("choice_option"),
        Some(&2)
    );
    assert_eq!(
        report.map_text_surface_counts.get("choice_branch"),
        Some(&1)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn scan_is_deterministic() {
    let dir = temp_dir("determinism");
    stage_synthetic_game(&dir, true);
    let first = scan_mv_mz_readiness_report(&dir).expect("scan");
    let second = scan_mv_mz_readiness_report(&dir).expect("scan");
    assert_eq!(first, second);
    assert_eq!(first.aggregate_data_hash_sha256.len(), 64);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn missing_directory_errors_without_leaking_the_path() {
    let dir = temp_dir("missing");
    let _ = std::fs::remove_dir_all(&dir);
    let secret = dir.join("private-owned-title-name");
    let error = scan_mv_mz_readiness_report(&secret).expect_err("missing dir errors");
    assert!(!error.to_string().contains("private-owned-title-name"));
}

#[test]
fn www_nested_layout_resolves() {
    let root = temp_dir("www-nested");
    let www = root.join("www");
    stage_synthetic_game(&www, true);
    let report = scan_mv_mz_readiness_report(&root).expect("scan via project root");
    assert!(report.system_json_has_encryption_key);
    assert_eq!(report.map_text_surface_counts.get("show_text"), Some(&1));
    let _ = std::fs::remove_dir_all(&root);
}
