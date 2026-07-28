use thiserror::Error;

/// Stable identifier of the `VarBanks` inspectable surface. Used by the
/// substrate facade so two snapshots from different ports cannot be
/// accidentally diffed.
pub const VAR_BANKS_INSPECTABLE_ID: &str = "utsushi-reallive-var-banks";

/// rlvm-documented per-bank index cap (`docs/research/reallive-engine.md`
/// §G — "rlvm caps each bank at 2 000 entries"). Out-of-range writes
/// emit a typed warning and clamp to `BANK_INDEX_CAP - 1`.
pub const BANK_INDEX_CAP: u16 = 2_000;

/// Number of typed integer banks (`intA`..`intM`).
pub const INT_BANK_COUNT: usize = 13;

/// Number of typed string banks (`strS`, `strM`, `strK`).
pub const STR_BANK_COUNT: usize = 3;

/// Bank byte for the `intM` bank (pinned by, byte `0x0C`).
/// The matching `BANK_BYTE_INT_A` constant lives in
/// [`crate::expression`] so this module does not introduce a duplicate
/// re-export.
pub const BANK_BYTE_INT_M: u8 = 0x0C;
/// Bank byte for the `strM` bank. Reserved outside the int-bank window
/// (`0x00..=0x0C`); not load-bearing for the expression
/// evaluator today (it only addresses int banks). Pinned here so future
/// nodes have a stable handle.
pub const BANK_BYTE_STR_M: u8 = 0x0D;
/// Bank byte for the `strK` bank. See [`BANK_BYTE_STR_M`].
pub const BANK_BYTE_STR_K: u8 = 0x0E;
/// Bank byte for the `strS` bank. rlvm convention places `strS` at the
/// post-int window; we pin it to `0x12` here as a stable, distinct byte.
/// See [`BANK_BYTE_STR_M`] for the load-bearing posture.
pub const BANK_BYTE_STR_S: u8 = 0x12;

/// State-tree namespace root the `VarBanks` Inspectable surface writes
/// under. Engine-port convention places port-owned fields under
/// `port.*`; the substrate forbids smuggling a new top-level namespace.
pub(super) const NAMESPACE_ROOT: &str = "port";

/// State-path leaf for the store register: `port.var_banks.store`.
pub(super) const STORE_PATH: &str = "port.var_banks.store";

/// State-path leaf for the manifest metadata entry. Used so a
/// completely-empty machine still produces a non-empty `StateTree`
/// (the substrate rejects empty trees with
/// [`SnapshotError::EmptyStateTree`]).
pub(super) const MANIFEST_PATH: &str = "port.var_banks.manifest";

/// Stable manifest string written under [`MANIFEST_PATH`]. Carries the
/// schema label so a future schema bump can be detected at restore time
/// without reaching for the substrate-pinned snapshot schema version.
pub(super) const VAR_BANKS_MANIFEST: &str = "utsushi-reallive-var-banks/0.1.0-alpha";

/// Identifier of a single variable bank. The discriminant for each
/// integer bank matches the bank-byte encoding (`0x00` =
/// `IntA`,..., `0x0C` = `IntM`); the string banks use distinct
/// reserved byte codes outside the int window. See [`BANK_BYTE_STR_M`]
/// for the load-bearing posture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum BankId {
    /// `intA` — general-purpose integer bank A (bank byte `0x00`).
    IntA,
    /// `intB` — general-purpose integer bank B (bank byte `0x01`).
    IntB,
    /// `intC` — general-purpose integer bank C (bank byte `0x02`).
    IntC,
    /// `intD` — general-purpose integer bank D (bank byte `0x03`).
    IntD,
    /// `intE` — general-purpose integer bank E (bank byte `0x04`).
    IntE,
    /// `intF` — general-purpose integer bank F (bank byte `0x05`).
    IntF,
    /// `intG` — general-purpose integer bank G (bank byte `0x06`).
    IntG,
    /// `intH` — general-purpose integer bank H (bank byte `0x07`).
    IntH,
    /// `intI` — general-purpose integer bank I (bank byte `0x08`).
    IntI,
    /// `intJ` — general-purpose integer bank J (bank byte `0x09`).
    IntJ,
    /// `intK` — general-purpose integer bank K (bank byte `0x0A`).
    IntK,
    /// `intL` — general-purpose integer bank L (bank byte `0x0B`).
    IntL,
    /// `intM` — general-purpose integer bank M (bank byte `0x0C`).
    IntM,
    /// `strS` — scratch string bank (bank byte `0x12`).
    StrS,
    /// `strM` — memory string bank (bank byte `0x0D`).
    StrM,
    /// `strK` — constants string bank (bank byte `0x0E`).
    StrK,
}

impl BankId {
    /// Canonical lowercase name (e.g. `"intA"`, `"strK"`). Used as the
    /// state-tree leaf segment under `port.var_banks.<name>`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::IntA => "intA",
            Self::IntB => "intB",
            Self::IntC => "intC",
            Self::IntD => "intD",
            Self::IntE => "intE",
            Self::IntF => "intF",
            Self::IntG => "intG",
            Self::IntH => "intH",
            Self::IntI => "intI",
            Self::IntJ => "intJ",
            Self::IntK => "intK",
            Self::IntL => "intL",
            Self::IntM => "intM",
            Self::StrS => "strS",
            Self::StrM => "strM",
            Self::StrK => "strK",
        }
    }

    /// State-path-safe lowercase segment (`intA` → `int_a`
    /// `strK` → `str_k`). The substrate's `StatePath` parser rejects
    /// uppercase ASCII, so the canonical name has to be lower-snake when
    /// it appears in the path.
    pub fn path_segment(self) -> &'static str {
        match self {
            Self::IntA => "int_a",
            Self::IntB => "int_b",
            Self::IntC => "int_c",
            Self::IntD => "int_d",
            Self::IntE => "int_e",
            Self::IntF => "int_f",
            Self::IntG => "int_g",
            Self::IntH => "int_h",
            Self::IntI => "int_i",
            Self::IntJ => "int_j",
            Self::IntK => "int_k",
            Self::IntL => "int_l",
            Self::IntM => "int_m",
            Self::StrS => "str_s",
            Self::StrM => "str_m",
            Self::StrK => "str_k",
        }
    }

    /// A stable, distinct byte code per bank, used only to disambiguate
    /// banks inside [`VarBanks::fingerprint`]. Integer banks reuse their
    /// pinned bank byte (`0x00..=0x0C`); string banks use their reserved
    /// codes (`0x0D`, `0x0E`, `0x12`). Not a wire format — purely a
    /// fingerprint discriminator.
    pub fn discriminant_byte(self) -> u8 {
        match self {
            Self::IntA => 0x00,
            Self::IntB => 0x01,
            Self::IntC => 0x02,
            Self::IntD => 0x03,
            Self::IntE => 0x04,
            Self::IntF => 0x05,
            Self::IntG => 0x06,
            Self::IntH => 0x07,
            Self::IntI => 0x08,
            Self::IntJ => 0x09,
            Self::IntK => 0x0A,
            Self::IntL => 0x0B,
            Self::IntM => BANK_BYTE_INT_M,
            Self::StrM => BANK_BYTE_STR_M,
            Self::StrK => BANK_BYTE_STR_K,
            Self::StrS => BANK_BYTE_STR_S,
        }
    }

    /// Whether the bank holds integer values.
    pub fn is_int(self) -> bool {
        matches!(
            self,
            Self::IntA
                | Self::IntB
                | Self::IntC
                | Self::IntD
                | Self::IntE
                | Self::IntF
                | Self::IntG
                | Self::IntH
                | Self::IntI
                | Self::IntJ
                | Self::IntK
                | Self::IntL
                | Self::IntM
        )
    }

    /// Whether the bank holds raw Shift-JIS string bytes.
    pub fn is_str(self) -> bool {
        !self.is_int()
    }

    /// Resolve an `intA..intM` bank from its raw byte (`0x00..=0x0C`).
    /// Returns `None` for any byte outside the documented int window.
    pub fn from_int_bank_byte(byte: u8) -> Option<BankId> {
        Some(match byte {
            0x00 => Self::IntA,
            0x01 => Self::IntB,
            0x02 => Self::IntC,
            0x03 => Self::IntD,
            0x04 => Self::IntE,
            0x05 => Self::IntF,
            0x06 => Self::IntG,
            0x07 => Self::IntH,
            0x08 => Self::IntI,
            0x09 => Self::IntJ,
            0x0A => Self::IntK,
            0x0B => Self::IntL,
            0x0C => Self::IntM,
            _ => return None,
        })
    }

    /// Resolve a bank from its raw byte across the int and string
    /// windows. The int window is pinned by (`0x00..=0x0C`);
    /// the string bank bytes (`0x0D`, `0x0E`, `0x12`) are reserved by
    /// this module and not load-bearing for any expression evaluator
    /// path today.
    pub fn from_bank_byte(byte: u8) -> Option<BankId> {
        if let Some(id) = Self::from_int_bank_byte(byte) {
            return Some(id);
        }
        match byte {
            BANK_BYTE_STR_M => Some(Self::StrM),
            BANK_BYTE_STR_K => Some(Self::StrK),
            BANK_BYTE_STR_S => Some(Self::StrS),
            _ => None,
        }
    }

    /// All integer banks in canonical order.
    pub const INT_BANKS: [BankId; INT_BANK_COUNT] = [
        Self::IntA,
        Self::IntB,
        Self::IntC,
        Self::IntD,
        Self::IntE,
        Self::IntF,
        Self::IntG,
        Self::IntH,
        Self::IntI,
        Self::IntJ,
        Self::IntK,
        Self::IntL,
        Self::IntM,
    ];

    /// All string banks in canonical order.
    pub const STR_BANKS: [BankId; STR_BANK_COUNT] = [Self::StrS, Self::StrM, Self::StrK];
}

/// Engine-neutral value carried by [`VarBanks::get`] / [`VarBanks::set`].
///
/// Integer values use `i32` (matching the expression evaluator's
/// arithmetic surface); string values carry **raw Shift-JIS bytes** as
/// [`Vec<u8>`] so the snapshot round-trip is byte-for-byte and no UTF-8
/// conversion can lose a high-bit byte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    /// Integer value (banks `intA`..`intM`).
    Int(i32),
    /// Raw Shift-JIS bytes (banks `strS`, `strM`, `strK`).
    Str(Vec<u8>),
}

/// Typed warning surface for [`VarBanks::set`]. The substrate-honesty
/// posture is "no silent fallback"; an out-of-range write returns the
/// warning to the caller AND clamps the index. The caller may bubble
/// the warning into a diagnostic sink or assert on it during testing.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum VarBanksWarning {
    /// A bank-index write targeted an index at or beyond
    /// [`BANK_INDEX_CAP`]. The store still applied the value at
    /// `BANK_INDEX_CAP - 1` (the rlvm-documented ceiling); the warning
    /// names the original requested index so the caller can surface a
    /// `utsushi.reallive.bank_index_out_of_range` event.
    #[error(
        "utsushi.reallive.bank_index_out_of_range: bank={bank} requested={requested} cap={cap}"
    )]
    BankIndexOutOfRange {
        /// Bank the write targeted.
        bank: &'static str,
        /// Original requested index (before clamping).
        requested: u32,
        /// Cap (`BANK_INDEX_CAP`). Pinned to a `u16` at the type level
        /// but rendered as `u32` here so callers can quote the
        /// out-of-range value verbatim even if it was originally
        /// supplied through a wider integer type.
        cap: u16,
    },
}

/// Typed error surface for [`VarBanks::restore`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum VarBanksRestoreError {
    /// The snapshot manifest string under [`MANIFEST_PATH`] did not
    /// match the pinned label. Surfaces the observed and expected
    /// strings so the audit trail names both verbatim.
    #[error(
        "utsushi.reallive.var_banks_manifest_mismatch: observed={observed} expected={expected}"
    )]
    ManifestMismatch {
        /// Observed manifest label.
        observed: String,
        /// Expected manifest label (the current `VAR_BANKS_MANIFEST`
        /// pin).
        expected: &'static str,
    },
    /// A bank-payload string under `port.var_banks.<bank>` failed to
    /// parse as the documented sparse-map JSON.
    #[error("utsushi.reallive.var_banks_bank_payload: bank={bank} reason={reason}")]
    BankPayload {
        /// Bank the malformed payload targeted.
        bank: String,
        /// Short reason string (no host paths, no raw bytes).
        reason: String,
    },
}
