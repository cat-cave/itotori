//! Real RealLive bytecode opcode dispatch.
//! Decodes the **real** RealLive scene-bytecode stream documented in
//! `docs/research/reallive-engine.md` §D and confirmed against an observed
//! decompressed scene 1 in the encryption-mechanism research note §4.2.
//! Clean-room provenance:
//! - The opener-byte switch (`{0x00, 0x0A, 0x21, 0x23, 0x24, 0x2C, 0x40}`
//!   plus Shift-JIS lead bytes `0x81..=0x9F` / `0xE0..=0xFC`) and the
//!   8-byte `CommandElement` header layout
//!   (`module_type`, `module_id`, `opcode_u16_le`, `argc`, `overload`,
//!   `reserved`) are restated in our own words from the public RLDEV
//!   manual (Haeleth) and from rlvm's `src/libreallive/bytecode.{h,cc}`
//!   (research anchor only; rlvm is GPL-3, not linked or vendored).
//! - The RLOperation-family classification keys on the documented module
//!   catalogue (rlvm `src/modules/module_*.cc` names). No bytes are
//!   inferred from one corpus alone — opcode handlers are documented
//!   per RLDEV/rlvm references per the audit-focus row.
//!   Scope:
//! - This module owns the **opener-byte + Command-header** dispatch and
//!   the full **ExpressionPiece evaluator** ([`parse_expression`]) that
//!   decodes `0x24` Expression elements and Command argument lists into
//!   typed [`Expr`] trees while computing their exact byte spans.
//! - Command elements consume their bracketed argument list and any
//!   goto-family trailing jump-target pointers (`docs/research/
//!   reallive-engine.md` §D + rlvm `bytecode.cc`), so the byte cursor
//!   stays aligned across the whole scene.
//! - Text strings carried in Command argument lists or in Textout elements
//!   are kept as raw Shift-JIS bytes; decoding is the
//!   [`crate::encoding`] surface's job.
//!   The decoder partitions **every** byte of a real observed scene
//!   stream into a typed [`RealLiveOpcode`] element — the seven structural
//!   openers decode their element and every other byte begins a Textout
//!   run (the catch-all). Every in-space Command is further classified to a
//!   **semantic operation family** keyed on its `module_id` (control-flow,
//!   selection, message, system, audio, voice, graphics-background,
//!   display-object, screen, variable, memory). A well-formed, fully
//!   catalogued stream therefore yields **zero** [`RealLiveOpcode::Command`]
//!   (un-catalogued) and **zero** [`RealLiveOpcode::Unknown`] (desync
//!   tripwire) spans — the SEMANTIC 100%-decompilation bar (Utsushi cannot
//!   render a command it cannot identify). A scene that produces no opcodes
//!   is an error ([`RealLiveParseError::TruncatedBytecode`]), never a silent
//!   `Ok(vec!)`.

#[cfg(test)]
#[path = "opcode_tests.rs"]
mod tests;
include!("opcode_parts/001.rs");
include!("opcode_parts/002.rs");
include!("opcode_parts/003.rs");
include!("opcode_parts/004.rs");
include!("opcode_parts/005.rs");
