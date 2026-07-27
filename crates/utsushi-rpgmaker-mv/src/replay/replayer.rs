//! Command execution for the replay skeleton.

use serde_json::Value;

use super::{DiagnosticReason, ReplayDiagnostic, ReplayEvent, ReplayOutcome, UnknownPolicy};

/// Replay one event-command `list[]` (a JSON array of `{code, indent
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
            // Control Variables — [startId, endId, operation, operandType,...].
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
