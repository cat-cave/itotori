//! Typed data model for the Siglus **statement / flow** layer.
//!
//! Everything here carries only counts, offsets, forms, string-table indices,
//! and named operators — never raw scene text. A `str` surface travels as its
//! string-table **index** plus the payload byte-span (offset + UTF-16 length)
//! that patch-back rewrites; the decoded characters never enter these types.

use std::collections::BTreeMap;

use crate::expression::{SiglusBinaryOp, SiglusUnaryOp};

/// The kind of a resolved control-flow transfer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SiglusJumpKind {
    /// `CD_GOTO` unconditional jump.
    Goto,
    /// `CD_GOTO_TRUE` jump-if-nonzero.
    GotoTrue,
    /// `CD_GOTO_FALSE` jump-if-zero.
    GotoFalse,
    /// `CD_GOSUB` / `CD_GOSUBSTR` subroutine call.
    Gosub {
        /// Whether this is the `str`-returning gosub variant.
        returns_str: bool,
    },
}

impl SiglusJumpKind {
    /// A stable, sanitized label for histograms.
    pub fn label(self) -> &'static str {
        match self {
            SiglusJumpKind::Goto => "goto",
            SiglusJumpKind::GotoTrue => "goto_true",
            SiglusJumpKind::GotoFalse => "goto_false",
            SiglusJumpKind::Gosub { returns_str: false } => "gosub",
            SiglusJumpKind::Gosub { returns_str: true } => "gosub_str",
        }
    }
}

/// A resolved control-flow edge: its site, kind, the raw label **index** it
/// names, and the resolved absolute bytecode target offset (`None` when the
/// label index is out of the scene's label table — a located diagnostic, never
/// a panic).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusJump {
    /// Byte offset of the jump instruction within the bytecode section.
    pub site_offset: usize,
    /// The kind of transfer.
    pub kind: SiglusJumpKind,
    /// The raw label index the instruction carries.
    pub label_index: i32,
    /// The resolved absolute target offset within the bytecode section.
    pub target_offset: Option<usize>,
}

/// A localizable text / speaker-name surface: the load-bearing patch-back
/// output. Carries the string-table **reference** (index) and the payload
/// byte-span (offset + UTF-16 code-unit length) — never the characters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusTextSurface {
    /// Byte offset of the `CD_TEXT` / `CD_NAME` instruction.
    pub site_offset: usize,
    /// `true` for `CD_NAME` (speaker), `false` for `CD_TEXT` (message run).
    pub is_name: bool,
    /// The `CD_TEXT` `read_flag` id word (`None` for `CD_NAME`).
    pub read_flag: Option<i32>,
    /// The string-table index the surface renders (`None` if the rendered
    /// string is a computed expression rather than a direct literal).
    pub str_index: Option<i32>,
    /// Absolute byte offset of the string's UTF-16 bytes within the scene
    /// payload (`str_list_ofs + entry.offset * 2`).
    pub str_byte_offset: Option<usize>,
    /// The string's length in UTF-16 code units (byte length is `2 ×` this).
    pub str_char_len: Option<i32>,
}

impl SiglusTextSurface {
    /// True when the surface resolved to a concrete string-table entry with a
    /// located byte-span — the shape the patch-back layer consumes.
    pub fn is_patchable(&self) -> bool {
        self.str_index.is_some() && self.str_byte_offset.is_some() && self.str_char_len.is_some()
    }
}

/// One arm of a select→conditional-jump choice: the constant the selection
/// result is compared against and the branch it dispatches to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusChoiceArm {
    /// The integer constant the selection result is compared against.
    pub compare_value: i32,
    /// Byte offset of the conditional-jump instruction for this arm.
    pub jump_site_offset: usize,
    /// The resolved branch target offset.
    pub target_offset: Option<usize>,
}

/// A recognized select→conditional-jump choice unit: a value-returning
/// selection command linked to the dispatch ladder that branches on its
/// result. Structural recognition — the arms link a choice constant to its
/// branch target. (Naming *which* selection command is a player-facing menu vs
/// an internal switch is refined by the syscall decoder.)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusChoiceUnit {
    /// Byte offset of the selection command whose result the ladder dispatches.
    pub select_offset: usize,
    /// The command's declared return form (non-zero — it yields the selector).
    pub select_ret_form: i32,
    /// The linked dispatch arms, in stream order (choice constant ↔ target).
    pub arms: Vec<SiglusChoiceArm>,
}

/// Sanitized report of the flow layer's resolution of the
/// expression-evaluator cross-control-flow-edge stack underflows.
///
/// `linear_underflow` reproduces the expression-stack evaluator's
/// straight-line count exactly (a regression cross-check). `flow_underflow`
/// is what remains after CFG stack-state propagation across every jump +
/// fall-through edge. The residual is a **documented non-flow residual**: it
/// is attributed to inter-procedural entry, not to any unresolved intra-scene
/// flow edge — see the two split counters.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FlowUnderflowReport {
    /// Underflows under a straight-line walk (equals the expression-stack evaluator's count).
    pub linear_underflow: usize,
    /// Underflows remaining after CFG stack-state propagation.
    pub flow_underflow: usize,
    /// Underflows the flow layer resolved (`linear_underflow - flow_underflow`).
    pub resolved: usize,
    /// Residual underflows in code reached from a runtime entry (offset 0 /
    /// scene-command entry): these consume the incoming **call-frame** the
    /// intra-scene walk does not model (function parameters passed on the
    /// stack), not a flow-edge defect.
    pub residual_call_frame: usize,
    /// Residual underflows in code reached only by cold-seeding — blocks with
    /// no modeled predecessor edge (indirect / computed dispatch entry).
    pub residual_indirect: usize,
    /// Residual underflows attributed to the consuming opcode's lead byte.
    pub residual_by_lead: BTreeMap<String, usize>,
}

impl FlowUnderflowReport {
    /// Fold another report into this one (per-game / per-corpus rollup).
    pub fn merge(&mut self, other: &FlowUnderflowReport) {
        self.linear_underflow += other.linear_underflow;
        self.flow_underflow += other.flow_underflow;
        self.resolved += other.resolved;
        self.residual_call_frame += other.residual_call_frame;
        self.residual_indirect += other.residual_indirect;
        for (lead, count) in &other.residual_by_lead {
            *self.residual_by_lead.entry(lead.clone()).or_insert(0) += count;
        }
    }

    /// True when the residual is fully attributed to the two inter-procedural
    /// categories (call-frame + indirect) — i.e. no unaccounted residual.
    pub fn residual_fully_attributed(&self) -> bool {
        self.residual_call_frame + self.residual_indirect == self.flow_underflow
            && self.residual_by_lead.values().sum::<usize>() == self.flow_underflow
    }
}

/// A named, exact-argument statement for one partitioned instruction. Every
/// instruction maps to exactly one variant, so a scene-wide histogram over
/// [`SiglusStatement::family`] carries **zero** `unknown` for a fully-classified
/// scene. The listed opcode families (`text`, `name`, `jump`, `assign`,
/// `arith`, `command`) carry their exact operands.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SiglusStatement {
    /// `CD_NL` source line-number marker.
    Line {
        /// The source line number.
        line: i32,
    },
    /// `CD_TEXT` message run → index into [`super::SceneFlowDecode::text_surfaces`].
    Text {
        /// Index into the scene's text-surface table.
        surface: usize,
    },
    /// `CD_NAME` speaker name → index into the text-surface table.
    Name {
        /// Index into the scene's text-surface table.
        surface: usize,
    },
    /// `CD_ASSIGN` assignment with its exact `(left, right, arg_list_id)` forms.
    Assign {
        /// Left-hand element form.
        left_form: i32,
        /// Right-hand value form.
        right_form: i32,
        /// Argument-list id word.
        arg_list_id: i32,
    },
    /// `CD_OPERATE_1` unary arithmetic with its re-derived operator.
    Unary {
        /// Operand form.
        form: i32,
        /// The named unary operator.
        op: SiglusUnaryOp,
    },
    /// `CD_OPERATE_2` binary arithmetic with its re-derived operator.
    Binary {
        /// Left operand form.
        left_form: i32,
        /// Right operand form.
        right_form: i32,
        /// The named binary operator.
        op: SiglusBinaryOp,
    },
    /// An arithmetic operator byte outside the re-derived tables (located
    /// diagnostic; `arity` is `1` or `2`).
    ArithUnsupported {
        /// The raw operator byte.
        op: u8,
        /// Operator arity.
        arity: u8,
    },
    /// A control-flow transfer → index into [`super::SceneFlowDecode::jumps`].
    Jump {
        /// Index into the scene's jump table.
        jump: usize,
    },
    /// `CD_RETURN` with the number of returned stack values.
    Return {
        /// Count of returned values (from the argument-form list).
        value_count: usize,
    },
    /// `CD_COMMAND` invocation with its exact structural argument shape.
    Command {
        /// Argument-list id word.
        arg_list_id: i32,
        /// Positional argument value count.
        arg_count: usize,
        /// Named-argument count.
        named_arg_count: usize,
        /// Declared return form.
        ret_form: i32,
        /// The trailing `read_flag_no` word, if partitioned.
        read_flag: Option<i32>,
    },
    /// A typed `CD_POP` that consumes one value (`form != 0`).
    PopValue {
        /// The popped value form.
        form: i32,
    },
    /// Any opcode with no dedicated family here (push / copy / element brackets /
    /// void pop / selection markers / arg / eof). Carries a stable name.
    Structural {
        /// A stable opcode name.
        name: &'static str,
    },
    /// An `Unknown` partition span (must be zero on a fully-partitioned scene).
    Unknown {
        /// The raw lead byte.
        lead: u8,
    },
}

impl SiglusStatement {
    /// The sanitized family label used by the acceptance histogram.
    pub fn family(&self) -> &'static str {
        match self {
            SiglusStatement::Line { .. } => "line",
            SiglusStatement::Text { .. } => "text",
            SiglusStatement::Name { .. } => "name",
            SiglusStatement::Assign { .. } => "assign",
            SiglusStatement::Unary { .. } | SiglusStatement::Binary { .. } => "arith",
            SiglusStatement::ArithUnsupported { .. } => "arith_unsupported",
            SiglusStatement::Jump { .. } => "jump",
            SiglusStatement::Return { .. } => "return",
            SiglusStatement::Command { .. } => "command",
            SiglusStatement::PopValue { .. } => "pop",
            SiglusStatement::Structural { .. } => "structural",
            SiglusStatement::Unknown { .. } => "unknown",
        }
    }
}
