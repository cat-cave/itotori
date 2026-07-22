use super::*;

impl Parser<'_> {
    pub(super) fn parse_text_line(&mut self, ls: usize, le: usize, line_index: usize) {
        let mut segment_index = 0usize;
        let mut run_start = ls;
        let mut i = ls;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if cl == 1 && self.bytes[i] == b'[' {
                // `[[` — literal-bracket escape; stays inside the run.
                if i + 1 < le && self.bytes[i + 1] == b'[' {
                    i += 2;
                    continue;
                }
                self.emit_run(line_index, &mut segment_index, run_start, i);
                let scan = self.scan_tag(i, le);
                if !scan.closed {
                    self.findings.push(TsFinding {
                        kind: TsFindingKind::UnclosedInlineTag,
                        line_index,
                        detail: self.token_name(scan.name_start, le),
                    });
                    run_start = le;
                    i = le;
                    continue;
                }
                self.apply_tag(line_index, &mut segment_index, &scan);
                run_start = scan.end;
                i = scan.end;
                continue;
            }
            if cl == 1 && self.bytes[i] == b'&' && is_embed_char(self.bytes.get(i + 1).copied()) {
                // Inline variable embed (`&f.x`) — structure. It delimits the
                // surrounding runs and is preserved byte-identical. The embed
                // consumes the `&` plus a JS member-path token
                // (`[A-Za-z0-9_.$]+`), so it terminates cleanly at following
                // message text, a tag, or whitespace.
                self.emit_run(line_index, &mut segment_index, run_start, i);
                let mut j = i + 1;
                while j < le {
                    let cl2 = self.enc.char_len(self.bytes, j);
                    if cl2 == 1 && is_embed_char(Some(self.bytes[j])) {
                        j += cl2;
                    } else {
                        break;
                    }
                }
                run_start = j;
                i = j;
                continue;
            }
            i += cl;
        }
        self.emit_run(line_index, &mut segment_index, run_start, le);
    }

    /// Handle a scanned inline tag: extract any translatable `text="…"`
    /// attribute and update `[link]…[endlink]` choice context. The tag bytes
    /// themselves are always structure.
    fn apply_tag(&mut self, line_index: usize, segment_index: &mut usize, scan: &TagScan) {
        let name = decode_slice(&self.bytes[scan.name_start..scan.name_end], self.enc);
        if let Some(role) = text_attr_role(&name)
            && let Some((vs, ve)) = self.find_attr_value(scan.body_start, scan.body_end, b"text")
        {
            let seg = *segment_index;
            if role == TextRole::SpeakerName {
                self.current_speaker = Some(decode_slice(&self.bytes[vs..ve], self.enc));
            }
            self.push_unit(line_index, seg, role, vs, ve);
            *segment_index += 1;
        }
        match name.as_str() {
            "link" => self.in_link = true,
            "endlink" => self.in_link = false,
            _ => {}
        }
    }

    /// Quote-aware scan of an inline tag beginning at `open` (the `[`).
    fn scan_tag(&self, open: usize, le: usize) -> TagScan {
        let name_start = open + 1;
        let mut i = name_start;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if cl != 1 {
                break;
            }
            let b = self.bytes[i];
            if b.is_ascii_alphanumeric() || b == b'_' {
                i += 1;
            } else {
                break;
            }
        }
        let name_end = i;
        let body_start = i;
        // Scan to the closing `]`, skipping over quoted attribute values so a
        // `]` inside `text="a]b"` does not prematurely end the tag.
        let mut quote: Option<u8> = None;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if cl == 1 {
                let b = self.bytes[i];
                match quote {
                    Some(q) => {
                        if b == q {
                            quote = None;
                        }
                    }
                    None => {
                        if b == b'"' || b == b'\'' {
                            quote = Some(b);
                        } else if b == b']' {
                            return TagScan {
                                end: i + 1,
                                closed: true,
                                name_start,
                                name_end,
                                body_start,
                                body_end: i,
                            };
                        }
                    }
                }
            }
            i += cl;
        }
        TagScan {
            end: le,
            closed: false,
            name_start,
            name_end,
            body_start,
            body_end: le,
        }
    }

    /// Find the value span of a **quoted** attribute `attr` inside the tag body
    /// `[start, end)`. Returns the inner value span (excluding the quotes), or
    /// `None` when the attribute is absent, unquoted, or unterminated.
    /// Unquoted values are deliberately NOT extracted: replacing an unquoted
    /// value with translated text containing whitespace would corrupt the tag.
    fn find_attr_value(&self, start: usize, end: usize, attr: &[u8]) -> Option<(usize, usize)> {
        let mut i = start;
        while i < end {
            let cl = self.enc.char_len(self.bytes, i);
            let prev_is_sep = i == start || self.bytes[i - 1].is_ascii_whitespace();
            if cl == 1
                && prev_is_sep
                && (self.bytes[i].is_ascii_alphabetic() || self.bytes[i] == b'_')
            {
                let id_start = i;
                let mut j = i;
                while j < end {
                    let b = self.bytes[j];
                    if b.is_ascii_alphanumeric() || b == b'_' {
                        j += 1;
                    } else {
                        break;
                    }
                }
                let mut k = j;
                while k < end && self.bytes[k].is_ascii_whitespace() {
                    k += 1;
                }
                if &self.bytes[id_start..j] == attr && k < end && self.bytes[k] == b'=' {
                    k += 1;
                    while k < end && self.bytes[k].is_ascii_whitespace() {
                        k += 1;
                    }
                    if k < end && (self.bytes[k] == b'"' || self.bytes[k] == b'\'') {
                        let q = self.bytes[k];
                        let value_start = k + 1;
                        let mut v = value_start;
                        while v < end {
                            let cl2 = self.enc.char_len(self.bytes, v);
                            if cl2 == 1 && self.bytes[v] == q {
                                return Some((value_start, v));
                            }
                            v += cl2;
                        }
                    }
                    return None; // unquoted or unterminated → not extracted
                }
                i = j;
                continue;
            }
            i += cl;
        }
        None
    }

    fn emit_run(&mut self, line_index: usize, segment_index: &mut usize, start: usize, end: usize) {
        if end <= start {
            return;
        }
        // Skip whitespace-only runs: they carry no translatable text and are
        // preserved verbatim as structure.
        let decoded = decode_slice(&self.bytes[start..end], self.enc);
        if decoded.trim().is_empty() {
            return;
        }
        let seg = *segment_index;
        let role = if self.in_link {
            TextRole::Choice
        } else {
            TextRole::Dialogue
        };
        self.push_unit(line_index, seg, role, start, end);
        *segment_index += 1;
    }
}

/// Whether `b` is a valid character inside a TyranoScript `&`-embed member
/// path (`[A-Za-z0-9_.$]`). `None` (end-of-line) is not.
fn is_embed_char(b: Option<u8>) -> bool {
    matches!(b, Some(c) if c.is_ascii_alphanumeric() || c == b'_' || c == b'.' || c == b'$')
}

/// The role a tag's quoted `text="…"` attribute carries, if the tag is one of
/// the recognised text-bearing tags. `glink` / `button` captions are choices;
/// `chara_ptext` is a speaker display name; a `link` tag may carry a `text`
/// caption too (in addition to opening a choice context).
fn text_attr_role(name: &str) -> Option<TextRole> {
    match name {
        "glink" | "button" | "link" => Some(TextRole::Choice),
        "chara_ptext" => Some(TextRole::SpeakerName),
        _ => None,
    }
}
