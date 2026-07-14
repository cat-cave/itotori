//! AST types for the RealLive Scene/SEEN parser-boundary smoke (KAIFUU-173).
//!
//! See `lib.rs` for the clean-room provenance posture. All structures
//! serialize as semantic JSON suitable for golden testing; field names use
//! camelCase to align with the rest of the kaifuu-core surface.

use std::fmt;

use kaifuu_core::RedactedContentSummary;
use serde::{Deserialize, Serialize};

use crate::diagnostics::ParseDiagnostic;
use crate::opcodes::NamedOpcode;

/// Schema version stamp emitted by every top-level structure in this
/// crate. Bumped if the AST shape changes.
pub const SCHEMA_VERSION: &str = "0.1.0";

/// Severity assigned to a [`ParseDiagnostic`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    /// Recoverable; the AST still carries the surrounding instructions
    /// and the diagnostic flags the byte range for downstream attention.
    Warning,
    /// Unrecoverable for the scene blob in question. `ParseOutcome.scene`
    /// is `None` and `ParseOutcome.status` is `Failed`.
    Fatal,
}

/// Outcome of a single-scene parse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseOutcome {
    pub schema_version: String,
    /// `None` when a fatal diagnostic prevents AST emission.
    pub scene: Option<Scene>,
    pub diagnostics: Vec<ParseDiagnostic>,
    pub status: ParseStatus,
}

/// Coarse status flag for a [`ParseOutcome`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseStatus {
    /// No diagnostics; AST present.
    Ok,
    /// Warning-severity diagnostics only; AST present.
    OkWithWarnings,
    /// At least one fatal diagnostic; AST omitted.
    Failed,
}

/// Parsed scene — bytecode-level AST plus extracted [`StringSlot`]s.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub schema_version: String,
    /// Stable string scene id (`reallive:scene-NNNN`) derived from the
    /// 10,000-slot directory index. See
    /// `crate::archive::scene_id_string`.
    pub scene_id: String,
    pub instructions: Vec<Instruction>,
    pub strings: Vec<StringSlot>,
}

/// Stable per-scene instruction id derived from byte position only.
///
/// Format: `reallive:scene-{scene_id:04}:ins-off-{instr_byte_offset_within_scene:08x}`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct InstructionId(pub(crate) String);

impl InstructionId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn for_scene(scene_id: u16, byte_offset_within_scene: u64) -> Self {
        Self(format!(
            "reallive:scene-{scene_id:04}:ins-off-{byte_offset_within_scene:08x}"
        ))
    }
}

/// One decoded instruction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instruction {
    pub instruction_id: InstructionId,
    pub byte_offset: u64,
    pub byte_len: u64,
    pub kind: InstructionKind,
    pub operands: Vec<Operand>,
    pub string_slot_refs: Vec<StringSlotRef>,
}

/// Either a known named opcode or a raw opener byte that did not match
/// the catalogue. Both shapes are paired with a diagnostic so the parser
/// never silently drops bytes.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "tag", rename_all = "snake_case")]
pub enum InstructionKind {
    Named { opcode: NamedOpcode },
    Unrecognized { raw_opener_byte: u8 },
}

impl fmt::Debug for InstructionKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Named { opcode } => formatter
                .debug_struct("Named")
                .field("opcode", opcode)
                .finish(),
            Self::Unrecognized { raw_opener_byte } => formatter
                .debug_struct("Unrecognized")
                .field(
                    "raw_opener_byte",
                    &RedactedContentSummary::from_bytes(&[*raw_opener_byte]),
                )
                .finish(),
        }
    }
}

/// Operand value. Byte ranges are scene-blob-relative offsets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "tag", rename_all = "snake_case")]
pub enum Operand {
    Int {
        value: i32,
        byte_offset: u64,
        byte_len: u64,
    },
    String {
        slot_ref: StringSlotRef,
    },
    Label {
        name: String,
        byte_offset: u64,
        byte_len: u64,
    },
}

/// Stable string-slot id derived from byte position only.
///
/// Format:
/// `reallive:scene-{scene_id:04}:str-off-{slot_byte_offset_within_scene:08x}-idx{slot_index_within_instruction:02}`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct StringSlotId(pub(crate) String);

impl StringSlotId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn for_scene(
        scene_id: u16,
        slot_byte_offset_within_scene: u64,
        slot_index_within_instruction: u8,
    ) -> Self {
        Self(format!(
            "reallive:scene-{scene_id:04}:str-off-{slot_byte_offset_within_scene:08x}-idx{slot_index_within_instruction:02}"
        ))
    }
}

/// FK from an [`Operand::String`] (or implicit instruction slot list) into
/// the scene's [`Scene::strings`] vector. Carries the stable slot id so
/// downstream consumers do not need to dereference the [`Scene`] to use
/// the id in bridge artifacts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringSlotRef {
    pub slot_id: StringSlotId,
    pub slot_index: u32,
}

/// Extracted string slot. Raw bytes are preserved verbatim as
/// uppercase-hex; encoding is set from the surrounding instruction
/// context (defaults to [`kaifuu_core::SourceEncoding::Binary`] for the
/// smoke). Decoding to a `String` is KAIFUU-174's responsibility.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringSlot {
    pub slot_id: StringSlotId,
    pub byte_offset_within_scene: u64,
    pub byte_len: u64,
    pub encoding: kaifuu_core::SourceEncoding,
    pub raw_bytes_hex: String,
    pub semantic_role: StringSlotRole,
}

impl fmt::Debug for StringSlot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let raw_bytes_hex = RedactedContentSummary::from_text(&self.raw_bytes_hex);
        formatter
            .debug_struct("StringSlot")
            .field("slot_id", &self.slot_id)
            .field("byte_offset_within_scene", &self.byte_offset_within_scene)
            .field("byte_len", &self.byte_len)
            .field("encoding", &self.encoding)
            .field("raw_bytes_hex", &raw_bytes_hex)
            .field("semantic_role", &self.semantic_role)
            .finish()
    }
}

/// Best-guess semantic role for a [`StringSlot`], derived from the
/// enclosing instruction. KAIFUU-174 refines this with codec-aware logic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StringSlotRole {
    Dialogue,
    SpeakerName,
    Choice,
    AssetReference,
    Unknown,
}

impl ParseOutcome {
    /// Bridge constructor used by the parser. Computes [`ParseStatus`]
    /// from the diagnostics severity histogram.
    pub(crate) fn new(scene: Option<Scene>, diagnostics: Vec<ParseDiagnostic>) -> Self {
        let any_fatal = diagnostics
            .iter()
            .any(|d| d.severity == DiagnosticSeverity::Fatal);
        let status = if any_fatal {
            ParseStatus::Failed
        } else if diagnostics.is_empty() {
            ParseStatus::Ok
        } else {
            ParseStatus::OkWithWarnings
        };
        // If anything fatal was emitted, the AST must be omitted per §4.1.
        let scene = if any_fatal { None } else { scene };
        Self {
            schema_version: SCHEMA_VERSION.to_string(),
            scene,
            diagnostics,
            status,
        }
    }
}
