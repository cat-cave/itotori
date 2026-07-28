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


