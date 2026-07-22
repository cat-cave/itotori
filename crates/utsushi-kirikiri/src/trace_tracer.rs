use super::*;

use crate::ids::{BridgeRole, bridge_ids};
use crate::parse::{Command, parse_command};

/// A token of a message/text line: a non-whitespace text run, or an inline
/// `[tag …]` command, in source order.
enum LineToken {
    Run(String),
    Cmd(Command),
}

impl Tracer<'_> {
    fn push(&mut self, mut row: KagTraceRow) {
        row.command_index = self.rows.len();
        self.rows.push(row);
    }

    /// A blank row template stamped with the active label scope.
    fn blank(&self, line_index: usize, kind: RowKind) -> KagTraceRow {
        KagTraceRow {
            command_index: 0, // filled by `push`
            line_index,
            kind,
            label: self.current_label.clone(),
            speaker: None,
            text: None,
            macro_id: None,
            macro_role: None,
            jump_target: None,
            branch_id: None,
            bridge_ref: None,
        }
    }

    pub(super) fn trace_line(&mut self, line: &str, line_index: usize) {
        // 1. Capturing a macro definition body (its lines are template, not
        //    traced) until `[endmacro]`.
        if let Some(name) = self.open_macro.clone() {
            if line_contains_tag(line, "endmacro") {
                self.open_macro = None;
                self.defined_macros.insert(name);
            }
            return;
        }
        // 2. Swallowing an `[iscript]` block body until `[endscript]`.
        if self.open_iscript {
            if line_contains_tag(line, "endscript") {
                self.open_iscript = false;
            }
            return;
        }
        // 3. A line whose first inline tag opens a `[macro]` definition.
        if let Some(cmd) = leading_command(line)
            && cmd.name == "macro"
        {
            let name = cmd.attr("name").unwrap_or("").to_string();
            let mut row = self.blank(line_index, RowKind::Macro);
            row.macro_id = Some(name.clone());
            row.macro_role = Some(MacroRole::Definition);
            self.push(row);
            if line_contains_tag(line, "endmacro") {
                if !name.is_empty() {
                    self.defined_macros.insert(name);
                }
            } else {
                self.open_macro = Some(name);
            }
            return;
        }
        // 4. A line whose first inline tag opens an `[iscript]` block.
        if leading_tag_name(line.trim_start()).as_deref() == Some("iscript") {
            if !line_contains_tag(line, "endscript") {
                self.open_iscript = true;
            }
            return;
        }
        // 5. An ordinary line — classify by column 0.
        let Some(first) = line.chars().next() else {
            return; // empty line
        };
        match first {
            ';' => {} // comment — pure structure.
            '*' => {
                let rest = &line[first.len_utf8()..];
                let name = rest.split('|').next().unwrap_or("").trim().to_string();
                self.current_label = Some(name.clone());
                let mut row = self.blank(line_index, RowKind::Label);
                row.label = Some(name);
                self.push(row);
            }
            '@' => {
                let rest = &line[first.len_utf8()..];
                let cmd = parse_command(rest);
                self.handle_command(&cmd, line_index);
            }
            '#' => self.trace_name_line(line, line_index),
            _ => self.trace_text_line(line, line_index),
        }
    }

    /// `#display` / `#voice/display` / bare `#`.
    fn trace_name_line(&mut self, line: &str, line_index: usize) {
        let after = &line['#'.len_utf8()..];
        let display = if after.is_empty() {
            None
        } else {
            let d = match after.split_once('/') {
                Some((_voice, display)) => display,
                None => after,
            };
            if d.is_empty() {
                None
            } else {
                Some(d.to_string())
            }
        };
        let mut row = self.blank(line_index, RowKind::Speaker);
        row.speaker.clone_from(&display);
        if display.is_some() {
            // A `#name` display is a `speaker_name` extraction unit at seg 0.
            row.bridge_ref = Some(self.bridge_ref(line_index, 0, BridgeRole::SpeakerName));
        }
        self.current_speaker = display;
        self.push(row);
    }

    fn trace_text_line(&mut self, line: &str, line_index: usize) {
        let tokens = split_text_line(line);
        // Per-line dialogue segment counter, shared by message runs AND link
        // option text — matching the `parse_text_line` seg counting.
        let mut dialogue_seg = 0usize;
        // `Some((target, text))` while inside a `[link]…[endlink]` option.
        let mut open_link: Option<(String, String)> = None;
        for token in tokens {
            match token {
                LineToken::Run(run) => {
                    if let Some((_target, text)) = open_link.as_mut() {
                        text.push_str(&run);
                    } else {
                        let mut row = self.blank(line_index, RowKind::Message);
                        row.speaker.clone_from(&self.current_speaker);
                        row.text = Some(run);
                        row.bridge_ref =
                            Some(self.bridge_ref(line_index, dialogue_seg, BridgeRole::Dialogue));
                        dialogue_seg += 1;
                        self.push(row);
                    }
                }
                LineToken::Cmd(cmd) => match cmd.name.as_str() {
                    "link" => {
                        let target = strip_star(cmd.attr("target").unwrap_or("")).to_string();
                        open_link = Some((target, String::new()));
                    }
                    "endlink" => {
                        if let Some((target, text)) = open_link.take() {
                            self.push_branch(line_index, &target, text, Some(dialogue_seg));
                            dialogue_seg += 1;
                        }
                    }
                    // `[select …]` single-tag option: its visible text lives in
                    // the `text=` attribute (tag structure, NOT an extraction
                    // text unit), so it carries a branch id + target but no
                    // bridge ref.
                    "select" if cmd.attr("target").is_some() => {
                        let target = strip_star(cmd.attr("target").unwrap_or("")).to_string();
                        let text = cmd.attr("text").unwrap_or("").to_string();
                        self.push_branch(line_index, &target, text, None);
                    }
                    _ => self.handle_command(&cmd, line_index),
                },
            }
        }
        // An unterminated `[link` with no `[endlink]`: still record the branch
        // (fail-soft, never drop it).
        if let Some((target, text)) = open_link.take() {
            self.push_branch(line_index, &target, text, Some(dialogue_seg));
        }
    }

    /// A `[jump]` / `@jump` / `[call]`, a macro invocation, or an
    /// (unmodelled) presentational tag.
    fn handle_command(&mut self, cmd: &Command, line_index: usize) {
        match cmd.name.as_str() {
            "jump" | "call" => {
                let target = cmd
                    .attr("target")
                    .or_else(|| cmd.attr("storage"))
                    .unwrap_or("");
                let mut row = self.blank(line_index, RowKind::Jump);
                row.jump_target = Some(strip_star(target).to_string());
                self.push(row);
            }
            name if self.defined_macros.contains(name) => {
                let mut row = self.blank(line_index, RowKind::Macro);
                row.macro_id = Some(name.to_string());
                row.macro_role = Some(MacroRole::Invocation);
                self.push(row);
            }
            // Every other recognised tag (presentational / TJS / storage) is
            // deliberately NOT a row in this structural probe — the replay
            // skeleton () is where those are evaluated. Recorded as
            // a no-op here, never crashed.
            _ => {}
        }
    }

    fn push_branch(
        &mut self,
        line_index: usize,
        target: &str,
        text: String,
        dialogue_seg: Option<usize>,
    ) {
        let (menu, option) = self.next_branch_slot();
        let mut row = self.blank(line_index, RowKind::Branch);
        row.branch_id = Some(format!("branch{menu}.{option}"));
        row.jump_target = Some(target.to_string());
        row.speaker.clone_from(&self.current_speaker);
        if !text.is_empty() {
            row.text = Some(text);
            if let Some(seg) = dialogue_seg {
                row.bridge_ref = Some(self.bridge_ref(line_index, seg, BridgeRole::Dialogue));
            }
        }
        self.push(row);
    }

    /// The `(menu_index, option_index)` for the next branch option. A run of
    /// adjacent branch rows (no non-branch row between them) is one menu.
    fn next_branch_slot(&self) -> (usize, usize) {
        // Count how many menus have started, and the option index within the
        // current (possibly open) menu, by scanning existing rows.
        let mut menu = 0usize;
        let mut option = 0usize;
        let mut prev_was_branch = false;
        for row in &self.rows {
            if row.kind == RowKind::Branch {
                if prev_was_branch {
                    option += 1;
                } else {
                    option = 0;
                }
                prev_was_branch = true;
            } else {
                if prev_was_branch {
                    menu += 1;
                }
                prev_was_branch = false;
            }
        }
        if prev_was_branch {
            (menu, option + 1)
        } else {
            (menu, 0)
        }
    }

    fn bridge_ref(&self, line_index: usize, segment_index: usize, role: BridgeRole) -> BridgeRef {
        let (bridge_unit_id, source_unit_key) =
            bridge_ids(self.source_file, line_index, segment_index, role);
        BridgeRef {
            bridge_unit_id,
            source_unit_key,
        }
    }
}

fn strip_star(target: &str) -> &str {
    target.strip_prefix('*').unwrap_or(target)
}

/// Split a message/text line into ordered [`LineToken`]s. `[[` is the KAG
/// literal-`[` escape and stays inside the text run. Whitespace-only runs are
/// dropped (matching ), so every emitted `Run` is translatable text.
fn split_text_line(line: &str) -> Vec<LineToken> {
    let chars: Vec<char> = line.chars().collect();
    let mut tokens: Vec<LineToken> = Vec::new();
    let mut run = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '[' {
            if chars.get(i + 1) == Some(&'[') {
                run.push('['); // `[[` literal-bracket escape
                i += 2;
                continue;
            }
            flush_run(&mut run, &mut tokens);
            let mut j = i + 1;
            let mut inner = String::new();
            let mut closed = false;
            while j < chars.len() {
                if chars[j] == ']' {
                    closed = true;
                    break;
                }
                inner.push(chars[j]);
                j += 1;
            }
            tokens.push(LineToken::Cmd(parse_command(&inner)));
            i = if closed { j + 1 } else { chars.len() };
            continue;
        }
        run.push(chars[i]);
        i += 1;
    }
    flush_run(&mut run, &mut tokens);
    tokens
}

fn flush_run(run: &mut String, tokens: &mut Vec<LineToken>) {
    if run.trim().is_empty() {
        run.clear();
    } else {
        tokens.push(LineToken::Run(std::mem::take(run)));
    }
}

/// Parse the FIRST inline `[tag …]` on `line` (after leading whitespace), else
/// `None`. Used to detect a `[macro]` opener.
fn leading_command(line: &str) -> Option<Command> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix('[')?;
    if rest.starts_with('[') {
        return None; // `[[` escape
    }
    let end = rest.find(']')?;
    Some(parse_command(&rest[..end]))
}

/// The name of the first `[tag …]` if `trimmed` starts with one, else `None`.
fn leading_tag_name(trimmed: &str) -> Option<String> {
    let rest = trimmed.strip_prefix('[')?;
    if rest.starts_with('[') {
        return None;
    }
    let end = rest.find(']')?;
    let inner = rest[..end].trim();
    let name = inner.split_whitespace().next().unwrap_or("");
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Whether any inline `[tag …]` on `line` names `want` (used to detect a
/// block's closing tag, which may trail body text on the same physical line).
fn line_contains_tag(line: &str, want: &str) -> bool {
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        rest = &rest[open..];
        if rest.starts_with("[[") {
            rest = &rest[2..];
            continue;
        }
        let Some(end) = rest.find(']') else { break };
        let inner = rest[1..end].trim();
        let name = inner.split_whitespace().next().unwrap_or("");
        if name == want {
            return true;
        }
        rest = &rest[end + 1..];
    }
    false
}
