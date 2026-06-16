use std::fs;
use std::path::Path;

use serde_json::{Value, json};

pub type KaifuuResult<T> = Result<T, Box<dyn std::error::Error>>;

pub fn extract_fixture(game_dir: &Path) -> KaifuuResult<Value> {
    let source_path = game_dir.join("source.json");
    let source_text = fs::read_to_string(&source_path)?;
    let source: Value = serde_json::from_str(&source_text)?;
    let units = source["units"]
        .as_array()
        .ok_or("fixture source missing units")?;
    let source_locale = source["sourceLocale"].as_str().unwrap_or("ja-JP");
    let bridge_units = units
        .iter()
        .enumerate()
        .map(|(index, unit)| {
            let source_unit_key = require_str(unit, "sourceUnitKey")?;
            let text = require_str(unit, "sourceText")?;
            let protected_spans = unit["protectedSpans"]
                .as_array()
                .unwrap_or(&Vec::new())
                .iter()
                .map(|span| {
                    Ok(json!({
                        "kind": require_str(span, "kind")?,
                        "raw": require_str(span, "raw")?,
                        "start": require_u64(span, "start")?,
                        "end": require_u64(span, "end")?,
                        "preserveMode": "exact"
                    }))
                })
                .collect::<KaifuuResult<Vec<_>>>()?;
            Ok(json!({
                "bridgeUnitId": deterministic_id("bridge-unit", index + 1),
                "sourceUnitKey": source_unit_key,
                "occurrenceId": format!("occurrence-{}", index + 1),
                "sourceHash": content_hash(text),
                "sourceLocale": source_locale,
                "sourceText": text,
                "speaker": unit["speaker"].as_str().unwrap_or(""),
                "textSurface": unit["textSurface"].as_str().unwrap_or("dialogue"),
                "protectedSpans": protected_spans,
                "patchRef": {
                    "assetId": "source.json",
                    "writeMode": "replace",
                    "sourceUnitKey": source_unit_key
                }
            }))
        })
        .collect::<KaifuuResult<Vec<_>>>()?;
    Ok(json!({
        "schemaVersion": "0.1.0",
        "bridgeId": deterministic_id("bridge", 1),
        "sourceBundleHash": content_hash(&source_text),
        "sourceLocale": source_locale,
        "extractorName": "kaifuu-fixture",
        "extractorVersion": env!("CARGO_PKG_VERSION"),
        "units": bridge_units
    }))
}

pub fn patch_fixture(
    game_dir: &Path,
    patch_export: &Value,
    output_dir: &Path,
) -> KaifuuResult<Value> {
    let source_path = game_dir.join("source.json");
    let mut source: Value = serde_json::from_str(&fs::read_to_string(&source_path)?)?;
    let entries = patch_export["entries"]
        .as_array()
        .ok_or("patch export missing entries")?;
    let units = source["units"]
        .as_array_mut()
        .ok_or("fixture source missing units")?;
    for unit in units {
        let key = require_str(unit, "sourceUnitKey")?;
        if let Some(entry) = entries
            .iter()
            .find(|entry| entry["sourceUnitKey"].as_str() == Some(key))
        {
            let target = require_str(entry, "targetText")?;
            unit["targetText"] = json!(target);
        }
    }
    fs::create_dir_all(output_dir)?;
    let output_path = output_dir.join("source.json");
    let patched_text = format!("{}\n", serde_json::to_string_pretty(&source)?);
    fs::write(&output_path, &patched_text)?;
    Ok(json!({
        "schemaVersion": "0.1.0",
        "patchResultId": deterministic_id("patch-result", 1),
        "patchExportId": patch_export["patchExportId"].as_str().unwrap_or(""),
        "status": "passed",
        "outputHash": content_hash(&patched_text),
        "failures": []
    }))
}

pub fn verify_fixture(game_dir: &Path) -> KaifuuResult<Value> {
    let source_path = game_dir.join("source.json");
    let source_text = fs::read_to_string(&source_path)?;
    let source: Value = serde_json::from_str(&source_text)?;
    let status = if source["units"].is_array() {
        "passed"
    } else {
        "failed"
    };
    Ok(json!({
        "schemaVersion": "0.1.0",
        "patchResultId": deterministic_id("verify", 1),
        "status": status,
        "outputHash": content_hash(&source_text),
        "failures": []
    }))
}

pub fn deterministic_id(kind: &str, index: usize) -> String {
    let mut compact = kind.replace('-', "");
    compact.truncate(8);
    while compact.len() < 8 {
        compact.push('0');
    }
    format!("019ed000-0000-7000-8000-{}{:04}", compact, index)
}

pub fn content_hash(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub fn write_json(path: &Path, value: &Value) -> KaifuuResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}

pub fn read_json(path: &Path) -> KaifuuResult<Value> {
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

fn require_str<'a>(value: &'a Value, key: &str) -> KaifuuResult<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("missing string field {key}").into())
}

fn require_u64(value: &Value, key: &str) -> KaifuuResult<u64> {
    value[key]
        .as_u64()
        .ok_or_else(|| format!("missing u64 field {key}").into())
}
