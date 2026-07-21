use super::object_create::{
    ChildCreateOp, ObjButtonStateOp, ObjButtonStateRoute, ObjCreateOp, ParentCreateOp,
};
use super::object_set::{ObjSetOp, ObjSetProp};
use super::*;

// object management — Alloc / Free / Init / FreeAll (module 60/61/62)

/// Object-management operations (per rlvm `module_obj_management.cc`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjMgmtOp {
    /// `objAlloc` (1): materialise an empty foreground object slot.
    Allocate,
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
            ObjMgmtOp::Allocate => {
                if let Some(buf) = arg_int(args, 0).and_then(slot_ok) {
                    let layer = self.target_layer();
                    self.runtime.with_stack_mut(|stack| {
                        let _ = stack.set_layer(layer, buf, GraphicsObject::image(""));
                    });
                }
            }
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

// registration

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

    for (mid, plane) in [
        (OBJ_FG_CREATION_ID, GraphicsPlane::Foreground),
        (OBJ_BG_CREATION_ID, GraphicsPlane::Background),
    ] {
        let create = |provenance| -> Arc<dyn RLOperation> {
            Arc::new(ObjCreateOp::with_provenance(
                Arc::clone(&runtime),
                plane,
                provenance,
            ))
        };
        let child_create = |provenance| -> Arc<dyn RLOperation> {
            Arc::new(ChildCreateOp::with_provenance(
                Arc::clone(&runtime),
                plane,
                provenance,
            ))
        };
        for op in [1000u16, 1001, 1003, 1005, 1100, 1101, 1200, 1300, 1400] {
            let provenance = if matches!(op, 1000 | 1001) {
                ImageProvenance::FileBacked
            } else {
                ImageProvenance::Placeholder
            };
            count += register_on_types(registry, &[0, 1], mid, op, create(provenance));
            count += register_on_types(registry, &[2], mid, op, child_create(provenance));
        }
        count += register_on_types(
            registry,
            &[0],
            mid,
            1500,
            create(ImageProvenance::Placeholder),
        );
        count += register_on_types(
            registry,
            &[1],
            mid,
            1500,
            Arc::new(ParentCreateOp::new(Arc::clone(&runtime), plane)),
        );
        count += register_on_types(
            registry,
            &[2],
            mid,
            1500,
            child_create(ImageProvenance::Placeholder),
        );
    }

    for (mid, plane) in [
        (OBJ_FG_SETTER_ID, GraphicsPlane::Foreground),
        (OBJ_BG_SETTER_ID, GraphicsPlane::Background),
        (OBJ_FG_RANGE_ID, GraphicsPlane::Foreground),
        (OBJ_BG_RANGE_ID, GraphicsPlane::Background),
    ] {
        let set = |p: ObjSetProp| -> Arc<dyn RLOperation> {
            Arc::new(ObjSetOp::new(Arc::clone(&runtime), plane, p))
        };
        let child_set = |p: ObjSetProp| -> Arc<dyn RLOperation> {
            Arc::new(ObjSetOp::new_child(Arc::clone(&runtime), plane, p))
        };
        let setters: &[(u16, ObjSetProp)] = &[
            (1000, ObjSetProp::Move),
            (1001, ObjSetProp::Left),
            (1002, ObjSetProp::Top),
            (1003, ObjSetProp::Alpha),
            (1004, ObjSetProp::Show),
            (1006, ObjSetProp::Adjust),
            (1007, ObjSetProp::AdjustX),
            (1008, ObjSetProp::AdjustY),
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
            (1053, ObjSetProp::Origin),
            (1054, ObjSetProp::OriginX),
            (1055, ObjSetProp::OriginY),
            (1061, ObjSetProp::HqScale),
            (1062, ObjSetProp::HqScaleX),
            (1063, ObjSetProp::HqScaleY),
            (2004, ObjSetProp::Show), // objEveDisplay → final Show (anim gap)
        ];
        for (op, prop) in setters {
            count += register_on_types(registry, &[0, 1], mid, *op, set(*prop));
            if matches!(mid, OBJ_FG_SETTER_ID | OBJ_BG_SETTER_ID) {
                count += register_on_types(registry, &[2], mid, *op, child_set(*prop));
            }
        }
        // objButtonOpts (1064): button-object setup feeding select_objbtn.
        count += register_on_types(
            registry,
            &[0, 1],
            mid,
            1064,
            Arc::new(super::super::module_obj::ObjButtonOptsOp::new(
                Arc::clone(&runtime),
                plane,
            )),
        );
        if matches!(mid, OBJ_FG_SETTER_ID | OBJ_BG_SETTER_ID) {
            count += register_on_types(
                registry,
                &[2],
                mid,
                1064,
                Arc::new(super::super::module_obj::ObjButtonOptsOp::new_child(
                    Arc::clone(&runtime),
                    plane,
                )),
            );
        }
    }

    // objBtnState (1066) uses distinct direct/range address shapes.
    for (module_type, module_id, route) in [
        (0, OBJ_FG_SETTER_ID, ObjButtonStateRoute::DirectTop),
        (2, OBJ_FG_SETTER_ID, ObjButtonStateRoute::DirectChild),
        (1, OBJ_FG_RANGE_ID, ObjButtonStateRoute::TopRange),
        (2, OBJ_FG_RANGE_ID, ObjButtonStateRoute::ChildRange),
    ] {
        count += register_on_types(
            registry,
            &[module_type],
            module_id,
            1066,
            Arc::new(ObjButtonStateOp::new(Arc::clone(&runtime), route)),
        );
    }

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
        count += register_on_types(registry, &LATTICE_TYPES, mid, 0, mgmt(ObjMgmtOp::Free));
        count += register_on_types(registry, &LATTICE_TYPES, mid, 10, mgmt(ObjMgmtOp::Init));
        count += register_on_types(registry, &LATTICE_TYPES, mid, 11, mgmt(ObjMgmtOp::FreeInit));
        count += register_on_types(registry, &LATTICE_TYPES, mid, 100, mgmt(ObjMgmtOp::FreeAll));
        count += register_on_types(registry, &LATTICE_TYPES, mid, 110, mgmt(ObjMgmtOp::FreeAll));
        count += register_on_types(registry, &LATTICE_TYPES, mid, 111, mgmt(ObjMgmtOp::FreeAll));
    }
    // objAlloc lives on the generic ObjManagement module (60) only and
    // materialises an empty foreground slot before a later objOf* fills it.
    count += register_on_types(
        registry,
        &LATTICE_TYPES,
        OBJ_MGMT_ID,
        1,
        Arc::new(ObjMgmtRenderOp::new(
            Arc::clone(&runtime),
            ObjMgmtOp::Allocate,
        )),
    );
    // objCopyFgToBg lives on the generic ObjManagement module (60) only.
    count += register_on_types(
        registry,
        &LATTICE_TYPES,
        OBJ_MGMT_ID,
        2,
        Arc::new(ObjMgmtRenderOp::new(
            Arc::clone(&runtime),
            ObjMgmtOp::CopyFgToBg,
        )),
    );

    count
}
