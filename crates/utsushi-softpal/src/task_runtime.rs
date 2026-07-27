//! Native task callback routing recovered from the engine's task layer.
//!
//! A native task call supplies four VM-stack words.  The first two address a
//! `16 × 128` callback table; the remaining words are callback payload.  The
//! router does not move the script instruction pointer: it only dispatches the
//! registered callback and reports its explicit outcome.

/// Number of native task groups accepted by the router.
pub const TASK_GROUP_COUNT: usize = 16;
/// Number of native task slots in each group.
pub const TASK_SLOT_COUNT: usize = 128;

/// Four native values consumed by a task-router call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeTaskCall {
    /// Task-table group, bounded to `0..16` exclusively.
    pub group: i32,
    /// Task-table slot, bounded to `0..128` exclusively.
    pub slot: i32,
    /// First opaque callback value.
    pub value0: i32,
    /// Second opaque callback value.
    pub value1: i32,
}

/// Mutable state retained by one registered native task.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NativeTask {
    /// Engine-visible task state.
    pub state: i32,
    /// Engine-visible message value.
    pub message: i32,
    /// Engine-visible task data value.
    pub data: i32,
}

/// Result returned by a registered native task callback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskCallbackOutcome {
    /// Callback completed; the script VM continues at its next instruction.
    Completed,
    /// Callback intentionally rejects the call with a stable diagnostic.
    Rejected(&'static str),
}

/// Native callback ABI represented without a host-binary dependency.
pub type TaskCallback = fn(&mut NativeTask, NativeTaskCall) -> TaskCallbackOutcome;

#[derive(Clone, Copy)]
struct RegisteredTask {
    task: NativeTask,
    callback: TaskCallback,
}

impl std::fmt::Debug for RegisteredTask {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RegisteredTask")
            .field("task", &self.task)
            .finish_non_exhaustive()
    }
}

/// Observable result of routing one native task call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskDispatchOutcome {
    /// A callback ran and returned its explicit outcome.
    Callback(TaskCallbackOutcome),
    /// The group was not in the engine's fixed `0..15` range.
    GroupOutOfRange,
    /// The slot was not in the engine's fixed `0..127` range.
    SlotOutOfRange,
    /// The bounded task address has no registered callback.
    MissingCallback,
}

/// Failure before the router can select a task callback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskDispatchError {
    /// The native producer supplied fewer than the four required values.
    OperandUnderflow,
}

/// The native task table and the operand stack feeding its router.
#[derive(Debug)]
pub struct TaskRuntime {
    table: Vec<Option<RegisteredTask>>,
    operands: Vec<i32>,
}

impl Default for TaskRuntime {
    fn default() -> Self {
        Self {
            table: vec![None; TASK_GROUP_COUNT * TASK_SLOT_COUNT],
            operands: Vec::new(),
        }
    }
}

impl TaskRuntime {
    /// Register (or replace) one bounded task callback.
    pub fn register(
        &mut self,
        group: usize,
        slot: usize,
        task: NativeTask,
        callback: TaskCallback,
    ) -> Result<(), TaskDispatchOutcome> {
        let index = Self::index(group as i32, slot as i32)?;
        self.table[index] = Some(RegisteredTask { task, callback });
        Ok(())
    }

    /// Snapshot one bounded task's persistent state.
    #[must_use]
    pub fn task(&self, group: usize, slot: usize) -> Option<NativeTask> {
        let index = Self::index(group as i32, slot as i32).ok()?;
        self.table[index].as_ref().map(|entry| entry.task)
    }

    /// Push a value produced by a proven native operand producer.
    pub fn push_operand(&mut self, value: i32) {
        self.operands.push(value);
    }

    /// Number of native operands awaiting a router call.
    #[must_use]
    pub fn operand_len(&self) -> usize {
        self.operands.len()
    }

    /// Consume four native operands and route the callback they address.
    ///
    /// The producer order is retained as the callback's four fields.  Fewer
    /// than four values is an explicit caller error and leaves the stack intact.
    pub fn dispatch_from_operands(&mut self) -> Result<TaskDispatchOutcome, TaskDispatchError> {
        let start = self
            .operands
            .len()
            .checked_sub(4)
            .ok_or(TaskDispatchError::OperandUnderflow)?;
        let values: [i32; 4] = self.operands[start..]
            .try_into()
            .expect("four values selected from the operand stack");
        self.operands.truncate(start);
        Ok(self.dispatch(NativeTaskCall {
            group: values[0],
            slot: values[1],
            value0: values[2],
            value1: values[3],
        }))
    }

    /// Route the engine task call into the VM's explicit-halt convention.
    pub(crate) fn dispatch_for_vm(&mut self) -> Result<(), &'static str> {
        match self.dispatch_from_operands() {
            Err(TaskDispatchError::OperandUnderflow) => Err("native_task_operand_underflow"),
            Ok(TaskDispatchOutcome::Callback(TaskCallbackOutcome::Completed)) => Ok(()),
            Ok(TaskDispatchOutcome::Callback(TaskCallbackOutcome::Rejected(reason))) => Err(reason),
            Ok(outcome) => Err(task_diagnostic(outcome)),
        }
    }

    /// Route a decoded four-value native task call.
    #[must_use]
    pub fn dispatch(&mut self, call: NativeTaskCall) -> TaskDispatchOutcome {
        let Ok(index) = Self::index(call.group, call.slot) else {
            return match Self::index(call.group, 0) {
                Err(TaskDispatchOutcome::GroupOutOfRange) => TaskDispatchOutcome::GroupOutOfRange,
                _ => TaskDispatchOutcome::SlotOutOfRange,
            };
        };
        let Some(entry) = self.table[index].as_mut() else {
            return TaskDispatchOutcome::MissingCallback;
        };
        TaskDispatchOutcome::Callback((entry.callback)(&mut entry.task, call))
    }

    fn index(group: i32, slot: i32) -> Result<usize, TaskDispatchOutcome> {
        let group = usize::try_from(group).map_err(|_| TaskDispatchOutcome::GroupOutOfRange)?;
        let slot = usize::try_from(slot).map_err(|_| TaskDispatchOutcome::SlotOutOfRange)?;
        if group >= TASK_GROUP_COUNT {
            return Err(TaskDispatchOutcome::GroupOutOfRange);
        }
        if slot >= TASK_SLOT_COUNT {
            return Err(TaskDispatchOutcome::SlotOutOfRange);
        }
        Ok(group * TASK_SLOT_COUNT + slot)
    }
}

fn task_diagnostic(outcome: TaskDispatchOutcome) -> &'static str {
    match outcome {
        TaskDispatchOutcome::Callback(_) => "native_task_callback_rejected",
        TaskDispatchOutcome::GroupOutOfRange => "native_task_group_out_of_range",
        TaskDispatchOutcome::SlotOutOfRange => "native_task_slot_out_of_range",
        TaskDispatchOutcome::MissingCallback => "native_task_callback_missing",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn retain_payload(task: &mut NativeTask, call: NativeTaskCall) -> TaskCallbackOutcome {
        task.state = call.value0;
        task.message = call.value1;
        task.data = call.group * 1_000 + call.slot;
        TaskCallbackOutcome::Completed
    }

    #[test]
    fn routes_four_native_values_to_the_bounded_registered_callback() {
        let mut runtime = TaskRuntime::default();
        runtime
            .register(15, 127, NativeTask::default(), retain_payload)
            .expect("last valid address registers");
        for value in [15, 127, 23, 47] {
            runtime.push_operand(value);
        }

        assert_eq!(
            runtime.dispatch_from_operands(),
            Ok(TaskDispatchOutcome::Callback(
                TaskCallbackOutcome::Completed
            ))
        );
        assert_eq!(
            runtime.operand_len(),
            0,
            "router consumed exactly four values"
        );
        assert_eq!(
            runtime.task(15, 127),
            Some(NativeTask {
                state: 23,
                message: 47,
                data: 15_127,
            }),
            "the registered callback received the two payload words"
        );
        let outcome = runtime.dispatch(NativeTaskCall {
            group: 15,
            slot: 127,
            value0: 0,
            value1: 0,
        });
        assert_eq!(
            outcome,
            TaskDispatchOutcome::Callback(TaskCallbackOutcome::Completed)
        );
    }

    #[test]
    fn rejects_out_of_range_addresses_and_preserves_short_operand_stacks() {
        let mut runtime = TaskRuntime::default();
        runtime.push_operand(1);
        assert_eq!(
            runtime.dispatch_from_operands(),
            Err(TaskDispatchError::OperandUnderflow)
        );
        assert_eq!(runtime.operand_len(), 1);
        assert_eq!(
            runtime.dispatch(NativeTaskCall {
                group: 16,
                slot: 0,
                value0: 0,
                value1: 0,
            }),
            TaskDispatchOutcome::GroupOutOfRange
        );
        assert_eq!(
            runtime.dispatch(NativeTaskCall {
                group: 0,
                slot: 128,
                value0: 0,
                value1: 0,
            }),
            TaskDispatchOutcome::SlotOutOfRange
        );
    }
}
