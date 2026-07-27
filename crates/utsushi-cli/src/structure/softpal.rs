//! Softpal narrative structure from the runtime's extracted scene program.
//!
//! The current format exposes one `SCRIPT.SRC` dispatch stream and one
//! `TEXT.DAT` pool for a game root.  The runtime proves that stream exhaustively
//! in byte order, but does not resolve conditional jump targets, so this
//! producer emits the complete observable linear scene rather than inventing a
//! route graph that the bytes do not establish.

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_softpal::PacArchive;
use serde_json::{Value, json};
use utsushi_softpal::{SceneStep, SoftpalScene};

use super::StructureCommandInput;

const SCENE_ID: &str = "scene:script-src";

pub(super) fn build_softpal_structure(
    input: StructureCommandInput,
) -> Result<Value, Box<dyn Error>> {
    if input.gameexe.is_some() || input.seen.is_some() || input.bridge.is_some() {
        return Err("softpal structure accepts --game-root and --output only".into());
    }
    if input.entry.is_some() || input.max_scenes.is_some() {
        return Err("softpal structure does not accept scene selection limits".into());
    }
    let game_root = input.game_root.as_deref().ok_or("missing --game-root")?;
    let (script, textdat) = read_runtime_inputs(game_root)?;
    let scene = SoftpalScene::execute(&script, &textdat)?;
    Ok(structure_value(&scene))
}

fn read_runtime_inputs(game_root: &Path) -> Result<(Vec<u8>, Vec<u8>), Box<dyn Error>> {
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

fn structure_value(scene: &SoftpalScene) -> Value {
    let mut messages = Vec::new();
    let mut choices = Vec::new();
    let mut choice_index = 0_usize;
    for step in &scene.steps {
        match step {
            SceneStep::Dialogue { speaker, text, .. } => messages.push(json!({
                "order": messages.len(),
                "speaker": speaker,
                "text": text,
                "textSurface": null,
            })),
            SceneStep::Choice { options, .. } => {
                for option in options.iter().filter_map(|option| option.text.as_deref()) {
                    choices.push(json!({
                        "optionIndex": choice_index,
                        "label": option,
                        "branchEntryScene": null,
                        "branchMessages": [],
                    }));
                    choice_index += 1;
                }
            }
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
                "opcodeExhaustive": scene.stats.opcode_exhaustive,
                "choiceMenuCount": scene.stats.choice_menu_count,
                "textBearingChoiceCount": scene.stats.text_bearing_choice_count,
                "systemSelectCount": scene.stats.system_select_count,
                "limitations": [
                    "Conditional jump targets and expression values are not resolved by the current runtime.",
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

    use kaifuu_softpal::{
        PAC_COUNT_OFFSET, PAC_ENTRY_NAME_BYTE_LEN, PAC_HEADER_BYTE_LEN, PAC_INDEX_ENTRY_BYTE_LEN,
        PAC_MAGIC, SCRIPT_MAGIC_PREFIX, SELECT_WORD_HI, SELECT_WORD_LO, TEXT_SHOW_WORD_HI,
        TEXTDAT_FLAG_PLAINTEXT, TEXTDAT_MAGIC_TAIL,
    };
    use tempfile::TempDir;

    use super::*;

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

    #[test]
    fn exports_runtime_messages_and_text_bearing_choices_from_a_game_root() {
        let root = TempDir::new().expect("temporary game root");
        let (textdat, pointers) = textdat();
        let script = script(&pointers);
        fs::write(
            root.path().join("data.pac"),
            build_pac(&[("SCRIPT.SRC", &script), ("TEXT.DAT", &textdat)]),
        )
        .expect("write fixture archive");

        let structure = build_softpal_structure(StructureCommandInput {
            gameexe: None,
            seen: None,
            game_root: Some(root.path().to_path_buf()),
            bridge: None,
            entry: None,
            max_scenes: None,
        })
        .expect("structure export");

        assert_eq!(structure["engine"], "softpal");
        assert_eq!(structure["scenes"].as_array().map(Vec::len), Some(1));
        let scene = &structure["scenes"][0];
        assert_eq!(scene["messages"].as_array().map(Vec::len), Some(1));
        assert_eq!(scene["messages"][0]["speaker"], "speaker");
        assert_eq!(scene["choices"].as_array().map(Vec::len), Some(2));
        assert_eq!(scene["choices"][0]["label"], "choice one");
    }
}
