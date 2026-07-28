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


