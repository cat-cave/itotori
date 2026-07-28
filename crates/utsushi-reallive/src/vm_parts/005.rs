/// The null-scene sentinel: RealLive scene ids are 1-based, so scene `0`
/// is "no scene". A cross-scene transfer to it is the game's own guarded
/// "nothing to call" path and takes no transfer at runtime.
pub const NULL_SCENE_SENTINEL: SceneId = 0;

/// The scenario-return entrypoint sentinel: entrypoint `99` is the last
/// slot of the 100-slot entrypoint lattice, reserved as the "return to
/// title / scenario complete" marker. A cross-scene transfer THROUGH it
/// is the end-of-scenario idiom, not a real entrypoint call.
pub const SCENARIO_RETURN_ENTRYPOINT: u16 = 99;

/// Whether a cross-scene `(target_scene, entrypoint)` is a RealLive
/// system-return SENTINEL (the null scene, or the scenario-return
/// entrypoint) rather than a real content target. Sentinels resolve to a
/// deterministic fall-through in [`Vm::resolve_scene_outcome`]; every
/// other absent scene / out-of-range entrypoint remains a typed gap.
fn is_system_return_sentinel(target_scene: SceneId, entrypoint: u16) -> bool {
    target_scene == NULL_SCENE_SENTINEL || entrypoint == SCENARIO_RETURN_ENTRYPOINT
}
/// Whether a [`DispatchOutcome`] moves the pc OFF the natural
/// fall-through by transferring control (an intra- or cross-scene jump
/// a `gosub`, or a `farcall`) — the outcomes the deterministic
/// spin-break model may rewrite to a fall-through.
///
/// Stack-UNWINDING outcomes (`Return` / `ReturnFromCall`) are excluded:
/// rewriting a `ret` into a fall-through would leave an orphaned frame
/// on the stack and desynchronise the call depth. `Advance` / `Yield`
/// `Halt` are not transfers.
fn outcome_is_pc_moving_transfer(outcome: &DispatchOutcome) -> bool {
    matches!(
        outcome,
        DispatchOutcome::Jump { .. }
            | DispatchOutcome::Subroutine { .. }
            | DispatchOutcome::FarCall { .. }
            | DispatchOutcome::JumpToScene { .. }
            | DispatchOutcome::FarCallToScene { .. }
    )
}

/// Internal wrapper around an `EvaluationError` so the dispatch path
/// can use `?` ergonomically. The conversion is one-way (eval-error
/// only) so the dispatch path cannot accidentally bubble a
/// `VmError::BytecodeDecode` through here.
#[derive(Debug)]
enum ExpressionWrapError {
    Eval(EvaluationError),
}

impl std::fmt::Display for ExpressionWrapError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Eval(err) => write!(formatter, "{err}"),
        }
    }
}
