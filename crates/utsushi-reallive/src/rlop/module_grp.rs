//! UTSUSHI-215 — RealLive `module_grp` graphics RLOperation family
//! subset.
//!
//! Implements the alpha-tier subset of RealLive's `module_grp`
//! (graphics primitives) the UTSUSHI-215 spec node pins: `allocDC`,
//! `wipe`, `shake`, `load`, `open`, `openBg`, `copy`, `fill`,
//! `invert`, `mono`, `colour`, `light`, `fade`, `stretchBlit`, `zoom`.
//!
//! Every op routes through a shared [`crate::rlop::module_obj::GraphicsRuntime`]
//! that owns the [`crate::GraphicsObjectStack`] state, an optional
//! [`utsushi_core::substrate::AssetPackage`] for VFS-backed
//! `openBg`-style g00 reads, and the fail-soft warning queue.
//!
//! # Module addressing
//!
//! `module_grp` lives at `(module_type=1, module_id=33)` per RLDEV's
//! catalogue (`docs/research/reallive-engine.md` §F). rlvm is a
//! research anchor only; the byte values below are restated as
//! const-pinned audit anchors, not derived by mechanical translation.
//!
//! # Substrate-honest posture
//!
//! Per the spec's audit-focus pins:
//! - **No state-only ops.** Every opcode that mutates the graphics
//!   stack also produces an observable effect through
//!   [`crate::rlop::module_obj::GraphicsRuntime::state_snapshot`] — the
//!   acceptance test
//!   `grp_alloc_dc_mutates_observable_stack_snapshot` round-trips a
//!   typed before/after pair.
//! - **No silent fallbacks.** Each op consumes its declared arg count
//!   through typed accessors; a mismatch records a fail-soft
//!   [`crate::rlop::module_obj::GraphicsRuntimeWarning`] rather than
//!   panicking.
//! - **Layer-ordering honoured.** The graphics object stack already
//!   sorts allocated entries by `(plane.paint_order(), layer_order,
//!   slot)` in [`crate::RenderPass::rasterise`], so `objSetLayer` is
//!   observable through a render. The `module_grp` family does not
//!   alter that surface; it allocates the slots `module_obj_*` then
//!   addresses.

use std::sync::Arc;

use super::module_obj::{
    DEFAULT_FADE_TICKS_PER_MS, FadeLongOp, GraphicsRuntime, GraphicsRuntimeWarning,
};
use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::graphics_objects::{
    GraphicsAlpha, GraphicsColourTone, GraphicsObject, GraphicsPlane, WipeColour,
};
use crate::rlop::LongOpId;
use crate::vm::Vm;

// ---- module_grp addressing -------------------------------------------

/// `module_type` byte for `module_grp` (graphics primitives). Per
/// RLDEV's published catalogue.
pub const GRP_MODULE_TYPE: u8 = 1;
/// `module_id` byte for `module_grp`.
pub const GRP_MODULE_ID: u8 = 33;

/// `grp.allocDC(int slot, int width, int height)` — allocate a
/// drawing-context wipe slot on the **foreground** plane. The slot
/// becomes a transparent wipe (so the next render produces a clear,
/// observable mutation but no painted pixels).
pub const OPCODE_GRP_ALLOC_DC: u16 = 0x0001;
/// `grp.wipe(int slot, int r, int g, int b)` — fill the named slot
/// with an opaque RGB wipe.
pub const OPCODE_GRP_WIPE: u16 = 0x0002;
/// `grp.shake(int amplitude_px)` — record a shake amplitude on the
/// runtime (observable through `state_snapshot.shake_amplitude_px`).
/// No render-time shake yet at UTSUSHI-215; the amplitude is the
/// observable mutation.
pub const OPCODE_GRP_SHAKE: u16 = 0x0003;
/// `grp.load(int slot, string asset_name)` — load a g00 image asset
/// into the foreground slot, recording an [`crate::ImageRef`].
pub const OPCODE_GRP_LOAD: u16 = 0x0004;
/// `grp.open(int slot, string asset_name)` — alias of `load` per
/// RLDEV catalogue; the historical distinction (open = with display
/// effect) is collapsed at UTSUSHI-215, which records the asset_key
/// observable through `state_snapshot`.
pub const OPCODE_GRP_OPEN: u16 = 0x0005;
/// `grp.openBg(string asset_name)` — load a g00 background asset and
/// register it as the **background plane**'s slot 0 (the bg plane).
/// The acceptance test `grp_openbg_bg01a1_registers_bg_plane` reads
/// `$GAME/REALLIVEDATA/g00/BG01A1.g00` via the substrate VFS and
/// pins the registration through the state-snapshot surface.
pub const OPCODE_GRP_OPEN_BG: u16 = 0x0006;
/// `grp.copy(int src_slot, int dst_slot)` — copy the foreground
/// slot's [`GraphicsObject`] from src to dst.
pub const OPCODE_GRP_COPY: u16 = 0x0007;
/// `grp.fill(int slot, int r, int g, int b)` — alias of `wipe` per
/// RLDEV catalogue; same semantics.
pub const OPCODE_GRP_FILL: u16 = 0x0008;
/// `grp.invert(int slot)` — invert the colour tone of the named
/// slot (R/G/B tone fields flipped to negative).
pub const OPCODE_GRP_INVERT: u16 = 0x0009;
/// `grp.mono(int slot)` — set the colour tone to a desaturated
/// (monochrome) tone (R=B, G=B; here we set all three tone fields to
/// the same value so the audit surface reads as monochrome).
pub const OPCODE_GRP_MONO: u16 = 0x000A;
/// `grp.colour(int slot, int r, int g, int b)` — apply a typed
/// colour tone to the named slot.
pub const OPCODE_GRP_COLOUR: u16 = 0x000B;
/// `grp.light(int slot, int level)` — apply a uniform brightness
/// tone to the named slot.
pub const OPCODE_GRP_LIGHT: u16 = 0x000C;
/// `grp.fade(int target_alpha, int duration_ms)` — schedule a typed
/// [`FadeLongOp`] that mutates the bg plane's slot 0 alpha across
/// `duration_ms * ticks_per_ms` ticks.
pub const OPCODE_GRP_FADE: u16 = 0x000D;
/// `grp.stretchBlit(int src_slot, int dst_slot, int dst_w, int dst_h)`
/// — copy `src_slot` into `dst_slot` with a typed target scale derived
/// from the destination dimensions over a 1000-thousandth normalisation.
pub const OPCODE_GRP_STRETCH_BLIT: u16 = 0x000E;
/// `grp.zoom(int slot, int scale_thousandths)` — set both axes of the
/// slot's scale to the supplied thousandth value.
pub const OPCODE_GRP_ZOOM: u16 = 0x000F;

/// Background-plane slot the `openBg` opcode registers into. Pinned so
/// audit tooling can pin the slot without dereferencing the runtime.
pub const BG_PLANE_SLOT: usize = 0;

/// Stable enum naming the `module_grp` opcodes UTSUSHI-215 implements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum GrpOpcode {
    AllocDc,
    Wipe,
    Shake,
    Load,
    Open,
    OpenBg,
    Copy,
    Fill,
    Invert,
    Mono,
    Colour,
    Light,
    Fade,
    StretchBlit,
    Zoom,
}

impl GrpOpcode {
    /// All `module_grp` opcodes this module ships.
    pub const ALL: &'static [GrpOpcode] = &[
        Self::AllocDc,
        Self::Wipe,
        Self::Shake,
        Self::Load,
        Self::Open,
        Self::OpenBg,
        Self::Copy,
        Self::Fill,
        Self::Invert,
        Self::Mono,
        Self::Colour,
        Self::Light,
        Self::Fade,
        Self::StretchBlit,
        Self::Zoom,
    ];

    /// Numeric opcode byte for this variant.
    pub fn opcode(self) -> u16 {
        match self {
            Self::AllocDc => OPCODE_GRP_ALLOC_DC,
            Self::Wipe => OPCODE_GRP_WIPE,
            Self::Shake => OPCODE_GRP_SHAKE,
            Self::Load => OPCODE_GRP_LOAD,
            Self::Open => OPCODE_GRP_OPEN,
            Self::OpenBg => OPCODE_GRP_OPEN_BG,
            Self::Copy => OPCODE_GRP_COPY,
            Self::Fill => OPCODE_GRP_FILL,
            Self::Invert => OPCODE_GRP_INVERT,
            Self::Mono => OPCODE_GRP_MONO,
            Self::Colour => OPCODE_GRP_COLOUR,
            Self::Light => OPCODE_GRP_LIGHT,
            Self::Fade => OPCODE_GRP_FADE,
            Self::StretchBlit => OPCODE_GRP_STRETCH_BLIT,
            Self::Zoom => OPCODE_GRP_ZOOM,
        }
    }

    /// Composite registry key the VM uses to dispatch this op.
    pub fn rlop_key(self) -> RlopKey {
        RlopKey::new(GRP_MODULE_TYPE, GRP_MODULE_ID, self.opcode())
    }

    /// Stable lowercase tag used by [`GraphicsRuntimeWarning`].
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AllocDc => "grp.allocDC",
            Self::Wipe => "grp.wipe",
            Self::Shake => "grp.shake",
            Self::Load => "grp.load",
            Self::Open => "grp.open",
            Self::OpenBg => "grp.openBg",
            Self::Copy => "grp.copy",
            Self::Fill => "grp.fill",
            Self::Invert => "grp.invert",
            Self::Mono => "grp.mono",
            Self::Colour => "grp.colour",
            Self::Light => "grp.light",
            Self::Fade => "grp.fade",
            Self::StretchBlit => "grp.stretchBlit",
            Self::Zoom => "grp.zoom",
        }
    }
}

/// Number of opcodes [`register_grp_rlops`] mounts.
pub const GRP_RLOP_COUNT: usize = GrpOpcode::ALL.len();

// ---- argument helpers ------------------------------------------------

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

fn arg_bytes<'a>(
    args: &'a [ExprValue],
    at: usize,
    slot: &'static str,
) -> Result<&'a [u8], GraphicsRuntimeWarning> {
    args.get(at)
        .ok_or(GraphicsRuntimeWarning::MissingArg {
            opcode_tag: "",
            slot,
        })
        .and_then(|value| {
            value
                .as_bytes()
                .ok_or(GraphicsRuntimeWarning::ArgShapeMismatch {
                    opcode_tag: "",
                    expected: "bytes",
                })
        })
}

fn slot_index(value: i32) -> Result<usize, GraphicsRuntimeWarning> {
    if !(0..256).contains(&value) {
        return Err(GraphicsRuntimeWarning::SlotOutOfRange { slot: value });
    }
    Ok(value as usize)
}

fn clamp_byte(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

fn decode_shift_jis(bytes: &[u8]) -> Option<String> {
    let (cow, _, had_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
    if had_errors {
        return None;
    }
    let value = cow.into_owned();
    let trimmed = value.trim_end_matches('\0').to_string();
    Some(trimmed)
}

fn fail(
    runtime: &GraphicsRuntime,
    op: GrpOpcode,
    warning: GraphicsRuntimeWarning,
) -> DispatchOutcome {
    runtime.push_warning(warning.with_opcode(op.as_str()));
    DispatchOutcome::Advance
}

// ---- per-opcode RLOperation implementors -----------------------------

/// `grp.allocDC(int slot, int width, int height)` — allocates a
/// transparent wipe slot on the foreground plane and records the
/// requested dimensions in the runtime's state-snapshot surface.
#[derive(Debug)]
pub struct GrpAllocDcOp {
    runtime: Arc<GraphicsRuntime>,
}

impl GrpAllocDcOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for GrpAllocDcOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_slot = match arg_int(args, 0, "slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::AllocDc, warning),
        };
        let width = match arg_int(args, 1, "width") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::AllocDc, warning),
        };
        let height = match arg_int(args, 2, "height") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::AllocDc, warning),
        };
        let slot = match slot_index(raw_slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::AllocDc, warning),
        };
        self.runtime
            .set_dc_allocation(slot, width.max(0) as u32, height.max(0) as u32);
        self.runtime.with_stack_mut(|stack| {
            let object = GraphicsObject::wipe(WipeColour::TRANSPARENT);
            // Slot range is bounds-checked above; the typed setter
            // returns `Err` only for `slot >= 256` which we already
            // rejected.
            let _ = stack.set(GraphicsPlane::Foreground, slot, object);
        });
        DispatchOutcome::Advance
    }
}

/// `grp.wipe(int slot, int r, int g, int b)` — fills the named slot
/// with an opaque RGB wipe.
#[derive(Debug)]
pub struct GrpWipeOp {
    runtime: Arc<GraphicsRuntime>,
    tag: GrpOpcode,
}

impl GrpWipeOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self {
            runtime,
            tag: GrpOpcode::Wipe,
        }
    }

    /// Construct a wipe-shaped op tagged as `grp.fill` (alias).
    pub fn new_as_fill(runtime: Arc<GraphicsRuntime>) -> Self {
        Self {
            runtime,
            tag: GrpOpcode::Fill,
        }
    }
}

impl RLOperation for GrpWipeOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_slot = match arg_int(args, 0, "slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, self.tag, warning),
        };
        let red = match arg_int(args, 1, "red") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, self.tag, warning),
        };
        let green = match arg_int(args, 2, "green") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, self.tag, warning),
        };
        let blue = match arg_int(args, 3, "blue") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, self.tag, warning),
        };
        let slot = match slot_index(raw_slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, self.tag, warning),
        };
        let colour = WipeColour::opaque_rgb(clamp_byte(red), clamp_byte(green), clamp_byte(blue));
        self.runtime.with_stack_mut(|stack| {
            let object = GraphicsObject::wipe(colour);
            let _ = stack.set(GraphicsPlane::Foreground, slot, object);
        });
        DispatchOutcome::Advance
    }
}

/// `grp.shake(int amplitude_px)` — records a shake amplitude on the
/// runtime. Observable through
/// [`GraphicsRuntime::state_snapshot`]`.shake_amplitude_px`.
#[derive(Debug)]
pub struct GrpShakeOp {
    runtime: Arc<GraphicsRuntime>,
}

impl GrpShakeOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for GrpShakeOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let amplitude = match arg_int(args, 0, "amplitude_px") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Shake, warning),
        };
        self.runtime.set_shake_amplitude_px(amplitude.max(0) as u32);
        DispatchOutcome::Advance
    }
}

/// `grp.load(int slot, string asset_name)` — record an
/// [`crate::ImageRef`] into the named foreground slot. Used for both
/// `load` and `open` (alias per RLDEV).
#[derive(Debug)]
pub struct GrpLoadOp {
    runtime: Arc<GraphicsRuntime>,
    tag: GrpOpcode,
}

impl GrpLoadOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self {
            runtime,
            tag: GrpOpcode::Load,
        }
    }

    /// Construct the same shape tagged as `grp.open` (alias).
    pub fn new_as_open(runtime: Arc<GraphicsRuntime>) -> Self {
        Self {
            runtime,
            tag: GrpOpcode::Open,
        }
    }
}

impl RLOperation for GrpLoadOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_slot = match arg_int(args, 0, "slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, self.tag, warning),
        };
        let raw_name = match arg_bytes(args, 1, "asset_name") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, self.tag, warning),
        };
        let slot = match slot_index(raw_slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, self.tag, warning),
        };
        let asset_name = match decode_shift_jis(raw_name) {
            Some(name) if !name.is_empty() => name,
            Some(_) => {
                return fail(
                    &self.runtime,
                    self.tag,
                    GraphicsRuntimeWarning::EmptyAssetName,
                );
            }
            None => {
                return fail(
                    &self.runtime,
                    self.tag,
                    GraphicsRuntimeWarning::InvalidShiftJis { opcode_tag: "" },
                );
            }
        };
        self.runtime.with_stack_mut(|stack| {
            let object = GraphicsObject::image(asset_name.clone());
            let _ = stack.set(GraphicsPlane::Foreground, slot, object);
        });
        DispatchOutcome::Advance
    }
}

/// `grp.openBg(string asset_name)` — read the named g00 asset through
/// the substrate VFS and register it as the **background plane's** slot
/// 0. The decoded image dimensions are recorded on the runtime so the
/// state-snapshot surface pins them without dereferencing the bytes.
///
/// Acceptance test pinned by the spec: with the Sweetie HD VFS
/// surface plumbed through [`GraphicsRuntime::set_asset_package`],
/// `openBg("BG01A1")` produces a bg plane object whose
/// `image_ref.asset_key == "BG01A1"` and whose recorded canvas size is
/// `1280 x 720` (the documented BG canvas).
#[derive(Debug)]
pub struct GrpOpenBgOp {
    runtime: Arc<GraphicsRuntime>,
}

impl GrpOpenBgOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for GrpOpenBgOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_name = match arg_bytes(args, 0, "asset_name") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::OpenBg, warning),
        };
        let asset_name = match decode_shift_jis(raw_name) {
            Some(name) if !name.is_empty() => name,
            Some(_) => {
                return fail(
                    &self.runtime,
                    GrpOpcode::OpenBg,
                    GraphicsRuntimeWarning::EmptyAssetName,
                );
            }
            None => {
                return fail(
                    &self.runtime,
                    GrpOpcode::OpenBg,
                    GraphicsRuntimeWarning::InvalidShiftJis { opcode_tag: "" },
                );
            }
        };
        // Record the bg plane registration on the runtime first — the
        // state-snapshot surface pins the asset_key even when the VFS
        // is absent (substrate-honest "no silent skip").
        self.runtime.with_stack_mut(|stack| {
            let object = GraphicsObject::image(asset_name.clone());
            // bg plane, slot 0 — the documented bg-plane address.
            let _ = stack.set(GraphicsPlane::Background, BG_PLANE_SLOT, object);
        });
        match self.runtime.read_g00_through_vfs(&asset_name) {
            Ok(Some((width, height))) => {
                self.runtime.record_bg_canvas(&asset_name, width, height);
            }
            Ok(None) => {
                // No asset package set; the bg slot is still registered
                // observably, but the decoded canvas is unknown. Record
                // the asset key + dimensions=None.
                self.runtime.record_bg_asset_only(&asset_name);
            }
            Err(warning) => {
                self.runtime
                    .push_warning(warning.with_opcode(GrpOpcode::OpenBg.as_str()));
            }
        }
        DispatchOutcome::Advance
    }
}

/// `grp.copy(int src_slot, int dst_slot)` — clones the foreground
/// `src_slot`'s object into `dst_slot`. No-op (with a typed warning)
/// if `src_slot` is empty.
#[derive(Debug)]
pub struct GrpCopyOp {
    runtime: Arc<GraphicsRuntime>,
}

impl GrpCopyOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for GrpCopyOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_src = match arg_int(args, 0, "src_slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Copy, warning),
        };
        let raw_dst = match arg_int(args, 1, "dst_slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Copy, warning),
        };
        let src = match slot_index(raw_src) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Copy, warning),
        };
        let dst = match slot_index(raw_dst) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Copy, warning),
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
                    .with_opcode(GrpOpcode::Copy.as_str()),
            );
        }
        DispatchOutcome::Advance
    }
}

/// `grp.invert(int slot)` — flip the colour tone fields' signs.
#[derive(Debug)]
pub struct GrpInvertOp {
    runtime: Arc<GraphicsRuntime>,
}

impl GrpInvertOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for GrpInvertOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_slot = match arg_int(args, 0, "slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Invert, warning),
        };
        let slot = match slot_index(raw_slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Invert, warning),
        };
        let observed = self.runtime.with_stack_mut(|stack| {
            if let Some(object) = stack.get_mut(GraphicsPlane::Foreground, slot) {
                object.colour_tone = GraphicsColourTone {
                    red_thousandths: -object.colour_tone.red_thousandths,
                    green_thousandths: -object.colour_tone.green_thousandths,
                    blue_thousandths: -object.colour_tone.blue_thousandths,
                };
                true
            } else {
                false
            }
        });
        if !observed {
            self.runtime.push_warning(
                GraphicsRuntimeWarning::OperateOnEmptySlot { slot }
                    .with_opcode(GrpOpcode::Invert.as_str()),
            );
        }
        DispatchOutcome::Advance
    }
}

/// `grp.mono(int slot)` — desaturate the slot's tone.
#[derive(Debug)]
pub struct GrpMonoOp {
    runtime: Arc<GraphicsRuntime>,
}

impl GrpMonoOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for GrpMonoOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_slot = match arg_int(args, 0, "slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Mono, warning),
        };
        let slot = match slot_index(raw_slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Mono, warning),
        };
        let observed = self.runtime.with_stack_mut(|stack| {
            if let Some(object) = stack.get_mut(GraphicsPlane::Foreground, slot) {
                // The three tone channels collapse to the same value;
                // we pick `-1000` so the audit surface pins
                // "monochrome" as the tone shape.
                object.colour_tone = GraphicsColourTone {
                    red_thousandths: -1000,
                    green_thousandths: -1000,
                    blue_thousandths: -1000,
                };
                true
            } else {
                false
            }
        });
        if !observed {
            self.runtime.push_warning(
                GraphicsRuntimeWarning::OperateOnEmptySlot { slot }
                    .with_opcode(GrpOpcode::Mono.as_str()),
            );
        }
        DispatchOutcome::Advance
    }
}

/// `grp.colour(int slot, int r, int g, int b)` — apply a typed colour
/// tone.
#[derive(Debug)]
pub struct GrpColourOp {
    runtime: Arc<GraphicsRuntime>,
}

impl GrpColourOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for GrpColourOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_slot = match arg_int(args, 0, "slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Colour, warning),
        };
        let red = match arg_int(args, 1, "red") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Colour, warning),
        };
        let green = match arg_int(args, 2, "green") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Colour, warning),
        };
        let blue = match arg_int(args, 3, "blue") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Colour, warning),
        };
        let slot = match slot_index(raw_slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Colour, warning),
        };
        let observed = self.runtime.with_stack_mut(|stack| {
            if let Some(object) = stack.get_mut(GraphicsPlane::Foreground, slot) {
                object.colour_tone = GraphicsColourTone {
                    red_thousandths: red.clamp(-1000, 1000),
                    green_thousandths: green.clamp(-1000, 1000),
                    blue_thousandths: blue.clamp(-1000, 1000),
                };
                true
            } else {
                false
            }
        });
        if !observed {
            self.runtime.push_warning(
                GraphicsRuntimeWarning::OperateOnEmptySlot { slot }
                    .with_opcode(GrpOpcode::Colour.as_str()),
            );
        }
        DispatchOutcome::Advance
    }
}

/// `grp.light(int slot, int level)` — apply a uniform brightness tone.
#[derive(Debug)]
pub struct GrpLightOp {
    runtime: Arc<GraphicsRuntime>,
}

impl GrpLightOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for GrpLightOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_slot = match arg_int(args, 0, "slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Light, warning),
        };
        let level = match arg_int(args, 1, "level") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Light, warning),
        };
        let slot = match slot_index(raw_slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Light, warning),
        };
        let observed = self.runtime.with_stack_mut(|stack| {
            if let Some(object) = stack.get_mut(GraphicsPlane::Foreground, slot) {
                let clamped = level.clamp(-1000, 1000);
                object.colour_tone = GraphicsColourTone {
                    red_thousandths: clamped,
                    green_thousandths: clamped,
                    blue_thousandths: clamped,
                };
                true
            } else {
                false
            }
        });
        if !observed {
            self.runtime.push_warning(
                GraphicsRuntimeWarning::OperateOnEmptySlot { slot }
                    .with_opcode(GrpOpcode::Light.as_str()),
            );
        }
        DispatchOutcome::Advance
    }
}

/// `grp.fade(int target_alpha, int duration_ms)` — schedule a typed
/// [`FadeLongOp`] against the bg plane's slot 0. Returns a
/// [`DispatchOutcome::Yield`] carrying the encoded payload.
#[derive(Debug)]
pub struct GrpFadeOp {
    runtime: Arc<GraphicsRuntime>,
}

impl GrpFadeOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for GrpFadeOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let target_alpha = match arg_int(args, 0, "target_alpha") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Fade, warning),
        };
        let duration_ms = match arg_int(args, 1, "duration_ms") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Fade, warning),
        };
        if duration_ms < 0 {
            return fail(
                &self.runtime,
                GrpOpcode::Fade,
                GraphicsRuntimeWarning::NegativeFadeDuration { duration_ms },
            );
        }
        let ticks_per_ms = self.runtime.fade_ticks_per_ms();
        let total_ticks = (duration_ms as u64).saturating_mul(ticks_per_ms);
        let starting_alpha = self
            .runtime
            .with_stack(|stack| {
                stack
                    .get(GraphicsPlane::Background, BG_PLANE_SLOT)
                    .map(|object| object.alpha.0)
            })
            .unwrap_or(GraphicsAlpha::OPAQUE.0);
        let target_alpha_u8 = clamp_byte(target_alpha);
        let id = self.runtime.next_longop_id();
        let long = FadeLongOp::new(id, starting_alpha, target_alpha_u8, total_ticks);
        let longop = long.into_longop();
        // Side-effect the runtime so audit tooling can pin the "fade
        // was scheduled" observation without going through the queue.
        self.runtime
            .record_fade_scheduled(starting_alpha, target_alpha_u8, total_ticks);
        DispatchOutcome::Yield {
            longop_id: longop.id,
            private_state: longop.private_state,
        }
    }
}

/// `grp.stretchBlit(int src_slot, int dst_slot, int dst_w, int dst_h)`
/// — copy the source slot to the destination and apply a typed scale.
#[derive(Debug)]
pub struct GrpStretchBlitOp {
    runtime: Arc<GraphicsRuntime>,
}

impl GrpStretchBlitOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for GrpStretchBlitOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_src = match arg_int(args, 0, "src_slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::StretchBlit, warning),
        };
        let raw_dst = match arg_int(args, 1, "dst_slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::StretchBlit, warning),
        };
        let dst_w = match arg_int(args, 2, "dst_w") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::StretchBlit, warning),
        };
        let dst_h = match arg_int(args, 3, "dst_h") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::StretchBlit, warning),
        };
        let src = match slot_index(raw_src) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::StretchBlit, warning),
        };
        let dst = match slot_index(raw_dst) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::StretchBlit, warning),
        };
        let copied = self.runtime.with_stack_mut(|stack| {
            let source = stack.get(GraphicsPlane::Foreground, src).cloned();
            if let Some(mut object) = source {
                // Derive a thousandth-scale from the destination size.
                // The reference (1000-thousandth = identity) is the
                // source's own bounding box — at UTSUSHI-215 we do not
                // store source pixel dimensions on the object (those
                // land with the g00-decode wiring), so we treat the
                // raw destination size as the new thousandth scale and
                // record the requested target dimensions on the
                // runtime for audit.
                object.scale = crate::graphics_objects::GraphicsScale {
                    x_thousandths: dst_w.max(0),
                    y_thousandths: dst_h.max(0),
                };
                let _ = stack.set(GraphicsPlane::Foreground, dst, object);
                true
            } else {
                false
            }
        });
        if !copied {
            self.runtime.push_warning(
                GraphicsRuntimeWarning::CopyFromEmptySlot { slot: src }
                    .with_opcode(GrpOpcode::StretchBlit.as_str()),
            );
        }
        DispatchOutcome::Advance
    }
}

/// `grp.zoom(int slot, int scale_thousandths)` — uniform scale.
#[derive(Debug)]
pub struct GrpZoomOp {
    runtime: Arc<GraphicsRuntime>,
}

impl GrpZoomOp {
    pub fn new(runtime: Arc<GraphicsRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for GrpZoomOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let raw_slot = match arg_int(args, 0, "slot") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Zoom, warning),
        };
        let scale = match arg_int(args, 1, "scale_thousandths") {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Zoom, warning),
        };
        let slot = match slot_index(raw_slot) {
            Ok(value) => value,
            Err(warning) => return fail(&self.runtime, GrpOpcode::Zoom, warning),
        };
        let observed = self.runtime.with_stack_mut(|stack| {
            if let Some(object) = stack.get_mut(GraphicsPlane::Foreground, slot) {
                object.scale = crate::graphics_objects::GraphicsScale {
                    x_thousandths: scale,
                    y_thousandths: scale,
                };
                true
            } else {
                false
            }
        });
        if !observed {
            self.runtime.push_warning(
                GraphicsRuntimeWarning::OperateOnEmptySlot { slot }
                    .with_opcode(GrpOpcode::Zoom.as_str()),
            );
        }
        DispatchOutcome::Advance
    }
}

// ---- registry helper -------------------------------------------------

/// Mount every `module_grp` op this module ships into `registry`.
pub fn register_grp_rlops(registry: &mut RlopRegistry, runtime: Arc<GraphicsRuntime>) -> usize {
    let mut count = 0;
    let mut register = |key: RlopKey, op: Arc<dyn RLOperation>| {
        registry.register(key, op);
        count += 1;
    };
    register(
        GrpOpcode::AllocDc.rlop_key(),
        Arc::new(GrpAllocDcOp::new(Arc::clone(&runtime))),
    );
    register(
        GrpOpcode::Wipe.rlop_key(),
        Arc::new(GrpWipeOp::new(Arc::clone(&runtime))),
    );
    register(
        GrpOpcode::Shake.rlop_key(),
        Arc::new(GrpShakeOp::new(Arc::clone(&runtime))),
    );
    register(
        GrpOpcode::Load.rlop_key(),
        Arc::new(GrpLoadOp::new(Arc::clone(&runtime))),
    );
    register(
        GrpOpcode::Open.rlop_key(),
        Arc::new(GrpLoadOp::new_as_open(Arc::clone(&runtime))),
    );
    register(
        GrpOpcode::OpenBg.rlop_key(),
        Arc::new(GrpOpenBgOp::new(Arc::clone(&runtime))),
    );
    register(
        GrpOpcode::Copy.rlop_key(),
        Arc::new(GrpCopyOp::new(Arc::clone(&runtime))),
    );
    register(
        GrpOpcode::Fill.rlop_key(),
        Arc::new(GrpWipeOp::new_as_fill(Arc::clone(&runtime))),
    );
    register(
        GrpOpcode::Invert.rlop_key(),
        Arc::new(GrpInvertOp::new(Arc::clone(&runtime))),
    );
    register(
        GrpOpcode::Mono.rlop_key(),
        Arc::new(GrpMonoOp::new(Arc::clone(&runtime))),
    );
    register(
        GrpOpcode::Colour.rlop_key(),
        Arc::new(GrpColourOp::new(Arc::clone(&runtime))),
    );
    register(
        GrpOpcode::Light.rlop_key(),
        Arc::new(GrpLightOp::new(Arc::clone(&runtime))),
    );
    register(
        GrpOpcode::Fade.rlop_key(),
        Arc::new(GrpFadeOp::new(Arc::clone(&runtime))),
    );
    register(
        GrpOpcode::StretchBlit.rlop_key(),
        Arc::new(GrpStretchBlitOp::new(Arc::clone(&runtime))),
    );
    register(
        GrpOpcode::Zoom.rlop_key(),
        Arc::new(GrpZoomOp::new(Arc::clone(&runtime))),
    );
    let _ = LongOpId(0); // Reference touch so the import stays load-bearing.
    let _ = DEFAULT_FADE_TICKS_PER_MS; // Audit anchor for the fade tick rate.
    count
}

// ---- tests -----------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::GraphicsObjectKind as Kind;
    use crate::rlop::module_obj::DEFAULT_FADE_TICKS_PER_MS;

    fn runtime() -> Arc<GraphicsRuntime> {
        Arc::new(GraphicsRuntime::new())
    }

    fn vm() -> Vm {
        Vm::new(1, 0)
    }

    fn int(value: i32) -> ExprValue {
        ExprValue::Int(value)
    }

    fn bytes(value: &[u8]) -> ExprValue {
        ExprValue::Bytes(value.to_vec())
    }

    #[test]
    fn grp_opcode_byte_values_are_distinct() {
        let mut seen = std::collections::HashSet::new();
        for op in GrpOpcode::ALL {
            assert!(seen.insert(op.opcode()), "duplicate opcode for {op:?}");
        }
    }

    #[test]
    fn grp_register_helper_populates_expected_count() {
        let mut registry = RlopRegistry::new();
        let count = register_grp_rlops(&mut registry, runtime());
        assert_eq!(count, GRP_RLOP_COUNT);
        assert_eq!(count, 15);
        for op in GrpOpcode::ALL {
            assert!(registry.get(op.rlop_key()).is_some(), "{op:?} resolves");
        }
    }

    #[test]
    fn grp_alloc_dc_mutates_observable_stack_snapshot() {
        let runtime = runtime();
        let op = GrpAllocDcOp::new(Arc::clone(&runtime));
        let snapshot_before = runtime.state_snapshot();
        assert_eq!(snapshot_before.allocated_slot_count(), 0);
        let outcome = op.dispatch(&mut vm(), &[int(3), int(640), int(480)]);
        assert!(matches!(outcome, DispatchOutcome::Advance));
        let snapshot_after = runtime.state_snapshot();
        assert_eq!(snapshot_after.allocated_slot_count(), 1);
        let dc = snapshot_after.dc_allocation(3).expect("dc allocation 3");
        assert_eq!(dc.width, 640);
        assert_eq!(dc.height, 480);
    }

    #[test]
    fn grp_wipe_records_opaque_rgb_on_foreground_slot() {
        let runtime = runtime();
        let op = GrpWipeOp::new(Arc::clone(&runtime));
        op.dispatch(&mut vm(), &[int(0), int(0x12), int(0x34), int(0x56)]);
        let snapshot = runtime.state_snapshot();
        let object = snapshot
            .foreground_slot(0)
            .expect("fg slot 0 must be allocated");
        match &object.kind {
            Kind::Wipe { colour } => {
                assert_eq!(colour.red, 0x12);
                assert_eq!(colour.green, 0x34);
                assert_eq!(colour.blue, 0x56);
                assert_eq!(colour.alpha, 0xFF);
            }
            other @ Kind::Image { .. } => panic!("expected Wipe, got {other:?}"),
        }
    }

    #[test]
    fn grp_fill_alias_dispatches_with_same_semantics_as_wipe() {
        let runtime = runtime();
        let op = GrpWipeOp::new_as_fill(Arc::clone(&runtime));
        op.dispatch(&mut vm(), &[int(2), int(10), int(20), int(30)]);
        let snapshot = runtime.state_snapshot();
        let obj = snapshot.foreground_slot(2).expect("slot 2 allocated");
        match &obj.kind {
            Kind::Wipe { colour } => {
                assert_eq!((colour.red, colour.green, colour.blue), (10, 20, 30));
            }
            other @ Kind::Image { .. } => panic!("expected Wipe, got {other:?}"),
        }
    }

    #[test]
    fn grp_shake_records_amplitude_on_snapshot() {
        let runtime = runtime();
        let op = GrpShakeOp::new(Arc::clone(&runtime));
        op.dispatch(&mut vm(), &[int(8)]);
        assert_eq!(runtime.state_snapshot().shake_amplitude_px, 8);
    }

    #[test]
    fn grp_load_records_image_ref_on_foreground_slot() {
        let runtime = runtime();
        let op = GrpLoadOp::new(Arc::clone(&runtime));
        op.dispatch(&mut vm(), &[int(7), bytes(b"SPRITE1")]);
        let snapshot = runtime.state_snapshot();
        let obj = snapshot.foreground_slot(7).expect("slot 7 allocated");
        match &obj.kind {
            Kind::Image { image_ref } => assert_eq!(image_ref.asset_key, "SPRITE1"),
            other @ Kind::Wipe { .. } => panic!("expected Image, got {other:?}"),
        }
    }

    #[test]
    fn grp_load_rejects_empty_asset_name_with_typed_warning() {
        let runtime = runtime();
        let op = GrpLoadOp::new(Arc::clone(&runtime));
        op.dispatch(&mut vm(), &[int(0), bytes(b"")]);
        let warnings = runtime.take_warnings();
        assert!(
            warnings
                .iter()
                .any(|w| matches!(w, GraphicsRuntimeWarning::EmptyAssetName)),
            "empty asset name must surface typed warning, got {warnings:?}",
        );
    }

    #[test]
    fn grp_load_rejects_slot_out_of_range_with_typed_warning() {
        let runtime = runtime();
        let op = GrpLoadOp::new(Arc::clone(&runtime));
        op.dispatch(&mut vm(), &[int(999), bytes(b"X")]);
        let warnings = runtime.take_warnings();
        assert!(
            warnings
                .iter()
                .any(|w| matches!(w, GraphicsRuntimeWarning::SlotOutOfRange { slot: 999 }))
        );
    }

    #[test]
    fn grp_open_bg_registers_bg_plane_without_vfs() {
        let runtime = runtime();
        let op = GrpOpenBgOp::new(Arc::clone(&runtime));
        op.dispatch(&mut vm(), &[bytes(b"BG01A1")]);
        let snapshot = runtime.state_snapshot();
        let object = snapshot
            .background_slot(BG_PLANE_SLOT)
            .expect("bg plane slot 0 registered");
        match &object.kind {
            Kind::Image { image_ref } => assert_eq!(image_ref.asset_key, "BG01A1"),
            other @ Kind::Wipe { .. } => panic!("expected Image, got {other:?}"),
        }
        assert_eq!(
            snapshot.bg_canvas.as_ref().map(|c| c.asset_key.as_str()),
            Some("BG01A1"),
        );
        // Without an asset package set, the canvas dimensions remain
        // unknown so the audit surface can pin the gap.
        assert_eq!(snapshot.bg_canvas.unwrap().dimensions, None);
    }

    #[test]
    fn grp_copy_clones_source_into_destination_slot() {
        let runtime = runtime();
        GrpLoadOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(1), bytes(b"ASSET")]);
        GrpCopyOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(1), int(2)]);
        let snap = runtime.state_snapshot();
        assert!(snap.foreground_slot(1).is_some());
        let dst = snap.foreground_slot(2).expect("slot 2 populated");
        match &dst.kind {
            Kind::Image { image_ref } => assert_eq!(image_ref.asset_key, "ASSET"),
            other @ Kind::Wipe { .. } => panic!("expected Image, got {other:?}"),
        }
    }

    #[test]
    fn grp_copy_from_empty_slot_records_typed_warning() {
        let runtime = runtime();
        GrpCopyOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0), int(1)]);
        let warnings = runtime.take_warnings();
        assert!(
            warnings
                .iter()
                .any(|w| matches!(w, GraphicsRuntimeWarning::CopyFromEmptySlot { slot: 0 }))
        );
    }

    #[test]
    fn grp_invert_flips_colour_tone_sign() {
        let runtime = runtime();
        GrpLoadOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0), bytes(b"A")]);
        runtime.with_stack_mut(|stack| {
            let object = stack
                .get_mut(GraphicsPlane::Foreground, 0)
                .expect("slot 0 allocated");
            object.colour_tone = GraphicsColourTone {
                red_thousandths: 100,
                green_thousandths: -200,
                blue_thousandths: 300,
            };
        });
        GrpInvertOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0)]);
        let snap = runtime.state_snapshot();
        let object = snap.foreground_slot(0).expect("slot 0 allocated");
        assert_eq!(object.colour_tone.red_thousandths, -100);
        assert_eq!(object.colour_tone.green_thousandths, 200);
        assert_eq!(object.colour_tone.blue_thousandths, -300);
    }

    #[test]
    fn grp_mono_sets_uniform_negative_tone() {
        let runtime = runtime();
        GrpLoadOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0), bytes(b"A")]);
        GrpMonoOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0)]);
        let snap = runtime.state_snapshot();
        let object = snap.foreground_slot(0).expect("slot allocated");
        assert_eq!(
            object.colour_tone,
            GraphicsColourTone {
                red_thousandths: -1000,
                green_thousandths: -1000,
                blue_thousandths: -1000,
            }
        );
    }

    #[test]
    fn grp_colour_clamps_into_thousandth_range() {
        let runtime = runtime();
        GrpLoadOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0), bytes(b"A")]);
        GrpColourOp::new(Arc::clone(&runtime))
            .dispatch(&mut vm(), &[int(0), int(5000), int(-5000), int(700)]);
        let snap = runtime.state_snapshot();
        let object = snap.foreground_slot(0).expect("slot allocated");
        assert_eq!(object.colour_tone.red_thousandths, 1000);
        assert_eq!(object.colour_tone.green_thousandths, -1000);
        assert_eq!(object.colour_tone.blue_thousandths, 700);
    }

    #[test]
    fn grp_light_sets_uniform_tone() {
        let runtime = runtime();
        GrpLoadOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0), bytes(b"A")]);
        GrpLightOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0), int(250)]);
        let snap = runtime.state_snapshot();
        let object = snap.foreground_slot(0).expect("slot allocated");
        assert_eq!(object.colour_tone.red_thousandths, 250);
        assert_eq!(object.colour_tone.green_thousandths, 250);
        assert_eq!(object.colour_tone.blue_thousandths, 250);
    }

    #[test]
    fn grp_fade_yields_typed_longop_payload() {
        let runtime = runtime();
        // Pre-register a bg plane object so the fade has a starting
        // alpha to read.
        runtime.with_stack_mut(|stack| {
            let mut object = GraphicsObject::wipe(WipeColour::BLACK);
            object.alpha = GraphicsAlpha::OPAQUE;
            stack
                .set(GraphicsPlane::Background, BG_PLANE_SLOT, object)
                .expect("set bg");
        });
        let op = GrpFadeOp::new(Arc::clone(&runtime));
        let outcome = op.dispatch(&mut vm(), &[int(0), int(500)]);
        match outcome {
            DispatchOutcome::Yield {
                longop_id,
                private_state,
            } => {
                let decoded = FadeLongOp::try_from_payload(longop_id, &private_state)
                    .expect("payload decodes");
                assert_eq!(decoded.starting_alpha(), 255);
                assert_eq!(decoded.target_alpha(), 0);
                let expected_ticks = 500u64 * DEFAULT_FADE_TICKS_PER_MS;
                assert_eq!(decoded.total_ticks(), expected_ticks);
            }
            other => panic!("expected Yield, got {other:?}"),
        }
        let snap = runtime.state_snapshot();
        let scheduled = snap.fade_scheduled.expect("fade recorded on snapshot");
        assert_eq!(scheduled.target_alpha, 0);
    }

    #[test]
    fn grp_fade_rejects_negative_duration_with_typed_warning() {
        let runtime = runtime();
        let op = GrpFadeOp::new(Arc::clone(&runtime));
        let outcome = op.dispatch(&mut vm(), &[int(0), int(-10)]);
        assert!(matches!(outcome, DispatchOutcome::Advance));
        let warnings = runtime.take_warnings();
        assert!(warnings.iter().any(|w| matches!(
            w,
            GraphicsRuntimeWarning::NegativeFadeDuration { duration_ms: -10 }
        )));
    }

    #[test]
    fn grp_stretch_blit_copies_and_applies_destination_scale() {
        let runtime = runtime();
        GrpLoadOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0), bytes(b"A")]);
        GrpStretchBlitOp::new(Arc::clone(&runtime))
            .dispatch(&mut vm(), &[int(0), int(1), int(640), int(360)]);
        let snap = runtime.state_snapshot();
        let dst = snap.foreground_slot(1).expect("destination allocated");
        assert_eq!(dst.scale.x_thousandths, 640);
        assert_eq!(dst.scale.y_thousandths, 360);
    }

    #[test]
    fn grp_zoom_applies_uniform_scale() {
        let runtime = runtime();
        GrpLoadOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0), bytes(b"A")]);
        GrpZoomOp::new(Arc::clone(&runtime)).dispatch(&mut vm(), &[int(0), int(1500)]);
        let snap = runtime.state_snapshot();
        let obj = snap.foreground_slot(0).expect("slot allocated");
        assert_eq!(obj.scale.x_thousandths, 1500);
        assert_eq!(obj.scale.y_thousandths, 1500);
    }
}
