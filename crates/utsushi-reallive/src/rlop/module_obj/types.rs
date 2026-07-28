use thiserror::Error;

use crate::graphics_objects::{GraphicsLayer, GraphicsObject, GraphicsObjectStack};

/// `module_type` byte for the `module_obj_management` submodule.
pub const OBJ_MGMT_MODULE_TYPE: u8 = 1;
/// `module_id` byte for the `module_obj_management` submodule. Per
/// RLDEV's catalogue.
pub const OBJ_MGMT_MODULE_ID: u8 = 60;

/// `module_type` byte for the per-object `module_obj_fg` setters.
pub const OBJ_FG_MODULE_TYPE: u8 = 1;
/// `module_id` byte for the per-object `module_obj_fg` setters.
pub const OBJ_FG_MODULE_ID: u8 = 81;

/// `module_type` byte for the per-object `module_obj_bg` setters.
pub const OBJ_BG_MODULE_TYPE: u8 = 1;
/// `module_id` byte for the per-object `module_obj_bg` setters.
pub const OBJ_BG_MODULE_ID: u8 = 82;

/// `objButtonOpts` opcode (button-object setup). REAL RealLive value
/// `1064` (rlvm `AddOpcode(1064, 2, "objButtonOpts")` →
/// `GraphicsObject::SetButtonOpts`). Oracle and synthetic tests establish the
/// exact five-int binding shape; strict-cipher real-byte validation remains
/// pending. `(1, {81, 82}, 1064)` attaches the exact five-int
/// `(buf, action, se, group, button_number)` state to its addressed object.
/// Registered on both the fg (`81`) and bg (`82`) object planes.
pub const OPCODE_OBJ_BUTTON_OPTS: u16 = 1064;

/// Default ticks-per-millisecond rate the `module_grp::fade` longop
/// uses to compute its `total_ticks`. One tick per ms keeps the
/// substrate-honest "no wall-clock" posture intact — the substrate
/// clock advances in ticks, not in absolute time, so the longop
/// schedules `duration_ms` ticks of progress.
pub const DEFAULT_FADE_TICKS_PER_MS: u64 = 1;

/// Magic byte that prefixes every [`FadeLongOp`] private-state payload.
pub const FADE_PRIVATE_STATE_MAGIC: u8 = 0xA3;

/// Fail-soft warning surface for the graphics RLOperation family. The
/// `opcode_tag` is populated by [`Self::with_opcode`] at the dispatch
/// boundary — every `dispatch` impl uses the with-opcode helper so the
/// warning carries the opcode name without each call-site re-typing it.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GraphicsRuntimeWarning {
    /// An opcode received fewer args than its declared arity.
    #[error("utsushi.reallive.graphics.missing_arg: op={opcode_tag} slot={slot}")]
    MissingArg {
        opcode_tag: &'static str,
        slot: &'static str,
    },
    /// An opcode received an arg with the wrong [`ExprValue`] variant.
    #[error("utsushi.reallive.graphics.arg_shape: op={opcode_tag} expected={expected}")]
    ArgShapeMismatch {
        opcode_tag: &'static str,
        expected: &'static str,
    },
    /// A slot index was outside `0..256`.
    #[error("utsushi.reallive.graphics.slot_out_of_range: slot={slot}")]
    SlotOutOfRange { slot: i32 },
    /// An asset name decoded from Shift-JIS but produced an empty
    /// string. The graphics layer rejects empty asset keys typed —
    /// they would silently map to a wipe slot.
    #[error("utsushi.reallive.graphics.empty_asset_name")]
    EmptyAssetName,
    /// An asset name byte string did not decode from Shift-JIS.
    #[error("utsushi.reallive.graphics.invalid_shift_jis: op={opcode_tag}")]
    InvalidShiftJis { opcode_tag: &'static str },
    /// `objCopy` / `stretchBlit` / `grp.copy` sourced from an empty
    /// slot. Surfaces typed so the audit trail names the cause rather
    /// than silently producing a "free" dst slot.
    #[error("utsushi.reallive.graphics.copy_from_empty: slot={slot}")]
    CopyFromEmptySlot { slot: usize },
    /// A per-object setter targeted a slot with no allocated object.
    #[error("utsushi.reallive.graphics.operate_on_empty: slot={slot}")]
    OperateOnEmptySlot { slot: usize },
    /// `grp.fade` received a negative duration. The longop schedule
    /// would underflow; refused typed.
    #[error("utsushi.reallive.graphics.negative_fade_duration: duration_ms={duration_ms}")]
    NegativeFadeDuration { duration_ms: i32 },
    /// VFS resolve / open returned an error. The asset key is the
    /// logical path the runtime built; the inner reason is the
    /// substrate's [`VfsError`] rendered through `Display` so the
    /// audit surface is one string (no PII paths inside the substrate
    /// error per its contract).
    #[error(
        "utsushi.reallive.graphics.vfs_failure: op={opcode_tag} asset={asset_key} reason={reason}"
    )]
    VfsFailure {
        opcode_tag: &'static str,
        asset_key: String,
        reason: String,
    },
    /// The g00 decoder returned an error for a VFS-opened asset.
    #[error(
        "utsushi.reallive.graphics.g00_decode_failure: op={opcode_tag} asset={asset_key} reason={reason}"
    )]
    G00DecodeFailure {
        opcode_tag: &'static str,
        asset_key: String,
        reason: String,
    },
    /// The g00 decoder returned a non-fatal [`crate::g00::G00Warning`]
    /// (e.g. a payload-length mismatch) while the dims-probe was reading
    /// a VFS-opened asset. Distinct from [`Self::G00DecodeFailure`]
    /// (which is a typed decode error). The dims probe surfaces this
    /// warning so the audit trail pins the LZSS-variant / length drift
    /// rather than silently rounding to the canvas size.
    #[error(
        "utsushi.reallive.graphics.g00_payload_warning: op={opcode_tag} asset={asset_key} reason={reason}"
    )]
    G00PayloadWarning {
        opcode_tag: &'static str,
        asset_key: String,
        reason: String,
    },
}

impl GraphicsRuntimeWarning {
    /// Stamp the `opcode_tag` field if the variant carries one. Used by
    /// the helper functions in [`crate::rlop::module_grp`] so each
    /// dispatch can build its warning once and then tag it at the
    /// boundary.
    pub fn with_opcode(mut self, opcode_tag: &'static str) -> Self {
        match &mut self {
            Self::MissingArg {
                opcode_tag: tag, ..
            }
            | Self::ArgShapeMismatch {
                opcode_tag: tag, ..
            }
            | Self::InvalidShiftJis { opcode_tag: tag }
            | Self::VfsFailure {
                opcode_tag: tag, ..
            }
            | Self::G00DecodeFailure {
                opcode_tag: tag, ..
            }
            | Self::G00PayloadWarning {
                opcode_tag: tag, ..
            } => *tag = opcode_tag,
            // Variants that don't carry an opcode tag are unchanged.
            Self::SlotOutOfRange { .. }
            | Self::EmptyAssetName
            | Self::CopyFromEmptySlot { .. }
            | Self::OperateOnEmptySlot { .. }
            | Self::NegativeFadeDuration { .. } => {}
        }
        self
    }
}

/// Recorded DC-allocation observation. Pinned on the state-snapshot so
/// the audit trail names the requested canvas size even though the
/// foreground slot is a transparent wipe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DcAllocation {
    pub slot: usize,
    pub width: u32,
    pub height: u32,
}

/// Recorded background-plane canvas. Pinned on the snapshot so the
/// `openBg` audit surface names the asset key + decoded canvas size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BgCanvas {
    pub asset_key: String,
    /// `Some((width, height))` once the asset bytes have been resolved
    /// through the substrate VFS and decoded by [`decode_g00`]. `None`
    /// when no asset package was set (so the audit surface pins the
    /// gap).
    pub dimensions: Option<(u32, u32)>,
}

/// Recorded fade schedule. Pinned on the snapshot so audit tooling can
/// verify a `grp.fade` actually scheduled a longop without scraping the
/// VM queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FadeSchedule {
    pub starting_alpha: u8,
    pub target_alpha: u8,
    pub total_ticks: u64,
}

/// Observable state-snapshot returned by
/// [`GraphicsRuntime::state_snapshot`]. Carries the full
/// [`GraphicsObjectStack`] alongside the side-table state mutated by
/// the `grp` family (DC allocations, shake amplitude, bg canvas, fade
/// schedule).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphicsStateSnapshot {
    pub stack: GraphicsObjectStack,
    pub dc_allocations: Vec<DcAllocation>,
    pub shake_amplitude_px: u32,
    pub bg_canvas: Option<BgCanvas>,
    pub fade_scheduled: Option<FadeSchedule>,
}

impl GraphicsStateSnapshot {
    /// Number of allocated `(plane, slot)` entries across both planes.
    pub fn allocated_slot_count(&self) -> usize {
        self.stack.len()
    }

    pub fn foreground_slot(&self, slot: usize) -> Option<&GraphicsObject> {
        self.stack.get_layer(GraphicsLayer::ForegroundObject, slot)
    }

    pub fn background_slot(&self, slot: usize) -> Option<&GraphicsObject> {
        self.stack.get_layer(GraphicsLayer::DisplayCommand, slot)
    }

    pub fn display_command_slot(&self, slot: usize) -> Option<&GraphicsObject> {
        self.stack.get_layer(GraphicsLayer::DisplayCommand, slot)
    }

    pub fn background_object_slot(&self, slot: usize) -> Option<&GraphicsObject> {
        self.stack.get_layer(GraphicsLayer::BackgroundObject, slot)
    }

    pub fn foreground_object_slot(&self, slot: usize) -> Option<&GraphicsObject> {
        self.stack.get_layer(GraphicsLayer::ForegroundObject, slot)
    }

    pub fn dc_allocation(&self, slot: usize) -> Option<DcAllocation> {
        self.dc_allocations
            .iter()
            .find(|dc| dc.slot == slot)
            .copied()
    }
}
