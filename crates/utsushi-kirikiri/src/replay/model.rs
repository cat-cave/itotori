use super::*;

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
