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

use super::{DispatchOutcome, ExprValue, RLOperation};
use crate::g00::{G00DecodeError, G00Warning, decode_g00};
use crate::graphics_objects::{GraphicsLayer, GraphicsObject, GraphicsObjectStack};
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

// ---- module_obj_fg_bg opcodes ---------------------------------------

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
    /// can record the gap observably. Non-fatal [`crate::g00::G00Warning`]
    /// entries the decoder returns alongside the image are pushed onto
    /// the runtime's warning queue (under
    /// [`GraphicsRuntimeWarning::G00PayloadWarning`]) — they are NOT
    /// discarded at the dims-probe boundary, so a corpus LZSS drift
    /// surfaces observably instead of being silently rounded to the
    /// canvas size. The fatal `Err` arm is unchanged (still returns
    /// [`GraphicsRuntimeWarning::G00DecodeFailure`] for the caller to
    /// tag with the dispatch opcode).
    ///
    /// `opcode_tag` is stamped on every emitted `G00PayloadWarning` so
    /// the dims-probe origin is named in the audit trail; pass the
    /// dispatch op's [`RLOperation::tag`] (or `""` when no dispatch
    /// context is available). Tests that don't care about the stamp
    /// may pass `""`.
    pub fn read_g00_through_vfs(
        &self,
        asset_name: &str,
        opcode_tag: &'static str,
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
            Ok((image, warnings)) => {
                for warning in warnings {
                    self.push_warning(Self::g00_payload_warning(asset_name, opcode_tag, &warning));
                }
                Ok(Some((image.width, image.height)))
            }
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

    /// Translate a non-fatal [`crate::g00::G00Warning`] into a
    /// [`GraphicsRuntimeWarning::G00PayloadWarning`] stamped with the
    /// dims-probe's asset key AND the dispatcher's `opcode_tag` (so the
    /// audit trail names both the g00 origin and the rgrop that triggered
    /// the probe). The `Display` impl of [`crate::g00::G00Warning`]
    /// renders the diagnostic prefix (`utsushi.reallive.g00.…`) so the
    /// resulting warning text carries the original stable code plus the
    /// runtime-owned opcode / asset framing.
    fn g00_payload_warning(
        asset_name: &str,
        opcode_tag: &'static str,
        warning: &G00Warning,
    ) -> GraphicsRuntimeWarning {
        GraphicsRuntimeWarning::G00PayloadWarning {
            opcode_tag,
            asset_key: asset_name.to_string(),
            reason: warning.to_string(),
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

// ---- tests -----------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

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
    fn obj_button_opts_registers_button_on_vm_group() {
        let op = ObjButtonOptsOp::new();
        let mut vm = vm();
        op.dispatch(&mut vm, &[int(2), int(7)]);
        op.dispatch(&mut vm, &[int(3), int(7)]);
        assert_eq!(vm.objbtn_buttons().len(), 2);
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
