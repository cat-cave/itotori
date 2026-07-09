//! `utsushi-reallive-render-opcode-semantics` — REAL-numbered RealLive
//! graphics / object render opcodes.
//!
//! # Why this module exists
//!
//! The earlier `module_grp` / `module_obj` tables implemented graphics
//! semantics under SYNTHETIC opcode numbers (`grp.allocDC = 1`, …) that
//! never occur on real bytes. On the proven corpora (Sweetie HD + Kanon)
//! the real RealLive opcode numbers (rlvm's `module_grp` at `15/16/31/32/
//! 70/72/73/…` and the object modules at `1000/1003/1004/1026/1039/…`)
//! were caught by the [`crate::rlop::module_catalog`] `Advance` gap-fill,
//! so they PARSED but never mutated render state — a faithful frame could
//! not be produced.
//!
//! This module gives those REAL opcode numbers REAL render semantics,
//! re-derived from the rlvm research anchor (`module_grp.cc`,
//! `module_obj_creation.cc`, `module_obj_fg_bg.cc`,
//! `module_obj_management.cc`, `object_module.cc`) — the LOGIC is
//! re-implemented, no source is vendored. Each op mutates the shared
//! [`GraphicsRuntime`] (the [`crate::GraphicsObjectStack`] +
//! side-tables) so a composited frame reflects it.
//!
//! # Opcode numbering (rlvm-anchored)
//!
//! - `module_grp` = `module_id 33` (rlvm `GrpModule("Grp", 1, 33)`).
//!   `allocDC=15, FreeDC=16, wipe=31, shake=32, grpBuffer=70,
//!   grpMaskBuffer=71, grpDisplay=72, grpOpenBg=73, grpMaskOpen=74,
//!   grpMulti=75/77, grpOpen=76, grpCopy=100, grpMaskCopy=101,
//!   grpFill=201, grpInvert=300, grpMono=301, grpColour=302, grpLight=303,
//!   grpFade=403`. `rec*` = the same ops on the `REC` coordinate space at
//!   `1050+` (`recOpenBg=1053, recOpen=1056, recCopy=1100, recFill=1201`).
//! - object CREATION = `module_id 71` (ObjFg) / `72` (ObjBg):
//!   `objOfFile=1000, objOfFileGan=1003, objOfArea=1100, objOfRect=1101,
//!   objOfText=1200, objDriftOfFile=1300, objOfDigits=1400,
//!   objOfChild=1500`.
//! - object SETTERS = `module_id 81` (ObjFg) / `82` (ObjBg) / `90`,`91`
//!   (range). rlvm's `object_module.cc` maps a base id `n` to opcode
//!   `1000+n` (`Move=1000, Left=1001, Top=1002, Alpha=1003, Mono=1009,
//!   Invert=1010, Light=1011, Layer=1026, PattNo=1039, Scale=1046, …`) plus
//!   the `addObjectFunctions` block (`objShow=1004, objTint=1012,
//!   objColour=1016, objButtonOpts=1064, objEveDisplay=2004`).
//! - object MANAGEMENT = `module_id 60`/`61`(fg)/`62`(bg):
//!   `objFree=0, objInit=10, objFreeInit=11, objFreeAll=100,
//!   objInitAll=110, objFreeInitAll=111` (+ `objCopyFgToBg=2` on `60`).
//!
//! # Lattice-type registration
//!
//! On the real bytes the SAME semantic op appears under more than one
//! `module_type` (Sweetie HD's object setters carry `module_type=2`;
//! Kanon's carry `module_type=1`). Like [`crate::rlop::module_catalog`],
//! every op here is registered under all three observed lattice types
//! `{0, 1, 2}` so it fires regardless of the compiler-version artifact.
//!
//! # Three-layer render model
//!
//! rlvm exposes three composited layers — the graphic DCs, the background
//! object namespace, and the foreground object namespace. This crate's
//! [`crate::GraphicsObjectStack`] models those as distinct
//! [`crate::GraphicsLayer`] values:
//!
//! - **DC graphics** (`module_grp`) → `DisplayCommand`, slot = `dc`.
//!   `DC0` (slot 0) is the on-screen background; `openBg`/`open`/`display`
//!   target it. `grpBuffer` loads to an off-screen `dc` slot marked
//!   `visible = false`; `grpDisplay(dc)` copies that buffer onto `DC0`.
//! - **background objects** (`ObjBg`) → `BackgroundObject`, slot = `buf`.
//! - **foreground objects** (`ObjFg`) → `ForegroundObject`, slot = `buf`.
//!
//! Same-number bg and fg object slots now coexist and composite in rlvm
//! order: DCs, then bg objects, then fg objects.

use std::sync::Arc;

use super::module_obj::{FadeLongOp, GraphicsRuntime, GraphicsRuntimeWarning};
use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::graphics_objects::{
    GraphicsAlpha, GraphicsColourTone, GraphicsLayer, GraphicsObject, GraphicsObjectKind,
    GraphicsPlane, GraphicsScale, WipeColour,
};
use crate::vm::Vm;

// ---- module addressing -----------------------------------------------

/// `module_id` of `module_grp` (graphic DC / background ops).
pub const GRP_MODULE_ID: u8 = 33;
/// `module_id` of the ObjFg CREATION module.
pub const OBJ_FG_CREATION_ID: u8 = 71;
/// `module_id` of the ObjBg CREATION module.
pub const OBJ_BG_CREATION_ID: u8 = 72;
/// `module_id` of the ObjFg SETTER module.
pub const OBJ_FG_SETTER_ID: u8 = 81;
/// `module_id` of the ObjBg SETTER module.
pub const OBJ_BG_SETTER_ID: u8 = 82;
/// `module_id` of the ObjRangeFg SETTER module.
pub const OBJ_FG_RANGE_ID: u8 = 90;
/// `module_id` of the ObjRangeBg SETTER module.
pub const OBJ_BG_RANGE_ID: u8 = 91;
/// `module_id` of the generic ObjManagement module.
pub const OBJ_MGMT_ID: u8 = 60;
/// `module_id` of the ObjFgManagement module.
pub const OBJ_FG_MGMT_ID: u8 = 61;
/// `module_id` of the ObjBgManagement module.
pub const OBJ_BG_MGMT_ID: u8 = 62;

/// The three lattice `module_type` bytes every render op is registered
/// under (the compiler-version artifact; `module_id` is the real key).
const LATTICE_TYPES: [u8; 3] = [0, 1, 2];

/// On-screen DC slot (rlvm `DC0`). `openBg` / `open` / `display` land here.
pub const SCREEN_DC_SLOT: usize = 0;

/// Layer-order base for bg-namespace objects (paint below fg objects).
pub const OBJ_BG_LAYER_BASE: i32 = 0;
/// Layer-order base for fg-namespace objects (paint above bg objects).
pub const OBJ_FG_LAYER_BASE: i32 = 1_000_000;

/// Documented render gaps (per the strict-proof "no silent stub" bar).
/// Each entry names a real opcode family whose semantics are only
/// PARTIALLY modelled (or intentionally a no-op) and why. These are
/// tracked here, NOT silently advanced.
pub const RENDER_GAPS: &[(&str, &str)] = &[
    (
        "grp.stretchBlit(401/409) / grp.zoom(402)",
        "rectangle-space blits: the src/dst Rect_T geometry is not modelled; \
         the destination slot receives the source image + a whole-object scale only.",
    ),
    (
        "grp.multi(75/77/1055/1057)",
        "the trailing variable-length MultiCommand overlay list is not decoded; \
         the base image is loaded to DC0, overlays are dropped.",
    ),
    (
        "obj.objOfText(1200) / objOfDigits(1400) / objDriftOfFile(1300) / objOfFileGan(1003)",
        "text / digit / drift / gan object DATA is not rendered; the object is \
         created as an image placeholder carrying the source string/asset key.",
    ),
    (
        "obj.objEveDisplay(2004) + Eve* mutators (3004 check / 4004 wait / …)",
        "animated (time-interpolated) mutators apply their FINAL value immediately; \
         the per-tick interpolation + wait scheduling is not modelled.",
    ),
    (
        "obj range setters (module 90/91)",
        "a range op applies to the FIRST buffer of the range only; the \
         MappedRLModule (first,last) fan-out is not expanded.",
    ),
    (
        "obj.objAdjust(1006) / objDispRect(1034) / objTextOpts / objNumOpts / objDriftOpts",
        "adjustment-slot / clip-rect / text-layout / num-layout / drift options are \
         recorded as a position or ignored; the fine geometry is not modelled.",
    ),
    (
        "scr(30/31) screen refresh + grp effect(40)",
        "screen-refresh and weather-effect triggers are intentional no-ops: this \
         headless model re-rasterises the whole stack on demand, so an explicit \
         refresh has no state to mutate. Left to the catalog Advance.",
    ),
];

/// Pixel-diff posture for rlvm PNG comparison.
///
/// This node validates the 3-layer object model through render-state and
/// replay-oracle evidence. It does NOT claim a numeric pixel-diff
/// tolerance against rlvm PNGs yet: any non-zero full-fidelity PNG diff
/// against an rlvm reference frame remains a render fidelity gap until a
/// dedicated pixel oracle lands.
pub const RLVM_PIXEL_DIFF_TOLERANCE: &str =
    "not claimed; non-zero full-fidelity rlvm PNG diffs remain a render gap";

fn object_layer(plane: GraphicsPlane) -> GraphicsLayer {
    match plane {
        GraphicsPlane::Background => GraphicsLayer::BackgroundObject,
        GraphicsPlane::Foreground => GraphicsLayer::ForegroundObject,
    }
}

// ---- argument helpers ------------------------------------------------

fn arg_int(args: &[ExprValue], at: usize) -> Option<i32> {
    args.get(at).and_then(ExprValue::as_int)
}

fn arg_bytes(args: &[ExprValue], at: usize) -> Option<&[u8]> {
    args.get(at).and_then(ExprValue::as_bytes)
}

fn clamp_byte(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

fn slot_ok(value: i32) -> Option<usize> {
    (0..256).contains(&value).then_some(value as usize)
}

fn decode_shift_jis(bytes: &[u8]) -> Option<String> {
    let (cow, _, had_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
    if had_errors {
        return None;
    }
    Some(cow.trim_end_matches('\0').to_string())
}

fn warn(runtime: &GraphicsRuntime, tag: &'static str, slot: usize) {
    runtime.push_warning(GraphicsRuntimeWarning::OperateOnEmptySlot { slot }.with_opcode(tag));
}

// ======================================================================
// module_grp — DC / background graphics (module_id 33)
// ======================================================================

/// The `module_grp` opcodes this module implements with real numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrpOp {
    AllocDc,
    FreeDc,
    Wipe,
    Shake,
    /// `grpBuffer`/`grpMaskBuffer`: load an image into an OFF-SCREEN dc.
    Buffer,
    /// `grpDisplay`: copy an off-screen dc onto the screen (DC0).
    Display,
    /// `grpOpenBg`/`grpOpen`/`grpMaskOpen`/`recOpenBg`/`recOpen`: load an
    /// image straight onto the screen (DC0).
    OpenScreen,
    /// `grpMulti`: load the base image to DC0 (overlays are a gap).
    Multi,
    Copy,
    Fill,
    Invert,
    Mono,
    Colour,
    Light,
    Fade,
}

impl GrpOp {
    fn tag(self) -> &'static str {
        match self {
            Self::AllocDc => "grp.allocDC",
            Self::FreeDc => "grp.freeDC",
            Self::Wipe => "grp.wipe",
            Self::Shake => "grp.shake",
            Self::Buffer => "grp.buffer",
            Self::Display => "grp.display",
            Self::OpenScreen => "grp.open",
            Self::Multi => "grp.multi",
            Self::Copy => "grp.copy",
            Self::Fill => "grp.fill",
            Self::Invert => "grp.invert",
            Self::Mono => "grp.mono",
            Self::Colour => "grp.colour",
            Self::Light => "grp.light",
            Self::Fade => "grp.fade",
        }
    }
}

/// A `module_grp` render op bound to a shared [`GraphicsRuntime`].
#[derive(Debug)]
pub struct GrpRenderOp {
    runtime: Arc<GraphicsRuntime>,
    op: GrpOp,
}

impl GrpRenderOp {
    pub fn new(runtime: Arc<GraphicsRuntime>, op: GrpOp) -> Self {
        Self { runtime, op }
    }

    fn load_image_to(&self, args: &[ExprValue], slot: usize, visible: bool) -> DispatchOutcome {
        // rlvm {grp,rec}(Mask)?(Load|Buffer|Open|OpenBg) take a
        // StrConstant_T FILENAME first. `???` means "keep current" in
        // rlvm; we skip the load on that sentinel.
        let Some(raw) = arg_bytes(args, 0) else {
            self.runtime
                .push_warning(GraphicsRuntimeWarning::MissingArg {
                    opcode_tag: self.op.tag(),
                    slot: "filename",
                });
            return DispatchOutcome::Advance;
        };
        let name = match decode_shift_jis(raw) {
            Some(n) if !n.is_empty() && n != "???" => n,
            Some(_) => {
                // Empty / "???" filename: no image to load; not an error.
                return DispatchOutcome::Advance;
            }
            None => {
                self.runtime.push_warning(
                    GraphicsRuntimeWarning::InvalidShiftJis { opcode_tag: "" }
                        .with_opcode(self.op.tag()),
                );
                return DispatchOutcome::Advance;
            }
        };
        self.runtime.with_stack_mut(|stack| {
            let mut object = GraphicsObject::image(name.clone());
            object.visible = visible;
            let _ = stack.set_layer(GraphicsLayer::DisplayCommand, slot, object);
        });
        // For the on-screen background (DC0), resolve+decode the g00 through
        // the substrate VFS (when bound) so the audit surface pins the real
        // canvas size; fall back to asset-key-only when no package is set.
        // The opcode_tag is passed through so any G00PayloadWarning
        // surfaced by the dims-probe carries the dispatch op's name in
        // its audit trail (instead of an empty tag).
        if slot == SCREEN_DC_SLOT {
            match self.runtime.read_g00_through_vfs(&name, self.op.tag()) {
                Ok(Some((w, h))) => self.runtime.record_bg_canvas(&name, w, h),
                Ok(None) => self.runtime.record_bg_asset_only(&name),
                Err(warning) => self
                    .runtime
                    .push_warning(warning.with_opcode(self.op.tag())),
            }
        }
        DispatchOutcome::Advance
    }
}

impl RLOperation for GrpRenderOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        match self.op {
            GrpOp::AllocDc => {
                // allocDC(dc, width, height).
                let (Some(dc), Some(w), Some(h)) =
                    (arg_int(args, 0), arg_int(args, 1), arg_int(args, 2))
                else {
                    return DispatchOutcome::Advance;
                };
                if let Some(slot) = slot_ok(dc) {
                    self.runtime
                        .set_dc_allocation(slot, w.max(0) as u32, h.max(0) as u32);
                    self.runtime.with_stack_mut(|stack| {
                        let mut o = GraphicsObject::wipe(WipeColour::TRANSPARENT);
                        o.visible = slot == SCREEN_DC_SLOT;
                        let _ = stack.set_layer(GraphicsLayer::DisplayCommand, slot, o);
                    });
                }
                DispatchOutcome::Advance
            }
            GrpOp::FreeDc => {
                if let Some(slot) = arg_int(args, 0).and_then(slot_ok) {
                    self.runtime.with_stack_mut(|stack| {
                        stack.clear_layer(GraphicsLayer::DisplayCommand, slot).ok()
                    });
                }
                DispatchOutcome::Advance
            }
            GrpOp::Wipe | GrpOp::Fill => {
                // wipe(dc, r, g, b) / fill(dc, r, g, b [,a]).
                let Some(dc) = arg_int(args, 0).and_then(slot_ok) else {
                    return DispatchOutcome::Advance;
                };
                let r = arg_int(args, 1).unwrap_or(0);
                let g = arg_int(args, 2).unwrap_or(0);
                let b = arg_int(args, 3).unwrap_or(0);
                let colour = WipeColour::opaque_rgb(clamp_byte(r), clamp_byte(g), clamp_byte(b));
                self.runtime.with_stack_mut(|stack| {
                    let mut o = GraphicsObject::wipe(colour);
                    o.visible = dc == SCREEN_DC_SLOT;
                    let _ = stack.set_layer(GraphicsLayer::DisplayCommand, dc, o);
                });
                DispatchOutcome::Advance
            }
            GrpOp::Shake => {
                let spec = arg_int(args, 0).unwrap_or(0);
                self.runtime.set_shake_amplitude_px(spec.max(0) as u32);
                DispatchOutcome::Advance
            }
            GrpOp::Buffer => {
                // grpBuffer(filename, dc, opacity=255): off-screen.
                let dc = arg_int(args, 1).and_then(slot_ok).unwrap_or(1);
                let visible = dc == SCREEN_DC_SLOT;
                self.load_image_to(args, dc, visible)
            }
            GrpOp::OpenScreen => {
                // openBg(filename, effect): straight to DC0 (visible).
                self.load_image_to(args, SCREEN_DC_SLOT, true)
            }
            GrpOp::Multi => {
                // grpMulti(filename, ...): base image to DC0; overlays gap.
                self.load_image_to(args, SCREEN_DC_SLOT, true)
            }
            GrpOp::Display => {
                // grpDisplay(dc, effect): copy off-screen dc → DC0 (screen).
                let Some(dc) = arg_int(args, 0).and_then(slot_ok) else {
                    return DispatchOutcome::Advance;
                };
                let copied = self.runtime.with_stack_mut(|stack| {
                    if let Some(src) = stack.get_layer(GraphicsLayer::DisplayCommand, dc).cloned() {
                        let mut shown = src;
                        shown.visible = true;
                        let _ =
                            stack.set_layer(GraphicsLayer::DisplayCommand, SCREEN_DC_SLOT, shown);
                        true
                    } else {
                        false
                    }
                });
                if !copied {
                    warn(&self.runtime, self.op.tag(), dc);
                }
                DispatchOutcome::Advance
            }
            GrpOp::Copy => {
                // grpCopy(src_dc, dst_dc, opacity=255).
                let (Some(src), Some(dst)) = (
                    arg_int(args, 0).and_then(slot_ok),
                    arg_int(args, 1).and_then(slot_ok),
                ) else {
                    return DispatchOutcome::Advance;
                };
                let copied = self.runtime.with_stack_mut(|stack| {
                    if let Some(o) = stack.get_layer(GraphicsLayer::DisplayCommand, src).cloned() {
                        let _ = stack.set_layer(GraphicsLayer::DisplayCommand, dst, o);
                        true
                    } else {
                        false
                    }
                });
                if !copied {
                    self.runtime.push_warning(
                        GraphicsRuntimeWarning::CopyFromEmptySlot { slot: src }
                            .with_opcode(self.op.tag()),
                    );
                }
                DispatchOutcome::Advance
            }
            GrpOp::Invert | GrpOp::Mono | GrpOp::Colour | GrpOp::Light => {
                let Some(dc) = arg_int(args, 0).and_then(slot_ok) else {
                    return DispatchOutcome::Advance;
                };
                let tone = match self.op {
                    GrpOp::Invert => None, // sign-flip handled below
                    GrpOp::Mono => Some(GraphicsColourTone {
                        red_thousandths: -1000,
                        green_thousandths: -1000,
                        blue_thousandths: -1000,
                    }),
                    GrpOp::Colour => Some(GraphicsColourTone {
                        red_thousandths: arg_int(args, 1).unwrap_or(0).clamp(-1000, 1000),
                        green_thousandths: arg_int(args, 2).unwrap_or(0).clamp(-1000, 1000),
                        blue_thousandths: arg_int(args, 3).unwrap_or(0).clamp(-1000, 1000),
                    }),
                    GrpOp::Light => {
                        let l = arg_int(args, 1).unwrap_or(0).clamp(-1000, 1000);
                        Some(GraphicsColourTone {
                            red_thousandths: l,
                            green_thousandths: l,
                            blue_thousandths: l,
                        })
                    }
                    _ => unreachable!(),
                };
                let observed = self.runtime.with_stack_mut(|stack| {
                    if let Some(o) = stack.get_layer_mut(GraphicsLayer::DisplayCommand, dc) {
                        match tone {
                            Some(t) => o.colour_tone = t,
                            None => {
                                o.colour_tone = GraphicsColourTone {
                                    red_thousandths: -o.colour_tone.red_thousandths,
                                    green_thousandths: -o.colour_tone.green_thousandths,
                                    blue_thousandths: -o.colour_tone.blue_thousandths,
                                };
                            }
                        }
                        true
                    } else {
                        false
                    }
                });
                if !observed {
                    warn(&self.runtime, self.op.tag(), dc);
                }
                DispatchOutcome::Advance
            }
            GrpOp::Fade => {
                // grpFade(dc?, target_alpha?, ...) — fade DC0 to a target.
                // rlvm's fade family has many overloads; we schedule a fade
                // of the DC0 alpha towards a target (the common visible
                // effect). arg 0 may be a DC or an RGB depending on
                // overload; we treat a trailing int as the duration.
                let target_alpha = arg_int(args, 0).map_or(0, clamp_byte);
                let duration_ms = args
                    .iter()
                    .rev()
                    .find_map(ExprValue::as_int)
                    .unwrap_or(0)
                    .max(0);
                let ticks_per_ms = self.runtime.fade_ticks_per_ms();
                let total_ticks = (duration_ms as u64).saturating_mul(ticks_per_ms);
                let starting_alpha = self
                    .runtime
                    .with_stack(|stack| {
                        stack
                            .get_layer(GraphicsLayer::DisplayCommand, SCREEN_DC_SLOT)
                            .map(|o| o.alpha.0)
                    })
                    .unwrap_or(GraphicsAlpha::OPAQUE.0);
                let id = self.runtime.next_longop_id();
                let long = FadeLongOp::new(id, starting_alpha, target_alpha, total_ticks);
                let longop = long.into_longop();
                self.runtime
                    .record_fade_scheduled(starting_alpha, target_alpha, total_ticks);
                DispatchOutcome::Yield {
                    longop_id: longop.id,
                    private_state: longop.private_state,
                }
            }
        }
    }
}

// ======================================================================
// object creation — objOfFile & friends (module_id 71 fg / 72 bg)
// ======================================================================

/// Object CREATION op (`objOfFile` and the placeholder-modelled
/// text/digit/drift/gan/area/child variants). Loads an image into an
/// object slot on the op's plane, applying any trailing
/// `(visible, x, y, pattern)` args per rlvm's `objGeneric_*` templates.
#[derive(Debug)]
pub struct ObjCreateOp {
    runtime: Arc<GraphicsRuntime>,
    plane: GraphicsPlane,
}

impl ObjCreateOp {
    pub fn new(runtime: Arc<GraphicsRuntime>, plane: GraphicsPlane) -> Self {
        Self { runtime, plane }
    }

    fn layer_base(&self) -> i32 {
        match self.plane {
            GraphicsPlane::Foreground => OBJ_FG_LAYER_BASE,
            GraphicsPlane::Background => OBJ_BG_LAYER_BASE,
        }
    }
}

impl RLOperation for ObjCreateOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        // objGeneric_*: (buf, filename[, visible, x, y, pattern, …]).
        let Some(buf) = arg_int(args, 0).and_then(slot_ok) else {
            self.runtime
                .push_warning(GraphicsRuntimeWarning::MissingArg {
                    opcode_tag: "obj.objOfFile",
                    slot: "buf",
                });
            return DispatchOutcome::Advance;
        };
        let name = arg_bytes(args, 1)
            .and_then(decode_shift_jis)
            .filter(|n| !n.is_empty() && n != "???");
        let layer = object_layer(self.plane);
        let layer_base = self.layer_base();
        self.runtime.with_stack_mut(|stack| {
            // For every creation op (objOfFile and the placeholder-modelled
            // text/digit/drift/gan variants) the decoded arg-1 string is the
            // object's asset key; objOfText carries inline text there, which
            // this model records but does not rasterise (a documented gap).
            let mut object = GraphicsObject::image(name.unwrap_or_default());
            object.layer_order = layer_base + buf as i32;
            // Optional trailing (visible, x, y, pattern).
            if let Some(v) = arg_int(args, 2) {
                object.visible = v != 0;
            }
            if let (Some(x), Some(y)) = (arg_int(args, 3), arg_int(args, 4)) {
                object.position = crate::graphics_objects::GraphicsPosition { x, y };
            }
            if let (Some(pattern), GraphicsObjectKind::Image { image_ref }) =
                (arg_int(args, 5), &mut object.kind)
            {
                image_ref.region_index = Some(pattern.max(0) as u32);
            }
            let _ = stack.set_layer(layer, buf, object);
        });
        DispatchOutcome::Advance
    }
}

// ======================================================================
// object setters — Move / Alpha / Show / Layer / PattNo / tone / scale
// ======================================================================

/// The object-setter properties this module implements, keyed by rlvm's
/// `object_module.cc` base id (opcode = `1000 + base_id`) or the
/// `addObjectFunctions` block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjSetProp {
    /// `Move` (1000): (buf, x, y).
    Move,
    /// `Left` (1001): (buf, x).
    Left,
    /// `Top` (1002): (buf, y).
    Top,
    /// `Alpha` (1003): (buf, alpha).
    Alpha,
    /// `objShow` (1004) / `objEveDisplay` (2004): (buf, visible).
    Show,
    /// `Mono` (1009): (buf, level != 0 → desaturate).
    Mono,
    /// `Invert` (1010): (buf, level != 0 → invert tone).
    Invert,
    /// `Light` (1011): (buf, level).
    Light,
    /// `objTint` (1012): (buf, r, g, b).
    Tint,
    /// `objColour` (1016): (buf, r, g, b, level).
    Colour,
    /// `objLayer` (1026): (buf, z).
    Layer,
    /// `objPattNo` (1039): (buf, pattern).
    PattNo,
    /// `Scale` (1046): (buf, width‰, height‰).
    Scale,
    /// `Width` (1047): (buf, width‰).
    Width,
    /// `Height` (1048): (buf, height‰).
    Height,
    /// `Adjust` (1006): (buf, repno, x, y) — modelled as a position add.
    Adjust,
}

impl ObjSetProp {
    fn tag(self) -> &'static str {
        match self {
            Self::Move => "obj.move",
            Self::Left => "obj.left",
            Self::Top => "obj.top",
            Self::Alpha => "obj.alpha",
            Self::Show => "obj.show",
            Self::Mono => "obj.mono",
            Self::Invert => "obj.invert",
            Self::Light => "obj.light",
            Self::Tint => "obj.tint",
            Self::Colour => "obj.colour",
            Self::Layer => "obj.layer",
            Self::PattNo => "obj.pattNo",
            Self::Scale => "obj.scale",
            Self::Width => "obj.width",
            Self::Height => "obj.height",
            Self::Adjust => "obj.adjust",
        }
    }
}

/// An object-setter op bound to a plane + property.
#[derive(Debug)]
pub struct ObjSetOp {
    runtime: Arc<GraphicsRuntime>,
    prop: ObjSetProp,
    layer: GraphicsLayer,
    layer_base: i32,
}

impl ObjSetOp {
    pub fn new(runtime: Arc<GraphicsRuntime>, plane: GraphicsPlane, prop: ObjSetProp) -> Self {
        let layer_base = match plane {
            GraphicsPlane::Foreground => OBJ_FG_LAYER_BASE,
            GraphicsPlane::Background => OBJ_BG_LAYER_BASE,
        };
        Self {
            runtime,
            prop,
            layer: object_layer(plane),
            layer_base,
        }
    }
}

impl RLOperation for ObjSetOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let Some(buf) = arg_int(args, 0).and_then(slot_ok) else {
            return DispatchOutcome::Advance;
        };
        let prop = self.prop;
        let layer = self.layer;
        let layer_base = self.layer_base;
        let observed = self.runtime.with_stack_mut(|stack| {
            let Some(o) = stack.get_layer_mut(layer, buf) else {
                return false;
            };
            match prop {
                ObjSetProp::Move => {
                    o.position.x = arg_int(args, 1).unwrap_or(o.position.x);
                    o.position.y = arg_int(args, 2).unwrap_or(o.position.y);
                }
                ObjSetProp::Left => o.position.x = arg_int(args, 1).unwrap_or(o.position.x),
                ObjSetProp::Top => o.position.y = arg_int(args, 1).unwrap_or(o.position.y),
                ObjSetProp::Alpha => {
                    o.alpha = GraphicsAlpha(clamp_byte(arg_int(args, 1).unwrap_or(255)));
                }
                ObjSetProp::Show => o.visible = arg_int(args, 1).unwrap_or(1) != 0,
                ObjSetProp::Mono => {
                    let on = arg_int(args, 1).unwrap_or(0) != 0;
                    o.colour_tone = if on {
                        GraphicsColourTone {
                            red_thousandths: -1000,
                            green_thousandths: -1000,
                            blue_thousandths: -1000,
                        }
                    } else {
                        GraphicsColourTone::NEUTRAL
                    };
                }
                ObjSetProp::Invert => {
                    o.colour_tone = GraphicsColourTone {
                        red_thousandths: -o.colour_tone.red_thousandths,
                        green_thousandths: -o.colour_tone.green_thousandths,
                        blue_thousandths: -o.colour_tone.blue_thousandths,
                    };
                }
                ObjSetProp::Light => {
                    let l = arg_int(args, 1).unwrap_or(0).clamp(-1000, 1000);
                    o.colour_tone = GraphicsColourTone {
                        red_thousandths: l,
                        green_thousandths: l,
                        blue_thousandths: l,
                    };
                }
                // objTint (1012) and objColour (1016) both drive the object's
                // per-channel tone from (r, g, b); objColour's trailing level
                // arg is folded into the tone by the render pass (gap: level
                // weighting is applied as a plain tone here).
                ObjSetProp::Tint | ObjSetProp::Colour => {
                    o.colour_tone = GraphicsColourTone {
                        red_thousandths: arg_int(args, 1).unwrap_or(0).clamp(-1000, 1000),
                        green_thousandths: arg_int(args, 2).unwrap_or(0).clamp(-1000, 1000),
                        blue_thousandths: arg_int(args, 3).unwrap_or(0).clamp(-1000, 1000),
                    };
                }
                ObjSetProp::Layer => {
                    o.layer_order = layer_base + arg_int(args, 1).unwrap_or(0);
                }
                ObjSetProp::PattNo => {
                    if let GraphicsObjectKind::Image { image_ref } = &mut o.kind {
                        image_ref.region_index = Some(arg_int(args, 1).unwrap_or(0).max(0) as u32);
                    }
                }
                ObjSetProp::Scale => {
                    o.scale = GraphicsScale {
                        x_thousandths: arg_int(args, 1).unwrap_or(o.scale.x_thousandths),
                        y_thousandths: arg_int(args, 2).unwrap_or(o.scale.y_thousandths),
                    };
                }
                ObjSetProp::Width => o.scale.x_thousandths = arg_int(args, 1).unwrap_or(1000),
                ObjSetProp::Height => o.scale.y_thousandths = arg_int(args, 1).unwrap_or(1000),
                ObjSetProp::Adjust => {
                    // objAdjust(buf, repno, x, y): position add (gap: repno).
                    o.position.x += arg_int(args, 2).unwrap_or(0);
                    o.position.y += arg_int(args, 3).unwrap_or(0);
                }
            }
            true
        });
        if !observed {
            warn(&self.runtime, prop.tag(), buf);
        }
        DispatchOutcome::Advance
    }
}

// ======================================================================
// object management — Free / Init / FreeAll (module 60/61/62)
// ======================================================================

/// Object-management operations (per rlvm `module_obj_management.cc`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjMgmtOp {
    /// `objFree` (0): clear the buffer.
    Free,
    /// `objInit` (10): reset the buffer to a blank/default (modelled as clear).
    Init,
    /// `objFreeInit` (11): free + init (clear).
    FreeInit,
    /// `objFreeAll` (100) / `objInitAll` (110) / `objFreeInitAll` (111):
    /// clear every object on the plane.
    FreeAll,
    /// `objCopyFgToBg` (60:2): copy every fg object to the bg namespace.
    CopyFgToBg,
}

/// A management op bound to a plane.
#[derive(Debug)]
pub struct ObjMgmtRenderOp {
    runtime: Arc<GraphicsRuntime>,
    layer: Option<GraphicsLayer>,
    op: ObjMgmtOp,
}

impl ObjMgmtRenderOp {
    pub fn new(runtime: Arc<GraphicsRuntime>, op: ObjMgmtOp) -> Self {
        Self {
            runtime,
            layer: None,
            op,
        }
    }

    pub fn for_plane(runtime: Arc<GraphicsRuntime>, plane: GraphicsPlane, op: ObjMgmtOp) -> Self {
        Self {
            runtime,
            layer: Some(object_layer(plane)),
            op,
        }
    }

    fn target_layer(&self) -> GraphicsLayer {
        self.layer.unwrap_or(GraphicsLayer::ForegroundObject)
    }
}

impl RLOperation for ObjMgmtRenderOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        match self.op {
            ObjMgmtOp::Free | ObjMgmtOp::Init | ObjMgmtOp::FreeInit => {
                if let Some(buf) = arg_int(args, 0).and_then(slot_ok) {
                    let layer = self.target_layer();
                    self.runtime
                        .with_stack_mut(|stack| stack.clear_layer(layer, buf).ok());
                }
            }
            ObjMgmtOp::FreeAll => {
                let layer = self.target_layer();
                self.runtime.with_stack_mut(|stack| {
                    for slot in 0..crate::graphics_objects::GRAPHICS_OBJECT_SLOT_COUNT {
                        let _ = stack.clear_layer(layer, slot);
                    }
                });
            }
            ObjMgmtOp::CopyFgToBg => {
                // Copy foreground objects into the background-object
                // namespace. Same-number slots coexist across layers.
                self.runtime.with_stack_mut(|stack| {
                    let snapshot: Vec<(usize, GraphicsObject)> = (0
                        ..crate::graphics_objects::GRAPHICS_OBJECT_SLOT_COUNT)
                        .filter_map(|slot| {
                            stack
                                .get_layer(GraphicsLayer::ForegroundObject, slot)
                                .map(|o| (slot, o.clone()))
                        })
                        .collect();
                    for (slot, mut o) in snapshot {
                        o.layer_order = OBJ_BG_LAYER_BASE + slot as i32;
                        let _ = stack.set_layer(GraphicsLayer::BackgroundObject, slot, o);
                    }
                });
            }
        }
        DispatchOutcome::Advance
    }
}

// ======================================================================
// registration
// ======================================================================

/// Register EVERY real-numbered render op under all three lattice types.
/// Returns the number of `(module_type, module_id, opcode)` keys mounted.
///
/// Mounted BEFORE [`crate::rlop::module_catalog::register_catalog_rlops`]
/// so the catalog's `Advance` gap-fill never shadows a real-semantics op.
pub fn register_render_rlops(registry: &mut RlopRegistry, runtime: Arc<GraphicsRuntime>) -> usize {
    let mut count = 0usize;
    let mut reg =
        |registry: &mut RlopRegistry, module_id: u8, opcode: u16, op: Arc<dyn RLOperation>| {
            for module_type in LATTICE_TYPES {
                registry.register(
                    RlopKey::new(module_type, module_id, opcode),
                    Arc::clone(&op),
                );
                count += 1;
            }
        };

    // ---- module_grp (id 33) --------------------------------------------
    let grp =
        |o: GrpOp| -> Arc<dyn RLOperation> { Arc::new(GrpRenderOp::new(Arc::clone(&runtime), o)) };
    reg(registry, GRP_MODULE_ID, 15, grp(GrpOp::AllocDc));
    reg(registry, GRP_MODULE_ID, 16, grp(GrpOp::FreeDc));
    reg(registry, GRP_MODULE_ID, 31, grp(GrpOp::Wipe));
    reg(registry, GRP_MODULE_ID, 32, grp(GrpOp::Shake));
    // Load / buffer family (off-screen).
    for op in [50u16, 51, 70, 71] {
        reg(registry, GRP_MODULE_ID, op, grp(GrpOp::Buffer));
    }
    reg(registry, GRP_MODULE_ID, 72, grp(GrpOp::Display));
    // Open-to-screen family (grp + rec + mask + openBg).
    for op in [73u16, 74, 76, 1053, 1056] {
        reg(registry, GRP_MODULE_ID, op, grp(GrpOp::OpenScreen));
    }
    for op in [75u16, 77, 1055, 1057] {
        reg(registry, GRP_MODULE_ID, op, grp(GrpOp::Multi));
    }
    for op in [100u16, 101, 1100, 1101] {
        reg(registry, GRP_MODULE_ID, op, grp(GrpOp::Copy));
    }
    for op in [201u16, 1201] {
        reg(registry, GRP_MODULE_ID, op, grp(GrpOp::Fill));
    }
    reg(registry, GRP_MODULE_ID, 300, grp(GrpOp::Invert));
    reg(registry, GRP_MODULE_ID, 301, grp(GrpOp::Mono));
    reg(registry, GRP_MODULE_ID, 302, grp(GrpOp::Colour));
    reg(registry, GRP_MODULE_ID, 303, grp(GrpOp::Light));
    reg(registry, GRP_MODULE_ID, 403, grp(GrpOp::Fade));

    // ---- object creation (71 fg / 72 bg) -------------------------------
    for (mid, plane) in [
        (OBJ_FG_CREATION_ID, GraphicsPlane::Foreground),
        (OBJ_BG_CREATION_ID, GraphicsPlane::Background),
    ] {
        let create =
            || -> Arc<dyn RLOperation> { Arc::new(ObjCreateOp::new(Arc::clone(&runtime), plane)) };
        // objOfFile / objOfFileGan / objOfArea / objOfRect / objOfText /
        // objDriftOfFile / objOfDigits / objOfChild — all image/placeholder
        // loaders whose arg-1 string is the object's asset key.
        for op in [
            1000u16, 1001, 1003, 1005, 1100, 1101, 1200, 1300, 1400, 1500,
        ] {
            reg(registry, mid, op, create());
        }
    }

    // ---- object setters (81 fg / 82 bg / 90,91 range) ------------------
    for (mid, plane) in [
        (OBJ_FG_SETTER_ID, GraphicsPlane::Foreground),
        (OBJ_BG_SETTER_ID, GraphicsPlane::Background),
        (OBJ_FG_RANGE_ID, GraphicsPlane::Foreground),
        (OBJ_BG_RANGE_ID, GraphicsPlane::Background),
    ] {
        let set = |p: ObjSetProp| -> Arc<dyn RLOperation> {
            Arc::new(ObjSetOp::new(Arc::clone(&runtime), plane, p))
        };
        let setters: &[(u16, ObjSetProp)] = &[
            (1000, ObjSetProp::Move),
            (1001, ObjSetProp::Left),
            (1002, ObjSetProp::Top),
            (1003, ObjSetProp::Alpha),
            (1004, ObjSetProp::Show),
            (1006, ObjSetProp::Adjust),
            (1009, ObjSetProp::Mono),
            (1010, ObjSetProp::Invert),
            (1011, ObjSetProp::Light),
            (1012, ObjSetProp::Tint),
            (1016, ObjSetProp::Colour),
            (1026, ObjSetProp::Layer),
            (1039, ObjSetProp::PattNo),
            (1046, ObjSetProp::Scale),
            (1047, ObjSetProp::Width),
            (1048, ObjSetProp::Height),
            (2004, ObjSetProp::Show), // objEveDisplay → final Show (anim gap)
        ];
        for (op, prop) in setters {
            reg(registry, mid, *op, set(*prop));
        }
        // objButtonOpts (1064): button-object setup feeding select_objbtn.
        reg(
            registry,
            mid,
            1064,
            Arc::new(super::module_obj::ObjButtonOptsOp::new(
                Arc::clone(&runtime),
                plane,
            )),
        );
    }

    // ---- object management (60 / 61 fg / 62 bg) ------------------------
    for (mid, plane) in [
        (OBJ_MGMT_ID, None),
        (OBJ_FG_MGMT_ID, Some(GraphicsPlane::Foreground)),
        (OBJ_BG_MGMT_ID, Some(GraphicsPlane::Background)),
    ] {
        let mgmt = |o: ObjMgmtOp| -> Arc<dyn RLOperation> {
            match plane {
                Some(plane) => Arc::new(ObjMgmtRenderOp::for_plane(Arc::clone(&runtime), plane, o)),
                None => Arc::new(ObjMgmtRenderOp::new(Arc::clone(&runtime), o)),
            }
        };
        reg(registry, mid, 0, mgmt(ObjMgmtOp::Free));
        reg(registry, mid, 10, mgmt(ObjMgmtOp::Init));
        reg(registry, mid, 11, mgmt(ObjMgmtOp::FreeInit));
        reg(registry, mid, 100, mgmt(ObjMgmtOp::FreeAll));
        reg(registry, mid, 110, mgmt(ObjMgmtOp::FreeAll));
        reg(registry, mid, 111, mgmt(ObjMgmtOp::FreeAll));
    }
    // objCopyFgToBg lives on the generic ObjManagement module (60) only.
    reg(
        registry,
        OBJ_MGMT_ID,
        2,
        Arc::new(ObjMgmtRenderOp::new(
            Arc::clone(&runtime),
            ObjMgmtOp::CopyFgToBg,
        )),
    );

    count
}

// ---- tests: rlvm-semantics oracle ------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graphics_objects::GraphicsObjectKind as Kind;

    fn rt() -> Arc<GraphicsRuntime> {
        Arc::new(GraphicsRuntime::new())
    }

    fn vm() -> Vm {
        Vm::new(1, 0)
    }

    fn int(v: i32) -> ExprValue {
        ExprValue::Int(v)
    }

    fn s(v: &[u8]) -> ExprValue {
        ExprValue::Bytes(v.to_vec())
    }

    fn grp(runtime: &Arc<GraphicsRuntime>, op: GrpOp, args: &[ExprValue]) -> DispatchOutcome {
        GrpRenderOp::new(Arc::clone(runtime), op).dispatch(&mut vm(), args)
    }

    // rlvm `allocDC(dc, width, height)` — a blank DC + recorded size.
    #[test]
    fn grp_alloc_dc_records_allocation_and_bg_slot() {
        let runtime = rt();
        grp(&runtime, GrpOp::AllocDc, &[int(1), int(640), int(480)]);
        let snap = runtime.state_snapshot();
        let dc = snap.dc_allocation(1).expect("dc1 allocated");
        assert_eq!((dc.width, dc.height), (640, 480));
        assert!(snap.stack.get(GraphicsPlane::Background, 1).is_some());
    }

    // rlvm `wipe(dc, r, g, b)` — dc filled with an opaque RGB triplet.
    #[test]
    fn grp_wipe_fills_dc_with_opaque_rgb() {
        let runtime = rt();
        grp(
            &runtime,
            GrpOp::Wipe,
            &[int(0), int(0x10), int(0x20), int(0x30)],
        );
        let snap = runtime.state_snapshot();
        match &snap.stack.get(GraphicsPlane::Background, 0).unwrap().kind {
            Kind::Wipe { colour } => {
                assert_eq!(
                    (colour.red, colour.green, colour.blue, colour.alpha),
                    (0x10, 0x20, 0x30, 0xFF)
                );
            }
            Kind::Image { .. } => panic!("expected Wipe"),
        }
    }

    // rlvm grpBuffer loads to an OFF-SCREEN dc (filename FIRST, then dc).
    #[test]
    fn grp_buffer_loads_offscreen_then_display_promotes_to_dc0() {
        let runtime = rt();
        grp(&runtime, GrpOp::Buffer, &[s(b"EV"), int(3)]);
        let snap = runtime.state_snapshot();
        let buf = snap.stack.get(GraphicsPlane::Background, 3).unwrap();
        assert!(!buf.visible);
        assert!(
            snap.stack
                .get(GraphicsPlane::Background, SCREEN_DC_SLOT)
                .is_none()
        );
        grp(&runtime, GrpOp::Display, &[int(3), int(0)]);
        let snap = runtime.state_snapshot();
        let screen = snap
            .stack
            .get(GraphicsPlane::Background, SCREEN_DC_SLOT)
            .unwrap();
        assert!(screen.visible);
        match &screen.kind {
            Kind::Image { image_ref } => assert_eq!(image_ref.asset_key, "EV"),
            Kind::Wipe { .. } => panic!("expected Image"),
        }
    }

    // rlvm grpOpenBg loads straight to DC0 (the screen), filename FIRST.
    #[test]
    fn grp_open_screen_loads_dc0_visible() {
        let runtime = rt();
        grp(&runtime, GrpOp::OpenScreen, &[s(b"BG10"), int(0)]);
        let snap = runtime.state_snapshot();
        let screen = snap
            .stack
            .get(GraphicsPlane::Background, SCREEN_DC_SLOT)
            .unwrap();
        assert!(screen.visible);
        match &screen.kind {
            Kind::Image { image_ref } => assert_eq!(image_ref.asset_key, "BG10"),
            Kind::Wipe { .. } => panic!("expected Image"),
        }
        assert_eq!(snap.bg_canvas.unwrap().asset_key, "BG10");
    }

    // rlvm "???" sentinel filename means "keep current" — no load.
    #[test]
    fn grp_open_screen_skips_triple_question_sentinel() {
        let runtime = rt();
        grp(&runtime, GrpOp::OpenScreen, &[s(b"???"), int(0)]);
        assert!(
            runtime
                .state_snapshot()
                .stack
                .get(GraphicsPlane::Background, 0)
                .is_none()
        );
    }

    // rlvm grpCopy(src, dst): copy DC src → DC dst.
    #[test]
    fn grp_copy_clones_src_dc_to_dst() {
        let runtime = rt();
        grp(&runtime, GrpOp::Buffer, &[s(b"A"), int(1)]);
        grp(&runtime, GrpOp::Copy, &[int(1), int(2)]);
        let snap = runtime.state_snapshot();
        match &snap.stack.get(GraphicsPlane::Background, 2).unwrap().kind {
            Kind::Image { image_ref } => assert_eq!(image_ref.asset_key, "A"),
            Kind::Wipe { .. } => panic!("expected Image"),
        }
    }

    // rlvm objOfFile(buf, filename[, visible, x, y, pattern]).
    #[test]
    fn obj_of_file_creates_image_with_trailing_placement() {
        let runtime = rt();
        ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground).dispatch(
            &mut vm(),
            &[int(5), s(b"CHAR"), int(1), int(10), int(20), int(3)],
        );
        let snap = runtime.state_snapshot();
        let o = snap.stack.get(GraphicsPlane::Foreground, 5).unwrap();
        match &o.kind {
            Kind::Image { image_ref } => {
                assert_eq!(image_ref.asset_key, "CHAR");
                assert_eq!(image_ref.region_index, Some(3));
            }
            Kind::Wipe { .. } => panic!("expected Image"),
        }
        assert!(o.visible);
        assert_eq!((o.position.x, o.position.y), (10, 20));
        assert_eq!(o.layer_order, OBJ_FG_LAYER_BASE + 5);
    }

    #[test]
    fn bg_and_fg_object_creation_same_buf_do_not_overwrite() {
        let runtime = rt();
        ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Background)
            .dispatch(&mut vm(), &[int(5), s(b"BG_OBJ")]);
        ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
            .dispatch(&mut vm(), &[int(5), s(b"FG_OBJ")]);

        let snap = runtime.state_snapshot();
        let bg = snap
            .stack
            .get_layer(GraphicsLayer::BackgroundObject, 5)
            .expect("bg object remains");
        let fg = snap
            .stack
            .get_layer(GraphicsLayer::ForegroundObject, 5)
            .expect("fg object remains");
        match &bg.kind {
            Kind::Image { image_ref } => assert_eq!(image_ref.asset_key, "BG_OBJ"),
            Kind::Wipe { .. } => panic!("expected bg image"),
        }
        match &fg.kind {
            Kind::Image { image_ref } => assert_eq!(image_ref.asset_key, "FG_OBJ"),
            Kind::Wipe { .. } => panic!("expected fg image"),
        }
        assert_eq!(bg.layer_order, OBJ_BG_LAYER_BASE + 5);
        assert_eq!(fg.layer_order, OBJ_FG_LAYER_BASE + 5);
    }

    // rlvm object setters: Move / Alpha / Show / Layer / PattNo (buf FIRST).
    #[test]
    fn obj_setters_mutate_created_object() {
        let runtime = rt();
        ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
            .dispatch(&mut vm(), &[int(0), s(b"X")]);
        let set = |p: ObjSetProp, args: &[ExprValue]| {
            ObjSetOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground, p)
                .dispatch(&mut vm(), args);
        };
        set(ObjSetProp::Move, &[int(0), int(7), int(9)]);
        set(ObjSetProp::Alpha, &[int(0), int(64)]);
        set(ObjSetProp::Show, &[int(0), int(0)]);
        set(ObjSetProp::Layer, &[int(0), int(4)]);
        set(ObjSetProp::PattNo, &[int(0), int(2)]);
        let snap = runtime.state_snapshot();
        let o = snap.stack.get(GraphicsPlane::Foreground, 0).unwrap();
        assert_eq!((o.position.x, o.position.y), (7, 9));
        assert_eq!(o.alpha.0, 64);
        assert!(!o.visible);
        assert_eq!(o.layer_order, OBJ_FG_LAYER_BASE + 4);
        if let Kind::Image { image_ref } = &o.kind {
            assert_eq!(image_ref.region_index, Some(2));
        }
    }

    #[test]
    fn bg_object_setter_mutates_bg_namespace_only() {
        let runtime = rt();
        ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Background)
            .dispatch(&mut vm(), &[int(2), s(b"BG")]);
        ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
            .dispatch(&mut vm(), &[int(2), s(b"FG")]);

        ObjSetOp::new(
            Arc::clone(&runtime),
            GraphicsPlane::Background,
            ObjSetProp::Move,
        )
        .dispatch(&mut vm(), &[int(2), int(10), int(20)]);

        let snap = runtime.state_snapshot();
        let bg = snap
            .stack
            .get_layer(GraphicsLayer::BackgroundObject, 2)
            .expect("bg object");
        let fg = snap
            .stack
            .get_layer(GraphicsLayer::ForegroundObject, 2)
            .expect("fg object");
        assert_eq!((bg.position.x, bg.position.y), (10, 20));
        assert_eq!((fg.position.x, fg.position.y), (0, 0));
    }

    // rlvm objFree(buf) clears the buffer; objFreeAll clears the plane.
    #[test]
    fn obj_management_free_and_free_all() {
        let runtime = rt();
        for buf in [0, 1, 2] {
            ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
                .dispatch(&mut vm(), &[int(buf), s(b"X")]);
        }
        ObjMgmtRenderOp::new(Arc::clone(&runtime), ObjMgmtOp::Free).dispatch(&mut vm(), &[int(1)]);
        assert!(
            runtime
                .state_snapshot()
                .stack
                .get(GraphicsPlane::Foreground, 1)
                .is_none()
        );
        assert_eq!(
            runtime
                .state_snapshot()
                .stack
                .plane_len(GraphicsPlane::Foreground),
            2
        );
        ObjMgmtRenderOp::new(Arc::clone(&runtime), ObjMgmtOp::FreeAll).dispatch(&mut vm(), &[]);
        assert_eq!(
            runtime
                .state_snapshot()
                .stack
                .plane_len(GraphicsPlane::Foreground),
            0
        );
    }

    // Registration mounts every real op under all three lattice types and
    // is displacement-free (no key collision panic).
    #[test]
    fn register_mounts_under_all_lattice_types() {
        let mut registry = RlopRegistry::new();
        let n = register_render_rlops(&mut registry, rt());
        assert!(
            n.is_multiple_of(3),
            "every op registered under 3 lattice types"
        );
        assert_eq!(registry.len(), n);
        // Spot-check the real opcode keys under all three types.
        for mt in [0u8, 1, 2] {
            assert!(registry.get(RlopKey::new(mt, GRP_MODULE_ID, 73)).is_some());
            assert!(
                registry
                    .get(RlopKey::new(mt, OBJ_FG_CREATION_ID, 1000))
                    .is_some()
            );
            assert!(
                registry
                    .get(RlopKey::new(mt, OBJ_FG_SETTER_ID, 1026))
                    .is_some()
            );
            assert!(registry.get(RlopKey::new(mt, OBJ_FG_MGMT_ID, 0)).is_some());
        }
    }

    #[test]
    fn render_gaps_are_documented_not_empty() {
        assert!(RENDER_GAPS.len() >= 6);
        for (family, why) in RENDER_GAPS {
            assert!(!family.is_empty() && !why.is_empty());
        }
        assert!(!RLVM_PIXEL_DIFF_TOLERANCE.is_empty());
    }
}
