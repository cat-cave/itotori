//! KAG plaintext REPLAY engine + typed trace.
//!
//! [`replay_kag`] walks a [`KagScript`] instruction stream like a tiny VM,
//! tracking the active speaker (`#name` state), emitting message text, and
//! following jumps + choices, producing a deterministic [`KagTrace`]. It is
//! the Utsushi-side analogue of `utsushi-reallive::replay_scene`: same
//! trace/observe shape (typed events + a byte-deterministic JSON surface
//! with sorted keys and no floats), same fail-soft-with-typed-diagnostics
//! posture (an unsupported command records a semantic diagnostic and
//! advances; it never panics and never silently skips).
//!
//! ## Honest scope
//!
//! This is a plaintext KAG REPLAY *skeleton*. It replays the structural
//! flow — message text, name state, choices, jumps — of a `.ks` script that
//! is ALREADY plaintext on disk. It does NOT evaluate TJS
//! (`[eval]`/`[emb]`/`[if]`/`[iscript]`/macros), and it does NOT open or
//! decrypt XP3 containers. Every one of those surfaces as a typed
//! [`KagDiagnostic`], so the boundary is visible in the trace, not hidden.
//! See [`crate::capability_note`].

use serde::Serialize;

use crate::parse::{BlockKind, Command, Instr, KagScript};

/// Stable schema label for [`KagTrace`], pinned so a consumer detects a
/// future bump at parse time.
pub const KAG_TRACE_SCHEMA_VERSION: &str = "utsushi-kirikiri-kag-trace/0.1.0-beta";

/// Default replay step budget. Sized to walk a synthetic fixture to its
/// terminus while terminating deterministically on a jump cycle.
pub const DEFAULT_STEP_BUDGET: u32 = 100_000;

/// Knobs for [`replay_kag`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KagReplayOpts {
    /// Maximum instructions executed before [`KagOutcome::BudgetExhausted`].
    pub step_budget: u32,
    /// Deterministic choice policy: the option index selected at the Nth
    /// choice menu. When the sequence is exhausted, the default is option
    /// `0` (the first). This makes a choice-driven replay reproducible
    /// without any interactive input.
    pub selections: Vec<usize>,
}

impl Default for KagReplayOpts {
    fn default() -> Self {
        Self {
            step_budget: DEFAULT_STEP_BUDGET,
            selections: Vec::new(),
        }
    }
}

/// One replay observation. Covers exactly the four structural surfaces the
/// node scopes: text, name state, choices, jumps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KagEvent {
    /// A message text run surfaced, carrying the active speaker (the `#name`
    /// state at the moment the text plays; `None` for narration).
    Message {
        /// The decoded message text run.
        text: String,
        /// Active speaker display name, or `None` for narration.
        #[serde(skip_serializing_if = "Option::is_none")]
        speaker: Option<String>,
    },
    /// The active speaker changed via a `#name` line. `speaker: None` marks
    /// a bare-`#` reset. Emitted so the name-state timeline is explicit in
    /// the trace, independent of whether any message followed.
    SpeakerChange {
        /// New active speaker, or `None` on reset.
        #[serde(skip_serializing_if = "Option::is_none")]
        speaker: Option<String>,
    },
    /// A choice menu (`[link …]…[endlink]` run) was presented. `options`
    /// lists every choice with the `*label` it jumps to; `selected` is the
    /// deterministically-chosen index. A [`KagEvent::Jump`] to the selected
    /// option's target follows.
    Choice {
        /// Every option, in menu order.
        options: Vec<ChoiceOption>,
        /// Index into `options` chosen by the deterministic policy.
        selected: usize,
    },
    /// Control transferred to a `*label`. `from_label` is the most recent
    /// label the walk passed through (`None` before the first label).
    Jump {
        /// Origin label, if any.
        #[serde(skip_serializing_if = "Option::is_none")]
        from_label: Option<String>,
        /// Destination label name (`*` stripped).
        to_label: String,
    },
}

/// One option of a [`KagEvent::Choice`] menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChoiceOption {
    /// Visible choice text (the run between `[link]` and `[endlink]`).
    pub text: String,
    /// `*label` the option jumps to (`*` stripped).
    pub target: String,
}

/// A typed semantic diagnostic. Emitted (not panicked, not silently
/// dropped) whenever the replay meets something outside the plaintext
/// text/name/choice/jump skeleton.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KagDiagnostic {
    /// Machine-stable semantic code
    /// (e.g. `utsushi.kirikiri.kag.unsupported_tjs_expression`).
    pub code: String,
    /// Which surface this concerns (a KAG command/tag name, or a block
    /// kind). Structural only — never message text.
    pub detail: String,
}

/// Semantic diagnostic kinds. Each maps to a stable `code` string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KagDiagnosticKind {
    /// A TJS expression tag (`[eval exp=…]`, `[emb exp=…]`, or any tag with
    /// an `exp=`/`cond=` attribute). TJS is not evaluated by the skeleton.
    UnsupportedTjsExpression,
    /// A TJS conditional control tag (`[if]`/`[elsif]`/`[else]`/`[endif]`).
    UnsupportedTjsConditional,
    /// A swallowed `[iscript]…[endscript]` TJS block.
    UnsupportedTjsBlock,
    /// A macro definition (`[macro]…[endmacro]`) or macro invocation.
    UnsupportedMacro,
    /// A jump/link/call to a different `storage=` (another `.ks` file). The
    /// skeleton replays a single already-extracted script only.
    UnsupportedCrossStorageJump,
    /// A jump/link target `*label` that is not present in this script.
    UnresolvedJumpTarget,
    /// A KAG command outside the text/name/choice/jump skeleton (recognised
    /// as a command, deliberately not modelled — recorded, not skipped).
    UnsupportedCommand,
}

impl KagDiagnosticKind {
    /// Stable machine code for this diagnostic.
    #[must_use]
    pub fn code(self) -> &'static str {
        match self {
            Self::UnsupportedTjsExpression => "utsushi.kirikiri.kag.unsupported_tjs_expression",
            Self::UnsupportedTjsConditional => "utsushi.kirikiri.kag.unsupported_tjs_conditional",
            Self::UnsupportedTjsBlock => "utsushi.kirikiri.kag.unsupported_tjs_block",
            Self::UnsupportedMacro => "utsushi.kirikiri.kag.unsupported_macro",
            Self::UnsupportedCrossStorageJump => {
                "utsushi.kirikiri.kag.unsupported_cross_storage_jump"
            }
            Self::UnresolvedJumpTarget => "utsushi.kirikiri.kag.unresolved_jump_target",
            Self::UnsupportedCommand => "utsushi.kirikiri.kag.unsupported_command",
        }
    }
}

/// Terminal outcome of a [`replay_kag`] walk. Named variants only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum KagOutcome {
    /// The walk reached the end of the instruction stream.
    EndOfScript {
        /// Number of events recorded at end-of-script.
        events: usize,
    },
    /// The walk exhausted [`KagReplayOpts::step_budget`] (e.g. a jump cycle).
    BudgetExhausted {
        /// Number of events recorded at the budget boundary.
        events: usize,
    },
}

/// The deterministic trace [`replay_kag`] produces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KagTrace {
    /// Equals [`KAG_TRACE_SCHEMA_VERSION`].
    pub schema_version: String,
    /// Source file the replay was driven against.
    pub source_file: String,
    /// Detected encoding label.
    pub encoding: String,
    /// Ordered structural observations.
    pub events: Vec<KagEvent>,
    /// Typed semantic diagnostics, in the order they were met.
    pub diagnostics: Vec<KagDiagnostic>,
    /// Terminal outcome.
    pub outcome: KagOutcome,
}

impl KagTrace {
    /// Number of [`KagEvent::Message`] events.
    #[must_use]
    pub fn message_count(&self) -> usize {
        self.events
            .iter()
            .filter(|e| matches!(e, KagEvent::Message { .. }))
            .count()
    }

    /// The `(text, speaker)` of every message, in order — the surface the
    /// text+name cross-validation test compares against KAIFUU-009's
    /// dialogue units.
    #[must_use]
    pub fn message_texts_with_speakers(&self) -> Vec<(String, Option<String>)> {
        self.events
            .iter()
            .filter_map(|e| match e {
                KagEvent::Message { text, speaker } => Some((text.clone(), speaker.clone())),
                _ => None,
            })
            .collect()
    }

    /// Whether any diagnostic with `code` is present.
    #[must_use]
    pub fn has_diagnostic(&self, code: &str) -> bool {
        self.diagnostics.iter().any(|d| d.code == code)
    }

    /// Byte-deterministic JSON: sorted keys at every level, no floats. Two
    /// replays of the same script produce identical output. Mirrors
    /// `utsushi-reallive::ReplayLog::to_deterministic_json`.
    ///
    /// # Errors
    /// Returns [`KagTraceError::Serialize`] if serialisation fails (never
    /// expected for this in-memory, float-free value).
    pub fn to_deterministic_json(&self) -> Result<String, KagTraceError> {
        let value = to_sorted_value(self)?;
        let mut out = Vec::with_capacity(1024);
        let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
        let mut ser = serde_json::Serializer::with_formatter(&mut out, formatter);
        value
            .serialize(&mut ser)
            .map_err(|e| KagTraceError::Serialize(e.to_string()))?;
        String::from_utf8(out).map_err(|e| KagTraceError::Serialize(e.to_string()))
    }
}

/// Typed error from the trace surface.
#[derive(Debug, thiserror::Error)]
pub enum KagTraceError {
    /// Deterministic-JSON serialisation failed.
    #[error("utsushi.kirikiri.kag.trace.serialize: {0}")]
    Serialize(String),
}

/// Recursively rebuild a serde value with object keys sorted, so the pretty
/// printer emits a byte-stable ordering regardless of struct field order.
fn to_sorted_value<T: Serialize>(value: &T) -> Result<serde_json::Value, KagTraceError> {
    let raw = serde_json::to_value(value).map_err(|e| KagTraceError::Serialize(e.to_string()))?;
    Ok(sort_value(raw))
}

fn sort_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut entries: Vec<(String, serde_json::Value)> =
                map.into_iter().map(|(k, v)| (k, sort_value(v))).collect();
            entries.sort_by(|(a, _), (b, _)| a.cmp(b));
            let mut sorted = serde_json::Map::with_capacity(entries.len());
            for (k, v) in entries {
                sorted.insert(k, v);
            }
            serde_json::Value::Object(sorted)
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(sort_value).collect())
        }
        other => other,
    }
}

/// Replay `script` with default options.
#[must_use]
pub fn replay_kag(script: &KagScript) -> KagTrace {
    replay_kag_with_opts(script, &KagReplayOpts::default())
}

/// Replay `script` with explicit `opts`.
#[must_use]
pub fn replay_kag_with_opts(script: &KagScript, opts: &KagReplayOpts) -> KagTrace {
    let mut engine = Engine {
        script,
        events: Vec::new(),
        diagnostics: Vec::new(),
        speaker: None,
        current_label: None,
        choice_cursor: 0,
    };
    let outcome = engine.run(opts);
    KagTrace {
        schema_version: KAG_TRACE_SCHEMA_VERSION.to_string(),
        source_file: script.source_file.clone(),
        encoding: script.encoding.as_str().to_string(),
        events: engine.events,
        diagnostics: engine.diagnostics,
        outcome,
    }
}

struct Engine<'a> {
    script: &'a KagScript,
    events: Vec<KagEvent>,
    diagnostics: Vec<KagDiagnostic>,
    speaker: Option<String>,
    current_label: Option<String>,
    /// How many choice menus have been resolved (indexes into
    /// `opts.selections`).
    choice_cursor: usize,
}

/// What a command handler decided about the program counter.
enum Flow {
    /// Advance to the next instruction.
    Next,
    /// Jump to an absolute instruction index.
    Goto(usize),
}

impl Engine<'_> {
    fn run(&mut self, opts: &KagReplayOpts) -> KagOutcome {
        let instrs = &self.script.instrs;
        let mut pc = 0usize;
        let mut steps = 0u32;
        while pc < instrs.len() {
            if steps >= opts.step_budget {
                return KagOutcome::BudgetExhausted {
                    events: self.events.len(),
                };
            }
            steps += 1;
            let flow = match &instrs[pc] {
                Instr::Label(name) => {
                    self.current_label = Some(name.clone());
                    Flow::Next
                }
                Instr::Name(speaker) => {
                    self.speaker = speaker.clone();
                    self.events.push(KagEvent::SpeakerChange {
                        speaker: speaker.clone(),
                    });
                    Flow::Next
                }
                Instr::Text(text) => {
                    self.events.push(KagEvent::Message {
                        text: text.clone(),
                        speaker: self.speaker.clone(),
                    });
                    Flow::Next
                }
                Instr::UnsupportedBlock(kind) => {
                    self.push_block_diagnostic(*kind);
                    Flow::Next
                }
                Instr::Command(command) => self.handle_command(command, pc, opts),
            };
            match flow {
                Flow::Next => pc += 1,
                Flow::Goto(target) => pc = target,
            }
        }
        KagOutcome::EndOfScript {
            events: self.events.len(),
        }
    }

    fn handle_command(&mut self, command: &Command, pc: usize, opts: &KagReplayOpts) -> Flow {
        let name = command.name.as_str();
        match name {
            // TJS conditional control — recognised by name (an `[if]` always
            // carries `exp=`, but it is a conditional, not a plain expr).
            "if" | "elsif" | "else" | "endif" => {
                self.push(KagDiagnosticKind::UnsupportedTjsConditional, name);
                Flow::Next
            }
            "macro" | "endmacro" | "erasemacro" => {
                self.push(KagDiagnosticKind::UnsupportedMacro, name);
                Flow::Next
            }
            "eval" | "emb" => {
                self.push(KagDiagnosticKind::UnsupportedTjsExpression, name);
                Flow::Next
            }
            "jump" => self.handle_jump(command),
            "call" => {
                // `[call storage=…]` enters another script — out of scope for
                // a single-script skeleton.
                self.push(KagDiagnosticKind::UnsupportedCrossStorageJump, name);
                Flow::Next
            }
            "link" => self.handle_choice_menu(pc, opts),
            // Grouping / presentational tags the skeleton recognises and
            // deliberately treats as no-ops (documented; NOT silently
            // skipped — they are enumerated here on purpose). `endlink` is
            // consumed inside `handle_choice_menu`; a stray one is a no-op.
            "endlink" | "select" | "endselect" | "p" | "l" | "r" | "pg" | "cm" | "ct" => Flow::Next,
            // Any OTHER tag driven by a TJS expression (`exp=`/`cond=`) is a
            // TJS expression the skeleton cannot evaluate; an unadorned
            // unknown tag is a recognised-but-unmodelled command.
            _ if command.has_tjs_expression() => {
                self.push(KagDiagnosticKind::UnsupportedTjsExpression, name);
                Flow::Next
            }
            _ => {
                self.push(KagDiagnosticKind::UnsupportedCommand, name);
                Flow::Next
            }
        }
    }

    fn handle_jump(&mut self, command: &Command) -> Flow {
        // A conditional jump (`[jump cond=…]`) depends on TJS the skeleton
        // cannot evaluate; do NOT follow it — record it instead.
        if command.has_tjs_expression() {
            self.push(KagDiagnosticKind::UnsupportedTjsExpression, "jump");
            return Flow::Next;
        }
        if let Some(storage) = command.attr("storage")
            && !self.is_current_storage(storage)
        {
            self.push(KagDiagnosticKind::UnsupportedCrossStorageJump, storage);
            return Flow::Next;
        }
        if let Some(target) = command.attr("target") {
            self.jump_to(target)
        } else {
            // A same-file `[jump]` with no target is malformed; record it
            // rather than crashing.
            self.push(KagDiagnosticKind::UnsupportedCommand, "jump");
            Flow::Next
        }
    }

    /// Collect a maximal run of `[link …]…[endlink]` options starting at
    /// `pc`, present them as one [`KagEvent::Choice`], select one
    /// deterministically, and jump to its target.
    fn handle_choice_menu(&mut self, pc: usize, opts: &KagReplayOpts) -> Flow {
        let instrs = &self.script.instrs;
        let mut options: Vec<ChoiceOption> = Vec::new();
        let mut cross_storage = false;
        let mut i = pc;
        while i < instrs.len() {
            let Instr::Command(cmd) = &instrs[i] else {
                // Whitespace-only runs were dropped at parse time; a stray
                // non-command between links ends the menu.
                if is_link_separator(&instrs[i]) {
                    i += 1;
                    continue;
                }
                break;
            };
            if cmd.name != "link" {
                break;
            }
            let same_storage = cmd
                .attr("storage")
                .is_none_or(|s| self.is_current_storage(s));
            if !same_storage {
                cross_storage = true;
            }
            let target = cmd
                .attr("target")
                .map(|t| strip_label_star(t).to_string())
                .unwrap_or_default();
            let (text, next) = collect_link_text(instrs, i + 1);
            options.push(ChoiceOption { text, target });
            i = next;
        }

        if cross_storage {
            self.push(KagDiagnosticKind::UnsupportedCrossStorageJump, "link");
        }
        if options.is_empty() {
            // Should not happen (called on a `link`), but never crash.
            return Flow::Next;
        }

        let selected = opts
            .selections
            .get(self.choice_cursor)
            .copied()
            .unwrap_or(0)
            .min(options.len() - 1);
        self.choice_cursor += 1;
        let target = options[selected].target.clone();
        self.events.push(KagEvent::Choice { options, selected });
        if target.is_empty() {
            self.push(KagDiagnosticKind::UnresolvedJumpTarget, "link");
            return Flow::Next;
        }
        self.jump_to(&target)
    }

    fn jump_to(&mut self, target: &str) -> Flow {
        let label = strip_label_star(target);
        if let Some(&index) = self.script.labels.get(label) {
            self.events.push(KagEvent::Jump {
                from_label: self.current_label.clone(),
                to_label: label.to_string(),
            });
            Flow::Goto(index)
        } else {
            self.push(KagDiagnosticKind::UnresolvedJumpTarget, label);
            Flow::Next
        }
    }

    fn is_current_storage(&self, storage: &str) -> bool {
        // Compare against the source file name, tolerating a `.ks` suffix on
        // either side.
        let strip = |s: &str| s.strip_suffix(".ks").unwrap_or(s).to_string();
        strip(storage) == strip(&self.script.source_file)
    }

    fn push_block_diagnostic(&mut self, kind: BlockKind) {
        let diag = match kind {
            BlockKind::IScript => KagDiagnosticKind::UnsupportedTjsBlock,
            BlockKind::Macro => KagDiagnosticKind::UnsupportedMacro,
        };
        self.push(diag, kind.as_str());
    }

    fn push(&mut self, kind: KagDiagnosticKind, detail: &str) {
        self.diagnostics.push(KagDiagnostic {
            code: kind.code().to_string(),
            detail: detail.to_string(),
        });
    }
}

/// Text runs / no-op presentational tags may sit between `[link]` items in a
/// choice menu; those separators are skipped when scanning the menu.
fn is_link_separator(instr: &Instr) -> bool {
    match instr {
        Instr::Text(_) => true,
        Instr::Command(cmd) => matches!(cmd.name.as_str(), "r" | "l" | "p" | "pg"),
        _ => false,
    }
}

/// Collect the visible text of one link option: the `Text` runs between a
/// `[link]` and its `[endlink]`. Returns the joined text and the index just
/// past the `[endlink]` (or past the last consumed instruction).
fn collect_link_text(instrs: &[Instr], start: usize) -> (String, usize) {
    let mut text = String::new();
    let mut i = start;
    while i < instrs.len() {
        match &instrs[i] {
            Instr::Text(run) => {
                text.push_str(run);
                i += 1;
            }
            Instr::Command(cmd) if cmd.name == "endlink" => {
                i += 1;
                break;
            }
            // Another `[link]` (or anything else) without an intervening
            // `[endlink]` ends this option's text.
            _ => break,
        }
    }
    (text, i)
}

fn strip_label_star(target: &str) -> &str {
    target.strip_prefix('*').unwrap_or(target)
}
