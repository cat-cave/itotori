//! UTSUSHI-206 — sparse `VarBanks` adopted into the substrate
//! `Inspectable` / `Restorable` traits.
//!
//! Replaces UTSUSHI-205's dense `[i32; 4096]` representation with sparse
//! `BTreeMap` storage so a snapshot of an unchanged machine stays under
//! 1 KB (only set indices appear). The integer-bank window is clamped to
//! the rlvm-documented **2 000 indices per bank** (per
//! `docs/research/reallive-engine.md` §G); writes past the ceiling emit a
//! [`VarBanksWarning::BankIndexOutOfRange`] and the index is clamped to
//! `BANK_INDEX_CAP - 1` rather than silently returning.
//!
//! # Bank layout
//!
//! - **Integer banks:** `intA`..`intM` (13 banks, bank bytes `0x00..=0x0C`,
//!   pinned by the UTSUSHI-205 mapping). Each bank stores its values in a
//!   sparse [`BTreeMap<u16, i32>`].
//! - **String banks:** `strS`, `strM`, `strK` (three banks, names per
//!   §G of the research doc). Each bank stores **raw Shift-JIS bytes**
//!   ([`Vec<u8>`]); no UTF-8 lossy round-trip. The byte codes pinned
//!   below (`BANK_BYTE_STR_M = 0x0D` etc.) are local conventions
//!   reserved outside the int-bank window — real Sweetie HD evidence
//!   for string-bank byte addressing is not yet in the research doc, so
//!   the codes are not load-bearing for any expression evaluator path
//!   today and are documented as such.
//! - **Store register:** a single `u32` (rlvm's documented type, see §G).
//!
//! # Substrate integration
//!
//! [`VarBanks`] implements [`utsushi_core::substrate::Inspectable`] and
//! [`utsushi_core::substrate::Restorable`]; the snapshot path serializes
//! the sparse maps as compact JSON strings under the `port.*` namespace
//! and the restore path validates type and shape end-to-end. A
//! round-trip through [`utsushi_core::substrate::InMemorySnapshotStore`]
//! is the load-bearing acceptance evidence in
//! `tests/var_banks.rs`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use utsushi_core::substrate::{
    Inspectable, Restorable, RestoreReport, SnapshotError, StatePath, StateTree, StateValue,
};

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

/// Bank byte for the `intM` bank (pinned by UTSUSHI-205, byte `0x0C`).
/// The matching `BANK_BYTE_INT_A` constant lives in
/// [`crate::expression`] so this module does not introduce a duplicate
/// re-export.
pub const BANK_BYTE_INT_M: u8 = 0x0C;
/// Bank byte for the `strM` bank. Reserved outside the int-bank window
/// (`0x00..=0x0C`); not load-bearing for the UTSUSHI-205 expression
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
const NAMESPACE_ROOT: &str = "port";

/// State-path leaf for the store register: `port.var_banks.store`.
const STORE_PATH: &str = "port.var_banks.store";

/// State-path leaf for the manifest metadata entry. Used so a
/// completely-empty machine still produces a non-empty `StateTree`
/// (the substrate rejects empty trees with
/// [`SnapshotError::EmptyStateTree`]).
const MANIFEST_PATH: &str = "port.var_banks.manifest";

/// Stable manifest string written under [`MANIFEST_PATH`]. Carries the
/// schema label so a future schema bump can be detected at restore time
/// without reaching for the substrate-pinned snapshot schema version.
const VAR_BANKS_MANIFEST: &str = "utsushi-reallive-var-banks/0.1.0-alpha";

/// Identifier of a single variable bank. The discriminant for each
/// integer bank matches UTSUSHI-205's bank-byte encoding (`0x00` =
/// `IntA`, ..., `0x0C` = `IntM`); the string banks use distinct,
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

    /// State-path-safe lowercase segment (`intA` → `int_a`,
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
    /// windows. The int window is pinned by UTSUSHI-205 (`0x00..=0x0C`);
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

/// Sparse representation of RealLive's typed variable banks.
///
/// Integer banks (`intA`..`intM`) and string banks (`strS`, `strM`,
/// `strK`) are stored as [`BTreeMap<u16, _>`] so only set indices
/// appear in the snapshot. The store register is a single `u32`.
///
/// See the module docs for the substrate `Inspectable` / `Restorable`
/// integration.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VarBanks {
    int_banks: BTreeMap<BankId, BTreeMap<u16, i32>>,
    str_banks: BTreeMap<BankId, BTreeMap<u16, Vec<u8>>>,
    store: u32,
}

impl VarBanks {
    /// Construct an empty `VarBanks` with no set indices and the store
    /// register cleared.
    pub fn new() -> Self {
        Self::default()
    }

    /// Read the value at `(bank, idx)`. Returns `None` for an unset
    /// index — sparse storage carries no implicit zero / empty-string
    /// fallback.
    pub fn get(&self, bank: BankId, idx: u16) -> Option<Value> {
        if bank.is_int() {
            self.int_banks
                .get(&bank)
                .and_then(|slots| slots.get(&idx))
                .copied()
                .map(Value::Int)
        } else {
            self.str_banks
                .get(&bank)
                .and_then(|slots| slots.get(&idx))
                .cloned()
                .map(Value::Str)
        }
    }

    /// Write `value` to `(bank, idx)`. Returns `Ok(())` on a clean
    /// write; returns
    /// `Err(VarBanksWarning::BankIndexOutOfRange { .. })` and clamps to
    /// `BANK_INDEX_CAP - 1` when `idx >= BANK_INDEX_CAP`.
    ///
    /// # Errors
    ///
    /// - [`VarBanksWarning::BankIndexOutOfRange`] when `idx >=
    ///   BANK_INDEX_CAP`. The write **still applies** at the clamped
    ///   index per the spec; the warning is the typed "no silent
    ///   fallback" surface.
    /// - Panics in this method are structurally impossible — a bank /
    ///   value-kind mismatch (e.g. writing a string into `intA`) is
    ///   rejected as a typed warning before any mutation happens. The
    ///   current variant set exposes no mismatch error variant because
    ///   the only constructor path is through `(BankId, Value)` and we
    ///   declare the mismatch loudly via `debug_assert!` plus a no-op
    ///   write so the caller cannot accidentally land a typed value in
    ///   the wrong bank. This matches the substrate-honesty posture: a
    ///   future caller hitting the mismatch path will see the
    ///   `debug_assert` immediately rather than a silent drop.
    pub fn set(&mut self, bank: BankId, idx: u16, value: Value) -> Result<(), VarBanksWarning> {
        let (clamped, warning) = if idx >= BANK_INDEX_CAP {
            (
                BANK_INDEX_CAP - 1,
                Some(VarBanksWarning::BankIndexOutOfRange {
                    bank: bank.as_str(),
                    requested: idx as u32,
                    cap: BANK_INDEX_CAP,
                }),
            )
        } else {
            (idx, None)
        };
        match (bank.is_int(), value) {
            (true, Value::Int(value)) => {
                self.int_banks
                    .entry(bank)
                    .or_default()
                    .insert(clamped, value);
            }
            (false, Value::Str(bytes)) => {
                self.str_banks
                    .entry(bank)
                    .or_default()
                    .insert(clamped, bytes);
            }
            (true, Value::Str(_)) => {
                debug_assert!(
                    false,
                    "VarBanks::set received string value for integer bank {}",
                    bank.as_str()
                );
            }
            (false, Value::Int(_)) => {
                debug_assert!(
                    false,
                    "VarBanks::set received integer value for string bank {}",
                    bank.as_str()
                );
            }
        }
        match warning {
            Some(warning) => Err(warning),
            None => Ok(()),
        }
    }

    /// Direct accessor for the store register (`u32`).
    pub fn store(&self) -> u32 {
        self.store
    }

    /// Direct setter for the store register (`u32`).
    pub fn set_store(&mut self, value: u32) {
        self.store = value;
    }

    /// Total number of set indices across every integer bank. Used by
    /// tests and the `Debug` impl to surface non-zero counts without
    /// printing every index.
    pub fn int_index_count(&self) -> usize {
        self.int_banks.values().map(BTreeMap::len).sum()
    }

    /// Total number of set indices across every string bank.
    pub fn str_index_count(&self) -> usize {
        self.str_banks.values().map(BTreeMap::len).sum()
    }
}

/// Wire form for a single sparse-bank payload. Carries the bank name
/// (canonical lowercase, e.g. `"intA"`) for round-trip cross-checking
/// and a sorted list of `(index, value)` pairs. The string-bank wire
/// form stores the raw bytes hex-encoded so the JSON layer cannot lose
/// a high-bit byte.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct IntBankWire {
    bank: String,
    #[serde(default)]
    entries: Vec<IntEntryWire>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IntEntryWire {
    idx: u16,
    value: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StrBankWire {
    bank: String,
    #[serde(default)]
    entries: Vec<StrEntryWire>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StrEntryWire {
    idx: u16,
    /// Raw Shift-JIS bytes, hex-encoded as lowercase ASCII (no `0x`
    /// prefix). The hex round-trip preserves every byte verbatim — the
    /// substrate's redaction filter rejects raw bytes that look like
    /// host paths, and Shift-JIS strings frequently contain backslashes
    /// (`\` / `0x5C`) that would otherwise trip the redaction layer.
    bytes_hex: String,
}

fn encode_int_bank(bank: BankId, slots: &BTreeMap<u16, i32>) -> Result<String, SnapshotError> {
    let wire = IntBankWire {
        bank: bank.as_str().to_string(),
        entries: slots
            .iter()
            .map(|(idx, value)| IntEntryWire {
                idx: *idx,
                value: *value,
            })
            .collect(),
    };
    serde_json::to_string(&wire).map_err(|err| SnapshotError::SerializationFailure {
        reason: err.to_string(),
    })
}

fn encode_str_bank(bank: BankId, slots: &BTreeMap<u16, Vec<u8>>) -> Result<String, SnapshotError> {
    let wire = StrBankWire {
        bank: bank.as_str().to_string(),
        entries: slots
            .iter()
            .map(|(idx, bytes)| StrEntryWire {
                idx: *idx,
                bytes_hex: bytes_to_hex(bytes),
            })
            .collect(),
    };
    serde_json::to_string(&wire).map_err(|err| SnapshotError::SerializationFailure {
        reason: err.to_string(),
    })
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(nibble_to_hex(byte >> 4));
        out.push(nibble_to_hex(byte & 0x0F));
    }
    out
}

fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    if !hex.len().is_multiple_of(2) {
        return Err("hex payload has odd length".to_string());
    }
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(hex.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_to_nibble(bytes[i])?;
        let lo = hex_to_nibble(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

fn nibble_to_hex(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        10..=15 => (b'a' + (nibble - 10)) as char,
        _ => '?',
    }
}

fn hex_to_nibble(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(10 + (byte - b'a')),
        b'A'..=b'F' => Ok(10 + (byte - b'A')),
        _ => Err(format!("invalid hex byte 0x{byte:02x}")),
    }
}

fn bank_path(bank: BankId) -> Result<StatePath, SnapshotError> {
    StatePath::parse(&format!("port.var_banks.{}", bank.path_segment()))
}

impl Inspectable for VarBanks {
    fn inspectable_id(&self) -> &'static str {
        VAR_BANKS_INSPECTABLE_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();
        // Manifest entry — always present so an empty machine still
        // produces a non-empty tree (the substrate rejects empty trees
        // with `SnapshotError::EmptyStateTree`).
        tree.insert(
            StatePath::parse(MANIFEST_PATH)?,
            StateValue::String {
                value: VAR_BANKS_MANIFEST.to_string(),
            },
        )?;
        // Store register — always present (even if zero) so the
        // round-trip restores it explicitly.
        tree.insert(
            StatePath::parse(STORE_PATH)?,
            StateValue::Uint {
                value: self.store as u64,
            },
        )?;
        // Sparse int banks — only non-empty banks emit an entry. This
        // is the "<1 KB empty machine" criterion: an empty bank is
        // simply absent.
        for bank in BankId::INT_BANKS {
            if let Some(slots) = self.int_banks.get(&bank) {
                if slots.is_empty() {
                    continue;
                }
                let payload = encode_int_bank(bank, slots)?;
                tree.insert(bank_path(bank)?, StateValue::String { value: payload })?;
            }
        }
        for bank in BankId::STR_BANKS {
            if let Some(slots) = self.str_banks.get(&bank) {
                if slots.is_empty() {
                    continue;
                }
                let payload = encode_str_bank(bank, slots)?;
                tree.insert(bank_path(bank)?, StateValue::String { value: payload })?;
            }
        }
        // Suppress unused-namespace lint: `NAMESPACE_ROOT` is the
        // documented prefix every path above starts with; the assertion
        // keeps the constant load-bearing.
        debug_assert!(MANIFEST_PATH.starts_with(NAMESPACE_ROOT));
        Ok(tree)
    }
}

impl Restorable for VarBanks {
    fn restore_state(&mut self, state: &StateTree) -> Result<RestoreReport, SnapshotError> {
        let mut new_int_banks: BTreeMap<BankId, BTreeMap<u16, i32>> = BTreeMap::new();
        let mut new_str_banks: BTreeMap<BankId, BTreeMap<u16, Vec<u8>>> = BTreeMap::new();
        let mut new_store: u32 = 0;
        let mut manifest_seen = false;
        let mut consumed = Vec::new();
        let ignored = Vec::new();
        for (path, value) in state.iter() {
            match (path.as_str(), value) {
                (MANIFEST_PATH, StateValue::String { value }) => {
                    if value != VAR_BANKS_MANIFEST {
                        return Err(SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: VarBanksRestoreError::ManifestMismatch {
                                observed: value.clone(),
                                expected: VAR_BANKS_MANIFEST,
                            }
                            .to_string(),
                        });
                    }
                    manifest_seen = true;
                    consumed.push(path.clone());
                }
                (MANIFEST_PATH, other) => {
                    return Err(SnapshotError::RestoreTypeMismatch {
                        path: path.clone(),
                        expected: "string",
                        found: other.type_tag(),
                    });
                }
                (STORE_PATH, StateValue::Uint { value }) => {
                    if *value > u32::MAX as u64 {
                        return Err(SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: format!("store register value {value} exceeds u32::MAX"),
                        });
                    }
                    new_store = *value as u32;
                    consumed.push(path.clone());
                }
                (STORE_PATH, other) => {
                    return Err(SnapshotError::RestoreTypeMismatch {
                        path: path.clone(),
                        expected: "uint",
                        found: other.type_tag(),
                    });
                }
                (raw, value) if raw.starts_with("port.var_banks.") => {
                    let bank = match resolve_bank_from_path(raw) {
                        Some(id) => id,
                        None => {
                            return Err(SnapshotError::RestoreStatePathUnknown {
                                path: path.clone(),
                            });
                        }
                    };
                    let payload = match value {
                        StateValue::String { value } => value,
                        other => {
                            return Err(SnapshotError::RestoreTypeMismatch {
                                path: path.clone(),
                                expected: "string",
                                found: other.type_tag(),
                            });
                        }
                    };
                    if bank.is_int() {
                        let slots = decode_int_bank(bank, payload).map_err(|reason| {
                            SnapshotError::RestoreValueOutOfRange {
                                path: path.clone(),
                                reason: VarBanksRestoreError::BankPayload {
                                    bank: bank.as_str().to_string(),
                                    reason,
                                }
                                .to_string(),
                            }
                        })?;
                        new_int_banks.insert(bank, slots);
                    } else {
                        let slots = decode_str_bank(bank, payload).map_err(|reason| {
                            SnapshotError::RestoreValueOutOfRange {
                                path: path.clone(),
                                reason: VarBanksRestoreError::BankPayload {
                                    bank: bank.as_str().to_string(),
                                    reason,
                                }
                                .to_string(),
                            }
                        })?;
                        new_str_banks.insert(bank, slots);
                    }
                    consumed.push(path.clone());
                }
                _ => {
                    return Err(SnapshotError::RestoreStatePathUnknown { path: path.clone() });
                }
            }
        }
        if !manifest_seen {
            return Err(SnapshotError::RestoreValueOutOfRange {
                path: StatePath::parse(MANIFEST_PATH)?,
                reason: "var_banks manifest entry missing from snapshot".to_string(),
            });
        }
        self.int_banks = new_int_banks;
        self.str_banks = new_str_banks;
        self.store = new_store;
        Ok(RestoreReport {
            consumed_paths: consumed,
            ignored_by_design: ignored,
        })
    }
}

fn resolve_bank_from_path(raw: &str) -> Option<BankId> {
    let suffix = raw.strip_prefix("port.var_banks.")?;
    for bank in BankId::INT_BANKS.iter().chain(BankId::STR_BANKS.iter()) {
        if bank.path_segment() == suffix {
            return Some(*bank);
        }
    }
    None
}

fn decode_int_bank(bank: BankId, payload: &str) -> Result<BTreeMap<u16, i32>, String> {
    let wire: IntBankWire =
        serde_json::from_str(payload).map_err(|err| format!("malformed int-bank JSON: {err}"))?;
    if wire.bank != bank.as_str() {
        return Err(format!(
            "int-bank payload labelled {:?} does not match path-bank {:?}",
            wire.bank,
            bank.as_str()
        ));
    }
    let mut slots = BTreeMap::new();
    for entry in wire.entries {
        if entry.idx >= BANK_INDEX_CAP {
            return Err(format!(
                "int-bank entry idx {} >= cap {}",
                entry.idx, BANK_INDEX_CAP
            ));
        }
        slots.insert(entry.idx, entry.value);
    }
    Ok(slots)
}

fn decode_str_bank(bank: BankId, payload: &str) -> Result<BTreeMap<u16, Vec<u8>>, String> {
    let wire: StrBankWire =
        serde_json::from_str(payload).map_err(|err| format!("malformed str-bank JSON: {err}"))?;
    if wire.bank != bank.as_str() {
        return Err(format!(
            "str-bank payload labelled {:?} does not match path-bank {:?}",
            wire.bank,
            bank.as_str()
        ));
    }
    let mut slots = BTreeMap::new();
    for entry in wire.entries {
        if entry.idx >= BANK_INDEX_CAP {
            return Err(format!(
                "str-bank entry idx {} >= cap {}",
                entry.idx, BANK_INDEX_CAP
            ));
        }
        let bytes = hex_to_bytes(&entry.bytes_hex)?;
        slots.insert(entry.idx, bytes);
    }
    Ok(slots)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bank_byte_table_maps_documented_int_letters() {
        assert_eq!(BankId::from_int_bank_byte(0x00), Some(BankId::IntA));
        assert_eq!(BankId::from_int_bank_byte(0x0C), Some(BankId::IntM));
        assert_eq!(BankId::from_int_bank_byte(0x0D), None);
        assert_eq!(BankId::from_int_bank_byte(0xFF), None);
    }

    #[test]
    fn bank_byte_table_includes_string_banks_outside_int_window() {
        assert_eq!(BankId::from_bank_byte(BANK_BYTE_STR_M), Some(BankId::StrM));
        assert_eq!(BankId::from_bank_byte(BANK_BYTE_STR_K), Some(BankId::StrK));
        assert_eq!(BankId::from_bank_byte(BANK_BYTE_STR_S), Some(BankId::StrS));
    }

    #[test]
    fn get_returns_none_for_unset_index() {
        let banks = VarBanks::new();
        assert!(banks.get(BankId::IntA, 0).is_none());
        assert!(banks.get(BankId::StrS, 0).is_none());
    }

    #[test]
    fn set_then_get_round_trips_through_sparse_storage() {
        let mut banks = VarBanks::new();
        banks
            .set(BankId::IntA, 0, Value::Int(42))
            .expect("clean set");
        banks
            .set(BankId::IntF, 7, Value::Int(-1))
            .expect("clean set");
        assert_eq!(banks.get(BankId::IntA, 0), Some(Value::Int(42)));
        assert_eq!(banks.get(BankId::IntF, 7), Some(Value::Int(-1)));
        assert_eq!(banks.get(BankId::IntA, 1), None);
    }

    #[test]
    fn out_of_range_set_emits_warning_and_clamps() {
        let mut banks = VarBanks::new();
        let err = banks
            .set(BankId::IntA, 2_000, Value::Int(99))
            .expect_err("out of range");
        match err {
            VarBanksWarning::BankIndexOutOfRange {
                bank,
                requested,
                cap,
            } => {
                assert_eq!(bank, "intA");
                assert_eq!(requested, 2_000);
                assert_eq!(cap, BANK_INDEX_CAP);
            }
        }
        // Clamped write landed at cap - 1.
        assert_eq!(
            banks.get(BankId::IntA, BANK_INDEX_CAP - 1),
            Some(Value::Int(99))
        );
    }

    #[test]
    fn str_bank_round_trips_raw_shift_jis_bytes() {
        let mut banks = VarBanks::new();
        // High-bit Shift-JIS bytes: 0x82 0xa0 = ｱ in half-width Katakana,
        // 0x5C is the half-width yen sign / Windows backslash. These
        // bytes are NOT valid UTF-8 and would be lost by any String
        // conversion.
        let bytes = vec![0x82, 0xa0, 0x5c, 0xff, 0x00, 0x01];
        banks
            .set(BankId::StrS, 0, Value::Str(bytes.clone()))
            .expect("clean str set");
        assert_eq!(banks.get(BankId::StrS, 0), Some(Value::Str(bytes)));
    }

    #[test]
    fn hex_round_trips_through_helper_functions() {
        let bytes = vec![0x00, 0x7f, 0x80, 0xff];
        let hex = bytes_to_hex(&bytes);
        assert_eq!(hex, "007f80ff");
        let parsed = hex_to_bytes(&hex).expect("clean parse");
        assert_eq!(parsed, bytes);
    }

    #[test]
    fn store_register_round_trips_through_setter() {
        let mut banks = VarBanks::new();
        banks.set_store(0xDEAD_BEEF);
        assert_eq!(banks.store(), 0xDEAD_BEEF);
    }
}
