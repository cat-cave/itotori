use std::fs;
use std::path::Path;

use kaifuu_core::{KaifuuResult, content_hash, deterministic_id, read_json, write_json};
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
    fs::create_dir_all(output_dir)?;
    let entry = delta["changedEntries"]
        .as_array()
        .and_then(|entries| entries.first())
        .ok_or("delta missing changed entry")?;
    let content = &entry["content"];
    let output_path = output_dir.join("source.json");
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
