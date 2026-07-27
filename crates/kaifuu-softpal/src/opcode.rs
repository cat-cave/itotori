//! Softpal `SCRIPT.SRC` (`Sv20`) **full opcode catalog**: the semantic-decompile
//! completion that types *every* command in the plaintext bytecode stream, not
//! just the two text-bearing shapes ([`crate::ScriptScan`]).
//! # The `Sv20` stack machine
//! After the 12-byte program header, `SCRIPT.SRC` is a flat stream of **4-byte
//! tokens** (little-endian, 4-byte aligned). A token is either an **operator**
//! or an **operand**, disambiguated purely by structure — *not* by a byte
//! pattern that could collide:
//! - An **operator** token has high word `== 0x0001` ([`SV_OPERATOR_TAG`]); its
//!   low word is the opcode id (all observed ids lie in `0x01..=0x21`, a fixed
//!   33-entry table, [`SV_MAX_OPCODE`]; id `0x00` is never observed as an
//!   operator). Every opcode consumes a **fixed number of following operand
//!   tokens** ([`SvOpcode::arity`]) — 0, 1, or 2.
//! - An **operand** token is an arbitrary 32-bit value consumed by the preceding
//!   operator. Its high nibble (bits 28-31) is a structural **tag**
//!   ([`OperandTag`]): `0x0` plain word (int literal / `TEXT.DAT` pointer /
//!   script offset / packed call discriminator), `0x4` typed value
//!   (`0x40000000` nil, `0x4000000N` indexed slot), `0x8` variable reference,
//!   `0xF` sentinel (`0xFFFFFFFF`), and a handful of other tagged forms.
//!   Because operators carry a fixed arity, an operand whose bits *happen* to look
//!   like an operator (e.g. the raw immediate `0x0001_09A0`) is never mistaken for
//!   one: the walk is **arity-driven**, so it steps operator→operands→operator and
//!   lands exactly on the next operator every time. This is what makes a
//!   **0-unknown** exhaustive walk reachable where a naive marker scan cannot be.
//! # The command surface: `Syscall` (opcode `0x17`) dispatch
//! The engine's *rendering-relevant* commands (dialogue, choices, graphics,
//! audio, flow, system) are **not** distinct opcodes — they are all the single
//! `Syscall` opcode `0x17` dispatching on its first operand, a packed
//! [`CallTarget`] `{ category = high word, function = low word }`. The existing
//! disassembler's two shapes are exactly two `Syscall` targets:
//! - **TEXT-SHOW** = category `0x0002`, function ∈ the text-type set
//!   ([`TEXT_TYPE_FUNCTIONS`]) — [`CommandFamily::TextShow`].
//! - **SELECT** = category `0x0006`, function `0x0002` —
//!   [`CommandFamily::Select`].
//!   Every other `Syscall` target ([`CommandFamily::Call`]) is fully *identified* by
//!   its `(category, function)` pair — the exact dispatch key a future Utsushi
//!   Softpal replay consumes — even though naming each built-in individually would
//!   require reversing `Pal.dll` (a separate, larger node; see the honest-scope
//!   note below).
//! # Honest scope: structural catalog, not a runtime
//! This module **types** every command: it recovers the header, walks the token
//! stream to a 0-unknown exhaustive accounting on ≥2 real games, classifies each
//! operator by opcode + fixed operand shape, and identifies each `Syscall` by its
//! dispatch target. It does **not** *execute* the stack machine (evaluate
//! expressions, resolve jumps, drive rendering) — that is the Utsushi Softpal
//! replay runtime, a separate future node. The catalog is what such a replay
//! would consume as its instruction table.
//! # Determinism / no shell-outs
//! Pure functions of the input `&[u8]`. No `Command::new`; the SoftPal-Tool
//! `pal_script_tool.py` (which types only the two text shapes) and GARbro are
//! reference oracles only. Malformed input never panics: a fatal header failure
//! is a typed [`OpcodeError`]; an unrecognized operator token or a truncated
//! final command is recorded ([`OpcodeScan::unknowns`] /
//! [`OpcodeScan::truncated_final`]), never a panic.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::SCRIPT_MAGIC_PREFIX;

#[path = "pal_dll_call_targets.rs"]
mod pal_dll_call_targets;

#[path = "opcode/scan.rs"]
mod scan;

pub use pal_dll_call_targets::{
    CALL_CATEGORY_SELECT, CALL_CATEGORY_TEXT, CallTarget, SELECT_FUNCTION, TEXT_TYPE_FUNCTIONS,
};

/// Total length of the `Sv20` program header: `"Sv"` + 2 version bytes + two
/// 32-bit header fields. The token stream begins immediately after.
pub const SV_PROGRAM_HEADER_BYTE_LEN: usize = 12;

/// Byte length of one bytecode token (operator or operand).
pub const SV_TOKEN_BYTE_LEN: usize = 4;

/// The high word (`bytes[off+2..off+4]`) that marks a token as an **operator**;
/// any other high word means the token is an operand.
pub const SV_OPERATOR_TAG: u16 = 0x0001;

/// The highest opcode id in the observed `Sv20` table. The observed operator
/// table is the **33 ids `0x01..=0x21`** (id `0x00` is never an operator in
/// either profiled title — see the table note).
pub const SV_MAX_OPCODE: u16 = 0x0021;

/// Grep-pinnable namespace marker every [`OpcodeError`] display string carries.
pub const SOFTPAL_OPCODE_ERROR_MARKER: &str = "kaifuu.softpal.opcode";

fn read_u16_le(bytes: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([bytes[off], bytes[off + 1]])
}
fn read_u32_le(bytes: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
}

macro_rules! sv_opcodes {
    ( $( $id:literal => $variant:ident : $arity:literal ),+ $(,)? ) => {
        /// The typed `Sv20` opcode table: one variant per observed operator id
        /// (the 33 ids `0x01..=0x21`), plus [`SvOpcode::Unknown`] for any id
        /// outside it (including the unobserved `0x00`).
        /// Variant names are the hex id (`Op02`..`Op21`) except the semantically
        /// firm [`SvOpcode::Move`] (`0x01`), script [`SvOpcode::Call`] (`0x0b`), and native [`SvOpcode::Syscall`] (`0x17`). Each
        /// opcode's **arity** (fixed operand-token count) is proven by the
        /// exhaustive 0-unknown walk; individual per-opcode *semantics* beyond
        /// Move, script Call, and native Syscall dispatch remain intentionally conservative.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub enum SvOpcode {
            $( #[doc = concat!("Opcode `", stringify!($id), "` — arity ", stringify!($arity), ".")] $variant, )+
            /// An operator token (high word `0x0001`) whose low word is outside
            /// the known `0x00..=0x21` table: an unrecognized opcode. Its arity
            /// is unknown, so the walk cannot consume its operands.
            Unknown(u16),
        }

        impl SvOpcode {
            /// Map a raw opcode id (an operator token's low word) to its variant.
            #[must_use]
            pub fn from_id(id: u16) -> Self {
                match id { $( $id => SvOpcode::$variant, )+ other => SvOpcode::Unknown(other) }
            }
            /// The raw opcode id (low word of the operator token).
            #[must_use]
            pub fn id(self) -> u16 {
                match self { $( SvOpcode::$variant => $id, )+ SvOpcode::Unknown(x) => x }
            }
            /// The fixed number of operand tokens this opcode consumes, or `None`
            /// for [`SvOpcode::Unknown`] (arity unknown ⇒ stream cannot be
            /// walked past it).
            #[must_use]
            pub fn arity(self) -> Option<usize> {
                match self { $( SvOpcode::$variant => Some($arity), )+ SvOpcode::Unknown(_) => None }
            }
        }
    };
}

// Opcode → arity table, measured by the arity-driven walk landing *exactly* on
// EOF with zero desync on two independently staged scripts (any wrong arity
// would desync).
// The 33 ids `0x01..=0x21` are all *observed* operators on both titles; id
// `0x00` is deliberately **absent** — it is never an operator in either corpus,
// so its arity is unproven and it is treated as [`SvOpcode::Unknown`] (it would
// surface as an explicit unknown rather than a fabricated-arity walk if a future
// title used it — no faked coverage).
sv_opcodes! {
    // `Move` assigns its second operand to the typed destination in its first
    // operand. This is the generic typed-value flow used by SELECT labels.
    0x01 => Move: 2, 0x02 => Op02: 2, 0x03 => Op03: 2,
    0x04 => Op04: 2, 0x05 => Op05: 2, 0x06 => Op06: 2, 0x07 => Op07: 2,
    0x08 => Op08: 2, 0x09 => Op09: 1, 0x0a => Op0A: 2, 0x0b => Call: 1,
    0x0c => Op0C: 2, 0x0d => Op0D: 2, 0x0e => Op0E: 2, 0x0f => Op0F: 2,
    0x10 => Op10: 2, 0x11 => Op11: 2, 0x12 => Op12: 2, 0x13 => Op13: 2,
    0x14 => Op14: 1, 0x15 => Op15: 0, 0x16 => Op16: 0,
    // 0x17 = the native dispatch opcode (dialogue/choice/graphics/audio/…).
    0x17 => Syscall: 2,
    0x18 => Op18: 0, 0x19 => Op19: 0, 0x1a => Op1A: 2, 0x1b => Op1B: 2,
    0x1c => Op1C: 2, 0x1d => Op1D: 1, 0x1e => Op1E: 1, 0x1f => Op1F: 1,
    0x20 => Op20: 1, 0x21 => Op21: 1,
}

impl SvOpcode {
    /// Whether this is a recognized opcode (not [`SvOpcode::Unknown`]).
    #[must_use]
    pub fn is_known(self) -> bool {
        !matches!(self, SvOpcode::Unknown(_))
    }
    /// Whether this is the native dispatch opcode ([`SvOpcode::Syscall`]).
    #[must_use]
    pub fn is_syscall(self) -> bool {
        matches!(self, SvOpcode::Syscall)
    }
}

/// The parsed 12-byte `Sv20` program header.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvProgramHeader {
    /// The two version bytes following the `"Sv"` magic (e.g. `b"20"`).
    pub version: [u8; 2],
    /// First 32-bit header field (a program id / checksum word; opaque to the
    /// catalog).
    pub field1: u32,
    /// Second 32-bit header field (a small count/size word; opaque to the
    /// catalog — observed values include 668 and 820).
    pub field2: u32,
}

impl SvProgramHeader {
    /// Parse the 12-byte header from the front of `bytes`.
    /// # Errors
    /// [`OpcodeError::TruncatedHeader`] for a short buffer, or
    /// [`OpcodeError::BadMagic`] if the first two bytes are not `"Sv"`.
    pub fn parse(bytes: &[u8]) -> Result<Self, OpcodeError> {
        if bytes.len() < SV_PROGRAM_HEADER_BYTE_LEN {
            return Err(OpcodeError::TruncatedHeader {
                observed_len: bytes.len(),
            });
        }
        let magic = [bytes[0], bytes[1]];
        if &magic != SCRIPT_MAGIC_PREFIX {
            return Err(OpcodeError::BadMagic {
                expected: *SCRIPT_MAGIC_PREFIX,
                found: magic,
            });
        }
        Ok(Self {
            version: [bytes[2], bytes[3]],
            field1: read_u32_le(bytes, 4),
            field2: read_u32_le(bytes, 8),
        })
    }
}

/// The structural **tag** of an operand token: its high nibble (bits 28-31),
/// which is how the `Sv20` machine distinguishes value forms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct OperandTag(pub u8);

impl OperandTag {
    /// Untagged plain word (tag `0x0`): an integer literal, a `TEXT.DAT`
    /// pointer, a script byte offset, or a packed `Call` discriminator — the
    /// interpretation is opcode-contextual (a runtime concern).
    pub const PLAIN: OperandTag = OperandTag(0x0);
    /// Typed value (tag `0x4`): `0x40000000` is the typed-nil sentinel;
    /// `0x4000000N` an indexed/typed slot.
    pub const TYPED: OperandTag = OperandTag(0x4);
    /// Variable reference (tag `0x8`): `0x8000000N`.
    pub const VAR: OperandTag = OperandTag(0x8);
    /// Sentinel (tag `0xF`): e.g. `0xFFFFFFFF`.
    pub const SENTINEL: OperandTag = OperandTag(0xF);
}

/// One operand token: its raw 32-bit value and the absolute byte offset of its
/// 4-byte field within `SCRIPT.SRC` (byte-locatable for a future patch-back).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operand {
    /// The raw little-endian 32-bit operand value.
    pub raw: u32,
    /// Absolute byte offset of this operand's 4-byte field within `SCRIPT.SRC`.
    pub field_offset: usize,
}

impl Operand {
    /// The structural [`OperandTag`] (high nibble) of this operand.
    #[must_use]
    pub fn tag(&self) -> OperandTag {
        OperandTag((self.raw >> 28) as u8)
    }
}

/// The classified command **family** of one instruction — the typed surface a
/// replay dispatches on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "family")]
pub enum CommandFamily {
    /// A `Syscall` to the dialogue message subroutine (category `0x0002`); carries
    /// the text-type function. The disassembler's TEXT-SHOW.
    TextShow {
        /// The text-type `Syscall` function (∈ [`TEXT_TYPE_FUNCTIONS`]).
        text_type: u16,
    },
    /// A `Syscall` to the choice/select subroutine. The disassembler's SELECT.
    Select,
    /// Any other engine `Syscall`, identified by its [`CallTarget`] dispatch key
    /// (graphics / audio / flow / system built-in).
    Call {
        /// The `(category, function)` dispatch key.
        target: CallTarget,
    },
    /// A nullary operator (`0x00`, `0x15`, `0x16`, `0x18`, `0x19`): a
    /// scene/block/flow boundary marker (0 operands).
    Control,
    /// A stack/expression operator (the remaining unary/binary opcodes):
    /// push / store / variable / arithmetic machinery consumed by the VM.
    Expr,
}

/// One fully-typed `Sv20` instruction: an operator plus its fixed operands, in
/// play (byte-offset) order. `Copy` — operands are held inline (arity ≤ 2), no
/// heap per instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instruction {
    /// Absolute byte offset of the operator token within `SCRIPT.SRC`.
    pub offset: usize,
    /// The decoded opcode.
    pub opcode: SvOpcode,
    /// The classified command family.
    pub family: CommandFamily,
    /// Number of operand tokens actually present (`< arity` only for a
    /// truncated final instruction at EOF).
    arity: u8,
    /// Inline operand storage (only the first `arity` entries are meaningful).
    operands_buf: [Operand; 2],
}

impl Instruction {
    /// The operand tokens this instruction consumed, in order.
    #[must_use]
    pub fn operands(&self) -> &[Operand] {
        &self.operands_buf[..self.arity as usize]
    }
    /// The `Syscall` dispatch target, if this instruction is a `Syscall`.
    #[must_use]
    pub fn call_target(&self) -> Option<CallTarget> {
        match self.family {
            CommandFamily::TextShow { text_type } => Some(CallTarget {
                category: CALL_CATEGORY_TEXT,
                function: text_type,
            }),
            CommandFamily::Select => Some(CallTarget {
                category: CALL_CATEGORY_SELECT,
                function: SELECT_FUNCTION,
            }),
            CommandFamily::Call { target } => Some(target),
            _ => None,
        }
    }
}

/// An operator-position token that could not be typed: either its high word is
/// not [`SV_OPERATOR_TAG`] (a desync) or its opcode id is outside the known
/// table ([`SvOpcode::Unknown`]). Recorded, never panicked. **Zero** of these on
/// real bytes is the catalog's completeness bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownToken {
    /// Absolute byte offset of the offending token.
    pub offset: usize,
    /// The token's low word (opcode id when the high word *is* the operator tag).
    pub token_lo: u16,
    /// The token's high word (should be [`SV_OPERATOR_TAG`] at an operator
    /// position).
    pub token_hi: u16,
}

/// The full opcode catalog of one `SCRIPT.SRC`: the header plus every typed
/// instruction in play order, with an explicit accounting of any residual
/// unknowns and trailing bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpcodeScan {
    /// The parsed program header.
    pub header: SvProgramHeader,
    /// Every typed instruction, in ascending byte offset.
    pub instructions: Vec<Instruction>,
    /// Operator-position tokens that could not be typed (empty on real bytes).
    pub unknowns: Vec<UnknownToken>,
    /// `true` if the final instruction lacked enough bytes for all its operands
    /// (a truncated stream). `false` on a clean stream.
    pub truncated_final: bool,
    /// Bytes after the last consumed token (`0..=3` on a clean stream — the
    /// stream is 4-byte aligned so this is `0`, or the leftover of a truncated
    /// final command).
    pub trailing_bytes: usize,
    /// Total input length (for coverage accounting).
    pub input_len: usize,
}

/// Fatal errors raised while cataloging a `SCRIPT.SRC`. Every display string
/// begins with [`SOFTPAL_OPCODE_ERROR_MARKER`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OpcodeError {
    /// The buffer is shorter than the fixed 12-byte program header.
    #[error(
        "kaifuu.softpal.opcode.truncated_header: length {observed_len} is shorter than the fixed \
         {SV_PROGRAM_HEADER_BYTE_LEN}-byte program header"
    )]
    TruncatedHeader {
        /// The observed buffer length.
        observed_len: usize,
    },
    /// The first two bytes are not the `"Sv"` magic prefix.
    #[error(
        "kaifuu.softpal.opcode.bad_magic: expected magic prefix {expected:02X?} (\"Sv\") at \
         offset 0, found {found:02X?}"
    )]
    BadMagic {
        /// The expected `"Sv"` magic.
        expected: [u8; 2],
        /// The bytes actually found.
        found: [u8; 2],
    },
}

#[cfg(test)]
#[path = "opcode_tests.rs"]
mod tests;
