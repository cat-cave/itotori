//! Branch-following observation types and port-pass selection helpers.
//!
//! Extracted from [`crate::replay`] so the control-transfer report types,
//! play-order observation shapes, and the private port-pass chooser share one
//! ≤500-line child module. Public items are re-exported through `replay`.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use utsushi_core::substrate::TextLine;

use crate::audio::AudioEvent as RealliveAudioEvent;
use crate::graphics_objects::GraphicsObjectStack;
use crate::rlop::module_sel::SelectionPrompt;
use crate::vm::SceneId;

/// Counts of the real control-flow transfers a branch-following replay
/// EXECUTED — the evidence that jumps/calls were FOLLOWED (not
/// linear-walked). A linear walk would record ZERO of every field; a
/// branch-following walk records non-zero transfers and, crucially
/// backward jumps + cross-scene transfers a linear walk can never produce.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlTransferCounts {
    /// Intra-scene `goto`-family jumps executed (pc rewritten within the
    /// same scene).
    pub intra_scene_jumps: u64,
    /// Of `intra_scene_jumps`, how many jumped BACKWARD (target pc < the
    /// jumping command's pc) — a loop/re-entry a linear walk cannot make.
    pub backward_jumps: u64,
    /// Cross-scene `jump` transfers executed (target scene differs).
    pub cross_scene_jumps: u64,
    /// Intra-scene `gosub` subroutine calls executed.
    pub subroutine_calls: u64,
    /// Cross-scene `farcall` calls executed.
    pub far_calls: u64,
    /// `ret` returns executed (subroutine frame popped).
    pub returns: u64,
    /// `rtl` returns executed (far-call frame popped).
    pub returns_from_call: u64,
}

impl ControlTransferCounts {
    /// Total control transfers executed. `> 0` proves the walk FOLLOWED
    /// branches rather than linear-walking.
    pub fn total(&self) -> u64 {
        self.intra_scene_jumps
            + self.cross_scene_jumps
            + self.subroutine_calls
            + self.far_calls
            + self.returns
            + self.returns_from_call
    }
}

/// How a branch-following walk terminated.
///
/// A RealLive scene reaches its natural end in one of two ways: it runs
/// off the end of its bytecode / halts (`EndOfScene`), or — for a scene
/// that is itself a subroutine (entered by the parent via `farcall`
/// `gosub`) — it executes its top-level `ret` / `rtl`. Driven STANDALONE
/// (with an empty call stack, rather than being called into), that
/// top-level return pops an empty stack; the driver classifies it as
/// [`BranchTerminus::ReturnedToCaller`] — a NATURAL terminus, not a fault
/// because the scene ran its real control flow to its return point. Both
/// are natural termini ([`BranchTerminus::is_natural`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BranchTerminus {
    /// pc ran past the end of the scene, or a `Halt` was executed.
    EndOfScene,
    /// A top-level `ret` / `rtl` popped the (empty) call stack — the
    /// standalone-driven subroutine scene returned to its notional caller.
    ReturnedToCaller,
    /// A cross-scene `jump` / `farcall` targeted a scene absent from the
    /// store (for the proven corpora: a scene the bytecode decoder has not
    /// yet recovered, or a genuinely-absent sentinel scene). NOT a natural
    /// terminus — records the missing target.
    SceneNotFound(SceneId),
    /// A cross-scene transfer named an entrypoint the target scene does
    /// not declare.
    EntrypointNotFound(SceneId, u16),
    /// The step budget was exhausted (e.g. an event-gated spin loop a
    /// headless walk cannot break). NOT a natural terminus.
    BudgetExhausted,
    /// A deterministic infinite loop was PROVEN (the walk re-entered an
    /// identical `(scene, pc, stack, memory)` fingerprint) AND the
    /// event-flag model could not break it: even after modelling the
    /// polled event as fired (taking the loop's exit edge), the walk
    /// returned to the same provable-spin fingerprint. This is the
    /// bounded-progress typed diagnostic — a scene that genuinely cannot
    /// progress under the headless model, naming exactly where it is
    /// stuck, in place of a silent [`Self::BudgetExhausted`]. NOT a
    /// natural terminus.
    EventGatedSpin {
        /// Scene the walk was stuck spinning in.
        scene: SceneId,
        /// pc at the proven-spin fingerprint.
        pc: u32,
        /// How many deterministic events the model fired before giving
        /// up on this scene (each is a suppressed loop-closing transfer).
        modeled_events: u64,
    },
    /// Any other typed VM error (carries the stable semantic code).
    OtherFatal(String),
}

impl BranchTerminus {
    /// Whether this terminus is a NATURAL end of execution (the scene ran
    /// its real control flow to completion), as opposed to a gap
    /// (unresolved cross-scene target / budget spin / fault).
    pub fn is_natural(&self) -> bool {
        matches!(self, Self::EndOfScene | Self::ReturnedToCaller)
    }
}

/// Typed result of a branch-following replay
/// ([`ReplayEngine::branch_following_report`]). `PartialEq` so a test can
/// assert two runs of the same scene produce a byte-identical report
/// (determinism).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchReplayReport {
    /// Scene the walk started from.
    pub scene_id: SceneId,
    /// How the walk terminated (natural end vs gap).
    pub terminus: BranchTerminus,
    /// Number of `Advanced` / `LongOpResumed` steps executed.
    pub steps: u32,
    /// Executed control-transfer counts (the branch-following evidence).
    pub transfers: ControlTransferCounts,
    /// Distinct scene ids the walk actually entered (`>1` iff a
    /// cross-scene transfer was followed into a resolvable scene).
    pub scenes_visited: std::collections::BTreeSet<SceneId>,
    /// Sorted, de-duplicated `(module_type, module_id, opcode)` tuples the
    /// walk could not dispatch on the EXECUTED path. The acceptance
    /// asserts this is EMPTY.
    pub unknown_opcode_keys: Vec<(u8, u8, u16)>,
    /// `Some(scene)` iff the walk terminated because a cross-scene
    /// transfer targeted a scene absent from the store. The acceptance
    /// asserts this is `None`.
    pub scene_not_found: Option<SceneId>,
    /// Text lines surfaced through the substrate sink during the walk.
    pub text_lines: usize,
    /// Pause / wait-for-click yields the input-provider auto-dismissed.
    pub pauses_advanced: u64,
    /// Choice prompts the input-provider resolved.
    pub choices_made: u64,
    /// Deterministic events the spin-break model fired during the walk:
    /// each is a PROVEN infinite-loop closing transfer that the model
    /// rewrote to a fall-through (modelling the polled event as having
    /// occurred). `0` for a scene that reached its terminus with no
    /// event-gated spin. Reproducible (fingerprint-driven, no clock/RNG).
    pub modeled_events: u64,
    /// The FIRST scene id, in dispatch order, the walk entered that differs
    /// from [`Self::scene_id`] — the real cross-scene dispatch target a
    /// `jump` / `farcall` / entrypoint resolution transferred into (always
    /// present in the store, since a transfer to an absent scene errors as
    /// [`BranchTerminus::SceneNotFound`] before the pc lands). `None` when
    /// the walk never left its start scene. This is the "next scene" the
    /// play-loop continues into ([`ReplayEngine::observe_playthrough`] chains
    /// on it to produce a multi-scene play-order stream).
    pub first_cross_scene: Option<SceneId>,
}

/// The real observation set produced by [`ReplayEngine::observe_scene`]:
/// the audio events emitted during the drive, the terminal
/// graphics-object stack, and the drive diagnostics. Text is not carried
/// here — it flowed into the caller-supplied
/// [`utsushi_core::substrate::TextSurfaceSink`] during the drive.
#[derive(Debug)]
pub struct SceneObservation {
    /// Audio events (`bgm` / `koe` / `se` / `wav` opcodes) emitted during
    /// the drive, in emission order. Converted by the engine port into
    /// substrate `AudioEvent`s (at the substrate's `E0` audio ceiling).
    pub audio_events: Vec<RealliveAudioEvent>,
    /// The graphics-object stack at the terminus, ready to composite into
    /// a frame through the real g00 rasteriser.
    pub graphics_stack: GraphicsObjectStack,
    /// Number of `Advanced` / `LongOpResumed` steps executed.
    pub steps: u32,
    /// Whether the drive reached a natural terminus (`EndOfScene`
    /// `Halt`) rather than the step budget.
    pub reached_natural_terminus: bool,
}

/// The port-facing observation produced by
/// [`ReplayEngine::observe_for_port`]: the REAL play-order message stream
/// kept distinct from the frame/audio observation.
#[derive(Debug)]
pub struct PortObservation {
    /// The branch-following (real play-order) message stream, single pass
    /// in the order a player sees the messages. This is what the message
    /// window renders one-per-frame and what the substrate text sink
    /// surfaces — NOT the doubled two-pass catalogue.
    pub play_order_lines: Vec<TextLine>,
    /// Selection prompts from the same chosen pass as [`Self::play_order_lines`].
    pub selection_prompts: Vec<SelectionPrompt>,
    /// The first cross-scene dispatch target the branch-following pass
    /// followed (a real `jump` / `farcall` / entrypoint resolution into a
    /// scene present in the store), or `None` when play stayed within this
    /// scene. This is the "next scene" the play-loop continues into;
    /// [`ReplayEngine::observe_playthrough`] chains on it.
    pub first_cross_scene: Option<SceneId>,
    /// Frame + audio observation (graphics stack, audio events, drive
    /// diagnostics). Its graphics/audio may be backfilled from the linear
    /// catalogue pass; its text is not used (see `play_order_lines`).
    pub scene: SceneObservation,
}

/// Choose the single replay pass that supplies port-facing text, carrying its
/// prompt trace alongside it. This is deliberately private transport logic
/// not selection policy: both passes have already executed their respective
/// schedulers before this point.
///
/// A branch is treated as a spin only when it exhausted its step budget and
/// its emitted text shows strong repetition evidence (at least 50 lines with
/// fewer than 10% distinct texts). VM errors and suspended passes remain
/// distinct failures and retain the branch's best-available lines; only a
/// natural linear terminus can authorize the fallback.
pub(super) fn select_port_pass(
    branch_lines: Vec<TextLine>,
    branch_prompts: Vec<SelectionPrompt>,
    branch_termination: PassTermination,
    linear_lines: Vec<TextLine>,
    linear_prompts: Vec<SelectionPrompt>,
    linear_termination: PassTermination,
) -> (Vec<TextLine>, Vec<SelectionPrompt>) {
    let branch_spun = branch_termination == PassTermination::BudgetExhausted
        && branch_lines_show_spin(&branch_lines)
        && linear_termination == PassTermination::NaturalTerminus
        && !linear_lines.is_empty();
    if branch_lines.is_empty() || (branch_spun && !linear_lines.is_empty()) {
        (linear_lines, linear_prompts)
    } else {
        (branch_lines, branch_prompts)
    }
}

/// A spin re-emits a small set of text lines to fill the step budget. Use a
/// conservative threshold of at least 50 lines and fewer than 10% distinct
/// line texts: tiny branches are never classified as spins, while a genuine
/// runaway repetition has a clearly non-distinct stream. Text is used instead
/// of `line_id` because each real emission receives a fresh sequence id.
fn branch_lines_show_spin(lines: &[TextLine]) -> bool {
    const MIN_SPIN_LINE_COUNT: usize = 50;

    if lines.len() < MIN_SPIN_LINE_COUNT {
        return false;
    }
    let distinct = lines
        .iter()
        .map(|line| line.text.as_str())
        .collect::<HashSet<_>>()
        .len();
    distinct.saturating_mul(10) < lines.len()
}

/// Why an `observe_pass` drive stopped. Only `NaturalTerminus` is a clean
/// completion; the other three are distinct non-terminus reasons that must
/// not be conflated when deciding whether the branch pass spun.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PassTermination {
    /// `EndOfScene` / `Halted` — the drive finished on its own.
    NaturalTerminus,
    /// Cut off at `opts.step_budget`.
    BudgetExhausted,
    /// `vm.step(...)` returned `Err` (a `VmError` in the dispatch loop).
    VmError,
    /// `StepOutcome::Suspended` — the VM parked on a queued longop the
    /// scheduler never satisfied.
    Suspended,
}

/// The outcome of a single branch-following drive under a fixed choice
/// policy ([`ReplayEngine::branch_following_observation`]): the play-order
/// text lines the branch produced PLUS the first cross-scene dispatch target
/// it followed. For a `select` option this `first_cross_scene` is the scene
/// the option DISPATCHES INTO (its branch root) — the signal the itotori
/// work-scope carve reads off the archive's opening game-select.
#[derive(Debug, Clone)]
pub struct BranchFollowingObservation {
    /// The branch's play-order text lines (single pass, choice-option lines
    /// included, tagged `text_surface = "choice:<idx>"`).
    pub lines: Vec<TextLine>,
    /// The first cross-scene dispatch target the resolved branch followed
    /// (`jump` / `farcall` / `goto_on($store)`), or `None` when the branch
    /// stayed within its start scene.
    pub first_cross_scene: Option<SceneId>,
}

/// One observation pass' outputs: the [`SceneObservation`] plus the first
/// cross-scene dispatch target the pass followed (only the branch-following
/// mount can leave the start scene; the linear-walk mount always reports
/// `None`).
pub(super) struct PassObservation {
    pub(super) scene: SceneObservation,
    pub(super) first_cross_scene: Option<SceneId>,
    pub(super) selection_prompts: Vec<SelectionPrompt>,
    pub(super) termination: PassTermination,
}

/// A bounded, continuous MULTI-SCENE play-order stream produced by
/// [`ReplayEngine::observe_playthrough`]: the play-loop followed the real
/// RealLive scene-dispatch across ≥1 scene boundary, in dispatch order.
#[derive(Debug)]
pub struct ScenePlaythrough {
    /// The observed scenes, in the dispatch order the play-loop crossed them
    /// (`segments[0]` is the entry scene; each subsequent segment is the
    /// cross-scene dispatch target the previous one followed).
    pub segments: Vec<ScenePlaySegment>,
}

impl ScenePlaythrough {
    /// The scene ids the play-loop crossed, in dispatch order. `len() >= 2`
    /// proves the stream spanned a real scene boundary (a regression that
    /// stops at the entry scene yields `len() == 1`).
    pub fn scene_ids(&self) -> Vec<SceneId> {
        self.segments.iter().map(|s| s.scene_id).collect()
    }

    /// Total play-order messages across every observed scene.
    pub fn total_messages(&self) -> usize {
        self.segments
            .iter()
            .map(|s| s.observation.play_order_lines.len())
            .sum()
    }
}

/// One scene of a [`ScenePlaythrough`]: its id plus the full port
/// observation (single-pass play-order messages + its own composited
/// background / audio) the play-loop rendered for it.
#[derive(Debug)]
pub struct ScenePlaySegment {
    /// The scene id this segment's messages/background belong to.
    pub scene_id: SceneId,
    /// The scene's port observation: play-order messages + its own frame
    /// audio observation (its background is `observation.scene.graphics_stack`).
    pub observation: PortObservation,
}
