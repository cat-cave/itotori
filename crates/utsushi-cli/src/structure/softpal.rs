//! Softpal narrative structure from the proven linear script walk.
//!
//! `SCRIPT.SRC` and `TEXT.DAT` establish a complete byte-order dialogue and
//! choice stream today. The VM is exercised separately until an executed path
//! covers this producer's output; structure export must not discard that
//! localization input merely because VM execution stops at an unknown call.

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_softpal::{OpcodeScan, PacArchive, ScriptScan, TextDat};
use serde_json::{Value, json};

use super::StructureCommandInput;
use super::adapters::validate_empty_adapter_config;
use super::softpal_bridge::selected_source_unit_keys;

const SCENE_ID: &str = "scene:script-src";

pub(super) fn build_softpal_structure(
    input: StructureCommandInput,
) -> Result<Value, Box<dyn Error>> {
    validate_empty_adapter_config("softpal", &input)?;
    let selected_keys = selected_source_unit_keys(&input.bridge)?;
    let game_root = &input.game_root;
    let (script, textdat) = read_structure_inputs(game_root)?;
    let scan = ScriptScan::parse(&script)?;
    let textdat = TextDat::parse(&textdat)?;
    let disassembly = scan.resolve(&textdat);
    if !disassembly.is_fully_resolved() {
        return Err(format!(
            "utsushi.structure.softpal_unresolved_disassembly: dangling={} unresolved_dialogue={} unresolved_speaker={}",
            disassembly.dangling_pointer_count(),
            disassembly.unresolved_dialogue_text_count(),
            disassembly.unresolved_speaker_count(),
        )
        .into());
    }
    let opcode_exhaustive = OpcodeScan::parse(&script)?.is_exhaustive();
    let choice_menu_count = scan
        .commands
        .iter()
        .fold((false, 0_usize), |(previous_was_select, count), command| {
            let is_select = matches!(command, kaifuu_softpal::RawCommand::Select { .. });
            (
                is_select,
                count + usize::from(is_select && !previous_was_select),
            )
        })
        .1;
    Ok(structure_value(
        &disassembly,
        opcode_exhaustive,
        choice_menu_count,
        &selected_keys,
    ))
}

fn read_structure_inputs(game_root: &Path) -> Result<(Vec<u8>, Vec<u8>), Box<dyn Error>> {
    if !game_root.is_dir() {
        return Err(format!(
            "softpal game root is not a directory: {}",
            game_root.display()
        )
        .into());
    }
    let mut archives = Vec::new();
    find_data_archives(game_root, &mut archives)?;
    archives.sort();

    let mut inputs = Vec::new();
    for path in archives {
        let bytes = fs::read(&path)?;
        let Ok(archive) = PacArchive::parse(&bytes) else {
            continue;
        };
        let (Some(script), Some(textdat)) = (archive.find("SCRIPT.SRC"), archive.find("TEXT.DAT"))
        else {
            continue;
        };
        inputs.push((
            path,
            archive.extract(&bytes, script)?.to_vec(),
            archive.extract(&bytes, textdat)?.to_vec(),
        ));
    }
    match inputs.len() {
        0 => Err("softpal game root has no data archive containing SCRIPT.SRC and TEXT.DAT".into()),
        1 => {
            let (_, script, textdat) = inputs.pop().expect("one input was checked");
            Ok((script, textdat))
        }
        count => Err(format!(
            "softpal game root has {count} data archives containing SCRIPT.SRC and TEXT.DAT; select one game root"
        )
        .into()),
    }
}

fn find_data_archives(root: &Path, archives: &mut Vec<PathBuf>) -> Result<(), Box<dyn Error>> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            find_data_archives(&path, archives)?;
        } else if file_type.is_file()
            && path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("data.pac"))
        {
            archives.push(path);
        }
    }
    Ok(())
}

fn structure_value(
    disassembly: &kaifuu_softpal::Disassembly,
    opcode_exhaustive: bool,
    choice_menu_count: usize,
    selected_keys: &std::collections::BTreeSet<String>,
) -> Value {
    let mut messages = Vec::new();
    let mut choices = Vec::new();
    let mut choice_index = 0_usize;
    for dialogue in &disassembly.dialogue {
        let key = format!("softpal:dialogue:{}", dialogue.text.pointer);
        if !selected_keys.contains(&key) {
            continue;
        }
        messages.push(json!({
            "order": messages.len(),
            "speaker": dialogue.speaker.as_ref().and_then(|speaker| speaker.resolved_text()),
            "text": dialogue.text.resolved_text(),
            "textSurface": null,
        }));
    }
    for choice in &disassembly.choices {
        let key = format!("softpal:choice:{}", choice.text.pointer);
        if !selected_keys.contains(&key) {
            continue;
        }
        if let Some(label) = choice.text.resolved_text() {
            choices.push(json!({
                "optionIndex": choice_index,
                "label": label,
                "branchEntryScene": null,
                "branchMessages": [],
            }));
            choice_index += 1;
        }
    }
    json!({
        "schemaVersion": "utsushi.narrative-structure.v1",
        "engine": "softpal",
        "entryScene": SCENE_ID,
        "sceneDispatchOrder": [SCENE_ID],
        "engineEvidence": {
            "softpal": {
                "sceneSource": "SCRIPT.SRC + TEXT.DAT from data.pac",
                "opcodeExhaustive": opcode_exhaustive,
                "choiceMenuCount": choice_menu_count,
                "textBearingChoiceCount": disassembly.text_bearing_choice_count(),
                "systemSelectCount": disassembly.nontext_select_count(),
                "limitations": [
                    "Structure follows the selected bridge units in SCRIPT.SRC byte order; it does not claim a branch route graph.",
                    "System selects without TEXT.DAT labels are not emitted as narrative choices."
                ]
            }
        },
        "scenes": [{
            "sceneId": SCENE_ID,
            "selectionControl": if choices.is_empty() { "none" } else { "text-window" },
            "nextScene": null,
            "dispatchFanoutScenes": [],
            "messages": messages,
            "choices": choices,
        }],
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use kaifuu_softpal::{
        PAC_COUNT_OFFSET, PAC_ENTRY_NAME_BYTE_LEN, PAC_HEADER_BYTE_LEN, PAC_INDEX_ENTRY_BYTE_LEN,
        PAC_MAGIC, SCRIPT_MAGIC_PREFIX, SELECT_WORD_HI, SELECT_WORD_LO, TEXT_SHOW_WORD_HI,
        TEXTDAT_FLAG_PLAINTEXT, TEXTDAT_MAGIC_TAIL,
    };
    use serde_json::Value;
    use tempfile::TempDir;

    fn build_pac(files: &[(&str, &[u8])]) -> Vec<u8> {
        let index_end = PAC_HEADER_BYTE_LEN + files.len() * PAC_INDEX_ENTRY_BYTE_LEN;
        let mut offsets = Vec::with_capacity(files.len());
        let mut cursor = index_end;
        for (_, payload) in files {
            offsets.push(cursor);
            cursor += payload.len();
        }
        let mut pac = vec![0; cursor];
        pac[..4].copy_from_slice(PAC_MAGIC);
        pac[PAC_COUNT_OFFSET..PAC_COUNT_OFFSET + 4]
            .copy_from_slice(&(files.len() as u32).to_le_bytes());
        for (index, (name, payload)) in files.iter().enumerate() {
            let entry = PAC_HEADER_BYTE_LEN + index * PAC_INDEX_ENTRY_BYTE_LEN;
            pac[entry..entry + name.len()].copy_from_slice(name.as_bytes());
            pac[entry + PAC_ENTRY_NAME_BYTE_LEN..entry + PAC_ENTRY_NAME_BYTE_LEN + 4]
                .copy_from_slice(&(payload.len() as u32).to_le_bytes());
            pac[entry + PAC_ENTRY_NAME_BYTE_LEN + 4..entry + PAC_ENTRY_NAME_BYTE_LEN + 8]
                .copy_from_slice(&(offsets[index] as u32).to_le_bytes());
            pac[offsets[index]..offsets[index] + payload.len()].copy_from_slice(payload);
        }
        pac
    }

    fn textdat() -> (Vec<u8>, Vec<u32>) {
        let records = [b"line".as_slice(), b"speaker", b"choice one", b"choice two"];
        let mut textdat = vec![TEXTDAT_FLAG_PLAINTEXT];
        textdat.extend_from_slice(TEXTDAT_MAGIC_TAIL);
        textdat.extend_from_slice(&(records.len() as u32).to_le_bytes());
        let mut pointers = Vec::new();
        for (index, text) in records.iter().enumerate() {
            pointers.push(textdat.len() as u32);
            textdat.extend_from_slice(&(index as u32).to_le_bytes());
            textdat.extend_from_slice(text);
            textdat.push(0);
        }
        (textdat, pointers)
    }

    fn opcode(id: u16) -> [u8; 4] {
        let mut token = [0; 4];
        token[..2].copy_from_slice(&id.to_le_bytes());
        token[2..].copy_from_slice(&1_u16.to_le_bytes());
        token
    }

    fn word(value: u32) -> [u8; 4] {
        value.to_le_bytes()
    }

    fn target(category: u16, function: u16) -> u32 {
        (u32::from(category) << 16) | u32::from(function)
    }

    fn script(pointers: &[u32]) -> Vec<u8> {
        let mut script = Vec::new();
        script.extend_from_slice(SCRIPT_MAGIC_PREFIX);
        script.extend_from_slice(b"20");
        script.extend_from_slice(&[0; 8]);
        for token in [
            opcode(0x1f),
            word(pointers[0]),
            opcode(0x1f),
            word(pointers[1]),
            opcode(0x1f),
            word(0),
            opcode(0x17),
            word(target(TEXT_SHOW_WORD_HI, 2)),
            word(0),
            opcode(0x1f),
            word(pointers[2]),
            opcode(0x17),
            word(target(SELECT_WORD_HI, SELECT_WORD_LO)),
            word(0),
            opcode(0x1f),
            word(pointers[3]),
            opcode(0x17),
            word(target(SELECT_WORD_HI, SELECT_WORD_LO)),
            word(0),
        ] {
            script.extend_from_slice(&token);
        }
        script
    }

    fn write_bridge(path: &Path, source_unit_keys: &[String]) {
        let units = source_unit_keys
            .iter()
            .map(|source_unit_key| serde_json::json!({ "sourceUnitKey": source_unit_key }))
            .collect::<Vec<_>>();
        fs::write(path, serde_json::json!({ "units": units }).to_string())
            .expect("write selected bridge");
    }

    fn structure_args(root: &Path, bridge: &Path, output: &Path) -> Vec<String> {
        vec![
            "--engine".to_owned(),
            "softpal".to_owned(),
            "--game-root".to_owned(),
            root.to_string_lossy().into_owned(),
            "--bridge".to_owned(),
            bridge.to_string_lossy().into_owned(),
            "--adapter-config".to_owned(),
            "{}".to_owned(),
            "--output".to_owned(),
            output.to_string_lossy().into_owned(),
        ]
    }

    #[test]
    fn generic_structure_command_exports_softpal_from_a_game_root() {
        let root = TempDir::new().expect("temporary game root");
        let (textdat, pointers) = textdat();
        let script = script(&pointers);
        fs::write(
            root.path().join("data.pac"),
            build_pac(&[("SCRIPT.SRC", &script), ("TEXT.DAT", &textdat)]),
        )
        .expect("write fixture archive");
        let bridge = root.path().join("generic.bridge.json");
        write_bridge(
            &bridge,
            &[
                format!("softpal:dialogue:{}", pointers[0]),
                format!("softpal:choice:{}", pointers[2]),
                format!("softpal:choice:{}", pointers[3]),
            ],
        );
        let output = root.path().join("structure.json");
        let args = structure_args(root.path(), &bridge, &output);

        super::super::run_structure_command(&args).expect("generic structure export");
        let structure: Value = serde_json::from_slice(&fs::read(output).expect("read structure"))
            .expect("structure is JSON");

        assert_eq!(structure["engine"], "softpal");
        assert_eq!(structure["scenes"].as_array().map(Vec::len), Some(1));
        let scene = &structure["scenes"][0];
        assert_eq!(scene["messages"].as_array().map(Vec::len), Some(1));
        assert_eq!(scene["messages"][0]["speaker"], "speaker");
        assert_eq!(scene["choices"].as_array().map(Vec::len), Some(2));
        assert_eq!(scene["choices"][0]["label"], "choice one");
    }

    #[test]
    fn generic_structure_command_respects_the_selected_softpal_bridge_units() {
        let root = TempDir::new().expect("temporary game root");
        let (textdat, pointers) = textdat();
        let script = script(&pointers);
        fs::write(
            root.path().join("data.pac"),
            build_pac(&[("SCRIPT.SRC", &script), ("TEXT.DAT", &textdat)]),
        )
        .expect("write fixture archive");
        let bridge = root.path().join("selected.bridge.json");
        write_bridge(
            &bridge,
            &[
                format!("softpal:dialogue:{}", pointers[0]),
                format!("softpal:choice:{}", pointers[3]),
            ],
        );
        let output = root.path().join("structure.json");

        super::super::run_structure_command(&structure_args(root.path(), &bridge, &output))
            .expect("selected generic structure export");
        let structure: Value = serde_json::from_slice(&fs::read(output).expect("read structure"))
            .expect("structure is JSON");
        let scene = &structure["scenes"][0];

        assert_eq!(scene["messages"].as_array().map(Vec::len), Some(1));
        assert_eq!(scene["choices"].as_array().map(Vec::len), Some(1));
        assert_eq!(scene["choices"][0]["label"], "choice two");
    }
}
