//! Substrate `Inspectable` / `Restorable` for [`super::Vm`].
//!
//! Snapshot path constants, wire types, encode/decode helpers, and the
//! trait impls that round-trip the VM through a substrate [`StateTree`].

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use utsushi_core::substrate::{
    Inspectable, Restorable, RestoreReport, SnapshotError, StatePath, StateTree, StateValue,
};

use crate::rlop::{LongOp, LongOpId};

use super::{SceneId, StackFrame, StackFrameKind, Vm};

/// Stable identifier of the VM `Inspectable` surface. Used by the
/// substrate facade so two snapshots from different ports cannot be
/// accidentally diffed.
pub const VM_INSPECTABLE_ID: &str = "utsushi-reallive-vm";

/// State-tree namespace root for the VM. Engine-port convention places
/// port-owned fields under `port.*`.
const NAMESPACE_ROOT: &str = "port";

/// State-path leaf for the manifest entry. Always present so an empty
/// VM still produces a non-empty `StateTree`.
pub(super) const MANIFEST_PATH: &str = "port.utsushi_reallive_vm.manifest";
/// State-path leaf for `scene`.
const SCENE_PATH: &str = "port.utsushi_reallive_vm.scene";
/// State-path leaf for `pc`.
const PC_PATH: &str = "port.utsushi_reallive_vm.pc";
/// State-path leaf for the call stack payload.
const STACK_PATH: &str = "port.utsushi_reallive_vm.stack";
/// State-path leaf for the queued longop payload.
const LONGOP_PATH: &str = "port.utsushi_reallive_vm.longop_queue";
/// State-path leaf for the halt flag.
const HALTED_PATH: &str = "port.utsushi_reallive_vm.halted";

/// Manifest string under [`MANIFEST_PATH`]. Carries the schema label
/// so a future schema bump can be detected at restore time.
pub(super) const VM_MANIFEST: &str = "utsushi-reallive-vm/0.1.0-alpha";

// Substrate Inspectable / Restorable

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StackFrameWire {
    frame_kind: String,
    return_pc: u32,
    return_scene: Option<SceneId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StackWire {
    frames: Vec<StackFrameWire>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LongOpWire {
    id: u64,
    state_hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LongOpQueueWire {
    queue: Vec<LongOpWire>,
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

fn encode_stack(stack: &[StackFrame]) -> Result<String, SnapshotError> {
    let wire = StackWire {
        frames: stack
            .iter()
            .map(|frame| StackFrameWire {
                frame_kind: frame.frame_kind.as_str().to_string(),
                return_pc: frame.return_pc,
                return_scene: frame.return_scene,
            })
            .collect(),
    };
    serde_json::to_string(&wire).map_err(|err| SnapshotError::SerializationFailure {
        reason: err.to_string(),
    })
}

fn decode_stack(payload: &str) -> Result<Vec<StackFrame>, String> {
    let wire: StackWire =
        serde_json::from_str(payload).map_err(|err| format!("malformed stack JSON: {err}"))?;
    wire.frames
        .into_iter()
        .map(|frame| {
            let kind = StackFrameKind::parse_wire(&frame.frame_kind)
                .ok_or_else(|| format!("unknown stack frame kind {:?}", frame.frame_kind))?;
            Ok(StackFrame {
                return_scene: frame.return_scene,
                return_pc: frame.return_pc,
                frame_kind: kind,
            })
        })
        .collect()
}

fn encode_longop_queue(queue: &VecDeque<LongOp>) -> Result<String, SnapshotError> {
    let wire = LongOpQueueWire {
        queue: queue
            .iter()
            .map(|op| LongOpWire {
                id: op.id.0,
                state_hex: bytes_to_hex(&op.private_state),
            })
            .collect(),
    };
    serde_json::to_string(&wire).map_err(|err| SnapshotError::SerializationFailure {
        reason: err.to_string(),
    })
}

fn decode_longop_queue(payload: &str) -> Result<VecDeque<LongOp>, String> {
    let wire: LongOpQueueWire = serde_json::from_str(payload)
        .map_err(|err| format!("malformed longop_queue JSON: {err}"))?;
    let mut out = VecDeque::with_capacity(wire.queue.len());
    for op in wire.queue {
        let private_state = hex_to_bytes(&op.state_hex)?;
        out.push_back(LongOp::new(LongOpId(op.id), private_state));
    }
    Ok(out)
}

impl Inspectable for Vm {
    fn inspectable_id(&self) -> &'static str {
        VM_INSPECTABLE_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse(MANIFEST_PATH)?,
            StateValue::String {
                value: VM_MANIFEST.to_string(),
            },
        )?;
        tree.insert(
            StatePath::parse(SCENE_PATH)?,
            StateValue::Uint {
                value: self.scene as u64,
            },
        )?;
        tree.insert(
            StatePath::parse(PC_PATH)?,
            StateValue::Uint {
                value: self.pc as u64,
            },
        )?;
        tree.insert(
            StatePath::parse(HALTED_PATH)?,
            StateValue::Bool { value: self.halted },
        )?;
        tree.insert(
            StatePath::parse(STACK_PATH)?,
            StateValue::String {
                value: encode_stack(&self.stack)?,
            },
        )?;
        tree.insert(
            StatePath::parse(LONGOP_PATH)?,
            StateValue::String {
                value: encode_longop_queue(&self.longop_queue)?,
            },
        )?;
        // Embed the var-banks substrate impl. The banks own their own
        // sub-tree under `port.var_banks.*` so we merge it here.
        let banks_tree = self.banks.inspect_state()?;
        for (path, value) in banks_tree.iter() {
            tree.insert(path.clone(), value.clone())?;
        }
        debug_assert!(MANIFEST_PATH.starts_with(NAMESPACE_ROOT));
        Ok(tree)
    }
}

impl Restorable for Vm {
    fn restore_state(&mut self, state: &StateTree) -> Result<RestoreReport, SnapshotError> {
        let mut new_scene: SceneId = self.scene;
        let mut new_pc: u32 = self.pc;
        let mut new_halted = false;
        let mut new_stack: Vec<StackFrame> = Vec::new();
        let mut new_longop_queue: VecDeque<LongOp> = VecDeque::new();
        let mut manifest_seen = false;
        let mut scene_seen = false;
        let mut pc_seen = false;
        let mut consumed = Vec::new();

        // The var-banks substrate impl is delegated below; collect a
        // sub-tree of `port.var_banks.*` paths and forward them
        // verbatim so the bank-side restore stays the single source of
        // truth.
        let mut banks_tree = StateTree::new();
        let mut banks_consumed = Vec::new();

        for (path, value) in state.iter() {
            let raw = path.as_str();
            match (raw, value) {
                (MANIFEST_PATH, StateValue::String { value }) => {
                    if value != VM_MANIFEST {
                        return Err(SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: format!(
                                "vm manifest mismatch: observed={value} expected={VM_MANIFEST}"
                            ),
                        });
                    }
                    manifest_seen = true;
                    consumed.push(path.clone());
                }
                (SCENE_PATH, StateValue::Uint { value }) => {
                    if *value > u16::MAX as u64 {
                        return Err(SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: format!("scene id {value} exceeds u16::MAX"),
                        });
                    }
                    new_scene = *value as SceneId;
                    scene_seen = true;
                    consumed.push(path.clone());
                }
                (PC_PATH, StateValue::Uint { value }) => {
                    if *value > u32::MAX as u64 {
                        return Err(SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: format!("pc {value} exceeds u32::MAX"),
                        });
                    }
                    new_pc = *value as u32;
                    pc_seen = true;
                    consumed.push(path.clone());
                }
                (HALTED_PATH, StateValue::Bool { value }) => {
                    new_halted = *value;
                    consumed.push(path.clone());
                }
                (STACK_PATH, StateValue::String { value }) => {
                    new_stack = decode_stack(value).map_err(|reason| {
                        SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason,
                        }
                    })?;
                    consumed.push(path.clone());
                }
                (LONGOP_PATH, StateValue::String { value }) => {
                    new_longop_queue = decode_longop_queue(value).map_err(|reason| {
                        SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason,
                        }
                    })?;
                    consumed.push(path.clone());
                }
                // Type-mismatch fallbacks: each sits after every typed arm so
                // the `other` binding never shadows a specific-type match.
                (SCENE_PATH | PC_PATH, other) => {
                    return Err(SnapshotError::RestoreTypeMismatch {
                        path: path.clone(),
                        expected: "uint",
                        found: other.type_tag(),
                    });
                }
                (HALTED_PATH, other) => {
                    return Err(SnapshotError::RestoreTypeMismatch {
                        path: path.clone(),
                        expected: "bool",
                        found: other.type_tag(),
                    });
                }
                (MANIFEST_PATH | STACK_PATH | LONGOP_PATH, other) => {
                    return Err(SnapshotError::RestoreTypeMismatch {
                        path: path.clone(),
                        expected: "string",
                        found: other.type_tag(),
                    });
                }
                (raw, value) if raw.starts_with("port.var_banks.") => {
                    banks_tree.insert(path.clone(), value.clone())?;
                    banks_consumed.push(path.clone());
                }
                _ => {
                    return Err(SnapshotError::RestoreStatePathUnknown { path: path.clone() });
                }
            }
        }
        if !manifest_seen {
            return Err(SnapshotError::RestoreValueOutOfRange {
                path: StatePath::parse(MANIFEST_PATH)?,
                reason: "vm manifest entry missing from snapshot".to_string(),
            });
        }
        if !scene_seen {
            return Err(SnapshotError::RestoreValueOutOfRange {
                path: StatePath::parse(SCENE_PATH)?,
                reason: "vm scene entry missing from snapshot".to_string(),
            });
        }
        if !pc_seen {
            return Err(SnapshotError::RestoreValueOutOfRange {
                path: StatePath::parse(PC_PATH)?,
                reason: "vm pc entry missing from snapshot".to_string(),
            });
        }

        let banks_report = self.banks.restore_state(&banks_tree)?;
        consumed.extend(banks_report.consumed_paths);

        self.scene = new_scene;
        self.pc = new_pc;
        self.halted = new_halted;
        self.stack = new_stack;
        self.longop_queue = new_longop_queue;
        Ok(RestoreReport {
            consumed_paths: consumed,
            ignored_by_design: banks_report.ignored_by_design,
        })
    }
}
