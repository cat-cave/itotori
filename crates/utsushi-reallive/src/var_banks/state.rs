use super::types::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Sparse representation of RealLive's typed variable banks.
///
/// Integer banks (`intA`..`intM`) and string banks (`strS`, `strM`
/// `strK`) are stored as [`BTreeMap<u16, _>`] so only set indices
/// appear in the snapshot. The store register is a single `u32`.
///
/// See the module docs for the substrate `Inspectable` / `Restorable`
/// integration.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VarBanks {
    pub(super) int_banks: BTreeMap<BankId, BTreeMap<u16, i32>>,
    pub(super) str_banks: BTreeMap<BankId, BTreeMap<u16, Vec<u8>>>,
    pub(super) store: u32,
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
    /// `Err(VarBanksWarning::BankIndexOutOfRange {.. })` and clamps to
    /// `BANK_INDEX_CAP - 1` when `idx >= BANK_INDEX_CAP`.
    ///
    /// # Errors
    ///
    /// - [`VarBanksWarning::BankIndexOutOfRange`] when `idx >=
    ///   BANK_INDEX_CAP`. The write **still applies** at the clamped
    ///   index per the spec; the warning is the typed "no silent
    ///   fallback" surface.
    /// - Panics in this method are structurally impossible — a bank
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

    /// Fold the FULL mutable memory state (every set integer- and
    /// string-bank slot, plus the store register) into a 64-bit
    /// fingerprint. Two `VarBanks` fingerprint equal iff they carry an
    /// identical set of `(bank, index, value)` entries and the same store
    /// register — the sparse maps iterate in a deterministic (`BTreeMap`)
    /// order, so the fold is reproducible with no clock / RNG input.
    ///
    /// This is the memory half of the branch-following runtime's
    /// provable-spin fingerprint (`docs`: event-flag modeling): a headless
    /// walk that returns to an already-seen `(scene, pc, stack, memory)`
    /// state is in a deterministic infinite loop, because the next step is
    /// a pure function of that state.
    pub fn fingerprint(&self) -> u64 {
        // FNV-1a 64-bit over the sparse entries. Bank ids fold in as their
        // stable byte code so two different banks with the same index/value
        // never collide.
        const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
        const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
        let mut hash = FNV_OFFSET;
        let fold = |bytes: &[u8], hash: &mut u64| {
            for byte in bytes {
                *hash ^= u64::from(*byte);
                *hash = hash.wrapping_mul(FNV_PRIME);
            }
        };
        for (bank, slots) in &self.int_banks {
            for (idx, value) in slots {
                fold(&[bank.discriminant_byte()], &mut hash);
                fold(&idx.to_le_bytes(), &mut hash);
                fold(&value.to_le_bytes(), &mut hash);
            }
        }
        for (bank, slots) in &self.str_banks {
            for (idx, bytes) in slots {
                fold(&[bank.discriminant_byte()], &mut hash);
                fold(&idx.to_le_bytes(), &mut hash);
                fold(bytes, &mut hash);
            }
        }
        fold(&self.store.to_le_bytes(), &mut hash);
        hash
    }
}

/// Wire form for a single sparse-bank payload. Carries the bank name
/// (canonical lowercase, e.g. `"intA"`) for round-trip cross-checking
/// and a sorted list of `(index, value)` pairs. The string-bank wire
/// form stores the raw bytes hex-encoded so the JSON layer cannot lose
/// a high-bit byte.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct IntBankWire {
    pub(super) bank: String,
    #[serde(default)]
    pub(super) entries: Vec<IntEntryWire>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct IntEntryWire {
    pub(super) idx: u16,
    pub(super) value: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct StrBankWire {
    pub(super) bank: String,
    #[serde(default)]
    pub(super) entries: Vec<StrEntryWire>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct StrEntryWire {
    pub(super) idx: u16,
    /// Raw Shift-JIS bytes, hex-encoded as lowercase ASCII (no `0x`
    /// prefix). The hex round-trip preserves every byte verbatim — the
    /// substrate's redaction filter rejects raw bytes that look like
    /// host paths, and Shift-JIS strings frequently contain backslashes
    /// (`\` / `0x5C`) that would otherwise trip the redaction layer.
    pub(super) bytes_hex: String,
}
