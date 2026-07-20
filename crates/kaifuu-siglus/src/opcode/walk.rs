//! Fuzz-safe linear walker for a Siglus scene-bytecode (`scn`) section.
//! Every read is bounds-checked and every recursion is depth-bounded, so an
//! adversarial or truncated stream can never panic or spin — an
//! unclassifiable / out-of-bounds position is recorded as a typed
//! [`SiglusOpcode::Unknown`] span and the walk resyncs at the next scene label
//! boundary (a guaranteed instruction start), deterministically bounding any
//! desync.
//!
//! # Operand-width model
//! The instruction stream is a stack-machine bytecode: a 1-byte command code
//! followed by a command-specific, little-endian operand block. All widths are
//! fixed except:
//!   * `CD_PUSH` (`0x02`) — an extra 4-byte literal follows only for the `int`
//!     / `str` push forms;
//!   * the argument-list opcodes (`0x13`/`0x14`/`0x15`/`0x30`) — a recursively
//!     nested `(count, form…)` list read straight from the stream; and
//!   * `CD_COMMAND` (`0x30`) — a trailing `read_flag_no` word present only when
//!     the invoked command consumes one. That decision is a *runtime* property
//!     of the command element (resolved by the stack VM, not the byte stream),
//!     so the skeleton disambiguates the 0-or-4-byte tail structurally: it
//!     picks the variant whose successor lands on a scene label boundary / EOF
//!     or survives a bounded trial walk. Full semantic resolution is the
//!     downstream decoder's job.

use std::collections::BTreeSet;

use super::{SiglusInstruction, SiglusOpcode};

/// Form code for a nested argument list (a `-1` sentinel in the stream).
const FM_LIST: i32 = -1;
/// Form code for an `int` literal / value.
const FM_INT: i32 = 10;
/// Form code for a `str` literal / value.
const FM_STR: i32 = 20;

/// Maximum nested-argument-list depth. Real scene data nests only a few levels;
/// the cap keeps a hostile stream from exhausting the native stack.
const MAX_ARG_DEPTH: u32 = 64;
/// How far the `CD_COMMAND` tail disambiguator trial-walks before treating a
/// candidate as "still plausible".
const TRIAL_BUDGET: usize = 64;

/// Read a little-endian `i32` at `pos`, or `None` if it would run past the end.
fn read_i32(bytes: &[u8], pos: usize) -> Option<i32> {
    let slice = bytes.get(pos..pos.checked_add(4)?)?;
    Some(i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// Compute the byte just past an argument list starting at `pos`.
/// Layout: `i32 count` then `count × (i32 form [+ nested list when form == -1])`.
/// Bounded reads + a depth cap make this panic-free on any input.
fn arg_list_end(bytes: &[u8], pos: usize, depth: u32) -> Option<usize> {
    if depth > MAX_ARG_DEPTH {
        return None;
    }
    let count = read_i32(bytes, pos)?;
    if count < 0 {
        return None;
    }
    let mut cursor = pos.checked_add(4)?;
    for _ in 0..count {
        let form = read_i32(bytes, cursor)?;
        cursor = cursor.checked_add(4)?;
        if form == FM_LIST {
            cursor = arg_list_end(bytes, cursor, depth + 1)?;
        }
    }
    Some(cursor)
}

/// True for every command code the partitioner classifies as a known opcode.
pub(super) fn is_known_lead(lead: u8) -> bool {
    matches!(lead, 0x01..=0x09 | 0x10..=0x16 | 0x20..=0x22 | 0x30..=0x34)
}

/// Decode the instruction starting at `pos`, classifying its opcode and
/// computing the byte just past it. `read_flag` selects the `CD_COMMAND` tail
/// variant. Returns `None` for an unclassifiable lead byte or any operand read
/// that would run past the stream end.
fn decode(bytes: &[u8], pos: usize, read_flag: bool) -> Option<(SiglusOpcode, usize)> {
    let lead = *bytes.get(pos)?;
    let after = pos.checked_add(1)?;
    let (opcode, next) = match lead {
        0x01 => (SiglusOpcode::Nl, after.checked_add(4)?),
        0x02 => {
            let form = read_i32(bytes, after)?;
            let extra = if form == FM_INT || form == FM_STR {
                4
            } else {
                0
            };
            (
                SiglusOpcode::Push,
                after.checked_add(4)?.checked_add(extra)?,
            )
        }
        0x03 => (SiglusOpcode::Pop, after.checked_add(4)?),
        0x04 => (SiglusOpcode::Copy, after.checked_add(4)?),
        0x05 => (SiglusOpcode::Property, after),
        0x06 => (SiglusOpcode::CopyElm, after),
        0x07 => (SiglusOpcode::DecProp, after.checked_add(8)?),
        0x08 => (SiglusOpcode::ElmPoint, after),
        0x09 => (SiglusOpcode::Arg, after),
        0x10 => (SiglusOpcode::Goto, after.checked_add(4)?),
        0x11 => (SiglusOpcode::GotoTrue, after.checked_add(4)?),
        0x12 => (SiglusOpcode::GotoFalse, after.checked_add(4)?),
        0x13 => (
            SiglusOpcode::Gosub,
            arg_list_end(bytes, after.checked_add(4)?, 0)?,
        ),
        0x14 => (
            SiglusOpcode::GosubStr,
            arg_list_end(bytes, after.checked_add(4)?, 0)?,
        ),
        0x15 => (SiglusOpcode::Return, arg_list_end(bytes, after, 0)?),
        0x16 => (SiglusOpcode::Eof, after),
        0x20 => (SiglusOpcode::Assign, after.checked_add(12)?),
        0x21 => (SiglusOpcode::Operate1, after.checked_add(5)?),
        0x22 => (SiglusOpcode::Operate2, after.checked_add(9)?),
        0x30 => {
            // arg_list_id (i32) is folded into the leading word before the list.
            let after_args = arg_list_end(bytes, after.checked_add(4)?, 0)?;
            let named_cnt = read_i32(bytes, after_args)?;
            if named_cnt < 0 {
                return None;
            }
            let named_bytes = 4usize.checked_mul(named_cnt as usize)?;
            // named_arg_cnt word + named-id words + ret_form word.
            let after_ret = after_args
                .checked_add(4)?
                .checked_add(named_bytes)?
                .checked_add(4)?;
            let next = if read_flag {
                after_ret.checked_add(4)?
            } else {
                after_ret
            };
            (SiglusOpcode::Command { read_flag }, next)
        }
        0x31 => (SiglusOpcode::Text, after.checked_add(4)?),
        0x32 => (SiglusOpcode::Name, after),
        0x33 => (SiglusOpcode::SelBlockStart, after),
        0x34 => (SiglusOpcode::SelBlockEnd, after),
        _ => return None,
    };
    if next > bytes.len() {
        return None;
    }
    Some((opcode, next))
}

/// Greedy bounded trial walk from `pos`, choosing the no-read-flag command tail
/// (falling back to the read-flag tail). Returns `true` when it reaches `stop`
/// (a label boundary) or EOF without overshooting or hitting an unclassifiable
/// byte, or when it stays alive for the whole budget.
fn trial(bytes: &[u8], mut pos: usize, stop: usize, budget: usize) -> bool {
    for _ in 0..budget {
        if pos == stop || pos == bytes.len() {
            return true;
        }
        if pos > stop {
            return false;
        }
        let next = decode(bytes, pos, false)
            .or_else(|| decode(bytes, pos, true))
            .map(|(_, n)| n);
        match next {
            Some(n) if n > pos => pos = n,
            _ => return false,
        }
    }
    true
}

/// Score a `CD_COMMAND` tail candidate: EOF is best, then a label boundary,
/// then a successor that begins a known opcode and survives a trial walk.
/// A negative score means "not a viable continuation".
fn score(
    candidate: &Option<(SiglusOpcode, usize)>,
    bytes: &[u8],
    anchors: &BTreeSet<usize>,
    stop: usize,
) -> i64 {
    let Some((_, next)) = candidate else {
        return -1;
    };
    let next = *next;
    if next == bytes.len() {
        1_000_000
    } else if anchors.contains(&next) {
        900_000
    } else if next < bytes.len() && is_known_lead(bytes[next]) {
        if trial(bytes, next, stop, TRIAL_BUDGET) {
            500_000 + next as i64
        } else {
            next as i64
        }
    } else {
        -1
    }
}

/// Linear-partition a bytecode section into contiguous instructions.
/// `anchors` are label / z-label byte offsets (guaranteed instruction starts)
/// used both to disambiguate `CD_COMMAND` tails and to resync after any
/// unresolved span. Returns the instruction stream (fully covering `bytes` with
/// no gaps), the offsets of every `Unknown` span, and the set of every
/// instruction-start boundary (for anchor-alignment verification).
pub(super) fn walk_bytecode(
    bytes: &[u8],
    anchors: &BTreeSet<usize>,
) -> (Vec<SiglusInstruction>, Vec<usize>, BTreeSet<usize>) {
    let mut instructions = Vec::new();
    let mut unknown_offsets = Vec::new();
    let mut boundaries = BTreeSet::new();
    let mut pos = 0usize;

    loop {
        boundaries.insert(pos);
        if pos >= bytes.len() {
            break;
        }
        let lead = bytes[pos];
        let chosen = if lead == 0x30 {
            let stop = anchors
                .range((pos + 1)..)
                .next()
                .copied()
                .unwrap_or(bytes.len());
            let no_rf = decode(bytes, pos, false);
            let with_rf = decode(bytes, pos, true);
            let s0 = score(&no_rf, bytes, anchors, stop);
            let s1 = score(&with_rf, bytes, anchors, stop);
            if s0 < 0 && s1 < 0 {
                None
            } else if s1 > s0 {
                with_rf
            } else {
                no_rf
            }
        } else {
            decode(bytes, pos, false)
        };

        match chosen {
            Some((opcode, next)) if next > pos => {
                instructions.push(SiglusInstruction {
                    byte_offset: pos,
                    lead,
                    opcode,
                    len: next - pos,
                });
                pos = next;
            }
            _ => {
                // Unresolved: record one Unknown span covering every byte up to
                // the next label boundary, then resync there (or advance one
                // byte when no boundary remains). Deterministic; no gaps.
                let resync = match anchors.range((pos + 1)..).next().copied() {
                    Some(anchor) if anchor > pos => anchor,
                    _ => pos + 1,
                };
                unknown_offsets.push(pos);
                instructions.push(SiglusInstruction {
                    byte_offset: pos,
                    lead,
                    opcode: SiglusOpcode::Unknown {
                        lead,
                        byte_offset: pos,
                    },
                    len: resync - pos,
                });
                pos = resync;
            }
        }
    }

    (instructions, unknown_offsets, boundaries)
}
