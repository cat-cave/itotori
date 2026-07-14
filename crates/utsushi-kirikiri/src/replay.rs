//! KAG plaintext REPLAY engine + typed trace.
//!
//! [`replay_kag`] walks a [`KagScript`] instruction stream like a tiny VM
//! tracking the active speaker (`#name` state), emitting message text, and
//! following jumps + choices, producing a deterministic [`KagTrace`]. It is
//! the Utsushi-side analogue of `utsushi-reallive::replay_scene`: same
//! trace/observe shape (typed events + a byte-deterministic JSON surface
//! with sorted keys and no floats), same fail-soft-with-typed-diagnostics
//! posture (an unsupported command records a semantic diagnostic and
//! advances; it never panics and never silently skips).
//!
//! ## Honest scope ( macro + storage subset)
//!
//! This is a plaintext KAG REPLAY *skeleton*. It replays the structural
//! flow — message text, name state, choices, jumps — of a `.ks` script that
//! is ALREADY plaintext on disk, plus a BOUNDED subset of macro expansion
//! (handled in [`crate::parse`]) and storage variables:
//!
//! - **Storage variables (bounded subset).** `[eval exp="f.x = …"]` performs a
//!   SIMPLE assignment to an `f.` (game flag) or `sf.` (system flag) variable
//!   whose right-hand side is an integer literal, a quoted string literal
//!   another already-bound `f.`/`sf.` variable (a copy), or a single spaced
//!   `A + B` / `A - B` over integer operands (so `f.count = f.count + 1`
//!   counters work). `[emb exp="f.x"]` reads a single already-bound variable
//!   and records its value. Variable state is visible as
//!   [`KagEvent::VariableSet`] / [`KagEvent::EmbeddedValue`] events and in the
//!   final [`KagTrace::variables`] snapshot.
//! - **Everything else is a typed diagnostic, never faked.** Any `[eval]`
//!   `[emb]` expression outside that subset (multiplication, comparisons
//!   function/method calls, string concatenation, multi-statement, a
//!   non-`f.`/`sf.` target) is an `unsupported_tjs_expression`; a read/copy of
//!   an UNBOUND variable is an `unresolved_variable`; `[if]` conditionals
//!   `[iscript]` blocks, and out-of-subset macros surface as their own typed
//!   diagnostics. It does NOT open or decrypt XP3 containers. Every
//!   unsupported construct is a [`KagDiagnostic`], so the boundary is visible
//!   in the trace, not hidden. See [`crate::capability_note`].

use std::collections::BTreeMap;

use serde::Serialize;

use crate::parse::{BlockKind, Command, Instr, KagScript};

/// Stable schema label for [`KagTrace`], pinned so a consumer detects a
/// future bump at parse time. Bumped for (macro expansion
/// storage-variable events and the `variables` snapshot).
pub const KAG_TRACE_SCHEMA_VERSION: &str = "utsushi-kirikiri-kag-trace/0.2.0-beta";

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

/// A KAG storage-variable value. KAG flag variables are integers or strings;
/// the supported subset models exactly those two (no floats, so the
/// deterministic JSON stays byte-stable). Serialised externally-tagged
/// (`{"int": 2}` / `{"str": "Alice"}`) so a consumer never has to guess the
/// type from the JSON shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VarValue {
    /// An integer flag value.
    Int(i64),
    /// A string flag value.
    Str(String),
}

/// One replay observation. Covers the four structural surfaces the skeleton
/// scopes (text, name state, choices, jumps) plus the two storage-variable
/// surfaces of the subset (a set, and an embedded read).
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
    /// A supported `[eval]` storage assignment was applied: variable `name`
    /// now holds `value`. The [`KagTrace::variables`] snapshot reflects the
    /// cumulative state; this event marks each individual change in order.
    VariableSet {
        /// Fully-qualified variable name (`f.x` / `sf.x`).
        name: String,
        /// The value assigned.
        value: VarValue,
    },
    /// A supported `[emb exp="f.x"]` read embedded the CURRENT value of an
    /// already-bound variable. Emitted (rather than folded into a message run)
    /// so an embedded storage value is never confused with authored dialogue.
    EmbeddedValue {
        /// The variable read.
        name: String,
        /// Its value at the moment of the read.
        value: VarValue,
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
    /// A macro construct OUTSIDE the supported expansion subset: an
    /// invocation whose `%param`s could not be resolved, a nameless/malformed
    /// `[macro]` definition, an invocation nested too deep, or a runtime
    /// macro op (`[erasemacro]`). A supported definition + invocation expands
    /// silently (in [`crate::parse`]) and produces no diagnostic.
    UnsupportedMacro,
    /// A read/copy of an `f.`/`sf.` storage variable that has not been bound
    /// by a prior supported `[eval]` assignment. The subset does NOT invent a
    /// value (no fake `0`/`""`) — it records this and advances.
    UnresolvedVariable,
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
            Self::UnresolvedVariable => "utsushi.kirikiri.kag.unresolved_variable",
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
    /// Final storage-variable snapshot (name → value) after the walk. A
    /// `BTreeMap` so the serialised order is deterministic. Empty for a script
    /// with no supported storage assignments.
    pub variables: BTreeMap<String, VarValue>,
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
    /// text+name cross-validation test compares against the
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

    /// The final value of storage variable `name`, if it was bound by a
    /// supported assignment during the walk.
    #[must_use]
    pub fn variable(&self, name: &str) -> Option<&VarValue> {
        self.variables.get(name)
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
pub(crate) fn to_sorted_value<T: Serialize>(value: &T) -> Result<serde_json::Value, KagTraceError> {
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
        variables: BTreeMap::new(),
    };
    let outcome = engine.run(opts);
    KagTrace {
        schema_version: KAG_TRACE_SCHEMA_VERSION.to_string(),
        source_file: script.source_file.clone(),
        encoding: script.encoding.as_str().to_string(),
        events: engine.events,
        diagnostics: engine.diagnostics,
        variables: engine.variables,
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
    /// Live storage-variable state (`f.`/`sf.` name → value), evolving as
    /// supported `[eval]` assignments execute.
    variables: BTreeMap<String, VarValue>,
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
                Instr::UnexpandedMacro(name) => {
                    self.push(KagDiagnosticKind::UnsupportedMacro, name);
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
            // `[macro]`/`[endmacro]` are consumed in the parser (supported
            // definitions expand silently); a stray one, or `[erasemacro]`
            // (runtime macro deletion, out of subset), is a diagnostic.
            "macro" | "endmacro" | "erasemacro" => {
                self.push(KagDiagnosticKind::UnsupportedMacro, name);
                Flow::Next
            }
            "eval" => self.handle_eval(command),
            "emb" => self.handle_emb(command),
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
        };
        self.push(diag, kind.as_str());
    }

    /// Handle `[eval exp="…"]`. A supported simple assignment updates variable
    /// state and records a [`KagEvent::VariableSet`]; a read of an unbound
    /// variable is an `unresolved_variable` diagnostic; anything else is an
    /// `unsupported_tjs_expression` (never a faked value).
    fn handle_eval(&mut self, command: &Command) -> Flow {
        let Some(exp) = command.attr("exp") else {
            self.push(KagDiagnosticKind::UnsupportedTjsExpression, "eval");
            return Flow::Next;
        };
        match self.eval_assignment(exp) {
            EvalOutcome::Assigned { name, value } => {
                self.variables.insert(name.clone(), value.clone());
                self.events.push(KagEvent::VariableSet { name, value });
            }
            EvalOutcome::UnresolvedVar(var) => {
                self.push(KagDiagnosticKind::UnresolvedVariable, &var);
            }
            EvalOutcome::Unsupported => {
                self.push(KagDiagnosticKind::UnsupportedTjsExpression, "eval");
            }
        }
        Flow::Next
    }

    /// Handle `[emb exp="f.x"]`. A read of a single already-bound variable
    /// records a [`KagEvent::EmbeddedValue`]; an unbound bare variable is an
    /// `unresolved_variable` diagnostic; any richer expression is an
    /// `unsupported_tjs_expression`.
    fn handle_emb(&mut self, command: &Command) -> Flow {
        let Some(exp) = command.attr("exp") else {
            self.push(KagDiagnosticKind::UnsupportedTjsExpression, "emb");
            return Flow::Next;
        };
        match parse_var_name(exp.trim()) {
            Some(name) => match self.variables.get(name) {
                Some(value) => self.events.push(KagEvent::EmbeddedValue {
                    name: name.to_string(),
                    value: value.clone(),
                }),
                None => self.push(KagDiagnosticKind::UnresolvedVariable, name),
            },
            None => self.push(KagDiagnosticKind::UnsupportedTjsExpression, "emb"),
        }
        Flow::Next
    }

    /// Parse a supported storage assignment `exp` (`f.x = RHS` / `sf.x = RHS`).
    /// Returns [`EvalOutcome::Unsupported`] for anything outside the subset —
    /// the target must be an `f.`/`sf.` variable and the RHS one of: an
    /// integer literal, a quoted string, another bound variable (copy), or a
    /// single spaced `A + B` / `A - B` over integer operands.
    fn eval_assignment(&self, exp: &str) -> EvalOutcome {
        let exp = exp.trim();
        // Reject comparisons/compound-assignments up front so a `==` is never
        // mistaken for the assignment `=`.
        if exp.contains("==")
            || exp.contains("!=")
            || exp.contains(">=")
            || exp.contains("<=")
            || exp.contains("+=")
            || exp.contains("-=")
        {
            return EvalOutcome::Unsupported;
        }
        let Some((lhs, rhs)) = exp.split_once('=') else {
            return EvalOutcome::Unsupported;
        };
        let Some(target) = parse_var_name(lhs.trim()) else {
            return EvalOutcome::Unsupported;
        };
        match self.eval_rhs(rhs.trim()) {
            RhsOutcome::Value(value) => EvalOutcome::Assigned {
                name: target.to_string(),
                value,
            },
            RhsOutcome::UnresolvedVar(var) => EvalOutcome::UnresolvedVar(var),
            RhsOutcome::Unsupported => EvalOutcome::Unsupported,
        }
    }

    /// Evaluate a supported right-hand side.
    fn eval_rhs(&self, rhs: &str) -> RhsOutcome {
        // A single operand: int literal, string literal, or a variable copy.
        match self.resolve_operand(rhs) {
            OperandOutcome::Value(v) => return RhsOutcome::Value(v),
            OperandOutcome::UnresolvedVar(var) => return RhsOutcome::UnresolvedVar(var),
            OperandOutcome::Unsupported => {}
        }
        // A single spaced `A + B` / `A - B` over integer operands.
        if let Some((a, op, b)) = split_binary(rhs) {
            let ai = match self.resolve_int(a) {
                IntOutcome::Value(v) => v,
                IntOutcome::UnresolvedVar(var) => return RhsOutcome::UnresolvedVar(var),
                IntOutcome::Unsupported => return RhsOutcome::Unsupported,
            };
            let bi = match self.resolve_int(b) {
                IntOutcome::Value(v) => v,
                IntOutcome::UnresolvedVar(var) => return RhsOutcome::UnresolvedVar(var),
                IntOutcome::Unsupported => return RhsOutcome::Unsupported,
            };
            let result = match op {
                '+' => ai.checked_add(bi),
                '-' => ai.checked_sub(bi),
                _ => None,
            };
            return match result {
                Some(v) => RhsOutcome::Value(VarValue::Int(v)),
                None => RhsOutcome::Unsupported, // overflow — refuse to fake
            };
        }
        RhsOutcome::Unsupported
    }

    /// Resolve a single operand to a [`VarValue`] (int literal, string
    /// literal, or a bound-variable copy).
    fn resolve_operand(&self, s: &str) -> OperandOutcome {
        let s = s.trim();
        if let Some(text) = string_literal(s) {
            return OperandOutcome::Value(VarValue::Str(text));
        }
        if let Ok(n) = s.parse::<i64>() {
            return OperandOutcome::Value(VarValue::Int(n));
        }
        if let Some(name) = parse_var_name(s) {
            return match self.variables.get(name) {
                Some(v) => OperandOutcome::Value(v.clone()),
                None => OperandOutcome::UnresolvedVar(name.to_string()),
            };
        }
        OperandOutcome::Unsupported
    }

    /// Resolve a single operand that MUST be an integer (literal or an
    /// int-valued bound variable) for arithmetic.
    fn resolve_int(&self, s: &str) -> IntOutcome {
        match self.resolve_operand(s) {
            OperandOutcome::Value(VarValue::Int(n)) => IntOutcome::Value(n),
            OperandOutcome::UnresolvedVar(var) => IntOutcome::UnresolvedVar(var),
            // A string operand or an unrecognised shape is not integer arithmetic.
            OperandOutcome::Value(VarValue::Str(_)) | OperandOutcome::Unsupported => {
                IntOutcome::Unsupported
            }
        }
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

/// Outcome of evaluating an `[eval]` expression against the supported subset.
enum EvalOutcome {
    /// A supported assignment: `name`:= `value`.
    Assigned { name: String, value: VarValue },
    /// A recognised assignment shape that reads an UNBOUND variable.
    UnresolvedVar(String),
    /// Outside the supported subset entirely.
    Unsupported,
}

/// Outcome of evaluating a right-hand side.
enum RhsOutcome {
    Value(VarValue),
    UnresolvedVar(String),
    Unsupported,
}

/// Outcome of resolving a single operand.
enum OperandOutcome {
    Value(VarValue),
    UnresolvedVar(String),
    Unsupported,
}

/// Outcome of resolving an operand constrained to an integer.
enum IntOutcome {
    Value(i64),
    UnresolvedVar(String),
    Unsupported,
}

/// If `s` is exactly an `f.IDENT` / `sf.IDENT` variable name, return it
/// (whole, including the prefix). `IDENT` is `[A-Za-z0-9_]+` with no further
/// `.`, so `f.a.b`, `game.x`, and `f.` are rejected.
fn parse_var_name(s: &str) -> Option<&str> {
    let s = s.trim();
    for prefix in ["f.", "sf."] {
        if let Some(rest) = s.strip_prefix(prefix)
            && !rest.is_empty()
            && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Some(s);
        }
    }
    None
}

/// If `s` is a `"…"` / `'…'` string literal (no embedded quote of the same
/// kind, no escapes — the bounded subset), return its inner text.
fn string_literal(s: &str) -> Option<String> {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() >= 2
        && (bytes[0] == b'"' || bytes[0] == b'\'')
        && bytes[bytes.len() - 1] == bytes[0]
    {
        let inner = &s[1..s.len() - 1];
        // A closing quote in the middle would be a concatenation/second token
        // — outside the single-literal subset.
        if !inner.contains(bytes[0] as char) {
            return Some(inner.to_string());
        }
    }
    None
}

/// Split a right-hand side into a single spaced binary `A OP B` where OP is
/// `+` or `-` (surrounding spaces REQUIRED, so a negative literal `-1` is one
/// operand, not an operator). Rejects a chained expression (a second top-level
/// operator) to stay inside the bounded subset.
fn split_binary(rhs: &str) -> Option<(&str, char, &str)> {
    for (token, op) in [(" + ", '+'), (" - ", '-')] {
        if let Some((a, b)) = rhs.split_once(token) {
            // A chain (`a + b + c`) is out of subset.
            if b.contains(" + ") || b.contains(" - ") {
                return None;
            }
            return Some((a.trim(), op, b.trim()));
        }
    }
    None
}
