use super::*;

fn bridge_namespace(source_file: &str) -> String {
    format!("kirikiri-kag-bridge:source-file={source_file}")
}

struct Parser<'a> {
    source_file: &'a str,
    namespace: String,
    bytes: &'a [u8],
    enc: KsEncoding,
    current_speaker: Option<String>,
    /// While `true`, physical lines are the body of an open
    /// `[iscript]…[endscript]` TJS block and are swallowed (no unit emitted)
    /// until the closing `[endscript]` / `@endscript` line.
    open_iscript: bool,
    units: Vec<KsUnit>,
    findings: Vec<KsFinding>,
}

impl Parser<'_> {
    fn push_unit(
        &mut self,
        line_index: usize,
        segment_index: usize,
        role: TextRole,
        start: usize,
        end: usize,
    ) {
        let source_text = decode_slice(&self.bytes[start..end], self.enc);
        let source_unit_key = format!(
            "kirikiri-kag:{}#L{line_index}#seg{segment_index}#{}",
            self.source_file,
            role.as_str()
        );
        let bridge_unit_id =
            deterministic_uuid7(&self.namespace, &format!("unit-{source_unit_key}"));
        let speaker = match role {
            TextRole::Dialogue => self.current_speaker.clone(),
            TextRole::SpeakerName => None,
        };
        self.units.push(KsUnit {
            bridge_unit_id,
            source_file: self.source_file.to_string(),
            line_index,
            segment_index,
            role,
            start_byte: start,
            end_byte: end,
            source_text,
            speaker,
            source_unit_key,
        });
    }

    /// Parse one physical line whose content bytes are `[ls, le)` (trailing
    /// `\r`/`\n` already excluded).
    fn parse_line(&mut self, ls: usize, le: usize, line_index: usize) {
        // 1. Inside an open `[iscript]` block: swallow every physical line
        // (including blanks) as TJS body — never emit a unit — until the
        // closing `[endscript]` / `@endscript` line, which is swallowed too.
        if self.open_iscript {
            if self.line_closes_iscript(ls, le) {
                self.open_iscript = false;
            }
            return;
        }

        if ls >= le {
            return; // empty line
        }

        // 2. A line that OPENS an `[iscript]` / `@iscript` TJS block. Recorded
        // as a finding; body lines are swallowed by branch 1 above. A
        // single-line `[iscript]…[endscript]` closes on the same line and
        // never opens the swallow state.
        if let Some(closes_same_line) = self.line_opens_iscript(ls, le) {
            self.findings.push(KsFinding {
                kind: KsFindingKind::IScriptBlock,
                line_index,
                detail: "iscript".to_string(),
            });
            if !closes_same_line {
                self.open_iscript = true;
            }
            return;
        }

        match self.enc.ascii_byte(self.bytes, ls) {
            // comment (`;`) and label (`*`) lines are pure structure.
            Some(b';' | b'*') => {}
            Some(b'@') => {
                let name_start = ls + self.enc.char_len(self.bytes, ls);
                let name = self.command_name(name_start, le);
                self.findings.push(KsFinding {
                    kind: KsFindingKind::LineCommand,
                    line_index,
                    detail: name,
                });
            }
            Some(b'#') => self.parse_name_line(ls, le, line_index),
            _ => self.parse_text_line(ls, le, line_index),
        }
    }

    /// Index of the first non-ASCII-whitespace byte in `[ls, le)` (encoding
    /// safe: a multi-byte char is stepped whole, so its trailing byte is never
    /// read as a whitespace control byte).
    fn first_content(&self, ls: usize, le: usize) -> usize {
        let mut i = ls;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if self
                .enc
                .ascii_byte(self.bytes, i)
                .is_some_and(|byte| byte.is_ascii_whitespace())
            {
                i += cl;
            } else {
                break;
            }
        }
        i
    }

    /// Name of the leading inline `[name …]` tag (after any leading ASCII
    /// whitespace), or `None` when the line does not begin with a real tag
    /// (`[[` is the literal-bracket escape, not a tag). The name is the first
    /// whitespace-delimited token inside the brackets.
    fn leading_tag_name(&self, ls: usize, le: usize) -> Option<String> {
        let start = self.first_content(ls, le);
        if start >= le || self.enc.ascii_byte(self.bytes, start) != Some(b'[') {
            return None;
        }
        // `[[` literal-bracket escape → this is text, not a tag.
        let next = start + self.enc.char_len(self.bytes, start);
        if self.enc.ascii_byte(self.bytes, next) == Some(b'[') {
            return None;
        }
        let inner_start = next;
        let close = self.find_close_bracket(inner_start, le)?;
        let name = self.command_name(inner_start, close);
        if name.is_empty() { None } else { Some(name) }
    }

    /// Name of the leading `@name …` line command (after any leading ASCII
    /// whitespace), or `None` when the line does not begin with `@`.
    fn leading_command_name(&self, ls: usize, le: usize) -> Option<String> {
        let start = self.first_content(ls, le);
        if start >= le || self.enc.ascii_byte(self.bytes, start) != Some(b'@') {
            return None;
        }
        let name_start = start + self.enc.char_len(self.bytes, start);
        let name = self.command_name(name_start, le);
        if name.is_empty() { None } else { Some(name) }
    }

    /// Byte index of the closing `]` for a tag whose inner text starts at
    /// `start`, scanning encoding-safely within `[start, le)`.
    fn find_close_bracket(&self, start: usize, le: usize) -> Option<usize> {
        let mut j = start;
        while j < le {
            let cl = self.enc.char_len(self.bytes, j);
            if self.enc.ascii_byte(self.bytes, j) == Some(b']') {
                return Some(j);
            }
            j += cl;
        }
        None
    }

    /// Whether any inline `[tag …]` in `[ls, le)` names `want` (used to detect
    /// an `[endscript]` close, which may trail body text on the same physical
    /// line). Respects the `[[` literal-bracket escape and steps multi-byte
    /// characters whole.
    fn contains_tag(&self, ls: usize, le: usize, want: &[u8]) -> bool {
        let mut i = ls;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if self.enc.ascii_byte(self.bytes, i) == Some(b'[') {
                let next = i + cl;
                if self.enc.ascii_byte(self.bytes, next) == Some(b'[') {
                    i = next + self.enc.char_len(self.bytes, next); // `[[` escape
                    continue;
                }
                match self.find_close_bracket(i + cl, le) {
                    Some(close) => {
                        if self.command_name(i + cl, close).as_bytes() == want {
                            return true;
                        }
                        i = close + self.enc.char_len(self.bytes, close);
                    }
                    None => break,
                }
                continue;
            }
            i += cl;
        }
        false
    }

    /// If the line opens an `[iscript]` / `@iscript` TJS block, return
    /// `Some(closes_same_line)`: `true` for a single-line
    /// `[iscript]…[endscript]` (which never opens the swallow state), `false`
    /// for a multi-line block. Returns `None` when the line opens no block.
    fn line_opens_iscript(&self, ls: usize, le: usize) -> Option<bool> {
        let opens = self.leading_tag_name(ls, le).as_deref() == Some("iscript")
            || self.leading_command_name(ls, le).as_deref() == Some("iscript");
        if !opens {
            return None;
        }
        // Only the bracket form can close on the same physical line; the
        // `@iscript` line-command form is closed by a later `@endscript` line.
        Some(self.contains_tag(ls, le, b"endscript"))
    }

    /// Whether a line inside an open block closes it — an `[endscript]` inline
    /// tag anywhere on the line, or a leading `@endscript` line command.
    fn line_closes_iscript(&self, ls: usize, le: usize) -> bool {
        self.contains_tag(ls, le, b"endscript")
            || self.leading_command_name(ls, le).as_deref() == Some("endscript")
    }

    /// `@commandname …` → the command name (ASCII up to whitespace or EOL).
    fn command_name(&self, start: usize, le: usize) -> String {
        let mut i = start;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if self
                .enc
                .ascii_byte(self.bytes, i)
                .is_some_and(|byte| byte.is_ascii_whitespace())
            {
                break;
            }
            i += cl;
        }
        decode_slice(&self.bytes[start..i], self.enc)
    }

    /// `#display` / `#voice/display` / bare `#`.
    fn parse_name_line(&mut self, ls: usize, le: usize, line_index: usize) {
        let name_start = ls + self.enc.char_len(self.bytes, ls);
        if name_start >= le {
            // bare `#` → clear speaker
            self.current_speaker = None;
            return;
        }
        // Find an ASCII '/' separating voice id from display name.
        let mut slash: Option<usize> = None;
        let mut i = name_start;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if self.enc.ascii_byte(self.bytes, i) == Some(b'/') {
                slash = Some(i);
                break;
            }
            i += cl;
        }
        let display_start = slash.map_or(name_start, |s| s + self.enc.char_len(self.bytes, s));
        if display_start >= le {
            // `#voice/` with empty display → clear speaker, no unit.
            self.current_speaker = None;
            return;
        }
        let display_text = decode_slice(&self.bytes[display_start..le], self.enc);
        self.current_speaker = Some(display_text);
        self.push_unit(line_index, 0, TextRole::SpeakerName, display_start, le);
    }

    fn parse_text_line(&mut self, ls: usize, le: usize, line_index: usize) {
        let mut segment_index = 0usize;
        let mut run_start = ls;
        let mut i = ls;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if self.enc.ascii_byte(self.bytes, i) == Some(b'[') {
                // `[[` — KAG literal-bracket escape; stays inside the run.
                let next = i + cl;
                if self.enc.ascii_byte(self.bytes, next) == Some(b'[') {
                    i = next + self.enc.char_len(self.bytes, next);
                    continue;
                }
                self.emit_run(line_index, &mut segment_index, run_start, i);
                // Scan to the closing `]`.
                let mut j = i + cl;
                let mut closed = false;
                while j < le {
                    let cl2 = self.enc.char_len(self.bytes, j);
                    if self.enc.ascii_byte(self.bytes, j) == Some(b']') {
                        j += cl2;
                        closed = true;
                        break;
                    }
                    j += cl2;
                }
                if !closed {
                    self.findings.push(KsFinding {
                        kind: KsFindingKind::UnclosedInlineTag,
                        line_index,
                        detail: self.command_name(i + cl, le),
                    });
                    j = le;
                }
                run_start = j;
                i = j;
                continue;
            }
            i += cl;
        }
        self.emit_run(line_index, &mut segment_index, run_start, le);
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
        self.push_unit(line_index, seg, TextRole::Dialogue, start, end);
        *segment_index += 1;
    }
}

/// Parse `bytes` as a KAG `.ks` script, auto-detecting the encoding.
#[must_use]
pub fn parse_ks(source_file: &str, bytes: &[u8]) -> KsDocument {
    parse_ks_with_encoding(source_file, bytes, KsEncoding::detect(bytes))
}

/// Parse `bytes` as a KAG `.ks` script under an explicit `enc`.
#[must_use]
pub fn parse_ks_with_encoding(source_file: &str, bytes: &[u8], enc: KsEncoding) -> KsDocument {
    let mut parser = Parser {
        source_file,
        namespace: bridge_namespace(source_file),
        bytes,
        enc,
        current_speaker: None,
        open_iscript: false,
        units: Vec::new(),
        findings: Vec::new(),
    };

    let mut ls = enc.bom_len(bytes);
    let mut line_index = 0usize;
    while ls < bytes.len() {
        // Locate the physical line terminator.
        let mut i = ls;
        let mut content_end = bytes.len();
        let mut next = bytes.len();
        while i < bytes.len() {
            let cl = enc.char_len(bytes, i);
            if enc.ascii_byte(bytes, i) == Some(b'\n') {
                let mut ce = i;
                if enc.previous_ascii_byte(bytes, ce) == Some(b'\r') {
                    ce = enc.previous_char_start(ce).expect("CR precedes LF");
                }
                content_end = ce;
                next = i + cl;
                break;
            }
            i += cl;
        }
        if i >= bytes.len() {
            // Final line with no trailing newline.
            content_end = bytes.len();
            if enc.previous_ascii_byte(bytes, content_end) == Some(b'\r') {
                content_end = enc
                    .previous_char_start(content_end)
                    .expect("final CR has a start offset");
            }
            next = bytes.len();
        }
        parser.parse_line(ls, content_end, line_index);
        ls = next;
        line_index += 1;
    }

    KsDocument {
        source_file: source_file.to_string(),
        encoding: enc,
        source_len: bytes.len(),
        units: parser.units,
        findings: parser.findings,
    }
}
