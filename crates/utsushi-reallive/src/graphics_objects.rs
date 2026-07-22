//! Graphics object stack (headless render pipeline).
//!
//! Implements the rlvm `GraphicsSystem` equivalent: a stack of
//! **256 graphics objects per render layer × 3 layers** (`DCs`
//! `BackgroundObject` + `ForegroundObject`) addressed by `(layer, slot)`.
//! Each object carries
//! `(position, scale, alpha, colour_tone, image_ref, layer_order, kind)`
//! state.
//!
//! The stack is **purely state**: the headless render-pipeline at
//! [`crate::render_pipeline`] walks the stack, sorted by `(render layer
//! layer_order)`, and rasterises a per-frame
//! [`crate::render_pipeline::Framebuffer`] into a deterministic PNG
//! blob.
//!
//! # Slot capacity
//!
//! Per rlvm's documented `GraphicsSystem` shape (publicly archived
//! header comments at `<https://github.com/eglaysher/rlvm>` — research
//! anchor only; not vendored, not derived), each plane addresses
//! `0..=255` (`256` slots). This crate pins the value through
//! [`GRAPHICS_OBJECT_SLOT_COUNT`] so the stack constructor and the
//! acceptance test
//! `graphics_object_stack_256_objects` share one source of truth.
//!
//! # Clean-room provenance
//!
//! The object-state shape (`position`, `scale`, `alpha`, `colour_tone`
//! `image_ref`, `layer_order`) is re-derived from the publicly-archived
//! RLDEV format documentation (Haeleth's RLDEV site) plus the
//! g00 decoder's [`crate::G00Image`] surface. No rlvm
//! source is vendored, linked, or mechanically translated, per the
//! crate-wide
//! [`crate::RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`].

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Per-plane slot count. Both the foreground and background planes
/// address `0..=255` (256 slots each), per the rlvm-public
/// `GraphicsSystem` shape. The acceptance criterion
/// `graphics_object_stack_256_objects` pins this constant.
pub const GRAPHICS_OBJECT_SLOT_COUNT: usize = 256;

/// Total addressable slot count across the RealLive render layers
/// (`DCs + bg objects + fg objects`).
pub const GRAPHICS_OBJECT_TOTAL_SLOTS: usize = GRAPHICS_OBJECT_SLOT_COUNT * 3;

/// The two graphics planes a RealLive scene addresses. Foreground objects
/// always paint **on top** of background objects regardless of
/// [`GraphicsObject::layer_order`] — the layer order is plane-local.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GraphicsPlane {
    /// Background plane — painted first.
    Background,
    /// Foreground plane — painted on top of background.
    Foreground,
}

impl GraphicsPlane {
    /// Stable plane index used by the render-pass paint order
    /// (`Background = 0`, `Foreground = 1`). Lower index paints first.
    pub fn paint_order(self) -> u8 {
        match self {
            Self::Background => 0,
            Self::Foreground => 1,
        }
    }
}

/// RealLive render layers in compositor order.
///
/// `GraphicsPlane` is retained as the public two-plane compatibility
/// surface: `Background` maps to [`Self::DisplayCommand`] and
/// `Foreground` maps to [`Self::ForegroundObject`]. RealLive object
/// opcode handling uses this type directly so bg-object slot `N` and
/// fg-object slot `N` can coexist instead of overwriting each other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GraphicsLayer {
    /// RealLive graphic DC namespace (`module_grp`).
    DisplayCommand,
    /// RealLive background object namespace.
    BackgroundObject,
    /// RealLive foreground object namespace.
    ForegroundObject,
}

impl GraphicsLayer {
    /// Stable compositor order: DCs, then bg objects, then fg objects.
    pub fn paint_order(self) -> u8 {
        match self {
            Self::DisplayCommand => 0,
            Self::BackgroundObject => 1,
            Self::ForegroundObject => 2,
        }
    }

    /// Compatibility mapping from the older two-plane API.
    pub fn from_plane(plane: GraphicsPlane) -> Self {
        match plane {
            GraphicsPlane::Background => Self::DisplayCommand,
            GraphicsPlane::Foreground => Self::ForegroundObject,
        }
    }

    /// Compatibility projection for diagnostics that still report
    /// `GraphicsPlane`.
    pub fn diagnostic_plane(self) -> GraphicsPlane {
        match self {
            Self::DisplayCommand => GraphicsPlane::Background,
            Self::BackgroundObject | Self::ForegroundObject => GraphicsPlane::Foreground,
        }
    }
}

/// 2D position in pixel space. The render pass interprets `(x, y)` as
/// the **top-left** corner of the object's bounding box (matching the
/// rlvm-public convention).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsPosition {
    pub x: i32,
    pub y: i32,
}

impl GraphicsPosition {
    pub const ORIGIN: Self = Self { x: 0, y: 0 };
}

/// Per-axis scale, expressed in **thousandths** (rlvm-public convention).
/// `1000` = `100%`, `500` = `50%`, `2000` = `200%`. Stored as `i32` so
/// the rlvm-documented signed-zero / negative-mirror cases can be
/// represented losslessly. The render pass **applies** this scale when
/// compositing an image object: the decoded g00 bitmap is nearest-neighbour
/// resampled to `src_dimension * thousandths / 1000` before it is blitted
/// into the framebuffer (see
/// [`crate::render_pipeline::RenderPass::paint_object`]). Negative or zero
/// values collapse the destination extent to `0` (the object contributes no
/// pixels); axis mirroring is out of scope for the headless rasteriser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsScale {
    pub x_thousandths: i32,
    pub y_thousandths: i32,
}

impl GraphicsScale {
    /// Identity scale (`100%` on both axes).
    pub const IDENTITY: Self = Self {
        x_thousandths: 1000,
        y_thousandths: 1000,
    };
}

/// Per-axis object-data scale in classic percent units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsPercentScale {
    pub x_percent: i32,
    pub y_percent: i32,
}

impl GraphicsPercentScale {
    pub const IDENTITY: Self = Self {
        x_percent: 100,
        y_percent: 100,
    };
}

/// Alpha in `0..=255` (rlvm-public convention). `0` = fully
/// transparent, `255` = fully opaque.
///
/// The render pass at [`crate::render_pipeline`] **applies** this alpha
/// when compositing every object:
/// [`crate::render_pipeline::RenderPass::paint_object`] blends the
/// object's contribution over the existing framebuffer using
/// `effective = source_alpha * object_alpha / 255` source-over
/// compositing. An object with `alpha = TRANSPARENT` therefore
/// contributes NO pixels (it leaves the framebuffer unchanged), and an
/// `alpha = OPAQUE` object composites its source colour verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsAlpha(pub u8);

impl GraphicsAlpha {
    pub const OPAQUE: Self = Self(255);
    pub const TRANSPARENT: Self = Self(0);
}

/// Per-channel colour tone, expressed in **signed thousandths**
/// (`-1000..=1000`). The render pass at [`crate::render_pipeline`]
/// **applies** this tone to each source pixel before compositing:
/// `channel_out = clamp(channel + tone_thousandths * 255 / 1000, 0, 255)`
/// (a `+1000` tone drives the channel to white, `-1000` to black). A
/// [`Self::NEUTRAL`] tone is the identity transform, so an object with
/// the default tone composites its source colour unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsColourTone {
    pub red_thousandths: i32,
    pub green_thousandths: i32,
    pub blue_thousandths: i32,
}

impl GraphicsColourTone {
    pub const NEUTRAL: Self = Self {
        red_thousandths: 0,
        green_thousandths: 0,
        blue_thousandths: 0,
    };
}

/// 24-bit BGRA-ordered colour as documented in
/// `docs/research/reallive-engine.md` § "g00 (RealLive image format)".
/// The wipe object renders this colour to **every** pixel of the
/// framebuffer; the render pass at [`crate::render_pipeline`] performs
/// the BGRA → RGBA reorder so the resulting PNG carries each channel
/// in the conventional PNG RGBA byte order.
///
/// The fields are named after the **logical channel**, not the on-disk
/// position, to make audit grep trivial: a regression that silently
/// transposes red and blue produces a colour-name field mismatch in
/// the typed value rather than a silent byte transpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WipeColour {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
    pub alpha: u8,
}

impl WipeColour {
    pub const BLACK: Self = Self {
        red: 0,
        green: 0,
        blue: 0,
        alpha: 255,
    };
    pub const TRANSPARENT: Self = Self {
        red: 0,
        green: 0,
        blue: 0,
        alpha: 0,
    };
    pub const WHITE: Self = Self {
        red: 255,
        green: 255,
        blue: 255,
        alpha: 255,
    };

    pub const fn opaque_rgb(red: u8, green: u8, blue: u8) -> Self {
        Self {
            red,
            green,
            blue,
            alpha: 255,
        }
    }
}

/// Reference to an image asset loaded by a graphics RLOperation. The
/// render pass at [`crate::render_pipeline`] **dereferences** this
/// reference during compositing: it resolves `g00/<asset_key>.g00`
/// through the render pass's bound [`utsushi_core::substrate::AssetPackage`]
/// decodes the bytes with [`crate::decode_g00`], and blits the decoded
/// bitmap into the framebuffer (subject to the object's scale, tone, and
/// alpha). The reference is also carried verbatim on the object so audit
/// tooling can pin which slot was assigned which asset across the
/// lifecycle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    /// Asset key (e.g. the g00 file's stem name like `BG01A1`).
    pub asset_key: String,
    /// Optional sub-region selector. Type-2 g00 files (see
    /// [`crate::G00Region`]) expose a typed region list; this field is
    /// the integer index into that list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region_index: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceGeometry {
    pub width: i32,
    pub height: i32,
    pub origin: GraphicsPosition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HitRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HitRegionUnavailable {
    AssetPatternGeometryUnavailable,
    ObjOfFileGanUnsupported,
    TextDigitsDriftAnimationUnsupported,
    ColourAreaRectNoClickBounds,
    NonFiniteTransform,
    OutOfRangeTransform,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HitRegion {
    Known(HitRect),
    Unavailable(HitRegionUnavailable),
}

/// Typed object-data state used only by the pure hit-geometry kernel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectGeometryState {
    pub surface: Option<SurfaceGeometry>,
    pub unavailable: HitRegionUnavailable,
    pub adjust_slots: [GraphicsPosition; 8],
    pub origin_override: Option<GraphicsPosition>,
    pub classic_percent: GraphicsPercentScale,
    pub hq_thousandths: GraphicsScale,
}

impl Default for ObjectGeometryState {
    fn default() -> Self {
        Self {
            surface: None,
            unavailable: HitRegionUnavailable::AssetPatternGeometryUnavailable,
            adjust_slots: [GraphicsPosition::ORIGIN; 8],
            origin_override: None,
            classic_percent: GraphicsPercentScale::IDENTITY,
            hq_thousandths: GraphicsScale::IDENTITY,
        }
    }
}

/// f32-only input to the pure destination-rectangle kernel.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DstRectKernelInput {
    pub surface: [f32; 2],
    pub child_position: [f32; 2],
    pub child_adjust: [f32; 2],
    pub origin: [f32; 2],
    pub child_factor: [f32; 2],
    pub parent: Option<DstRectKernelParent>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DstRectKernelParent {
    pub position: [f32; 2],
    pub adjust: [f32; 2],
    pub factor: [f32; 2],
}

/// Un-clipped destination geometry, faithful to rlvm
/// `GraphicsObjectData::DstRect` (rlvm `src/systems/base/graphics_object_data.cc:236-266`).
///
/// rlvm assigns `center` and `half_real` EACH to an `int` (C truncation
/// toward zero) **separately**, then combines them with integer arithmetic:
/// `int center_x = go.x() + adj - origin.x() + src.width()/2.0f;` (then
/// `center_x += parent->x() + parent_adj;`), `int half_real_width =
/// (src.width()*pf*cf)/2.0f;`, `xPos1 = center_x - half_real_width`, `xPos2 =
/// center_x + half_real_width`, `Rect::GRP(x1,y1,x2,y2)` stores origin
/// `(x1,y1)` and size `(x2-x1, y2-y1) = (2*half_real_width, 2*half_real_height)`.
///
/// Two truncation points are load-bearing: (1) `center` is truncated before
/// the (integer) parent position/adjust are added — folding them into the
/// pre-truncation sum is WRONG because `trunc(f + n) != trunc(f) + n` for a
/// negative `f` (trunc rounds toward zero, not toward -inf); (2) `half_real`
/// is truncated independently of `center`. The scale factors apply only to
/// the half extents; `origin` is subtracted unscaled.
pub fn derive_dst_rect(input: DstRectKernelInput) -> Result<HitRect, HitRegionUnavailable> {
    let parent = input.parent.unwrap_or(DstRectKernelParent {
        position: [0.0, 0.0],
        adjust: [0.0, 0.0],
        factor: [1.0, 1.0],
    });
    // rlvm: `int center = <float>` truncates, THEN the integer parent
    // position/adjust are added.
    let center_x = (input.child_position[0] + input.child_adjust[0] - input.origin[0]
        + input.surface[0] / 2.0)
        .trunc()
        + parent.position[0]
        + parent.adjust[0];
    let center_y = (input.child_position[1] + input.child_adjust[1] - input.origin[1]
        + input.surface[1] / 2.0)
        .trunc()
        + parent.position[1]
        + parent.adjust[1];
    // rlvm: `int half_real = (src * pf * cf) / 2.0f` — truncated independently.
    let half_x = (input.surface[0] * parent.factor[0] * input.child_factor[0] / 2.0).trunc();
    let half_y = (input.surface[1] * parent.factor[1] * input.child_factor[1] / 2.0).trunc();
    let values = [
        center_x - half_x,
        center_y - half_y,
        2.0 * half_x,
        2.0 * half_y,
    ];
    if values.iter().any(|value| !value.is_finite()) {
        return Err(HitRegionUnavailable::NonFiniteTransform);
    }
    let mut output = [0i32; 4];
    for (index, value) in values.into_iter().enumerate() {
        // `value` is already integral (int arithmetic over truncated terms);
        // guard the i32 range before the cast.
        if value < i32::MIN as f32 || value >= 2_147_483_648.0 {
            return Err(HitRegionUnavailable::OutOfRangeTransform);
        }
        output[index] = value as i32;
    }
    Ok(HitRect {
        x: output[0],
        y: output[1],
        width: output[2],
        height: output[3],
    })
}

#[path = "graphics_objects/object.rs"]
mod object;
pub use object::{
    ButtonOptions, GraphicsObject, GraphicsObjectKind, GraphicsObjectParent, GraphicsObjectTarget,
    ImageProvenance,
};

#[path = "graphics_objects/stack.rs"]
mod stack;
pub use stack::{GraphicsObjectStack, GraphicsStackError};

#[cfg(test)]
#[path = "graphics_objects/tests.rs"]
mod tests;
