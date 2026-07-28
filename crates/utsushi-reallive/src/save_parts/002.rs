impl SaveState {
    /// Construct an empty `SaveState` (no slots populated).
    pub fn new() -> Self {
        Self::default()
    }

    /// Borrow the system-save slot.
    pub fn system_save(&self) -> Option<&SystemSave> {
        self.system_save.as_ref()
    }

    /// Borrow the global-save slot.
    pub fn global_save(&self) -> Option<&GlobalSave> {
        self.global_save.as_ref()
    }

    /// Borrow the read-flags slot.
    pub fn read_flags(&self) -> Option<&ReadFlags> {
        self.read_flags.as_ref()
    }

    /// Replace the system-save slot. Returns the previous value if any.
    pub fn set_system_save(&mut self, save: SystemSave) -> Option<SystemSave> {
        self.system_save.replace(save)
    }

    /// Replace the global-save slot. Returns the previous value if any.
    pub fn set_global_save(&mut self, save: GlobalSave) -> Option<GlobalSave> {
        self.global_save.replace(save)
    }

    /// Replace the read-flags slot. Returns the previous value if any.
    pub fn set_read_flags(&mut self, flags: ReadFlags) -> Option<ReadFlags> {
        self.read_flags.replace(flags)
    }
}

impl Inspectable for SaveState {
    fn inspectable_id(&self) -> &'static str {
        SAVE_STATE_INSPECTABLE_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse(MANIFEST_PATH)?,
            StateValue::String {
                value: SAVE_STATE_MANIFEST.to_string(),
            },
        )?;
        if let Some(save) = &self.system_save {
            tree.insert(
                StatePath::parse(SYSTEM_SAVE_PATH)?,
                StateValue::String {
                    value: bytes_to_hex(&save.encode()),
                },
            )?;
        }
        if let Some(save) = &self.global_save {
            tree.insert(
                StatePath::parse(GLOBAL_SAVE_PATH)?,
                StateValue::String {
                    value: bytes_to_hex(&save.encode()),
                },
            )?;
        }
        if let Some(flags) = &self.read_flags {
            tree.insert(
                StatePath::parse(READ_FLAGS_PATH)?,
                StateValue::String {
                    value: bytes_to_hex(&flags.encode()),
                },
            )?;
        }
        Ok(tree)
    }
}

impl Restorable for SaveState {
    fn restore_state(&mut self, state: &StateTree) -> Result<RestoreReport, SnapshotError> {
        let mut new_system: Option<SystemSave> = None;
        let mut new_global: Option<GlobalSave> = None;
        let mut new_read: Option<ReadFlags> = None;
        let mut manifest_seen = false;
        let mut consumed = Vec::new();
        for (path, value) in state.iter() {
            match (path.as_str(), value) {
                (MANIFEST_PATH, StateValue::String { value }) => {
                    if value != SAVE_STATE_MANIFEST {
                        return Err(SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: format!(
                                "save_state manifest mismatch: observed={value} expected={SAVE_STATE_MANIFEST}"
                            ),
                        });
                    }
                    manifest_seen = true;
                    consumed.push(path.clone());
                }
                (SYSTEM_SAVE_PATH, StateValue::String { value }) => {
                    let bytes = decode_hex_payload(path, value)?;
                    let save = SystemSave::decode(&bytes).map_err(|err| {
                        SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: err.to_string(),
                        }
                    })?;
                    new_system = Some(save);
                    consumed.push(path.clone());
                }
                (GLOBAL_SAVE_PATH, StateValue::String { value }) => {
                    let bytes = decode_hex_payload(path, value)?;
                    let save = GlobalSave::decode(&bytes).map_err(|err| {
                        SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: err.to_string(),
                        }
                    })?;
                    new_global = Some(save);
                    consumed.push(path.clone());
                }
                (READ_FLAGS_PATH, StateValue::String { value }) => {
                    let bytes = decode_hex_payload(path, value)?;
                    let flags = ReadFlags::decode(&bytes).map_err(|err| {
                        SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: err.to_string(),
                        }
                    })?;
                    new_read = Some(flags);
                    consumed.push(path.clone());
                }
                (MANIFEST_PATH | SYSTEM_SAVE_PATH | GLOBAL_SAVE_PATH | READ_FLAGS_PATH, other) => {
                    return Err(SnapshotError::RestoreTypeMismatch {
                        path: path.clone(),
                        expected: "string",
                        found: other.type_tag(),
                    });
                }
                _ => {
                    return Err(SnapshotError::RestoreStatePathUnknown { path: path.clone() });
                }
            }
        }
        if !manifest_seen {
            return Err(SnapshotError::RestoreValueOutOfRange {
                path: StatePath::parse(MANIFEST_PATH)?,
                reason: "save_state manifest entry missing from snapshot".to_string(),
            });
        }
        self.system_save = new_system;
        self.global_save = new_global;
        self.read_flags = new_read;
        Ok(RestoreReport {
            consumed_paths: consumed,
            ignored_by_design: Vec::new(),
        })
    }
}

fn decode_hex_payload(path: &StatePath, value: &str) -> Result<Vec<u8>, SnapshotError> {
    hex_to_bytes(value).map_err(|reason| SnapshotError::RestoreValueOutOfRange {
        path: path.clone(),
        reason: format!("{}: {reason}", codes::STATE_HEX_DECODE_FAILURE),
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

/// Synthetic fixture builder for the "byte-identical round-trip" test.
/// Produces a minimal valid byte stream for each save kind that can be
/// `decode`d, then `encode`d back to the same bytes.
///
/// Held as a typed builder (not a free function) so the test suite can
/// extend it per audit-focus item without forking the construction
/// surface.
#[derive(Debug, Clone)]
pub struct SaveRoundTrip;

impl SaveRoundTrip {
    /// Build a synthetic `REALLIVE.sav` byte stream of the requested
    /// total `total_byte_len` (must be `>= 0x18 + magic_len + 1`).
    /// The leading u32 is set to `total_byte_len` so the file-size
    /// cross-check passes; the rest of the preamble is filled with
    /// stable, non-zero pinned values.
    pub fn synthetic_system_save(total_byte_len: usize) -> Vec<u8> {
        Self::synthetic_with_magic(
            total_byte_len,
            SYSTEM_SAVE_MAGIC.as_bytes(),
            0x02DC,
            AVG_DERIVED_COMPILER_VERSION,
        )
    }

    /// Build a synthetic `save999.sav` byte stream. The leading u32 is
    /// the per-format constant `0x000000A4`.
    pub fn synthetic_global_save(payload_byte_len: usize) -> Vec<u8> {
        let total = AVG_SAVE_PREAMBLE_BYTE_LEN + GLOBAL_SAVE_MAGIC.len() + 1 + payload_byte_len;
        let mut bytes = Self::synthetic_with_magic(
            total,
            GLOBAL_SAVE_MAGIC.as_bytes(),
            0x02E0,
            AVG_DERIVED_COMPILER_VERSION,
        );
        // Global save's leading u32 is a per-format constant (`0xA4`)
        // not the file size; rewrite it after the helper has filled in
        // the rest of the preamble.
        bytes[0x00..0x04].copy_from_slice(&0x0000_00A4u32.to_le_bytes());
        bytes
    }

    /// Build a synthetic `read.sav` byte stream with the supplied
    /// Shift-JIS title bytes.
    pub fn synthetic_read_flags(title_bytes: &[u8], payload_byte_len: usize) -> Vec<u8> {
        let total = AVG_SAVE_PREAMBLE_BYTE_LEN + title_bytes.len() + 1 + payload_byte_len;
        let mut bytes =
            Self::synthetic_with_magic(total, title_bytes, 0x02E7, AVG_DERIVED_COMPILER_VERSION);
        bytes[0x00..0x04].copy_from_slice(&0x0000_0098u32.to_le_bytes());
        bytes
    }

    fn synthetic_with_magic(
        total: usize,
        magic: &[u8],
        tail: u16,
        compiler_version: u32,
    ) -> Vec<u8> {
        let preamble = AvgSavePreamble {
            leading_u32: total as u32,
            compiler_version,
            timestamp: [0x07E9, 0x0003, 0x0002, 0x000B, 0x0012, 0x0027],
            padding_a: 0,
            tail,
        };
        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(&preamble.encode());
        out.extend_from_slice(magic);
        out.push(0u8);
        // The remaining payload bytes are a stable pseudo-random
        // pattern (`(idx % 251) as u8`) so a regression that drops a
        // byte from the round-trip surfaces as a positional mismatch
        // rather than a "all zeros" green test.
        let payload_len = total - AVG_SAVE_PREAMBLE_BYTE_LEN - magic.len() - 1;
        for idx in 0..payload_len {
            out.push((idx % 251) as u8);
        }
        debug_assert_eq!(out.len(), total);
        out
    }
}

impl fmt::Display for SystemSave {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "SystemSave {{ leading_u32={}, payload_bytes={} }}",
            self.preamble.leading_u32,
            self.payload.len()
        )
    }
}

impl fmt::Display for GlobalSave {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "GlobalSave {{ leading_u32={}, payload_bytes={} }}",
            self.preamble.leading_u32,
            self.payload.len()
        )
    }
}

impl fmt::Display for ReadFlags {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "ReadFlags {{ title_bytes={}, title_chars={}, payload_bytes={} }}",
            self.title_bytes.len(),
            self.title.chars().count(),
            self.payload.len()
        )
    }
}


