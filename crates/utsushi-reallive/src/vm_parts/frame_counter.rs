impl Vm {
    /// Decode the grouped tuple arguments of `sys.InitFrames` and
    /// `sys.ReadFrames`.  Other complex command arguments retain their
    /// established opaque treatment; only these two byte-proven opcodes need
    /// recursive tuple structure and writable references.
    fn decode_frame_command_args(&mut self, raw_bytes: &[u8]) -> Vec<ExprValue> {
        let arg_slices = match decode_command_arg_values(raw_bytes) {
            Ok(slices) => slices,
            Err(err) => {
                self.push_warning(VmWarning::ExpressionFailure {
                    scene: self.scene,
                    pc: self.pc,
                    reason: err.to_string(),
                });
                return Vec::new();
            }
        };
        arg_slices
            .into_iter()
            .map(|arg| self.decode_frame_argument(arg))
            .collect::<Result<Vec<_>, _>>()
            .unwrap_or_else(|err| {
                self.push_warning(VmWarning::ExpressionFailure {
                    scene: self.scene,
                    pc: self.pc,
                    reason: err,
                });
                Vec::new()
            })
    }

    fn decode_frame_argument(
        &mut self,
        arg: crate::bytecode_element::CommandArg,
    ) -> Result<ExprValue, String> {
        match arg.shape {
            CommandArgShape::Expression => {
                let parsed =
                    parse_expression_with_warnings(&arg.bytes).map_err(|err| err.to_string())?;
                self.record_expression_warnings(&parsed.warnings);
                self.decode_command_expr_value(&parsed.node)
                    .map_err(|err| err.to_string())
            }
            CommandArgShape::Complex if arg.bytes.first() == Some(&b'(') => {
                let values =
                    crate::bytecode_element::decode_parenthesized_command_arg_values(&arg.bytes)
                        .map_err(|err| err.to_string())?
                        .into_iter()
                        .map(|nested| self.decode_frame_argument(nested))
                        .collect::<Result<Vec<_>, _>>()?;
                Ok(ExprValue::List(values))
            }
            CommandArgShape::String | CommandArgShape::Complex => Ok(ExprValue::Bytes(arg.bytes)),
        }
    }

    pub(crate) fn init_frame_counter(
        &mut self,
        counter: i32,
        min: i32,
        max: i32,
        duration_ms: i32,
    ) {
        // `FrameCounter` starts at `frame_min`; only a zero duration is
        // complete at construction.  A same-endpoint nonzero counter is
        // retired by its first read, matching rlvm's `CheckIfFinished`.
        let completed = duration_ms == 0;
        self.frame_counters.insert(
            counter,
            FrameCounterState {
                min,
                max,
                duration_ms: duration_ms.max(0) as u32,
                elapsed_ms: 0,
                active: !completed,
            },
        );
    }

    /// Read a frame value at the current deterministic logical instant.
    /// The value uses rlvm's linear `SimpleFrameCounter` interpolation and
    /// its truncating integer result.
    pub(crate) fn read_frame_counter(&mut self, counter: i32) -> Option<(i32, bool)> {
        let frame = self.frame_counters.get_mut(&counter)?;
        if !frame.active {
            return Some((frame.max, false));
        }
        if frame.min == frame.max || frame.elapsed_ms >= frame.duration_ms {
            frame.active = false;
            return Some((frame.max, false));
        }
        let distance = i64::from(frame.max) - i64::from(frame.min);
        let value = i64::from(frame.min)
            + distance * i64::from(frame.elapsed_ms) / i64::from(frame.duration_ms);
        Some((value as i32, true))
    }

    /// Advance the deterministic event-clock after one complete
    /// `ReadFrames` multi-dispatch.  Advancing afterwards is significant:
    /// `InitFrames; ReadFrames` sees the same initial value rlvm sees at its
    /// construction tick.
    pub(crate) fn advance_frame_clock(&mut self) {
        for frame in self.frame_counters.values_mut() {
            if frame.active {
                frame.elapsed_ms = frame.elapsed_ms.saturating_add(1);
            }
        }
    }
}
