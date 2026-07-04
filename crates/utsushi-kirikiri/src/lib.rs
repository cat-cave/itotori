//! UTSUSHI-037 — **KAG plaintext REPLAY skeleton** for KiriKiri/KAG.
//!
//! This crate is the Utsushi (faithful-runtime) counterpart to KAIFUU-009's
//! KAG `.ks` *extraction* adapter (`kaifuu-kirikiri`). Where KAIFUU-009
//! parses translatable text units + byte spans for byte-preserving
//! patchback, this crate **replays** an already-plaintext KAG `.ks` script
//! into a deterministic, typed [`KagTrace`] of the four structural surfaces
//! the node scopes:
//!
//! - **message text** (per text run) — [`KagEvent::Message`],
//! - **speaker / name state** (the active `#name`) — [`KagEvent::SpeakerChange`]
//!   plus the `speaker` carried on every message,
//! - **choices** (`[link …]…[endlink]` menus) — [`KagEvent::Choice`], and
//! - **jumps** (`@jump` / `[jump target=*label]`, and the label a choice
//!   jumps to) — [`KagEvent::Jump`].
//!
//! # Honest scope: a plaintext REPLAY skeleton, NOT a full KiriKiri runtime
//!
//! The support boundary is deliberately narrow and stated up front (see
//! [`capability_note`]):
//!
//! - **Plaintext / already-extracted `.ks` only.** Commercial KiriKiri
//!   titles ship their scripts inside *encrypted* XP3 archives; opening
//!   those needs the XP3 container layer plus per-title key material. That
//!   is a SEPARATE capability and is entirely out of scope here — this crate
//!   never reads, decrypts, or unpacks an XP3 archive. It replays a `.ks`
//!   file that is already plaintext on disk (an unencrypted / `plain` XP3
//!   whose members were extracted, an author's tree, or a fan-distributed
//!   script).
//! - **Structural flow, NOT TJS.** The skeleton replays text/name/choice/
//!   jump control flow. It does NOT evaluate TJS: `[eval]`, `[emb]`, `[if]`
//!   conditionals, `[iscript]…[endscript]` blocks, and macros all surface as
//!   typed [`KagDiagnostic`]s (never faked, never a panic, never a silent
//!   skip). A cross-`storage=` jump/call (into another script) is likewise a
//!   typed diagnostic, because the skeleton replays one script.
//!
//! Presenting this as full-KiriKiri coverage would be dishonest; the trace
//! makes every unsupported construct visible so a reduced render can never
//! masquerade as a faithful one.
//!
//! # Reuse of KAIFUU-009
//!
//! The `.ks` line dialect (column-0 classification, the `[[` escape, the
//! `#voice/display` speaker convention) is re-derived from KAIFUU-009's
//! documented parser rather than imported — matching the workspace's
//! engine-port isolation posture (`utsushi-reallive` likewise re-implements
//! the parsers it shares with `kaifuu-reallive` so a regression in one
//! project cannot poison the other). `kaifuu-kirikiri` is a **dev-dependency
//! oracle**: the `text_name_trace` test asserts this crate's independent
//! replay reproduces KAIFUU-009's authoritative `(dialogue text, speaker)`
//! extraction byte-for-byte, so the reuse is proven against real parse
//! OUTPUT, not asserted by production linkage.
//!
//! # Determinism / no shell-outs
//!
//! Pure in-process parsing + replay. The same script yields an identical
//! [`KagTrace::to_deterministic_json`] (sorted keys, no floats) on every
//! run. No `Command::new`, no network, no helper process. The fixture corpus
//! is synthetic, authored, CC0 — no retail KiriKiri bytes.

#![forbid(unsafe_code)]

mod encoding;
mod parse;
mod replay;

pub use encoding::KagEncoding;
pub use parse::{Attr, BlockKind, Command, Instr, KagScript, parse_kag, parse_kag_with_encoding};
pub use replay::{
    ChoiceOption, DEFAULT_STEP_BUDGET, KAG_TRACE_SCHEMA_VERSION, KagDiagnostic, KagDiagnosticKind,
    KagEvent, KagOutcome, KagReplayOpts, KagTrace, KagTraceError, replay_kag, replay_kag_with_opts,
};

/// One-line honest-scope statement, embedded so the boundary is queryable
/// from code, not only prose docs (mirrors `kaifuu_kirikiri::capability_note`).
#[must_use]
pub fn capability_note() -> &'static str {
    "utsushi-kirikiri REPLAYS a plaintext, already-extracted KiriKiri/KAG `.ks` \
     script into a deterministic trace of message text, speaker/name state, \
     choices, and jumps. This is a plaintext REPLAY SKELETON, NOT a full \
     KiriKiri runtime: it does not evaluate TJS (`[eval]`/`[iscript]`/macros \
     surface as typed semantic diagnostics) and it does not open or decrypt \
     XP3 containers (a separate capability). Commercial encrypted-XP3 titles \
     are out of scope."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_note_states_the_boundary() {
        let note = capability_note();
        assert!(note.contains("plaintext"));
        assert!(note.contains("REPLAY SKELETON"));
        assert!(note.contains("NOT a full"));
        assert!(note.contains("TJS"));
        assert!(note.contains("XP3"));
    }

    #[test]
    fn empty_script_ends_cleanly() {
        let script = parse_kag("empty.ks", b"");
        let trace = replay_kag(&script);
        assert_eq!(trace.message_count(), 0);
        assert!(trace.diagnostics.is_empty());
        assert!(matches!(
            trace.outcome,
            KagOutcome::EndOfScript { events: 0 }
        ));
    }
}
