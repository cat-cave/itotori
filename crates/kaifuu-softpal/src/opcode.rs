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
//! # The command surface: `Call` (opcode `0x17`) dispatch
//! The engine's *rendering-relevant* commands (dialogue, choices, graphics,
//! audio, flow, system) are **not** distinct opcodes — they are all the single
//! `Call` opcode `0x17` dispatching on its first operand, a packed
//! [`CallTarget`] `{ category = high word, function = low word }`. The existing
//! disassembler's two shapes are exactly two `Call` targets:
//! - **TEXT-SHOW** = category `0x0002`, function ∈ the text-type set
//!   ([`TEXT_TYPE_FUNCTIONS`]) — [`CommandFamily::TextShow`].
//! - **SELECT** = category `0x0006`, function `0x0002` —
//!   [`CommandFamily::Select`].
//!   Every other `Call` target ([`CommandFamily::Call`]) is fully *identified* by
//!   its `(category, function)` pair — the exact dispatch key a future Utsushi
//!   Softpal replay consumes — even though naming each built-in individually would
//!   require reversing `Pal.dll` (a separate, larger node; see the honest-scope
//!   note below).
//! # Honest scope: structural catalog, not a runtime
//! This module **types** every command: it recovers the header, walks the token
//! stream to a 0-unknown exhaustive accounting on ≥2 real games, classifies each
//! operator by opcode + fixed operand shape, and identifies each `Call` by its
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

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::SCRIPT_MAGIC_PREFIX;

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

/// The `Call` ([`SvOpcode::Call`], opcode `0x17`) *category* (target high word)
/// that dispatches the dialogue message subroutine (TEXT-SHOW).
pub const CALL_CATEGORY_TEXT: u16 = 0x0002;

/// The `Call` *category* (target high word) that dispatches the choice/select
/// subroutine.
pub const CALL_CATEGORY_SELECT: u16 = 0x0006;

/// The `Call` *function* (target low word) under [`CALL_CATEGORY_SELECT`] that is
/// a choice/select command.
pub const SELECT_FUNCTION: u16 = 0x0002;

/// The set of `Call` *functions* (target low word) under [`CALL_CATEGORY_TEXT`]
/// that render a dialogue line. Mirrors the disassembler's
/// [`crate::TEXT_SHOW_TYPE_WORDS`].
pub const TEXT_TYPE_FUNCTIONS: [u16; 7] = [0x0002, 0x000f, 0x0010, 0x0011, 0x0012, 0x0013, 0x0014];

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
        /// Variant names are the hex id (`Op01`..`Op21`) except the semantically
        /// firm [`SvOpcode::Call`] (`0x17`). Each opcode's **arity** (fixed
        /// operand-token count) is proven by the exhaustive 0-unknown walk on
        /// two real games; individual per-opcode *semantics* beyond `Call`
        /// dispatch are a separate `Pal.dll` RE effort (honest scope).
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
// EOF with zero desync on both v21465 and v60663 (any wrong arity would desync).
// The 33 ids `0x01..=0x21` are all *observed* operators on both titles; id
// `0x00` is deliberately **absent** — it is never an operator in either corpus,
// so its arity is unproven and it is treated as [`SvOpcode::Unknown`] (it would
// surface as an explicit unknown rather than a fabricated-arity walk if a future
// title used it — no faked coverage).
sv_opcodes! {
    0x01 => Op01: 2, 0x02 => Op02: 2, 0x03 => Op03: 2,
    0x04 => Op04: 2, 0x05 => Op05: 2, 0x06 => Op06: 2, 0x07 => Op07: 2,
    0x08 => Op08: 2, 0x09 => Op09: 1, 0x0a => Op0A: 2, 0x0b => Op0B: 1,
    0x0c => Op0C: 2, 0x0d => Op0D: 2, 0x0e => Op0E: 2, 0x0f => Op0F: 2,
    0x10 => Op10: 2, 0x11 => Op11: 2, 0x12 => Op12: 2, 0x13 => Op13: 2,
    0x14 => Op14: 1, 0x15 => Op15: 0, 0x16 => Op16: 0,
    // 0x17 = the engine-call dispatch opcode (dialogue/choice/graphics/audio/…).
    0x17 => Call: 2,
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
    /// Whether this is the engine-call dispatch opcode ([`SvOpcode::Call`]).
    #[must_use]
    pub fn is_call(self) -> bool {
        matches!(self, SvOpcode::Call)
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
    /// catalog — e.g. 668 on v21465, 820 on v60663).
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

/// The dispatch key of a [`SvOpcode::Call`] instruction: the engine built-in it
/// invokes, packed into the call's first operand as
/// `category = high word`, `function = low word`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallTarget {
    /// Subroutine category (the operand's high word) — e.g. `0x0002` message,
    /// `0x0003`/`0x0005`/`0x0007`/`0x0011`/`0x0016` graphics/audio/system.
    pub category: u16,
    /// Function within the category (the operand's low word).
    pub function: u16,
}

impl CallTarget {
    /// Decode a `Call`'s first operand raw value into its `(category, function)`
    /// dispatch key.
    #[must_use]
    pub fn from_operand(raw: u32) -> Self {
        CallTarget {
            category: (raw >> 16) as u16,
            function: (raw & 0xffff) as u16,
        }
    }
    /// Whether this target renders a dialogue line (TEXT-SHOW).
    #[must_use]
    pub fn is_text_show(&self) -> bool {
        self.category == CALL_CATEGORY_TEXT && TEXT_TYPE_FUNCTIONS.contains(&self.function)
    }
    /// Whether this target is a choice/select command.
    #[must_use]
    pub fn is_select(&self) -> bool {
        self.category == CALL_CATEGORY_SELECT && self.function == SELECT_FUNCTION
    }

    /// The faithful engine-operation name when the game executable's registered
    /// handler makes that named `Pal.dll` call.
    ///
    /// This is deliberately an `Option`: a target is *not* given a plausible
    /// sounding name merely because it shares a category with one whose handler
    /// has been reversed.  The names below come from the real game's target
    /// registration table followed by the handler's `Pal.dll` import thunk.
    /// `None` therefore means "structurally decoded, semantics not yet proven",
    /// not an unknown bytecode shape.
    #[must_use]
    pub fn semantic_name(&self) -> Option<&'static str> {
        match (self.category, self.function) {
            // The two text surfaces are independently proved by their stack
            // shape and TEXT.DAT-pointer use in ScriptScan.
            (CALL_CATEGORY_TEXT, function) if TEXT_TYPE_FUNCTIONS.contains(&function) => {
                Some("message.show")
            }
            (CALL_CATEGORY_SELECT, SELECT_FUNCTION) => Some("choice.select"),

            // Sprite/render handlers (category 0x0003).
            (0x0003, 0x0009) => Some("sprite.set_center_offset"),
            (0x0003, 0x000c) => Some("sprite.set_option"),
            (0x0003, 0x000f) => Some("sprite.rect_set_pos"),
            (0x0003, 0x0010) => Some("sprite.set_render_mode"),
            (0x0003, 0x0026) => Some("sprite.copy_rgb"),
            (0x0003, 0x0028) => Some("sprite.paint"),
            (0x0003, 0x0033) => Some("sprite.cancel_transition"),
            (0x0003, 0x0036) => Some("sprite.backbuffer_copy"),
            (0x0003, 0x003e) => Some("sprite.box_blur"),
            (0x0003, 0x0040) => Some("sprite.get_pixel"),
            (0x0003, 0x0041) => Some("sprite.set_pixel"),
            (0x0003, 0x0052) => Some("render_list.clear"),
            (0x0003, 0x0054) => Some("render_list.draw"),
            (0x0003, 0x005f) => Some("sprite.stretch_blt"),
            (0x0003, 0x0062) => Some("sprite.apply_alpha_mask"),
            (0x0003, 0x0063) => Some("sprite.displacement_map"),
            (0x0003, 0x006a) => Some("sprite.swirl_blur"),
            (0x0003, 0x006b) => Some("sprite.set_rotate_resolution"),

            // Audio/video handlers.  The split sound categories are retained
            // because their handlers are distinct registrations in the VM.
            (0x0004, 0x0006) | (0x0005, 0x0004 | 0x000e) => Some("sound.set_volume"),
            (0x0004, 0x0009) | (0x0005, 0x0006) => Some("sound.release"),
            (0x0004, 0x000a) => Some("sound.play_fade"),
            (0x0005, 0x0003) => Some("sound.stop"),
            (0x0005, 0x000f) => Some("sound.set_frequency"),
            (0x000b, 0x0000) => Some("video.play"),
            (0x000b, 0x0001) => Some("movie_sprite.play"),
            (0x000b, 0x0007) => Some("movie_sprite.stop"),

            // Button/input handlers.
            (0x0008, 0x0000) => Some("button.create"),
            (0x0008, 0x0001) => Some("button.release"),
            (0x0008, 0x0008) => Some("button.delete"),
            (0x0008, 0x000f) => Some("button.control"),
            (0x0008, 0x0016) => Some("button.set_reaction"),
            (0x0008, 0x0024) => Some("button.set_mode"),
            (0x0008, 0x0026) => Some("button.get_reaction"),
            (0x0017, 0x0000) => Some("input.get_key_ex"),

            // Effects and utility handlers.
            (0x0013, 0x0001) => Some("fx.set"),
            (0x0013, 0x0002) => Some("fx.get_state"),
            (0x0014, 0x0000) => Some("random.next"),
            (0x0016, 0x0000) => Some("effect.execute"),
            _ => None,
        }
    }
}

/// The classified command **family** of one instruction — the typed surface a
/// replay dispatches on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "family")]
pub enum CommandFamily {
    /// A `Call` to the dialogue message subroutine (category `0x0002`); carries
    /// the text-type function. The disassembler's TEXT-SHOW.
    TextShow {
        /// The text-type `Call` function (∈ [`TEXT_TYPE_FUNCTIONS`]).
        text_type: u16,
    },
    /// A `Call` to the choice/select subroutine. The disassembler's SELECT.
    Select,
    /// Any other engine `Call`, identified by its [`CallTarget`] dispatch key
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
    /// The `Call` dispatch target, if this instruction is a `Call`.
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

impl OpcodeScan {
    /// Walk a whole `SCRIPT.SRC` buffer into a typed opcode catalog.
    /// The walk is **arity-driven**: it reads the header, then repeatedly reads
    /// an operator token and consumes exactly [`SvOpcode::arity`] operand tokens,
    /// stepping to the next operator. This is what makes the walk exhaustive and
    /// unambiguous — an operand whose bits resemble an operator is consumed as an
    /// operand, never re-read as one.
    /// Never panics: a fatal header failure is `Err`; an unrecognized operator
    /// token is recorded in [`Self::unknowns`] (and the walk resyncs on the
    /// 4-byte grid); a truncated final command sets [`Self::truncated_final`].
    /// # Errors
    /// [`OpcodeError::TruncatedHeader`] / [`OpcodeError::BadMagic`] from the
    /// header parse.
    pub fn parse(bytes: &[u8]) -> Result<Self, OpcodeError> {
        let header = SvProgramHeader::parse(bytes)?;
        let mut instructions = Vec::new();
        let mut unknowns = Vec::new();
        let mut truncated_final = false;

        let mut off = SV_PROGRAM_HEADER_BYTE_LEN;
        while off + SV_TOKEN_BYTE_LEN <= bytes.len() {
            let lo = read_u16_le(bytes, off);
            let hi = read_u16_le(bytes, off + 2);

            // At an operator position the high word must be the operator tag.
            if hi != SV_OPERATOR_TAG {
                unknowns.push(UnknownToken {
                    offset: off,
                    token_lo: lo,
                    token_hi: hi,
                });
                off += SV_TOKEN_BYTE_LEN;
                continue;
            }
            let opcode = SvOpcode::from_id(lo);
            let Some(arity) = opcode.arity() else {
                // Unknown opcode id: arity unknown, cannot consume operands.
                unknowns.push(UnknownToken {
                    offset: off,
                    token_lo: lo,
                    token_hi: hi,
                });
                off += SV_TOKEN_BYTE_LEN;
                continue;
            };

            let op_offset = off;
            off += SV_TOKEN_BYTE_LEN;

            let mut operands_buf = [Operand::default(); 2];
            let mut got = 0usize;
            for slot in operands_buf.iter_mut().take(arity) {
                if off + SV_TOKEN_BYTE_LEN > bytes.len() {
                    break;
                }
                *slot = Operand {
                    raw: read_u32_le(bytes, off),
                    field_offset: off,
                };
                got += 1;
                off += SV_TOKEN_BYTE_LEN;
            }

            let family = classify(opcode, &operands_buf, got);
            instructions.push(Instruction {
                offset: op_offset,
                opcode,
                family,
                arity: got as u8,
                operands_buf,
            });

            if got < arity {
                truncated_final = true;
                break;
            }
        }

        let trailing_bytes = bytes.len().saturating_sub(off);
        Ok(Self {
            header,
            instructions,
            unknowns,
            truncated_final,
            trailing_bytes,
            input_len: bytes.len(),
        })
    }

    /// The catalog is **exhaustive** iff it typed every command with no residual:
    /// no unknown operator tokens, no truncated final command, and no trailing
    /// bytes. This is the 0-unknown completeness bar.
    #[must_use]
    pub fn is_exhaustive(&self) -> bool {
        self.unknowns.is_empty() && !self.truncated_final && self.trailing_bytes == 0
    }

    /// Number of unknown (untyped) operator-position tokens — the residual the
    /// completeness bar drives to zero.
    #[must_use]
    pub fn unknown_count(&self) -> usize {
        self.unknowns.len()
    }

    /// TEXT-SHOW (dialogue) instruction count — mirrors
    /// [`crate::ScriptScan::text_show_count`].
    #[must_use]
    pub fn text_show_count(&self) -> usize {
        self.instructions
            .iter()
            .filter(|i| matches!(i.family, CommandFamily::TextShow { .. }))
            .count()
    }

    /// SELECT (choice) instruction count — mirrors
    /// [`crate::ScriptScan::select_count`].
    #[must_use]
    pub fn select_count(&self) -> usize {
        self.instructions
            .iter()
            .filter(|i| matches!(i.family, CommandFamily::Select))
            .count()
    }

    /// Total `Call` (opcode `0x17`) instruction count, across all targets
    /// (TEXT-SHOW + SELECT + every other engine built-in).
    #[must_use]
    pub fn call_count(&self) -> usize {
        self.instructions
            .iter()
            .filter(|i| i.opcode.is_call())
            .count()
    }

    /// Opcode-id → occurrence-count histogram over all typed instructions.
    #[must_use]
    pub fn opcode_histogram(&self) -> BTreeMap<u16, usize> {
        let mut h = BTreeMap::new();
        for i in &self.instructions {
            *h.entry(i.opcode.id()).or_default() += 1;
        }
        h
    }

    /// Operand structural-tag → occurrence-count histogram over every operand of
    /// every instruction.
    #[must_use]
    pub fn operand_tag_histogram(&self) -> BTreeMap<u8, usize> {
        let mut h = BTreeMap::new();
        for i in &self.instructions {
            for o in i.operands() {
                *h.entry(o.tag().0).or_default() += 1;
            }
        }
        h
    }

    /// `Call` category (dispatch high word) → count histogram over all `Call`
    /// instructions — the coarse command-family table.
    #[must_use]
    pub fn call_category_histogram(&self) -> BTreeMap<u16, usize> {
        let mut h = BTreeMap::new();
        for i in &self.instructions {
            if let Some(t) = i.call_target() {
                *h.entry(t.category).or_default() += 1;
            }
        }
        h
    }

    /// The set of distinct `Call` `(category, function)` dispatch targets — the
    /// fine-grained engine built-in table a replay must cover.
    #[must_use]
    pub fn call_target_count(&self) -> usize {
        let mut set = std::collections::BTreeSet::new();
        for i in &self.instructions {
            if let Some(t) = i.call_target() {
                set.insert((t.category, t.function));
            }
        }
        set.len()
    }

    /// Total token count consumed (operators + operands).
    #[must_use]
    pub fn token_count(&self) -> usize {
        self.instructions
            .iter()
            .map(|i| 1 + i.arity as usize)
            .sum::<usize>()
            + self.unknowns.len()
    }
}

/// Classify an operator + its (up to `got`) operands into a [`CommandFamily`].
fn classify(opcode: SvOpcode, operands: &[Operand; 2], got: usize) -> CommandFamily {
    if opcode.is_call() && got >= 1 {
        let target = CallTarget::from_operand(operands[0].raw);
        // Keep the extraction-bearing families on the same semantic catalog as
        // every other Call target.  ScriptScan (and therefore the real Softpal
        // bridge) consumes this classification; this is not a test-only seam.
        match target.semantic_name() {
            Some("message.show") => {
                return CommandFamily::TextShow {
                    text_type: target.function,
                };
            }
            Some("choice.select") => return CommandFamily::Select,
            _ => {}
        }
        return CommandFamily::Call { target };
    }
    match opcode.arity() {
        Some(0) => CommandFamily::Control,
        _ => CommandFamily::Expr,
    }
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
mod tests {
    use super::*;

    /// Emit one operator token `(opcode id, 0x0001)`.
    fn op(id: u16) -> [u8; 4] {
        let mut t = [0u8; 4];
        t[0..2].copy_from_slice(&id.to_le_bytes());
        t[2..4].copy_from_slice(&SV_OPERATOR_TAG.to_le_bytes());
        t
    }
    /// Emit one raw operand token.
    fn val(v: u32) -> [u8; 4] {
        v.to_le_bytes()
    }
    /// A `Call` first-operand raw value from `(category, function)`.
    fn target(category: u16, function: u16) -> u32 {
        (u32::from(category) << 16) | u32::from(function)
    }

    fn program(tokens: &[[u8; 4]]) -> Vec<u8> {
        let mut s = Vec::new();
        s.extend_from_slice(SCRIPT_MAGIC_PREFIX);
        s.extend_from_slice(b"20");
        s.extend_from_slice(&0x59fa_e876u32.to_le_bytes()); // field1
        s.extend_from_slice(&668u32.to_le_bytes()); // field2
        for t in tokens {
            s.extend_from_slice(t);
        }
        s
    }

    #[test]
    fn header_parses_and_rejects_bad_input() {
        let s = program(&[]);
        let h = SvProgramHeader::parse(&s).unwrap();
        assert_eq!(h.version, *b"20");
        assert_eq!(h.field1, 0x59fa_e876);
        assert_eq!(h.field2, 668);

        assert!(matches!(
            SvProgramHeader::parse(b"XX20\0\0\0\0\0\0\0\0"),
            Err(OpcodeError::BadMagic { .. })
        ));
        assert!(matches!(
            SvProgramHeader::parse(b"Sv2"),
            Err(OpcodeError::TruncatedHeader { observed_len: 3 })
        ));
        // Error strings carry the namespace marker.
        assert!(
            OpcodeError::TruncatedHeader { observed_len: 0 }
                .to_string()
                .starts_with(SOFTPAL_OPCODE_ERROR_MARKER)
        );
    }

    #[test]
    fn opcode_table_covers_full_range_with_known_arities() {
        // Every id in 0x01..=0x21 is known; ids above are Unknown (arity None).
        for id in 0x01..=SV_MAX_OPCODE {
            let o = SvOpcode::from_id(id);
            assert!(o.is_known(), "id {id:#x} must be known");
            assert_eq!(o.id(), id);
            let a = o.arity().expect("known arity");
            assert!(a <= 2, "arity {a} in range");
        }
        assert_eq!(SvOpcode::from_id(0x17), SvOpcode::Call);
        assert!(SvOpcode::Call.is_call());
        // id 0x00 is unobserved: not in the known table (arity unproven).
        assert_eq!(SvOpcode::from_id(0x00), SvOpcode::Unknown(0x00));
        assert!(!SvOpcode::from_id(0x00).is_known());
        assert_eq!(SvOpcode::from_id(0x00).arity(), None);
        let u = SvOpcode::from_id(0x09a0);
        assert_eq!(u, SvOpcode::Unknown(0x09a0));
        assert!(!u.is_known());
        assert_eq!(u.arity(), None);
        assert_eq!(u.id(), 0x09a0);
    }

    #[test]
    fn walks_each_command_family_exhaustively() {
        // A nullary control op, an Expr binary op with a var-ref + typed-nil,
        // a TEXT-SHOW call, a SELECT call, and another engine Call.
        let tokens = [
            op(0x18),         // Control (arity 0)
            op(0x01),         // Expr binary
            val(0x8000_0002), // var-ref operand
            val(0x4000_0000), // typed-nil operand
            op(0x17),         // Call -> TEXT-SHOW
            val(target(CALL_CATEGORY_TEXT, 0x0002)),
            val(0x0000_1234), // text pointer operand (plain)
            op(0x17),         // Call -> SELECT
            val(target(CALL_CATEGORY_SELECT, SELECT_FUNCTION)),
            val(0x4000_0000),            // system immediate
            op(0x17),                    // Call -> other engine built-in
            val(target(0x0011, 0x0008)), // graphics/system dispatch
            val(0x0000_0005),
        ];
        let s = program(&tokens);
        let scan = OpcodeScan::parse(&s).unwrap();

        assert!(scan.is_exhaustive(), "no unknowns/trailing/truncation");
        assert_eq!(scan.unknown_count(), 0);
        assert_eq!(scan.trailing_bytes, 0);
        assert_eq!(scan.instructions.len(), 5);
        assert_eq!(scan.token_count(), tokens.len());
        // Consumed every token: header + all tokens.
        assert_eq!(
            SV_PROGRAM_HEADER_BYTE_LEN + tokens.len() * SV_TOKEN_BYTE_LEN,
            s.len()
        );

        assert_eq!(scan.text_show_count(), 1);
        assert_eq!(scan.select_count(), 1);
        assert_eq!(scan.call_count(), 3);
        assert_eq!(scan.call_target_count(), 3);

        // Families.
        assert!(matches!(
            scan.instructions[0].family,
            CommandFamily::Control
        ));
        assert!(matches!(scan.instructions[1].family, CommandFamily::Expr));
        assert!(matches!(
            scan.instructions[2].family,
            CommandFamily::TextShow { text_type: 0x0002 }
        ));
        assert!(matches!(scan.instructions[3].family, CommandFamily::Select));
        assert!(matches!(
            scan.instructions[4].family,
            CommandFamily::Call {
                target: CallTarget {
                    category: 0x0011,
                    function: 0x0008
                }
            }
        ));

        // Operand tags + byte-locatable offsets.
        let expr = &scan.instructions[1];
        assert_eq!(expr.operands().len(), 2);
        assert_eq!(expr.operands()[0].tag(), OperandTag::VAR);
        assert_eq!(expr.operands()[1].tag(), OperandTag::TYPED);
        assert!(expr.operands()[0].field_offset + 4 <= s.len());

        // Histograms.
        let oh = scan.opcode_histogram();
        assert_eq!(oh[&0x17], 3);
        assert_eq!(oh[&0x18], 1);
        assert_eq!(oh[&0x01], 1);
        let cc = scan.call_category_histogram();
        assert_eq!(cc[&CALL_CATEGORY_TEXT], 1);
        assert_eq!(cc[&CALL_CATEGORY_SELECT], 1);
        assert_eq!(cc[&0x0011], 1);
    }

    #[test]
    fn call_target_names_are_export_evidence_not_category_guesses() {
        assert_eq!(
            CallTarget {
                category: 0x0003,
                function: 0x0009
            }
            .semantic_name(),
            Some("sprite.set_center_offset")
        );
        assert_eq!(
            CallTarget {
                category: 0x000b,
                function: 0x0000
            }
            .semantic_name(),
            Some("video.play")
        );
        // Category alone is not evidence: unknown function ids remain named
        // only by their raw dispatch target for a future RE pass.
        assert_eq!(
            CallTarget {
                category: 0x0003,
                function: 0x0001
            }
            .semantic_name(),
            None
        );
    }

    #[test]
    fn operand_that_looks_like_an_operator_is_consumed_not_misread() {
        // op 0x0b (arity 1) followed by a raw immediate whose high word is the
        // operator tag (0x0001_09A0). A naive scan would mistake it for opcode
        // 0x09A0; the arity-driven walk consumes it as op 0x0b's operand.
        let tokens = [
            op(0x0b),
            val(0x0001_09a0), // immediate that *looks* like operator 0x09a0
            op(0x18),         // real operator after it
        ];
        let s = program(&tokens);
        let scan = OpcodeScan::parse(&s).unwrap();
        assert!(scan.is_exhaustive());
        assert_eq!(scan.instructions.len(), 2);
        assert_eq!(scan.instructions[0].opcode, SvOpcode::from_id(0x0b));
        assert_eq!(scan.instructions[0].operands()[0].raw, 0x0001_09a0);
        assert_eq!(scan.instructions[1].opcode, SvOpcode::from_id(0x18));
        assert_eq!(scan.unknown_count(), 0);
    }

    #[test]
    fn unknown_opcode_is_recorded_not_panicked() {
        // An operator token with an out-of-table opcode id (0x00FF). Recorded as
        // an unknown; the walk resyncs on the grid and types the next operator.
        let mut bad_op = [0u8; 4];
        bad_op[0..2].copy_from_slice(&0x00ffu16.to_le_bytes());
        bad_op[2..4].copy_from_slice(&SV_OPERATOR_TAG.to_le_bytes());
        let tokens = [bad_op, op(0x18)];
        let s = program(&tokens);
        let scan = OpcodeScan::parse(&s).unwrap();
        assert!(!scan.is_exhaustive());
        assert_eq!(scan.unknown_count(), 1);
        assert_eq!(scan.unknowns[0].token_lo, 0x00ff);
        assert_eq!(scan.unknowns[0].token_hi, SV_OPERATOR_TAG);
        // The following real operator is still typed.
        assert_eq!(scan.instructions.len(), 1);
        assert_eq!(scan.instructions[0].opcode, SvOpcode::from_id(0x18));
    }

    #[test]
    fn truncated_final_command_is_recorded_not_panicked() {
        // A Call (arity 2) at EOF with only one operand present.
        let tokens = [op(0x17), val(target(CALL_CATEGORY_TEXT, 0x0002))];
        let s = program(&tokens);
        let scan = OpcodeScan::parse(&s).unwrap();
        assert!(scan.truncated_final);
        assert!(!scan.is_exhaustive());
        // The partial instruction is still recorded with the operands it had.
        assert_eq!(scan.instructions.len(), 1);
        assert_eq!(scan.instructions[0].operands().len(), 1);
    }

    #[test]
    fn desync_token_at_operator_position_is_unknown() {
        // A token at an operator position whose high word is not the operator
        // tag (a raw value where an operator was expected).
        let tokens = [val(0x1234_5678), op(0x18)];
        let s = program(&tokens);
        let scan = OpcodeScan::parse(&s).unwrap();
        assert_eq!(scan.unknown_count(), 1);
        assert_eq!(scan.unknowns[0].token_hi, 0x1234);
        assert_eq!(scan.instructions.len(), 1);
    }
}
