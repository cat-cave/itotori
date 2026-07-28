//! Executed `Sv20` moments, backed by the small VM in [`crate::scene_vm`].

use std::collections::HashMap;

use kaifuu_softpal::{
    CommandFamily, FileDat, FileDatError, OpcodeError, OpcodeScan, PacArchive, PacError,
    ScriptError, ScriptScan, TextDat, TextDatError,
};
use serde::{Deserialize, Serialize};

use crate::scene_vm::{ResourceAssets, Vm, point_offsets};

/// Decode the one-based `POINT.DAT` entry table into script-byte offsets.
///
/// These are title-authored destinations, never caller-supplied raw offsets.
///
/// # Errors
///
/// Returns [`SoftpalRuntimeError::InvalidPointTable`] for a malformed table.
pub fn point_entry_offsets(points: &[u8]) -> Result<Vec<usize>, SoftpalRuntimeError> {
    point_offsets(points)
}

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

/// One script-visible destination updated by a native call.  This retains the
/// storage address, never the value stored there, so real-corpus traces can be
/// compared without exposing dialogue or other licensed payloads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeBankWrite {
    pub destination_tag: u8,
    pub destination_slot: u32,
}

/// A text-free execution event used to compare native-call contracts across
/// real corpora.  Calls are recorded before dispatch; a missing return value
/// consequently remains visible when a call is unimplemented and execution
/// stops rather than advancing on an invented result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RuntimeTraceEvent {
    Call {
        offset: usize,
        category: u16,
        function: u16,
        stack_depth: usize,
        destination_tag: Option<u8>,
        return_value: Option<i32>,
        bank_writes: Vec<RuntimeBankWrite>,
    },
    Branch {
        offset: usize,
        taken: bool,
        target_offset: Option<usize>,
    },
}

/// Accounting for a deterministic VM run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftpalSceneStats {
    pub instructions_executed: usize,
    /// Native `0x17` syscall dispatches (not script-function `0x0b` calls).
    pub call_count: usize,
    pub control_count: usize,
    pub dialogue_count: usize,
    pub choice_menu_count: usize,
    pub text_bearing_choice_count: usize,
    pub system_select_count: usize,
    pub branch_count: usize,
    /// Whether the executed path attached the native work-process pump.
    pub work_process_attached: bool,
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
    /// Native-call and branch evidence, deliberately excluding decoded text.
    pub trace: Vec<RuntimeTraceEvent>,
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
        Self::execute_with_points_and_mem_dat(script, textdat, points, None)
    }

    /// Execute with matching labels and an optional `MEM.DAT` asset. Operand
    /// tag `0x6` requires the asset; an absent asset is a named runtime gap.
    pub fn execute_with_points_and_mem_dat(
        script: &[u8],
        textdat: &[u8],
        points: Option<&[u8]>,
        mem_dat: Option<&[u8]>,
    ) -> Result<Self, SoftpalRuntimeError> {
        Self::execute_with_assets(script, textdat, points, mem_dat, None, None)
    }

    /// Execute from a one-based `POINT.DAT` entry id. The id is resolved only
    /// through the supplied byte table; callers cannot supply a raw script
    /// offset. This is the entry surface for title-owned scene dispatchers.
    pub fn execute_from_point_with_points(
        script: &[u8],
        textdat: &[u8],
        points: &[u8],
        point_id: u32,
    ) -> Result<Self, SoftpalRuntimeError> {
        Self::execute_with_assets(script, textdat, Some(points), None, None, Some(point_id))
    }

    /// Execute with the original `data.pac` as the native resource source.
    /// The archive is parsed by `kaifuu-softpal`'s validated PAC reader and
    /// `FILE.DAT` is decoded into resource-name slots for `openfile`.
    pub fn execute_with_points_mem_dat_and_pac(
        script: &[u8],
        textdat: &[u8],
        points: Option<&[u8]>,
        mem_dat: Option<&[u8]>,
        pac_bytes: &[u8],
    ) -> Result<Self, SoftpalRuntimeError> {
        Self::execute_with_points_mem_dat_and_pacs(script, textdat, points, mem_dat, &[pac_bytes])
    }

    /// Execute with every PAC archive that the current native path may open.
    /// The caller supplies archive bytes explicitly; the VM never discovers
    /// host paths or silently falls back to an unrelated file.
    pub fn execute_with_points_mem_dat_and_pacs(
        script: &[u8],
        textdat: &[u8],
        points: Option<&[u8]>,
        mem_dat: Option<&[u8]>,
        pac_bytes: &[&[u8]],
    ) -> Result<Self, SoftpalRuntimeError> {
        let archives = pac_bytes
            .iter()
            .map(|bytes| PacArchive::parse(bytes).map(|archive| (archive, *bytes)))
            .collect::<Result<Vec<_>, _>>()?;
        let (file_archive, file_bytes) = archives
            .iter()
            .find(|(archive, _)| archive.find("FILE.DAT").is_some())
            .ok_or(SoftpalRuntimeError::FileDatMissing)?;
        let file_entry = file_archive.find("FILE.DAT").expect("located above");
        let file_dat = FileDat::parse(file_archive.extract(file_bytes, file_entry)?)?;
        Self::execute_with_assets(
            script,
            textdat,
            points,
            mem_dat,
            Some(ResourceAssets { archives, file_dat }),
            None,
        )
    }

    /// Execute a byte-designated `POINT.DAT` entry with every PAC archive the
    /// current native path may open. As with [`Self::execute_from_point_with_points`],
    /// a raw script offset is intentionally not accepted.
    pub fn execute_from_point_with_points_mem_dat_and_pacs(
        script: &[u8],
        textdat: &[u8],
        points: &[u8],
        mem_dat: Option<&[u8]>,
        pac_bytes: &[&[u8]],
        point_id: u32,
    ) -> Result<Self, SoftpalRuntimeError> {
        let archives = pac_bytes
            .iter()
            .map(|bytes| PacArchive::parse(bytes).map(|archive| (archive, *bytes)))
            .collect::<Result<Vec<_>, _>>()?;
        let (file_archive, file_bytes) = archives
            .iter()
            .find(|(archive, _)| archive.find("FILE.DAT").is_some())
            .ok_or(SoftpalRuntimeError::FileDatMissing)?;
        let file_entry = file_archive.find("FILE.DAT").expect("located above");
        let file_dat = FileDat::parse(file_archive.extract(file_bytes, file_entry)?)?;
        Self::execute_with_assets(
            script,
            textdat,
            Some(points),
            mem_dat,
            Some(ResourceAssets { archives, file_dat }),
            Some(point_id),
        )
    }

    fn execute_with_assets(
        script: &[u8],
        textdat: &[u8],
        points: Option<&[u8]>,
        mem_dat: Option<&[u8]>,
        resources: Option<ResourceAssets<'_>>,
        entry_point: Option<u32>,
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
        let entry_ip = match entry_point {
            None => 0,
            Some(0) => {
                return Err(SoftpalRuntimeError::PointEntryOutOfRange {
                    point_id: 0,
                    point_count: labels.len(),
                });
            }
            Some(point_id) => {
                let offset = *labels.get((point_id - 1) as usize).ok_or(
                    SoftpalRuntimeError::PointEntryOutOfRange {
                        point_id,
                        point_count: labels.len(),
                    },
                )?;
                walk.instructions
                    .iter()
                    .position(|instruction| instruction.offset == offset)
                    .ok_or(SoftpalRuntimeError::PointEntryNotInstruction { point_id, offset })?
            }
        };
        let mut result = Vm::new(
            &walk,
            &scan.commands,
            &labels,
            &texts,
            mem_dat,
            resources,
            entry_ip,
        )
        .run();
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
            trace: result.trace,
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
                work_process_attached: result.work_process_attached,
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
    #[error("utsushi.softpal.runtime.pac: {0}")]
    Pac(#[from] PacError),
    #[error("utsushi.softpal.runtime.filedat: {0}")]
    FileDat(#[from] FileDatError),
    #[error("utsushi.softpal.runtime.filedat_missing: PAC has no FILE.DAT entry")]
    FileDatMissing,
    #[error("utsushi.softpal.runtime.point_table: POINT.DAT is malformed")]
    InvalidPointTable,
    #[error(
        "utsushi.softpal.runtime.point_entry_out_of_range: point {point_id} is outside the {point_count}-entry POINT.DAT table"
    )]
    PointEntryOutOfRange { point_id: u32, point_count: usize },
    #[error(
        "utsushi.softpal.runtime.point_entry_not_instruction: point {point_id} resolves to non-instruction offset {offset}"
    )]
    PointEntryNotInstruction { point_id: u32, offset: usize },
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
    use kaifuu_softpal::{
        FILEDAT_MAGIC_TAIL, FILEDAT_SLOT_BYTE_LEN, PAC_HEADER_BYTE_LEN, PAC_INDEX_ENTRY_BYTE_LEN,
        SCRIPT_MAGIC_PREFIX, TEXTDAT_FLAG_PLAINTEXT, TEXTDAT_MAGIC_TAIL,
    };

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
    fn filedat(slots: &[&str]) -> Vec<u8> {
        let mut bytes = Vec::from(*b"_");
        bytes.extend_from_slice(FILEDAT_MAGIC_TAIL);
        bytes.extend_from_slice(&(slots.len() as u32).to_le_bytes());
        for value in slots {
            let mut slot = [0_u8; FILEDAT_SLOT_BYTE_LEN];
            slot[..value.len()].copy_from_slice(value.as_bytes());
            bytes.extend_from_slice(&slot);
        }
        bytes
    }
    fn pac(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let index_end = PAC_HEADER_BYTE_LEN + entries.len() * PAC_INDEX_ENTRY_BYTE_LEN;
        let mut bytes = vec![0_u8; index_end];
        bytes[..4].copy_from_slice(b"PAC ");
        bytes[8..12].copy_from_slice(&(entries.len() as u32).to_le_bytes());
        let mut payload_offset = index_end;
        for (index, (name, payload)) in entries.iter().enumerate() {
            let entry_offset = PAC_HEADER_BYTE_LEN + index * PAC_INDEX_ENTRY_BYTE_LEN;
            bytes[entry_offset..entry_offset + name.len()].copy_from_slice(name.as_bytes());
            bytes[entry_offset + 32..entry_offset + 36]
                .copy_from_slice(&(payload.len() as u32).to_le_bytes());
            bytes[entry_offset + 36..entry_offset + 40]
                .copy_from_slice(&(payload_offset as u32).to_le_bytes());
            payload_offset += payload.len();
        }
        for (_, payload) in entries {
            bytes.extend_from_slice(payload);
        }
        bytes
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
    fn executes_a_reachable_message_syscall_through_the_text_path() {
        let (textdat, pointer) = textdat();
        // The reference's message syscall is the same push-then-0x17 shape
        // that ScriptScan resolves: text, absent speaker, message value, then
        // native target 0x0002:0x0002.
        let scene = SoftpalScene::execute(
            &program(&[
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
            ]),
            &textdat,
        )
        .expect("message syscall is a valid scene");

        assert_eq!(scene.stats.dialogue_count, 1);
        assert_eq!(scene.stats.call_count, 1);
        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.steps,
            vec![SceneStep::Dialogue {
                command_offset: 12,
                speaker: None,
                text: "line".to_string(),
            }]
        );
    }

    #[test]
    fn executes_only_a_point_table_designated_message_entry() {
        // The root ends before the message. Point id 1 is the sole permitted
        // alternative entry, encoded in POINT.DAT as a header-relative offset;
        // replacing the entry resolver with a raw/default IP makes this fail.
        let (textdat, pointer) = textdat();
        let script = program(&[
            op(0x15),
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
        ]);
        let mut points = Vec::from(&b"_POINT_LIST_****"[..]);
        points.extend_from_slice(&4_u32.to_le_bytes());

        let scene = SoftpalScene::execute_from_point_with_points(&script, &textdat, &points, 1)
            .expect("point-table entry executes");
        assert_eq!(scene.stats.instructions_executed, 5);
        assert_eq!(scene.stats.dialogue_count, 1);
        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.steps,
            vec![SceneStep::Dialogue {
                command_offset: 16,
                speaker: None,
                text: "line".to_string(),
            }]
        );
        assert!(matches!(
            SoftpalScene::execute_from_point_with_points(&script, &textdat, &points, 2),
            Err(SoftpalRuntimeError::PointEntryOutOfRange {
                point_id: 2,
                point_count: 1,
            })
        ));
    }

    #[test]
    fn debug_window_state_returns_the_previous_value_and_controls_flow() {
        let (textdat, pointer) = textdat();
        // Two state swaps should return 0 then 3. `not(local2)` is zero only
        // when the second call returned the state installed by the first; the
        // jump then bypasses the message. A gutted state exchange emits it.
        let tokens = [
            op(0x1f),
            word(3),
            op(0x17),
            word(0x000f_0005),
            word(0x4000_0001),
            op(0x1f),
            word(9),
            op(0x17),
            word(0x000f_0005),
            word(0x4000_0002),
            op(0x14),
            word(0x4000_0002),
            op(0x0a),
            word(1),
            word(0x4000_0002),
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
        points.extend_from_slice(&96_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("stateful debug calls execute");
        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.stats.dialogue_count, 0,
            "state return bypasses message"
        );
        assert_eq!(
            scene.stats.branch_count, 2,
            "conditional plus its taken jump"
        );
    }

    #[test]
    fn bgv_volume_round_trip_controls_execution() {
        let (textdat, pointer) = textdat();
        // The setter must consume and retain 73; the query must return that
        // retained value. Deleting either implementation makes the equality
        // false and reaches the decoded message at point 1.
        let tokens = [
            op(0x1f),
            word(73),
            op(0x17),
            word(0x000d_0015),
            word(0x4000_0001),
            op(0x17),
            word(0x000d_0016),
            word(0x4000_0002),
            op(0x0c),
            word(0x4000_0002),
            word(73),
            op(0x0a),
            word(1),
            word(0x4000_0002),
            op(0x15),
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
        points.extend_from_slice(&60_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("BGV-volume calls execute");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.stats.dialogue_count, 0,
            "stored volume bypasses message"
        );
        assert_eq!(scene.stats.branch_count, 1);
    }

    #[test]
    fn set_last_process_consumes_its_point_before_the_next_native_call() {
        let (textdat, pointer) = textdat();
        // 0023's cache has no compact scheduler consumer yet, so this checks
        // its observable stack contract: it must remove point 9 before the
        // following BGV setter consumes 73. Leaving 9 on the stack makes the
        // BGV query fail the comparison and emits the decoded message.
        let tokens = [
            op(0x1f),
            word(73),
            op(0x1f),
            word(9),
            op(0x17),
            word(0x0012_0023),
            word(0x4000_0001),
            op(0x17),
            word(0x000d_0015),
            word(0x4000_0002),
            op(0x17),
            word(0x000d_0016),
            word(0x4000_0003),
            op(0x0c),
            word(0x4000_0003),
            word(73),
            op(0x0a),
            word(1),
            word(0x4000_0003),
            op(0x15),
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
        points.extend_from_slice(&80_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("set-last-process call executes");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(scene.stats.dialogue_count, 0, "point id was consumed");
        assert_eq!(scene.stats.branch_count, 1);
    }

    #[test]
    fn scene_skip_cancel_returns_success_and_bypasses_failure_path() {
        let (textdat, pointer) = textdat();
        // Category 9/index 52 consumes no arguments and returns success. If
        // its implementation is removed or reduced to a pass-through, local 1
        // remains zero and the conditional reaches the message at point 1.
        let tokens = [
            op(0x17),
            word(0x0009_0034),
            word(0x4000_0001),
            op(0x0a),
            word(1),
            word(0x4000_0001),
            op(0x15),
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
        points.extend_from_slice(&28_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("scene-skip cancellation executes");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.stats.dialogue_count, 0,
            "success bypasses failure message"
        );
        assert_eq!(scene.stats.branch_count, 1);
    }

    #[test]
    fn auto_set_consumes_its_flag_and_returns_success() {
        let (textdat, pointer) = textdat();
        // The setter must consume its input and write success. A gutted
        // implementation either stops at the named call or leaves local 1 at
        // zero, which takes point 1 and emits this message.
        let tokens = [
            op(0x1f),
            word(1),
            op(0x17),
            word(0x0009_0002),
            word(0x4000_0001),
            op(0x0a),
            word(1),
            word(0x4000_0001),
            op(0x15),
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
        points.extend_from_slice(&36_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("auto setter executes");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.stats.dialogue_count, 0,
            "success bypasses failure message"
        );
        assert_eq!(scene.stats.branch_count, 1);
    }

    #[test]
    fn user_memory_read_and_write_control_execution_at_the_proven_bank_boundary() {
        let (textdat, pointer) = textdat();
        // Set vars[1] = 0xffff, write 7 through tag 1, and read it back into
        // local 2. The equality controls a branch that bypasses the message.
        // Removing either tag-1 access makes local 2 zero and emits the line.
        let tokens = [
            op(1),
            word(0x4000_0001),
            word(0xffff),
            op(1),
            word(0x1000_0001),
            word(7),
            op(1),
            word(0x4000_0002),
            word(0x1000_0001),
            op(0x0c),
            word(0x4000_0002),
            word(7),
            op(0x0a),
            word(1),
            word(0x4000_0002),
            op(0x15),
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
        points.extend_from_slice(&64_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("user-memory path executes");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.stats.dialogue_count, 0,
            "bank round-trip bypasses message"
        );
        assert_eq!(scene.stats.branch_count, 1);
    }

    #[test]
    fn user_memory_stops_visibly_when_the_indirect_index_is_out_of_range() {
        let (textdat, _) = textdat();
        let scene = SoftpalScene::execute(
            &program(&[
                op(1),
                word(0x4000_0001),
                word(0x1_0000),
                op(1),
                word(0x4000_0002),
                word(0x1000_0001),
                op(0x15),
            ]),
            &textdat,
        )
        .expect("out-of-range operand remains decodable");

        assert_eq!(
            scene.diagnostics,
            vec![RuntimeDiagnostic {
                signature: "user_mem_index_out_of_range".to_string(),
                offset: 24,
            }]
        );
        assert_eq!(scene.stats.instructions_executed, 2);
    }

    #[test]
    fn user_memory_write_stops_visibly_when_the_indirect_index_is_out_of_range() {
        let (textdat, _) = textdat();
        let scene = SoftpalScene::execute(
            &program(&[
                op(1),
                word(0x4000_0001),
                word(0x1_0000),
                op(0x1f),
                word(7),
                op(0x1e),
                word(0x1000_0001),
                op(0x15),
            ]),
            &textdat,
        )
        .expect("out-of-range destination remains decodable");

        assert_eq!(
            scene.diagnostics,
            vec![RuntimeDiagnostic {
                signature: "user_mem_index_out_of_range".to_string(),
                offset: 32,
            }]
        );
        assert_eq!(scene.stats.instructions_executed, 3);
    }

    #[test]
    fn system_task_value_returns_the_active_latch_value_to_control_execution() {
        let (textdat, pointer) = textdat();
        // The zero-argument call returns one. If its modeled result is gutted,
        // the conditional reaches the message instead of bypassing it.
        let tokens = [
            op(0x17),
            word(0x0012_000f),
            word(0x4000_0001),
            op(0x0a),
            word(1),
            word(0x4000_0001),
            op(0x15),
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
        points.extend_from_slice(&28_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("system task value executes");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.stats.dialogue_count, 0,
            "success bypasses failure message"
        );
        assert_eq!(scene.stats.branch_count, 1);
    }

    #[test]
    fn string_alloc_consumes_its_argument_and_returns_a_nonzero_dynamic_handle() {
        let (textdat, pointer) = textdat();
        // A real allocation returns a nonzero handle. If it is gutted, reduced
        // to zero, or does not consume the source stack value, the conditional
        // reaches the message or a later call observes a corrupted stack.
        let tokens = [
            op(0x1f),
            word(99),
            op(0x17),
            word(0x0012_0006),
            word(0x4000_0001),
            op(0x14),
            word(0x4000_0001),
            op(0x0a),
            word(1),
            word(0x4000_0001),
            op(0x15),
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
        points.extend_from_slice(&80_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("string allocation executes");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.stats.dialogue_count, 0,
            "handle bypasses failure message"
        );
        assert_eq!(scene.stats.branch_count, 2);
    }

    #[test]
    fn openfile_reads_the_pac_payload_named_by_its_filedat_slot() {
        let (textdat, pointer) = textdat();
        let filedat = filedat(&["FONT.DAT"]);
        let archive = pac(&[("FILE.DAT", filedat.as_slice()), ("FONT.DAT", &[7, 8, 9])]);
        // The open result becomes the read handle. The first byte read through
        // that handle must equal the PAC payload's 7; otherwise the branch
        // reaches the message. Deleting open/read or replacing the table with
        // a fixed success return therefore fails this behavior test.
        let tokens = [
            op(0x1f),
            word(0),
            op(0x17),
            word(0x0012_001e),
            word(0x4000_0001),
            op(0x1f),
            word(3),
            op(0x1f),
            word(12),
            op(0x1f),
            word(0x4000_0001),
            op(0x17),
            word(0x0012_001f),
            word(0x4000_0002),
            op(1),
            word(0x4000_0003),
            word(12),
            op(1),
            word(0x4000_0004),
            word(0x5000_0003),
            op(0x0c),
            word(0x4000_0004),
            word(7),
            op(0x14),
            word(0x4000_0004),
            op(0x0a),
            word(1),
            word(0x4000_0004),
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
        points.extend_from_slice(&148_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points_mem_dat_and_pac(
            &program(&tokens),
            &textdat,
            Some(&points),
            None,
            &archive,
        )
        .expect("PAC-backed file path executes");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(scene.stats.dialogue_count, 0, "PAC byte bypasses message");
        assert_eq!(scene.stats.branch_count, 2);
    }

    #[test]
    fn openfile_stops_visibly_when_the_resolved_pac_entry_is_absent() {
        let (textdat, _) = textdat();
        let filedat = filedat(&["MISSING.DAT"]);
        let archive = pac(&[("FILE.DAT", filedat.as_slice())]);
        let scene = SoftpalScene::execute_with_points_mem_dat_and_pac(
            &program(&[
                op(0x1f),
                word(0),
                op(0x17),
                word(0x0012_001e),
                word(0),
                op(0x15),
            ]),
            &textdat,
            None,
            None,
            &archive,
        )
        .expect("well-formed input retains a named runtime failure");

        assert_eq!(
            scene.diagnostics,
            vec![RuntimeDiagnostic {
                signature: "openfile_pac_entry_missing".to_string(),
                offset: 20,
            }]
        );
    }
}
