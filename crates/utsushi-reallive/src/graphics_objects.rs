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

/// Per-object kind discriminator. Two kinds: `Image` (assigned an
/// [`ImageRef`]; the render pass dereferences the ref, decodes the g00
/// bitmap, and composites it) and `Wipe` (a full-framebuffer
/// solid-colour fill — used for the
/// `render_wipe_solid_colour_deterministic_png` acceptance smoke).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GraphicsObjectKind {
    /// Image-backed object. The render pass resolves the [`ImageRef`]
    /// through the bound asset package, decodes the g00 bytes, and
    /// composites the decoded bitmap (scaled, tone-shifted, and
    /// alpha-blended per the object's state) into the framebuffer.
    Image { image_ref: ImageRef },
    /// Solid-colour wipe. The render pass paints `colour` across the
    /// entire framebuffer (per the rlvm-public `Wipe` opcode shape).
    Wipe { colour: WipeColour },
}

/// Creation provenance used to gate future asset-backed metadata work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageProvenance {
    FileBacked,
    Placeholder,
}

/// One graphics object slot. The state is intentionally `pub` so audit
/// tooling can introspect a slot without going through accessors. A
/// slot is either `Some(GraphicsObject {... })` (allocated) or
/// `None` (free).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsObject {
    /// Pixel-space position (top-left of the object's bounding box).
    pub position: GraphicsPosition,
    /// Per-axis scale (thousandths).
    pub scale: GraphicsScale,
    /// Alpha in `0..=255`.
    pub alpha: GraphicsAlpha,
    /// Per-channel colour tone (`-1000..=1000`).
    pub colour_tone: GraphicsColourTone,
    /// Plane-local layer order. Higher values paint on top.
    pub layer_order: i32,
    /// Discriminator + payload (`Image` or `Wipe`).
    pub kind: GraphicsObjectKind,
    /// Whether this object was created by a direct file form.
    pub image_provenance: ImageProvenance,
    /// Visibility flag (`objShow` / `objHide` in ). The
    /// render pass skips invisible objects without dereferencing their
    /// image refs.
    pub visible: bool,
    /// Exact `objButtonOpts(buf, action, se, group, button_number)` binding.
    pub button_options: Option<ButtonOptions>,
    /// Exact `objBtnState` value; does not create a button binding.
    pub button_state: i32,
    /// Object-data geometry; intentionally independent of render scale/state.
    pub geometry: ObjectGeometryState,
}

/// Sparse value-owned children declared by a parent object address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphicsObjectParent {
    pub declared_capacity: usize,
    pub children: BTreeMap<usize, GraphicsObject>,
}

impl GraphicsObjectParent {
    pub fn new(declared_capacity: usize) -> Self {
        Self {
            declared_capacity,
            children: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphicsObjectTarget {
    TopLevel {
        layer: GraphicsLayer,
        slot: usize,
    },
    Child {
        plane: GraphicsPlane,
        parent: usize,
        child: usize,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonOptions {
    pub action: i32,
    pub se: i32,
    pub group: i32,
    pub button_number: i32,
}

impl GraphicsObject {
    /// Construct an image-backed object at the origin with identity
    /// scale, opaque alpha, and neutral tone. The render pass
    /// dereferences the `image_ref` through its bound asset package and
    /// composites the decoded g00 bitmap.
    pub fn image(asset_key: impl Into<String>) -> Self {
        Self {
            position: GraphicsPosition::ORIGIN,
            scale: GraphicsScale::IDENTITY,
            alpha: GraphicsAlpha::OPAQUE,
            colour_tone: GraphicsColourTone::NEUTRAL,
            layer_order: 0,
            kind: GraphicsObjectKind::Image {
                image_ref: ImageRef {
                    asset_key: asset_key.into(),
                    region_index: None,
                },
            },
            image_provenance: ImageProvenance::Placeholder,
            visible: true,
            button_options: None,
            button_state: 0,
            geometry: ObjectGeometryState::default(),
        }
    }

    /// Construct a wipe object that paints `colour` across the entire
    /// framebuffer. The render pass treats this as a clear-screen
    /// operation; multiple wipes within the same plane paint in
    /// ascending `layer_order` order.
    pub fn wipe(colour: WipeColour) -> Self {
        Self {
            position: GraphicsPosition::ORIGIN,
            scale: GraphicsScale::IDENTITY,
            alpha: GraphicsAlpha::OPAQUE,
            colour_tone: GraphicsColourTone::NEUTRAL,
            layer_order: 0,
            kind: GraphicsObjectKind::Wipe { colour },
            image_provenance: ImageProvenance::Placeholder,
            visible: true,
            button_options: None,
            button_state: 0,
            geometry: ObjectGeometryState::default(),
        }
    }

    fn factor(&self) -> (f32, f32) {
        (
            self.geometry.classic_percent.x_percent as f32 / 100.0
                * (self.geometry.hq_thousandths.x_thousandths as f32 / 1000.0),
            self.geometry.classic_percent.y_percent as f32 / 100.0
                * (self.geometry.hq_thousandths.y_thousandths as f32 / 1000.0),
        )
    }

    /// Recompute the render scale ([`GraphicsScale`], thousandths) from the
    /// object-data scale inputs, matching rlvm's single
    /// `GraphicsObject::GetWidthScaleFactor` /`GetHeightScaleFactor`
    /// (`src/systems/base/graphics_object.cc:256-262`):
    /// `(width_ / 100.0f) * (hq_width_ / 1000.0f)`. In thousandths that is
    /// `x_percent * x_thousandths / 100`. The classic-percent (`objScale`
    /// `objWidth` / `objHeight`) and hq (`objHqScale...`) setters call this so
    /// the render pass — which composites through [`Self::scale`] — reflects
    /// every scale opcode, exactly as rlvm's `DstRect` multiplies both factors.
    pub fn sync_render_scale_from_geometry(&mut self) {
        self.scale = GraphicsScale {
            x_thousandths: self.geometry.classic_percent.x_percent
                * self.geometry.hq_thousandths.x_thousandths
                / 100,
            y_thousandths: self.geometry.classic_percent.y_percent
                * self.geometry.hq_thousandths.y_thousandths
                / 100,
        };
    }

    fn adjust_sum(&self) -> (f32, f32) {
        self.geometry
            .adjust_slots
            .iter()
            .fold((0.0, 0.0), |(x, y), adjust| {
                (x + adjust.x as f32, y + adjust.y as f32)
            })
    }

    /// Derive only from an explicit child surface. A parent contributes its
    /// placement/transform but never makes an unknown child surface known.
    pub fn hit_region(&self, parent: Option<&GraphicsObject>) -> HitRegion {
        let Some(surface) = self.geometry.surface else {
            return HitRegion::Unavailable(self.geometry.unavailable);
        };
        let origin = self.geometry.origin_override.unwrap_or(surface.origin);
        let (child_adjust_x, child_adjust_y) = self.adjust_sum();
        let (child_factor_x, child_factor_y) = self.factor();
        let parent = parent.map(|parent| {
            let (adjust_x, adjust_y) = parent.adjust_sum();
            let (factor_x, factor_y) = parent.factor();
            DstRectKernelParent {
                position: [parent.position.x as f32, parent.position.y as f32],
                adjust: [adjust_x, adjust_y],
                factor: [factor_x, factor_y],
            }
        });
        derive_dst_rect(DstRectKernelInput {
            surface: [surface.width as f32, surface.height as f32],
            child_position: [self.position.x as f32, self.position.y as f32],
            child_adjust: [child_adjust_x, child_adjust_y],
            origin: [origin.x as f32, origin.y as f32],
            child_factor: [child_factor_x, child_factor_y],
            parent,
        })
        .map_or_else(HitRegion::Unavailable, HitRegion::Known)
    }
}

/// Typed errors surfaced by [`GraphicsObjectStack::allocate`]
/// [`GraphicsObjectStack::set`]. Every variant carries the
/// `(plane, slot)` it failed against.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GraphicsStackError {
    /// Slot index is `>= 256`. The stack refuses to silently truncate.
    #[error(
        "graphics object slot {slot} is out of range (must be < {GRAPHICS_OBJECT_SLOT_COUNT}) on plane {plane:?}"
    )]
    SlotOutOfRange { plane: GraphicsPlane, slot: usize },
}

/// The 256-slot × 2-plane graphics object stack.
///
/// The acceptance test `graphics_object_stack_256_objects` pins:
/// - allocating 256 objects (one per slot on a single plane) is
///   accepted;
/// - the next allocation (slot 256) is rejected with
///   [`GraphicsStackError::SlotOutOfRange`];
/// - after population the stack reports `len() == 256` on the
///   populated plane and `len() == 0` on the other.
///
/// The state is dense (`Vec<Option<GraphicsObject>>` of length 256
/// per plane) so a slot lookup is `O(1)`; the empty slots carry a
/// fixed-size `None` so the total memory cost is the same regardless
/// of allocation pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphicsObjectStack {
    display_commands: Vec<Option<GraphicsObject>>,
    background_objects: Vec<Option<GraphicsObject>>,
    foreground_objects: Vec<Option<GraphicsObject>>,
    background_parents: BTreeMap<usize, GraphicsObjectParent>,
    foreground_parents: BTreeMap<usize, GraphicsObjectParent>,
}

impl GraphicsObjectStack {
    /// Construct an empty stack: all three render layers have 256
    /// `None` slots.
    pub fn new() -> Self {
        Self {
            display_commands: (0..GRAPHICS_OBJECT_SLOT_COUNT).map(|_| None).collect(),
            background_objects: (0..GRAPHICS_OBJECT_SLOT_COUNT).map(|_| None).collect(),
            foreground_objects: (0..GRAPHICS_OBJECT_SLOT_COUNT).map(|_| None).collect(),
            background_parents: BTreeMap::new(),
            foreground_parents: BTreeMap::new(),
        }
    }

    fn parents(&self, plane: GraphicsPlane) -> &BTreeMap<usize, GraphicsObjectParent> {
        match plane {
            GraphicsPlane::Background => &self.background_parents,
            GraphicsPlane::Foreground => &self.foreground_parents,
        }
    }

    fn parents_mut(&mut self, plane: GraphicsPlane) -> &mut BTreeMap<usize, GraphicsObjectParent> {
        match plane {
            GraphicsPlane::Background => &mut self.background_parents,
            GraphicsPlane::Foreground => &mut self.foreground_parents,
        }
    }

    fn materialize_parent_object(
        &mut self,
        plane: GraphicsPlane,
        parent: usize,
    ) -> Option<&mut GraphicsObject> {
        let layer = GraphicsLayer::from_plane(plane);
        if self.get_layer(layer, parent).is_none() {
            self.set_layer(layer, parent, GraphicsObject::image(""))
                .ok()?;
        }
        self.get_layer_mut(layer, parent)
    }

    fn layer_slice(&self, layer: GraphicsLayer) -> &[Option<GraphicsObject>] {
        match layer {
            GraphicsLayer::DisplayCommand => &self.display_commands,
            GraphicsLayer::BackgroundObject => &self.background_objects,
            GraphicsLayer::ForegroundObject => &self.foreground_objects,
        }
    }

    fn layer_slice_mut(&mut self, layer: GraphicsLayer) -> &mut [Option<GraphicsObject>] {
        match layer {
            GraphicsLayer::DisplayCommand => &mut self.display_commands,
            GraphicsLayer::BackgroundObject => &mut self.background_objects,
            GraphicsLayer::ForegroundObject => &mut self.foreground_objects,
        }
    }

    /// Store `object` at `(plane, slot)`. Overwrites whatever was
    /// there. Returns [`GraphicsStackError::SlotOutOfRange`] if `slot
    /// >= 256`.
    pub fn set(
        &mut self,
        plane: GraphicsPlane,
        slot: usize,
        object: GraphicsObject,
    ) -> Result<(), GraphicsStackError> {
        self.set_layer(GraphicsLayer::from_plane(plane), slot, object)
            .map_err(|_| GraphicsStackError::SlotOutOfRange { plane, slot })
    }

    /// Store `object` at `(layer, slot)`. Overwrites whatever was
    /// there. Returns [`GraphicsStackError::SlotOutOfRange`] if `slot
    /// >= 256`.
    pub fn set_layer(
        &mut self,
        layer: GraphicsLayer,
        slot: usize,
        object: GraphicsObject,
    ) -> Result<(), GraphicsStackError> {
        if slot >= GRAPHICS_OBJECT_SLOT_COUNT {
            return Err(GraphicsStackError::SlotOutOfRange {
                plane: layer.diagnostic_plane(),
                slot,
            });
        }
        self.layer_slice_mut(layer)[slot] = Some(object);
        Ok(())
    }

    /// Free `(plane, slot)` (sets it to `None`). No-op if already
    /// `None`. Returns [`GraphicsStackError::SlotOutOfRange`] if `slot
    /// >= 256`.
    pub fn clear(&mut self, plane: GraphicsPlane, slot: usize) -> Result<(), GraphicsStackError> {
        self.clear_layer(GraphicsLayer::from_plane(plane), slot)
            .map_err(|_| GraphicsStackError::SlotOutOfRange { plane, slot })
    }

    /// Free `(layer, slot)` (sets it to `None`). No-op if already
    /// `None`. Returns [`GraphicsStackError::SlotOutOfRange`] if `slot
    /// >= 256`.
    pub fn clear_layer(
        &mut self,
        layer: GraphicsLayer,
        slot: usize,
    ) -> Result<(), GraphicsStackError> {
        if slot >= GRAPHICS_OBJECT_SLOT_COUNT {
            return Err(GraphicsStackError::SlotOutOfRange {
                plane: layer.diagnostic_plane(),
                slot,
            });
        }
        self.layer_slice_mut(layer)[slot] = None;
        Ok(())
    }

    /// Borrow the object at `(plane, slot)`, or `None` if the slot is
    /// free or out of range.
    pub fn get(&self, plane: GraphicsPlane, slot: usize) -> Option<&GraphicsObject> {
        self.get_layer(GraphicsLayer::from_plane(plane), slot)
    }

    /// Borrow the object at `(layer, slot)`, or `None` if the slot is
    /// free or out of range.
    pub fn get_layer(&self, layer: GraphicsLayer, slot: usize) -> Option<&GraphicsObject> {
        if slot >= GRAPHICS_OBJECT_SLOT_COUNT {
            return None;
        }
        self.layer_slice(layer)[slot].as_ref()
    }

    /// Mutably borrow the object at `(plane, slot)`, or `None` if the
    /// slot is free or out of range.
    pub fn get_mut(&mut self, plane: GraphicsPlane, slot: usize) -> Option<&mut GraphicsObject> {
        self.get_layer_mut(GraphicsLayer::from_plane(plane), slot)
    }

    /// Mutably borrow the object at `(layer, slot)`, or `None` if the
    /// slot is free or out of range.
    pub fn get_layer_mut(
        &mut self,
        layer: GraphicsLayer,
        slot: usize,
    ) -> Option<&mut GraphicsObject> {
        if slot >= GRAPHICS_OBJECT_SLOT_COUNT {
            return None;
        }
        self.layer_slice_mut(layer)[slot].as_mut()
    }

    pub fn target(&self, target: GraphicsObjectTarget) -> Option<&GraphicsObject> {
        match target {
            GraphicsObjectTarget::TopLevel { layer, slot } => self.get_layer(layer, slot),
            GraphicsObjectTarget::Child {
                plane,
                parent,
                child,
            } => self.parents(plane).get(&parent)?.children.get(&child),
        }
    }

    pub fn target_mut(&mut self, target: GraphicsObjectTarget) -> Option<&mut GraphicsObject> {
        match target {
            GraphicsObjectTarget::TopLevel { layer, slot } => self.get_layer_mut(layer, slot),
            GraphicsObjectTarget::Child {
                plane,
                parent,
                child,
            } => self
                .parents_mut(plane)
                .get_mut(&parent)?
                .children
                .get_mut(&child),
        }
    }

    pub fn create_parent(
        &mut self,
        plane: GraphicsPlane,
        parent: usize,
        declared_capacity: usize,
        visible: Option<bool>,
        position: Option<GraphicsPosition>,
    ) -> bool {
        if parent >= GRAPHICS_OBJECT_SLOT_COUNT {
            return false;
        }
        let Some(object) = self.materialize_parent_object(plane, parent) else {
            return false;
        };
        if let Some(visible) = visible {
            object.visible = visible;
        }
        if let Some(position) = position {
            object.position = position;
        }
        self.parents_mut(plane)
            .insert(parent, GraphicsObjectParent::new(declared_capacity));
        true
    }

    pub fn set_child(
        &mut self,
        plane: GraphicsPlane,
        parent: usize,
        child: usize,
        object: GraphicsObject,
    ) -> bool {
        if parent >= GRAPHICS_OBJECT_SLOT_COUNT {
            return false;
        }
        let capacity = self
            .parents(plane)
            .get(&parent)
            .map_or(GRAPHICS_OBJECT_SLOT_COUNT, |entry| entry.declared_capacity);
        if child >= capacity {
            return false;
        }
        if self.materialize_parent_object(plane, parent).is_none() {
            return false;
        }
        self.parents_mut(plane)
            .entry(parent)
            .or_insert_with(|| GraphicsObjectParent::new(GRAPHICS_OBJECT_SLOT_COUNT))
            .children
            .insert(child, object);
        true
    }

    pub fn parent(&self, plane: GraphicsPlane, parent: usize) -> Option<&GraphicsObjectParent> {
        self.parents(plane).get(&parent)
    }

    /// Number of allocated slots on `plane`.
    pub fn plane_len(&self, plane: GraphicsPlane) -> usize {
        self.layer_len(GraphicsLayer::from_plane(plane))
    }

    /// Number of allocated slots on `layer`.
    pub fn layer_len(&self, layer: GraphicsLayer) -> usize {
        self.layer_slice(layer)
            .iter()
            .filter(|s| s.is_some())
            .count()
    }

    /// Total allocated slot count across all render layers.
    pub fn len(&self) -> usize {
        self.layer_len(GraphicsLayer::DisplayCommand)
            + self.layer_len(GraphicsLayer::BackgroundObject)
            + self.layer_len(GraphicsLayer::ForegroundObject)
    }

    /// True iff no slots are allocated on any render layer.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Iterate `(plane, slot, &GraphicsObject)` over **allocated**
    /// slots only, projected through the legacy two-plane API. The
    /// render pass uses [`Self::iter_allocated_layers`] instead so bg
    /// objects and fg objects with the same slot stay distinct.
    pub fn iter_allocated(&self) -> impl Iterator<Item = (GraphicsPlane, usize, &GraphicsObject)> {
        self.iter_allocated_layers()
            .map(|(layer, slot, object)| (layer.diagnostic_plane(), slot, object))
    }

    /// Iterate `(layer, slot, &GraphicsObject)` over allocated slots in
    /// deterministic compositor-layer order.
    pub fn iter_allocated_layers(
        &self,
    ) -> impl Iterator<Item = (GraphicsLayer, usize, &GraphicsObject)> {
        let layers = [
            GraphicsLayer::DisplayCommand,
            GraphicsLayer::BackgroundObject,
            GraphicsLayer::ForegroundObject,
        ];
        layers.into_iter().flat_map(move |layer| {
            self.layer_slice(layer)
                .iter()
                .enumerate()
                .filter_map(move |(slot, entry)| entry.as_ref().map(|object| (layer, slot, object)))
        })
    }
}

impl Default for GraphicsObjectStack {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kernel_input() -> DstRectKernelInput {
        DstRectKernelInput {
            surface: [11.0, 7.0],
            child_position: [100.0, 50.0],
            child_adjust: [18.0, 7.0],
            origin: [0.0, 5.0],
            child_factor: [1.3, 0.7],
            parent: None,
        }
    }

    #[test]
    fn dst_rect_kernel_pins_oracle_order_and_truncation() {
        // rlvm `DstRect` hand-trace (no parent), src=(11,7):
        //   center_x = trunc(100 + 18 - 0 + 11/2=5.5) = trunc(123.5) = 123
        //   half_x = trunc(11 * 1 * 1.3 / 2 = 7.15) = 7
        //   x = 123 - 7 = 116; width = 2*7 = 14
        //   center_y = trunc(50 + 7 - 5 + 7/2=3.5) = trunc(55.5) = 55
        //   half_y = trunc(7 * 1 * 0.7 / 2 = 2.45) = 2
        //   y = 55 - 2 = 53; height = 2*2 = 4
        assert_eq!(
            derive_dst_rect(kernel_input()),
            Ok(HitRect {
                x: 116,
                y: 53,
                width: 14,
                height: 4,
            })
        );
        // rlvm `DstRect` hand-trace WITH a parent — the y axis is the
        // discriminating case for the separate `center` truncation:
        //   center_y_core = -10 + 2 - (-2) + 7/2=3.5 = -2.5; trunc(-2.5) = -2
        //   center_y = -2 + parent.y(50) + parent.adj(8) = 56
        //   half_y = trunc(7 * (2.0*0.75=1.5) * (0.8*0.5=0.4) / 2 = 2.1) = 2
        //   y = 56 - 2 = 54 (folding parent into the pre-trunc sum would give
        //   trunc(-2.5 + 58 - 2.1) = trunc(53.4) = 53, which is WRONG).
        //   center_x_core = 20 + 6 - 3 + 5.5 = 28.5; trunc = 28
        //   center_x = 28 + 100 + (-5) = 123; half_x = trunc(11*0.75*1.8/2=7.425)=7
        //   x = 123 - 7 = 116; width = 2*7 = 14; height = 2*2 = 4
        assert_eq!(
            derive_dst_rect(DstRectKernelInput {
                surface: [11.0, 7.0],
                child_position: [20.0, -10.0],
                child_adjust: [6.0, 2.0],
                origin: [3.0, -2.0],
                child_factor: [1.5 * 1.2, 0.8 * 0.5],
                parent: Some(DstRectKernelParent {
                    position: [100.0, 50.0],
                    adjust: [-5.0, 8.0],
                    factor: [0.5 * 1.5, 2.0 * 0.75],
                }),
            }),
            Ok(HitRect {
                x: 116,
                y: 54,
                width: 14,
                height: 4,
            })
        );
        // Discriminates rlvm's SEPARATE center/half truncation from a single
        // `trunc(center - half)`. src=(10,10), scale 0.3, no parent:
        //   center = trunc(0 + 0 - 0 + 10/2=5.0) = 5
        //   half = trunc(10 * 1 * 0.3 / 2 = 1.5) = 1
        //   x = y = 5 - 1 = 4; width = height = 2*1 = 2
        // A single-truncation kernel yields trunc(5.0 - 1.5)=trunc(3.5)=3 (WRONG).
        assert_eq!(
            derive_dst_rect(DstRectKernelInput {
                surface: [10.0, 10.0],
                child_position: [0.0, 0.0],
                child_adjust: [0.0, 0.0],
                origin: [0.0, 0.0],
                child_factor: [0.3, 0.3],
                parent: None,
            }),
            Ok(HitRect {
                x: 4,
                y: 4,
                width: 2,
                height: 2,
            })
        );
        let mut negative = kernel_input();
        negative.child_factor = [-0.5, 0.5];
        let rect = derive_dst_rect(negative).expect("finite signed rectangle");
        assert_eq!((rect.width, rect.height), (-4, 2));
        let mut nonfinite = kernel_input();
        nonfinite.surface[0] = f32::NAN;
        assert_eq!(
            derive_dst_rect(nonfinite),
            Err(HitRegionUnavailable::NonFiniteTransform)
        );
        let mut out_of_range = kernel_input();
        out_of_range.child_factor[0] = 1_000_000_000.0;
        assert_eq!(
            derive_dst_rect(out_of_range),
            Err(HitRegionUnavailable::OutOfRangeTransform)
        );
    }

    #[test]
    fn object_geometry_uses_explicit_child_surface_only() {
        let mut child = GraphicsObject::image("child");
        child.position = GraphicsPosition { x: 100, y: 50 };
        child.geometry.surface = Some(SurfaceGeometry {
            width: 20,
            height: 10,
            origin: GraphicsPosition { x: 4, y: 2 },
        });
        child.geometry.adjust_slots[0] = GraphicsPosition { x: 17, y: 2 };
        child.geometry.hq_thousandths = GraphicsScale {
            x_thousandths: 700,
            y_thousandths: 400,
        };
        assert_eq!(
            child.hit_region(None),
            HitRegion::Known(HitRect {
                x: 116,
                y: 53,
                width: 14,
                height: 4,
            })
        );
        let snapshot = child.clone();
        for adjust in &mut child.geometry.adjust_slots {
            adjust.x += 1;
            adjust.y += 1;
        }
        assert_eq!(
            child.hit_region(None),
            HitRegion::Known(HitRect {
                x: 124,
                y: 61,
                width: 14,
                height: 4,
            })
        );
        child.geometry.origin_override = Some(GraphicsPosition::ORIGIN);
        assert_ne!(child.hit_region(None), snapshot.hit_region(None));
        assert_eq!(snapshot.geometry.origin_override, None);

        let mut parent = GraphicsObject::image("parent");
        parent.position = GraphicsPosition { x: 3, y: -2 };
        parent.geometry.adjust_slots[7] = GraphicsPosition { x: 1, y: 2 };
        assert_ne!(
            snapshot.hit_region(None),
            snapshot.hit_region(Some(&parent))
        );
        let unknown = GraphicsObject::image("asset-only");
        assert_eq!(
            unknown.hit_region(Some(&parent)),
            HitRegion::Unavailable(HitRegionUnavailable::AssetPatternGeometryUnavailable)
        );
        assert_eq!(
            GraphicsObject::image("text").geometry.unavailable,
            HitRegionUnavailable::AssetPatternGeometryUnavailable
        );
    }

    #[test]
    fn new_stack_is_empty() {
        let stack = GraphicsObjectStack::new();
        assert_eq!(stack.len(), 0);
        assert!(stack.is_empty());
        assert_eq!(stack.plane_len(GraphicsPlane::Background), 0);
        assert_eq!(stack.plane_len(GraphicsPlane::Foreground), 0);
    }

    #[test]
    fn slot_at_capacity_is_rejected() {
        let mut stack = GraphicsObjectStack::new();
        let result = stack.set(
            GraphicsPlane::Foreground,
            GRAPHICS_OBJECT_SLOT_COUNT,
            GraphicsObject::wipe(WipeColour::BLACK),
        );
        assert_eq!(
            result,
            Err(GraphicsStackError::SlotOutOfRange {
                plane: GraphicsPlane::Foreground,
                slot: GRAPHICS_OBJECT_SLOT_COUNT,
            })
        );
        assert_eq!(stack.len(), 0);
    }

    #[test]
    fn fills_full_plane_then_rejects_next() {
        let mut stack = GraphicsObjectStack::new();
        for slot in 0..GRAPHICS_OBJECT_SLOT_COUNT {
            stack
                .set(
                    GraphicsPlane::Foreground,
                    slot,
                    GraphicsObject::image(format!("asset-{slot}")),
                )
                .expect("in-range slot accepted");
        }
        assert_eq!(stack.plane_len(GraphicsPlane::Foreground), 256);
        assert_eq!(stack.plane_len(GraphicsPlane::Background), 0);
        let result = stack.set(
            GraphicsPlane::Foreground,
            GRAPHICS_OBJECT_SLOT_COUNT,
            GraphicsObject::image("overflow"),
        );
        assert!(matches!(
            result,
            Err(GraphicsStackError::SlotOutOfRange { .. })
        ));
    }

    #[test]
    fn iter_allocated_visits_background_before_foreground() {
        let mut stack = GraphicsObjectStack::new();
        stack
            .set(GraphicsPlane::Foreground, 5, GraphicsObject::image("fg5"))
            .expect("set fg");
        stack
            .set(GraphicsPlane::Background, 9, GraphicsObject::image("bg9"))
            .expect("set bg");
        let visited: Vec<(GraphicsPlane, usize)> = stack
            .iter_allocated()
            .map(|(plane, slot, _)| (plane, slot))
            .collect();
        assert_eq!(
            visited,
            vec![
                (GraphicsPlane::Background, 9),
                (GraphicsPlane::Foreground, 5),
            ]
        );
    }

    #[test]
    fn bg_and_fg_object_layers_can_share_slot_number() {
        let mut stack = GraphicsObjectStack::new();
        stack
            .set_layer(
                GraphicsLayer::BackgroundObject,
                7,
                GraphicsObject::image("bg-object"),
            )
            .expect("set bg object");
        stack
            .set_layer(
                GraphicsLayer::ForegroundObject,
                7,
                GraphicsObject::image("fg-object"),
            )
            .expect("set fg object");

        assert_eq!(stack.len(), 2);
        assert_eq!(stack.layer_len(GraphicsLayer::BackgroundObject), 1);
        assert_eq!(stack.layer_len(GraphicsLayer::ForegroundObject), 1);
        assert_eq!(
            stack
                .get_layer(GraphicsLayer::BackgroundObject, 7)
                .and_then(|object| match &object.kind {
                    GraphicsObjectKind::Image { image_ref } => Some(image_ref.asset_key.as_str()),
                    GraphicsObjectKind::Wipe { .. } => None,
                }),
            Some("bg-object")
        );
        assert_eq!(
            stack
                .get_layer(GraphicsLayer::ForegroundObject, 7)
                .and_then(|object| match &object.kind {
                    GraphicsObjectKind::Image { image_ref } => Some(image_ref.asset_key.as_str()),
                    GraphicsObjectKind::Wipe { .. } => None,
                }),
            Some("fg-object")
        );
    }

    #[test]
    fn clear_frees_a_slot() {
        let mut stack = GraphicsObjectStack::new();
        stack
            .set(GraphicsPlane::Foreground, 7, GraphicsObject::image("a"))
            .expect("set");
        assert_eq!(stack.plane_len(GraphicsPlane::Foreground), 1);
        stack
            .clear(GraphicsPlane::Foreground, 7)
            .expect("clear in range");
        assert_eq!(stack.plane_len(GraphicsPlane::Foreground), 0);
        assert!(stack.get(GraphicsPlane::Foreground, 7).is_none());
    }

    #[test]
    fn slot_total_constant_matches_three_render_layers() {
        assert_eq!(GRAPHICS_OBJECT_TOTAL_SLOTS, GRAPHICS_OBJECT_SLOT_COUNT * 3);
    }
}
