use serde::{Deserialize, Serialize};

/// BytecodeElement opener bytes (rlvm `bytecode.cc::BytecodeElement::Read`).
/// These are the seven structural lead bytes that mark the start of a
/// documented element in a decompressed RealLive scene stream. Any other
/// lead byte begins a Textout run ([`is_structural_opener`] is the
/// boundary predicate; Shift-JIS pairs are consumed whole).
pub mod opener {
    pub const META_COMMA: u8 = 0x00;
    pub const META_LINE: u8 = 0x0A;
    pub const META_ENTRYPOINT: u8 = 0x21;
    pub const COMMAND: u8 = 0x23;
    pub const EXPRESSION: u8 = 0x24;
    pub const COMMA: u8 = 0x2C;
    pub const META_KIDOKU: u8 = 0x40;
}

/// Width of the [`opener::COMMAND`] header (rlvm `bytecode.h:CommandElement`,
/// `command[COMMAND_SIZE] = 8`).
pub const COMMAND_HEADER_LEN: usize = 8;

/// Encoding tag carried by [`RealLiveOpcode::TextDisplay`].
/// The bytes in the operand stream are u16-LE-length-prefixed Shift-JIS;
/// downstream decode is owned by [`crate::encoding::decode_shift_jis_slot`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextEncoding {
    /// 16-bit little-endian length prefix followed by N bytes of Shift-JIS.
    ShiftJisLengthPrefixed,
    /// Raw Shift-JIS bytes (Textout element body — no length prefix; runs
    /// until the next opener byte).
    ShiftJisInlineRun,
}
