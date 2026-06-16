use std::fs;
use std::path::Path;

use serde_json::{Value, json};

pub type UtsushiResult<T> = Result<T, Box<dyn std::error::Error>>;

pub fn trace_fixture(game_dir: &Path) -> UtsushiResult<Value> {
    let source = read_source(game_dir)?;
    let unit = first_unit(&source)?;
    Ok(json!({
        "schemaVersion": "0.1.0",
        "runtimeTraceId": deterministic_id("runtime-trace", 1),
        "adapterName": "utsushi-fixture",
        "fidelityTier": "trace_only",
        "textEvents": [
            {
                "runtimeTextEventId": deterministic_id("runtime-text", 1),
                "bridgeUnitId": deterministic_id("bridge-unit", 1),
                "text": unit["targetText"].as_str().or_else(|| unit["sourceText"].as_str()).unwrap_or(""),
                "frame": 1
            }
        ],
        "approximations": ["fixture runtime emits deterministic text events without real rendering"]
    }))
}

pub fn capture_fixture(game_dir: &Path) -> UtsushiResult<Value> {
    let _ = read_source(game_dir)?;
    Ok(json!({
        "schemaVersion": "0.1.0",
        "frameCaptureId": deterministic_id("frame", 1),
        "bridgeUnitId": deterministic_id("bridge-unit", 1),
        "width": 320,
        "height": 180,
        "nonZeroPixels": 57600,
        "artifactPath": "fixture://frame/1"
    }))
}

pub fn smoke_fixture(game_dir: &Path) -> UtsushiResult<Value> {
    let trace = trace_fixture(game_dir)?;
    let capture = capture_fixture(game_dir)?;
    Ok(json!({
        "schemaVersion": "0.1.0",
        "runtimeReportId": deterministic_id("runtime-report", 1),
        "adapterName": "utsushi-fixture",
        "fidelityTier": "layout_probe",
        "status": "passed",
        "textEvents": trace["textEvents"].clone(),
        "frameCaptures": [capture],
        "approximations": [
            "fixture runtime validates trace/capture plumbing, not engine fidelity"
        ]
    }))
}

pub fn write_json(path: &Path, value: &Value) -> UtsushiResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}

fn read_source(game_dir: &Path) -> UtsushiResult<Value> {
    Ok(serde_json::from_str(&fs::read_to_string(
        game_dir.join("source.json"),
    )?)?)
}

fn first_unit(source: &Value) -> UtsushiResult<&Value> {
    source["units"]
        .as_array()
        .and_then(|units| units.first())
        .ok_or_else(|| "source has no units".into())
}

fn deterministic_id(kind: &str, index: usize) -> String {
    let mut compact = kind.replace('-', "");
    compact.truncate(8);
    while compact.len() < 8 {
        compact.push('0');
    }
    format!("019ed000-0000-7000-8000-{}{:04}", compact, index)
}
