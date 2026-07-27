use super::*;

/// Engine-neutral dispatch argument. The evaluator returns
/// `i32`, so the integer variant is `i32` for that path; the byte-string
/// variant carries raw Shift-JIS bytes (no UTF-8 lossy conversion) so a
/// future textout/string op can consume them verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExprValue {
    /// Signed 32-bit integer (matches `evaluate` / `evaluate_assignment`).
    Int(i32),
    /// An integer-bank reference passed to a command that writes through its
    /// argument. `value` retains the reference's current read value so
    /// ordinary input operations keep their existing integer semantics.
    IntReference { bank: u8, index: i32, value: i32 },
    /// Raw byte string. Used by when a string-shaped
    /// argument flows into a dispatch.
    Bytes(Vec<u8>),
}

impl ExprValue {
    /// Convenience accessor — returns the int payload or `None`.
    pub fn as_int(&self) -> Option<i32> {
        match self {
            Self::Int(value) | Self::IntReference { value, .. } => Some(*value),
            Self::Bytes(_) => None,
        }
    }

    /// Convenience accessor — returns the bytes payload or `None`.
    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Bytes(bytes) => Some(bytes.as_slice()),
            Self::Int(_) | Self::IntReference { .. } => None,
        }
    }

    /// Return a writable integer-bank destination when this command argument
    /// was encoded as a direct memory reference.
    pub fn as_int_reference(&self) -> Option<(u8, i32)> {
        match self {
            Self::IntReference { bank, index, .. } => Some((*bank, *index)),
            Self::Int(_) | Self::Bytes(_) => None,
        }
    }
}
