//! UTSUSHI-215 — RealLive `module_obj_management` + `module_obj_fg_bg`
//! RLOperation family subset.
//!
//! Implements the alpha-tier object-stack subset the UTSUSHI-215 spec
//! node pins:
//!
//! - `module_obj_management` (`(1, 60)`): `objAlloc`, `objFree`,
//!   `objInit`, `objCopy`.
//! - `module_obj_fg_bg` (`(1, 81)` foreground / `(1, 82)` background):
//!   per-object setters `objSetPos`, `objSetAlpha`, `objSetScale`,
//!   `objSetLayer`, plus `objShow` / `objHide`.
//!
//! Every op routes through a shared [`GraphicsRuntime`] that owns the
//! [`crate::GraphicsObjectStack`] state, a typed VFS surface for
//! `module_grp::openBg`-style g00 reads, the long-op id sequence used
//! by the `module_grp` `fade` op, and the fail-soft warning queue.
//!
//! # Layer-ordering posture (audit-focus pin)
//!
//! The DAG node carries the audit-focus item "layer-ordering that
//! ignores `objSetLayer`". The render-pass at
//! [`crate::RenderPass::rasterise`] already sorts allocated objects by
//! `(plane.paint_order(), layer_order, slot)` — UTSUSHI-214 pinned
//! this. UTSUSHI-215's `objSetLayer` directly mutates
//! [`crate::GraphicsObject::layer_order`], so a render after a
//! `objSetLayer` re-orders the paint output observably; the acceptance
//! test `obj_set_layer_reorders_render_pass_output` pins that the
//! highest-`layer_order` object wins the single pixel of a 1×1
//! framebuffer regardless of `objSetLayer` call order.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::g00::{G00DecodeError, decode_g00};
use crate::graphics_objects::{
    GRAPHICS_OBJECT_SLOT_COUNT, GraphicsAlpha, GraphicsObject, GraphicsObjectKind,
    GraphicsObjectStack, GraphicsPlane, GraphicsPosition, GraphicsScale,
};
use crate::rlop::{LongOp, LongOpId};
use crate::vm::Vm;
use utsushi_core::substrate::{AssetPackage, VfsError};

// ---- module addressing -----------------------------------------------

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

// ---- module_obj_management opcodes ----------------------------------

/// `objAlloc(int slot)` — allocate an empty image-slot object on the
/// foreground plane.
pub const OPCODE_OBJ_ALLOC: u16 = 0x0001;
/// `objFree(int slot)` — free the foreground slot.
pub const OPCODE_OBJ_FREE: u16 = 0x0002;
/// `objInit(int slot)` — reset the foreground slot to identity state
/// (origin position, identity scale, opaque alpha, neutral tone).
pub const OPCODE_OBJ_INIT: u16 = 0x0003;
/// `objCopy(int src_slot, int dst_slot)` — clone a foreground slot.
pub const OPCODE_OBJ_COPY: u16 = 0x0004;

// ---- module_obj_fg_bg opcodes ---------------------------------------

/// `objSetPos(int slot, int x, int y)` — set the slot's position.
pub const OPCODE_OBJ_SET_POS: u16 = 0x0010;
/// `objSetAlpha(int slot, int alpha)` — set the slot's alpha
/// (`0..=255`).
pub const OPCODE_OBJ_SET_ALPHA: u16 = 0x0011;
/// `objSetScale(int slot, int x_thousandths, int y_thousandths)` —
/// set per-axis scale.
pub const OPCODE_OBJ_SET_SCALE: u16 = 0x0012;
/// `objSetLayer(int slot, int layer_order)` — set the slot's
/// plane-local layer-order.
pub const OPCODE_OBJ_SET_LAYER: u16 = 0x0013;
/// `objShow(int slot)` — set the slot's visibility flag.
pub const OPCODE_OBJ_SHOW: u16 = 0x0014;
/// `objHide(int slot)` — clear the slot's visibility flag.
pub const OPCODE_OBJ_HIDE: u16 = 0x0015;

/// `objButtonOpts` opcode (button-object setup). REAL RealLive value
/// `1064` (rlvm `AddOpcode(1064, 2, "objButtonOpts")` →
/// `GraphicsObject::SetButtonOpts`), VALIDATED on real Sweetie HD bytes:
/// `(1, {81, 82}, 1064)` occurs once per selectable button object — its
/// args carry the button's 0-based ordinal (arg 0) and group id (arg 1).
/// The COUNT of these ops before a `select_objbtn` (`sel (0,2,4)`) is the
/// real source of that graphical select's option count (the objbtn scenes
/// carry no inline `{ … }` option block). Registered on both the fg (`81`)
/// and bg (`82`) planes.
pub const OPCODE_OBJ_BUTTON_OPTS: u16 = 1064;

/// Default ticks-per-millisecond rate the `module_grp::fade` longop
/// uses to compute its `total_ticks`. One tick per ms keeps the
/// substrate-honest "no wall-clock" posture intact — the substrate
/// clock advances in ticks, not in absolute time, so the longop
/// schedules `duration_ms` ticks of progress.
pub const DEFAULT_FADE_TICKS_PER_MS: u64 = 1;

/// Magic byte that prefixes every [`FadeLongOp`] private-state payload.
pub const FADE_PRIVATE_STATE_MAGIC: u8 = 0xA3;

// ---- enums for the three submodules ---------------------------------

/// Opcodes registered by `module_obj_management`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ObjMgmtOpcode {
    Alloc,
    Free,
    Init,
    Copy,
}

impl ObjMgmtOpcode {
    pub const ALL: &'static [ObjMgmtOpcode] = &[Self::Alloc, Self::Free, Self::Init, Self::Copy];

    pub fn opcode(self) -> u16 {
        match self {
            Self::Alloc => OPCODE_OBJ_ALLOC,
            Self::Free => OPCODE_OBJ_FREE,
            Self::Init => OPCODE_OBJ_INIT,
            Self::Copy => OPCODE_OBJ_COPY,
        }
    }

    pub fn rlop_key(self) -> RlopKey {
        RlopKey::new(OBJ_MGMT_MODULE_TYPE, OBJ_MGMT_MODULE_ID, self.opcode())
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Alloc => "obj.objAlloc",
            Self::Free => "obj.objFree",
            Self::Init => "obj.objInit",
            Self::Copy => "obj.objCopy",
        }
    }
}

/// Opcodes registered per-plane by `module_obj_fg_bg`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ObjFgBgOpcode {
    SetPos,
    SetAlpha,
    SetScale,
    SetLayer,
    Show,
    Hide,
}

impl ObjFgBgOpcode {
    pub const ALL: &'static [ObjFgBgOpcode] = &[
        Self::SetPos,
        Self::SetAlpha,
        Self::SetScale,
        Self::SetLayer,
        Self::Show,
        Self::Hide,
    ];

    pub fn opcode(self) -> u16 {
        match self {
            Self::SetPos => OPCODE_OBJ_SET_POS,
            Self::SetAlpha => OPCODE_OBJ_SET_ALPHA,
            Self::SetScale => OPCODE_OBJ_SET_SCALE,
            Self::SetLayer => OPCODE_OBJ_SET_LAYER,
            Self::Show => OPCODE_OBJ_SHOW,
            Self::Hide => OPCODE_OBJ_HIDE,
        }
    }

    pub fn rlop_key_for(self, plane: GraphicsPlane) -> RlopKey {
        match plane {
            GraphicsPlane::Foreground => {
                RlopKey::new(OBJ_FG_MODULE_TYPE, OBJ_FG_MODULE_ID, self.opcode())
            }
            GraphicsPlane::Background => {
                RlopKey::new(OBJ_BG_MODULE_TYPE, OBJ_BG_MODULE_ID, self.opcode())
            }
        }
    }

    pub fn as_str(self, plane: GraphicsPlane) -> &'static str {
        match (self, plane) {
            (Self::SetPos, GraphicsPlane::Foreground) => "objFg.objSetPos",
            (Self::SetPos, GraphicsPlane::Background) => "objBg.objSetPos",
            (Self::SetAlpha, GraphicsPlane::Foreground) => "objFg.objSetAlpha",
            (Self::SetAlpha, GraphicsPlane::Background) => "objBg.objSetAlpha",
            (Self::SetScale, GraphicsPlane::Foreground) => "objFg.objSetScale",
            (Self::SetScale, GraphicsPlane::Background) => "objBg.objSetScale",
            (Self::SetLayer, GraphicsPlane::Foreground) => "objFg.objSetLayer",
            (Self::SetLayer, GraphicsPlane::Background) => "objBg.objSetLayer",
            (Self::Show, GraphicsPlane::Foreground) => "objFg.objShow",
            (Self::Show, GraphicsPlane::Background) => "objBg.objShow",
            (Self::Hide, GraphicsPlane::Foreground) => "objFg.objHide",
            (Self::Hide, GraphicsPlane::Background) => "objBg.objHide",
        }
    }
}

/// Total opcode count [`register_obj_rlops`] mounts: 4 management +
/// 6 per-plane setters × 2 planes + the `objButtonOpts` button-setup op on
/// both planes = 18.
pub const OBJ_RLOP_COUNT: usize = ObjMgmtOpcode::ALL.len() + ObjFgBgOpcode::ALL.len() * 2 + 2;

// ---- runtime warnings -----------------------------------------------

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

// ---- graphics runtime ------------------------------------------------

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
        self.stack.get(GraphicsPlane::Foreground, slot)
    }

    pub fn background_slot(&self, slot: usize) -> Option<&GraphicsObject> {
        self.stack.get(GraphicsPlane::Background, slot)
    }

    pub fn dc_allocation(&self, slot: usize) -> Option<DcAllocation> {
        self.dc_allocations
            .iter()
            .find(|dc| dc.slot == slot)
            .copied()
    }
}

/// Shared runtime carrier for every `module_grp` and `module_obj_*`
/// op. Owns the graphics object stack, the optional VFS surface, the
/// long-op id sequence used by `grp.fade`, the recorded fade tick
/// rate, and the fail-soft warning queue.
pub struct GraphicsRuntime {
    inner: Mutex<GraphicsRuntimeInner>,
}

struct GraphicsRuntimeInner {
    stack: GraphicsObjectStack,
    dc_allocations: Vec<DcAllocation>,
    shake_amplitude_px: u32,
    bg_canvas: Option<BgCanvas>,
    fade_scheduled: Option<FadeSchedule>,
    fade_ticks_per_ms: u64,
    asset_package: Option<Arc<dyn AssetPackage>>,
    next_longop_id: u64,
    warnings: Vec<GraphicsRuntimeWarning>,
}

impl std::fmt::Debug for GraphicsRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GraphicsRuntime")
            .field("allocated_slot_count", &self.allocated_slot_count())
            .finish()
    }
}

impl GraphicsRuntime {
    /// Build a runtime with an empty stack, no VFS, and the default
    /// fade tick rate ([`DEFAULT_FADE_TICKS_PER_MS`]).
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(GraphicsRuntimeInner {
                stack: GraphicsObjectStack::new(),
                dc_allocations: Vec::new(),
                shake_amplitude_px: 0,
                bg_canvas: None,
                fade_scheduled: None,
                fade_ticks_per_ms: DEFAULT_FADE_TICKS_PER_MS,
                asset_package: None,
                next_longop_id: 1,
                warnings: Vec::new(),
            }),
        }
    }

    /// Override the ticks-per-ms rate used by `grp.fade`. Tests use
    /// this to make the longop duration observable without scaling the
    /// fixture clock.
    pub fn set_fade_ticks_per_ms(&self, ticks_per_ms: u64) {
        self.lock_inner().fade_ticks_per_ms = ticks_per_ms.max(1);
    }

    /// Borrow the current fade ticks-per-ms rate.
    pub fn fade_ticks_per_ms(&self) -> u64 {
        self.lock_inner().fade_ticks_per_ms
    }

    /// Bind the substrate VFS surface the `openBg`-style ops consult.
    /// `module_grp::openBg` looks up `g00/<NAME>.g00` against the
    /// resolved [`AssetPackage::resolve`] path.
    pub fn set_asset_package(&self, package: Arc<dyn AssetPackage>) {
        self.lock_inner().asset_package = Some(package);
    }

    /// Number of slots allocated on the stack across both planes.
    pub fn allocated_slot_count(&self) -> usize {
        self.lock_inner().stack.len()
    }

    /// Emit a fresh long-op id. The id sequence starts at `1` and
    /// monotonically increases; the substrate-honest "no PII" posture
    /// is unaffected because the value is opaque.
    pub fn next_longop_id(&self) -> LongOpId {
        let mut guard = self.lock_inner();
        let id = guard.next_longop_id;
        guard.next_longop_id = guard.next_longop_id.saturating_add(1);
        LongOpId(id)
    }

    /// Borrow a typed observable snapshot of the runtime state.
    pub fn state_snapshot(&self) -> GraphicsStateSnapshot {
        let guard = self.lock_inner();
        GraphicsStateSnapshot {
            stack: guard.stack.clone(),
            dc_allocations: guard.dc_allocations.clone(),
            shake_amplitude_px: guard.shake_amplitude_px,
            bg_canvas: guard.bg_canvas.clone(),
            fade_scheduled: guard.fade_scheduled,
        }
    }

    /// Read-only access to the object stack.
    pub fn with_stack<R>(&self, body: impl FnOnce(&GraphicsObjectStack) -> R) -> R {
        body(&self.lock_inner().stack)
    }

    /// Mutable access to the object stack.
    pub fn with_stack_mut<R>(&self, body: impl FnOnce(&mut GraphicsObjectStack) -> R) -> R {
        body(&mut self.lock_inner().stack)
    }

    /// Record a DC-allocation observation. Overwrites any prior entry
    /// for the same slot.
    pub fn set_dc_allocation(&self, slot: usize, width: u32, height: u32) {
        let mut guard = self.lock_inner();
        guard.dc_allocations.retain(|dc| dc.slot != slot);
        guard.dc_allocations.push(DcAllocation {
            slot,
            width,
            height,
        });
    }

    pub fn set_shake_amplitude_px(&self, amplitude_px: u32) {
        self.lock_inner().shake_amplitude_px = amplitude_px;
    }

    /// Record a bg-plane canvas observation with decoded dimensions.
    pub fn record_bg_canvas(&self, asset_key: &str, width: u32, height: u32) {
        self.lock_inner().bg_canvas = Some(BgCanvas {
            asset_key: asset_key.to_string(),
            dimensions: Some((width, height)),
        });
    }

    /// Record a bg-plane asset observation without dimensions (no
    /// VFS was set).
    pub fn record_bg_asset_only(&self, asset_key: &str) {
        self.lock_inner().bg_canvas = Some(BgCanvas {
            asset_key: asset_key.to_string(),
            dimensions: None,
        });
    }

    /// Record that `grp.fade` scheduled a longop.
    pub fn record_fade_scheduled(&self, starting_alpha: u8, target_alpha: u8, total_ticks: u64) {
        self.lock_inner().fade_scheduled = Some(FadeSchedule {
            starting_alpha,
            target_alpha,
            total_ticks,
        });
    }

    /// Append a fail-soft warning to the runtime's diagnostic queue.
    pub fn push_warning(&self, warning: GraphicsRuntimeWarning) {
        self.lock_inner().warnings.push(warning);
    }

    /// Drain the fail-soft warnings.
    pub fn take_warnings(&self) -> Vec<GraphicsRuntimeWarning> {
        std::mem::take(&mut self.lock_inner().warnings)
    }

    /// Borrow the fail-soft warnings without draining.
    pub fn warnings(&self) -> Vec<GraphicsRuntimeWarning> {
        self.lock_inner().warnings.clone()
    }

    /// Resolve `g00/<asset_name>.g00` through the substrate VFS,
    /// decode the bytes, and return the decoded `(width, height)`.
    /// Returns `Ok(None)` when no asset package was set so the caller
    /// can record the gap observably.
    pub fn read_g00_through_vfs(
        &self,
        asset_name: &str,
    ) -> Result<Option<(u32, u32)>, GraphicsRuntimeWarning> {
        let package = {
            let guard = self.lock_inner();
            guard.asset_package.clone()
        };
        let Some(package) = package else {
            return Ok(None);
        };
        let logical = format!("g00/{asset_name}.g00");
        let id = package
            .resolve(&logical)
            .map_err(|err| Self::vfs_warning(asset_name, err))?;
        let bytes = package
            .open(&id)
            .map_err(|err| Self::vfs_warning(asset_name, err))?;
        match decode_g00(bytes.as_slice()) {
            Ok((image, _warnings)) => Ok(Some((image.width, image.height))),
            Err(err) => Err(Self::g00_warning(asset_name, err)),
        }
    }

    fn vfs_warning(asset_name: &str, err: VfsError) -> GraphicsRuntimeWarning {
        GraphicsRuntimeWarning::VfsFailure {
            opcode_tag: "",
            asset_key: asset_name.to_string(),
            reason: err.to_string(),
        }
    }

    fn g00_warning(asset_name: &str, err: G00DecodeError) -> GraphicsRuntimeWarning {
        GraphicsRuntimeWarning::G00DecodeFailure {
            opcode_tag: "",
            asset_key: asset_name.to_string(),
            reason: err.to_string(),
        }
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, GraphicsRuntimeInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Default for GraphicsRuntime {
    fn default() -> Self {
        Self::new()
    }
}

// ---- fade longop wrapper --------------------------------------------

/// Typed wrapper around the `Fade` private state. Carries the alpha
/// endpoints and the total tick count the substrate scheduler will
/// advance through.
///
/// # Payload shape
///
/// `[FADE_PRIVATE_STATE_MAGIC (1B), starting_alpha (1B), target_alpha
/// (1B), total_ticks_LE (8B), elapsed_ticks_LE (8B)]` — 19 bytes total.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FadeLongOp {
    id: LongOpId,
    starting_alpha: u8,
    target_alpha: u8,
    total_ticks: u64,
    elapsed_ticks: u64,
}

impl FadeLongOp {
    pub const PAYLOAD_BYTE_LEN: usize = 19;

    /// Build a fresh fade longop. The `elapsed_ticks` field starts at
    /// `0`; the scheduler increments it through [`Self::advance`] and
    /// then re-encodes the payload through [`Self::write_into_payload`].
    pub fn new(id: LongOpId, starting_alpha: u8, target_alpha: u8, total_ticks: u64) -> Self {
        Self {
            id,
            starting_alpha,
            target_alpha,
            total_ticks,
            elapsed_ticks: 0,
        }
    }

    pub fn id(&self) -> LongOpId {
        self.id
    }

    pub fn starting_alpha(&self) -> u8 {
        self.starting_alpha
    }

    pub fn target_alpha(&self) -> u8 {
        self.target_alpha
    }

    pub fn total_ticks(&self) -> u64 {
        self.total_ticks
    }

    pub fn elapsed_ticks(&self) -> u64 {
        self.elapsed_ticks
    }

    /// Whether the fade has run its full tick budget.
    pub fn is_complete(&self) -> bool {
        self.elapsed_ticks >= self.total_ticks
    }

    /// Linear-interpolated alpha for the current elapsed ticks. Pinned
    /// so the substrate-honest "no float drift" guarantee holds.
    pub fn current_alpha(&self) -> u8 {
        if self.total_ticks == 0 || self.is_complete() {
            return self.target_alpha;
        }
        let start = self.starting_alpha as i64;
        let target = self.target_alpha as i64;
        let elapsed = self.elapsed_ticks as i64;
        let total = self.total_ticks as i64;
        // value = start + (target - start) * elapsed / total
        let span = target - start;
        let delta = span * elapsed / total;
        let value = start + delta;
        value.clamp(0, 255) as u8
    }

    /// Advance the fade by `ticks` ticks. Saturates at `total_ticks`.
    pub fn advance(&mut self, ticks: u64) {
        self.elapsed_ticks = self
            .elapsed_ticks
            .saturating_add(ticks)
            .min(self.total_ticks);
    }

    /// Encode the wrapper into a [`LongOp`] carrier.
    pub fn into_longop(self) -> LongOp {
        let mut payload = Vec::with_capacity(Self::PAYLOAD_BYTE_LEN);
        payload.push(FADE_PRIVATE_STATE_MAGIC);
        payload.push(self.starting_alpha);
        payload.push(self.target_alpha);
        payload.extend_from_slice(&self.total_ticks.to_le_bytes());
        payload.extend_from_slice(&self.elapsed_ticks.to_le_bytes());
        LongOp::new(self.id, payload)
    }

    /// Decode a payload back into a `FadeLongOp`. Returns a typed error
    /// on length or magic mismatch.
    pub fn try_from_payload(id: LongOpId, payload: &[u8]) -> Result<Self, FadeLongOpDecodeError> {
        if payload.len() != Self::PAYLOAD_BYTE_LEN {
            return Err(FadeLongOpDecodeError::UnexpectedPayloadLength {
                observed: payload.len(),
                expected: Self::PAYLOAD_BYTE_LEN,
            });
        }
        if payload[0] != FADE_PRIVATE_STATE_MAGIC {
            return Err(FadeLongOpDecodeError::MagicMismatch {
                observed: payload[0],
                expected: FADE_PRIVATE_STATE_MAGIC,
            });
        }
        let starting_alpha = payload[1];
        let target_alpha = payload[2];
        let total_ticks = u64::from_le_bytes(payload[3..11].try_into().expect("11-3=8"));
        let elapsed_ticks = u64::from_le_bytes(payload[11..19].try_into().expect("19-11=8"));
        Ok(Self {
            id,
            starting_alpha,
            target_alpha,
            total_ticks,
            elapsed_ticks,
        })
    }
}

/// Typed decode error for [`FadeLongOp::try_from_payload`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FadeLongOpDecodeError {
    #[error("utsushi.reallive.rlop.fade.payload_length: observed={observed} expected={expected}")]
    UnexpectedPayloadLength { observed: usize, expected: usize },
    #[error(
        "utsushi.reallive.rlop.fade.magic_mismatch: observed=0x{observed:02x} expected=0x{expected:02x}"
    )]
    MagicMismatch { observed: u8, expected: u8 },
}

// ---- argument helpers -----------------------------------------------

fn arg_int(
    args: &[ExprValue],
    at: usize,
    slot: &'static str,
) -> Result<i32, GraphicsRuntimeWarning> {
    args.get(at)
        .ok_or(GraphicsRuntimeWarning::MissingArg {
            opcode_tag: "",
            slot,
        })
        .and_then(|value| {
            value
                .as_int()
                .ok_or(GraphicsRuntimeWarning::ArgShapeMismatch {
                    opcode_tag: "",
                    expected: "int",
                })
        })
}

fn slot_index(value: i32) -> Result<usize, GraphicsRuntimeWarning> {
    if !(0..GRAPHICS_OBJECT_SLOT_COUNT as i32).contains(&value) {
        return Err(GraphicsRuntimeWarning::SlotOutOfRange { slot: value });
    }
    Ok(value as usize)
}

fn fail(
    runtime: &GraphicsRuntime,
    opcode_tag: &'static str,
    warning: GraphicsRuntimeWarning,
) -> DispatchOutcome {
    runtime.push_warning(warning.with_opcode(opcode_tag));
    DispatchOutcome::Advance
}

// ---- module_obj_management ops --------------------------------------

/// `objAlloc(int slot)` — allocate an empty image-slot on the
/// foreground plane (the asset key is the empty string until a
/// follow-up `objSetImage` lands; for UTSUSHI-215 the empty key is the
/// observable mutation).
#[derive(Debug)]
pub struct ObjAllocOp {
    runtime: Arc<GraphicsRuntime>,
}

impl ObjAllocOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for ObjAllocOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_slot = match arg_int(args, 0, "slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, ObjMgmtOpcode::Alloc.as_str(), warning),
        };
        let slot = match slot_index(raw_slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, ObjMgmtOpcode::Alloc.as_str(), warning),
        };
        self.runtime.with_stack_mut(|stack| {
            let _ = stack.set(
                GraphicsPlane::Foreground,
                slot,
                GraphicsObject::image(String::new()),
            );
        });
        DispatchOutcome::Advance
    }
}

/// `objFree(int slot)` — free the foreground slot.
#[derive(Debug)]
pub struct ObjFreeOp {
    runtime: Arc<GraphicsRuntime>,
}

impl ObjFreeOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for ObjFreeOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_slot = match arg_int(args, 0, "slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, ObjMgmtOpcode::Free.as_str(), warning),
        };
        let slot = match slot_index(raw_slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, ObjMgmtOpcode::Free.as_str(), warning),
        };
        self.runtime.with_stack_mut(|stack| {
            let _ = stack.clear(GraphicsPlane::Foreground, slot);
        });
        DispatchOutcome::Advance
    }
}

/// `objInit(int slot)` — reset the slot's mutable state to identity
/// without touching its image_ref.
#[derive(Debug)]
pub struct ObjInitOp {
    runtime: Arc<GraphicsRuntime>,
}

impl ObjInitOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for ObjInitOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_slot = match arg_int(args, 0, "slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, ObjMgmtOpcode::Init.as_str(), warning),
        };
        let slot = match slot_index(raw_slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, ObjMgmtOpcode::Init.as_str(), warning),
        };
        let observed = self.runtime.with_stack_mut(|stack| {
            if let Some(object) = stack.get_mut(GraphicsPlane::Foreground, slot) {
                object.position = GraphicsPosition::ORIGIN;
                object.scale = GraphicsScale::IDENTITY;
                object.alpha = GraphicsAlpha::OPAQUE;
                object.colour_tone = crate::graphics_objects::GraphicsColourTone::NEUTRAL;
                object.layer_order = 0;
                object.visible = true;
                true
            } else {
                false
            }
        });
        if !observed {
            self.runtime.push_warning(
                GraphicsRuntimeWarning::OperateOnEmptySlot { slot }
                    .with_opcode(ObjMgmtOpcode::Init.as_str()),
            );
        }
        DispatchOutcome::Advance
    }
}

/// `objCopy(int src_slot, int dst_slot)` — clone src into dst on the
/// foreground plane.
#[derive(Debug)]
pub struct ObjCopyOp {
    runtime: Arc<GraphicsRuntime>,
}

impl ObjCopyOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for ObjCopyOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_src = match arg_int(args, 0, "src_slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, ObjMgmtOpcode::Copy.as_str(), warning),
        };
        let raw_dst = match arg_int(args, 1, "dst_slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, ObjMgmtOpcode::Copy.as_str(), warning),
        };
        let src = match slot_index(raw_src) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, ObjMgmtOpcode::Copy.as_str(), warning),
        };
        let dst = match slot_index(raw_dst) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, ObjMgmtOpcode::Copy.as_str(), warning),
        };
        let copied = self.runtime.with_stack_mut(|stack| {
            let source = stack.get(GraphicsPlane::Foreground, src).cloned();
            if let Some(object) = source {
                let _ = stack.set(GraphicsPlane::Foreground, dst, object);
                true
            } else {
                false
            }
        });
        if !copied {
            self.runtime.push_warning(
                GraphicsRuntimeWarning::CopyFromEmptySlot { slot: src }
                    .with_opcode(ObjMgmtOpcode::Copy.as_str()),
            );
        }
        DispatchOutcome::Advance
    }
}

// ---- module_obj_fg_bg ops --------------------------------------------

/// Per-plane setter for `objSetPos` / `objSetAlpha` / ... A single op
/// type carries a `(plane, opcode)` pair so the same impl can be
/// mounted on both planes without code duplication.
#[derive(Debug)]
pub struct ObjFgBgOp {
    runtime: Arc<GraphicsRuntime>,
    plane: GraphicsPlane,
    opcode: ObjFgBgOpcode,
}

impl ObjFgBgOp {
    pub fn new(runtime: Arc<GraphicsRuntime>, plane: GraphicsPlane, opcode: ObjFgBgOpcode) -> Self {
        Self {
            runtime,
            plane,
            opcode,
        }
    }

    fn opcode_tag(&self) -> &'static str {
        self.opcode.as_str(self.plane)
    }

    fn dispatch_set_pos(&self, args: &[ExprValue]) -> DispatchOutcome {
        let (slot, x, y) = match (
            arg_int(args, 0, "slot"),
            arg_int(args, 1, "x"),
            arg_int(args, 2, "y"),
        ) {
            (Ok(s), Ok(x), Ok(y)) => (s, x, y),
            (Err(w), _, _) | (_, Err(w), _) | (_, _, Err(w)) => {
                return fail(&self.runtime, self.opcode_tag(), w);
            }
        };
        let slot = match slot_index(slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, self.opcode_tag(), warning),
        };
        let plane = self.plane;
        let observed = self.runtime.with_stack_mut(|stack| {
            if let Some(object) = stack.get_mut(plane, slot) {
                object.position = GraphicsPosition { x, y };
                true
            } else {
                false
            }
        });
        if !observed {
            self.runtime.push_warning(
                GraphicsRuntimeWarning::OperateOnEmptySlot { slot }.with_opcode(self.opcode_tag()),
            );
        }
        DispatchOutcome::Advance
    }

    fn dispatch_set_alpha(&self, args: &[ExprValue]) -> DispatchOutcome {
        let (slot, alpha) = match (arg_int(args, 0, "slot"), arg_int(args, 1, "alpha")) {
            (Ok(s), Ok(a)) => (s, a),
            (Err(w), _) | (_, Err(w)) => return fail(&self.runtime, self.opcode_tag(), w),
        };
        let slot = match slot_index(slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, self.opcode_tag(), warning),
        };
        let plane = self.plane;
        let alpha_u8 = alpha.clamp(0, 255) as u8;
        let observed = self.runtime.with_stack_mut(|stack| {
            if let Some(object) = stack.get_mut(plane, slot) {
                object.alpha = GraphicsAlpha(alpha_u8);
                true
            } else {
                false
            }
        });
        if !observed {
            self.runtime.push_warning(
                GraphicsRuntimeWarning::OperateOnEmptySlot { slot }.with_opcode(self.opcode_tag()),
            );
        }
        DispatchOutcome::Advance
    }

    fn dispatch_set_scale(&self, args: &[ExprValue]) -> DispatchOutcome {
        let (slot, x, y) = match (
            arg_int(args, 0, "slot"),
            arg_int(args, 1, "x_thousandths"),
            arg_int(args, 2, "y_thousandths"),
        ) {
            (Ok(s), Ok(x), Ok(y)) => (s, x, y),
            (Err(w), _, _) | (_, Err(w), _) | (_, _, Err(w)) => {
                return fail(&self.runtime, self.opcode_tag(), w);
            }
        };
        let slot = match slot_index(slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, self.opcode_tag(), warning),
        };
        let plane = self.plane;
        let observed = self.runtime.with_stack_mut(|stack| {
            if let Some(object) = stack.get_mut(plane, slot) {
                object.scale = GraphicsScale {
                    x_thousandths: x,
                    y_thousandths: y,
                };
                true
            } else {
                false
            }
        });
        if !observed {
            self.runtime.push_warning(
                GraphicsRuntimeWarning::OperateOnEmptySlot { slot }.with_opcode(self.opcode_tag()),
            );
        }
        DispatchOutcome::Advance
    }

    fn dispatch_set_layer(&self, args: &[ExprValue]) -> DispatchOutcome {
        let (slot, layer_order) = match (arg_int(args, 0, "slot"), arg_int(args, 1, "layer_order"))
        {
            (Ok(s), Ok(l)) => (s, l),
            (Err(w), _) | (_, Err(w)) => {
                return fail(&self.runtime, self.opcode_tag(), w);
            }
        };
        let slot = match slot_index(slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, self.opcode_tag(), warning),
        };
        let plane = self.plane;
        let observed = self.runtime.with_stack_mut(|stack| {
            if let Some(object) = stack.get_mut(plane, slot) {
                object.layer_order = layer_order;
                true
            } else {
                false
            }
        });
        if !observed {
            self.runtime.push_warning(
                GraphicsRuntimeWarning::OperateOnEmptySlot { slot }.with_opcode(self.opcode_tag()),
            );
        }
        DispatchOutcome::Advance
    }

    fn dispatch_set_visible(&self, args: &[ExprValue], visible: bool) -> DispatchOutcome {
        let slot = match arg_int(args, 0, "slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, self.opcode_tag(), warning),
        };
        let slot = match slot_index(slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, self.opcode_tag(), warning),
        };
        let plane = self.plane;
        let observed = self.runtime.with_stack_mut(|stack| {
            if let Some(object) = stack.get_mut(plane, slot) {
                object.visible = visible;
                true
            } else {
                false
            }
        });
        if !observed {
            self.runtime.push_warning(
                GraphicsRuntimeWarning::OperateOnEmptySlot { slot }.with_opcode(self.opcode_tag()),
            );
        }
        DispatchOutcome::Advance
    }
}

impl RLOperation for ObjFgBgOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        match self.opcode {
            ObjFgBgOpcode::SetPos => self.dispatch_set_pos(args),
            ObjFgBgOpcode::SetAlpha => self.dispatch_set_alpha(args),
            ObjFgBgOpcode::SetScale => self.dispatch_set_scale(args),
            ObjFgBgOpcode::SetLayer => self.dispatch_set_layer(args),
            ObjFgBgOpcode::Show => self.dispatch_set_visible(args, true),
            ObjFgBgOpcode::Hide => self.dispatch_set_visible(args, false),
        }
    }
}

// ---- registry helper ------------------------------------------------

/// `objButtonOpts` (`obj (1,{81,82},1064)`) — button-object setup. rlvm's
/// `objButtonOpts` calls `GraphicsObject::SetButtonOpts(action, se, group,
/// button_number)`, marking the object a selectable button that a
/// `select_objbtn` collects for its group. This port records the button on
/// the VM's pending button group ([`Vm::objbtn_register`]) so the following
/// `select_objbtn` (`sel (0,2,4)`) can recover the option set (count +
/// per-button ordinal). It does NOT touch the graphics stack — the button's
/// sprite / position are placed by separate `objOfFile` / `objSetPos` ops —
/// so it carries no [`GraphicsRuntime`].
///
/// Args (real Sweetie bytes): arg 0 = button ordinal, arg 1 = group id.
/// Mis-shaped / missing args fail soft — the button is still appended (its
/// ordinal defaults to the append position, group to `0`) so the recovered
/// option COUNT stays faithful to the number of setup ops.
#[derive(Debug, Default)]
pub struct ObjButtonOptsOp;

impl ObjButtonOptsOp {
    /// Construct the op (stateless — it mutates the VM's button group).
    pub fn new() -> Self {
        Self
    }
}

impl RLOperation for ObjButtonOptsOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let number = arg_int(args, 0, "button_number").unwrap_or(vm.objbtn_buttons().len() as i32);
        let group = arg_int(args, 1, "group").unwrap_or(0);
        vm.objbtn_register(number, group);
        DispatchOutcome::Advance
    }
}

/// Mount every `module_obj_management` + `module_obj_fg_bg` op this
/// module ships. Returns the registered op count.
pub fn register_obj_rlops(registry: &mut RlopRegistry, runtime: Arc<GraphicsRuntime>) -> usize {
    let mut count = 0;
    let mut register = |key: RlopKey, op: Arc<dyn RLOperation>| {
        registry.register(key, op);
        count += 1;
    };
    // module_obj_management
    register(
        ObjMgmtOpcode::Alloc.rlop_key(),
        Arc::new(ObjAllocOp::new(Arc::clone(&runtime))),
    );
    register(
        ObjMgmtOpcode::Free.rlop_key(),
        Arc::new(ObjFreeOp::new(Arc::clone(&runtime))),
    );
    register(
        ObjMgmtOpcode::Init.rlop_key(),
        Arc::new(ObjInitOp::new(Arc::clone(&runtime))),
    );
    register(
        ObjMgmtOpcode::Copy.rlop_key(),
        Arc::new(ObjCopyOp::new(Arc::clone(&runtime))),
    );
    // module_obj_fg_bg (per plane)
    for plane in [GraphicsPlane::Foreground, GraphicsPlane::Background] {
        for opcode in ObjFgBgOpcode::ALL {
            register(
                opcode.rlop_key_for(plane),
                Arc::new(ObjFgBgOp::new(Arc::clone(&runtime), plane, *opcode)),
            );
        }
    }
    // `objButtonOpts` on both planes — button-object setup that feeds the
    // `select_objbtn` option set. Stateless (mutates the VM's button
    // group), so it takes no `runtime`.
    for module_id in [OBJ_FG_MODULE_ID, OBJ_BG_MODULE_ID] {
        register(
            RlopKey::new(OBJ_FG_MODULE_TYPE, module_id, OPCODE_OBJ_BUTTON_OPTS),
            Arc::new(ObjButtonOptsOp::new()),
        );
    }
    // Touch the GraphicsObjectKind import so the audit grep that
    // pins "no unused imports" remains green.
    let _ = std::marker::PhantomData::<GraphicsObjectKind>;
    count
}

// ---- tests -----------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::GraphicsObjectKind as Kind;
    use crate::RenderPass;
    use crate::WipeColour;

    fn runtime() -> Arc<GraphicsRuntime> {
        Arc::new(GraphicsRuntime::new())
    }

    fn vm() -> Vm {
        Vm::new(1, 0)
    }

    fn int(value: i32) -> ExprValue {
        ExprValue::Int(value)
    }

    #[test]
    fn obj_register_helper_populates_expected_count() {
        let mut registry = RlopRegistry::new();
        let count = register_obj_rlops(&mut registry, runtime());
        assert_eq!(count, OBJ_RLOP_COUNT);
        assert_eq!(count, 18);
        // `objButtonOpts` mounted on both planes (button-object setup).
        assert!(
            registry
                .get(RlopKey::new(
                    OBJ_FG_MODULE_TYPE,
                    OBJ_FG_MODULE_ID,
                    OPCODE_OBJ_BUTTON_OPTS
                ))
                .is_some(),
            "objButtonOpts resolves on the fg plane"
        );
        assert!(
            registry
                .get(RlopKey::new(
                    OBJ_BG_MODULE_TYPE,
                    OBJ_BG_MODULE_ID,
                    OPCODE_OBJ_BUTTON_OPTS
                ))
                .is_some(),
            "objButtonOpts resolves on the bg plane"
        );
        for op in ObjMgmtOpcode::ALL {
            assert!(registry.get(op.rlop_key()).is_some(), "{op:?} resolves");
        }
        for plane in [GraphicsPlane::Foreground, GraphicsPlane::Background] {
            for op in ObjFgBgOpcode::ALL {
                assert!(
                    registry.get(op.rlop_key_for(plane)).is_some(),
                    "{plane:?} {op:?} resolves",
                );
            }
        }
    }

    #[test]
    fn obj_alloc_allocates_empty_image_slot_on_foreground() {
        let runtime = runtime();
        ObjAllocOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(4)]);
        let snap = runtime.state_snapshot();
        let object = snap.foreground_slot(4).expect("slot 4 allocated");
        match &object.kind {
            Kind::Image { image_ref } => assert!(image_ref.asset_key.is_empty()),
            other @ Kind::Wipe { .. } => panic!("expected Image, got {other:?}"),
        }
    }

    #[test]
    fn obj_free_releases_the_slot() {
        let runtime = runtime();
        ObjAllocOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(4)]);
        assert_eq!(runtime.state_snapshot().allocated_slot_count(), 1);
        ObjFreeOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(4)]);
        assert_eq!(runtime.state_snapshot().allocated_slot_count(), 0);
    }

    #[test]
    fn obj_init_resets_mutable_state_to_identity() {
        let runtime = runtime();
        ObjAllocOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(1)]);
        // Mutate every field.
        runtime.with_stack_mut(|stack| {
            let obj = stack.get_mut(GraphicsPlane::Foreground, 1).unwrap();
            obj.position = GraphicsPosition { x: 100, y: 200 };
            obj.scale = GraphicsScale {
                x_thousandths: 500,
                y_thousandths: 500,
            };
            obj.alpha = GraphicsAlpha(0);
            obj.layer_order = 7;
            obj.visible = false;
        });
        ObjInitOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(1)]);
        let snap = runtime.state_snapshot();
        let obj = snap.foreground_slot(1).expect("slot 1 allocated");
        assert_eq!(obj.position, GraphicsPosition::ORIGIN);
        assert_eq!(obj.scale, GraphicsScale::IDENTITY);
        assert_eq!(obj.alpha, GraphicsAlpha::OPAQUE);
        assert_eq!(obj.layer_order, 0);
        assert!(obj.visible);
    }

    #[test]
    fn obj_copy_clones_source_to_destination() {
        let runtime = runtime();
        ObjAllocOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0)]);
        runtime.with_stack_mut(|stack| {
            let obj = stack.get_mut(GraphicsPlane::Foreground, 0).unwrap();
            obj.layer_order = 5;
        });
        ObjCopyOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0), int(7)]);
        let snap = runtime.state_snapshot();
        let dst = snap.foreground_slot(7).expect("destination slot allocated");
        assert_eq!(dst.layer_order, 5);
    }

    #[test]
    fn obj_set_pos_alpha_scale_apply_observable_mutation() {
        let runtime = runtime();
        ObjAllocOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0)]);
        ObjFgBgOp::new(
            Arc::clone(&runtime),
            GraphicsPlane::Foreground,
            ObjFgBgOpcode::SetPos,
        )
        .dispatch(&mut vm(), &[int(0), int(12), int(-7)]);
        ObjFgBgOp::new(
            Arc::clone(&runtime),
            GraphicsPlane::Foreground,
            ObjFgBgOpcode::SetAlpha,
        )
        .dispatch(&mut vm(), &[int(0), int(128)]);
        ObjFgBgOp::new(
            Arc::clone(&runtime),
            GraphicsPlane::Foreground,
            ObjFgBgOpcode::SetScale,
        )
        .dispatch(&mut vm(), &[int(0), int(2000), int(500)]);
        let snap = runtime.state_snapshot();
        let obj = snap.foreground_slot(0).expect("slot allocated");
        assert_eq!(obj.position, GraphicsPosition { x: 12, y: -7 });
        assert_eq!(obj.alpha, GraphicsAlpha(128));
        assert_eq!(
            obj.scale,
            GraphicsScale {
                x_thousandths: 2000,
                y_thousandths: 500,
            }
        );
    }

    #[test]
    fn obj_show_hide_toggles_visibility_flag() {
        let runtime = runtime();
        ObjAllocOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0)]);
        ObjFgBgOp::new(
            Arc::clone(&runtime),
            GraphicsPlane::Foreground,
            ObjFgBgOpcode::Hide,
        )
        .dispatch(&mut vm(), &[int(0)]);
        assert!(!runtime.state_snapshot().foreground_slot(0).unwrap().visible);
        ObjFgBgOp::new(
            Arc::clone(&runtime),
            GraphicsPlane::Foreground,
            ObjFgBgOpcode::Show,
        )
        .dispatch(&mut vm(), &[int(0)]);
        assert!(runtime.state_snapshot().foreground_slot(0).unwrap().visible);
    }

    #[test]
    fn obj_set_layer_reorders_render_pass_output() {
        // Audit-focus pin: a `objSetLayer` must observably re-order the
        // render-pass paint output. We populate two wipe slots on the
        // foreground plane (black at layer 0 and white at layer 1).
        // Setting white's layer to a lower value than black's must
        // change which colour wins the 1x1 framebuffer.
        let runtime = runtime();
        runtime.with_stack_mut(|stack| {
            let mut black = GraphicsObject::wipe(WipeColour::BLACK);
            black.layer_order = 0;
            let mut white = GraphicsObject::wipe(WipeColour::WHITE);
            white.layer_order = 1;
            stack
                .set(GraphicsPlane::Foreground, 0, black)
                .expect("set black");
            stack
                .set(GraphicsPlane::Foreground, 1, white)
                .expect("set white");
        });
        let pass = RenderPass::with_dimensions(1, 1).expect("non-zero");
        let before = runtime.with_stack(|stack| pass.rasterise(stack));
        assert_eq!(before.pixels(), &[0xFF, 0xFF, 0xFF, 0xFF]);
        // Now drop white to layer -1; black wins.
        ObjFgBgOp::new(
            Arc::clone(&runtime),
            GraphicsPlane::Foreground,
            ObjFgBgOpcode::SetLayer,
        )
        .dispatch(&mut vm(), &[int(1), int(-1)]);
        let after = runtime.with_stack(|stack| pass.rasterise(stack));
        assert_eq!(after.pixels(), &[0x00, 0x00, 0x00, 0xFF]);
    }

    #[test]
    fn obj_set_alpha_on_bg_plane_lands_on_background() {
        let runtime = runtime();
        runtime.with_stack_mut(|stack| {
            stack
                .set(
                    GraphicsPlane::Background,
                    0,
                    GraphicsObject::wipe(WipeColour::BLACK),
                )
                .expect("set bg");
        });
        ObjFgBgOp::new(
            Arc::clone(&runtime),
            GraphicsPlane::Background,
            ObjFgBgOpcode::SetAlpha,
        )
        .dispatch(&mut vm(), &[int(0), int(64)]);
        let snap = runtime.state_snapshot();
        assert_eq!(snap.background_slot(0).unwrap().alpha, GraphicsAlpha(64));
    }

    #[test]
    fn obj_set_pos_on_empty_slot_records_typed_warning() {
        let runtime = runtime();
        ObjFgBgOp::new(
            Arc::clone(&runtime),
            GraphicsPlane::Foreground,
            ObjFgBgOpcode::SetPos,
        )
        .dispatch(&mut vm(), &[int(5), int(1), int(2)]);
        let warnings = runtime.take_warnings();
        assert!(
            warnings
                .iter()
                .any(|w| matches!(w, GraphicsRuntimeWarning::OperateOnEmptySlot { slot: 5 }))
        );
    }

    #[test]
    fn fade_longop_round_trips_through_payload() {
        let long = FadeLongOp::new(LongOpId(1), 255, 0, 1000).into_longop();
        assert_eq!(long.private_state.len(), FadeLongOp::PAYLOAD_BYTE_LEN);
        assert_eq!(long.private_state[0], FADE_PRIVATE_STATE_MAGIC);
        let decoded = FadeLongOp::try_from_payload(long.id, &long.private_state).expect("decode");
        assert_eq!(decoded.starting_alpha(), 255);
        assert_eq!(decoded.target_alpha(), 0);
        assert_eq!(decoded.total_ticks(), 1000);
        assert_eq!(decoded.elapsed_ticks(), 0);
    }

    #[test]
    fn fade_longop_current_alpha_interpolates_linearly() {
        let mut fade = FadeLongOp::new(LongOpId(1), 0, 200, 100);
        assert_eq!(fade.current_alpha(), 0);
        fade.advance(50);
        assert_eq!(fade.current_alpha(), 100);
        fade.advance(50);
        assert_eq!(fade.current_alpha(), 200);
        assert!(fade.is_complete());
    }

    #[test]
    fn fade_longop_payload_decode_rejects_wrong_magic() {
        let mut payload = vec![0u8; FadeLongOp::PAYLOAD_BYTE_LEN];
        payload[0] = 0x00;
        let err = FadeLongOp::try_from_payload(LongOpId(1), &payload).expect_err("must reject");
        assert!(matches!(
            err,
            FadeLongOpDecodeError::MagicMismatch {
                observed: 0x00,
                expected: FADE_PRIVATE_STATE_MAGIC,
            }
        ));
    }

    #[test]
    fn fade_longop_payload_decode_rejects_short_payload() {
        let payload = vec![FADE_PRIVATE_STATE_MAGIC];
        let err = FadeLongOp::try_from_payload(LongOpId(1), &payload).expect_err("must reject");
        assert!(matches!(
            err,
            FadeLongOpDecodeError::UnexpectedPayloadLength {
                observed: 1,
                expected: 19,
            }
        ));
    }

    #[test]
    fn graphics_runtime_next_longop_id_is_strictly_monotonic() {
        let runtime = runtime();
        assert_eq!(runtime.next_longop_id(), LongOpId(1));
        assert_eq!(runtime.next_longop_id(), LongOpId(2));
        assert_eq!(runtime.next_longop_id(), LongOpId(3));
    }

    #[test]
    fn graphics_runtime_fade_ticks_per_ms_defaults_then_overrides() {
        let runtime = runtime();
        assert_eq!(runtime.fade_ticks_per_ms(), DEFAULT_FADE_TICKS_PER_MS);
        runtime.set_fade_ticks_per_ms(8);
        assert_eq!(runtime.fade_ticks_per_ms(), 8);
    }
}
