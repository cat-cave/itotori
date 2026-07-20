//! Typed `CD_COMMAND` (`0x30`) syscall decoder (siglus-11).
//!
//! The opcode and expression layers already prove the byte layout of every
//! command operand. This layer replays that typed stack discipline to retain
//! each call site: its resolved system-function id, every typed argument, and
//! the optional command tail. The selection syscall (`System{76}`) additionally
//! exposes its option string-table references and connects them to the flow
//! layer's branch arms. It never decodes or stores title text.

mod decode;
mod model;

pub use decode::decode_scene_syscalls;
pub use model::{
    SEL_SYSTEM_FUNCTION_ID, SceneSyscallDecode, SceneSyscallError, SiglusCallTarget,
    SiglusSelChoice, SiglusSelOption, SiglusStringRef, SiglusSyscallDiagnostic, SiglusTypedCall,
    system_function_name,
};

#[cfg(test)]
mod tests;
