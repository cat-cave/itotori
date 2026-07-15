use super::*;

// object setters — Move / Alpha / Show / Layer / PattNo / tone / scale

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
    /// Classic `Scale` (1046): (buf, width%, height%).
    Scale,
    /// Classic `Width` (1047): (buf, width%).
    Width,
    /// Classic `Height` (1048): (buf, height%).
    Height,
    /// `Adjust` (1006): (buf, repno, x, y).
    Adjust,
    AdjustX,
    AdjustY,
    /// `Origin` (1053): (buf, x, y).
    Origin,
    OriginX,
    OriginY,
    /// High-quality `Scale` (1061): (buf, width‰, height‰).
    HqScale,
    HqScaleX,
    HqScaleY,
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
            Self::AdjustX => "obj.adjustX",
            Self::AdjustY => "obj.adjustY",
            Self::Origin => "obj.origin",
            Self::OriginX => "obj.originX",
            Self::OriginY => "obj.originY",
            Self::HqScale => "obj.hqScale",
            Self::HqScaleX => "obj.hqScaleX",
            Self::HqScaleY => "obj.hqScaleY",
        }
    }
}

/// An object-setter op bound to a plane + property.
#[derive(Debug)]
pub struct ObjSetOp {
    runtime: Arc<GraphicsRuntime>,
    prop: ObjSetProp,
    plane: GraphicsPlane,
    layer: GraphicsLayer,
    layer_base: i32,
    child_addressed: bool,
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
            plane,
            layer: object_layer(plane),
            layer_base,
            child_addressed: false,
        }
    }

    pub fn new_child(
        runtime: Arc<GraphicsRuntime>,
        plane: GraphicsPlane,
        prop: ObjSetProp,
    ) -> Self {
        let mut op = Self::new(runtime, plane, prop);
        op.child_addressed = true;
        op
    }
}

impl RLOperation for ObjSetOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (target, args, slot) = if self.child_addressed {
            let Some(parent) = arg_int(args, 0).and_then(slot_ok) else {
                return DispatchOutcome::Advance;
            };
            let Some(child) = arg_int(args, 1).and_then(slot_ok) else {
                return DispatchOutcome::Advance;
            };
            (
                GraphicsObjectTarget::Child {
                    plane: self.plane,
                    parent,
                    child,
                },
                &args[1..],
                child,
            )
        } else {
            let Some(slot) = arg_int(args, 0).and_then(slot_ok) else {
                return DispatchOutcome::Advance;
            };
            (
                GraphicsObjectTarget::TopLevel {
                    layer: self.layer,
                    slot,
                },
                args,
                slot,
            )
        };
        let prop = self.prop;
        let layer_base = self.layer_base;
        let observed = self.runtime.with_stack_mut(|stack| {
            let Some(o) = stack.target_mut(target) else {
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
                    o.geometry.classic_percent.x_percent = arg_int(args, 1).unwrap_or(100);
                    o.geometry.classic_percent.y_percent = arg_int(args, 2).unwrap_or(100);
                    o.sync_render_scale_from_geometry();
                }
                ObjSetProp::Width => {
                    o.geometry.classic_percent.x_percent = arg_int(args, 1).unwrap_or(100);
                    o.sync_render_scale_from_geometry();
                }
                ObjSetProp::Height => {
                    o.geometry.classic_percent.y_percent = arg_int(args, 1).unwrap_or(100);
                    o.sync_render_scale_from_geometry();
                }
                ObjSetProp::Adjust => {
                    if let Some(slot) =
                        arg_int(args, 1).and_then(|value| usize::try_from(value).ok())
                        && let Some(adjust) = o.geometry.adjust_slots.get_mut(slot)
                    {
                        adjust.x = arg_int(args, 2).unwrap_or(adjust.x);
                        adjust.y = arg_int(args, 3).unwrap_or(adjust.y);
                    }
                }
                ObjSetProp::AdjustX | ObjSetProp::AdjustY => {
                    if let Some(slot) =
                        arg_int(args, 1).and_then(|value| usize::try_from(value).ok())
                        && let Some(adjust) = o.geometry.adjust_slots.get_mut(slot)
                    {
                        if matches!(prop, ObjSetProp::AdjustX) {
                            adjust.x = arg_int(args, 2).unwrap_or(adjust.x);
                        } else {
                            adjust.y = arg_int(args, 2).unwrap_or(adjust.y);
                        }
                    }
                }
                ObjSetProp::Origin | ObjSetProp::OriginX | ObjSetProp::OriginY => {
                    let mut origin = o
                        .geometry
                        .origin_override
                        .or(o.geometry.surface.map(|surface| surface.origin))
                        .unwrap_or(crate::graphics_objects::GraphicsPosition::ORIGIN);
                    match prop {
                        ObjSetProp::Origin => {
                            origin.x = arg_int(args, 1).unwrap_or(origin.x);
                            origin.y = arg_int(args, 2).unwrap_or(origin.y);
                        }
                        ObjSetProp::OriginX => origin.x = arg_int(args, 1).unwrap_or(origin.x),
                        ObjSetProp::OriginY => origin.y = arg_int(args, 1).unwrap_or(origin.y),
                        _ => unreachable!("origin property matched above"),
                    }
                    o.geometry.origin_override = Some(origin);
                }
                ObjSetProp::HqScale => {
                    o.geometry.hq_thousandths = GraphicsScale {
                        x_thousandths: arg_int(args, 1).unwrap_or(1000),
                        y_thousandths: arg_int(args, 2).unwrap_or(1000),
                    };
                    o.sync_render_scale_from_geometry();
                }
                ObjSetProp::HqScaleX => {
                    o.geometry.hq_thousandths.x_thousandths = arg_int(args, 1).unwrap_or(1000);
                    o.sync_render_scale_from_geometry();
                }
                ObjSetProp::HqScaleY => {
                    o.geometry.hq_thousandths.y_thousandths = arg_int(args, 1).unwrap_or(1000);
                    o.sync_render_scale_from_geometry();
                }
            }
            true
        });
        if !observed {
            warn(&self.runtime, prop.tag(), slot);
        }
        DispatchOutcome::Advance
    }
}
