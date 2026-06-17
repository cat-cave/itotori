use std::fs;
use std::path::Path;

use kaifuu_core::{
    KaifuuResult, content_hash, deterministic_id, read_json, safe_join_relative, write_json,
};
use serde_json::{Value, json};

pub fn create_delta(original_dir: &Path, patched_dir: &Path) -> KaifuuResult<Value> {
    let original_path = original_dir.join("source.json");
    let patched_path = patched_dir.join("source.json");
    let original_text = fs::read_to_string(&original_path)?;
    let patched_text = fs::read_to_string(&patched_path)?;
    Ok(json!({
        "schemaVersion": "0.1.0",
        "deltaPatchId": deterministic_id("delta", 1),
        "format": "kaifuu-fixture-delta",
        "original": {
            "path": "source.json",
            "hash": content_hash(&original_text)
        },
        "changedEntries": [
            {
                "path": "source.json",
                "strategy": "whole_changed_file",
                "content": serde_json::from_str::<Value>(&patched_text)?,
                "patchedHash": content_hash(&patched_text)
            }
        ]
    }))
}

pub fn apply_delta(game_dir: &Path, delta_path: &Path, output_dir: &Path) -> KaifuuResult<Value> {
    let delta: Value = read_json(delta_path)?;
    let original_hash = delta["original"]["hash"]
        .as_str()
        .ok_or("delta missing original hash")?;
    let original_text = fs::read_to_string(game_dir.join("source.json"))?;
    if content_hash(&original_text) != original_hash {
        return Err("original source hash does not match delta package".into());
    }
    let entries = delta["changedEntries"]
        .as_array()
        .ok_or("delta missing changed entries")?;
    if entries.len() != 1 {
        return Err("fixture delta apply requires exactly one changed entry".into());
    }
    let entry = &entries[0];
    let entry_path = entry["path"]
        .as_str()
        .ok_or("delta changed entry missing path")?;
    let content = &entry["content"];
    let output_path = safe_join_relative(output_dir, entry_path)?;
    write_json(&output_path, content)?;
    let patched_text = fs::read_to_string(&output_path)?;
    Ok(json!({
        "schemaVersion": "0.1.0",
        "patchResultId": deterministic_id("delta-apply", 1),
        "status": "passed",
        "outputHash": content_hash(&patched_text),
        "failures": []
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "kaifuu-delta-{name}-{}-{nonce}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_original_source(game_dir: &Path) -> String {
        fs::create_dir_all(game_dir).unwrap();
        let source_text = "{\n  \"units\": []\n}\n".to_string();
        fs::write(game_dir.join("source.json"), &source_text).unwrap();
        source_text
    }

    #[test]
    fn apply_delta_rejects_traversal_path_without_writing_output() {
        let root = temp_dir("traversal-path");
        let game_dir = root.join("game");
        let output_dir = root.join("patched");
        let original_text = write_original_source(&game_dir);
        let delta_path = root.join("unsafe.kaifuu");
        write_json(
            &delta_path,
            &json!({
                "schemaVersion": "0.1.0",
                "deltaPatchId": deterministic_id("delta", 1),
                "format": "kaifuu-fixture-delta",
                "original": {
                    "path": "source.json",
                    "hash": content_hash(&original_text)
                },
                "changedEntries": [
                    {
                        "path": "../escaped.json",
                        "strategy": "whole_changed_file",
                        "content": { "units": [] },
                        "patchedHash": "ignored"
                    }
                ]
            }),
        )
        .unwrap();

        let error = apply_delta(&game_dir, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("unsafe relative output path"));
        assert!(!root.join("escaped.json").exists());
        assert!(!output_dir.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_windows_drive_relative_path_without_writing_output() {
        for (index, unsafe_path) in [
            "C:source.json",
            "c:source.json",
            "data/C:source.json",
            "data\\C:source.json",
        ]
        .iter()
        .enumerate()
        {
            let root = temp_dir(&format!("drive-relative-path-{index}"));
            let game_dir = root.join("game");
            let output_dir = root.join("patched");
            let original_text = write_original_source(&game_dir);
            let delta_path = root.join("unsafe.kaifuu");
            write_json(
                &delta_path,
                &json!({
                    "schemaVersion": "0.1.0",
                    "deltaPatchId": deterministic_id("delta", 1),
                    "format": "kaifuu-fixture-delta",
                    "original": {
                        "path": "source.json",
                        "hash": content_hash(&original_text)
                    },
                    "changedEntries": [
                        {
                            "path": unsafe_path,
                            "strategy": "whole_changed_file",
                            "content": { "units": [] },
                            "patchedHash": "ignored"
                        }
                    ]
                }),
            )
            .unwrap();

            let error = apply_delta(&game_dir, &delta_path, &output_dir)
                .unwrap_err()
                .to_string();

            assert!(error.contains("unsafe relative output path"));
            assert!(!output_dir.exists());
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn apply_delta_rejects_partial_multi_entry_delta_without_writing_output() {
        let root = temp_dir("partial-multi-entry");
        let game_dir = root.join("game");
        let output_dir = root.join("patched");
        let original_text = write_original_source(&game_dir);
        let delta_path = root.join("partial.kaifuu");
        write_json(
            &delta_path,
            &json!({
                "schemaVersion": "0.1.0",
                "deltaPatchId": deterministic_id("delta", 1),
                "format": "kaifuu-fixture-delta",
                "original": {
                    "path": "source.json",
                    "hash": content_hash(&original_text)
                },
                "changedEntries": [
                    {
                        "path": "source.json",
                        "strategy": "whole_changed_file",
                        "content": { "units": [] },
                        "patchedHash": "ignored"
                    },
                    {
                        "path": "extra.json",
                        "strategy": "whole_changed_file",
                        "content": { "units": [] },
                        "patchedHash": "ignored"
                    }
                ]
            }),
        )
        .unwrap();

        let error = apply_delta(&game_dir, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("exactly one changed entry"));
        assert!(!output_dir.join("source.json").exists());
        assert!(!output_dir.join("extra.json").exists());
        let _ = fs::remove_dir_all(root);
    }
}
