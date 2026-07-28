use super::state::{IntBankWire, IntEntryWire, StrBankWire, StrEntryWire, VarBanks};
use super::types::*;
use std::collections::BTreeMap;
use utsushi_core::substrate::{
    Inspectable, Restorable, RestoreReport, SnapshotError, StatePath, StateTree, StateValue,
};

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

pub(super) fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(nibble_to_hex(byte >> 4));
        out.push(nibble_to_hex(byte & 0x0F));
    }
    out
}

pub(super) fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
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
                    let Some(bank) = resolve_bank_from_path(raw) else {
                        return Err(SnapshotError::RestoreStatePathUnknown { path: path.clone() });
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
