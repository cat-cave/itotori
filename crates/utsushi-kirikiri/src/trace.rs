//! **KAG command-trace probe** for plaintext / already-extracted
//! KiriKiri/KAG `.ks` scripts.
//!
//! Where [`crate::replay`] walks the script like a tiny jump-FOLLOWING VM
//! (), this probe produces a **linear, command-indexed trace** in
//! source (trace) order for review: one row per significant command, each
//! carrying the columns a reviewer needs to correlate the runtime stream to
//! the extraction bridge —
//!
//! - **command index** (dense position in trace order) + source **line index**
//! - the active **label** scope (and, on a `*label` row, the label entered)
//! - a **macro id** (a `[macro name=x]` definition or a later `[x …]`
//!   invocation of a defined macro)
//! - a **jump target** (`[jump]` / `@jump` / `[call]`)
//! - a **branch id** (a `[link …]…[endlink]` choice option, or a `[select …]`
//!   option) plus the option target
//! - the active **speaker** (`#name` state), and
//! - the observed **text** (a message run, or a choice option's visible text).
//!
//! # Bridge-unit linkage (mirrors )
//!
//! Every **speaker**, **message**, and **branch-option** row carries a
//! [`BridgeRef`] identifying the extraction unit for that exact
//! source text. The `(bridge_unit_id, source_unit_key)` pair is re-derived
//! (per this crate's dev-dep-oracle isolation posture) with the SAME scheme
//! `kaifuu_kirikiri` stamps on its extraction units, and the
//! `command_trace_bridge` oracle test proves the ids are byte-identical to
//! `kaifuu_kirikiri::parse_ks`'s own output — so the link is provably the real
//! extraction identity, not a parallel one.
//!
//! # Honest scope (READ THIS)
//!
//! This is a **plaintext / already-extracted** probe ONLY. It reads a `.ks`
//! file that is already plaintext on disk (an author tree, a fan-distributed
//! script, or the extracted members of an *unencrypted* XP3). It does **not**
//! open, decrypt, or unpack an XP3 archive — commercial KiriKiri titles ship
//! their scripts inside *encrypted* XP3 containers, and reaching those is a
//! SEPARATE capability that is entirely out of scope here (this is continuous
//! expansion AFTER XP3 readiness, consuming its plaintext output). Like the
//! replay skeleton, the probe follows the structural KAG flow and records a
//! bounded, enumerated set of surfaces; it is not a full TJS runtime.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::encoding::KagEncoding;
use crate::ids::{BridgeRole, bridge_ids};
use crate::parse::{Command, parse_command};
use crate::replay::{KagTraceError, to_sorted_value};

/// Stable schema label for [`KagCommandTrace`].
pub const KAG_COMMAND_TRACE_SCHEMA_VERSION: &str = "utsushi-kirikiri-kag-command-trace/0.1.0";

/// One-line honest-scope statement embedded in every trace artifact so the
/// plaintext-only boundary travels with the data, not just the docs.
pub const KAG_COMMAND_TRACE_SCOPE: &str = "plaintext / already-extracted KAG `.ks` ONLY: reads a \
     script already plaintext on disk (author tree, fan-distributed script, or \
     extracted members of an UNENCRYPTED XP3). Does NOT open, decrypt, or unpack \
     an XP3 container — commercial encrypted-XP3 titles are a separate capability \
     and out of scope. Structural flow probe, not a full TJS runtime.";

/// A link back to the extraction bridge unit for a row's source
/// text (mirrors `utsushi_core::ObservationBridgeRef`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRef {
    /// Deterministic UUID7-shaped id — byte-identical to the.
    pub bridge_unit_id: String,
    /// Stable human-readable key: `kirikiri-kag:<file>#L<line>#seg<seg>#<role>`.
    pub source_unit_key: String,
}

/// What a trace row records. One variant per significant KAG surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowKind {
    /// A `*label` line (a jump target / section boundary).
    Label,
    /// A `#name` speaker line (sets or clears the active speaker).
    Speaker,
    /// A run of on-screen message text.
    Message,
    /// A `[jump]` / `@jump` / `[call]` control transfer.
    Jump,
    /// A choice-menu option (`[link …]…[endlink]` or `[select …]`).
    Branch,
    /// A `[macro name=x]` definition or a `[x …]` invocation of a defined macro.
    Macro,
}

/// One command in the linear trace. Optional columns are omitted when absent so
/// the JSON stays compact and deterministic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KagTraceRow {
    /// Dense position of this row in trace order (0-based).
    pub command_index: usize,
    /// Zero-based source physical line the command sits on.
    pub line_index: usize,
    /// Which surface this row records.
    pub kind: RowKind,
    /// Active `*label` scope at this command (the label entered, on a Label
    /// row). `None` before the first label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Active speaker (on a Message/Branch row) or the new speaker (on a
    /// Speaker row; `None` marks a bare-`#` reset).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    /// Observed text: a message run, or a choice option's visible text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Macro name (on a Macro row).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub macro_id: Option<String>,
    /// Whether a Macro row is a `definition` or an `invocation`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub macro_role: Option<MacroRole>,
    /// Destination `*label` (on a Jump or Branch row; `*` stripped).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_target: Option<String>,
    /// Stable branch id `branch<menu>.<option>` (on a Branch row).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<String>,
    /// Link back to the extraction bridge unit for this row's source text
    /// (speaker / message / branch-option rows carry it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_ref: Option<BridgeRef>,
}

/// Whether a [`RowKind::Macro`] row is a definition or an invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MacroRole {
    /// A `[macro name=x]…[endmacro]` definition.
    Definition,
    /// A `[x …]` / `@x …` invocation of a previously-defined macro.
    Invocation,
}

/// The deterministic command trace the probe produces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KagCommandTrace {
    /// Equals [`KAG_COMMAND_TRACE_SCHEMA_VERSION`].
    pub schema_version: String,
    /// Honest scope boundary — equals [`KAG_COMMAND_TRACE_SCOPE`].
    pub scope: String,
    /// Source file the probe was driven against.
    pub source_file: String,
    /// Detected encoding label (`utf8` / `shift_jis`).
    pub encoding: String,
    /// Rows in trace (source) order.
    pub rows: Vec<KagTraceRow>,
    /// `rows.len()`, surfaced for a quick review count.
    pub row_count: usize,
}

impl KagCommandTrace {
    /// Byte-deterministic JSON: sorted keys at every level, no floats. Two
    /// probes of the same script produce identical output. Mirrors
    /// [`crate::KagTrace::to_deterministic_json`].
    ///
    /// # Errors
    /// Returns [`KagTraceError::Serialize`] if serialisation fails (never
    /// expected for this in-memory, float-free value).
    pub fn to_deterministic_json(&self) -> Result<String, KagTraceError> {
        let value = to_sorted_value(self)?;
        let mut out = Vec::with_capacity(2048);
        let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
        let mut ser = serde_json::Serializer::with_formatter(&mut out, formatter);
        value
            .serialize(&mut ser)
            .map_err(|e| KagTraceError::Serialize(e.to_string()))?;
        String::from_utf8(out).map_err(|e| KagTraceError::Serialize(e.to_string()))
    }

    /// Rows of a given [`RowKind`], borrowed in order.
    pub fn rows_of(&self, kind: RowKind) -> impl Iterator<Item = &KagTraceRow> {
        self.rows.iter().filter(move |r| r.kind == kind)
    }
}

/// Trace a plaintext KAG `.ks` script's bytes, auto-detecting the encoding.
/// `source_file` is used verbatim in bridge-unit keys, so pass the same name
/// the extraction adapter would (typically the file's base name).
#[must_use]
pub fn trace_kag_commands(source_file: &str, bytes: &[u8]) -> KagCommandTrace {
    let encoding = KagEncoding::detect(bytes);
    trace_kag_commands_with_encoding(source_file, bytes, encoding)
}

/// Trace under an explicit `encoding`.
#[must_use]
pub fn trace_kag_commands_with_encoding(
    source_file: &str,
    bytes: &[u8],
    encoding: KagEncoding,
) -> KagCommandTrace {
    let text = encoding.decode(bytes);
    let mut tracer = Tracer {
        source_file,
        rows: Vec::new(),
        current_label: None,
        current_speaker: None,
        defined_macros: BTreeSet::new(),
        open_macro: None,
        open_iscript: false,
    };
    for (line_index, raw_line) in text.split('\n').enumerate() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        tracer.trace_line(line, line_index);
    }
    let row_count = tracer.rows.len();
    KagCommandTrace {
        schema_version: KAG_COMMAND_TRACE_SCHEMA_VERSION.to_string(),
        scope: KAG_COMMAND_TRACE_SCOPE.to_string(),
        source_file: source_file.to_string(),
        encoding: encoding.as_str().to_string(),
        rows: tracer.rows,
        row_count,
    }
}

struct Tracer<'a> {
    source_file: &'a str,
    rows: Vec<KagTraceRow>,
    current_label: Option<String>,
    current_speaker: Option<String>,
    /// Names of macros defined so far (a later invocation is recognised only
    /// after its definition, matching a linear KAG load).
    defined_macros: BTreeSet<String>,
    /// While `Some(name)`, physical lines are a macro definition body (skipped
    /// until `[endmacro]`).
    open_macro: Option<String>,
    /// While `true`, physical lines are a swallowed `[iscript]` TJS body.
    open_iscript: bool,
}

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

    fn trace_line(&mut self, line: &str, line_index: usize) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_states_plaintext_only_boundary() {
        assert!(KAG_COMMAND_TRACE_SCOPE.contains("plaintext"));
        assert!(KAG_COMMAND_TRACE_SCOPE.contains("out of scope"));
        assert!(KAG_COMMAND_TRACE_SCOPE.to_lowercase().contains("xp3"));
    }

    #[test]
    fn empty_script_traces_no_rows() {
        let trace = trace_kag_commands("empty.ks", b"");
        assert_eq!(trace.row_count, 0);
        assert!(trace.rows.is_empty());
    }

    #[test]
    fn command_index_is_dense_and_ordered() {
        let src = "*a\n#Bob\nHello.\n@jump target=*a\n";
        let trace = trace_kag_commands("x.ks", src.as_bytes());
        for (i, row) in trace.rows.iter().enumerate() {
            assert_eq!(row.command_index, i);
        }
        let kinds: Vec<RowKind> = trace.rows.iter().map(|r| r.kind).collect();
        assert_eq!(
            kinds,
            vec![
                RowKind::Label,
                RowKind::Speaker,
                RowKind::Message,
                RowKind::Jump
            ]
        );
        // The active label scope rides on every row.
        assert!(trace.rows.iter().all(|r| r.label.as_deref() == Some("a")));
    }

    #[test]
    fn select_branch_records_id_and_target_without_bridge_ref() {
        // `[select]` option text lives in a tag attribute, not an extraction
        // unit, so the branch row has an id + target but no bridge ref.
        let src = "*menu\n[select text=\"Go north\" target=*north]\n";
        let trace = trace_kag_commands("x.ks", src.as_bytes());
        let branch = trace
            .rows_of(RowKind::Branch)
            .next()
            .expect("a select branch row");
        assert_eq!(branch.branch_id.as_deref(), Some("branch0.0"));
        assert_eq!(branch.jump_target.as_deref(), Some("north"));
        assert_eq!(branch.text.as_deref(), Some("Go north"));
        assert!(branch.bridge_ref.is_none());
    }

    #[test]
    fn macro_definition_and_invocation_are_recorded() {
        let src = "[macro name=greet]Hi %who.[endmacro]\n[greet who=you]\n";
        let trace = trace_kag_commands("x.ks", src.as_bytes());
        let macros: Vec<(Option<&str>, Option<MacroRole>)> = trace
            .rows_of(RowKind::Macro)
            .map(|r| (r.macro_id.as_deref(), r.macro_role))
            .collect();
        assert_eq!(
            macros,
            vec![
                (Some("greet"), Some(MacroRole::Definition)),
                (Some("greet"), Some(MacroRole::Invocation)),
            ]
        );
        // The macro body line is template, never a message row.
        assert_eq!(trace.rows_of(RowKind::Message).count(), 0);
    }

    #[test]
    fn same_script_yields_identical_json() {
        let src = "*s\n#Al\nHi.\n[link target=*t]Go[endlink]\n*t\nEnd.\n";
        let a = trace_kag_commands("x.ks", src.as_bytes())
            .to_deterministic_json()
            .expect("json a");
        let b = trace_kag_commands("x.ks", src.as_bytes())
            .to_deterministic_json()
            .expect("json b");
        assert_eq!(a, b);
    }
}
