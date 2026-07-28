//! Snapshot-store backing for decoded save files.

use utsushi_core::substrate::{
    Inspectable, Restorable, RestoreReport, SnapshotError, StatePath, StateTree, StateValue,
};

use super::{GlobalSave, ReadFlags, SystemSave, codes};

/// Stable identifier of the [`SaveState`] inspectable surface. Used by
/// the substrate facade so two snapshots from different ports cannot
/// be accidentally diffed.
pub const SAVE_STATE_INSPECTABLE_ID: &str = "utsushi-reallive-save-state";

/// State-path leaf for the manifest entry. Used so a completely-empty
/// `SaveState` still produces a non-empty `StateTree` (the substrate
/// rejects empty trees with [`SnapshotError::EmptyStateTree`]).
pub(super) const MANIFEST_PATH: &str = "port.save_state.manifest";

/// State-path leaves for each on-disk slot. The substrate's
/// `StatePath` parser rejects uppercase ASCII, so the canonical names
/// are lower-snake.
const SYSTEM_SAVE_PATH: &str = "port.save_state.system_save";
const GLOBAL_SAVE_PATH: &str = "port.save_state.global_save";
const READ_FLAGS_PATH: &str = "port.save_state.read_flags";

/// Stable manifest string written under [`MANIFEST_PATH`]. Carries the
/// schema label so a future schema bump can be detected at restore
/// time.
pub(super) const SAVE_STATE_MANIFEST: &str = "utsushi-reallive-save-state/0.1.0-alpha";

/// In-memory backing for the save state — the substrate's
/// [`Inspectable`] / [`Restorable`] integration point. The on-disk
/// `SystemSave` / `GlobalSave` / `ReadFlags` serialisers are
/// **strictly separate** from this struct: writing to bytes never
/// touches the substrate; restoring from the substrate never touches
/// the disk.
///
/// Each on-disk slot is held as an [`Option`] so a snapshot can carry
/// a partial set (e.g. only the system save, with no global save yet
/// loaded). The substrate snapshot serialises each present slot as a
/// hex-encoded byte payload under `port.save_state.*`; the hex
/// round-trip avoids the substrate's redaction filter triggering on
/// raw high-bit bytes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SaveState {
    system_save: Option<SystemSave>,
    global_save: Option<GlobalSave>,
    read_flags: Option<ReadFlags>,
}

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
