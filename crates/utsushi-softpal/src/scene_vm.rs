//! Sv20 execution: values, branches, calls, and honest stop diagnostics.
use crate::scene_runtime::{
    ChoiceOption, RuntimeBankWrite, RuntimeDiagnostic, RuntimeTraceEvent, SceneStep,
};
use kaifuu_softpal::{
    CommandFamily, FileDat, Instruction, OpcodeScan, Operand, OperandTag, PacArchive, RawCommand,
};
use std::collections::{BTreeMap, HashMap};
mod scene_vm_calls;
mod scene_vm_support;
pub(crate) use scene_vm_support::point_offsets;

/// Sena initializes `user_mem` with 0x10000 i32 cells, matching the original
/// engine (`pal-vm/src/runtime.rs:32`, `:957`).
const USER_MEM_LEN: usize = 0x10000;
/// Sena allocates the temporary operand bank at the same original-engine size
/// as `user_mem` (`pal-vm/src/runtime.rs:32`, `:959`).
const TEMP_MEM_LEN: usize = 0x10000;
#[derive(Default)]
struct Frame {
    locals: BTreeMap<u32, i32>,
    arguments: Vec<i32>,
}

/// Read-only PAC resources available to native file calls for one VM run.
#[derive(Debug)]
pub(crate) struct ResourceAssets<'a> {
    pub(crate) archives: Vec<(PacArchive, &'a [u8])>,
    pub(crate) file_dat: FileDat,
}

#[derive(Debug)]
struct RuntimeFile {
    bytes: Vec<u8>,
    cursor: usize,
    table: Option<scene_vm_support::FileTable>,
    table_cursor: usize,
}

pub(crate) struct Vm<'a> {
    instructions: &'a [Instruction],
    by_offset: HashMap<usize, usize>,
    labels: &'a [usize],
    commands: HashMap<usize, &'a RawCommand>,
    texts: &'a HashMap<u32, String>,
    frames: Vec<Frame>,
    globals: BTreeMap<u32, i32>,
    shared: BTreeMap<u32, i32>,
    /// Operand tag `0x1`: `user_mem[vars[lo]]`.
    ///
    /// This is a fixed, zero-initialized bank. Unlike Sena's permissive
    /// fallback, the compact runtime makes an invalid script index a visible
    /// stop so an unproven script path cannot silently change behavior.
    user_mem: Vec<i32>,
    /// Writable `MEM.DAT` i32-word shadow for operand tag `0x6`.
    mem_dat: Option<Vec<i32>>,
    /// Operand tag `0x5`: temporary memory addressed through a local slot.
    temp_mem: Vec<i32>,
    argument_base: i32,
    /// Category-18 dynamic strings use a rotating 16-slot native buffer.
    dynamic_strings: Vec<String>,
    dynamic_string_cursor: usize,
    /// Validated PAC + FILE.DAT assets used by category-18 file calls.
    resources: Option<ResourceAssets<'a>>,
    /// One-based, reusable native file handles. A missing/closed slot is never
    /// converted into a zero result: callers stop at a named diagnostic.
    file_handles: Vec<Option<RuntimeFile>>,
    returns: Vec<usize>,
    stack: Vec<i32>,
    ip: usize,
    steps: Vec<SceneStep>,
    diagnostics: Vec<RuntimeDiagnostic>,
    trace: Vec<RuntimeTraceEvent>,
    /// Category `0x0011:0x001c` work-process attachment; no launcher data is invented.
    work_process_attached: bool,
    /// Category `0x000f:0x0005` exchanges this PAL-owned mode value.
    debug_window_state: i32,
    /// Category `0x0012:0x0023` retains the script point selected for the
    /// next native work process. The compact VM has no PAL process scheduler,
    /// but must retain and consume this contract exactly.
    last_process_point: i32,
    /// Category `0x000d:0x0015`'s script-visible BGV level.  PAL initializes
    /// this audio field to 50; it is deliberately distinct from an audio
    /// renderer, which this compact VM does not own.
    bgv_volume: i32,
    /// Category `0x000f:0x0004`'s three native overlay arguments.
    system_window_overlay: Option<(i32, i32, i32)>,
    /// Category `0x0009:0x0034` cancels this native scene-skip latch.
    ///
    /// The compact VM has no scene-skip producer yet, but retaining the latch
    /// makes this a state transition rather than an invisible pass-through.
    scene_skip_active: bool,
    /// Category `0x0009:0x0002` controls timer-based ADV progression.
    text_auto_enabled: bool,
    /// Category `0x0009:0x0000` controls user-triggered ADV skipping.
    text_skip_enabled: bool,
    /// Slots currently represented by the compact system-button model.
    system_button_slots: std::collections::BTreeSet<i32>,
    /// Category `0x0009:0x000e` clears this PAL-owned temporary work bank.
    scene_scratch: BTreeMap<u32, i32>,
    /// Active category-17 action counters in the compact scheduler model.
    active_actions: std::collections::BTreeSet<i32>,
    /// Live category-3 sprite slots known to the compact scene state.
    sprite_slots: std::collections::BTreeSet<i32>,
    branches: usize,
    instruction_count: usize,
}

include!("scene_vm/scene_vm_execution.rs");
include!("scene_vm/scene_vm_dispatch.rs");
include!("scene_vm/scene_vm_resources.rs");
include!("scene_vm/scene_vm_banks.rs");

pub(crate) struct VmResult {
    pub(crate) steps: Vec<SceneStep>,
    pub(crate) diagnostics: Vec<RuntimeDiagnostic>,
    pub(crate) trace: Vec<RuntimeTraceEvent>,
    pub(crate) branches: usize,
    pub(crate) instructions: usize,
    pub(crate) work_process_attached: bool,
}
