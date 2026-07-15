//! BGI/Ethornell loose-bytecode adapter integration tests.
//! The byte inputs come from the committed BGI parser fixture
//! `fixtures/kaifuu/bgi/bytecode.profiles.json`; the test materializes those
//! bytes into temp game directories and drives the real `kaifuu-cli`
//! detect/extract/patch/verify commands.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use kaifuu_core::{
    BridgeBundle, EngineAdapter, OperationStatus, PatchExport, PatchExportEntry,
    PatchPreflightRequest, read_json,
};
use serde_json::Value;

fn kaifuu_cli_binary() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"));
    assert!(
        path.exists(),
        "kaifuu-cli binary must exist at {}",
        path.display()
    );
    path
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn fixture_entries() -> Vec<Value> {
    let path = repo_root().join("fixtures/kaifuu/bgi/bytecode.profiles.json");
    let value: Value = read_json(&path).expect("BGI fixture JSON parses");
    value["entries"].as_array().expect("entries array").clone()
}

fn decode_hex(hex: &str) -> Vec<u8> {
    let hex = hex.trim();
    assert!(hex.len().is_multiple_of(2), "hex fixture has even length");
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex byte"))
        .collect()
}

fn write_game(entry: &Value, scenario_name: &str) -> tempfile::TempDir {
    write_multi_asset_game(&[(entry, scenario_name)])
}

fn write_multi_asset_game(scripts: &[(&Value, &str)]) -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("bgi-bytecode")
        .tempdir()
        .expect("tempdir");
    fs::create_dir_all(dir.path().join("scenario")).expect("scenario dir");
    for (entry, scenario_name) in scripts {
        let bytes = decode_hex(
            entry["sourceBytesHex"]
                .as_str()
                .expect("sourceBytesHex string"),
        );
        fs::write(dir.path().join("scenario").join(scenario_name), bytes).expect("scenario write");
    }
    dir
}

fn run_cli(args: &[&str]) -> std::process::Output {
    Command::new(kaifuu_cli_binary())
        .args(args)
        .output()
        .expect("kaifuu-cli must run")
}

fn assert_success(output: &std::process::Output, command: &str) {
    assert!(
        output.status.success(),
        "{command} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn translated_patch_export(bridge: &BridgeBundle, patch_export_id: &str) -> PatchExport {
    PatchExport {
        patch_export_id: patch_export_id.to_string(),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: bridge
            .units
            .iter()
            .map(|unit| PatchExportEntry {
                bridge_unit_id: unit.bridge_unit_id.clone(),
                source_unit_key: unit.source_unit_key.clone(),
                source_hash: unit.source_hash.clone(),
                target_text: format!("{} 長い", unit.source_text),
                protected_span_mappings: vec![],
            })
            .collect(),
    }
}

#[test]
fn bgi_cli_round_trips_header_and_no_header_with_offset_rewrites() {
    for entry in fixture_entries() {
        let fixture_id = entry["fixtureId"].as_str().expect("fixture id");
        let scenario_name = if fixture_id.ends_with("header") {
            "0100.bgi"
        } else {
            "0101"
        };
        let game = write_game(&entry, scenario_name);
        let out = tempfile::Builder::new()
            .prefix("bgi-cli-out")
            .tempdir()
            .expect("tempdir");

        let detect_path = out.path().join("detect.json");
        let detect = run_cli(&[
            "detect",
            game.path().to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ]);
        assert_success(&detect, "detect");
        let detect_json: Value = read_json(&detect_path).expect("detect json");
        let bgi = detect_json["detections"]
            .as_array()
            .expect("detections")
            .iter()
            .find(|row| row["adapterId"] == "kaifuu.bgi")
            .expect("BGI adapter detection row");
        assert_eq!(bgi["detected"], true, "{fixture_id}");
        assert_eq!(bgi["engineFamily"], "bgi", "{fixture_id}");

        let bridge_path = out.path().join("bridge.json");
        let extract = run_cli(&[
            "extract",
            game.path().to_str().unwrap(),
            "--output",
            bridge_path.to_str().unwrap(),
        ]);
        assert_success(&extract, "extract");
        let bridge: BridgeBundle = read_json(&bridge_path).expect("bridge bundle");
        assert!(
            !bridge.units.is_empty(),
            "{fixture_id} extracts bridge units"
        );

        let patch = translated_patch_export(&bridge, &format!("bgi-patch-{fixture_id}"));
        let patch_path = out.path().join("patch.json");
        fs::write(
            &patch_path,
            serde_json::to_string_pretty(&patch).expect("patch json"),
        )
        .expect("write patch");
        let patched_dir = out.path().join("patched");
        let patch_output = run_cli(&[
            "patch",
            game.path().to_str().unwrap(),
            "--patch",
            patch_path.to_str().unwrap(),
            "--output",
            patched_dir.to_str().unwrap(),
        ]);
        assert_success(&patch_output, "patch");

        let patched_bytes =
            fs::read(patched_dir.join("scenario").join(scenario_name)).expect("patched scenario");
        let (_variant, reparsed) =
            kaifuu_core::parse_bgi_bytecode_bytes(&patched_bytes).expect("patched reparses");
        for unit in &bridge.units {
            let reference_id = unit
                .source_unit_key
                .rsplit_once('#')
                .expect("source key has reference")
                .1;
            let reference = reparsed
                .iter()
                .find(|reference| reference.reference_id == reference_id)
                .expect("patched reference survives");
            assert_eq!(
                reference.decoded_text,
                format!("{} 長い", unit.source_text),
                "{fixture_id}"
            );
        }

        let verify_path = out.path().join("verify.json");
        let verify = run_cli(&[
            "verify",
            patched_dir.to_str().unwrap(),
            "--output",
            verify_path.to_str().unwrap(),
        ]);
        assert_success(&verify, "verify");
        let verify_json: kaifuu_core::VerificationResult =
            read_json(&verify_path).expect("verify result");
        assert_eq!(verify_json.status, OperationStatus::Passed, "{fixture_id}");
    }
}

#[test]
fn bgi_cli_patch_preflight_accepts_units_from_multiple_script_assets() {
    let entries = fixture_entries();
    let header = entries
        .iter()
        .find(|entry| entry["fixtureId"] == "bgi.bytecode.header")
        .expect("header fixture");
    let no_header = entries
        .iter()
        .find(|entry| entry["fixtureId"] == "bgi.bytecode.no-header")
        .expect("no-header fixture");
    let game = write_multi_asset_game(&[(header, "0100.bgi"), (no_header, "0101")]);
    let out = tempfile::Builder::new()
        .prefix("bgi-cli-multi-asset-out")
        .tempdir()
        .expect("tempdir");

    let bridge_path = out.path().join("bridge.json");
    let extract = run_cli(&[
        "extract",
        game.path().to_str().unwrap(),
        "--output",
        bridge_path.to_str().unwrap(),
    ]);
    assert_success(&extract, "extract");
    let bridge: BridgeBundle = read_json(&bridge_path).expect("bridge bundle");
    assert!(
        bridge
            .units
            .iter()
            .any(|unit| unit.source_unit_key.starts_with("scenario/0100.bgi#")),
        "header asset units are present"
    );
    assert!(
        bridge
            .units
            .iter()
            .any(|unit| unit.source_unit_key.starts_with("scenario/0101#")),
        "second asset units are present"
    );

    let patch = translated_patch_export(&bridge, "bgi-patch-multi-asset");
    let adapter = kaifuu_engine_fixture::BgiBytecodeAdapter;
    let preflight = adapter
        .patch_preflight(PatchPreflightRequest {
            game_dir: game.path(),
            patch_export: &patch,
        })
        .expect("preflight runs");
    assert_eq!(preflight.status, OperationStatus::Passed);

    let patch_path = out.path().join("patch.json");
    fs::write(
        &patch_path,
        serde_json::to_string_pretty(&patch).expect("patch json"),
    )
    .expect("write patch");
    let patched_dir = out.path().join("patched");
    let patch_output = run_cli(&[
        "patch",
        game.path().to_str().unwrap(),
        "--patch",
        patch_path.to_str().unwrap(),
        "--output",
        patched_dir.to_str().unwrap(),
    ]);
    assert_success(&patch_output, "patch");

    for scenario_name in ["0100.bgi", "0101"] {
        let patched_bytes =
            fs::read(patched_dir.join("scenario").join(scenario_name)).expect("patched scenario");
        let (_variant, reparsed) =
            kaifuu_core::parse_bgi_bytecode_bytes(&patched_bytes).expect("patched reparses");
        let source_prefix = format!("scenario/{scenario_name}#");
        for unit in bridge
            .units
            .iter()
            .filter(|unit| unit.source_unit_key.starts_with(&source_prefix))
        {
            let reference_id = unit
                .source_unit_key
                .rsplit_once('#')
                .expect("source key has reference")
                .1;
            let reference = reparsed
                .iter()
                .find(|reference| reference.reference_id == reference_id)
                .expect("patched reference survives");
            assert_eq!(reference.decoded_text, format!("{} 長い", unit.source_text));
        }
    }
}

#[test]
fn bgi_cli_does_not_detect_false_positive_reference_words() {
    let entry = fixture_entries()
        .into_iter()
        .find(|entry| entry["fixtureId"] == "bgi.bytecode.no-header")
        .expect("no-header fixture");
    let negative = entry["negativeCases"]
        .as_array()
        .expect("negative cases")
        .iter()
        .find(|case| case["caseId"] == "bgi.no_header.false-positive-code-pointer")
        .expect("false-positive case");
    let dir = tempfile::Builder::new()
        .prefix("bgi-false-positive")
        .tempdir()
        .expect("tempdir");
    fs::write(
        dir.path().join("0001"),
        decode_hex(
            negative["sourceBytesHex"]
                .as_str()
                .expect("negative source hex"),
        ),
    )
    .expect("write false-positive bytes");

    let out = tempfile::Builder::new()
        .prefix("bgi-false-positive-out")
        .tempdir()
        .expect("tempdir");
    let detect_path = out.path().join("detect.json");
    let detect = run_cli(&[
        "detect",
        dir.path().to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);
    assert_success(&detect, "detect");
    let detect_json: Value = read_json(&detect_path).expect("detect json");
    let bgi = detect_json["detections"]
        .as_array()
        .expect("detections")
        .iter()
        .find(|row| row["adapterId"] == "kaifuu.bgi")
        .expect("BGI adapter detection row");
    assert_eq!(bgi["detected"], false);
    assert_eq!(
        bgi["evidence"][0]["detail"],
        "no loose BGI/Ethornell header or no-header bytecode file parsed"
    );
}
