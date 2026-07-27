use super::*;
use crate::{BankId, Value, VmWarning};

/// Foreground-object getters that write through integer-bank references.
#[derive(Debug)]
pub struct ObjGetOp {
    runtime: Arc<GraphicsRuntime>,
    kind: ObjGetKind,
}

#[derive(Debug, Clone, Copy)]
pub enum ObjGetKind {
    Position,
    Dimensions,
}

impl ObjGetOp {
    pub fn new(runtime: Arc<GraphicsRuntime>, kind: ObjGetKind) -> Self {
        Self { runtime, kind }
    }
}

impl RLOperation for ObjGetOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let Some(slot) = arg_int(args, 0).and_then(slot_ok) else {
            vm.push_warning(VmWarning::RlopArgsInvalid {
                op: "obj.get",
                reason: "missing foreground object slot".to_owned(),
            });
            return DispatchOutcome::Advance;
        };
        let Some(destinations) = two_int_references(args) else {
            vm.push_warning(VmWarning::RlopArgsInvalid {
                op: "obj.get",
                reason: "expected two direct integer-bank destinations".to_owned(),
            });
            return DispatchOutcome::Advance;
        };
        let values = self.runtime.with_stack(|stack| {
            let object = stack.get_layer(GraphicsLayer::ForegroundObject, slot)?;
            match self.kind {
                ObjGetKind::Position => Some([object.position.x, object.position.y]),
                ObjGetKind::Dimensions => object
                    .geometry
                    .surface
                    .map(|surface| [surface.width, surface.height]),
            }
        });
        let Some(values) = values else {
            vm.push_warning(VmWarning::RlopArgsInvalid {
                op: "obj.get",
                reason: "foreground object has no recoverable getter value".to_owned(),
            });
            return DispatchOutcome::Advance;
        };
        for ((bank, index), value) in destinations.into_iter().zip(values) {
            if let Err(error) = vm.banks_mut().set(bank, index, Value::Int(value)) {
                vm.push_warning(VmWarning::RlopArgsInvalid {
                    op: "obj.get",
                    reason: error.to_string(),
                });
                break;
            }
        }
        DispatchOutcome::Advance
    }
}

fn two_int_references(args: &[ExprValue]) -> Option<[(BankId, u16); 2]> {
    let reference = |slot: usize| {
        let (bank, index) = args.get(slot)?.as_int_reference()?;
        Some((
            BankId::from_int_bank_byte(bank)?,
            u16::try_from(index).ok()?,
        ))
    };
    Some([reference(1)?, reference(2)?])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(index: i32) -> ExprValue {
        ExprValue::IntReference {
            bank: 0,
            index,
            value: 0,
        }
    }

    #[test]
    fn object_getters_write_rectangle_destinations_from_object_state() {
        let runtime = Arc::new(GraphicsRuntime::new());
        runtime.with_stack_mut(|stack| {
            let mut object = GraphicsObject::image("synthetic");
            object.position = crate::GraphicsPosition { x: 12, y: 34 };
            object.geometry.surface = Some(crate::SurfaceGeometry {
                width: 56,
                height: 78,
                origin: crate::GraphicsPosition::ORIGIN,
            });
            stack
                .set_layer(GraphicsLayer::ForegroundObject, 3, object)
                .expect("in-range foreground object");
        });
        let mut vm = Vm::new(1, 0);
        let args = vec![ExprValue::Int(3), reference(1000), reference(1001)];
        ObjGetOp::new(Arc::clone(&runtime), ObjGetKind::Position).dispatch(&mut vm, &args);
        let args = vec![ExprValue::Int(3), reference(1002), reference(1003)];
        ObjGetOp::new(runtime, ObjGetKind::Dimensions).dispatch(&mut vm, &args);

        assert_eq!(vm.banks().get(BankId::IntA, 1000), Some(Value::Int(12)));
        assert_eq!(vm.banks().get(BankId::IntA, 1001), Some(Value::Int(34)));
        assert_eq!(vm.banks().get(BankId::IntA, 1002), Some(Value::Int(56)));
        assert_eq!(vm.banks().get(BankId::IntA, 1003), Some(Value::Int(78)));
    }
}
