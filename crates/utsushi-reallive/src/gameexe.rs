//! Structured `Gameexe.ini` parser.
//!
//! This module is the structured complement to
//! `kaifuu-reallive::gameexe`. Where the kaifuu module is a
//! **line-classifier / parser-boundary inventory** (one
//! `GameexeInventoryEntry` per recognised line, family + treatment
//! buckets, no value materialisation), this module decodes the
//! Shift-JIS bytes and parses each recognised value shape into a typed
//! [`GameexeValue`] keyed by its dotted path. The RealLive engine
//! queries the file by dotted path (`SYSCOM.005.000`
//! `FOLDNAME.G00`, `MOUSEACTIONCALL.000.AREA`, etc.); this module
//! provides that shape.
//!
//! # Provenance and clean-room posture
//!
//! - Shape derivation is from `docs/research/reallive-engine.md` §B
//!   (publicly archived RLDEV documentation plus byte-level counts
//!   against an observed real `Gameexe.ini`). No expression is copied
//!   from rlvm or any other GPL-licensed source. See
//!   [`crate::RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`] for the
//!   crate-level boundary statement.
//! - This module **does not** depend on `kaifuu-reallive::gameexe`
//!   internals. The structural parser is independent — duplicating the
//!   line-walking logic is intentional and load-bearing for the
//!   no-derivation posture.
//! - Shift-JIS decoding goes through the `encoding_rs` crate directly.
//!   There is no silent fallback: any byte sequence the decoder cannot
//!   round-trip surfaces as a typed [`GameexeParseError::ShiftJisDecode`].
//!   Recoverable numeric-token failures are retained in the parsed tree
//!   and exposed through [`Gameexe::warnings`] as typed
//!   [`GameexeParseWarning`] values.
//!
//! # Parsed shapes
//!
//! The parser recognises five value shapes:
//!
//! 1. **Quoted string** — `#KEY = "text"`. Stored as
//!    [`GameexeValue::Str`].
//! 2. **Unquoted scalar** — `#KEY = 1` / `#KEY = path/to/thing`.
//!    Numeric scalars are stored as a single-element
//!    [`GameexeValue::IntArray`]; non-numeric scalars are stored as
//!    [`GameexeValue::Str`].
//! 3. **Integer array** — `#KEY = 999, 1280, 720`. Stored as
//!    [`GameexeValue::IntArray`].
//! 4. **`FOLDNAME` triple** — `#FOLDNAME.G00 = "G00" = 0: "G00.PAK"`.
//!    Stored as [`GameexeValue::Tuple3`] with `(name, mode, archive)`.
//! 5. **`NAMAE` quintuple** —
//!    `#NAMAE = "display" = "canonical" = (mode, color_table_index, reserved)`.
//!    Stored as [`GameexeValue::Namae`]. Keyed by `NAMAE.<display>`
//!    so the file's 11 entries land under a queryable dotted-path
//!    namespace.
//! 6. **`SYSCOM` labelled string** — `#SYSCOM.NNN = U:"label"`
//!    `#SYSCOM.NNN = N:"label"` / `#SYSCOM.NNN.MMM = "label"`. The
//!    `U:` / `N:` prefix (when present) is captured as
//!    [`SyscomVisibility`]; the body is the user-visible label.
//!    Stored as [`GameexeValue::SyscomLabel`].
//!
//! # Lookup surface
//!
//! - [`Gameexe::get`] — arbitrary dotted-path lookup returning
//!   `Option<&GameexeValue>`.
//! - [`Gameexe::get_str`] — string-shaped accessor. Returns
//!   `Some(&str)` for `Str` and `SyscomLabel`.
//! - [`Gameexe::get_int`] — single-integer scalar.
//! - [`Gameexe::get_int_pair`] — exactly-2 integer tuple.
//! - [`Gameexe::get_int_array`] — N-integer array.
//! - [`Gameexe::get_tuple3`] — the `FOLDNAME` triple.
//! - [`Gameexe::list_namespace`] — enumerate every fully-qualified key
//!   whose dotted-path prefix matches the given namespace string.
//! - [`Gameexe::len`] — total parsed entry count (the
//!   real-bytes integration test pins this against an observed corpus's 1,345
//!   recognised lines).
//!
//! Missing keys return `None`. Type mismatches (asking `get_str` for
//! an entry stored as `IntArray`) return `None`. Neither path surfaces
//! a panic. Fatal malformed **input** at parse time raises a typed
//! [`GameexeParseError`] from [`Gameexe::parse`]; recoverable numeric
//! token failures are recorded as [`GameexeParseWarning`] values.

#[cfg(test)]
#[path = "gameexe_tests.rs"]
mod tests;
include!("gameexe_parts/001.rs");
include!("gameexe_parts/002.rs");
include!("gameexe_parts/003.rs");
