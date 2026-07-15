//! Named-opcode summary catalogue used by the [`crate::ast::Scene`] tree.
//! After the parser produces a [`crate::opcode::RealLiveOpcode`]
//! sequence by decoding the **real** RealLive byte stream. The
//! [`NamedOpcode`] enum here is the **summary** classification used to
//! decorate the [`crate::ast::Instruction`] kind in the legacy `Scene`
//! tree consumed by [`crate::inventory`] and [`crate::patchback`]. It is
//! a small, stable surface — the rich opcode taxonomy lives on
//! [`crate::opcode::RealLiveOpcode`].
//! Provenance: the names below are restated from the RLOperation module
//! catalogue documented in Haeleth's RLDEV manual and reflected in
//! rlvm's `src/modules/module_*.cc` listing (research anchor only;
//! rlvm is GPL-3, not linked or vendored — `crate::opcode` is the
//! actual decoder, this is just the labelling enum).
//! The pre- `INSTRUCTION_OPENER`/operand-tag-byte
//! constants and the `from_byte(byte) -> Option<Self>` synthetic-fixture
//! mapping are deleted; opcode classification lives in
//! [`crate::opcode::parse_real_bytecode`] now.

use serde::{Deserialize, Serialize};

/// Summary opcode classification used in the legacy [`crate::ast::Scene`]
/// tree. Decoded from the full [`crate::opcode::RealLiveOpcode`] stream
/// by [`crate::parser::parse_scene_into_ast`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NamedOpcode {
    /// Display a dialogue text string (rlvm `module_msg` family).
    TextDisplay,
    /// Set the active speaker name string (rlvm `module_msg::CharText`).
    SetSpeaker,
    /// Present a choice option (rlvm `module_sel`).
    Choice,
    /// Variable bank write (rlvm `module_mem` / `module_str` / per-module
    /// memory writes such as `bgmPlay`/`koePlay`/`Background`).
    SetVar,
    /// Control-flow jump / branch / call (rlvm `module_jmp`).
    Jump,
    /// Subroutine return / scene end (rlvm `module_jmp::ret*` and
    /// `module_sys::end`).
    Return,
    /// Pause for keypress / wait longop (rlvm `module_sys::wait`,
    /// `module_msg::pause`).
    Pause,
}

impl NamedOpcode {
    /// Stable serde label (snake_case), useful for golden tests that pin
    /// the AST surface to the named-opcode contract.
    pub fn as_label(self) -> &'static str {
        match self {
            Self::TextDisplay => "text_display",
            Self::SetSpeaker => "set_speaker",
            Self::Choice => "choice",
            Self::SetVar => "set_var",
            Self::Jump => "jump",
            Self::Return => "return",
            Self::Pause => "pause",
        }
    }

    /// Default semantic role for the string slot(s) carried by this
    /// opcode. 's heuristic refines this.
    pub fn default_string_slot_role(self) -> super::ast::StringSlotRole {
        use super::ast::StringSlotRole;
        match self {
            Self::TextDisplay => StringSlotRole::Dialogue,
            Self::SetSpeaker => StringSlotRole::SpeakerName,
            Self::Choice => StringSlotRole::Choice,
            Self::SetVar | Self::Jump | Self::Return | Self::Pause => StringSlotRole::Unknown,
        }
    }
}
