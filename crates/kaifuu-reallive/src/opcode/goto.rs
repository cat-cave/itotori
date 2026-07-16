use super::{RealLiveParseError, command::decode_command, opener, parser::decode_element};

/// Width of a goto-family jump-target pointer (`i32` LE).
pub(super) const GOTO_POINTER_LEN: usize = 4;

/// One captured goto-family jump-target pointer inside a scene's
/// decompressed (and, for `xor_2` titles, decrypted) bytecode.
/// RealLive control-flow commands (`goto`/`goto_if`/`goto_on`/`goto_case`/
/// `gosub*`/`farcall*`) carry trailing `i32 LE` pointers whose value is the
/// **absolute byte offset** of the jump destination within the same scene
/// bytecode stream (rlvm `libreallive` resolves each pointer against the
/// scene's `Pointers` table, which is a byte-offset index). When a
/// length-changing text splice shifts everything after the edit, every
/// pointer whose destination sits at/after the edit must be re-based by the
/// cumulative byte delta — the patchback drives that off this record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GotoPointerSite {
    /// Absolute byte offset (within the scene bytecode) of the 4-byte
    /// `i32 LE` pointer itself — where the recalculated value is written back.
    pub pointer_offset: usize,
    /// The current jump-target byte offset the pointer encodes (its `i32`
    /// value, absolute within the same scene bytecode stream).
    pub target: i32,
}

/// Walk a decompressed (and, for `xor_2` titles, decrypted) scene bytecode
/// stream and collect every goto-family jump-target pointer site.
/// Drives off the single-source-of-truth element decoder ([`decode_element`]
/// [`decode_command`]) so the pointer offsets can never drift from the
/// authoritative command framing: for a Command opener the pointer-recording
/// [`decode_command`] is called; every other element is advanced by
/// [`decode_element`]. The returned offsets/values are absolute within
/// `bytes` (the same coordinate space the text-splice offsets use), so the
/// patchback can re-base each target by the cumulative splice delta and write
/// the new value back at `pointer_offset`.
pub fn collect_goto_pointer_sites(
    bytes: &[u8],
) -> Result<Vec<GotoPointerSite>, RealLiveParseError> {
    if bytes.is_empty() {
        return Err(RealLiveParseError::TruncatedBytecode { input_len: 0 });
    }
    let mut sites: Vec<GotoPointerSite> = Vec::new();
    let mut pos: usize = 0;
    while pos < bytes.len() {
        let consumed = if bytes[pos] == opener::COMMAND {
            let (_op, consumed) = decode_command(bytes, pos, &mut sites)?;
            consumed
        } else {
            let (_op, consumed) = decode_element(bytes, pos)?;
            consumed
        };
        debug_assert!(consumed > 0, "decode must make forward progress");
        pos += consumed;
    }
    Ok(sites)
}

/// Goto-family classification of a Command, keyed on the 32-bit command
/// id `(module_type << 24) | (module_id << 16) | opcode_u16` (rlvm
/// `libreallive/bytecode.cc::BytecodeElement::Read`). These are the
/// commands that carry **trailing jump-target pointers** after the
/// argument list — the structure a length-only argument scan cannot see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GotoKind {
    /// `goto` / `gosub`: 8-byte header + one `i32` target, no arglist.
    Goto,
    /// `goto_if` / `goto_unless` / `gosub_if`: header + `(cond)` + `i32`.
    GotoIf,
    /// `goto_on`: header + `(expr)` + `argc` × `i32` targets.
    GotoOn,
    /// `goto_case`: header + `(expr)` + `argc` × (`(case)` + `i32`).
    GotoCase,
    /// `gosub_with`: header + `(args)` + `i32` target.
    GosubWith,
    /// Not a goto-family command.
    None,
}

/// Map a command id to its [`GotoKind`]. The id sets are restated from
/// rlvm `libreallive/bytecode.cc`'s `BytecodeElement::Read` dispatch
/// switch (the cross-scene/`farcall` module variants `0x05`/`0x06` are
/// included alongside the intra-scene `0x01` jmp module).
pub(super) fn goto_kind(command_id: u32) -> GotoKind {
    match command_id {
        0x0001_0000 | 0x0001_0005 | 0x0005_0001 | 0x0005_0005 | 0x0006_0001 | 0x0006_0005 => {
            GotoKind::Goto
        }
        0x0001_0001 | 0x0001_0002 | 0x0001_0006 | 0x0001_0007 | 0x0005_0002 | 0x0005_0006
        | 0x0005_0007 | 0x0006_0000 | 0x0006_0002 | 0x0006_0006 | 0x0006_0007 => GotoKind::GotoIf,
        0x0001_0003 | 0x0001_0008 | 0x0005_0003 | 0x0005_0008 | 0x0006_0003 | 0x0006_0008 => {
            GotoKind::GotoOn
        }
        0x0001_0004 | 0x0001_0009 | 0x0005_0004 | 0x0005_0009 | 0x0006_0004 | 0x0006_0009 => {
            GotoKind::GotoCase
        }
        0x0001_0010 | 0x0006_0010 => GotoKind::GosubWith,
        _ => GotoKind::None,
    }
}
