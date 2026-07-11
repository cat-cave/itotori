//! Multi-title real-byte proof for the closed MV/MZ plugin/script recognizer.
//!
//! The test reads only the two staged `www` trees named by the environment
//! variables below. It reports command names and counts, never command
//! arguments or player text. Every observed plugin/script command must be
//! either a typed text recognizer or a member of the exact opaque tables in
//! `recognize.rs`; an unlisted command is a hard failure.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_rpgmaker::{
    BridgeOpts, FindingKind, OPAQUE_PLUGIN_COMMANDS, OPAQUE_SCRIPT_COMMANDS, OpaqueCommandFamily,
    PluginCommandRecognition, ScriptCommandRecognition, classify_plugin_command,
    classify_script_command, extract_game_dir,
};
use serde_json::Value;

const REAL_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ";
const REAL_ROOT_2_ENV: &str = "ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ_2";

#[derive(Debug, Default)]
struct Census {
    plugin_translatable: BTreeMap<String, usize>,
    plugin_opaque: BTreeMap<String, usize>,
    plugin_unknown: BTreeMap<String, usize>,
    script_opaque: BTreeMap<String, usize>,
    script_unknown: BTreeMap<String, usize>,
    control_variable_opaque: BTreeMap<String, usize>,
    control_variable_unknown: BTreeMap<String, usize>,
}

fn opts() -> BridgeOpts<'static> {
    BridgeOpts {
        game_id: "rpgmaker-real-command-recognition",
        game_version: "real-bytes",
        source_profile_id: "kaifuu-rpgmaker-real-command-recognition",
        source_locale: "ja-JP",
        extractor_name: "kaifuu-rpgmaker",
        extractor_version: "0.1.0",
    }
}

/// Accept either a direct `www` path or a staged corpus root containing it.
fn resolve_www_dir(root: &Path) -> PathBuf {
    fn find(dir: &Path, depth: usize) -> Option<PathBuf> {
        if dir.file_name().and_then(|name| name.to_str()) == Some("www")
            && dir.join("data").is_dir()
        {
            return Some(dir.to_path_buf());
        }
        if depth == 0 {
            return None;
        }
        let mut children: Vec<PathBuf> = fs::read_dir(dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        children.sort();
        children
            .into_iter()
            .find_map(|child| find(&child, depth - 1))
    }

    if root.join("data").is_dir() {
        return root.to_path_buf();
    }

    find(root, 6).unwrap_or_else(|| {
        panic!(
            "{}={} contains no www/data directory",
            REAL_ROOT_ENV,
            root.display()
        )
    })
}

fn command_name(command: &str) -> String {
    command
        .split(' ')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("<empty>")
        .to_string()
}

fn increment(map: &mut BTreeMap<String, usize>, key: impl Into<String>) {
    *map.entry(key.into()).or_default() += 1;
}

fn classify_commands(value: &Value, census: &mut Census) {
    match value {
        Value::Array(values) => {
            for value in values {
                classify_commands(value, census);
            }
        }
        Value::Object(object) => {
            if let Some(code) = object.get("code").and_then(Value::as_i64) {
                let params = object.get("parameters").and_then(Value::as_array);
                match code {
                    356 | 357 => match params.and_then(|values| values.first()) {
                        Some(Value::String(command)) => match classify_plugin_command(command) {
                            PluginCommandRecognition::Translatable(recognized) => {
                                increment(&mut census.plugin_translatable, recognized.command);
                            }
                            PluginCommandRecognition::Opaque(spec) => {
                                increment(&mut census.plugin_opaque, spec.name);
                            }
                            PluginCommandRecognition::Unknown => {
                                increment(&mut census.plugin_unknown, command_name(command));
                            }
                        },
                        _ => increment(&mut census.plugin_unknown, "<non-string-param0>"),
                    },
                    355 | 655 => match params.and_then(|values| values.first()) {
                        Some(Value::String(script)) => match classify_script_command(script) {
                            ScriptCommandRecognition::Opaque(spec) => {
                                increment(&mut census.script_opaque, spec.name);
                            }
                            ScriptCommandRecognition::Unknown => {
                                increment(&mut census.script_unknown, "<unlisted-script>");
                            }
                        },
                        _ => increment(&mut census.script_unknown, "<non-string-script>"),
                    },
                    122 if params
                        .and_then(|values| values.get(3))
                        .and_then(Value::as_i64)
                        == Some(4) =>
                    {
                        match params
                            .and_then(|values| values.get(4))
                            .and_then(Value::as_str)
                        {
                            Some(script) => match classify_script_command(script) {
                                ScriptCommandRecognition::Opaque(spec) => {
                                    increment(&mut census.control_variable_opaque, spec.name);
                                }
                                ScriptCommandRecognition::Unknown => {
                                    increment(
                                        &mut census.control_variable_unknown,
                                        "<unlisted-script>",
                                    );
                                }
                            },
                            None => increment(
                                &mut census.control_variable_unknown,
                                "<non-string-script>",
                            ),
                        }
                    }
                    _ => {}
                }
            }

            for value in object.values() {
                classify_commands(value, census);
            }
        }
        _ => {}
    }
}

fn data_census(www: &Path) -> Census {
    let mut paths: Vec<PathBuf> = fs::read_dir(www.join("data"))
        .expect("read RPG Maker data directory")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();

    let mut census = Census::default();
    for path in paths {
        let bytes = fs::read(&path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
        let json_bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        let value: Value = serde_json::from_slice(json_bytes)
            .unwrap_or_else(|err| panic!("parse {}: {err}", path.display()));
        classify_commands(&value, &mut census);
    }
    census
}

fn emitted_plugin_units(result: &kaifuu_rpgmaker::RpgMakerExtraction) -> BTreeMap<String, usize> {
    let mut units = BTreeMap::new();
    for unit in &result.bundle.bundle.units {
        if unit.surface_kind != "narration" {
            continue;
        }
        for span in &unit.spans {
            let Some(name) = span.parsed_name.as_ref().and_then(Value::as_str) else {
                continue;
            };
            let Some(command) = name
                .strip_prefix("rpgmaker.plugin.")
                .and_then(|name| name.strip_suffix(".command"))
            else {
                continue;
            };
            increment(&mut units, command);
        }
    }
    units
}

fn emitted_opaque(result: &kaifuu_rpgmaker::RpgMakerExtraction) -> BTreeMap<String, usize> {
    let mut commands = BTreeMap::new();
    for occurrence in &result.opaque_commands {
        assert!(!occurrence.reason.is_empty());
        increment(&mut commands, occurrence.command);
    }
    commands
}

fn spec_reason(name: &str, family: OpaqueCommandFamily) -> &'static str {
    let specs = match family {
        OpaqueCommandFamily::Plugin => OPAQUE_PLUGIN_COMMANDS,
        OpaqueCommandFamily::Script | OpaqueCommandFamily::ControlVariableScript => {
            OPAQUE_SCRIPT_COMMANDS
        }
    };
    specs.iter().find(|spec| spec.name == name).map_or_else(
        || panic!("opaque command {name:?} has no enumerated reason"),
        |spec| spec.reason,
    )
}

fn assert_title(name: &str, root: &Path) {
    let www = resolve_www_dir(root);
    let census = data_census(&www);
    let result = extract_game_dir(&www, &opts()).expect("real RPG Maker extraction");

    assert!(
        census.plugin_unknown.is_empty(),
        "{name} has plugin commands outside the exact opaque/text set: {:?}",
        census.plugin_unknown
    );
    assert!(
        census.script_unknown.is_empty(),
        "{name} has script commands outside the exact opaque set: {:?}",
        census.script_unknown
    );
    assert!(
        census.control_variable_unknown.is_empty(),
        "{name} has Control Variables script operands outside the exact opaque set: {:?}",
        census.control_variable_unknown
    );

    let generic_findings: Vec<_> = result
        .findings
        .iter()
        .filter(|finding| {
            matches!(
                finding.kind,
                FindingKind::PluginCommandText
                    | FindingKind::ScriptCommandText
                    | FindingKind::ControlVariableScriptString
            )
        })
        .collect();
    assert!(
        generic_findings.is_empty(),
        "{name} emitted generic plugin/script findings: {generic_findings:?}"
    );

    assert_eq!(
        emitted_plugin_units(&result),
        census.plugin_translatable,
        "{name} plugin text recognition must surface one unit per typed text command"
    );
    assert_eq!(
        result
            .opaque_commands
            .iter()
            .filter(|occurrence| occurrence.family == OpaqueCommandFamily::Plugin)
            .fold(BTreeMap::new(), |mut counts, occurrence| {
                increment(&mut counts, occurrence.command);
                counts
            }),
        census.plugin_opaque,
        "{name} plugin opaque census must match extracted occurrences"
    );
    assert_eq!(
        result
            .opaque_commands
            .iter()
            .filter(|occurrence| occurrence.family == OpaqueCommandFamily::Script)
            .fold(BTreeMap::new(), |mut counts, occurrence| {
                increment(&mut counts, occurrence.command);
                counts
            }),
        census.script_opaque,
        "{name} script opaque census must match extracted occurrences"
    );
    assert_eq!(
        result
            .opaque_commands
            .iter()
            .filter(|occurrence| occurrence.family == OpaqueCommandFamily::ControlVariableScript)
            .fold(BTreeMap::new(), |mut counts, occurrence| {
                increment(&mut counts, occurrence.command);
                counts
            }),
        census.control_variable_opaque,
        "{name} Control Variables opaque census must match extracted occurrences"
    );

    let opaque_commands = emitted_opaque(&result);
    let mut reported_names: Vec<String> = opaque_commands.keys().cloned().collect();
    reported_names.sort();
    eprintln!(
        "[real-bytes][{name}] units={} | plugin text={:?} | script text={{}} | opaque occurrences={} | generic findings=0",
        result.bundle.bundle.units.len(),
        census.plugin_translatable,
        result.opaque_commands.len(),
    );
    eprintln!("[real-bytes][{name}] opaque command names (exact enumerated set entries observed):");
    for command in reported_names {
        let family = result
            .opaque_commands
            .iter()
            .find(|occurrence| occurrence.command == command)
            .map(|occurrence| occurrence.family)
            .expect("reported opaque command occurrence");
        eprintln!(
            "  {command} ({}): {}",
            match family {
                OpaqueCommandFamily::Plugin => "plugin",
                OpaqueCommandFamily::Script => "script",
                OpaqueCommandFamily::ControlVariableScript => "control-variable-script",
            },
            spec_reason(&command, family),
        );
    }
}

/// Env-gated, two-title proof. Run with `--include-ignored` and both vars
/// pointing at the `www` trees from the task brief:
///
/// ```text
/// ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ=/scratch/itotori-research/rpg-maker-mv-mz/extracted/LustMemory/www
/// ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ_2=/scratch/itotori-research/rpg-maker-mv-mz/countryside-life/inakaraifu.rj390522.v1-0.en/countryside-life-2025/www
/// ```
#[test]
#[ignore = "real-bytes; requires both RPG Maker MV/MZ title roots"]
fn both_real_titles_have_only_typed_plugin_script_commands() {
    let Some(root) = env::var_os(REAL_ROOT_ENV) else {
        eprintln!("SKIP: {REAL_ROOT_ENV} unset");
        return;
    };
    let Some(root_2) = env::var_os(REAL_ROOT_2_ENV) else {
        eprintln!("SKIP: {REAL_ROOT_2_ENV} unset");
        return;
    };

    assert_title("LustMemory", Path::new(&root));
    assert_title("Countryside Life", Path::new(&root_2));
}
