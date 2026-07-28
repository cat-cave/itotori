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

use std::collections::HashMap;
use std::sync::Arc;

use encoding_rs::SHIFT_JIS;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Stable diagnostic code emitted when [`Gameexe::parse`] cannot decode
/// a byte run as Shift-JIS. Pinned as a `const` so audit tooling can
/// match against it without scraping the `Display` form.
pub const GAMEEXE_SHIFT_JIS_DECODE_FAILURE_CODE: &str =
    "utsushi.reallive.gameexe.shift_jis_decode_failure";

/// Visibility hint carried on `SYSCOM` label values.
///
/// `#SYSCOM.005=U:"画面モード"` parses with [`SyscomVisibility::User`];
/// `#SYSCOM.011=N:"ＢＧＭ設定"` parses with [`SyscomVisibility::Navigation`].
/// Lines without a `U:` / `N:` prefix (the sub-option lines like
/// `#SYSCOM.005.000="フルスクリーン"`) parse with
/// [`SyscomVisibility::Unspecified`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyscomVisibility {
    /// User-visible label (RLDEV-documented `U:` prefix).
    User,
    /// Navigation-only label (RLDEV-documented `N:` prefix).
    Navigation,
    /// No prefix observed; this is the common case for
    /// `SYSCOM.NNN.MMM` sub-option labels.
    Unspecified,
}

/// One parsed `NAMAE` registry entry.
///
/// The RealLive engine's speaker registry keys each entry by the
/// authored display string and exposes the canonical (box-shown) name
/// plus a `(mode, color_table_index, reserved)` triple. The MIDDLE
/// field is a `#COLOR_TABLE` row index — the per-speaker DIALOGUE TEXT
/// COLOUR — NOT a voice pattern id. Voice playback is carried by
/// `koePlay` bytecode arguments, not by `#NAMAE`. (The historical
/// `(archive, pattern, pitch)` labelling mistook this colour index for
/// a voice slot; see `docs/research/reallive-engine.md` §B.) The
/// reserved field is the `-1` engine-default sentinel; the integer is
/// stored as-is, not coerced to `Option<i32>`.
///
/// Example: `#NAMAE="和人" = "和人" = (1,016, -1)` → `mode = 1`
/// `color_table_index = 16` (→ `#COLOR_TABLE.016 = 204,204,255`
/// Kazuto's pale text), `reserved = -1`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamaeEntry {
    /// Display key as authored (e.g. `"和人"`, `"？？？／凛"`). This is
    /// the `#NAMAE` lookup key an inline `【…】` name prefix carries.
    pub display: String,
    /// Canonical (box-shown) name (e.g. `"和人"`, or `"？？？"` for a
    /// still-hidden character).
    pub canonical: String,
    /// First tuple field — an engine mode flag (`0` / `1`), NOT a voice
    /// archive id.
    pub mode: i32,
    /// Middle tuple field — the `#COLOR_TABLE.<NNN>` row index that
    /// gives this speaker's dialogue text colour.
    pub color_table_index: i32,
    /// Last tuple field — reserved (`-1` is the engine-default
    /// sentinel).
    pub reserved: i32,
}

/// A speaker resolved from the `#NAMAE` + `#COLOR_TABLE` tables: the
/// name to paint in the message-window name box, and the RGB colour the
/// speaker's dialogue text is drawn in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSpeaker {
    /// Box-shown name (the `#NAMAE` canonical field).
    pub display_name: String,
    /// Dialogue text colour, resolved from `#COLOR_TABLE[color_table_index]`.
    pub color: [u8; 3],
}

/// Owned `【key】 → (display_name, colour)` table.
///
/// Built from a parsed [`Gameexe`] via [`Gameexe::namae_resolver`] and
/// cloned into the message runtime so the `Textout` → `TextLine` path
/// can resolve a leading full-width lenticular `【…】` speaker prefix
/// (the `#NAMAE` lookup key) into a display name + text colour WITHOUT
/// borrowing the whole `Gameexe`. Keyed by the `#NAMAE` display key (the
/// exact bytes an authored `【…】` prefix carries).
#[derive(Debug, Clone, Default)]
pub struct NamaeResolver {
    by_key: HashMap<String, ResolvedSpeaker>,
}

impl NamaeResolver {
    /// Resolve a `【…】` prefix key (the inner string, e.g. `"和人"`) to
    /// its display name + dialogue colour. `None` for a key with no
    /// `#NAMAE` row (narration, or an unregistered one-off token).
    pub fn resolve(&self, key: &str) -> Option<&ResolvedSpeaker> {
        self.by_key.get(key)
    }

    /// Number of registered `#NAMAE` keys.
    pub fn len(&self) -> usize {
        self.by_key.len()
    }

    /// `true` when no `#NAMAE` rows were registered.
    pub fn is_empty(&self) -> bool {
        self.by_key.is_empty()
    }
}

/// One parsed `SYSCOM` label entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyscomLabel {
    /// Visibility prefix (`U:`, `N:`, or none).
    pub visibility: SyscomVisibility,
    /// The label body. Quote characters are stripped if the RHS was a
    /// quoted string; left as-is otherwise.
    pub label: String,
}

/// Typed parsed value for a single `Gameexe.ini` key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GameexeValue {
    /// Quoted-or-unquoted scalar string.
    Str(String),
    /// Comma-separated integer array (`#SCREENSIZE_MOD=999,1280,720`).
    /// A single-integer scalar (`#SEEN_START=0001`) is stored as a
    /// one-element vector so `get_int` works uniformly.
    IntArray(Vec<i32>),
    /// `#FOLDNAME.<KIND> = "<subdir>" = <mode>: "<pakname>"`.
    Tuple3 {
        /// Subdirectory string (first RHS).
        name: String,
        /// Numeric mode flag (middle RHS).
        mode: i32,
        /// Archive / pak filename (last RHS, possibly empty).
        archive: String,
    },
    /// One `#NAMAE` speaker-registry row.
    Namae(NamaeEntry),
    /// One `#SYSCOM` labelled line.
    SyscomLabel(SyscomLabel),
}

/// Typed errors surfaced by [`Gameexe::parse`].
///
/// All variants carry the 1-based line number where the problem was
/// observed so the caller can route the diagnostic without re-walking
/// the byte stream.
#[derive(Debug, Clone, Error, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GameexeParseError {
    /// `encoding_rs` reported one or more Shift-JIS replacement-byte
    /// substitutions on the named line. The parser does not silently
    /// accept U+FFFD; the caller decides whether to recover.
    #[error(
        "Shift-JIS decode failure on line {line_number} ({code}): {byte_len} bytes could not be \
         decoded without substitution"
    )]
    ShiftJisDecode {
        /// Stable diagnostic code (matches
        /// [`GAMEEXE_SHIFT_JIS_DECODE_FAILURE_CODE`]).
        code: String,
        /// 1-based line number where the failure was observed.
        line_number: u64,
        /// Length in bytes of the line that failed to decode.
        byte_len: u64,
    },
    /// A `#KEY = …` line is missing its `=` separator (and lacks a
    /// whitespace fallback). The line is recorded verbatim (post-decode)
    /// so the caller can include it in the diagnostic.
    #[error(
        "malformed Gameexe line {line_number}: expected `#KEY = VALUE` separator, found {raw:?}"
    )]
    MissingSeparator {
        /// 1-based line number where the failure was observed.
        line_number: u64,
        /// The decoded line text.
        raw: String,
    },
    /// A `#KEY = …` line has a key that, after the leading `#`, is
    /// empty or starts with `.` / `=` (`#=…`, `#.NAME=…`).
    #[error("malformed Gameexe line {line_number}: empty or malformed key in {raw:?}")]
    MalformedKey {
        /// 1-based line number where the failure was observed.
        line_number: u64,
        /// The decoded line text.
        raw: String,
    },
    /// A `#FOLDNAME.<KIND> = …` line did not parse as the documented
    /// triple shape.
    #[error(
        "malformed FOLDNAME triple on line {line_number}: expected `\"<name>\" = <mode> : \
         \"<archive>\"`, got {raw:?}"
    )]
    MalformedFoldname {
        /// 1-based line number.
        line_number: u64,
        /// The decoded RHS.
        raw: String,
    },
    /// A `#NAMAE = …` line did not parse as the documented quintuple
    /// shape.
    #[error(
        "malformed NAMAE entry on line {line_number}: expected `\"<display>\" = \"<canonical>\" \
         = (<mode>, <color_table_index>, <reserved>)`, got {raw:?}"
    )]
    MalformedNamae {
        /// 1-based line number.
        line_number: u64,
        /// The decoded RHS.
        raw: String,
    },
}

/// Typed warning surface for recoverable [`Gameexe::parse`] failures.
///
/// The parser preserves a scalar with a non-numeric token as
/// [`GameexeValue::Str`], so typed integer accessors continue to return
/// `None`. The warning makes that recovery distinguishable from a missing
/// key to validation tooling.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("utsushi.reallive.gameexe_parse_warning: key={key} raw={raw:?}")]
pub struct GameexeParseWarning {
    /// Normalised Gameexe key that contained the malformed token.
    pub key: String,
    /// The individual token that failed to parse as an `i32`.
    pub raw: String,
}

/// Structured, queryable `Gameexe.ini` tree.
///
/// Internally a flat `HashMap<String, GameexeValue>` keyed by the
/// dotted-path key (uppercase, no leading `#`). The
/// `kaifuu-reallive::gameexe` line-classifier remains the canonical
/// per-line inventory; this struct is the query surface the runtime
/// uses.
#[derive(Debug, Clone, Default)]
pub struct Gameexe {
    entries: HashMap<String, GameexeValue>,
    /// Source-order key list. Maintained alongside `entries` so
    /// [`Gameexe::list_namespace`] returns keys in their on-disk order
    /// (useful when iterating `SYSCOM.000`, `SYSCOM.001`, … rather than
    /// hash-order).
    order: Vec<String>,
    /// Recoverable diagnostics collected while parsing numeric tokens.
    warnings: Vec<GameexeParseWarning>,
}

mod accessors;
mod parser;

/// Resolved `#WINDOW.<index>` message-window layout, read from
/// `Gameexe.ini` by [`Gameexe::message_window`]. All coordinates are in
/// the game's declared screen space ([`Gameexe::screen_size_px`]); the
/// renderer scales them to the actual framebuffer.
///
/// This is the config the message-window subsystem drives the dialogue
/// box position / colour / alpha / font-size / insets from, plus the
/// `NAME_MOD` separate-name-box mechanism. Nothing here is hardcoded — a
/// game with a different `Gameexe.ini` yields a different box.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageWindowConfig {
    /// `POS` origin/anchor type: `0`=top-left, `1`=top-right
    /// `2`=bottom-left, `3`=bottom-right.
    pub origin: i32,
    /// `POS` x offset from the anchor (screen-space px).
    pub pos_x: i32,
    /// `POS` y offset from the anchor (screen-space px).
    pub pos_y: i32,
    /// Resolved backdrop colour `(r, g, b, alpha)` — `ATTR` after the
    /// `ATTR_MOD` indirection. `alpha` is opacity (`255` = opaque).
    pub attr_rgba: (u8, u8, u8, u8),
    /// `MOJI_SIZE` message font pixel height.
    pub moji_size: u32,
    /// `MOJI_POS` box padding `(upper, lower, left, right)`.
    pub moji_pad: (i32, i32, i32, i32),
    /// `MOJI_CNT` window size in characters `(x_chars, y_chars)`, if
    /// declared. Drives the box text-area size when no waku frame is
    /// available.
    pub moji_cnt: Option<(i32, i32)>,
    /// `MOJI_REP` inter-character spacing `(x_spacing, y_spacing)`.
    pub moji_rep: (i32, i32),
    /// `LUBY_SIZE` ruby (furigana) text size (adds to line height).
    pub ruby_size: i32,
    /// `NAME_MOD`: `1` = separate name box, `0` = inline / no name box.
    pub name_mod: i32,
    /// `MESSAGE_MOD`: `0` = ADV (one message box), `1` = NVL (full-screen
    /// accumulating). Recorded for the renderer; the port currently
    /// renders one message per frame regardless.
    pub message_mod: i32,
    /// `NAME_MOJI_SIZE` name-box font pixel height.
    pub name_moji_size: u32,
    /// `NAME_POS` name-box offset `(x, y)` from the message box origin.
    pub name_pos: (i32, i32),
}

impl Default for MessageWindowConfig {
    /// A neutral bottom-anchored ADV box. This is ONLY the fallback for a
    /// context with no `Gameexe.ini` at all (e.g. a synthetic-bytecode
    /// unit test); every real title supplies its own config via
    /// [`Gameexe::message_window`].
    fn default() -> Self {
        Self {
            origin: 2,
            pos_x: 0,
            pos_y: 0,
            attr_rgba: (12, 16, 24, 200),
            moji_size: 25,
            moji_pad: (0, 0, 0, 0),
            moji_cnt: None,
            moji_rep: (0, 0),
            ruby_size: 0,
            name_mod: 0,
            message_mod: 0,
            name_moji_size: 25,
            name_pos: (0, 0),
        }
    }
}

/// Convenience builder so the runtime can hand the parsed tree around
/// through an `Arc`. Held separately from [`Gameexe::parse`] so the
/// alloc shape is callsite-decided.
pub fn parse_into_arc(bytes: &[u8]) -> Result<Arc<Gameexe>, GameexeParseError> {
    Gameexe::parse(bytes).map(Arc::new)
}

#[cfg(test)]
#[path = "gameexe_tests.rs"]
mod tests;
