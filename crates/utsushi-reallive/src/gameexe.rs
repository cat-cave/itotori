//! UTSUSHI-207 — structured `Gameexe.ini` parser.
//!
//! This module is the structured complement to
//! `kaifuu-reallive::gameexe`. Where the kaifuu module is a
//! **line-classifier / parser-boundary inventory** (one
//! `GameexeInventoryEntry` per recognised line, family + treatment
//! buckets, no value materialisation), this module decodes the
//! Shift-JIS bytes and parses each recognised value shape into a typed
//! [`GameexeValue`] keyed by its dotted path. The RealLive engine
//! queries the file by dotted path (`SYSCOM.005.000`,
//! `FOLDNAME.G00`, `MOUSEACTIONCALL.000.AREA`, etc.); this module
//! provides that shape.
//!
//! # Provenance and clean-room posture
//!
//! - Shape derivation is from `docs/research/reallive-engine.md` §B
//!   (publicly archived RLDEV documentation plus byte-level counts
//!   against Sweetie HD's real `Gameexe.ini`). No expression is copied
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
//! 4. **`FOLDNAME` triple** — `#FOLDNAME.G00 = "G00" = 0 : "G00.PAK"`.
//!    Stored as [`GameexeValue::Tuple3`] with `(name, mode, archive)`.
//! 5. **`NAMAE` quintuple** —
//!    `#NAMAE = "display" = "canonical" = (mode, color_table_index, reserved)`.
//!    Stored as [`GameexeValue::Namae`]. Keyed by `NAMAE.<display>`
//!    so the file's 11 entries land under a queryable dotted-path
//!    namespace.
//! 6. **`SYSCOM` labelled string** — `#SYSCOM.NNN = U:"label"` /
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
//!   real-bytes integration test pins this against Sweetie HD's 1,345
//!   recognised lines).
//!
//! Missing keys return `None`. Type mismatches (asking `get_str` for
//! an entry stored as `IntArray`) return `None`. Neither path surfaces
//! a panic. Malformed **input** at parse time raises a typed
//! [`GameexeParseError`] from [`Gameexe::parse`].

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
/// Example: `#NAMAE="和人" = "和人" = (1,016, -1)` → `mode = 1`,
/// `color_table_index = 16` (→ `#COLOR_TABLE.016 = 204,204,255`,
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
    /// `#FOLDNAME.<KIND> = "<subdir>" = <mode> : "<pakname>"`.
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
}

impl Gameexe {
    /// Parse a `Gameexe.ini` byte slice.
    ///
    /// Decodes Shift-JIS via `encoding_rs`. Surfaces typed
    /// [`GameexeParseError`] on Shift-JIS substitution or structural
    /// failure. There is no silent fallback: callers that want lossy
    /// recovery must implement it on top of [`Gameexe::parse`].
    pub fn parse(bytes: &[u8]) -> Result<Self, GameexeParseError> {
        let mut entries: HashMap<String, GameexeValue> = HashMap::new();
        let mut order: Vec<String> = Vec::new();
        let mut cursor = 0usize;
        let mut line_number: u64 = 0;
        while cursor < bytes.len() {
            line_number += 1;
            let line_start = cursor;
            let mut newline = cursor;
            while newline < bytes.len() && bytes[newline] != b'\n' {
                newline += 1;
            }
            let mut line_end = newline;
            if line_end > line_start && bytes[line_end - 1] == b'\r' {
                line_end -= 1;
            }
            cursor = newline.saturating_add(1).min(bytes.len() + 1);
            if cursor > bytes.len() {
                cursor = bytes.len();
            }
            let line_bytes = &bytes[line_start..line_end];

            // Cheap skips before the Shift-JIS round-trip: an empty
            // line or a line whose first non-whitespace byte is not `#`
            // is a comment or blank and is ignored.
            let trimmed_bytes = trim_leading_ascii_ws(line_bytes);
            if trimmed_bytes.is_empty() || trimmed_bytes[0] != b'#' {
                continue;
            }

            // Now decode Shift-JIS strictly. `encoding_rs` returns
            // `had_replacement` when it substituted U+FFFD; we surface
            // that as a typed error so the caller cannot ignore it.
            let (decoded, _, had_replacement) = SHIFT_JIS.decode(line_bytes);
            if had_replacement {
                return Err(GameexeParseError::ShiftJisDecode {
                    code: GAMEEXE_SHIFT_JIS_DECODE_FAILURE_CODE.to_string(),
                    line_number,
                    byte_len: line_bytes.len() as u64,
                });
            }
            let decoded = decoded.into_owned();
            let trimmed = trim_leading_ws(&decoded);

            // Split at the first `=` or whitespace. We require a
            // separator at minimum so structural errors raise instead
            // of silently dropping a `#KEY` with no value. The
            // line-classifier in `kaifuu-reallive` is permissive on
            // this point; the structural parser is not.
            let Some((key_raw, value_raw)) = split_key_value(trimmed) else {
                return Err(GameexeParseError::MissingSeparator {
                    line_number,
                    raw: decoded,
                });
            };
            let bare_key = key_raw
                .strip_prefix('#')
                .ok_or_else(|| GameexeParseError::MalformedKey {
                    line_number,
                    raw: decoded.clone(),
                })?
                .trim();
            if bare_key.is_empty() || bare_key.starts_with('.') || bare_key.starts_with('=') {
                return Err(GameexeParseError::MalformedKey {
                    line_number,
                    raw: decoded,
                });
            }
            let upper_key = bare_key.to_uppercase();
            let value_text = value_raw.trim();

            // Per-shape branching. The order matters: dotted prefixes
            // are checked before bare suffix-stripping so the more
            // specific shape wins.
            let (final_key, value) = if let Some(kind) = upper_key.strip_prefix("FOLDNAME.") {
                let parsed = parse_foldname_triple(value_text).ok_or_else(|| {
                    GameexeParseError::MalformedFoldname {
                        line_number,
                        raw: value_text.to_string(),
                    }
                })?;
                (format!("FOLDNAME.{kind}"), parsed)
            } else if upper_key == "NAMAE" {
                let (display, value) = parse_namae_entry(value_text).ok_or_else(|| {
                    GameexeParseError::MalformedNamae {
                        line_number,
                        raw: value_text.to_string(),
                    }
                })?;
                (format!("NAMAE.{display}"), value)
            } else if upper_key.starts_with("SYSCOM.") {
                let label = parse_syscom_label(value_text);
                (upper_key, GameexeValue::SyscomLabel(label))
            } else {
                let value = parse_scalar_value(value_text);
                (upper_key, value)
            };

            if !entries.contains_key(&final_key) {
                order.push(final_key.clone());
            }
            entries.insert(final_key, value);
        }
        Ok(Self { entries, order })
    }

    /// Total parsed key count. Each `NAMAE` row counts individually
    /// because it is stored under `NAMAE.<display>`.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// `true` when no recognised lines were parsed.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Arbitrary dotted-path lookup. Returns `None` for missing keys.
    pub fn get(&self, key: &str) -> Option<&GameexeValue> {
        self.entries.get(&normalise_key(key))
    }

    /// String-shaped accessor. Returns `Some(&str)` for
    /// [`GameexeValue::Str`] and the label of a
    /// [`GameexeValue::SyscomLabel`]. Returns `None` for any other
    /// shape (including missing keys, integer arrays, and tuples).
    pub fn get_str(&self, key: &str) -> Option<&str> {
        match self.get(key)? {
            GameexeValue::Str(s) => Some(s.as_str()),
            GameexeValue::SyscomLabel(label) => Some(label.label.as_str()),
            _ => None,
        }
    }

    /// Single-integer scalar accessor. Returns `Some(int)` when the
    /// stored value is a one-element [`GameexeValue::IntArray`]; returns
    /// `None` otherwise.
    pub fn get_int(&self, key: &str) -> Option<i32> {
        match self.get(key)? {
            GameexeValue::IntArray(ints) if ints.len() == 1 => Some(ints[0]),
            _ => None,
        }
    }

    /// Exactly-two-integer accessor (e.g. `CANCELCALL=9999,10`).
    pub fn get_int_pair(&self, key: &str) -> Option<(i32, i32)> {
        match self.get(key)? {
            GameexeValue::IntArray(ints) if ints.len() == 2 => Some((ints[0], ints[1])),
            _ => None,
        }
    }

    /// Integer-array accessor. Returns the borrowed slice for any
    /// [`GameexeValue::IntArray`]; returns `None` for missing keys or
    /// other value shapes.
    pub fn get_int_array(&self, key: &str) -> Option<&[i32]> {
        match self.get(key)? {
            GameexeValue::IntArray(ints) => Some(ints.as_slice()),
            _ => None,
        }
    }

    /// `FOLDNAME` triple accessor. Returns
    /// `Some((name, mode, archive))` for [`GameexeValue::Tuple3`].
    pub fn get_tuple3(&self, key: &str) -> Option<(&str, i32, &str)> {
        match self.get(key)? {
            GameexeValue::Tuple3 {
                name,
                mode,
                archive,
            } => Some((name.as_str(), *mode, archive.as_str())),
            _ => None,
        }
    }

    /// `NAMAE` entry accessor. Returns the borrowed
    /// [`NamaeEntry`] for [`GameexeValue::Namae`].
    pub fn get_namae(&self, key: &str) -> Option<&NamaeEntry> {
        match self.get(key)? {
            GameexeValue::Namae(entry) => Some(entry),
            _ => None,
        }
    }

    /// Resolve a `#COLOR_TABLE.<index>` row to an RGB triple. The table
    /// is authored with zero-padded 3-digit indices
    /// (`#COLOR_TABLE.016=204,204,255`); a bare `<index>` form is
    /// accepted as a fallback. Returns `None` for a missing / malformed
    /// / negative index.
    pub fn color_table_rgb(&self, index: i32) -> Option<[u8; 3]> {
        if index < 0 {
            return None;
        }
        let padded = format!("COLOR_TABLE.{index:03}");
        let arr = self
            .get_int_array(&padded)
            .or_else(|| self.get_int_array(&format!("COLOR_TABLE.{index}")))?;
        if arr.len() < 3 {
            return None;
        }
        let clamp = |v: i32| v.clamp(0, 255) as u8;
        Some([clamp(arr[0]), clamp(arr[1]), clamp(arr[2])])
    }

    /// Build an owned `【key】 → (display_name, colour)` resolver from the
    /// parsed `#NAMAE` + `#COLOR_TABLE` tables.
    ///
    /// Each `#NAMAE` row is keyed by its display key (the exact bytes an
    /// authored inline `【…】` name prefix carries); the resolved
    /// display name is the row's canonical (box-shown) field and the
    /// colour is `#COLOR_TABLE[color_table_index]` (falling back to
    /// opaque white when the row's index has no palette entry).
    pub fn namae_resolver(&self) -> NamaeResolver {
        let mut by_key = HashMap::new();
        for key in self.list_namespace("NAMAE") {
            let Some(entry) = self.get_namae(key) else {
                continue;
            };
            let display_key = key.strip_prefix("NAMAE.").unwrap_or(key).to_string();
            let color = self
                .color_table_rgb(entry.color_table_index)
                .unwrap_or([255, 255, 255]);
            by_key.insert(
                display_key,
                ResolvedSpeaker {
                    display_name: entry.canonical.clone(),
                    color,
                },
            );
        }
        NamaeResolver { by_key }
    }

    /// Enumerate every key under the given dotted-path namespace.
    ///
    /// The namespace is matched as a dotted prefix: `list_namespace("SYSCOM")`
    /// returns every key whose dotted-path starts with `SYSCOM.`.
    /// Returned keys are full dotted paths in source-file order (the
    /// order they were first observed during the byte walk).
    pub fn list_namespace(&self, namespace: &str) -> Vec<&str> {
        let prefix = normalise_key(namespace);
        let with_dot = format!("{prefix}.");
        self.order
            .iter()
            .filter(|key| key.as_str() == prefix || key.starts_with(&with_dot))
            .map(String::as_str)
            .collect()
    }

    /// Borrowed iterator over `(key, value)` pairs in source-file
    /// order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &GameexeValue)> {
        self.order
            .iter()
            .filter_map(|key| self.entries.get(key).map(|value| (key.as_str(), value)))
    }

    /// The game's declared framebuffer size, read from
    /// `#SCREENSIZE_MOD`. The message-window `POS` / `MOJI_POS` /
    /// `NAME_POS` coordinates are authored in THIS space.
    ///
    /// - `#SCREENSIZE_MOD=0` → classic `640x480` (Kanon and other
    ///   1.2.6.x titles).
    /// - `#SCREENSIZE_MOD=1` → `800x600`.
    /// - `#SCREENSIZE_MOD=999,w,h` → the explicit `w x h` (Sweetie HD:
    ///   `999,1280,720`).
    /// - missing / malformed → classic `640x480`.
    pub fn screen_size_px(&self) -> (u32, u32) {
        match self.get_int_array("SCREENSIZE_MOD") {
            Some([_mode, w, h, ..]) if *w > 0 && *h > 0 => (*w as u32, *h as u32),
            Some([1]) => (800, 600),
            _ => (640, 480),
        }
    }

    /// Resolve the [`MessageWindowConfig`] for the `#WINDOW.<index>` set
    /// (typically index `0`, `#WINDOW.000`). Every field is a REAL
    /// Gameexe value read from disk — the dialogue box position, colour,
    /// alpha, font size and insets are config-driven, never hardcoded.
    ///
    /// The `ATTR` RGBA is resolved through the RealLive `ATTR_MOD`
    /// indirection exactly as the engine does: when
    /// `#WINDOW.<index>.ATTR_MOD=0` the global `#WINDOW_ATTR` supplies the
    /// colour; otherwise the window-local `#WINDOW.<index>.ATTR` does.
    /// Keys the game omits fall back to RealLive's documented defaults.
    pub fn message_window(&self, index: u32) -> MessageWindowConfig {
        let base = format!("WINDOW.{index:03}");
        let key = |suffix: &str| format!("{base}.{suffix}");

        // POS is stored as a `Str` ("type:x,y") because the leading
        // `type:` token defeats the plain int-array parser.
        let (origin, pos_x, pos_y) = self
            .get_str(&key("POS"))
            .and_then(parse_pos_triple)
            .unwrap_or((2, 0, 0));

        // ATTR_MOD indirection: 0 (or absent) → global #WINDOW_ATTR;
        // otherwise the window-local ATTR.
        let attr_mod = self.get_int(&key("ATTR_MOD")).unwrap_or(0);
        let attr_source = if attr_mod == 0 {
            self.get_int_array("WINDOW_ATTR")
        } else {
            self.get_int_array(&key("ATTR"))
        };
        let attr_rgba = attr_source.filter(|attr| attr.len() >= 4).map_or(
            // Dark, mostly-opaque slate fallback for a Gameexe with no
            // window colour declared at all.
            (10, 16, 24, 200),
            |attr| {
                (
                    clamp_u8(attr[0]),
                    clamp_u8(attr[1]),
                    clamp_u8(attr[2]),
                    clamp_u8(attr[3]),
                )
            },
        );

        let moji_size = self.get_int(&key("MOJI_SIZE")).unwrap_or(25).max(1) as u32;
        // MOJI_POS is (upper, lower, left, right) per the RealLive
        // text-box padding convention.
        let moji_pad = self
            .get_int_array(&key("MOJI_POS"))
            .filter(|pad| pad.len() >= 4)
            .map_or((0, 0, 0, 0), |pad| (pad[0], pad[1], pad[2], pad[3]));
        let moji_cnt = self
            .get_int_array(&key("MOJI_CNT"))
            .filter(|cnt| cnt.len() >= 2)
            .map(|cnt| (cnt[0], cnt[1]));
        let moji_rep = self
            .get_int_array(&key("MOJI_REP"))
            .filter(|rep| rep.len() >= 2)
            .map_or((0, 0), |rep| (rep[0], rep[1]));
        let ruby_size = self.get_int(&key("LUBY_SIZE")).unwrap_or(0);

        let name_mod = self.get_int(&key("NAME_MOD")).unwrap_or(0);
        let message_mod = self.get_int(&key("MESSAGE_MOD")).unwrap_or(0);
        let name_moji_size = self
            .get_int(&key("NAME_MOJI_SIZE"))
            .map_or(moji_size, |value| value.max(1) as u32);
        let name_pos = self.get_int_pair(&key("NAME_POS")).unwrap_or((0, 0));

        MessageWindowConfig {
            origin,
            pos_x,
            pos_y,
            attr_rgba,
            moji_size,
            moji_pad,
            moji_cnt,
            moji_rep,
            ruby_size,
            name_mod,
            message_mod,
            name_moji_size,
            name_pos,
        }
    }

    /// The `#WINDOW.<index>` set index the engine renders a `select`
    /// prompt into, read from the real `#DEFAULT_SEL_WINDOW` Gameexe key
    /// (Kanon `#DEFAULT_SEL_WINDOW=000`, Sweetie HD `=031`). RealLive uses
    /// this number to pick the `#WINDOW.NNN` box that frames the choice
    /// options — the selection window is a `#WINDOW` set, exactly like the
    /// message window. A value `< 0` (the "use the standard text window"
    /// sentinel) or a missing key falls back to index `0`.
    pub fn sel_window_index(&self) -> u32 {
        match self.get_int("DEFAULT_SEL_WINDOW") {
            Some(index) if index >= 0 => index as u32,
            _ => 0,
        }
    }

    /// Resolve the [`MessageWindowConfig`] the engine frames a `select`
    /// prompt's option list into: the `#WINDOW.<index>` set named by
    /// [`Gameexe::sel_window_index`] (`#DEFAULT_SEL_WINDOW`). Config-driven
    /// exactly like [`Gameexe::message_window`] — position / colour / alpha
    /// / font-size / insets are the real Gameexe values, never hardcoded.
    pub fn sel_window(&self) -> MessageWindowConfig {
        self.message_window(self.sel_window_index())
    }
}

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
    /// `POS` origin/anchor type: `0`=top-left, `1`=top-right,
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

/// Parse a RealLive `#WINDOW.xxx.POS` value (`"type:x,y"`) into
/// `(origin_type, x, y)`. Returns `None` when the shape does not match.
fn parse_pos_triple(raw: &str) -> Option<(i32, i32, i32)> {
    let (type_text, coords) = raw.split_once(':')?;
    let origin: i32 = type_text.trim().parse().ok()?;
    let (x_text, y_text) = coords.split_once(',')?;
    let x: i32 = x_text.trim().parse().ok()?;
    let y: i32 = y_text.trim().parse().ok()?;
    Some((origin, x, y))
}

/// Clamp an `i32` Gameexe colour/alpha channel into `u8` range.
fn clamp_u8(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

/// Convenience builder so the runtime can hand the parsed tree around
/// through an `Arc`. Held separately from [`Gameexe::parse`] so the
/// alloc shape is callsite-decided.
pub fn parse_into_arc(bytes: &[u8]) -> Result<Arc<Gameexe>, GameexeParseError> {
    Gameexe::parse(bytes).map(Arc::new)
}

// ---------- key + value parsers ----------

fn normalise_key(key: &str) -> String {
    key.trim().trim_start_matches('#').to_uppercase()
}

fn trim_leading_ascii_ws(bytes: &[u8]) -> &[u8] {
    let mut start = 0;
    while start < bytes.len() && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    &bytes[start..]
}

fn trim_leading_ws(text: &str) -> &str {
    text.trim_start()
}

/// Split a trimmed `#KEY = VALUE` line into its key half and value
/// half. The separator can be `=` or whitespace (Gameexe.ini accepts
/// both). Returns `None` if no separator is found.
fn split_key_value(line: &str) -> Option<(&str, &str)> {
    let mut split_at = None;
    for (i, ch) in line.char_indices() {
        if ch == '=' || ch.is_ascii_whitespace() {
            split_at = Some((i, ch));
            break;
        }
    }
    let (i, separator) = split_at?;
    let key = &line[..i];
    let mut rest = &line[i + separator.len_utf8()..];
    // Consume the rest of the separator run.
    loop {
        let mut chars = rest.char_indices();
        match chars.next() {
            Some((0, ch)) if ch == '=' || ch.is_ascii_whitespace() => {
                rest = &rest[ch.len_utf8()..];
            }
            _ => break,
        }
    }
    Some((key, rest))
}

/// Decide the shape of a raw RHS for a non-special key.
///
/// Order of operations:
/// 1. If the entire trimmed RHS is `"…"`, return [`GameexeValue::Str`] with
///    the unquoted body.
/// 2. If every comma-separated, whitespace-trimmed token parses as an
///    `i32`, return [`GameexeValue::IntArray`].
/// 3. Otherwise treat the RHS as a string scalar
///    ([`GameexeValue::Str`]).
fn parse_scalar_value(raw: &str) -> GameexeValue {
    let trimmed = raw.trim();
    if let Some(inner) = strip_outer_quotes(trimmed) {
        return GameexeValue::Str(inner.to_string());
    }
    if let Some(ints) = parse_int_list(trimmed) {
        return GameexeValue::IntArray(ints);
    }
    GameexeValue::Str(trimmed.to_string())
}

fn strip_outer_quotes(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
        let inner = &text[1..text.len() - 1];
        if !inner.contains('"') {
            return Some(inner);
        }
    }
    None
}

fn parse_int_list(text: &str) -> Option<Vec<i32>> {
    let mut out = Vec::new();
    for token in text.split(',') {
        let token = token.trim();
        if token.is_empty() {
            return None;
        }
        let parsed: i32 = token.parse().ok()?;
        out.push(parsed);
    }
    if out.is_empty() { None } else { Some(out) }
}

/// Parse a `FOLDNAME` RHS:
/// `"<name>" = <mode> : "<archive>"`. The archive string may be empty
/// (`#FOLDNAME.KOE = "KOE" = 1 : ""`).
fn parse_foldname_triple(raw: &str) -> Option<GameexeValue> {
    let (name_field, after_name) = take_quoted_string(raw)?;
    let after_name = skip_separator(after_name, '=');
    let (mode_text, after_mode) = take_until(after_name, ':');
    let mode: i32 = mode_text.trim().parse().ok()?;
    let after_colon = after_mode.strip_prefix(':')?.trim_start();
    let (archive_field, _) = take_quoted_string(after_colon)?;
    Some(GameexeValue::Tuple3 {
        name: name_field.to_string(),
        mode,
        archive: archive_field.to_string(),
    })
}

/// Parse a `NAMAE` RHS:
/// `"<display>" = "<canonical>" = (<mode>, <color_table_index>, <reserved>)`.
/// Returns the parsed display key alongside the value so the caller
/// can route the entry under `NAMAE.<display>` in the flat map.
fn parse_namae_entry(raw: &str) -> Option<(String, GameexeValue)> {
    let (display, after_display) = take_quoted_string(raw)?;
    let after_display = skip_separator(after_display, '=');
    let (canonical, after_canonical) = take_quoted_string(after_display)?;
    let after_canonical = skip_separator(after_canonical, '=');
    let after_open = after_canonical.trim_start().strip_prefix('(')?;
    let close = after_open.find(')')?;
    let tuple_text = &after_open[..close];
    let parts: Vec<&str> = tuple_text.split(',').map(str::trim).collect();
    if parts.len() != 3 {
        return None;
    }
    let mode: i32 = parts[0].parse().ok()?;
    let color_table_index: i32 = parts[1].parse().ok()?;
    let reserved: i32 = parts[2].parse().ok()?;
    Some((
        display.to_string(),
        GameexeValue::Namae(NamaeEntry {
            display: display.to_string(),
            canonical: canonical.to_string(),
            mode,
            color_table_index,
            reserved,
        }),
    ))
}

/// Parse a `SYSCOM.*` RHS, peeling off the optional `U:` / `N:`
/// visibility prefix and the surrounding quotes.
///
/// Examples:
/// - `U:"画面モード"` → `(User, "画面モード")`
/// - `N:"ＢＧＭ設定"` → `(Navigation, "ＢＧＭ設定")`
/// - `"フルスクリーン"` → `(Unspecified, "フルスクリーン")`
/// - `1` → `(Unspecified, "1")` (sub-keys like `SYSCOM.002.PAGE=0` land
///   here)
fn parse_syscom_label(raw: &str) -> SyscomLabel {
    let trimmed = raw.trim();
    let (visibility, body) = if let Some(rest) = trimmed.strip_prefix("U:") {
        (SyscomVisibility::User, rest)
    } else if let Some(rest) = trimmed.strip_prefix("N:") {
        (SyscomVisibility::Navigation, rest)
    } else {
        (SyscomVisibility::Unspecified, trimmed)
    };
    let body = body.trim();
    let label = strip_outer_quotes(body).map_or_else(|| body.to_string(), str::to_string);
    SyscomLabel { visibility, label }
}

/// Read a quoted `"…"` substring at the start of `text` and return
/// `(inner, rest)` where `rest` is the byte run after the closing
/// quote. Trims leading whitespace. Returns `None` if the input does
/// not begin with a quote or has no matching closing quote.
fn take_quoted_string(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_start();
    let rest = text.strip_prefix('"')?;
    let close = rest.find('"')?;
    let inner = &rest[..close];
    let after = &rest[close + 1..];
    Some((inner, after))
}

/// Skip leading whitespace and a single occurrence of `separator`.
fn skip_separator(text: &str, separator: char) -> &str {
    let text = text.trim_start();
    text.strip_prefix(separator).map_or(text, str::trim_start)
}

/// Split `text` at the first occurrence of `delimiter`, returning
/// `(before, from_delimiter_inclusive)`.
fn take_until(text: &str, delimiter: char) -> (&str, &str) {
    match text.find(delimiter) {
        Some(idx) => (&text[..idx], &text[idx..]),
        None => (text, ""),
    }
}

// ---------- unit tests (synthetic) ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_str(text: &str) -> Gameexe {
        let bytes = encoding_rs::SHIFT_JIS.encode(text).0.into_owned();
        Gameexe::parse(&bytes).expect("synthetic input must parse")
    }

    #[test]
    fn parses_quoted_string_scalar() {
        let gx = parse_str("#CAPTION=\"hello\"\r\n");
        assert_eq!(gx.get_str("CAPTION"), Some("hello"));
        assert!(gx.get_int_array("CAPTION").is_none());
    }

    #[test]
    fn parses_unquoted_string_scalar() {
        let gx = parse_str("#REGNAME = HADASHI\\OSHIOKIHD\r\n");
        assert_eq!(gx.get_str("REGNAME"), Some("HADASHI\\OSHIOKIHD"));
    }

    #[test]
    fn parses_integer_scalar_as_one_element_array() {
        let gx = parse_str("#SEEN_START=0001\r\n");
        assert_eq!(gx.get_int("SEEN_START"), Some(1));
        assert_eq!(gx.get_int_array("SEEN_START"), Some(&[1][..]));
        assert!(gx.get_str("SEEN_START").is_none());
    }

    #[test]
    fn screen_size_reads_screensize_mod() {
        assert_eq!(
            parse_str("#SCREENSIZE_MOD=0\r\n").screen_size_px(),
            (640, 480)
        );
        assert_eq!(
            parse_str("#SCREENSIZE_MOD=1\r\n").screen_size_px(),
            (800, 600)
        );
        assert_eq!(
            parse_str("#SCREENSIZE_MOD=999,1280,720\r\n").screen_size_px(),
            (1280, 720)
        );
        // Missing → classic default, never a panic.
        assert_eq!(parse_str("#CAPTION=\"x\"\r\n").screen_size_px(), (640, 480));
    }

    #[test]
    fn message_window_reads_kanon_shaped_window() {
        // Kanon #WINDOW.000: top-left bottom box, ATTR_MOD=0 so the global
        // #WINDOW_ATTR supplies the colour, NAME_MOD=0 (narration only).
        let gx = parse_str(
            "#WINDOW_ATTR=100,100,160,200,0\r\n\
             #WINDOW.000.POS=0:0,345\r\n\
             #WINDOW.000.ATTR_MOD=0\r\n\
             #WINDOW.000.ATTR=080,112,160,255,0\r\n\
             #WINDOW.000.MOJI_SIZE=25\r\n\
             #WINDOW.000.MOJI_POS=19,0,53,0\r\n\
             #WINDOW.000.MOJI_CNT=22,3\r\n\
             #WINDOW.000.MOJI_REP=-1,3\r\n\
             #WINDOW.000.NAME_MOD=0\r\n\
             #WINDOW.000.MESSAGE_MOD=0\r\n",
        );
        let cfg = gx.message_window(0);
        assert_eq!(cfg.origin, 0);
        assert_eq!((cfg.pos_x, cfg.pos_y), (0, 345));
        // ATTR_MOD=0 → global WINDOW_ATTR wins over the window-local ATTR.
        assert_eq!(cfg.attr_rgba, (100, 100, 160, 200));
        assert_eq!(cfg.moji_size, 25);
        assert_eq!(cfg.moji_pad, (19, 0, 53, 0));
        assert_eq!(cfg.moji_cnt, Some((22, 3)));
        assert_eq!(cfg.moji_rep, (-1, 3));
        assert_eq!(cfg.name_mod, 0);
    }

    #[test]
    fn message_window_reads_sweetie_shaped_name_box_and_local_attr() {
        // Sweetie HD #WINDOW.000 with ATTR_MOD=1 → the window-local ATTR
        // is used; NAME_MOD=1 → separate name box.
        let gx = parse_str(
            "#WINDOW_ATTR=100,100,160,200,0\r\n\
             #WINDOW.000.POS=2:220,0\r\n\
             #WINDOW.000.ATTR_MOD=1\r\n\
             #WINDOW.000.ATTR=10,20,30,240,0\r\n\
             #WINDOW.000.MOJI_SIZE=36\r\n\
             #WINDOW.000.MOJI_POS=48,0,12,0\r\n\
             #WINDOW.000.NAME_MOD=1\r\n\
             #WINDOW.000.NAME_MOJI_SIZE=25\r\n\
             #WINDOW.000.NAME_POS=18,26\r\n\
             #WINDOW.000.MESSAGE_MOD=0\r\n",
        );
        let cfg = gx.message_window(0);
        assert_eq!(cfg.origin, 2);
        assert_eq!((cfg.pos_x, cfg.pos_y), (220, 0));
        // ATTR_MOD=1 → window-local ATTR, NOT the global.
        assert_eq!(cfg.attr_rgba, (10, 20, 30, 240));
        assert_eq!(cfg.moji_size, 36);
        assert_eq!(cfg.name_mod, 1);
        assert_eq!(cfg.name_moji_size, 25);
        assert_eq!(cfg.name_pos, (18, 26));
    }

    #[test]
    fn parses_integer_array() {
        let gx = parse_str("#SCREENSIZE_MOD=999,1280,720\r\n");
        assert_eq!(
            gx.get_int_array("SCREENSIZE_MOD"),
            Some(&[999, 1280, 720][..])
        );
        // Asking for a string on an int-array yields None — typed mismatch
        // never panics.
        assert!(gx.get_str("SCREENSIZE_MOD").is_none());
        // Wrong shape accessors also return None, not a wrong-shape
        // partial answer.
        assert!(gx.get_int("SCREENSIZE_MOD").is_none());
        assert!(gx.get_int_pair("SCREENSIZE_MOD").is_none());
    }

    #[test]
    fn parses_integer_pair() {
        let gx = parse_str("#CANCELCALL=9999,10\r\n");
        assert_eq!(gx.get_int_pair("CANCELCALL"), Some((9999, 10)));
        assert_eq!(gx.get_int_array("CANCELCALL"), Some(&[9999, 10][..]));
    }

    #[test]
    fn parses_foldname_triple_with_empty_archive() {
        let gx = parse_str("#FOLDNAME.KOE = \"KOE\" =  1   : \"\"\r\n");
        assert_eq!(gx.get_tuple3("FOLDNAME.KOE"), Some(("KOE", 1, "")));
    }

    #[test]
    fn parses_foldname_triple_with_pak() {
        let gx = parse_str("#FOLDNAME.G00 = \"G00\" =  0   : \"G00.PAK\"\r\n");
        assert_eq!(gx.get_tuple3("FOLDNAME.G00"), Some(("G00", 0, "G00.PAK")));
    }

    #[test]
    fn malformed_foldname_raises_typed_error() {
        let bytes = b"#FOLDNAME.X = no_quote = 0 : \"X.PAK\"\r\n";
        let err = Gameexe::parse(bytes).expect_err("malformed FOLDNAME must raise");
        assert!(matches!(err, GameexeParseError::MalformedFoldname { .. }));
    }

    #[test]
    fn parses_namae_entry_keyed_by_display() {
        // Encoded so the input is true Shift-JIS bytes, not UTF-8.
        let gx = parse_str("#NAMAE=\"和人\" = \"和人\" = (1,016, -1)\r\n");
        let entry = gx
            .get_namae("NAMAE.和人")
            .expect("NAMAE.<display> must be reachable");
        assert_eq!(entry.display, "和人");
        assert_eq!(entry.canonical, "和人");
        assert_eq!(entry.mode, 1);
        assert_eq!(entry.color_table_index, 16);
        assert_eq!(entry.reserved, -1);
    }

    #[test]
    fn namae_resolver_maps_key_to_display_and_color_table_rgb() {
        // NAMAE middle field is a #COLOR_TABLE index, not a voice slot.
        // 和人 → idx 16 → COLOR_TABLE.016 = (204,204,255) pale;
        // 真理子 → idx 14 → COLOR_TABLE.014 = (255,153,204) pink.
        let gx = parse_str(
            "#COLOR_TABLE.014=255,153,204\r\n\
             #COLOR_TABLE.016=204,204,255\r\n\
             #NAMAE=\"和人\" = \"和人\" = (1,016, -1)\r\n\
             #NAMAE=\"真理子\" = \"真理子\" = (1,014, -1)\r\n\
             #NAMAE=\"？？？／凛\" = \"？？？\" = (1,015, -1)\r\n",
        );
        let resolver = gx.namae_resolver();
        let kazuto = resolver.resolve("和人").expect("和人 resolves");
        assert_eq!(kazuto.display_name, "和人");
        assert_eq!(kazuto.color, [204, 204, 255]);
        let mariko = resolver.resolve("真理子").expect("真理子 resolves");
        assert_eq!(mariko.display_name, "真理子");
        assert_eq!(mariko.color, [255, 153, 204]);
        // Censored key shows the canonical box name (？？？), not the key.
        let hidden = resolver.resolve("？？？／凛").expect("？？？／凛 resolves");
        assert_eq!(hidden.display_name, "？？？");
        // Narration / unregistered key → no speaker.
        assert!(resolver.resolve("ナレーション").is_none());
    }

    #[test]
    fn malformed_namae_raises_typed_error() {
        let bytes = b"#NAMAE=\"unclosed\r\n";
        let err = Gameexe::parse(bytes).expect_err("unclosed NAMAE must raise");
        assert!(matches!(err, GameexeParseError::MalformedNamae { .. }));
    }

    #[test]
    fn parses_syscom_user_prefix() {
        let gx = parse_str("#SYSCOM.000=U:\"label\"\r\n");
        let value = gx.get("SYSCOM.000").expect("SYSCOM.000 must be reachable");
        match value {
            GameexeValue::SyscomLabel(label) => {
                assert_eq!(label.visibility, SyscomVisibility::User);
                assert_eq!(label.label, "label");
            }
            other => panic!("expected SyscomLabel, got {other:?}"),
        }
        // get_str on a SyscomLabel returns the label body.
        assert_eq!(gx.get_str("SYSCOM.000"), Some("label"));
    }

    #[test]
    fn parses_syscom_nav_prefix() {
        let gx = parse_str("#SYSCOM.011=N:\"label\"\r\n");
        let value = gx.get("SYSCOM.011").expect("SYSCOM.011 must be reachable");
        match value {
            GameexeValue::SyscomLabel(label) => {
                assert_eq!(label.visibility, SyscomVisibility::Navigation);
                assert_eq!(label.label, "label");
            }
            other => panic!("expected SyscomLabel, got {other:?}"),
        }
    }

    #[test]
    fn parses_syscom_sub_option_without_prefix() {
        let gx = parse_str("#SYSCOM.005.000=\"option0\"\r\n");
        let value = gx.get("SYSCOM.005.000").expect("must be reachable");
        match value {
            GameexeValue::SyscomLabel(label) => {
                assert_eq!(label.visibility, SyscomVisibility::Unspecified);
                assert_eq!(label.label, "option0");
            }
            other => panic!("expected SyscomLabel, got {other:?}"),
        }
    }

    #[test]
    fn missing_key_returns_none_not_error() {
        let gx = parse_str("#FOO=1\r\n");
        assert!(gx.get("BAR").is_none());
        assert!(gx.get_str("BAR").is_none());
        assert!(gx.get_int("BAR").is_none());
        assert!(gx.get_int_array("BAR").is_none());
        assert!(gx.get_tuple3("BAR").is_none());
    }

    #[test]
    fn list_namespace_returns_source_order() {
        let gx = parse_str("#SYSCOM.000=U:\"A\"\r\n#SYSCOM.001=U:\"B\"\r\n#SYSCOM.002=U:\"C\"\r\n");
        let listed = gx.list_namespace("SYSCOM");
        assert_eq!(listed, vec!["SYSCOM.000", "SYSCOM.001", "SYSCOM.002"]);
    }

    #[test]
    fn shift_jis_replacement_raises_typed_error() {
        // 0xFD is not a valid Shift-JIS lead byte; `encoding_rs` will
        // substitute U+FFFD. The parser must surface that as
        // `ShiftJisDecode` rather than silently dropping the byte.
        let bytes: &[u8] = &[b'#', b'K', b'=', 0xFD, b'\r', b'\n'];
        let err = Gameexe::parse(bytes).expect_err("invalid Shift-JIS must raise");
        match err {
            GameexeParseError::ShiftJisDecode {
                code, line_number, ..
            } => {
                assert_eq!(code, GAMEEXE_SHIFT_JIS_DECODE_FAILURE_CODE);
                assert_eq!(line_number, 1);
            }
            other => panic!("expected ShiftJisDecode, got {other:?}"),
        }
    }

    #[test]
    fn malformed_key_raises_typed_error() {
        let bytes = b"#=novalue\r\n";
        let err = Gameexe::parse(bytes).expect_err("empty key must raise");
        assert!(matches!(err, GameexeParseError::MalformedKey { .. }));
    }

    #[test]
    fn malformed_dotted_key_raises_typed_error() {
        let bytes = b"#.X=1\r\n";
        let err = Gameexe::parse(bytes).expect_err("leading-dot key must raise");
        assert!(matches!(err, GameexeParseError::MalformedKey { .. }));
    }

    #[test]
    fn comment_and_blank_lines_skip_silently() {
        let gx = parse_str("\r\n; comment\r\n   \r\n#OK=1\r\n");
        assert_eq!(gx.len(), 1);
        assert_eq!(gx.get_int("OK"), Some(1));
    }

    #[test]
    fn parse_into_arc_yields_shared_tree() {
        let bytes = encoding_rs::SHIFT_JIS.encode("#A=1\r\n").0.into_owned();
        let arc = parse_into_arc(&bytes).expect("must parse");
        assert_eq!(arc.get_int("A"), Some(1));
    }

    #[test]
    fn case_insensitive_keys_normalise_on_lookup() {
        let gx = parse_str("#caption=\"hi\"\r\n");
        assert_eq!(gx.get_str("CAPTION"), Some("hi"));
        // Lookup with lowercase or leading `#` works too.
        assert_eq!(gx.get_str("caption"), Some("hi"));
        assert_eq!(gx.get_str("#CAPTION"), Some("hi"));
    }

    #[test]
    fn duplicate_key_last_writer_wins() {
        // The flat map keeps one entry per dotted path; a later line
        // overwrites an earlier one but does not change source order.
        let gx = parse_str("#K=1\r\n#K=2\r\n");
        assert_eq!(gx.get_int("K"), Some(2));
        assert_eq!(gx.list_namespace("K"), vec!["K"]);
    }
}
