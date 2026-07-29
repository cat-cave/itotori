impl Vm {
    /// Resolve `(target_scene, entrypoint)` to a byte-offset pc.
    fn resolve_entrypoint(
        &self,
        scenes: &dyn SceneStore,
        target_scene: SceneId,
        entrypoint: u16,
    ) -> Result<u32, VmError> {
        let scene = scenes.fetch(target_scene).ok_or(VmError::SceneNotFound {
            scene: target_scene,
        })?;
        scene
            .entrypoint_pc(entrypoint)
            .ok_or(VmError::EntrypointNotFound {
                scene: target_scene,
                entrypoint,
            })
    }
    /// Apply a [`DispatchOutcome`] from a command-dispatch path. The
    /// `post_pc` argument is the byte offset immediately past the
    /// dispatching command — used by `Advance` / `Subroutine`
    /// `FarCall`.
    fn apply_outcome(&mut self, outcome: &DispatchOutcome, post_pc: u32) -> Result<(), VmError> {
        match outcome {
            DispatchOutcome::Advance => {
                self.pc = post_pc;
                Ok(())
            }
            DispatchOutcome::Jump { scene, pc } => {
                self.scene = *scene;
                self.pc = *pc;
                Ok(())
            }
            DispatchOutcome::JumpToScene { .. } | DispatchOutcome::FarCallToScene { .. } => {
                // These must be resolved into Jump / FarCall against the
                // scene store by `resolve_scene_outcome` before reaching
                // here. If one arrives (e.g. via the public
                // `apply_dispatch_outcome` test seam, which has no store)
                // refuse it rather than silently mis-transferring.
                Err(VmError::UnexpectedDispatchOutcome {
                    scene: self.scene,
                    pc: self.pc,
                    expected: "resolved_jump_or_farcall",
                    found: "unresolved_cross_scene_outcome",
                })
            }
            DispatchOutcome::Subroutine {
                return_pc,
                target_scene,
                target_pc,
            } => {
                if self.stack.len() >= STACK_DEPTH_LIMIT {
                    return Err(VmError::StackOverflow {
                        scene: self.scene,
                        pc: self.pc,
                        limit: STACK_DEPTH_LIMIT,
                        kind: StackFrameKind::Subroutine.as_str(),
                    });
                }
                self.stack.push(StackFrame {
                    return_scene: None,
                    return_pc: *return_pc,
                    frame_kind: StackFrameKind::Subroutine,
                });
                self.scene = *target_scene;
                self.pc = *target_pc;
                Ok(())
            }
            DispatchOutcome::FarCall {
                return_scene,
                return_pc,
                target_scene,
                target_pc,
            } => {
                if self.stack.len() >= STACK_DEPTH_LIMIT {
                    return Err(VmError::StackOverflow {
                        scene: self.scene,
                        pc: self.pc,
                        limit: STACK_DEPTH_LIMIT,
                        kind: StackFrameKind::FarCall.as_str(),
                    });
                }
                self.stack.push(StackFrame {
                    return_scene: Some(*return_scene),
                    return_pc: *return_pc,
                    frame_kind: StackFrameKind::FarCall,
                });
                self.scene = *target_scene;
                self.pc = *target_pc;
                Ok(())
            }
            DispatchOutcome::Return => {
                let frame = self.stack.pop().ok_or(VmError::EmptyStack {
                    scene: self.scene,
                    pc: self.pc,
                    expected: "subroutine",
                })?;
                if frame.frame_kind != StackFrameKind::Subroutine {
                    return Err(VmError::FrameKindMismatch {
                        scene: self.scene,
                        pc: self.pc,
                        expected: "subroutine",
                        found: frame.frame_kind.as_str(),
                    });
                }
                self.pc = frame.return_pc;
                // Subroutine frames do not change scene.
                Ok(())
            }
            DispatchOutcome::ReturnFromCall => {
                let frame = self.stack.pop().ok_or(VmError::EmptyStack {
                    scene: self.scene,
                    pc: self.pc,
                    expected: "far_call",
                })?;
                if frame.frame_kind != StackFrameKind::FarCall {
                    return Err(VmError::FrameKindMismatch {
                        scene: self.scene,
                        pc: self.pc,
                        expected: "far_call",
                        found: frame.frame_kind.as_str(),
                    });
                }
                let return_scene = frame.return_scene.ok_or(VmError::FrameKindMismatch {
                    scene: self.scene,
                    pc: self.pc,
                    expected: "far_call_with_return_scene",
                    found: "far_call_without_return_scene",
                })?;
                self.scene = return_scene;
                self.pc = frame.return_pc;
                Ok(())
            }
            DispatchOutcome::Yield {
                longop_id,
                private_state,
            } => {
                self.longop_queue
                    .push_back(LongOp::new(*longop_id, private_state.clone()));
                self.pc = post_pc;
                Ok(())
            }
            DispatchOutcome::Halt => {
                self.halted = true;
                // pc stays put so the caller can inspect the halt site.
                Ok(())
            }
        }
    }

    /// Public helper for tests + per-module RLOperation tables that want
    /// to enqueue a longop directly. Centralised so the snapshot round
    /// trip uses the same code path as the dispatch loop.
    pub fn enqueue_longop(&mut self, longop: LongOp) {
        self.longop_queue.push_back(longop);
    }
}
