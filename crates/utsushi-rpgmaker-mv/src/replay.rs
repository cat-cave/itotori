//! Narrow, deterministic REPLAY skeleton for a declared subset of RPG Maker
//! MV/MZ event-command lists.
//!
//! # Replay vs the static walk
//!
//! [`crate::event_data`] is a *static event-stream walk*: it surfaces the
//! text-bearing commands in declaration order, does not thread any state, and
//! silently skips every non-text command. This module is deliberately
//! different — it is a **replay**:
//!
//! - It threads deterministic **switch/variable state** across the command
//!   list (`Control Switches` 121, `Control Variables` 122) and emits a state
//!   trace as those values change.
//! - It emits ordered **text** (`Show Text` 101 setup + 401 body lines) and
//!   **choice** (`Show Choices` 102) trace events alongside the state trace.
//! - It is **not** a broad VM: it replays only the *declared subset* below.
//!   Any command outside that subset surfaces a **semantic diagnostic**
//!   (typed reason + JSON pointer) — never a silent skip, never a panic.
//!   That visibility is the substrate law: unsupported must be visible.
//!
//! # Declared command subset
//!
//! code | command | replay effect
//! ------|---------------------|---------------------------------------------
//! 101 | Show Text (setup) | opens a message window; MZ speaker = p\[4\]
//! 401 | Show Text (body) | appends one line to the open message window
//! 102 | Show Choices | emits a choice event (options in decl order)
//! 121 | Control Switches | sets switch(es) ON/OFF → switch state trace
//! 122 | Control Variables | mutates variable(s) → variable state trace
//! 0 | end of list | flushes any open message window; no event
//!
//! Code `0` (list terminator) is recognised as a structural no-op so a
//! well-formed list does not trip the unknown-command diagnostic. Every other
//! code is *unsupported by this narrow skeleton* and produces a diagnostic.
//!
//! `Control Variables` (122) supports the `set/add/sub/mul/div/mod`
//! operations against a **constant** (operand 0) or **another variable**
//! (operand 1) operand. Random/game-data/script operands (2/3/4) are outside
//! the skeleton and surface a diagnostic rather than silently computing a
//! wrong value.
//!
//! The command-code numbers are public RPG Maker MV/MZ engine constants
//! documented across the community wikis; no game-specific bytes inform this
//! module.

use std::collections::BTreeMap;

use serde_json::{Value, json};

mod replayer;

pub use replayer::replay_event_list;

/// Schema tag for the replay trace serialization. Distinct from the
/// live-observation envelope's `0.1.0-alpha` because a replay is a *static*
/// re-execution of the event bytes, not a live-DOM observation.
pub const REPLAY_TRACE_SCHEMA: &str = "0.1.0-alpha";

/// Observation-source tag distinguishing a replay trace from the live-DOM
/// fixture-declared sources the envelope carries.
pub const OBSERVATION_SOURCE_STATIC_REPLAY: &str = "static_replay";

/// How the replay reacts to a command outside the declared subset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnknownPolicy {
    /// Record a diagnostic and continue replaying the rest of the list.
    /// The command's effect is *not* applied (there is no VM for it), but the
    /// gap is recorded and visible — never silently dropped.
    SkipWithDiagnostic,
    /// Abort the replay at the first out-of-subset command, returning the
    /// diagnostic as an error.
    Fail,
}

/// Severity of a replay diagnostic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiagnosticSeverity {
    /// The command was outside the declared subset and its effect was skipped.
    Unsupported,
    /// The command was in the subset but its parameters were malformed.
    Malformed,
}

impl DiagnosticSeverity {
    /// Stable lowercase identifier used in the serialized trace.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported",
            Self::Malformed => "malformed",
        }
    }
}

/// A typed, visible reason a command could not be replayed by the skeleton.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiagnosticReason {
    /// The command code is not in the declared replay subset.
    CommandOutsideSubset { code: i64 },
    /// A `Control Variables` operand type the skeleton does not model
    /// (2 = random, 3 = game data, 4 = script).
    UnsupportedVariableOperand { operand_type: i64 },
    /// A `Control Variables` operation code the skeleton does not model.
    UnsupportedVariableOperation { operation: i64 },
    /// A command in the subset had missing/ill-typed parameters.
    MalformedParameters { code: i64, detail: String },
}

impl DiagnosticReason {
    fn severity(&self) -> DiagnosticSeverity {
        match self {
            Self::CommandOutsideSubset { .. }
            | Self::UnsupportedVariableOperand { .. }
            | Self::UnsupportedVariableOperation { .. } => DiagnosticSeverity::Unsupported,
            Self::MalformedParameters { .. } => DiagnosticSeverity::Malformed,
        }
    }

    /// Stable machine-readable kind tag.
    fn kind(&self) -> &'static str {
        match self {
            Self::CommandOutsideSubset { .. } => "command_outside_subset",
            Self::UnsupportedVariableOperand { .. } => "unsupported_variable_operand",
            Self::UnsupportedVariableOperation { .. } => "unsupported_variable_operation",
            Self::MalformedParameters { .. } => "malformed_parameters",
        }
    }

    /// Human-readable message.
    fn message(&self) -> String {
        match self {
            Self::CommandOutsideSubset { code } => {
                format!("event command code {code} is outside the declared replay subset")
            }
            Self::UnsupportedVariableOperand { operand_type } => format!(
                "Control Variables operand type {operand_type} is not modelled by the replay skeleton"
            ),
            Self::UnsupportedVariableOperation { operation } => format!(
                "Control Variables operation code {operation} is not modelled by the replay skeleton"
            ),
            Self::MalformedParameters { code, detail } => {
                format!("command code {code} has malformed parameters: {detail}")
            }
        }
    }
}

/// One typed diagnostic emitted while replaying, locating the offending
/// command by its index in the event list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayDiagnostic {
    /// The offending event command's `code`.
    pub code: i64,
    /// Position of the command in the replayed `list[]`.
    pub command_index: usize,
    pub severity: DiagnosticSeverity,
    pub reason: DiagnosticReason,
}

impl ReplayDiagnostic {
    fn to_json(&self) -> Value {
        json!({
            "code": self.code,
            "commandIndex": self.command_index,
            "severity": self.severity.as_str(),
            "reasonKind": self.reason.kind(),
            "message": self.reason.message(),
        })
    }
}

impl std::fmt::Display for ReplayDiagnostic {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "[{}] command #{} (code {}): {}",
            self.severity.as_str(),
            self.command_index,
            self.code,
            self.reason.message()
        )
    }
}

impl std::error::Error for ReplayDiagnostic {}

/// One deterministic trace event produced by replaying the declared subset.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReplayEvent {
    /// A `Show Text` message window (101 setup + its 401 body lines).
    Text {
        speaker: Option<String>,
        lines: Vec<String>,
    },
    /// A `Show Choices` prompt (102) — options in declaration order. The
    /// skeleton does not branch; it records the choice as presented.
    Choice { options: Vec<String> },
    /// A switch changed value (121).
    SwitchChanged { switch_id: i64, value: bool },
    /// A variable changed value (122).
    VariableChanged { variable_id: i64, value: i64 },
}

impl ReplayEvent {
    /// Envelope-compatible JSON for the event. Text/choice events mirror the
    /// `payloadKind` vocabulary (`text` / `choice`); the `state`
    /// kind is a replay-specific extension the live-observation envelope has
    /// no slot for.
    fn to_json(&self) -> Value {
        match self {
            Self::Text { speaker, lines } => json!({
                "eventKind": "text",
                "payload": {
                    "payloadKind": "text",
                    "speaker": speaker,
                    "lines": lines,
                },
            }),
            Self::Choice { options } => json!({
                "eventKind": "choice",
                "payload": {
                    "payloadKind": "choice",
                    "options": options,
                },
            }),
            Self::SwitchChanged { switch_id, value } => json!({
                "eventKind": "state",
                "payload": {
                    "payloadKind": "switch",
                    "switchId": switch_id,
                    "value": value,
                },
            }),
            Self::VariableChanged { variable_id, value } => json!({
                "eventKind": "state",
                "payload": {
                    "payloadKind": "variable",
                    "variableId": variable_id,
                    "value": value,
                },
            }),
        }
    }
}

/// The switch/variable state threaded across the replay. Deterministic: reads
/// of an unset switch/variable return the engine defaults (switch = OFF
/// variable = 0), matching RPG Maker MV/MZ runtime semantics.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReplayState {
    switches: BTreeMap<i64, bool>,
    variables: BTreeMap<i64, i64>,
}

impl ReplayState {
    /// Current value of a switch (default OFF).
    pub fn switch(&self, id: i64) -> bool {
        self.switches.get(&id).copied().unwrap_or(false)
    }

    /// Current value of a variable (default 0).
    pub fn variable(&self, id: i64) -> i64 {
        self.variables.get(&id).copied().unwrap_or(0)
    }

    fn set_switch(&mut self, id: i64, value: bool) {
        self.switches.insert(id, value);
    }

    fn set_variable(&mut self, id: i64, value: i64) {
        self.variables.insert(id, value);
    }

    /// Deterministic JSON snapshot of the final state (ascending id order).
    fn to_json(&self) -> Value {
        let switches: Vec<Value> = self
            .switches
            .iter()
            .map(|(id, value)| json!({ "switchId": id, "value": value }))
            .collect();
        let variables: Vec<Value> = self
            .variables
            .iter()
            .map(|(id, value)| json!({ "variableId": id, "value": value }))
            .collect();
        json!({ "switches": switches, "variables": variables })
    }
}

/// The result of replaying one event `list[]`: the ordered trace, the final
/// state, and any diagnostics gathered under [`UnknownPolicy::SkipWithDiagnostic`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReplayOutcome {
    pub events: Vec<ReplayEvent>,
    pub state: ReplayState,
    pub diagnostics: Vec<ReplayDiagnostic>,
}

impl ReplayOutcome {
    /// Deterministic, envelope-compatible JSON serialization of the whole
    /// replay trace. Golden tests assert against this.
    pub fn to_trace_json(&self) -> Value {
        json!({
            "schemaVersion": REPLAY_TRACE_SCHEMA,
            "observationSource": OBSERVATION_SOURCE_STATIC_REPLAY,
            "events": self.events.iter().map(ReplayEvent::to_json).collect::<Vec<_>>(),
            "finalState": self.state.to_json(),
            "diagnostics": self
                .diagnostics
                .iter()
                .map(ReplayDiagnostic::to_json)
                .collect::<Vec<_>>(),
        })
    }
}

#[cfg(test)]
#[path = "replay_tests.rs"]
mod tests;
