impl Vm {
    /// Dispatch a fetched element. Centralised so [`Vm::step`] stays
    /// focused on the fetch / queue / pc-arithmetic loop. The `post_pc`
    /// argument is the byte offset that follows the element — used by
    /// the `Advance` and `Subroutine` / `FarCall` paths.
    fn dispatch_element(
        &mut self,
        scenes: &dyn SceneStore,
        element: BytecodeElement,
        post_pc: u32,
        registry: &RlopRegistry,
    ) -> Result<VmEvent, VmError> {
        match element {
            BytecodeElement::MetaLine { .. } => {
                self.pc = post_pc;
                Ok(VmEvent::Advanced {
                    element: "meta_line",
                })
            }
            BytecodeElement::MetaEntrypoint { .. } => {
                self.pc = post_pc;
                Ok(VmEvent::Advanced {
                    element: "meta_entrypoint",
                })
            }
            BytecodeElement::MetaKidoku { .. } => {
                self.pc = post_pc;
                Ok(VmEvent::Advanced {
                    element: "meta_kidoku",
                })
            }
            BytecodeElement::Comma { .. } => {
                self.pc = post_pc;
                Ok(VmEvent::Advanced { element: "comma" })
            }
            BytecodeElement::Textout { raw_bytes, .. } => {
                self.pc = post_pc;
                Ok(VmEvent::Textout { raw_bytes })
            }
            BytecodeElement::SelectionOption { marker, .. } => {
                self.warnings
                    .push(VmWarning::SelectionRuntimeUnimplemented {
                        marker,
                        scene: self.scene,
                        pc: self.pc,
                    });
                self.pc = post_pc;
                Ok(VmEvent::SelectionOption { marker })
            }
            BytecodeElement::Expression { raw_bytes, .. } => {
                let event = self.dispatch_expression(&raw_bytes);
                self.pc = post_pc;
                Ok(event)
            }
            BytecodeElement::Command {
                module_type,
                module_id,
                opcode,
                overload,
                raw_bytes,
                goto_targets,
                goto_case_exprs,
                ..
            } => {
                let key = RlopKey::with_overload(module_type, module_id, opcode, overload);
                if let Some((op, provenance)) = registry.resolve(key) {
                    // Decode the element's own argument list and
                    // dispatch with the REAL values. Previously this
                    // passed `&[]`, so every argument-taking op — all
                    // control-flow ops (goto / farcall / …) included —
                    // saw an empty slice and took its warn-and-advance
                    // path, making jumps dead in the integration path.
                    //
                    // The goto-family jump-target pointers live OUTSIDE
                    // the `(...)` argument list (the decoder framed them
                    // as trailing `i32`s). Append them as trailing `Int`
                    // args so a control-flow op sees `[cond?.., target..]`
                    // — the layout `GotoOp` / `GotoIfOp` / `GotoOnOp`
                    // expect. Non-goto commands carry no targets, so this
                    // is a no-op for them.
                    let mut args = if module_id == crate::rlop::module_sys::SYS_MODULE_ID
                        && matches!(opcode, 600 | 610)
                    {
                        self.decode_frame_command_args(&raw_bytes)
                    } else if module_type == crate::rlop::SEL_MODULE_TYPE
                        && module_id == crate::rlop::SEL_MODULE_ID
                    {
                        // Text `select` / `select_s` / `select_w` carry option
                        // labels in the trailing `{... }` SelectElement block.
                        // Object-button ops (`select_objbtn` / cancel / setup)
                        // carry their payload in the `(...)` arg list instead
                        // (e.g. `select_objbtn(group)`) with no option block —
                        // fall back to normal command-arg decoding so the group
                        // id reaches the op. See
                        // [`crate::bytecode_element::extract_select_choice_texts`].
                        let choice_texts = extract_select_choice_texts(&raw_bytes);
                        if choice_texts.is_empty() {
                            self.decode_command_args(&raw_bytes)
                        } else {
                            choice_texts.into_iter().map(ExprValue::Bytes).collect()
                        }
                    } else {
                        self.decode_command_args(&raw_bytes)
                    };
                    if goto_case_exprs.is_empty() {
                        for target in &goto_targets {
                            args.push(ExprValue::Int(i32::from_ne_bytes(target.to_ne_bytes())));
                        }
                    } else {
                        // `goto_case` / `gosub_case`: the decoded `(disc)`
                        // list left the discriminant in `args[0]`. Evaluate
                        // each case's match EXPRESSION against it (in real VM
                        // memory context) and pre-resolve the matched target
                        // reproducing the exact `value == case_i` selection.
                        // The op receives the single resolved target (or an
                        // empty arg list ⇒ no case matched and no default `()`
                        // case, so control falls through).
                        let discriminant = args.first().and_then(ExprValue::as_int);
                        let selected = self.select_goto_case_target(
                            discriminant,
                            &goto_targets,
                            &goto_case_exprs,
                        );
                        args.clear();
                        if let Some(target) = selected {
                            args.push(ExprValue::Int(i32::from_ne_bytes(target.to_ne_bytes())));
                        }
                    }
                    // Expose the post-command pc so branch-following
                    // `gosub` / `farcall` ops can read the return pc they
                    // must push, without the VM prepending a synthetic arg.
                    self.post_pc = post_pc;
                    let outcome = op.dispatch(self, &args);
                    self.post_pc = 0;
                    // Deterministic spin-break / event model: if the
                    // branch-following driver armed a one-shot suppression
                    // (it PROVED the walk is re-entering an identical
                    // `(scene, pc, stack, memory)` state — a deterministic
                    // infinite loop) and THIS command is a pc-moving
                    // control transfer (a backward `goto` closing the poll
                    // loop, or a computed `farcall`/`gosub` into an event
                    // subsystem), rewrite it to a fall-through. This models
                    // the polled event having fired: the poll takes its
                    // exit edge instead of looping. `ret` / `rtl` unwinds
                    // are never rewritten (that would corrupt the stack).
                    let outcome =
                        if self.suppress_next_transfer && outcome_is_pc_moving_transfer(&outcome) {
                            self.suppress_next_transfer = false;
                            self.last_transfer_suppressed = true;
                            DispatchOutcome::Advance
                        } else {
                            outcome
                        };
                    // Cross-scene outcomes address a target by
                    // `(scene, entrypoint)`; resolve the entrypoint to a
                    // concrete pc against the store (which the op layer
                    // cannot see) before applying. The resolved outcome is
                    // what the VmEvent reports, so downstream sees the real
                    // scene/pc transfer.
                    let resolved = self.resolve_scene_outcome(scenes, &outcome, post_pc)?;
                    self.apply_outcome(&resolved, post_pc)?;
                    Ok(VmEvent::CommandDispatched {
                        key,
                        provenance: Some(provenance),
                        outcome: resolved,
                    })
                } else {
                    self.warnings.push(VmWarning::MissingRlop {
                        key,
                        scene: self.scene,
                        pc: self.pc,
                    });
                    self.pc = post_pc;
                    Ok(VmEvent::CommandDispatched {
                        key,
                        provenance: None,
                        outcome: DispatchOutcome::Advance,
                    })
                }
            }
        }
    }

    /// Decode command values into the [`ExprValue`] slice each RLOp receives.
    ///
    /// Decoding is fail-soft to match the surrounding dispatch loop: a
    /// value that fails to parse / evaluate surfaces a typed
    /// [`VmWarning::ExpressionFailure`] and decoding stops, so the op
    /// observes the prefix it could decode and applies its own typed
    /// arity / variant check rather than panicking. The element already
    /// length-walked successfully at decode time, so a hard structural
    /// error here is unreachable on real scenes; if it ever occurs it is
    /// surfaced as a warning and an empty arg list, never a panic.
    fn decode_command_args(&mut self, raw_bytes: &[u8]) -> Vec<ExprValue> {
        let arg_slices = match decode_command_arg_values(raw_bytes) {
            Ok(slices) => slices,
            Err(err) => {
                self.warnings.push(VmWarning::ExpressionFailure {
                    scene: self.scene,
                    pc: self.pc,
                    reason: err.to_string(),
                });
                return Vec::new();
            }
        };
        let mut values = Vec::with_capacity(arg_slices.len());
        for arg in arg_slices {
            match arg.shape {
                CommandArgShape::Expression => match parse_expression_with_warnings(&arg.bytes) {
                    Ok(parsed) => {
                        self.record_expression_warnings(&parsed.warnings);
                        match self.decode_command_expr_value(&parsed.node) {
                            Ok(value) => {
                                values.push(value);
                            }
                            Err(err) => {
                                self.warnings.push(VmWarning::ExpressionFailure {
                                    scene: self.scene,
                                    pc: self.pc,
                                    reason: err.to_string(),
                                });
                                break;
                            }
                        }
                    }
                    Err(err) => {
                        self.warnings.push(VmWarning::ExpressionFailure {
                            scene: self.scene,
                            pc: self.pc,
                            reason: err.to_string(),
                        });
                        break;
                    }
                },
                CommandArgShape::Complex if arg.bytes.first() == Some(&b'(') => {
                    values.push(self.decode_parenthesized_command_arg(arg.bytes));
                }
                CommandArgShape::String | CommandArgShape::Complex => {
                    values.push(ExprValue::Bytes(arg.bytes));
                }
            }
        }
        values
    }

    /// Select the matched `goto_case` / `gosub_case` jump target by
    /// evaluating each case's match expression against the discriminant.
    ///
    /// Faithful to rlvm `GotoCaseElement`: the cases are checked in order;
    /// a non-empty case `(expr)` matches when `eval(expr) == discriminant`
    /// and the default case (the empty `()`, recorded as an empty
    /// expression) matches unconditionally. Returns the absolute target pc
    /// of the first matching case, or `None` when no case matches and no
    /// default `()` case is present (control falls through past the block).
    ///
    /// Case expressions are evaluated read-only against the current memory
    /// banks (no store-register side effect), so probing the cases never
    /// perturbs VM state. Recover-path parse warnings are folded into
    /// [`VmWarning::ExpressionFailure`] via [`Self::record_expression_warnings`]
    /// so unknown-operator recovery is not silent here either.
    fn select_goto_case_target(
        &mut self,
        discriminant: Option<i32>,
        targets: &[u32],
        cases: &[Vec<u8>],
    ) -> Option<u32> {
        let discriminant = discriminant?;
        for (index, case) in cases.iter().enumerate() {
            let matched = if case.is_empty() {
                // The default `()` case matches any discriminant.
                true
            } else {
                match parse_expression_with_warnings(case) {
                    Ok(parsed) => {
                        self.record_expression_warnings(&parsed.warnings);
                        evaluate(&parsed.node, &self.banks).is_ok_and(|value| value == discriminant)
                    }
                    // A case whose bytes do not parse as an expression
                    // cannot match; skip it rather than fail the drive.
                    Err(_) => false,
                }
            };
            if matched {
                return targets.get(index).copied();
            }
        }
        None
    }

    /// Evaluate the supplied expression element raw bytes and surface a
    /// typed event. Failures are recorded as fail-soft warnings — the
    /// VM still advances past the expression element. Uses the
    /// recover-path parser so unknown operators warn + partial-eval
    /// rather than hard-fail (the decompile path is fail-closed).
    fn dispatch_expression(&mut self, raw_bytes: &[u8]) -> VmEvent {
        match parse_expression_with_warnings(raw_bytes) {
            Ok(parsed) => {
                self.record_expression_warnings(&parsed.warnings);
                match self.eval_expression_node(&parsed.node) {
                    Ok((is_assignment, value)) => VmEvent::ExpressionEvaluated {
                        is_assignment,
                        value,
                    },
                    Err(err) => {
                        self.warnings.push(VmWarning::ExpressionFailure {
                            scene: self.scene,
                            pc: self.pc,
                            reason: err.to_string(),
                        });
                        VmEvent::ExpressionEvaluated {
                            is_assignment: false,
                            value: 0,
                        }
                    }
                }
            }
            Err(err) => {
                self.warnings.push(VmWarning::ExpressionFailure {
                    scene: self.scene,
                    pc: self.pc,
                    reason: err.to_string(),
                });
                VmEvent::ExpressionEvaluated {
                    is_assignment: false,
                    value: 0,
                }
            }
        }
    }

    /// Fold parser recover-path warnings into the VM warning stream.
    ///
    /// Call sites: standalone expression-element dispatch
    /// ([`Self::dispatch_expression`]), command-arg decoding
    /// ([`Self::decode_command_args`]), and `goto_case` / `gosub_case`
    /// case matching ([`Self::select_goto_case_target`]). Together these
    /// cover every recover-path parse the integration VM performs, so
    /// unknown-operator recovery is not silent on the emulator path.
    fn record_expression_warnings(&mut self, warnings: &[ExpressionWarning]) {
        for warning in warnings {
            let reason = match warning {
                ExpressionWarning::UnknownOperator { byte, offset } => format!(
                    "{}: byte=0x{byte:02x} offset={offset}",
                    ExpressionWarning::AUDIT_CODE_UNKNOWN_OPERATOR
                ),
            };
            self.warnings.push(VmWarning::ExpressionFailure {
                scene: self.scene,
                pc: self.pc,
                reason,
            });
        }
    }

    /// Reduce the parsed [`ExprNode`] either through
    /// `evaluate_assignment` (when the top-level node is an
    /// assignment) or `evaluate` (when it is not). Returns
    /// `(is_assignment, value)`.
    fn eval_expression_node(
        &mut self,
        node: &ExprNode,
    ) -> Result<(bool, i32), ExpressionWrapError> {
        if let ExprNode::Assignment { .. } = node {
            let value =
                evaluate_assignment(node, &mut self.banks).map_err(ExpressionWrapError::Eval)?;
            Ok((true, value))
        } else {
            let value = evaluate(node, &self.banks).map_err(ExpressionWrapError::Eval)?;
            // Plain-expression result lands in the store register
            // per the §H VM-dispatch documentation — the store
            // register is the engine's "expression-result holder"
            // between command boundaries.
            self.banks.set_store(value as u32);
            Ok((false, value))
        }
    }

    /// Rewrite a cross-scene [`DispatchOutcome::JumpToScene`]
    /// [`DispatchOutcome::FarCallToScene`] into a concrete
    /// [`DispatchOutcome::Jump`] / [`DispatchOutcome::FarCall`] by
    /// resolving the target scene's entrypoint against `scenes`. Every
    /// other outcome passes through unchanged.
    ///
    /// A target scene absent from the store surfaces
    /// [`VmError::SceneNotFound`]; a non-zero entrypoint the target scene
    /// does not declare surfaces [`VmError::EntrypointNotFound`]. Neither
    /// is masked with a fail-soft advance — a cross-scene gap is a real
    /// gap.
    ///
    /// # System-return sentinels
    ///
    /// Two cross-scene targets are RealLive control-flow SENTINELS rather
    /// than real content scenes, and resolve to a deterministic
    /// FALL-THROUGH (`Advance` to `post_pc`) instead of a transfer or a
    /// spurious `SceneNotFound` / `EntrypointNotFound`:
    ///
    /// - **The null scene (`scene 0`)** — RealLive scene ids are 1-based
    ///   so scene `0` is the "no scene" sentinel. A `farcall(0, …)`
    ///   `jump(0)` is the game's own guarded "nothing to call" path (Kanon
    ///   emits `farcall(0, 10)`); the engine takes no transfer. This is
    ///   the "absent-but-guarded" case: the guard is intrinsic (the target
    ///   is null), so the path is not taken at runtime.
    /// - **The scenario-return entrypoint (`entrypoint 99`)** — entrypoint
    ///   `99` is the last slot of the 100-slot entrypoint lattice and is
    ///   reserved as the "return to title / scenario complete" marker. A
    ///   present system scene (the observed corpus's SEEN9999, which declares real
    ///   entrypoints `0..=15`) is entered at `99` only as this end idiom;
    ///   the headless model treats it as a fall-through so the scene runs
    ///   its real control flow to a natural terminus.
    ///
    /// Any OTHER absent scene (a real content scene missing from the
    /// store) or out-of-range entrypoint is a GENUINE gap and still
    /// surfaces the typed `SceneNotFound` / `EntrypointNotFound`.
    fn resolve_scene_outcome(
        &self,
        scenes: &dyn SceneStore,
        outcome: &DispatchOutcome,
        post_pc: u32,
    ) -> Result<DispatchOutcome, VmError> {
        // System-return sentinels short-circuit to a fall-through before
        // any store lookup — the transfer is not taken at runtime.
        if let DispatchOutcome::JumpToScene {
            target_scene,
            entrypoint,
        }
        | DispatchOutcome::FarCallToScene {
            target_scene,
            entrypoint,
        } = outcome
            && is_system_return_sentinel(*target_scene, *entrypoint)
        {
            return Ok(DispatchOutcome::Advance);
        }
        match outcome {
            DispatchOutcome::JumpToScene {
                target_scene,
                entrypoint,
            } => {
                let pc = self.resolve_entrypoint(scenes, *target_scene, *entrypoint)?;
                Ok(DispatchOutcome::Jump {
                    scene: *target_scene,
                    pc,
                })
            }
            DispatchOutcome::FarCallToScene {
                target_scene,
                entrypoint,
            } => {
                let pc = self.resolve_entrypoint(scenes, *target_scene, *entrypoint)?;
                Ok(DispatchOutcome::FarCall {
                    return_scene: self.scene,
                    return_pc: post_pc,
                    target_scene: *target_scene,
                    target_pc: pc,
                })
            }
            other => Ok(other.clone()),
        }
    }

}
