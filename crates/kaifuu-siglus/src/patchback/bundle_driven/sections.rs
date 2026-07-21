//! `S_tnm_scn_header` section-directory relocation for string-table splices.
//!
//! Siglus stores every section start as an absolute byte offset from the
//! decompressed scene payload. The paired fields are element counts (and field
//! two is the bytecode byte length), not byte positions. A resized string entry
//! therefore relocates every later section start, but does not change the
//! bytecode's size, label offsets, command offsets, or string ids: those all
//! remain relative to their own sections or identify table entries by index.

use super::PatchbackError;

use crate::opcode::{SCN_HEADER_BYTE_LEN, SCN_HEADER_DECLARED_SIZE};

const HEADER_FIELD_COUNT: usize = SCN_HEADER_BYTE_LEN / 4;
const OFFSET_FIELDS: [usize; 16] = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31];

/// One source-coordinate string replacement.
#[derive(Debug, Clone, Copy)]
pub(super) struct SectionSplice {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) replacement_len: usize,
}

/// The complete fixed scene-header directory, retained so all section starts
/// can be relocated together after a splice.
#[derive(Debug, Clone)]
pub(super) struct SceneSections {
    fields: [i32; HEADER_FIELD_COUNT],
}

impl SceneSections {
    /// Parse the fixed scene header before mutating its payload. The bytecode
    /// partitioner performs the same declared-size check; doing it here keeps a
    /// length-changing splice from moving an unrecognized header shape.
    pub(super) fn parse(decoded: &[u8], scene_id: u32) -> Result<Self, PatchbackError> {
        if decoded.len() < SCN_HEADER_BYTE_LEN {
            return Err(scene_error(scene_id, "truncated scene section directory"));
        }
        let fields = std::array::from_fn(|index| {
            let at = index * 4;
            i32::from_le_bytes(
                decoded[at..at + 4]
                    .try_into()
                    .expect("header bounds checked"),
            )
        });
        if fields[0] != SCN_HEADER_DECLARED_SIZE {
            return Err(scene_error(
                scene_id,
                format!("unexpected scene header size {:#x}", fields[0]),
            ));
        }
        Ok(Self { fields })
    }

    /// Relocate every absolute section start after the supplied source spans.
    /// A header coordinate inside a replaced string is ambiguous (the only
    /// valid one is the string-section start itself), so it is rejected rather
    /// than silently pointing into a newly-sized literal.
    pub(super) fn relocated(
        &self,
        splices: &[SectionSplice],
        scene_id: u32,
    ) -> Result<Self, PatchbackError> {
        let mut fields = self.fields;
        for field in OFFSET_FIELDS {
            let value = self.fields[field];
            if value <= 0 {
                continue;
            }
            let offset = value as usize;
            let relocated = relocate_offset(offset, splices, scene_id)?;
            fields[field] = i32::try_from(relocated)
                .map_err(|_| scene_error(scene_id, "relocated section offset exceeds i32"))?;
        }
        Ok(Self { fields })
    }

    /// Absolute byte offset of a named section in this version of the header.
    pub(super) fn offset(&self, field: usize, scene_id: u32) -> Result<usize, PatchbackError> {
        let value = self
            .fields
            .get(field)
            .copied()
            .ok_or_else(|| scene_error(scene_id, "invalid section-directory field"))?;
        if value < 0 {
            return Err(scene_error(scene_id, "negative section-directory offset"));
        }
        Ok(value as usize)
    }

    /// Write the relocated directory back into the untouched fixed header.
    pub(super) fn write_to(&self, output: &mut [u8], scene_id: u32) -> Result<(), PatchbackError> {
        let header = output
            .get_mut(..SCN_HEADER_BYTE_LEN)
            .ok_or_else(|| scene_error(scene_id, "relocated scene lacks a full header"))?;
        for (index, value) in self.fields.iter().enumerate() {
            let at = index * 4;
            header[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        Ok(())
    }
}

fn relocate_offset(
    original: usize,
    splices: &[SectionSplice],
    scene_id: u32,
) -> Result<usize, PatchbackError> {
    let mut relocated = i64::try_from(original)
        .map_err(|_| scene_error(scene_id, "section offset does not fit i64"))?;
    for splice in splices {
        if splice.start < original && original < splice.end {
            return Err(scene_error(
                scene_id,
                "section directory points inside a replaced string span",
            ));
        }
        if splice.end <= original {
            let old_len = i64::try_from(splice.end - splice.start)
                .map_err(|_| scene_error(scene_id, "string span does not fit i64"))?;
            let new_len = i64::try_from(splice.replacement_len)
                .map_err(|_| scene_error(scene_id, "replacement span does not fit i64"))?;
            relocated = relocated
                .checked_add(new_len - old_len)
                .ok_or_else(|| scene_error(scene_id, "relocated section offset overflow"))?;
        }
    }
    usize::try_from(relocated)
        .map_err(|_| scene_error(scene_id, "relocated section offset became negative"))
}

fn scene_error(scene_id: u32, message: impl Into<String>) -> PatchbackError {
    PatchbackError::SceneReencode {
        scene_id,
        message: message.into(),
    }
}
