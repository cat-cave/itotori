use super::super::super::{DispatchOutcome, ExprValue, RLOperation};
use super::button_bindings;
use super::runtime::GraphicsRuntime;
use crate::graphics_objects::{ButtonOptions, GraphicsLayer, GraphicsObjectTarget, GraphicsPlane};
use crate::vm::Vm;
use std::sync::Arc;

/// `objButtonOpts` (`obj (1,{81,82},1064)`) binds the authoritative
/// `(buf, action, se, group, button_number)` tuple to the exact graphics
/// object at `(plane, buf)`. Bad shapes, invalid slots, and empty slots fail
/// soft without creating a binding. The current foreground-only group query
/// is an inspection seam; select/resume mapping and rendering stay separate.
#[derive(Debug)]
pub struct ObjButtonOptsOp {
    runtime: Arc<GraphicsRuntime>,
    plane: GraphicsPlane,
    child_addressed: bool,
}

impl ObjButtonOptsOp {
    pub fn new(runtime: Arc<GraphicsRuntime>, plane: GraphicsPlane) -> Self {
        Self {
            runtime,
            plane,
            child_addressed: false,
        }
    }

    pub fn new_child(runtime: Arc<GraphicsRuntime>, plane: GraphicsPlane) -> Self {
        Self {
            runtime,
            plane,
            child_addressed: true,
        }
    }
}

impl RLOperation for ObjButtonOptsOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (target, args) = if self.child_addressed {
            let Some(parent) = args.first().and_then(ExprValue::as_int).and_then(|value| {
                usize::try_from(value)
                    .ok()
                    .filter(|&slot| slot < crate::graphics_objects::GRAPHICS_OBJECT_SLOT_COUNT)
            }) else {
                return DispatchOutcome::Advance;
            };
            let Some(child) = args.get(1).and_then(ExprValue::as_int).and_then(|value| {
                usize::try_from(value)
                    .ok()
                    .filter(|&slot| slot < crate::graphics_objects::GRAPHICS_OBJECT_SLOT_COUNT)
            }) else {
                return DispatchOutcome::Advance;
            };
            (
                GraphicsObjectTarget::Child {
                    plane: self.plane,
                    parent,
                    child,
                },
                &args[1..],
            )
        } else {
            let Some(slot) = args
                .first()
                .and_then(ExprValue::as_int)
                .and_then(|value| usize::try_from(value).ok())
            else {
                return DispatchOutcome::Advance;
            };
            let layer = match self.plane {
                GraphicsPlane::Foreground => GraphicsLayer::ForegroundObject,
                GraphicsPlane::Background => GraphicsLayer::BackgroundObject,
            };
            (GraphicsObjectTarget::TopLevel { layer, slot }, args)
        };
        let Some(values) = args
            .iter()
            .map(ExprValue::as_int)
            .collect::<Option<Vec<_>>>()
        else {
            return DispatchOutcome::Advance;
        };
        let Some((action, se, group, button_number)) = button_bindings::button_opts_tuple(&values)
        else {
            return DispatchOutcome::Advance;
        };
        self.runtime.with_stack_mut(|stack| {
            if let Some(object) = stack.target_mut(target) {
                object.button_options = Some(ButtonOptions {
                    action,
                    se,
                    group,
                    button_number,
                });
            }
        });
        DispatchOutcome::Advance
    }
}
