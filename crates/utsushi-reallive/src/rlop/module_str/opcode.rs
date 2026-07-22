use super::*;

/// `module_str` module type byte. Pinned at `1` to match the
/// `(1, X)` convention established by
/// [`crate::rlop::module_msg`] / [`crate::rlop::module_sel`]
/// [`crate::rlop::module_sys`].
pub const STR_MODULE_TYPE: u8 = 1;
/// `module_str` module id byte. This is the REAL RealLive semantic id
/// `10` used by the `kaifuu-reallive` decompiler
/// (`opcode::module_id::STR`) and validated on the real bytecode. An
/// earlier revision mislabelled it `2` (which is actually `SEL`).
/// Corrected to `10`.
pub const STR_MODULE_ID: u8 = 10;

/// `strcpy` — `strX[dst]:= strX[src]`.
pub const OPCODE_STRCPY: u16 = 0x0000;
/// `strcat` — `strX[dst]:= strX[dst] + strX[src]`.
pub const OPCODE_STRCAT: u16 = 0x0002;
/// `strlen` — `intX[dst]:= byte-length(strX[src])`.
pub const OPCODE_STRLEN: u16 = 0x0003;
/// `strout` — emit `strX[src]` through the substrate sink.
pub const OPCODE_STROUT: u16 = 0x0009;
/// `intout` — emit ASCII decimal `intX[src]` through the substrate sink.
pub const OPCODE_INTOUT: u16 = 0x000a;
/// `Uppercase` — ASCII upper-case `strX[idx]` in place.
pub const OPCODE_UPPERCASE: u16 = 0x000b;
/// `Lowercase` — ASCII lower-case `strX[idx]` in place.
pub const OPCODE_LOWERCASE: u16 = 0x000c;
/// `itoa` — `strX[dst]:= decimal_ascii(int_src)`.
pub const OPCODE_ITOA: u16 = 0x000d;
/// `atoi` — `intX[dst]:= parse_decimal(strX[src])`.
pub const OPCODE_ATOI: u16 = 0x000e;
/// `strpos` — byte position of needle in haystack (`-1` on miss).
pub const OPCODE_STRPOS: u16 = 0x000f;
/// `strlpos` — last byte position of needle in haystack (`-1` on miss).
pub const OPCODE_STRLPOS: u16 = 0x0010;
/// `hantozen` — half-width → full-width transform on `strX[idx]`.
pub const OPCODE_HANTOZEN: u16 = 0x0011;
/// `zentohan` — full-width → half-width transform on `strX[idx]`.
pub const OPCODE_ZENTOHAN: u16 = 0x0012;

/// Stable enum naming the `module_str` opcodes implements.
/// Used by audit tooling to assert the registry covers every variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum StrOpcode {
    /// `strcpy` — copy.
    Strcpy,
    /// `strcat` — concatenate.
    Strcat,
    /// `strlen` — byte length.
    Strlen,
    /// `strout` — sink emission.
    Strout,
    /// `intout` — sink emission of an integer's decimal form.
    Intout,
    /// `Uppercase` — ASCII upper-case.
    Uppercase,
    /// `Lowercase` — ASCII lower-case.
    Lowercase,
    /// `itoa` — int → decimal-ASCII into a string slot.
    Itoa,
    /// `atoi` — decimal-ASCII string → int.
    Atoi,
    /// `strpos` — first byte position of needle.
    Strpos,
    /// `strlpos` — last byte position of needle.
    Strlpos,
    /// `hantozen` — half-width → full-width.
    Hantozen,
    /// `zentohan` — full-width → half-width.
    Zentohan,
}

impl StrOpcode {
    /// All `module_str` opcodes ships. The registry covers
    /// exactly this list.
    pub const ALL: &'static [StrOpcode] = &[
        Self::Strcpy,
        Self::Strcat,
        Self::Strlen,
        Self::Strout,
        Self::Intout,
        Self::Uppercase,
        Self::Lowercase,
        Self::Itoa,
        Self::Atoi,
        Self::Strpos,
        Self::Strlpos,
        Self::Hantozen,
        Self::Zentohan,
    ];

    /// Numeric opcode byte for this variant.
    pub fn opcode(self) -> u16 {
        match self {
            Self::Strcpy => OPCODE_STRCPY,
            Self::Strcat => OPCODE_STRCAT,
            Self::Strlen => OPCODE_STRLEN,
            Self::Strout => OPCODE_STROUT,
            Self::Intout => OPCODE_INTOUT,
            Self::Uppercase => OPCODE_UPPERCASE,
            Self::Lowercase => OPCODE_LOWERCASE,
            Self::Itoa => OPCODE_ITOA,
            Self::Atoi => OPCODE_ATOI,
            Self::Strpos => OPCODE_STRPOS,
            Self::Strlpos => OPCODE_STRLPOS,
            Self::Hantozen => OPCODE_HANTOZEN,
            Self::Zentohan => OPCODE_ZENTOHAN,
        }
    }

    /// Composite registry key the VM uses to dispatch this op.
    pub fn rlop_key(self) -> RlopKey {
        RlopKey::new(STR_MODULE_TYPE, STR_MODULE_ID, self.opcode())
    }

    /// Stable lowercase tag used by [`VmWarning::RlopArgsInvalid::op`].
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Strcpy => "str.strcpy",
            Self::Strcat => "str.strcat",
            Self::Strlen => "str.strlen",
            Self::Strout => "str.strout",
            Self::Intout => "str.intout",
            Self::Uppercase => "str.uppercase",
            Self::Lowercase => "str.lowercase",
            Self::Itoa => "str.itoa",
            Self::Atoi => "str.atoi",
            Self::Strpos => "str.strpos",
            Self::Strlpos => "str.strlpos",
            Self::Hantozen => "str.hantozen",
            Self::Zentohan => "str.zentohan",
        }
    }
}

/// Number of opcodes [`register_str_rlops`] mounts. Pinned so audit
/// tooling can assert the registry covers exactly the
/// surface without walking the helper body.
pub const STR_RLOP_COUNT: usize = StrOpcode::ALL.len();
