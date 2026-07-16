use crate::command_catalog::{is_catalogued_command_opcode, is_coverage_manifest_opcode};

use super::{
    CommandArg, RealLiveOpcode, TextEncoding,
    expression::{Expr, parse_expression},
    goto::{GotoKind, goto_kind},
    module_id,
};

/// Classify a fully-framed Command into a typed [`RealLiveOpcode`].
/// The byte framing (header, argument list, goto pointers, select block)
/// is already resolved by [`decode_command`]; this is purely the
/// *labelling* pass. It returns `None` **only** when `module_type` is
/// outside RealLive's documented `{0, 1, 2}` space — a desync tripwire the
/// caller records as [`RealLiveOpcode::Unknown`]. In-space commands first
/// pass through an enumerated `(module_id, opcode)` allow-list: only
/// catalogued opcodes resolve to a **semantically-typed** operation family
/// keyed on `module_id` (the engine's real semantic key — `module_type` is
/// a compiler-version artifact, so e.g. `Wait` is observed at both
/// `0:4:100` and `1:4:100`). The generic [`RealLiveOpcode::Command`] is
/// reached by either an uncatalogued in-space `module_id` or an
/// uncatalogued opcode inside a known module — it is NOT recognised and
/// FAILS the semantic-zero gate. On the proven Sweetie HD / Kanon corpora
/// every real tuple is enumerated and lands in a named family.
/// `module_id` keys are restated from the rlvm `src/modules/module_*.cc`
/// registrations (`RLModule(name, type, id)`) and `libreallive/bytecode.cc`
/// dispatch — reference, not vendored.
pub(super) fn classify_command(
    module_type: u8,
    module_id: u8,
    opcode_u16: u16,
    overload: u8,
    args_bytes: &[CommandArg],
) -> Option<RealLiveOpcode> {
    if module_type > 2 {
        return None;
    }
    let command_id =
        (u32::from(module_type) << 24) | (u32::from(module_id) << 16) | u32::from(opcode_u16);

    // Un-catalogued fallback: an in-space `module_id` no semantic family
    // covers. Structurally decoded but NOT recognised — fails the
    // semantic-zero gate. Never reached on the proven corpora.
    let generic = || RealLiveOpcode::Command {
        module_type,
        module_id,
        opcode: opcode_u16,
        overload,
        args: args_bytes.to_vec(),
    };

    // Control-flow commands (`module_jmp` and the cross-scene `gosub`/
    // `farcall` module variants) were byte-consumed via their goto framing;
    // label them by family.
    match goto_kind(command_id) {
        GotoKind::Goto => return Some(RealLiveOpcode::Goto),
        GotoKind::GotoIf => return Some(RealLiveOpcode::Branch),
        GotoKind::GotoOn | GotoKind::GotoCase => return Some(RealLiveOpcode::If),
        GotoKind::GosubWith => return Some(RealLiveOpcode::Call),
        GotoKind::None => {}
    }

    if !is_catalogued_command_opcode(module_id, opcode_u16)
        && !is_coverage_manifest_opcode(module_id, opcode_u16)
    {
        return Some(generic());
    }

    let mapped = match module_id {
        // module_jmp (rlvm `module_jmp.cc`, id 1) — the non-pointer opcodes
        // (the pointer-carrying ones are handled by goto framing above).
        // Module 1 is the control-flow namespace, so any residual opcode is a
        // jump/computed-flow form rather than a generic blob.
        module_id::JMP => match opcode_u16 {
            0 | 1 => RealLiveOpcode::Goto,
            2 | 3 => RealLiveOpcode::Branch,
            4 | 5 => RealLiveOpcode::If,
            10..=13 => RealLiveOpcode::Call,
            20..=22 => RealLiveOpcode::Return,
            _ => RealLiveOpcode::Jump,
        },
        // module_sel (rlvm `module_sel.cc`, id 2) — the translatable
        // `select*` option blocks were decoded to `Choice` before classify;
        // every other opcode is selection-button setup / state.
        module_id::SEL => RealLiveOpcode::SelectionControl { opcode: opcode_u16 },
        // module_msg (rlvm `module_msg.cc`, id 3) — opcode 3 is the character
        // speaker text op; catalogued opcodes in the text-display range
        // decode to `TextDisplay`; the remaining catalogued opcodes are
        // non-dialogue window directives.
        module_id::MSG => match opcode_u16 {
            3 => RealLiveOpcode::CharacterTextDisplay,
            x if (1..=200).contains(&x) => RealLiveOpcode::TextDisplay {
                encoding: TextEncoding::ShiftJisLengthPrefixed,
            },
            _ => RealLiveOpcode::MessageControl { opcode: opcode_u16 },
        },
        // module_sys (rlvm `module_sys.cc`, id 4) — `end` / `wait` keep their
        // named variants; the long control / query tail is system control.
        module_id::SYS => match opcode_u16 {
            17 => RealLiveOpcode::End,
            100 | 101 => RealLiveOpcode::Wait {
                duration_ms: first_arg_as_i32(args_bytes),
            },
            _ => RealLiveOpcode::SystemControl { opcode: opcode_u16 },
        },
        // module_sys second registration id (5) — system-class control.
        module_id::SYS2 => RealLiveOpcode::SystemControl { opcode: opcode_u16 },
        // module_str-class indexed variable / flag module (id 10) — uniform
        // single integer memory-bank reference operand.
        module_id::STR => RealLiveOpcode::VariableOp { opcode: opcode_u16 },
        // module_mem (rlvm `module_mem.cc`, id 11) — any variable-bank write.
        module_id::MEM => RealLiveOpcode::SetVariable,
        // Audio channels (module_bgm / module_se / module_pcm, ids 20/21/22)
        // — play (by filename) / stop / fade / volume.
        module_id::AUDIO_BGM | module_id::AUDIO_SE | module_id::AUDIO_PCM => {
            RealLiveOpcode::Audio {
                module_id,
                opcode: opcode_u16,
            }
        }
        // module_koe (rlvm `module_koe.cc`, id 23) — voice playback.
        module_id::KOE => RealLiveOpcode::VoicePlay {
            voice_id: first_arg_as_u32(args_bytes),
        },
        // module_grp (rlvm `module_grp.cc`, id 33) — background / sprite load
        // (first arg is the sprite id).
        module_id::GRP => RealLiveOpcode::Background {
            sprite_id: first_arg_as_u32(args_bytes),
        },
        // Screen / frame / weather / animation-layer control (ids
        // 30/31/40/60/61/62) — whole-screen / effect-layer graphics ops.
        30 | 31 | 40 | 60 | 61 | 62 => RealLiveOpcode::ScreenControl {
            module_id,
            opcode: opcode_u16,
        },
        // Display-object (sprite-plane) modules — foreground / background /
        // child object planes and their range (`module_type = 2`) forms.
        71 | 72 | 73 | 81 | 82 | 84 | 85 | 90 | 91 => RealLiveOpcode::GraphicsObject {
            module_id,
            opcode: opcode_u16,
        },
        // An in-space module id the catalogue has not reached: the typed
        // fallback that FAILS the semantic-zero gate (never occurs on the
        // proven Sweetie HD / Kanon corpora).
        _ => generic(),
    };
    Some(mapped)
}

/// Reduce an [`Expr`] to a constant `i32` when it is (or wraps) an
/// integer literal. Used to decorate `Wait` / `Background` / `VoicePlay`
/// with their first scalar argument.
fn expr_as_i32(expr: &Expr) -> Option<i32> {
    match expr {
        Expr::IntLiteral { value } => Some(*value),
        // A single-item complex parameter is a parenthesised value `(lit)`.
        Expr::Complex { items } if items.len() == 1 => expr_as_i32(&items[0]),
        _ => None,
    }
}

/// Parse the first argument's bytes as an ExpressionPiece and return its
/// integer value when it is a constant literal, else `0`. The argument
/// bytes are a full expression (e.g. `$ 0xFF` + i32), decoded by the real
/// [`parse_expression`] evaluator rather than a byte-prefix guess.
fn first_arg_as_i32(args_bytes: &[CommandArg]) -> i32 {
    args_bytes
        .first()
        .and_then(|arg| parse_expression(&arg.bytes, 0).ok())
        .and_then(|(expr, _)| expr_as_i32(&expr))
        .unwrap_or(0)
}

/// Surface the first argument literal as a `u32` **id** without losing
/// magnitude or sign information. Asset / voice ids are bit-packed `u32`
/// values (e.g. `voice_id = (archive_id << 16) | sample_id`), so the raw
/// `i32` bit pattern is reinterpreted (`as u32`) rather than passed
/// through `unsigned_abs`, which would flip a negative literal to its
/// absolute value and corrupt the id.
fn first_arg_as_u32(args_bytes: &[CommandArg]) -> u32 {
    first_arg_as_i32(args_bytes) as u32
}
