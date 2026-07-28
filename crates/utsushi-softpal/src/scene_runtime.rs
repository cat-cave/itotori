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
    include!("scene_runtime/scene_runtime_test_support.rs");
    include!("scene_runtime/scene_runtime_test_calls.rs");
    include!("scene_runtime/scene_runtime_test_banks.rs");
}
