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
//! | code | command             | replay effect                               |
//! |------|---------------------|---------------------------------------------|
//! | 101  | Show Text (setup)   | opens a message window; MZ speaker = p\[4\]  |
//! | 401  | Show Text (body)    | appends one line to the open message window |
//! | 102  | Show Choices        | emits a choice event (options in decl order)|
//! | 121  | Control Switches    | sets switch(es) ON/OFF → switch state trace |
//! | 122  | Control Variables   | mutates variable(s) → variable state trace  |
//! | 0    | end of list         | flushes any open message window; no event   |
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

/// Schema tag for the replay trace serialization. Distinct from the
/// live-observation envelope's `0.1.0-alpha` because a replay is a *static*
/// re-execution of the event bytes, not a live-DOM observation.
pub const REPLAY_TRACE_SCHEMA: &str = "0.1.0-alpha";

/// Observation-source tag distinguishing a replay trace from the live-DOM /
/// fixture-declared sources the UTSUSHI-006 envelope carries.
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
    /// UTSUSHI-006 `payloadKind` vocabulary (`text` / `choice`); the `state`
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
/// of an unset switch/variable return the engine defaults (switch = OFF,
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

/// Replay one event-command `list[]` (a JSON array of `{code, indent,
/// parameters}` objects) through the declared subset.
///
/// Under [`UnknownPolicy::SkipWithDiagnostic`] the whole list is replayed and
/// out-of-subset commands accumulate in [`ReplayOutcome::diagnostics`]. Under
/// [`UnknownPolicy::Fail`] the first out-of-subset command aborts with the
/// diagnostic as the `Err`.
pub fn replay_event_list(
    list: &[Value],
    policy: UnknownPolicy,
) -> Result<ReplayOutcome, ReplayDiagnostic> {
    let mut replayer = Replayer::new(policy);
    for (command_index, command) in list.iter().enumerate() {
        replayer.step(command_index, command)?;
    }
    replayer.flush_message();
    Ok(replayer.into_outcome())
}

/// Internal per-list replay state machine.
struct Replayer {
    policy: UnknownPolicy,
    outcome: ReplayOutcome,
    pending_speaker: Option<String>,
    pending_lines: Vec<String>,
    message_open: bool,
}

impl Replayer {
    fn new(policy: UnknownPolicy) -> Self {
        Self {
            policy,
            outcome: ReplayOutcome::default(),
            pending_speaker: None,
            pending_lines: Vec::new(),
            message_open: false,
        }
    }

    fn into_outcome(self) -> ReplayOutcome {
        self.outcome
    }

    /// Emit the currently-open `Show Text` window (if any) as a text event.
    fn flush_message(&mut self) {
        if self.message_open {
            let lines = std::mem::take(&mut self.pending_lines);
            let speaker = self.pending_speaker.take();
            self.outcome
                .events
                .push(ReplayEvent::Text { speaker, lines });
            self.message_open = false;
        }
    }

    fn diagnose(
        &mut self,
        code: i64,
        command_index: usize,
        reason: DiagnosticReason,
    ) -> Result<(), ReplayDiagnostic> {
        let diagnostic = ReplayDiagnostic {
            code,
            command_index,
            severity: reason.severity(),
            reason,
        };
        match self.policy {
            UnknownPolicy::Fail => Err(diagnostic),
            UnknownPolicy::SkipWithDiagnostic => {
                self.outcome.diagnostics.push(diagnostic);
                Ok(())
            }
        }
    }

    fn step(&mut self, command_index: usize, command: &Value) -> Result<(), ReplayDiagnostic> {
        let code = command.get("code").and_then(Value::as_i64).unwrap_or(-1);
        let params = command.get("parameters").and_then(Value::as_array);
        match code {
            // Show Text setup — open a new window; a preceding window flushes.
            101 => {
                self.flush_message();
                self.message_open = true;
                self.pending_speaker = params
                    .and_then(|p| p.get(4))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string);
                Ok(())
            }
            // Show Text body line — append to the open window.
            401 => {
                if let Some(text) = params.and_then(|p| p.first()).and_then(Value::as_str) {
                    if !self.message_open {
                        // A 401 with no preceding 101 is malformed input.
                        return self.diagnose(
                            code,
                            command_index,
                            DiagnosticReason::MalformedParameters {
                                code,
                                detail: "401 body line without a preceding 101 setup".to_string(),
                            },
                        );
                    }
                    self.pending_lines.push(text.to_string());
                }
                Ok(())
            }
            // Show Choices — flush any open window, then emit the choice.
            102 => {
                self.flush_message();
                let options = params
                    .and_then(|p| p.first())
                    .and_then(Value::as_array)
                    .map(|options| {
                        options
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToString::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                self.outcome.events.push(ReplayEvent::Choice { options });
                Ok(())
            }
            // Control Switches — [startId, endId, value] (0 = ON, 1 = OFF).
            121 => {
                self.flush_message();
                self.step_control_switches(code, command_index, params)
            }
            // Control Variables — [startId, endId, operation, operandType, ...].
            122 => {
                self.flush_message();
                self.step_control_variables(code, command_index, params)
            }
            // List terminator — structural no-op; flush any open window.
            0 => {
                self.flush_message();
                Ok(())
            }
            // Everything else is outside the narrow skeleton.
            other => {
                self.flush_message();
                self.diagnose(
                    other,
                    command_index,
                    DiagnosticReason::CommandOutsideSubset { code: other },
                )
            }
        }
    }

    fn step_control_switches(
        &mut self,
        code: i64,
        command_index: usize,
        params: Option<&Vec<Value>>,
    ) -> Result<(), ReplayDiagnostic> {
        let Some((start, end, raw_value)) = params.and_then(|p| {
            Some((
                p.first()?.as_i64()?,
                p.get(1)?.as_i64()?,
                p.get(2)?.as_i64()?,
            ))
        }) else {
            return self.diagnose(
                code,
                command_index,
                DiagnosticReason::MalformedParameters {
                    code,
                    detail: "expected [startId, endId, value]".to_string(),
                },
            );
        };
        // RPG Maker encodes ON as 0 and OFF as 1.
        let value = raw_value == 0;
        for switch_id in start..=end {
            self.outcome.state.set_switch(switch_id, value);
            self.outcome
                .events
                .push(ReplayEvent::SwitchChanged { switch_id, value });
        }
        Ok(())
    }

    fn step_control_variables(
        &mut self,
        code: i64,
        command_index: usize,
        params: Option<&Vec<Value>>,
    ) -> Result<(), ReplayDiagnostic> {
        let Some((start, end, operation, operand_type)) = params.and_then(|p| {
            Some((
                p.first()?.as_i64()?,
                p.get(1)?.as_i64()?,
                p.get(2)?.as_i64()?,
                p.get(3)?.as_i64()?,
            ))
        }) else {
            return self.diagnose(
                code,
                command_index,
                DiagnosticReason::MalformedParameters {
                    code,
                    detail: "expected [startId, endId, operation, operandType, ...]".to_string(),
                },
            );
        };
        // Resolve the operand for each target id. operandType 0 = constant
        // (p[4] literal), 1 = another variable (p[4] = source id, read live).
        let operand = match operand_type {
            0 => match params.and_then(|p| p.get(4)).and_then(Value::as_i64) {
                Some(constant) => Operand::Constant(constant),
                None => {
                    return self.diagnose(
                        code,
                        command_index,
                        DiagnosticReason::MalformedParameters {
                            code,
                            detail: "constant operand missing integer p[4]".to_string(),
                        },
                    );
                }
            },
            1 => match params.and_then(|p| p.get(4)).and_then(Value::as_i64) {
                Some(source_id) => Operand::Variable(source_id),
                None => {
                    return self.diagnose(
                        code,
                        command_index,
                        DiagnosticReason::MalformedParameters {
                            code,
                            detail: "variable operand missing integer p[4]".to_string(),
                        },
                    );
                }
            },
            other => {
                return self.diagnose(
                    code,
                    command_index,
                    DiagnosticReason::UnsupportedVariableOperand {
                        operand_type: other,
                    },
                );
            }
        };
        for variable_id in start..=end {
            let operand_value = match operand {
                Operand::Constant(value) => value,
                Operand::Variable(source_id) => self.outcome.state.variable(source_id),
            };
            let current = self.outcome.state.variable(variable_id);
            let Some(next) = apply_operation(operation, current, operand_value) else {
                return self.diagnose(
                    code,
                    command_index,
                    DiagnosticReason::UnsupportedVariableOperation { operation },
                );
            };
            self.outcome.state.set_variable(variable_id, next);
            self.outcome.events.push(ReplayEvent::VariableChanged {
                variable_id,
                value: next,
            });
        }
        Ok(())
    }
}

/// Resolved `Control Variables` operand.
#[derive(Clone, Copy)]
enum Operand {
    Constant(i64),
    Variable(i64),
}

/// Apply a `Control Variables` operation. Returns `None` for an operation code
/// the skeleton does not model. Division/modulo by zero yield the RPG Maker
/// runtime's behaviour of leaving the value unchanged (it guards against it).
fn apply_operation(operation: i64, current: i64, operand: i64) -> Option<i64> {
    let next = match operation {
        0 => operand,                         // set
        1 => current.saturating_add(operand), // add
        2 => current.saturating_sub(operand), // sub
        3 => current.saturating_mul(operand), // mul
        4 => {
            if operand == 0 {
                current
            } else {
                current / operand
            }
        } // div
        5 => {
            if operand == 0 {
                current
            } else {
                current % operand
            }
        } // mod
        _ => return None,
    };
    Some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replays_show_text_window_with_speaker() {
        let list = vec![
            json!({ "code": 101, "indent": 0, "parameters": ["face", 0, 0, 2, "Alice"] }),
            json!({ "code": 401, "indent": 0, "parameters": ["Hello there."] }),
            json!({ "code": 401, "indent": 0, "parameters": ["How are you?"] }),
            json!({ "code": 0, "indent": 0, "parameters": [] }),
        ];
        let outcome = replay_event_list(&list, UnknownPolicy::SkipWithDiagnostic).unwrap();
        assert_eq!(
            outcome.events,
            vec![ReplayEvent::Text {
                speaker: Some("Alice".to_string()),
                lines: vec!["Hello there.".to_string(), "How are you?".to_string()],
            }]
        );
        assert!(outcome.diagnostics.is_empty());
    }

    #[test]
    fn replays_choices() {
        let list = vec![json!({ "code": 102, "parameters": [["Yes", "No"], 1] })];
        let outcome = replay_event_list(&list, UnknownPolicy::SkipWithDiagnostic).unwrap();
        assert_eq!(
            outcome.events,
            vec![ReplayEvent::Choice {
                options: vec!["Yes".to_string(), "No".to_string()],
            }]
        );
    }

    #[test]
    fn threads_switch_and_variable_state() {
        let list = vec![
            json!({ "code": 121, "parameters": [1, 1, 0] }), // switch 1 ON
            json!({ "code": 122, "parameters": [10, 10, 0, 0, 5] }), // var 10 = 5
            json!({ "code": 122, "parameters": [10, 10, 1, 0, 3] }), // var 10 += 3 => 8
            json!({ "code": 122, "parameters": [11, 11, 0, 1, 10] }), // var 11 = var 10 => 8
        ];
        let outcome = replay_event_list(&list, UnknownPolicy::SkipWithDiagnostic).unwrap();
        assert!(outcome.state.switch(1));
        assert_eq!(outcome.state.variable(10), 8);
        assert_eq!(outcome.state.variable(11), 8);
        assert_eq!(
            outcome.events,
            vec![
                ReplayEvent::SwitchChanged {
                    switch_id: 1,
                    value: true
                },
                ReplayEvent::VariableChanged {
                    variable_id: 10,
                    value: 5
                },
                ReplayEvent::VariableChanged {
                    variable_id: 10,
                    value: 8
                },
                ReplayEvent::VariableChanged {
                    variable_id: 11,
                    value: 8
                },
            ]
        );
    }

    #[test]
    fn switch_range_and_off_value() {
        let list = vec![json!({ "code": 121, "parameters": [1, 3, 1] })]; // switches 1..=3 OFF
        let outcome = replay_event_list(&list, UnknownPolicy::SkipWithDiagnostic).unwrap();
        assert_eq!(outcome.events.len(), 3);
        assert!(!outcome.state.switch(2));
    }

    #[test]
    fn unknown_command_skips_with_semantic_diagnostic_not_silently() {
        // Code 355 (Script) is deliberately outside the narrow skeleton.
        let list = vec![
            json!({ "code": 121, "parameters": [1, 1, 0] }),
            json!({ "code": 355, "parameters": ["$gameSwitches.setValue(2, true)"] }),
            json!({ "code": 122, "parameters": [10, 10, 0, 0, 1] }),
        ];
        let outcome = replay_event_list(&list, UnknownPolicy::SkipWithDiagnostic).unwrap();
        // The unsupported command did NOT vanish silently: it is a diagnostic.
        assert_eq!(outcome.diagnostics.len(), 1);
        let diagnostic = &outcome.diagnostics[0];
        assert_eq!(diagnostic.code, 355);
        assert_eq!(diagnostic.command_index, 1);
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Unsupported);
        assert_eq!(
            diagnostic.reason,
            DiagnosticReason::CommandOutsideSubset { code: 355 }
        );
        // Replay continued: the surrounding subset commands still applied.
        assert!(outcome.state.switch(1));
        assert_eq!(outcome.state.variable(10), 1);
    }

    #[test]
    fn unknown_command_fail_policy_aborts_with_diagnostic() {
        let list = vec![
            json!({ "code": 121, "parameters": [1, 1, 0] }),
            json!({ "code": 999, "parameters": [] }),
        ];
        let error = replay_event_list(&list, UnknownPolicy::Fail).unwrap_err();
        assert_eq!(error.code, 999);
        assert_eq!(
            error.reason,
            DiagnosticReason::CommandOutsideSubset { code: 999 }
        );
    }

    #[test]
    fn unsupported_variable_operand_is_diagnosed_not_miscomputed() {
        // operandType 2 = random — outside the skeleton; must not silently
        // fabricate a value.
        let list = vec![json!({ "code": 122, "parameters": [10, 10, 0, 2, 1, 6] })];
        let outcome = replay_event_list(&list, UnknownPolicy::SkipWithDiagnostic).unwrap();
        assert_eq!(outcome.events.len(), 0);
        assert_eq!(outcome.diagnostics.len(), 1);
        assert_eq!(
            outcome.diagnostics[0].reason,
            DiagnosticReason::UnsupportedVariableOperand { operand_type: 2 }
        );
        // State untouched — no fabricated value.
        assert_eq!(outcome.state.variable(10), 0);
    }
}
