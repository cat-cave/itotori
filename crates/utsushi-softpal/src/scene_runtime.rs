//! Executed `Sv20` moments, backed by the small VM in [`crate::scene_vm`].

use std::collections::HashMap;

use kaifuu_softpal::{
    CommandFamily, OpcodeError, OpcodeScan, ScriptError, ScriptScan, TextDat, TextDatError,
};
use serde::{Deserialize, Serialize};

use crate::scene_vm::{Vm, point_offsets};

/// A visible moment in deterministic execution order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SceneStep {
    Dialogue {
        command_offset: usize,
        speaker: Option<String>,
        text: String,
    },
    Choice {
        options: Vec<ChoiceOption>,
        selected: usize,
    },
    Branch {
        command_offset: usize,
        taken: bool,
        target_offset: Option<usize>,
    },
}

/// A choice option presented by an executed SELECT call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceOption {
    pub command_offset: usize,
    pub text: Option<String>,
}

impl ChoiceOption {
    #[must_use]
    pub fn is_text_bearing(&self) -> bool {
        self.text.is_some()
    }
}

/// A distinct construct where execution deliberately stopped.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostic {
    pub signature: String,
    pub offset: usize,
}

/// Accounting for a deterministic VM run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftpalSceneStats {
    pub instructions_executed: usize,
    pub call_count: usize,
    pub control_count: usize,
    pub dialogue_count: usize,
    pub choice_menu_count: usize,
    pub text_bearing_choice_count: usize,
    pub system_select_count: usize,
    pub branch_count: usize,
    pub unresolved_construct_count: usize,
    pub opcode_exhaustive: bool,
}

/// One deterministic run of the script's VM entrypoint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftpalScene {
    pub sv_version: [u8; 2],
    pub steps: Vec<SceneStep>,
    pub diagnostics: Vec<RuntimeDiagnostic>,
    pub stats: SoftpalSceneStats,
}

impl SoftpalScene {
    /// Execute a script without labels. Label-dependent programs stop with a
    /// diagnostic rather than following an invented target.
    pub fn execute(script: &[u8], textdat: &[u8]) -> Result<Self, SoftpalRuntimeError> {
        Self::execute_with_points(script, textdat, None)
    }

    /// Execute with the matching `POINT.DAT` label table when supplied.
    pub fn execute_with_points(
        script: &[u8],
        textdat: &[u8],
        points: Option<&[u8]>,
    ) -> Result<Self, SoftpalRuntimeError> {
        let walk = OpcodeScan::parse(script)?;
        let scan = ScriptScan::parse(script)?;
        let textdat = TextDat::parse(textdat)?;
        let disassembly = scan.resolve(&textdat);
        if !disassembly.is_fully_resolved() {
            return Err(SoftpalRuntimeError::UnresolvedDisassembly {
                dangling: disassembly.dangling_pointer_count(),
                unresolved_dialogue: disassembly.unresolved_dialogue_text_count(),
                unresolved_speaker: disassembly.unresolved_speaker_count(),
            });
        }
        let texts = textdat
            .records
            .iter()
            .filter_map(|record| {
                u32::try_from(record.offset)
                    .ok()
                    .map(|offset| (offset, record.text.clone()))
            })
            .collect();
        let needs_labels = walk
            .instructions
            .iter()
            .any(|instruction| matches!(instruction.opcode.id(), 0x09..=0x0b));
        let labels = match points {
            Some(bytes) => point_offsets(bytes)?,
            None if needs_labels => Vec::new(),
            None => Vec::new(),
        };
        let mut result = Vm::new(&walk, &scan.commands, &labels, &texts).run();
        if needs_labels && points.is_none() && result.diagnostics.is_empty() {
            result.diagnostics.push(RuntimeDiagnostic {
                signature: "point_table_required".to_string(),
                offset: 12,
            });
        }
        finalize_choices(&mut result.steps);
        let dialogue_count = result
            .steps
            .iter()
            .filter(|step| matches!(step, SceneStep::Dialogue { .. }))
            .count();
        let choices: Vec<_> = result
            .steps
            .iter()
            .filter_map(|step| match step {
                SceneStep::Choice { options, .. } => Some(options),
                _ => None,
            })
            .flatten()
            .collect();
        let text_bearing_choice_count = choices
            .iter()
            .filter(|choice| choice.is_text_bearing())
            .count();
        Ok(Self {
            sv_version: scan.header.version,
            stats: SoftpalSceneStats {
                instructions_executed: result.instructions,
                call_count: walk.call_count(),
                control_count: walk
                    .instructions
                    .iter()
                    .filter(|instruction| matches!(instruction.family, CommandFamily::Control))
                    .count(),
                dialogue_count,
                choice_menu_count: result
                    .steps
                    .iter()
                    .filter(|step| matches!(step, SceneStep::Choice { .. }))
                    .count(),
                text_bearing_choice_count,
                system_select_count: choices.len() - text_bearing_choice_count,
                branch_count: result.branches,
                unresolved_construct_count: result.diagnostics.len(),
                opcode_exhaustive: walk.is_exhaustive(),
            },
            steps: result.steps,
            diagnostics: result.diagnostics,
        })
    }

    pub fn dialogue_lines(&self) -> impl Iterator<Item = (Option<&str>, &str)> {
        self.steps.iter().filter_map(|step| match step {
            SceneStep::Dialogue { speaker, text, .. } => Some((speaker.as_deref(), text.as_str())),
            _ => None,
        })
    }

    #[must_use]
    pub fn diagnostic_frequencies(&self) -> HashMap<&str, usize> {
        let mut frequencies = HashMap::new();
        for diagnostic in &self.diagnostics {
            *frequencies
                .entry(diagnostic.signature.as_str())
                .or_default() += 1;
        }
        frequencies
    }
}

fn finalize_choices(steps: &mut [SceneStep]) {
    for step in steps {
        if let SceneStep::Choice { options, selected } = step {
            *selected = options
                .iter()
                .position(ChoiceOption::is_text_bearing)
                .unwrap_or(0);
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SoftpalRuntimeError {
    #[error("utsushi.softpal.runtime.opcode: {0}")]
    Opcode(#[from] OpcodeError),
    #[error("utsushi.softpal.runtime.script: {0}")]
    Script(#[from] ScriptError),
    #[error("utsushi.softpal.runtime.textdat: {0}")]
    TextDat(#[from] TextDatError),
    #[error("utsushi.softpal.runtime.point_table: POINT.DAT is malformed")]
    InvalidPointTable,
    #[error(
        "utsushi.softpal.runtime.unresolved_disassembly: dangling={dangling} unresolved_dialogue={unresolved_dialogue} unresolved_speaker={unresolved_speaker}"
    )]
    UnresolvedDisassembly {
        dangling: usize,
        unresolved_dialogue: usize,
        unresolved_speaker: usize,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaifuu_softpal::{SCRIPT_MAGIC_PREFIX, TEXTDAT_FLAG_PLAINTEXT, TEXTDAT_MAGIC_TAIL};

    fn op(id: u16) -> [u8; 4] {
        let mut token = [0; 4];
        token[..2].copy_from_slice(&id.to_le_bytes());
        token[2..].copy_from_slice(&1_u16.to_le_bytes());
        token
    }
    fn word(value: u32) -> [u8; 4] {
        value.to_le_bytes()
    }
    fn program(tokens: &[[u8; 4]]) -> Vec<u8> {
        let mut bytes = Vec::from(&SCRIPT_MAGIC_PREFIX[..]);
        bytes.extend_from_slice(b"20");
        bytes.extend_from_slice(&[0; 8]);
        for token in tokens {
            bytes.extend_from_slice(token);
        }
        bytes
    }
    fn textdat() -> (Vec<u8>, u32) {
        let mut bytes = vec![TEXTDAT_FLAG_PLAINTEXT];
        bytes.extend_from_slice(TEXTDAT_MAGIC_TAIL);
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        let pointer = bytes.len() as u32;
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(b"line\0");
        (bytes, pointer)
    }

    #[test]
    fn evaluates_a_condition_and_takes_only_its_target_branch() {
        let (textdat, pointer) = textdat();
        // Labels reverse to offsets 12, 44, and 80. `jz label 2, local 1` is
        // not taken; `jmp label 3` bypasses the message at label 2. Returning a
        // constant zero from the evaluator makes this test emit that message.
        let tokens = [
            op(1),
            word(0x4000_0001),
            word(1),
            op(0x0a),
            word(2),
            word(0x4000_0001),
            op(9),
            word(3),
            op(0x1f),
            word(pointer),
            op(0x1f),
            word(0x0fff_ffff),
            op(0x1f),
            word(0),
            op(0x17),
            word(0x0002_0002),
            word(0),
            op(0x15),
        ];
        let mut points = Vec::from(&b"_POINT_LIST_****"[..]);
        for offset in [68_u32, 32, 0] {
            points.extend_from_slice(&offset.to_le_bytes());
        }
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("executes");
        assert_eq!(scene.stats.branch_count, 2);
        assert_eq!(scene.stats.dialogue_count, 0, "taken jump bypasses message");
        assert!(
            scene.diagnostics.is_empty(),
            "fully determined synthetic path"
        );
    }

    #[test]
    fn refuses_debug_window_state_call_without_inventing_host_state() {
        let (textdat, _) = textdat();
        let scene = SoftpalScene::execute(
            &program(&[op(0x1f), word(0), op(0x17), word(0x000f_0005), word(0)]),
            &textdat,
        )
        .expect("valid script shape");
        assert_eq!(scene.stats.instructions_executed, 2);
        assert_eq!(
            scene.diagnostics,
            vec![RuntimeDiagnostic {
                signature: "debug_window_state_unavailable".to_string(),
                offset: 20,
            }],
            "the registered handler consumes a value and swaps an external debug-window state"
        );
    }
}
