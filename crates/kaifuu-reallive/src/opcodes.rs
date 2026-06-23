//! Named opcode catalogue (bounded).
//!
//! Provenance: derived from the synthetic fixtures under
//! `tests/fixtures/` plus the documented common-case cushion in Haeleth's
//! RLDEV format notes (`https://dev.haeleth.net/rldev.shtml`). The byte
//! mapping is a clean-room synthetic catalogue, not a copy of any rlvm or
//! RLDEV table; opcodes whose byte does not match this catalogue produce
//! an `Unrecognized` instruction with a paired warning rather than a
//! silent skip. See the module-level comment in `lib.rs`.

use serde::{Deserialize, Serialize};

/// Bounded set of named RealLive-style opcodes recognized by the parser.
///
/// The byte mapping is documented in `lib.rs` (§ "Scene bytecode") and is
/// derived from synthetic-fixture bytes plus the documented common-case
/// cushion. Each opcode is **named** in the AST; no opaque byte ranges
/// appear in serialized output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NamedOpcode {
    /// Display a dialogue text string.
    TextDisplay,
    /// Set the active speaker name string.
    SetSpeaker,
    /// Present a choice option (one string slot per option).
    Choice,
    /// Assign a small integer to a numeric variable.
    SetVar,
    /// Jump to a named label within the same scene.
    Jump,
    /// Return from a scene-internal sub-section.
    Return,
    /// Clear the text window.
    ClearScreen,
    /// Pause for keypress.
    Pause,
}

impl NamedOpcode {
    /// Resolve the catalogue byte to a [`NamedOpcode`]. Returns `None` for
    /// bytes outside the bounded catalogue; callers must emit an
    /// `Unrecognized` instruction plus a paired warning.
    pub fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            0x01 => Some(Self::TextDisplay),
            0x02 => Some(Self::SetSpeaker),
            0x03 => Some(Self::Choice),
            0x04 => Some(Self::SetVar),
            0x05 => Some(Self::Jump),
            0x06 => Some(Self::Return),
            0x07 => Some(Self::ClearScreen),
            0x08 => Some(Self::Pause),
            _ => None,
        }
    }

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
            Self::ClearScreen => "clear_screen",
            Self::Pause => "pause",
        }
    }

    /// Default semantic role for the string slot(s) carried by this
    /// opcode. Real-game heuristics may refine this in KAIFUU-174.
    pub fn default_string_slot_role(self) -> super::ast::StringSlotRole {
        use super::ast::StringSlotRole;
        match self {
            Self::TextDisplay => StringSlotRole::Dialogue,
            Self::SetSpeaker => StringSlotRole::SpeakerName,
            Self::Choice => StringSlotRole::Choice,
            // SetVar/Jump/Return/ClearScreen/Pause carry no string slots
            // by default in the synthetic catalogue.
            Self::SetVar | Self::Jump | Self::Return | Self::ClearScreen | Self::Pause => {
                StringSlotRole::Unknown
            }
        }
    }
}

/// Instruction-opener byte. Any other lead byte is an `Unrecognized`
/// instruction (advance by exactly one byte after emitting a warning).
pub const INSTRUCTION_OPENER: u8 = 0x23;

/// Operand-tag bytes documented in `lib.rs` (§ "Scene bytecode").
pub mod operand_tag {
    pub const INT: u8 = 0x69; // 'i'
    pub const STRING: u8 = 0x73; // 's'
    pub const LABEL: u8 = 0x6C; // 'l'
}
