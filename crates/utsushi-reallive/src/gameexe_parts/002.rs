impl Gameexe {
    /// Parse a `Gameexe.ini` byte slice.
    ///
    /// Decodes Shift-JIS via `encoding_rs`. Surfaces typed
    /// [`GameexeParseError`] on Shift-JIS substitution or structural
    /// failure. A failed numeric token preserves its scalar value and
    /// records a [`GameexeParseWarning`] in [`Gameexe::warnings`].
    pub fn parse(bytes: &[u8]) -> Result<Self, GameexeParseError> {
        let mut entries: HashMap<String, GameexeValue> = HashMap::new();
        let mut order: Vec<String> = Vec::new();
        let mut warnings: Vec<GameexeParseWarning> = Vec::new();
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
                let value = parse_scalar_value(&upper_key, value_text, &mut warnings);
                (upper_key, value)
            };

            if !entries.contains_key(&final_key) {
                order.push(final_key.clone());
            }
            entries.insert(final_key, value);
        }
        Ok(Self {
            entries,
            order,
            warnings,
        })
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

    /// Recoverable numeric-token diagnostics collected while parsing.
    ///
    /// A warning records the key and raw malformed token while preserving
    /// the existing `None` behavior from typed numeric accessors.
    pub fn warnings(&self) -> &[GameexeParseWarning] {
        &self.warnings
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
    /// negative index.
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
    /// `#SCREENSIZE_MOD`. The message-window `POS` / `MOJI_POS`
    /// `NAME_POS` coordinates are authored in THIS space.
    ///
    /// - `#SCREENSIZE_MOD=0` → classic `640x480` (Kanon and other
    ///   1.2.6.x titles).
    /// - `#SCREENSIZE_MOD=1` → `800x600`.
    /// - `#SCREENSIZE_MOD=999,w,h` → the explicit `w x h` (observed:
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
    /// Gameexe value read from disk — the dialogue box position, colour
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
    /// (Kanon `#DEFAULT_SEL_WINDOW=000`, observed `=031`). RealLive uses
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
    /// font-size / insets are the real Gameexe values, never hardcoded.
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


