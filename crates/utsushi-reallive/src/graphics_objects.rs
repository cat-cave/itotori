//! UTSUSHI-214 — graphics object stack (headless render pipeline).
//!
//! Implements the rlvm `GraphicsSystem` equivalent: a stack of
//! **256 graphics objects per render layer × 3 layers** (`DCs` +
//! `BackgroundObject` + `ForegroundObject`) addressed by `(layer, slot)`.
//! Each object carries
//! `(position, scale, alpha, colour_tone, image_ref, layer_order, kind)`
//! state.
//!
//! The stack is **purely state**: the headless render-pipeline at
//! [`crate::render_pipeline`] walks the stack, sorted by `(render layer,
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
//! The object-state shape (`position`, `scale`, `alpha`, `colour_tone`,
//! `image_ref`, `layer_order`) is re-derived from the publicly-archived
//! RLDEV format documentation (Haeleth's RLDEV site) plus the
//! UTSUSHI-216 g00 decoder's [`crate::G00Image`] surface. No rlvm
//! source is vendored, linked, or mechanically translated, per the
//! crate-wide
//! [`crate::RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`].

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
/// through the render pass's bound [`utsushi_core::substrate::AssetPackage`],
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

/// One graphics object slot. The state is intentionally `pub` so audit
/// tooling can introspect a slot without going through accessors. A
/// slot is either `Some(GraphicsObject { ... })` (allocated) or
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
    /// Visibility flag (`objShow` / `objHide` in UTSUSHI-215). The
    /// render pass skips invisible objects without dereferencing their
    /// image refs.
    pub visible: bool,
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
            visible: true,
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
            visible: true,
        }
    }
}

/// Typed errors surfaced by [`GraphicsObjectStack::allocate`] /
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
}

impl GraphicsObjectStack {
    /// Construct an empty stack: all three render layers have 256
    /// `None` slots.
    pub fn new() -> Self {
        Self {
            display_commands: (0..GRAPHICS_OBJECT_SLOT_COUNT).map(|_| None).collect(),
            background_objects: (0..GRAPHICS_OBJECT_SLOT_COUNT).map(|_| None).collect(),
            foreground_objects: (0..GRAPHICS_OBJECT_SLOT_COUNT).map(|_| None).collect(),
        }
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
