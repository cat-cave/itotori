//! The `Sv20` scene-dispatch **executor**.
//!
//! [`SoftpalScene::execute`] drives the arity-driven `Sv20` dispatch stream the
//! `kaifuu-softpal` disassembler recovers, in play order, into an ordered
//! [`SceneStep`] program: TEXT-SHOW `Call`s become [`SceneStep::Dialogue`],
//! runs of adjacent SELECT `Call`s become one [`SceneStep::Choice`] menu, and
//! the nullary control operators are counted as executed scene/block markers.
//! The executed dialogue/choice stream is cross-checked against the
//! 100%-pointer-resolved bridge disassembly ([`ScriptScan::resolve`]); a
//! mismatch, an unresolved dialogue line, or a dangling pointer is a hard
//! [`SoftpalRuntimeError`], never a silently-degraded run.

use std::collections::HashMap;

use kaifuu_softpal::{
    CommandFamily, OpcodeError, OpcodeScan, RawCommand, ScriptError, ScriptScan, TextDat,
    TextDatError,
};
use serde::{Deserialize, Serialize};

/// One executed step of the scene-dispatch, in play order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SceneStep {
    /// A TEXT-SHOW `Call`: one dialogue line, with an optional speaker name.
    Dialogue {
        /// Absolute byte offset of the 32-byte command in `SCRIPT.SRC`.
        command_offset: usize,
        /// The resolved speaker name, or `None` for narration.
        speaker: Option<String>,
        /// The resolved dialogue text (always present — a dialogue line whose
        /// text pointer does not resolve fails execution).
        text: String,
    },
    /// A run of adjacent SELECT `Call`s: one choice menu the player picks from.
    Choice {
        /// The choice options, in on-screen order.
        options: Vec<ChoiceOption>,
        /// The option the headless deterministic policy selects: the first
        /// text-bearing option, or `0` when the menu is all system selects.
        selected: usize,
    },
}

/// One option of a [`SceneStep::Choice`] menu.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceOption {
    /// Absolute byte offset of the 16-byte SELECT command in `SCRIPT.SRC`.
    pub command_offset: usize,
    /// The resolved choice text, or `None` for a system/branch select whose
    /// immediate lies outside the `TEXT.DAT` pool (no inline label).
    pub text: Option<String>,
}

impl ChoiceOption {
    /// Whether this option carries inline choice text (a real player choice,
    /// not a system/branch select).
    #[must_use]
    pub fn is_text_bearing(&self) -> bool {
        self.text.is_some()
    }
}

/// Aggregate accounting of one executed scene: what the stack machine walked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftpalSceneStats {
    /// Total `Sv20` operators walked (executed) across the whole dispatch stream.
    pub instructions_executed: usize,
    /// `Call` (opcode `0x17`) operators dispatched to the engine command surface.
    pub call_count: usize,
    /// Nullary control operators (scene/block/flow markers) walked.
    pub control_count: usize,
    /// TEXT-SHOW dialogue lines emitted.
    pub dialogue_count: usize,
    /// Distinct choice menus presented.
    pub choice_menu_count: usize,
    /// Text-bearing choice options across every menu (real player choices).
    pub text_bearing_choice_count: usize,
    /// System/branch selects across every menu (out-of-pool immediates).
    pub system_select_count: usize,
    /// Whether the `Sv20` operator walk was 0-unknown exhaustive (every token
    /// typed, no residual) — the disassembler's completeness bar.
    pub opcode_exhaustive: bool,
}

/// A fully executed Softpal scene: the ordered step program plus stats.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftpalScene {
    /// The `"Sv"` version bytes of the executed `SCRIPT.SRC` (e.g. `b"20"`).
    pub sv_version: [u8; 2],
    /// The executed steps, in play order.
    pub steps: Vec<SceneStep>,
    /// Aggregate execution accounting.
    pub stats: SoftpalSceneStats,
}

impl SoftpalScene {
    /// Execute the `Sv20` scene-dispatch of one extracted `SCRIPT.SRC` against
    /// its `TEXT.DAT` string pool.
    ///
    /// # Errors
    ///
    /// Returns a [`SoftpalRuntimeError`] if the script/textdat fail to decode,
    /// if the disassembly is not fully pointer-resolved (a dangling or
    /// unresolved dialogue/speaker pointer), or if the executed dialogue/choice
    /// stream disagrees with the bridge disassembly's counts.
    pub fn execute(script_bytes: &[u8], textdat_bytes: &[u8]) -> Result<Self, SoftpalRuntimeError> {
        // 1. The arity-driven operator walk IS the stack-machine execution: it
        //    steps operator -> operands -> operator across the whole stream.
        let walk = OpcodeScan::parse(script_bytes)?;
        let control_count = walk
            .instructions
            .iter()
            .filter(|instruction| matches!(instruction.family, CommandFamily::Control))
            .count();
        let stats_partial = (walk.instructions.len(), walk.call_count(), control_count);
        let opcode_exhaustive = walk.is_exhaustive();

        // 2. Text-bearing command stream (play order) + resolved pool.
        let scan = ScriptScan::parse(script_bytes)?;
        let textdat = TextDat::parse(textdat_bytes)?;
        let disassembly = scan.resolve(&textdat);
        if !disassembly.is_fully_resolved() {
            return Err(SoftpalRuntimeError::UnresolvedDisassembly {
                dangling: disassembly.dangling_pointer_count(),
                unresolved_dialogue: disassembly.unresolved_dialogue_text_count(),
                unresolved_speaker: disassembly.unresolved_speaker_count(),
            });
        }

        // record byte-offset (as u32) -> decoded line.
        let mut by_offset: HashMap<u32, String> = HashMap::with_capacity(textdat.records.len());
        for record in &textdat.records {
            if let Ok(offset) = u32::try_from(record.offset) {
                by_offset.insert(offset, record.text.clone());
            }
        }
        let resolve = |pointer: u32| by_offset.get(&pointer).cloned();

        // 3. Walk the commands in play order, grouping adjacent selects into a
        //    single menu (a dialogue line closes any open menu).
        let mut steps: Vec<SceneStep> = Vec::new();
        let mut pending: Vec<ChoiceOption> = Vec::new();
        for command in &scan.commands {
            match *command {
                RawCommand::TextShow {
                    command_offset,
                    text_pointer,
                    name_pointer,
                    ..
                } => {
                    flush_menu(&mut steps, &mut pending);
                    let text = resolve(text_pointer)
                        .ok_or(SoftpalRuntimeError::UnresolvedDialogue { command_offset })?;
                    let speaker = name_pointer.and_then(resolve);
                    steps.push(SceneStep::Dialogue {
                        command_offset,
                        speaker,
                        text,
                    });
                }
                RawCommand::Select {
                    command_offset,
                    text_pointer,
                    decoupled_label,
                    ..
                } => {
                    let text = resolve(text_pointer)
                        .or_else(|| decoupled_label.and_then(|label| resolve(label.pointer)));
                    pending.push(ChoiceOption {
                        command_offset,
                        text,
                    });
                }
            }
        }
        flush_menu(&mut steps, &mut pending);

        // 4. Cross-check the executed stream against the bridge disassembly.
        let dialogue_count = steps
            .iter()
            .filter(|step| matches!(step, SceneStep::Dialogue { .. }))
            .count();
        let options: Vec<&ChoiceOption> = steps
            .iter()
            .filter_map(|step| match step {
                SceneStep::Choice { options, .. } => Some(options),
                SceneStep::Dialogue { .. } => None,
            })
            .flatten()
            .collect();
        let text_bearing = options.iter().filter(|o| o.is_text_bearing()).count();
        let system = options.len() - text_bearing;
        if dialogue_count != disassembly.dialogue.len()
            || options.len() != disassembly.choices.len()
        {
            return Err(SoftpalRuntimeError::SceneStreamMismatch {
                executed_dialogue: dialogue_count,
                bridge_dialogue: disassembly.dialogue.len(),
                executed_choices: options.len(),
                bridge_choices: disassembly.choices.len(),
            });
        }

        let choice_menu_count = steps
            .iter()
            .filter(|step| matches!(step, SceneStep::Choice { .. }))
            .count();
        let (instructions_executed, call_count, control_count) = stats_partial;
        Ok(Self {
            sv_version: scan.header.version,
            steps,
            stats: SoftpalSceneStats {
                instructions_executed,
                call_count,
                control_count,
                dialogue_count,
                choice_menu_count,
                text_bearing_choice_count: text_bearing,
                system_select_count: system,
                opcode_exhaustive,
            },
        })
    }

    /// The dialogue lines in play order (speaker + text), skipping choice menus.
    pub fn dialogue_lines(&self) -> impl Iterator<Item = (Option<&str>, &str)> {
        self.steps.iter().filter_map(|step| match step {
            SceneStep::Dialogue { speaker, text, .. } => Some((speaker.as_deref(), text.as_str())),
            SceneStep::Choice { .. } => None,
        })
    }
}

/// Close an open choice menu (if any) into a [`SceneStep::Choice`], selecting
/// the first text-bearing option under the headless deterministic policy.
fn flush_menu(steps: &mut Vec<SceneStep>, pending: &mut Vec<ChoiceOption>) {
    if pending.is_empty() {
        return;
    }
    let options = std::mem::take(pending);
    let selected = options
        .iter()
        .position(ChoiceOption::is_text_bearing)
        .unwrap_or(0);
    steps.push(SceneStep::Choice { options, selected });
}

/// Fatal errors raised while executing a Softpal scene. Every display string
/// begins with the `utsushi.softpal.runtime` namespace marker.
#[derive(Debug, thiserror::Error)]
pub enum SoftpalRuntimeError {
    /// The `SCRIPT.SRC` opcode stream failed to decode.
    #[error("utsushi.softpal.runtime.opcode: {0}")]
    Opcode(#[from] OpcodeError),
    /// The `SCRIPT.SRC` command stream failed to decode.
    #[error("utsushi.softpal.runtime.script: {0}")]
    Script(#[from] ScriptError),
    /// The `TEXT.DAT` string pool failed to decode.
    #[error("utsushi.softpal.runtime.textdat: {0}")]
    TextDat(#[from] TextDatError),
    /// The bridge disassembly was not fully pointer-resolved, so the runtime
    /// refuses to execute a partially-recovered scene.
    #[error(
        "utsushi.softpal.runtime.unresolved_disassembly: dangling={dangling} \
         unresolved_dialogue={unresolved_dialogue} unresolved_speaker={unresolved_speaker}"
    )]
    UnresolvedDisassembly {
        dangling: usize,
        unresolved_dialogue: usize,
        unresolved_speaker: usize,
    },
    /// A TEXT-SHOW command's text pointer did not land on a record boundary.
    #[error("utsushi.softpal.runtime.unresolved_dialogue: command at offset {command_offset}")]
    UnresolvedDialogue { command_offset: usize },
    /// The executed dialogue/choice stream disagreed with the bridge
    /// disassembly counts — a runtime/disassembler integrity divergence.
    #[error(
        "utsushi.softpal.runtime.scene_stream_mismatch: executed_dialogue={executed_dialogue} \
         bridge_dialogue={bridge_dialogue} executed_choices={executed_choices} \
         bridge_choices={bridge_choices}"
    )]
    SceneStreamMismatch {
        executed_dialogue: usize,
        bridge_dialogue: usize,
        executed_choices: usize,
        bridge_choices: usize,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaifuu_softpal::{
        SCRIPT_MAGIC_PREFIX, SELECT_WORD_HI, SELECT_WORD_LO, TEXT_SHOW_WORD_HI,
        TEXTDAT_FLAG_PLAINTEXT, TEXTDAT_MAGIC_TAIL,
    };

    /// Build a plaintext `TEXT.DAT` from `(index, ascii)` records; returns the
    /// bytes and each record's absolute byte offset (a valid text pointer).
    fn build_textdat(records: &[(u32, &[u8])]) -> (Vec<u8>, Vec<usize>) {
        let mut buf = vec![TEXTDAT_FLAG_PLAINTEXT];
        buf.extend_from_slice(TEXTDAT_MAGIC_TAIL);
        buf.extend_from_slice(&(records.len() as u32).to_le_bytes());
        let mut offsets = Vec::new();
        for (index, text) in records {
            offsets.push(buf.len());
            buf.extend_from_slice(&index.to_le_bytes());
            buf.extend_from_slice(text);
            buf.push(0);
        }
        (buf, offsets)
    }

    fn opc(id: u16) -> [u8; 4] {
        let mut token = [0u8; 4];
        token[0..2].copy_from_slice(&id.to_le_bytes());
        token[2..4].copy_from_slice(&0x0001u16.to_le_bytes());
        token
    }
    fn word(value: u32) -> [u8; 4] {
        value.to_le_bytes()
    }
    fn target(category: u16, function: u16) -> u32 {
        (u32::from(category) << 16) | u32::from(function)
    }
    fn text_show(text_ptr: u32, name_ptr: u32) -> Vec<[u8; 4]> {
        vec![
            opc(0x1f),
            word(text_ptr),
            opc(0x1f),
            word(name_ptr),
            opc(0x1f),
            word(0),
            opc(0x17),
            word(target(TEXT_SHOW_WORD_HI, 0x0002)),
            word(0),
        ]
    }
    fn select(immediate: u32) -> Vec<[u8; 4]> {
        vec![
            opc(0x1f),
            word(immediate),
            opc(0x17),
            word(target(SELECT_WORD_HI, SELECT_WORD_LO)),
            word(0),
        ]
    }
    fn program(token_groups: &[Vec<[u8; 4]>]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(SCRIPT_MAGIC_PREFIX);
        bytes.extend_from_slice(b"20");
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        for group in token_groups {
            for token in group {
                bytes.extend_from_slice(token);
            }
        }
        bytes
    }

    /// A synthetic scene: two dialogue lines (one with speaker) then a two-option
    /// choice menu, both options text-bearing — the direct-immediate label idiom.
    fn synthetic() -> (Vec<u8>, Vec<u8>) {
        let no_speaker = 0x0FFF_FFFFu32; // NO_SPEAKER_POINTER
        let (textdat, recs) = build_textdat(&[
            (0, b"first line"),
            (1, b"Speaker"),
            (2, b"go left"),
            (3, b"go right"),
        ]);
        let script = program(&[
            text_show(recs[0] as u32, recs[1] as u32),
            text_show(recs[0] as u32, no_speaker),
            select(recs[2] as u32),
            select(recs[3] as u32),
        ]);
        (script, textdat)
    }

    #[test]
    fn executes_dialogue_choices_and_control_flow_in_play_order() {
        let (script, textdat) = synthetic();
        let scene = SoftpalScene::execute(&script, &textdat).expect("scene executes");

        assert_eq!(scene.sv_version, *b"20");
        assert_eq!(scene.stats.dialogue_count, 2);
        assert_eq!(scene.stats.choice_menu_count, 1);
        assert_eq!(scene.stats.text_bearing_choice_count, 2);
        assert_eq!(scene.stats.system_select_count, 0);
        assert!(scene.stats.opcode_exhaustive, "0-unknown walk");
        assert!(scene.stats.call_count >= 4, "4 Calls dispatched");

        // Play order: dialogue, dialogue, then the grouped choice menu.
        assert!(matches!(scene.steps[0], SceneStep::Dialogue { .. }));
        assert!(matches!(scene.steps[1], SceneStep::Dialogue { .. }));
        match &scene.steps[2] {
            SceneStep::Choice { options, selected } => {
                assert_eq!(options.len(), 2, "two selects grouped into one menu");
                assert_eq!(*selected, 0, "headless picks the first text-bearing option");
                assert_eq!(options[0].text.as_deref(), Some("go left"));
                assert_eq!(options[1].text.as_deref(), Some("go right"));
            }
            dialogue @ SceneStep::Dialogue { .. } => {
                panic!("expected a choice menu, got {dialogue:?}")
            }
        }

        let lines: Vec<_> = scene.dialogue_lines().collect();
        assert_eq!(lines[0], (Some("Speaker"), "first line"));
        assert_eq!(lines[1], (None, "first line"));
    }

    #[test]
    fn malformed_script_is_a_typed_error_not_a_panic() {
        let (_, textdat) = synthetic();
        let error =
            SoftpalScene::execute(b"XX20not-a-script", &textdat).expect_err("bad magic must fail");
        assert!(
            error.to_string().starts_with("utsushi.softpal.runtime"),
            "carries the runtime namespace: {error}"
        );
    }
}
