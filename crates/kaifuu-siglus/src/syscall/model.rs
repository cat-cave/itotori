//! Public, text-free model for the Siglus `CD_COMMAND` decoder.

use std::collections::BTreeMap;

use crate::expression::{SiglusArgForm, SiglusExpr};
use crate::flow::SceneFlowError;
use crate::{SiglusExpressionError, SiglusParseError};

/// The `GLOBAL.SELBTN` system-function id used by the title choice syscall.
pub const SEL_SYSTEM_FUNCTION_ID: i32 = 76;

/// Return the stable system-function name when this decoder has an
/// authoritative argument-shape entry for an id.
pub fn system_function_name(function_id: i32) -> Option<&'static str> {
    super::shapes::system_function_name(function_id)
}

/// A command target recovered from its element frame. A system target is the
/// normal syscall form; the other variants preserve an unusual target instead
/// of inventing a function id.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SiglusCallTarget {
    /// A direct `System{function_id}` target.
    System {
        /// Stable numeric system-function id.
        function_id: i32,
    },
    /// A direct system-function root followed by typed element accessors.
    ///
    /// The Siglus VM dispatches these through the same global-system namespace
    /// as a bare [`System`](Self::System) head; the tail selects a form member
    /// but is never opaque bytecode.
    SystemPath {
        /// Stable numeric system-function id at the root of the path.
        function_id: i32,
        /// Typed element accessors in encoded order.
        tail: Vec<SiglusExpr>,
    },
    /// A direct script function reference.
    Function {
        /// Function-table index.
        function_id: i32,
    },
    /// A global variable used as a call target.
    GlobalVar {
        /// Global-variable index.
        variable_id: i32,
    },
    /// A packed head outside the known tag table.
    Raw {
        /// Original packed head word.
        value: i32,
    },
    /// A computed head or a target with member/index accessors.
    Computed {
        /// Fully typed target expression, never opaque bytes.
        expression: SiglusExpr,
    },
}

impl SiglusCallTarget {
    /// Direct system-function id, if this is a `System{...}` target.
    pub fn system_function_id(&self) -> Option<i32> {
        match self {
            SiglusCallTarget::System { function_id }
            | SiglusCallTarget::SystemPath { function_id, .. } => Some(*function_id),
            _ => None,
        }
    }
}

/// A resolved string-table reference. It names title text only by table index
/// and byte span; decoded characters are intentionally absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusStringRef {
    /// Index into the scene's string table.
    pub index: i32,
    /// Byte offset of the UTF-16 string within the decompressed scene payload.
    pub byte_offset: usize,
    /// UTF-16 code-unit length.
    pub char_len: i32,
}

/// One option passed to the `selbtn` syscall, linked to its structural branch arm
/// when the siglus-10 select→jump recognizer found one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusSelOption {
    /// One-based result value returned when this option is selected.
    pub result_value: i32,
    /// Text surface as a string-table reference, never decoded text.
    pub text: SiglusStringRef,
    /// Index into the corresponding [`crate::SiglusChoiceUnit`] arm list.
    pub structural_arm_index: Option<usize>,
    /// Branch target resolved by the structural arm.
    pub branch_target_offset: Option<usize>,
}

/// The option list attached to one `System{76}` (`selbtn`) call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusSelChoice {
    /// Byte offset of the `CD_COMMAND` instruction.
    pub call_offset: usize,
    /// Index into [`SceneSyscallDecode::calls`].
    pub call_index: usize,
    /// Index into [`crate::SceneFlowDecode::choice_units`] when a dispatch
    /// ladder begins at this call.
    pub structural_choice_index: Option<usize>,
    /// Extracted options in argument order.
    pub options: Vec<SiglusSelOption>,
}

/// One fully typed `CD_COMMAND` call. Its command operand was decoded by the
/// siglus-09 decoder and therefore consumed exactly `operand_byte_len` bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusCallArgument {
    /// ABI role, including its positional index or encoded named id.
    pub role: SiglusCallArgumentRole,
    /// One leaf argument form that consumed this value.
    pub form: SiglusArgForm,
    /// Fully typed expression value consumed at this role.
    pub value: SiglusExpr,
}

/// Semantic identity of one argument in a `CD_COMMAND` argument list.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SiglusCallArgumentRole {
    /// An ordinary ABI positional operand in source order.
    Positional {
        /// Zero-based position among positional operands.
        index: usize,
    },
    /// An operand identified by the encoded named-argument id.
    Named {
        /// Stable argument id supplied after the command's argument forms.
        id: i32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusTypedCall {
    /// Bytecode offset of the `0x30` instruction.
    pub site_offset: usize,
    /// Exact command operand byte count (`instruction.len - 1`).
    pub operand_byte_len: usize,
    /// Decoded function target.
    pub target: SiglusCallTarget,
    /// The original element expression, retained for non-direct targets.
    pub target_expression: SiglusExpr,
    /// Argument-list id word.
    pub arg_list_id: i32,
    /// Fully decoded argument-form list.
    pub arg_forms: Vec<SiglusArgForm>,
    /// Fully typed argument values in source order.
    pub args: Vec<SiglusExpr>,
    /// Argument values paired with their exact leaf form and ABI role.
    pub semantic_args: Vec<SiglusCallArgument>,
    /// Named argument ids, in their encoded order.
    pub named_arg_ids: Vec<i32>,
    /// Declared return form.
    pub ret_form: i32,
    /// The function-dependent trailing read-flag word, if present.
    pub read_flag: Option<i32>,
}

/// A non-fatal, aggregate syscall diagnostic. These variants are intentionally
/// typed and text-free so unknown shapes cannot be silently skipped.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SiglusSyscallDiagnostic {
    /// A direct system-function id has no authoritative argument-shape entry.
    /// `count` is the number of call sites for that id in this scene.
    UnknownSyscallArgShape {
        /// Direct system-function id.
        function_id: i32,
        /// Number of call sites using this unknown shape.
        count: usize,
    },
    /// A command target could not be represented as typed data.
    ///
    /// This is reserved for a future target encoding that lacks a typed
    /// [`SiglusCallTarget`] variant; a non-system target is itself typed and
    /// does not trigger this diagnostic.
    UnknownSyscallTargetShape {
        /// Number of unusual command targets in this scene.
        count: usize,
    },
    /// A `sel` string argument did not resolve to an in-bounds string-table
    /// reference. The option is not fabricated from invalid bytes.
    UnresolvedSelOptionStringRef {
        /// Number of unresolved option references in this scene.
        count: usize,
    },
}

/// Result of decoding every `CD_COMMAND` call in one scene.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneSyscallDecode {
    /// Number of partitioned instructions in the scene.
    pub instruction_count: usize,
    /// One typed record for every `0x30` site.
    pub calls: Vec<SiglusTypedCall>,
    /// Extractable `selbtn` option lists.
    pub selections: Vec<SiglusSelChoice>,
    /// Explicit aggregate diagnostics; never a silent unknown-function skip.
    pub diagnostics: Vec<SiglusSyscallDiagnostic>,
    /// Command operand bytes examined by this layer.
    pub total_command_operand_bytes: usize,
    /// Command operand bytes fully decoded as typed operands.
    pub typed_command_operand_bytes: usize,
    /// Unknown direct system-function argument shapes, keyed by function id.
    pub unknown_arg_shape_counts: BTreeMap<i32, usize>,
    /// Number of targets whose shape was not recovered as typed data.
    ///
    /// Every target representation currently emitted by this decoder is typed,
    /// including function/global-variable references and computed elements.
    pub unknown_target_shapes: usize,
}

impl SceneSyscallDecode {
    /// True exactly when every command operand byte became typed data.
    pub fn commands_fully_typed(&self) -> bool {
        self.total_command_operand_bytes == self.typed_command_operand_bytes
    }

    /// Count direct calls to a system-function id.
    pub fn system_call_count(&self, function_id: i32) -> usize {
        self.calls
            .iter()
            .filter(|call| call.target.system_function_id() == Some(function_id))
            .count()
    }
}

/// Fatal decoder failures. Unknown function shapes are values in
/// [`SceneSyscallDecode::diagnostics`], not fatal failures.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SceneSyscallError {
    /// The scene header or bytecode section could not be partitioned.
    #[error("kaifuu.siglus.syscall.partition: {0}")]
    Partition(#[from] SiglusParseError),
    /// One command operand violated the already-partitioned byte span.
    #[error("kaifuu.siglus.syscall.operand: {0}")]
    Operand(#[from] SiglusExpressionError),
    /// The flow decode used to link branch arms failed.
    #[error("kaifuu.siglus.syscall.flow: {0}")]
    Flow(#[from] SceneFlowError),
}
