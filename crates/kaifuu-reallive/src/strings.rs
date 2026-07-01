//! String-slot extraction and stable slot-id derivation.
//!
//! The slot id format is documented in `lib.rs` (§ "Stable id derivation
//! rule"). The role default is provided by [`crate::opcodes::NamedOpcode`]
//! for known opcodes; unknown contexts default to
//! [`crate::ast::StringSlotRole::Unknown`].

use kaifuu_core::SourceEncoding;

use crate::ast::{StringSlot, StringSlotId, StringSlotRef, StringSlotRole};

/// Build a new [`StringSlot`] plus its [`StringSlotRef`] given the
/// byte-range, encoding, and role context.
pub(crate) fn make_slot(
    scene_id: u16,
    slot_byte_offset_within_scene: u64,
    slot_index_within_instruction: u8,
    raw_bytes: &[u8],
    role: StringSlotRole,
    encoding: SourceEncoding,
    next_global_index: u32,
) -> (StringSlot, StringSlotRef) {
    let slot_id = StringSlotId::for_scene(
        scene_id,
        slot_byte_offset_within_scene,
        slot_index_within_instruction,
    );
    let slot = StringSlot {
        slot_id: slot_id.clone(),
        byte_offset_within_scene: slot_byte_offset_within_scene,
        byte_len: raw_bytes.len() as u64,
        encoding,
        raw_bytes_hex: hex_encode_upper(raw_bytes),
        semantic_role: role,
    };
    let slot_ref = StringSlotRef {
        slot_id,
        slot_index: next_global_index,
    };
    (slot, slot_ref)
}

/// Uppercase-hex byte encoder. Bypasses bringing in a hex crate; the
/// parser is the only emitter.
pub(crate) fn hex_encode_upper(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02X}");
    }
    out
}
