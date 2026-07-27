//! Compilation of one decoded scene into a VM-addressable program.

use std::collections::BTreeMap;

use kaifuu_siglus::{SiglusInstruction, SiglusOperand, decode_operand, partition_scene};
use thiserror::Error;

/// Decoded, executable instruction with its bytecode coordinate retained.
#[derive(Debug, Clone)]
pub(crate) struct VmInstruction {
    pub(crate) instruction: SiglusInstruction,
    pub(crate) operand: SiglusOperand,
}

/// A real decoded scene prepared for deterministic VM dispatch.
#[derive(Debug, Clone)]
pub struct SceneProgram {
    pub(crate) scene_id: u32,
    pub(crate) instructions: Vec<VmInstruction>,
    pub(crate) offsets: BTreeMap<usize, usize>,
    pub(crate) labels: Vec<usize>,
    pub(crate) functions: Vec<Option<usize>>,
    pub(crate) strings: BTreeMap<i32, String>,
}

/// Scene-program construction failure. No bytecode is skipped on an error.
#[derive(Debug, Error)]
pub enum SceneProgramError {
    /// Kaifuu rejected the decompressed scene envelope.
    #[error("utsushi.siglus.vm.partition: {0}")]
    Partition(#[from] kaifuu_siglus::SiglusParseError),
    /// An instruction's exact assigned operand span did not decode.
    #[error("utsushi.siglus.vm.operand: {0}")]
    Operand(#[from] kaifuu_siglus::SiglusExpressionError),
    /// A header table cannot describe an executable instruction boundary.
    #[error(
        "utsushi.siglus.vm.invalid_label: label {label} targets non-instruction offset {offset}"
    )]
    InvalidLabel { label: usize, offset: usize },
}

impl SceneProgram {
    /// Decode one decompressed `S_tnm_scn` payload. The caller owns container
    /// decryption/decompression and can use `kaifuu_siglus::decode_scene_chunk`.
    pub fn from_payload(scene_id: u32, payload: &[u8]) -> Result<Self, SceneProgramError> {
        let partition = partition_scene(payload)?;
        let scn_offset = field(payload, 1).max(0) as usize;
        let bytecode = &payload[scn_offset..scn_offset + partition.bytecode_len];
        let mut offsets = BTreeMap::new();
        let mut instructions = Vec::with_capacity(partition.instructions.len());
        for instruction in partition.instructions {
            let index = instructions.len();
            offsets.insert(instruction.byte_offset, index);
            let operand = decode_operand(bytecode, &instruction)?;
            instructions.push(VmInstruction {
                instruction,
                operand,
            });
        }
        let labels = i32_table(payload, field(payload, 7), field(payload, 8))
            .into_iter()
            .map(|offset| offset.max(0) as usize)
            .enumerate()
            .map(|(label, offset)| {
                offsets
                    .contains_key(&offset)
                    .then_some(offset)
                    .ok_or(SceneProgramError::InvalidLabel { label, offset })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let functions = i32_table(payload, field(payload, 19), field(payload, 20))
            .into_iter()
            .map(|offset| {
                if offset < 0 {
                    return Ok(None);
                }
                offsets.get(&(offset as usize)).copied().map(Some).ok_or(
                    SceneProgramError::InvalidLabel {
                        label: usize::MAX,
                        offset: offset as usize,
                    },
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            scene_id,
            instructions,
            offsets,
            labels,
            functions,
            strings: strings(payload),
        })
    }

    pub(crate) fn target(&self, label: i32) -> Option<usize> {
        usize::try_from(label)
            .ok()
            .and_then(|index| self.labels.get(index))
            .and_then(|offset| self.offsets.get(offset))
            .copied()
    }

    pub(crate) fn function(&self, index: i32) -> Option<usize> {
        usize::try_from(index)
            .ok()
            .and_then(|index| self.functions.get(index))
            .copied()
            .flatten()
    }
}

fn field(payload: &[u8], index: usize) -> i32 {
    let start = index * 4;
    payload.get(start..start + 4).map_or(0, |raw| {
        i32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]])
    })
}

fn i32_table(payload: &[u8], offset: i32, count: i32) -> Vec<i32> {
    if offset < 0 || count < 0 {
        return Vec::new();
    }
    (0..count as usize)
        .filter_map(|index| {
            let start = offset as usize + index * 4;
            payload
                .get(start..start + 4)
                .map(|raw| i32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))
        })
        .collect()
}

fn strings(payload: &[u8]) -> BTreeMap<i32, String> {
    let index_offset = field(payload, 3);
    let count = field(payload, 4);
    let list_offset = field(payload, 5).max(0) as usize;
    if index_offset < 0 || count < 0 {
        return BTreeMap::new();
    }
    (0..count as usize)
        .filter_map(|index| {
            let start = index_offset as usize + index * 8;
            let raw = payload.get(start..start + 8)?;
            let chars = i32::from_le_bytes(raw[0..4].try_into().ok()?);
            let len = i32::from_le_bytes(raw[4..8].try_into().ok()?);
            let chars = usize::try_from(chars).ok()?;
            let len = usize::try_from(len).ok()?;
            let start = list_offset.checked_add(chars.checked_mul(2)?)?;
            let end = start.checked_add(len.checked_mul(2)?)?;
            let units = payload.get(start..end)?.chunks_exact(2).map(|pair| {
                u16::from_le_bytes([pair[0], pair[1]]) ^ 28807_u16.wrapping_mul(index as u16)
            });
            Some((
                index as i32,
                String::from_utf16_lossy(&units.take_while(|unit| *unit != 0).collect::<Vec<_>>()),
            ))
        })
        .collect()
}
