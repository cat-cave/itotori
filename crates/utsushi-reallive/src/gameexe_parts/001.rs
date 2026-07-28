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


