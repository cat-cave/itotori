use super::{LongOpId, module_sel::SelectionPromptKind};

/// One selection pause observed by the replay runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectionPrompt {
    pub longop_id: LongOpId,
    /// Emitting command's scene-relative byte offset.
    pub byte_offset_in_scene: u32,
    pub kind: SelectionPromptKind,
    pub cancelable: bool,
    pub option_line_ids: Vec<String>,
}
