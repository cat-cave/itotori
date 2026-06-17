use std::fs;
use std::path::Path;

use serde_json::{Value, json};

pub type UtsushiResult<T> = Result<T, Box<dyn std::error::Error>>;

pub fn trace_fixture(game_dir: &Path) -> UtsushiResult<Value> {
    let source = read_source(game_dir)?;
    let unit = first_unit(&source)?;
    Ok(runtime_report(
        &source,
        vec![trace_event(unit, 1)?],
        vec![],
        "trace_only",
        "E1",
        "Runtime trace reached fixture text; no frame was captured.",
    ))
}

pub fn capture_fixture(game_dir: &Path) -> UtsushiResult<Value> {
    let source = read_source(game_dir)?;
    let unit = first_unit(&source)?;
    Ok(runtime_report(
        &source,
        vec![trace_event(unit, 1)?],
        vec![capture_event(unit, 1)?],
        "layout_probe",
        "E2",
        "Fixture capture produced a screenshot reference; no pixel comparison was performed.",
    ))
}

pub fn smoke_fixture(game_dir: &Path) -> UtsushiResult<Value> {
    capture_fixture(game_dir)
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

fn runtime_report(
    source: &Value,
    trace_events: Vec<Value>,
    captures: Vec<Value>,
    fidelity_tier: &str,
    evidence_tier: &str,
    limitation: &str,
) -> Value {
    let affected_bridge_unit_refs = trace_events
        .iter()
        .filter_map(|event| event.get("bridgeUnitRef").cloned())
        .collect::<Vec<_>>();
    json!({
        "schemaVersion": "0.2.0",
        "runtimeReportId": deterministic_uuid("runtime-report", 1),
        "sourceLocale": source["sourceLocale"].as_str().unwrap_or("und"),
        "adapterName": "utsushi-fixture",
        "adapterVersion": env!("CARGO_PKG_VERSION"),
        "fidelityTier": fidelity_tier,
        "evidenceTier": evidence_tier,
        "status": "passed",
        "createdAt": "2026-06-17T00:00:00.000Z",
        "traceEvents": trace_events,
        "branchEvents": [],
        "captures": captures,
        "recordings": [],
        "approximations": [
            {
                "approximationId": deterministic_uuid("approximation", 1),
                "approximationTier": "deterministic_fixture",
                "scope": "fixture runtime",
                "description": "Fixture runtime emits deterministic trace and capture evidence without reference-runtime pixel comparison.",
                "affectedBridgeUnitRefs": affected_bridge_unit_refs,
                "evidenceTierCeiling": evidence_tier
            }
        ],
        "validationFindings": [],
        "limitations": [limitation]
    })
}

fn trace_event(unit: &Value, frame: usize) -> UtsushiResult<Value> {
    Ok(json!({
        "traceEventId": deterministic_uuid("runtime-trace", frame),
        "eventKind": "text_observed",
        "bridgeUnitRef": bridge_unit_ref(unit, 1)?,
        "frame": frame,
        "traceKey": require_str(unit, "sourceUnitKey")?,
        "observedText": unit["targetText"]
            .as_str()
            .or_else(|| unit["sourceText"].as_str())
            .unwrap_or("")
    }))
}

fn capture_event(unit: &Value, frame: usize) -> UtsushiResult<Value> {
    Ok(json!({
        "captureId": deterministic_uuid("capture", frame),
        "bridgeUnitRef": bridge_unit_ref(unit, 1)?,
        "evidenceTier": "E2",
        "frame": frame,
        "width": 320,
        "height": 180,
        "nonZeroPixels": 57600,
        "artifactRef": {
            "artifactId": deterministic_uuid("screenshot", frame),
            "artifactKind": "screenshot",
            "uri": format!("artifacts/utsushi/hello/frame-{frame:04}.png"),
            "mediaType": "image/png"
        }
    }))
}

fn bridge_unit_ref(unit: &Value, index: usize) -> UtsushiResult<Value> {
    Ok(json!({
        "bridgeUnitId": legacy_fixture_id("bridge-unit", index),
        "sourceUnitKey": require_str(unit, "sourceUnitKey")?
    }))
}

fn require_str<'a>(value: &'a Value, key: &str) -> UtsushiResult<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("fixture source unit missing {key}").into())
}

fn legacy_fixture_id(kind: &str, index: usize) -> String {
    let mut compact = kind.replace('-', "");
    compact.truncate(8);
    while compact.len() < 8 {
        compact.push('0');
    }
    format!("019ed000-0000-7000-8000-{}{:04}", compact, index)
}

fn deterministic_uuid(kind: &str, index: usize) -> String {
    let kind_code = match kind {
        "runtime-report" => 0x1000,
        "runtime-trace" => 0x2000,
        "capture" => 0x3000,
        "screenshot" => 0x4000,
        "approximation" => 0x5000,
        _ => 0xf000,
    };
    format!("019ed003-0000-7000-8000-{kind_code:08x}{index:04x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_game(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "utsushi-core-{name}-{}-{nonce}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("source.json"),
            r#"{
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "こんにちは、{player}。",
      "targetText": "Hello, {player}.",
      "protectedSpans": []
    }
  ]
}
"#,
        )
        .unwrap();
        dir
    }

    #[test]
    fn smoke_fixture_serializes_v02_referenced_capture_evidence() {
        let game_dir = temp_game("smoke");
        let report = smoke_fixture(&game_dir).unwrap();

        assert_eq!(report["schemaVersion"], "0.2.0");
        assert_eq!(report["evidenceTier"], "E2");
        assert_eq!(report["fidelityTier"], "layout_probe");
        assert_eq!(report["traceEvents"].as_array().unwrap().len(), 1);
        assert_eq!(report["captures"].as_array().unwrap().len(), 1);
        assert_eq!(
            report["captures"][0]["artifactRef"]["uri"],
            "artifacts/utsushi/hello/frame-0001.png"
        );
        assert!(report["captures"][0].get("bytes").is_none());
        assert!(report["captures"][0].get("data").is_none());
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn trace_fixture_serializes_e1_without_capture_claims() {
        let game_dir = temp_game("trace");
        let report = trace_fixture(&game_dir).unwrap();

        assert_eq!(report["schemaVersion"], "0.2.0");
        assert_eq!(report["evidenceTier"], "E1");
        assert_eq!(report["fidelityTier"], "trace_only");
        assert_eq!(report["captures"].as_array().unwrap().len(), 0);
        let _ = fs::remove_dir_all(game_dir);
    }
}
