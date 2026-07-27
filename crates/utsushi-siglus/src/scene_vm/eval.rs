//! Integer expression evaluation for the executing scene VM.

use super::model::{SceneVm, Value, VmError};

impl SceneVm<'_> {
    pub(super) fn unary(&mut self, offset: usize, op: u8) -> Result<(), VmError> {
        let value = self.integer(offset)?;
        let result = match op {
            0x01 => value,
            0x02 => value.wrapping_neg(),
            0x30 => !value,
            _ => return Err(self.unsupported(offset, "unary-operator")),
        };
        self.values.push(Value::Int(result));
        Ok(())
    }

    pub(super) fn binary(&mut self, offset: usize, op: u8) -> Result<(), VmError> {
        let rhs = self.integer(offset)?;
        let lhs = self.integer(offset)?;
        let result = match op {
            0x01 => lhs.wrapping_add(rhs),
            0x02 => lhs.wrapping_sub(rhs),
            0x03 => lhs.wrapping_mul(rhs),
            0x04 if rhs != 0 => lhs.wrapping_div(rhs),
            0x05 if rhs != 0 => lhs.wrapping_rem(rhs),
            0x10 => i32::from(lhs == rhs),
            0x11 => i32::from(lhs != rhs),
            0x12 => i32::from(lhs > rhs),
            0x13 => i32::from(lhs >= rhs),
            0x14 => i32::from(lhs < rhs),
            0x15 => i32::from(lhs <= rhs),
            0x20 => i32::from(lhs != 0 && rhs != 0),
            0x21 => i32::from(lhs != 0 || rhs != 0),
            0x31 => lhs & rhs,
            0x32 => lhs | rhs,
            0x33 => lhs ^ rhs,
            0x34 => lhs.wrapping_shl(rhs as u32),
            0x35 => lhs.wrapping_shr(rhs as u32),
            0x36 => ((lhs as u32) >> rhs) as i32,
            _ => return Err(self.unsupported(offset, "binary-operator")),
        };
        self.values.push(Value::Int(result));
        Ok(())
    }

    fn unsupported(&self, offset: usize, operation: &'static str) -> VmError {
        VmError::UnsupportedOperation {
            scene_id: self.scene_id,
            offset,
            operation,
        }
    }
}
