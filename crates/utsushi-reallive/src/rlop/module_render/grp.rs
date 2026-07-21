use std::sync::Arc;

use super::{
    DispatchOutcome, ExprValue, RLOperation, SCREEN_DC_SLOT, arg_bytes, arg_int, clamp_byte,
    decode_shift_jis, slot_ok, warn,
};
use crate::graphics_objects::{
    GraphicsAlpha, GraphicsColourTone, GraphicsLayer, GraphicsObject, WipeColour,
};
use crate::rlop::module_obj::{FadeLongOp, GraphicsRuntime, GraphicsRuntimeWarning};
use crate::vm::Vm;

// module_grp — DC / background graphics (module_id 33)

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
        self.runtime
            .route_stack_result(self.runtime.with_stack_mut(|stack| {
                let mut object = GraphicsObject::image(name.clone());
                object.visible = visible;
                stack.set_layer(GraphicsLayer::DisplayCommand, slot, object)
            }));
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
                    self.runtime
                        .route_stack_result(self.runtime.with_stack_mut(|stack| {
                            let mut o = GraphicsObject::wipe(WipeColour::TRANSPARENT);
                            o.visible = slot == SCREEN_DC_SLOT;
                            stack.set_layer(GraphicsLayer::DisplayCommand, slot, o)
                        }));
                }
                DispatchOutcome::Advance
            }
            GrpOp::FreeDc => {
                if let Some(slot) = arg_int(args, 0).and_then(slot_ok) {
                    self.runtime
                        .route_stack_result(self.runtime.with_stack_mut(|stack| {
                            stack.clear_layer(GraphicsLayer::DisplayCommand, slot)
                        }));
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
                self.runtime
                    .route_stack_result(self.runtime.with_stack_mut(|stack| {
                        let mut o = GraphicsObject::wipe(colour);
                        o.visible = dc == SCREEN_DC_SLOT;
                        stack.set_layer(GraphicsLayer::DisplayCommand, dc, o)
                    }));
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
                // grpMulti(filename,...): base image to DC0; overlays gap.
                self.load_image_to(args, SCREEN_DC_SLOT, true)
            }
            GrpOp::Display => {
                // grpDisplay(dc, effect): copy off-screen dc → DC0 (screen).
                let Some(dc) = arg_int(args, 0).and_then(slot_ok) else {
                    return DispatchOutcome::Advance;
                };
                let outcome = self.runtime.with_stack_mut(|stack| {
                    if let Some(src) = stack.get_layer(GraphicsLayer::DisplayCommand, dc).cloned() {
                        let mut shown = src;
                        shown.visible = true;
                        stack
                            .set_layer(GraphicsLayer::DisplayCommand, SCREEN_DC_SLOT, shown)
                            .map(|()| true)
                    } else {
                        Ok(false)
                    }
                });
                match outcome {
                    Ok(false) => warn(&self.runtime, self.op.tag(), dc),
                    Ok(true) => {}
                    Err(error) => self.runtime.route_stack_error(error),
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
                let outcome = self.runtime.with_stack_mut(|stack| {
                    if let Some(o) = stack.get_layer(GraphicsLayer::DisplayCommand, src).cloned() {
                        stack
                            .set_layer(GraphicsLayer::DisplayCommand, dst, o)
                            .map(|()| true)
                    } else {
                        Ok(false)
                    }
                });
                match outcome {
                    Ok(false) => {
                        self.runtime.push_warning(
                            GraphicsRuntimeWarning::CopyFromEmptySlot { slot: src }
                                .with_opcode(self.op.tag()),
                        );
                    }
                    Ok(true) => {}
                    Err(error) => self.runtime.route_stack_error(error),
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
                // grpFade(dc?, target_alpha?,...) — fade DC0 to a target.
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
