//! Stateful mouse polling opcodes used by hand-written RealLive menus.

use std::sync::{Arc, Mutex};

use utsushi_core::input::{InputEvent, PointerButton};

use crate::rlop::module_obj::DEFAULT_BUTTON_GROUP;
use crate::rlop::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::var_banks::{BankId, Value};
use crate::vm::{Vm, VmWarning};
use crate::{GraphicsRuntime, HitRegion};

const SYS_MODULE_TYPE: u8 = 1;
const SYS_MODULE_ID: u8 = 4;
const OPCODE_FLUSH_CLICK: u16 = 130;
const OPCODE_GET_CURSOR_POS: u16 = 133;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct CursorState {
    x: i32,
    y: i32,
    primary: i32,
    secondary: i32,
}

/// The input state visible to the reference-writing system calls.
#[derive(Debug, Default)]
pub(super) struct CursorInputRuntime {
    state: Mutex<CursorState>,
    graphics: Arc<GraphicsRuntime>,
    auto_first_button: bool,
}

impl CursorInputRuntime {
    pub(super) fn new(graphics: Arc<GraphicsRuntime>, auto_first_button: bool) -> Self {
        Self {
            state: Mutex::new(CursorState::default()),
            graphics,
            auto_first_button,
        }
    }
    pub(super) fn record(&self, event: &InputEvent, screen: (i32, i32)) {
        let InputEvent::Pointer { x, y, button } = event else {
            return;
        };
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.x = (x * (screen.0 - 1).max(0) as f32).round() as i32;
        state.y = (y * (screen.1 - 1).max(0) as f32).round() as i32;
        match button {
            // A substrate pointer event represents the completed gesture that
            // the poll observes, matching EventSystem's released value.
            PointerButton::Primary => state.primary = 2,
            PointerButton::Secondary => state.secondary = 2,
            PointerButton::Auxiliary => {}
        }
    }

    fn flush(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.primary = 0;
        state.secondary = 0;
    }

    fn state(&self) -> CursorState {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.auto_first_button
            && state.primary == 0
            && let Some(HitRegion::Known(rect)) = self
                .graphics
                .button_candidates(DEFAULT_BUTTON_GROUP)
                .into_iter()
                .map(|candidate| candidate.object.hit_region(None))
                .find(|region| matches!(region, HitRegion::Known(_)))
        {
            state.x = rect.x.saturating_add(rect.width / 2);
            state.y = rect.y.saturating_add(rect.height / 2);
            state.primary = 2;
        }
        *state
    }
}

pub(super) fn register_cursor_input_rlops(
    registry: &mut RlopRegistry,
    runtime: std::sync::Arc<CursorInputRuntime>,
) {
    registry.register(
        RlopKey::new(SYS_MODULE_TYPE, SYS_MODULE_ID, OPCODE_FLUSH_CLICK),
        std::sync::Arc::new(FlushClickOp {
            runtime: runtime.clone(),
        }),
    );
    registry.register(
        RlopKey::new(SYS_MODULE_TYPE, SYS_MODULE_ID, OPCODE_GET_CURSOR_POS),
        std::sync::Arc::new(GetCursorPosOp { runtime }),
    );
}

#[derive(Debug)]
struct FlushClickOp {
    runtime: std::sync::Arc<CursorInputRuntime>,
}

impl RLOperation for FlushClickOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.is_empty() {
            self.runtime.flush();
        }
        DispatchOutcome::Advance
    }
}

#[derive(Debug)]
struct GetCursorPosOp {
    runtime: std::sync::Arc<CursorInputRuntime>,
}

impl RLOperation for GetCursorPosOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let refs = match four_int_references(args) {
            Ok(refs) => refs,
            Err(reason) => {
                vm.push_warning(VmWarning::RlopArgsInvalid {
                    op: "sys.get_cursor_pos",
                    reason,
                });
                return DispatchOutcome::Advance;
            }
        };
        let state = self.runtime.state();
        for ((bank, index), value) in
            refs.into_iter()
                .zip([state.x, state.y, state.primary, state.secondary])
        {
            if let Err(warning) = vm.banks_mut().set(bank, index, Value::Int(value)) {
                vm.push_warning(VmWarning::RlopArgsInvalid {
                    op: "sys.get_cursor_pos",
                    reason: warning.to_string(),
                });
                return DispatchOutcome::Advance;
            }
        }
        DispatchOutcome::Advance
    }
}

fn four_int_references(args: &[ExprValue]) -> Result<[(BankId, u16); 4], String> {
    if args.len() != 8 {
        return Err(format!(
            "expected four integer references, got {} values",
            args.len()
        ));
    }
    let reference = |slot: usize| -> Result<(BankId, u16), String> {
        let bank_raw = args[slot * 2]
            .as_int()
            .ok_or_else(|| format!("reference {slot}: bank is not an integer"))?;
        let index_raw = args[slot * 2 + 1]
            .as_int()
            .ok_or_else(|| format!("reference {slot}: index is not an integer"))?;
        let bank_byte = u8::try_from(bank_raw)
            .map_err(|_| format!("reference {slot}: bank {bank_raw} is out of range"))?;
        let bank = BankId::from_int_bank_byte(bank_byte)
            .ok_or_else(|| format!("reference {slot}: bank 0x{bank_byte:02x} is not integer"))?;
        let index = u16::try_from(index_raw)
            .map_err(|_| format!("reference {slot}: index {index_raw} is out of range"))?;
        Ok((bank, index))
    };
    Ok([reference(0)?, reference(1)?, reference(2)?, reference(3)?])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_cursor_pos_writes_every_reference_after_a_completed_primary_click() {
        let runtime = CursorInputRuntime::new(Arc::new(GraphicsRuntime::new()), false);
        runtime.record(
            &InputEvent::Pointer {
                x: 0.5,
                y: 0.25,
                button: PointerButton::Primary,
            },
            (800, 600),
        );
        let mut vm = Vm::new(1, 0);
        let op = GetCursorPosOp {
            runtime: std::sync::Arc::new(runtime),
        };
        let refs = [0x00, 3, 0x00, 4, 0x00, 5, 0x00, 6]
            .into_iter()
            .map(ExprValue::Int)
            .collect::<Vec<_>>();
        op.dispatch(&mut vm, &refs);
        assert_eq!(vm.banks().get(BankId::IntA, 3), Some(Value::Int(400)));
        assert_eq!(vm.banks().get(BankId::IntA, 4), Some(Value::Int(150)));
        assert_eq!(vm.banks().get(BankId::IntA, 5), Some(Value::Int(2)));
        assert_eq!(vm.banks().get(BankId::IntA, 6), Some(Value::Int(0)));
    }

    #[test]
    fn flush_click_clears_button_states_without_moving_the_cursor() {
        let runtime = Arc::new(CursorInputRuntime::new(
            Arc::new(GraphicsRuntime::new()),
            false,
        ));
        runtime.record(
            &InputEvent::Pointer {
                x: 0.5,
                y: 0.25,
                button: PointerButton::Primary,
            },
            (800, 600),
        );
        FlushClickOp {
            runtime: runtime.clone(),
        }
        .dispatch(&mut Vm::new(1, 0), &[]);
        assert_eq!(
            runtime.state(),
            CursorState {
                x: 400,
                y: 150,
                primary: 0,
                secondary: 0
            }
        );
    }
}
