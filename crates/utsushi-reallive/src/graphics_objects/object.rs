use super::*;

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
