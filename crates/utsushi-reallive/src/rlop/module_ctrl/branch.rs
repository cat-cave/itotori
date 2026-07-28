//! Real-numbered branch-following and linear-walk control-flow operations.

use std::sync::Arc;

use crate::rlop::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::vm::Vm;

use super::MODULE_JMP_ID;

// Real-bytes control-flow numbering + exhaustive-linear-walk registrar

/// The real `module_jmp` opcode numbering (rlvm `module_jmp.cc`)
/// cross-checked against the `kaifuu-reallive` decompiler's byte-validated
/// `goto_kind` id sets on the observed corpus + Kanon. Each entry is `(opcode
/// semantic name)`.
///
/// This SUPERSEDES the speculative numbering
/// (`gosub`/`ret`/`farcall`/`rtl` invented at `0x10`/`0x12`/`0x20`/`0x22`):
/// on the real bytes `gosub` is opcode 5, `ret`/`jump`/`farcall`/`rtl` are
/// 10..=13, and the `*_with` variants are 16..=19.
pub const JMP_REAL_OPCODES: &[(u16, &str)] = &[
    (0, "goto"),
    (1, "goto_if"),
    (2, "goto_unless"),
    (3, "goto_on"),
    (4, "goto_case"),
    (5, "gosub"),
    (6, "gosub_if"),
    (7, "gosub_unless"),
    (8, "gosub_on"),
    (9, "gosub_case"),
    (10, "ret"),
    (11, "jump"),
    (12, "farcall"),
    (13, "rtl"),
    (16, "gosub_with"),
    (17, "ret_with"),
    (18, "farcall_with"),
    (19, "rtl_with"),
];

/// The RealLive lattice module-type bytes a `module_jmp` command is
/// observed under (type is a compiler-version artifact; module_id 1 is the
/// real semantic key). The cross-scene `farcall` variant is observed under
/// type 2 on Kanon, so all three are registered.
pub(super) const JMP_LATTICE_TYPES: [u8; 3] = [0, 1, 2];

/// A control-flow opcode dispatched as an exhaustive-linear-walk
/// [`DispatchOutcome::Advance`], carrying its real opcode + semantic name
/// for identity. See [`register_control_flow_linear_walk`].
#[derive(Debug, Clone, Copy)]
pub struct JmpLinearWalkOp {
    /// Real `module_jmp` opcode.
    pub opcode: u16,
    /// Semantic name (`"goto"`, `"gosub"`, `"farcall"`, …).
    pub name: &'static str,
}

impl RLOperation for JmpLinearWalkOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Advance
    }
}

/// Register the FULL real-numbered `module_jmp` control-flow family under
/// every observed lattice type, dispatched as an exhaustive-linear-walk
/// [`DispatchOutcome::Advance`].
///
/// This is the registrar the full-module cataloging **replay** mounts (in
/// place of [`register_control_flow_rlops`]): the replay must VISIT every
/// command in a scene — following branches would both skip the un-taken
/// arms (cataloguing fewer commands) and spin forever on the input-gated
/// loops a headless deterministic walk cannot exit. The decoder
/// ([`crate::bytecode_element`]) already fully consumes the goto-family
/// jump-target framing, so the walk never desyncs. The branch-execution
/// state machine (real `Jump` / `Subroutine` / `FarCall` outcomes) lives in
/// the [`GotoOp`] / [`GosubOp`] / [`FarcallOp`] family above — unit-tested
/// and driven by the syscall route dispatcher — and is intentionally NOT
/// used by the cataloguing replay.
///
/// Returns the number of `(type, opcode)` keys registered.
pub fn register_control_flow_linear_walk(registry: &mut RlopRegistry) -> usize {
    let mut registered = 0usize;
    for &(opcode, name) in JMP_REAL_OPCODES {
        for module_type in JMP_LATTICE_TYPES {
            let key = RlopKey::new(module_type, MODULE_JMP_ID, opcode);
            registry.register(key, Arc::new(JmpLinearWalkOp { opcode, name }));
            registered += 1;
        }
    }
    registered
}

mod following;

pub use following::*;
