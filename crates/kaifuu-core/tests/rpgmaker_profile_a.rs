//! Read-only proof for the external RPG Maker MV/MZ profile-A metadata intake.
//!
//! The committed fixture is deliberately metadata-only: this test re-reads the
//! supplied source bytes and proves every declared hash, count, and structural
//! JSON-pointer sample. It never serializes source text or copies a game file.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

const SOURCE_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ";
const DEFAULT_SOURCE_ROOT: &str = "/scratch/itotori-research/rpg-maker-mv-mz/extracted/LustMemory";
const SPDX_ID: &str = "LicenseRef-LustMemory-English-Public-Release";
const MANIFEST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/public/kaifuu-rpgmaker-mv-mz-profile-a.manifest.json"
));

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ExtractionCounts {
    show_text: usize,
    show_choices: usize,
    common_event_commands: usize,
    system_terms_fields: usize,
}

#[test]
fn profile_a_metadata_matches_the_supplied_read_only_game_bytes() {
    let manifest: Value = serde_json::from_str(MANIFEST).expect("profile-A manifest parses");
    assert_eq!(
        manifest["SPDX-License-Identifier"].as_str(),
        Some(SPDX_ID),
        "the task-authorized SPDX LicenseRef is preserved verbatim"
    );
    assert_eq!(
        manifest["fixture"]["license"]["spdx"].as_str(),
        Some(SPDX_ID),
        "fixture license repeats the SPDX identifier"
    );
    assert_eq!(
        manifest["fixture"]["provenance"]["sourcePath"].as_str(),
        Some("LustMemory/www/data"),
        "the manifest records only a corpus-relative source path"
    );

    let data_dir = source_data_dir();
    let observed_files = source_file_bytes(&data_dir);
    let manifest_files = manifest["sourceFiles"]
        .as_array()
        .expect("profile-A sourceFiles array");
    assert_eq!(
        manifest_files.len(),
        observed_files.len(),
        "every source data JSON has exactly one metadata hash row"
    );

    for (index, (name, bytes)) in observed_files.iter().enumerate() {
        let row = &manifest_files[index];
        assert_eq!(
            row["path"].as_str(),
            Some(format!("www/data/{name}").as_str()),
            "metadata rows are bytewise filename-sorted and corpus-relative"
        );
        assert_eq!(
            row["bytes"].as_u64(),
            Some(bytes.len() as u64),
            "metadata byte count matches the supplied source"
        );
        assert_eq!(
            row["sha256"].as_str(),
            Some(sha256(bytes).as_str()),
            "metadata SHA-256 matches the supplied source"
        );
    }

    let observed = observe_extraction_surfaces(&data_dir, &observed_files);
    let declared = &manifest["extractionSurfaces"];
    assert_eq!(
        declared["showText"].as_u64(),
        Some(observed.show_text as u64)
    );
    assert_eq!(
        declared["showChoices"].as_u64(),
        Some(observed.show_choices as u64)
    );
    assert_eq!(
        declared["commonEventCommands"].as_u64(),
        Some(observed.common_event_commands as u64)
    );
    assert_eq!(
        declared["systemTermsFields"].as_u64(),
        Some(observed.system_terms_fields as u64)
    );
    assert!(
        observed.show_text >= 5,
        "profile A requires five Show Text surfaces"
    );
    assert!(
        observed.show_choices >= 1,
        "profile A requires one Show Choices surface"
    );

    assert_command_samples(&data_dir, declared, "showText", 401, |target| {
        target.as_str().is_some_and(|text| !text.is_empty())
    });
    assert_command_samples(&data_dir, declared, "showChoices", 102, Value::is_array);
    assert_common_event_samples(&data_dir, declared);
    assert_system_terms_samples(&data_dir, declared);

    let aggregate = &manifest["aggregateStats"];
    assert_eq!(
        aggregate["sourceFiles"].as_u64(),
        Some(observed_files.len() as u64),
        "aggregate source file count matches the hash rows"
    );
    assert_eq!(
        aggregate["mapFiles"].as_u64(),
        Some(
            observed_files
                .keys()
                .filter(|name| is_map_file(name))
                .count() as u64
        ),
        "aggregate map count matches the source tree"
    );

    let rerun = observe_extraction_surfaces(&data_dir, &observed_files);
    assert_eq!(
        observed, rerun,
        "the real-byte surface census is deterministic"
    );
}

fn source_data_dir() -> PathBuf {
    let root = env::var_os(SOURCE_ROOT_ENV)
        .map_or_else(|| PathBuf::from(DEFAULT_SOURCE_ROOT), PathBuf::from);
    let direct = root.join("data");
    let nested = root.join("www/data");
    if direct.is_dir() {
        direct
    } else if nested.is_dir() {
        nested
    } else {
        panic!(
            "{SOURCE_ROOT_ENV} must name the supplied RPG Maker MV/MZ root or its www directory"
        );
    }
}

fn source_file_bytes(data_dir: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    for entry in fs::read_dir(data_dir).expect("read supplied source data directory") {
        let entry = entry.expect("read source data entry");
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .expect("source data filename is UTF-8");
        let bytes = fs::read(&path).expect("read source JSON bytes");
        assert!(
            files.insert(name, bytes).is_none(),
            "source filenames are unique"
        );
    }
    assert!(!files.is_empty(), "source data directory contains JSON");
    files
}

fn observe_extraction_surfaces(
    data_dir: &Path,
    source_files: &BTreeMap<String, Vec<u8>>,
) -> ExtractionCounts {
    let mut counts = ExtractionCounts::default();
    for (name, bytes) in source_files {
        if !is_map_file(name) && name != "CommonEvents.json" && name != "System.json" {
            continue;
        }
        let value = read_json(data_dir, name, bytes);
        if is_map_file(name) {
            count_map_surfaces(&value, &mut counts);
        } else if name == "CommonEvents.json" {
            count_common_event_commands(&value, &mut counts);
        } else {
            count_system_terms(&value, &mut counts);
        }
    }
    counts
}

fn read_json(data_dir: &Path, name: &str, bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or_else(|error| {
        panic!(
            "parse source data JSON {name} under {}: {error}",
            data_dir.display()
        )
    })
}

fn is_map_file(name: &str) -> bool {
    name.starts_with("Map")
        && Path::new(name)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        && name
            .strip_prefix("Map")
            .and_then(|suffix| suffix.strip_suffix(".json"))
            .is_some_and(|number| {
                !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
            })
}

fn count_map_surfaces(value: &Value, counts: &mut ExtractionCounts) {
    let Some(events) = value.get("events").and_then(Value::as_array) else {
        return;
    };
    for event in events {
        let Some(pages) = event.get("pages").and_then(Value::as_array) else {
            continue;
        };
        for page in pages {
            let Some(list) = page.get("list").and_then(Value::as_array) else {
                continue;
            };
            for command in list {
                match command.get("code").and_then(Value::as_i64) {
                    Some(401)
                        if command
                            .get("parameters")
                            .and_then(Value::as_array)
                            .and_then(|parameters| parameters.first())
                            .and_then(Value::as_str)
                            .is_some_and(|text| !text.is_empty()) =>
                    {
                        counts.show_text += 1;
                    }
                    Some(102)
                        if command
                            .get("parameters")
                            .and_then(Value::as_array)
                            .and_then(|parameters| parameters.first())
                            .is_some_and(Value::is_array) =>
                    {
                        counts.show_choices += 1;
                    }
                    _ => {}
                }
            }
        }
    }
}

fn count_common_event_commands(value: &Value, counts: &mut ExtractionCounts) {
    let Some(events) = value.as_array() else {
        return;
    };
    for event in events {
        let Some(list) = event.get("list").and_then(Value::as_array) else {
            continue;
        };
        counts.common_event_commands += list
            .iter()
            .filter(|command| command.get("code").and_then(Value::as_i64).is_some())
            .count();
    }
}

fn count_system_terms(value: &Value, counts: &mut ExtractionCounts) {
    counts.system_terms_fields = value
        .get("terms")
        .and_then(Value::as_object)
        .map_or(0, serde_json::Map::len);
}

fn assert_command_samples(
    data_dir: &Path,
    declared: &Value,
    sample_kind: &str,
    expected_code: i64,
    target_matches: impl Fn(&Value) -> bool,
) {
    let samples = declared["samples"][sample_kind]
        .as_array()
        .unwrap_or_else(|| panic!("{sample_kind} samples are an array"));
    assert!(!samples.is_empty(), "{sample_kind} has structural samples");
    for sample in samples {
        let (path, pointer, code) = sample_fields(sample);
        assert_eq!(
            code, expected_code,
            "{sample_kind} sample declares its event code"
        );
        let source = read_source_value(data_dir, path);
        let command_pointer = pointer.strip_suffix("/parameters/0").unwrap_or(pointer);
        let command = source
            .pointer(command_pointer)
            .unwrap_or_else(|| panic!("{sample_kind} sample command pointer resolves"));
        assert_eq!(
            command.get("code").and_then(Value::as_i64),
            Some(expected_code)
        );
        let target = source
            .pointer(pointer)
            .unwrap_or_else(|| panic!("{sample_kind} sample target pointer resolves"));
        assert!(
            target_matches(target),
            "{sample_kind} sample has the declared command shape"
        );
    }
}

fn assert_common_event_samples(data_dir: &Path, declared: &Value) {
    let samples = declared["samples"]["commonEventCommands"]
        .as_array()
        .expect("CommonEvents samples array");
    assert!(!samples.is_empty(), "CommonEvents has structural samples");
    for sample in samples {
        let (path, pointer, code) = sample_fields(sample);
        assert_eq!(path, "www/data/CommonEvents.json");
        let source = read_source_value(data_dir, path);
        let command = source
            .pointer(pointer)
            .expect("CommonEvents command pointer resolves");
        assert_eq!(command.get("code").and_then(Value::as_i64), Some(code));
    }
}

fn assert_system_terms_samples(data_dir: &Path, declared: &Value) {
    let samples = declared["samples"]["systemTermsFields"]
        .as_array()
        .expect("System.terms samples array");
    assert!(!samples.is_empty(), "System.terms has structural samples");
    for sample in samples {
        let path = sample["path"].as_str().expect("System sample path");
        let pointer = sample["pointer"].as_str().expect("System sample pointer");
        assert_eq!(path, "www/data/System.json");
        assert!(
            read_source_value(data_dir, path).pointer(pointer).is_some(),
            "System.terms sample pointer resolves"
        );
    }
}

fn sample_fields(sample: &Value) -> (&str, &str, i64) {
    (
        sample["path"].as_str().expect("sample path"),
        sample["pointer"].as_str().expect("sample pointer"),
        sample["code"].as_i64().expect("sample command code"),
    )
}

fn read_source_value(data_dir: &Path, manifest_path: &str) -> Value {
    let name = manifest_path
        .strip_prefix("www/data/")
        .expect("manifest sample stays under www/data");
    assert!(
        !name.contains('/') && !name.contains('\\') && !name.contains(".."),
        "manifest sample uses a safe data filename"
    );
    let bytes = fs::read(data_dir.join(name)).expect("read sampled source JSON");
    serde_json::from_slice(&bytes).expect("parse sampled source JSON")
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
