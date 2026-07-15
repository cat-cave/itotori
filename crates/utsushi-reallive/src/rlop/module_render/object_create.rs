use super::*;

// object creation — objOfFile & friends (module_id 71 fg / 72 bg)

/// Object CREATION op (`objOfFile` and the placeholder-modelled
/// text/digit/drift/gan/area/child variants). Loads an image into an
/// object slot on the op's plane, applying any trailing
/// `(visible, x, y, pattern)` args per rlvm's `objGeneric_*` templates.
#[derive(Debug)]
pub struct ObjCreateOp {
    runtime: Arc<GraphicsRuntime>,
    plane: GraphicsPlane,
    provenance: ImageProvenance,
}

impl ObjCreateOp {
    pub fn new(runtime: Arc<GraphicsRuntime>, plane: GraphicsPlane) -> Self {
        Self::with_provenance(runtime, plane, ImageProvenance::FileBacked)
    }

    pub(super) fn with_provenance(
        runtime: Arc<GraphicsRuntime>,
        plane: GraphicsPlane,
        provenance: ImageProvenance,
    ) -> Self {
        Self {
            runtime,
            plane,
            provenance,
        }
    }
}

fn created_object(
    plane: GraphicsPlane,
    args: &[ExprValue],
    provenance: ImageProvenance,
) -> Option<(usize, GraphicsObject)> {
    let buf = arg_int(args, 0).and_then(slot_ok)?;
    let name = arg_bytes(args, 1)
        .and_then(decode_shift_jis)
        .filter(|name| !name.is_empty() && name != "???");
    let mut object = GraphicsObject::image(name.unwrap_or_default());
    object.image_provenance = provenance;
    object.layer_order = match plane {
        GraphicsPlane::Foreground => OBJ_FG_LAYER_BASE + buf as i32,
        GraphicsPlane::Background => OBJ_BG_LAYER_BASE + buf as i32,
    };
    if let Some(visible) = arg_int(args, 2) {
        object.visible = visible != 0;
    }
    if let (Some(x), Some(y)) = (arg_int(args, 3), arg_int(args, 4)) {
        object.position = crate::graphics_objects::GraphicsPosition { x, y };
    }
    if let (Some(pattern), GraphicsObjectKind::Image { image_ref }) =
        (arg_int(args, 5), &mut object.kind)
    {
        image_ref.region_index = Some(pattern.max(0) as u32);
    }
    Some((buf, object))
}

impl RLOperation for ObjCreateOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        // objGeneric_*: (buf, filename[, visible, x, y, pattern, …]).
        let Some((buf, object)) = created_object(self.plane, args, self.provenance) else {
            self.runtime
                .push_warning(GraphicsRuntimeWarning::MissingArg {
                    opcode_tag: "obj.objOfFile",
                    slot: "buf",
                });
            return DispatchOutcome::Advance;
        };
        let layer = object_layer(self.plane);
        self.runtime.with_stack_mut(|stack| {
            let _ = stack.set_layer(layer, buf, object);
        });
        DispatchOutcome::Advance
    }
}

#[derive(Debug)]
pub struct ChildCreateOp {
    runtime: Arc<GraphicsRuntime>,
    plane: GraphicsPlane,
    provenance: ImageProvenance,
}

impl ChildCreateOp {
    pub fn new(runtime: Arc<GraphicsRuntime>, plane: GraphicsPlane) -> Self {
        Self::with_provenance(runtime, plane, ImageProvenance::FileBacked)
    }

    pub(super) fn with_provenance(
        runtime: Arc<GraphicsRuntime>,
        plane: GraphicsPlane,
        provenance: ImageProvenance,
    ) -> Self {
        Self {
            runtime,
            plane,
            provenance,
        }
    }
}

impl RLOperation for ChildCreateOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let Some(parent) = arg_int(args, 0).and_then(slot_ok) else {
            return DispatchOutcome::Advance;
        };
        let Some((child, object)) = created_object(self.plane, &args[1..], self.provenance) else {
            return DispatchOutcome::Advance;
        };
        self.runtime.with_stack_mut(|stack| {
            let _ = stack.set_child(self.plane, parent, child, object);
        });
        DispatchOutcome::Advance
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) enum ObjButtonStateRoute {
    DirectTop,
    DirectChild,
    TopRange,
    ChildRange,
}

#[derive(Debug)]
pub(super) struct ObjButtonStateOp {
    runtime: Arc<GraphicsRuntime>,
    route: ObjButtonStateRoute,
}

impl ObjButtonStateOp {
    pub(super) fn new(runtime: Arc<GraphicsRuntime>, route: ObjButtonStateRoute) -> Self {
        Self { runtime, route }
    }
}

impl RLOperation for ObjButtonStateOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        match self.route {
            ObjButtonStateRoute::DirectTop => {
                let Some(slot) = arg_int(args, 0).and_then(slot_ok) else {
                    return DispatchOutcome::Advance;
                };
                let Some(state) = arg_int(args, 1) else {
                    return DispatchOutcome::Advance;
                };
                self.runtime.with_stack_mut(|stack| {
                    if let Some(object) = stack.target_mut(GraphicsObjectTarget::TopLevel {
                        layer: GraphicsLayer::ForegroundObject,
                        slot,
                    }) {
                        object.button_state = state;
                    }
                });
            }
            ObjButtonStateRoute::DirectChild => {
                let Some(parent) = arg_int(args, 0).and_then(slot_ok) else {
                    return DispatchOutcome::Advance;
                };
                let Some(child) = arg_int(args, 1).and_then(slot_ok) else {
                    return DispatchOutcome::Advance;
                };
                let Some(state) = arg_int(args, 2) else {
                    return DispatchOutcome::Advance;
                };
                self.runtime.with_stack_mut(|stack| {
                    if let Some(object) = stack.target_mut(GraphicsObjectTarget::Child {
                        plane: GraphicsPlane::Foreground,
                        parent,
                        child,
                    }) {
                        object.button_state = state;
                    }
                });
            }
            ObjButtonStateRoute::TopRange => {
                let Some(lower) = arg_int(args, 0).and_then(slot_ok) else {
                    return DispatchOutcome::Advance;
                };
                let Some(upper) = arg_int(args, 1).and_then(slot_ok) else {
                    return DispatchOutcome::Advance;
                };
                let Some(state) = arg_int(args, 2) else {
                    return DispatchOutcome::Advance;
                };
                if lower > upper {
                    return DispatchOutcome::Advance;
                }
                self.runtime.with_stack_mut(|stack| {
                    for slot in lower..=upper {
                        if let Some(object) = stack.target_mut(GraphicsObjectTarget::TopLevel {
                            layer: GraphicsLayer::ForegroundObject,
                            slot,
                        }) {
                            object.button_state = state;
                        }
                    }
                });
            }
            ObjButtonStateRoute::ChildRange => {
                let Some(parent) = arg_int(args, 0).and_then(slot_ok) else {
                    return DispatchOutcome::Advance;
                };
                let Some(lower) = arg_int(args, 1).and_then(slot_ok) else {
                    return DispatchOutcome::Advance;
                };
                let Some(upper) = arg_int(args, 2).and_then(slot_ok) else {
                    return DispatchOutcome::Advance;
                };
                let Some(state) = arg_int(args, 3) else {
                    return DispatchOutcome::Advance;
                };
                if lower > upper {
                    return DispatchOutcome::Advance;
                }
                self.runtime.with_stack_mut(|stack| {
                    for child in lower..=upper {
                        if let Some(object) = stack.target_mut(GraphicsObjectTarget::Child {
                            plane: GraphicsPlane::Foreground,
                            parent,
                            child,
                        }) {
                            object.button_state = state;
                        }
                    }
                });
            }
        }
        DispatchOutcome::Advance
    }
}

#[derive(Debug)]
pub struct ParentCreateOp {
    runtime: Arc<GraphicsRuntime>,
    plane: GraphicsPlane,
}

impl ParentCreateOp {
    pub fn new(runtime: Arc<GraphicsRuntime>, plane: GraphicsPlane) -> Self {
        Self { runtime, plane }
    }
}

impl RLOperation for ParentCreateOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let Some(parent) = arg_int(args, 0).and_then(slot_ok) else {
            return DispatchOutcome::Advance;
        };
        let Some(capacity) = arg_int(args, 1).and_then(|value| usize::try_from(value).ok()) else {
            return DispatchOutcome::Advance;
        };
        let visible = arg_int(args, 2).map(|value| value != 0);
        let position = match (arg_int(args, 3), arg_int(args, 4)) {
            (Some(x), Some(y)) => Some(crate::graphics_objects::GraphicsPosition { x, y }),
            _ => None,
        };
        self.runtime.with_stack_mut(|stack| {
            let _ = stack.create_parent(self.plane, parent, capacity, visible, position);
        });
        DispatchOutcome::Advance
    }
}
