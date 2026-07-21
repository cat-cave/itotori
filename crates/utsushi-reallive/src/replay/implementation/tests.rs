use super::canonical::{bytes_to_hex, event_to_canonical_value};
use super::*;

use crate::bytecode_element::{BytecodeElement, TextoutEncoding};
use crate::vm::Scene;

// Helpers for main's semantic / unimplemented-command diagnostics tests.
fn command_element(
    module_type: u8,
    module_id: u8,
    opcode: u16,
    byte_offset: usize,
) -> BytecodeElement {
    let mut raw_bytes = vec![0, module_type, module_id];
    raw_bytes.extend_from_slice(&opcode.to_le_bytes());
    raw_bytes.extend_from_slice(&[0, 0, 0]);
    BytecodeElement::Command {
        module_type,
        module_id,
        opcode,
        arg_count: 0,
        overload: 0,
        goto_targets: Vec::new(),
        goto_case_exprs: Vec::new(),
        raw_bytes,
        byte_offset,
        byte_len: 8,
    }
}

fn semantic_and_unimplemented_engine() -> ReplayEngine {
    let semantic = RlopKey::new(MSG_MODULE_TYPE, MSG_MODULE_ID, OPCODE_LINE_BREAK);
    // This was previously an observed-corpus `Advance` fallback. It must now
    // remain unmatched so replay records an explicit unknown-opcode diagnostic.
    let unimplemented = RlopKey::new(0, 5, 0);
    let scene = Scene::new(
        1,
        vec![
            command_element(semantic.module_type, semantic.module_id, semantic.opcode, 0),
            command_element(
                unimplemented.module_type,
                unimplemented.module_id,
                unimplemented.opcode,
                8,
            ),
        ],
    )
    .expect("synthetic command scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    ReplayEngine::from_store(store, HashSet::new())
}

// Helpers for objbtn chain's port-pass prompt-trace alignment tests.
fn prompt(id: u64, line_id: &str) -> crate::rlop::module_sel::SelectionPrompt {
    crate::rlop::module_sel::SelectionPrompt {
        longop_id: crate::rlop::LongOpId(id),
        byte_offset_in_scene: 0,
        kind: crate::rlop::SelectionPromptKind::Text,
        cancelable: false,
        option_line_ids: vec![line_id.to_string()],
    }
}
fn line(line_id: &str) -> TextLine {
    TextLine {
        line_id: line_id.to_string(),
        evidence_tier: EvidenceTier::E1,
        text: line_id.to_string(),
        speaker: None,
        color: None,
        text_surface: None,
        bridge_ref: None,
        source_asset: None,
        byte_offset_in_scene: None,
        body_shift_jis: None,
    }
}

/// An ASCII textout run for the end-to-end port observation fixture. The
/// caller records its `(scene, offset)` in the Shift-JIS set so the real
/// replay path flushes it as a `TextLine`.
fn textout(offset: usize, text: &str) -> (BytecodeElement, usize) {
    let raw_bytes = text.as_bytes().to_vec();
    let byte_len = raw_bytes.len();
    (
        BytecodeElement::Textout {
            encoding_hint: TextoutEncoding::Other,
            raw_bytes,
            byte_offset: offset,
            byte_len,
        },
        byte_len,
    )
}

const SELECT_BLOCK_OPEN: u8 = 0x7B;
const SELECT_BLOCK_CLOSE: u8 = 0x7D;
const META_LINE_LEAD: u8 = 0x0A;
const STORE_REGISTER: [u8; 2] = [0x24, 0xC8];
const JMP_MODULE_TYPE: u8 = 0;
const JMP_MODULE_ID: u8 = 1;
const OPCODE_GOTO: u16 = 0;
const OPCODE_GOTO_ON: u16 = 3;
const SEL_MODULE_TYPE: u8 = crate::rlop::module_sel::SEL_MODULE_TYPE;
const SEL_MODULE_ID: u8 = crate::rlop::module_sel::SEL_MODULE_ID;
const OPCODE_SELECT: u16 = crate::rlop::module_sel::OPCODE_SELECT;

/// Build the real `{ option \n option }` framing used by a text select.
fn select_command(offset: usize, options: &[&str]) -> (BytecodeElement, usize) {
    let mut raw = vec![
        0x23,
        SEL_MODULE_TYPE,
        SEL_MODULE_ID,
        OPCODE_SELECT as u8,
        (OPCODE_SELECT >> 8) as u8,
        0,
        0,
        0,
        SELECT_BLOCK_OPEN,
    ];
    for (index, option) in options.iter().enumerate() {
        if index > 0 {
            raw.extend_from_slice(&[META_LINE_LEAD, 0, 0]);
        }
        raw.extend_from_slice(option.as_bytes());
    }
    raw.push(SELECT_BLOCK_CLOSE);
    let byte_len = raw.len();
    (
        BytecodeElement::Command {
            module_type: SEL_MODULE_TYPE,
            module_id: SEL_MODULE_ID,
            opcode: OPCODE_SELECT,
            arg_count: 0,
            overload: 0,
            goto_targets: Vec::new(),
            goto_case_exprs: Vec::new(),
            raw_bytes: raw,
            byte_offset: offset,
            byte_len,
        },
        byte_len,
    )
}

/// Build `goto_on($store, { targets... })`; the synthetic VM element
/// carries the trailing target pointers in `goto_targets`, just like the
/// decoder does for real bytecode.
fn goto_on_store(offset: usize, targets: Vec<u32>) -> (BytecodeElement, usize) {
    let arg_count = targets.len() as u16;
    let mut raw = vec![
        0x23,
        JMP_MODULE_TYPE,
        JMP_MODULE_ID,
        OPCODE_GOTO_ON as u8,
        (OPCODE_GOTO_ON >> 8) as u8,
        arg_count as u8,
        (arg_count >> 8) as u8,
        0,
        b'(',
    ];
    raw.extend_from_slice(&STORE_REGISTER);
    raw.push(b')');
    let byte_len = raw.len();
    (
        BytecodeElement::Command {
            module_type: JMP_MODULE_TYPE,
            module_id: JMP_MODULE_ID,
            opcode: OPCODE_GOTO_ON,
            arg_count,
            overload: 0,
            goto_targets: targets,
            goto_case_exprs: Vec::new(),
            raw_bytes: raw,
            byte_offset: offset,
            byte_len,
        },
        byte_len,
    )
}

/// Build a `goto(target)` command with one trailing target pointer.
fn goto_command(offset: usize, target: u32) -> (BytecodeElement, usize) {
    let raw = vec![
        0x23,
        JMP_MODULE_TYPE,
        JMP_MODULE_ID,
        OPCODE_GOTO as u8,
        (OPCODE_GOTO >> 8) as u8,
        0,
        0,
        0,
    ];
    let byte_len = raw.len() + 4;
    (
        BytecodeElement::Command {
            module_type: JMP_MODULE_TYPE,
            module_id: JMP_MODULE_ID,
            opcode: OPCODE_GOTO,
            arg_count: 0,
            overload: 0,
            goto_targets: vec![target],
            goto_case_exprs: Vec::new(),
            raw_bytes: raw,
            byte_offset: offset,
            byte_len,
        },
        byte_len,
    )
}

/// A two-option text select whose options dispatch to distinct reaction
/// textouts. Branch-following takes the first reaction; linear walking
/// visits both reactions.
fn divergent_select_port_engine() -> ReplayEngine {
    const FIRST_REACTION: &str = "reaction from the first option";
    const SECOND_REACTION: &str = "reaction from the second option";

    let mut offset = 0usize;
    let (select, select_len) = select_command(offset, &["first option", "second option"]);
    offset += select_len;

    let goto_on_offset = offset;
    let (_, goto_on_len) = goto_on_store(goto_on_offset, vec![0, 0]);
    offset += goto_on_len;

    let first_reaction = offset;
    let (first_text, first_text_len) = textout(first_reaction, FIRST_REACTION);
    offset += first_text_len;
    let first_goto_offset = offset;
    let (_, first_goto_len) = goto_command(first_goto_offset, 0);
    offset += first_goto_len;

    let second_reaction = offset;
    let (second_text, second_text_len) = textout(second_reaction, SECOND_REACTION);
    offset += second_text_len;
    let second_goto_offset = offset;
    let (_, second_goto_len) = goto_command(second_goto_offset, 0);
    offset += second_goto_len;
    let end = offset as u32;

    let (goto_on, _) = goto_on_store(
        goto_on_offset,
        vec![first_reaction as u32, second_reaction as u32],
    );
    let (first_goto, _) = goto_command(first_goto_offset, end);
    let (second_goto, _) = goto_command(second_goto_offset, end);
    let scene = Scene::new(
        1,
        vec![
            select,
            goto_on,
            first_text,
            first_goto,
            second_text,
            second_goto,
        ],
    )
    .expect("divergent select scene builds");

    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let shift_jis = HashSet::from([(1, first_reaction as u32), (1, second_reaction as u32)]);
    ReplayEngine::from_store(store, shift_jis)
}

/// A select/redraw loop whose branch path repeats the prompt, while the
/// linear catalogue walks through two reaction textouts and terminates.
fn spinning_select_port_engine() -> ReplayEngine {
    const FIRST_REACTION: &str = "linear first reaction";
    const SECOND_REACTION: &str = "linear second reaction";

    let mut offset = 0usize;
    let (select, select_len) = select_command(offset, &["repeat first", "repeat second"]);
    offset += select_len;
    let goto_on_offset = offset;
    let (_, goto_on_len) = goto_on_store(goto_on_offset, vec![0, 0]);
    offset += goto_on_len;

    let first_reaction = offset;
    let (first_text, first_text_len) = textout(first_reaction, FIRST_REACTION);
    offset += first_text_len;
    let second_reaction = offset;
    let (second_text, _) = textout(second_reaction, SECOND_REACTION);

    let (goto_on, _) = goto_on_store(goto_on_offset, vec![0, 0]);
    let scene = Scene::new(1, vec![select, goto_on, first_text, second_text])
        .expect("spinning select scene builds");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let shift_jis = HashSet::from([(1, first_reaction as u32), (1, second_reaction as u32)]);
    ReplayEngine::from_store(store, shift_jis)
}

mod basics;
mod port;
