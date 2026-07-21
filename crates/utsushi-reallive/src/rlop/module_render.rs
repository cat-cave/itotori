//! `utsushi-reallive-render-opcode-semantics` — REAL-numbered RealLive
//! graphics / object render opcodes.
//!
//! # Why this module exists
//!
//! The earlier `module_grp` / `module_obj` tables implemented graphics
//! semantics under SYNTHETIC opcode numbers (`grp.allocDC = 1`, …) that
//! never occur on real bytes. The real RealLive opcode numbers (rlvm's `module_grp` at `15/16/31/32
//! 70/72/73/…` and the object modules at `1000/1003/1004/1026/1039/…`)
//! are implemented here so they mutate render state instead of surfacing as
//! unknown commands.
//!
//! This module gives those REAL opcode numbers REAL render semantics
//! re-derived from the rlvm research anchor (`module_grp.cc`
//! `module_obj_creation.cc`, `module_obj_fg_bg.cc`
//! `module_obj_management.cc`, `object_module.cc`) — the LOGIC is
//! re-implemented, no source is vendored. Each op mutates the shared
//! [`GraphicsRuntime`] (the [`crate::GraphicsObjectStack`]
//! side-tables) so a composited frame reflects it.
//!
//! # Opcode numbering (rlvm-anchored)
//!
//! - `module_grp` = `module_id 33` (rlvm `GrpModule("Grp", 1, 33)`).
//!   `allocDC=15, FreeDC=16, wipe=31, shake=32, grpBuffer=70
//!   grpMaskBuffer=71, grpDisplay=72, grpOpenBg=73, grpMaskOpen=74
//!   grpMulti=75/77, grpOpen=76, grpCopy=100, grpMaskCopy=101
//!   grpFill=201, grpInvert=300, grpMono=301, grpColour=302, grpLight=303
//!   grpFade=403`. `rec*` = the same ops on the `REC` coordinate space at
//!   `1050+` (`recOpenBg=1053, recOpen=1056, recCopy=1100, recFill=1201`).
//! - object CREATION = `module_id 71` (ObjFg) / `72` (ObjBg):
//!   `objOfFile=1000, objOfFileGan=1003, objOfArea=1100, objOfRect=1101
//!   objOfText=1200, objDriftOfFile=1300, objOfDigits=1400
//!   objOfChild=1500`.
//! - object SETTERS = `module_id 81` (ObjFg) / `82` (ObjBg) / `90`,`91`
//!   (range). rlvm's `object_module.cc` maps a base id `n` to opcode
//!   `1000+n` (`Move=1000, Left=1001, Top=1002, Alpha=1003, Mono=1009
//!   Invert=1010, Light=1011, Layer=1026, PattNo=1039, Scale=1046, …`) plus
//!   the `addObjectFunctions` block (`objShow=1004, objTint=1012
//!   objColour=1016, objButtonOpts=1064, objEveDisplay=2004`).
//! - object MANAGEMENT = `module_id 60`/`61`(fg)/`62`(bg):
//!   `objAlloc=1` (on `60`), `objFree=0, objInit=10, objFreeInit=11, objFreeAll=100
//!   objInitAll=110, objFreeInitAll=111` (+ `objCopyFgToBg=2` on `60`).
//!
//! # Lattice-type registration
//!
//! A semantic op can appear under more than one compiler `module_type`.
//! Every op here is registered under all three observed lattice types
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

mod grp;
pub use grp::{GrpOp, GrpRenderOp};

use std::sync::Arc;

use super::module_obj::{GraphicsRuntime, GraphicsRuntimeWarning};
use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::graphics_objects::{
    GraphicsAlpha, GraphicsColourTone, GraphicsLayer, GraphicsObject, GraphicsObjectKind,
    GraphicsObjectTarget, GraphicsPlane, GraphicsScale, ImageProvenance,
};
use crate::vm::Vm;

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

fn register_on_types(
    registry: &mut RlopRegistry,
    module_types: &[u8],
    module_id: u8,
    opcode: u16,
    op: Arc<dyn RLOperation>,
) -> usize {
    for &module_type in module_types {
        registry.register(
            RlopKey::new(module_type, module_id, opcode),
            Arc::clone(&op),
        );
    }
    module_types.len()
}

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

mod management;
mod object_create;
mod object_set;
#[cfg(test)]
mod tests;

pub use management::{ObjMgmtOp, ObjMgmtRenderOp, register_render_rlops};
pub use object_create::{ChildCreateOp, ObjCreateOp, ParentCreateOp};
pub use object_set::{ObjSetOp, ObjSetProp};
