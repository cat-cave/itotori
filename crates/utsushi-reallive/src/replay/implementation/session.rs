//! Stateful, human-driven RealLive stepping session.
//!
//! The existing replay APIs deliberately build a fresh VM for an offline
//! observation. This module is the complementary live boundary: it keeps one
//! VM, registry, graphics runtime, and user-input queue alive across calls.

use super::*;

use utsushi_core::input::InputEvent;
use utsushi_core::substrate::AssetPackage;

use super::event_loop_gate::{PolledEventLoop, carries_a_back_edge};
use crate::input_bridge::{BridgeScheduler, PendingYield, UserInputQueue};
use crate::pointer_click::{
    HydratedPrimaryClick, HydratedPrimaryClickError, LIVE_SESSION_SCREEN,
    ScriptRectanglePrimaryClick, ScriptRectanglePrimaryClickError,
};
use crate::render_pipeline::ObjectButtonChoiceOption;
use crate::rlop::SelectLongOp;
use crate::rlop::module_sel::SelectionPromptKind;
use crate::var_banks::{BankId, Value};

/// A compact, serialisable-by-callers description of the live VM boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveSessionState {
    /// The scene currently executing.
    pub scene: SceneId,
    /// The bytecode instruction pointer at the boundary.
    pub pc: u32,
    /// Count of actual VM transitions performed by this session.
    pub event_index: u64,
    /// The input gate the VM is waiting for, if any.
    pub waiting_for: Option<LiveSessionWait>,
    /// Whether the VM reached a natural terminal state.
    pub ended: bool,
}

/// The input shape currently requested by the actual VM longop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveSessionWait {
    Advance,
    /// A script-owned input polling loop. The caller must send the event the
    /// loop samples; this is not interchangeable with a message pause.
    Pointer,
    Choice {
        choice_count: usize,
    },
}

/// The REAL options behind the current choice gate, read off the parked
/// longop rather than inferred from the emitted text stream.
///
/// Without this the only thing a caller can show at a choice gate is the
/// last emitted line — one of the options, indistinguishable from
/// dialogue — so the player sees neither the full option list nor which
/// option is focused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveSessionChoice {
    /// A `select`-family text prompt. Labels are the longop's own
    /// Shift-JIS option strings, decoded here.
    Text { options: Vec<String> },
    /// A `select_objbtn`-family prompt over on-screen button objects,
    /// carrying each option's decoded hit rectangle and art reference.
    ObjectButtons {
        options: Vec<ObjectButtonChoiceOption>,
    },
}

/// A state transition plus the real text lines emitted while it executed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveSessionUpdate {
    pub state: LiveSessionState,
    pub emitted_lines: Vec<TextLine>,
}

/// A typed failure from a live session. Callers should terminate the browser
/// session on this error rather than silently substituting a saved frame.
#[derive(Debug, thiserror::Error)]
pub enum LiveSessionError {
    #[error("utsushi.reallive.live_session.scene_not_found: scene={scene}")]
    SceneNotFound { scene: SceneId },
    #[error("utsushi.reallive.live_session.step_budget_exhausted: limit={limit}")]
    StepBudgetExhausted { limit: u32 },
    #[error("utsushi.reallive.live_session.vm: {0}")]
    Vm(#[from] crate::vm::VmError),
}

/// A live RealLive VM retained across browser input events.
#[derive(Debug)]
pub struct LiveSession {
    vm: Vm,
    registry: RlopRegistry,
    runtime: Arc<MsgRuntime>,
    sink: Arc<ReplayTextSink>,
    graphics: Arc<GraphicsRuntime>,
    queue: UserInputQueue,
    scheduler: BridgeScheduler,
    store: InMemorySceneStore,
    shift_jis: HashSet<(SceneId, u32)>,
    event_index: u64,
    ended: bool,
    selection: Arc<SelRuntime>,
    cursor: Arc<cursor_input::CursorInputRuntime>,
    /// Button-object options recorded by the most recent `select_objbtn`
    /// prompt. Retained across the drive loop because the selection
    /// runtime's prompt buffer DRAINS on read.
    object_buttons: Vec<ObjectButtonChoiceOption>,
    /// Recognises a screen that waits by polling rather than by queueing,
    /// and turns it into a real boundary the reader can cross.
    event_loop: PolledEventLoop,
}

impl ReplayEngine {
    /// Start a session at a scene and execute until the first real input gate.
    /// The returned object owns the VM state; [`LiveSession::send`] resumes
    /// that exact VM instead of replaying from scene zero.
    pub fn start_live_session(
        &self,
        scene: SceneId,
    ) -> Result<(LiveSession, LiveSessionUpdate), LiveSessionError> {
        self.start_live_session_with_optional_assets(scene, None)
    }

    /// Start a live session with the g00 package the graphics opcodes use
    /// while they build the current stack. Binding this before the first VM
    /// step matters: `grp.openBg` both observes and allocates the real
    /// background object during that initial drive.
    pub fn start_live_session_with_assets(
        &self,
        scene: SceneId,
        assets: Arc<dyn AssetPackage>,
    ) -> Result<(LiveSession, LiveSessionUpdate), LiveSessionError> {
        self.start_live_session_with_optional_assets(scene, Some(assets))
    }

    fn start_live_session_with_optional_assets(
        &self,
        scene: SceneId,
        assets: Option<Arc<dyn AssetPackage>>,
    ) -> Result<(LiveSession, LiveSessionUpdate), LiveSessionError> {
        if self.store.fetch(scene).is_none() {
            return Err(LiveSessionError::SceneNotFound { scene });
        }
        let sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
        let sink_dyn: Arc<dyn TextSurfaceSink> = Arc::clone(&sink) as Arc<dyn TextSurfaceSink>;
        let runtime = Arc::new(MsgRuntime::with_sink(Arc::clone(&sink_dyn)));
        runtime.set_speaker_resolver(self.speaker_resolver.clone());
        let handles = mount_registry_handles(
            sink_dyn,
            Arc::clone(&runtime),
            ControlFlowMount::BranchFollowing,
        );
        if let Some(assets) = assets {
            handles.graphics.set_asset_package(assets);
        }
        let queue = UserInputQueue::new();
        let mut session = LiveSession {
            vm: Vm::new(scene, 0),
            registry: handles.registry,
            runtime,
            sink,
            graphics: handles.graphics,
            queue: queue.clone(),
            scheduler: BridgeScheduler::user(queue),
            store: self.store.clone(),
            shift_jis: self.shift_jis.clone(),
            event_index: 0,
            ended: false,
            selection: handles.selection,
            cursor: handles.cursor,
            object_buttons: Vec::new(),
            event_loop: PolledEventLoop::default(),
        };
        let initial = session.drive_to_boundary()?;
        Ok((session, initial))
    }
}

impl LiveSession {
    /// Current VM state without advancing it.
    pub fn state(&self) -> LiveSessionState {
        let waiting_for = self
            .vm
            .longop_queue()
            .front()
            .map(PendingYield::classify)
            .and_then(|pending| match pending {
                PendingYield::Pause => Some(LiveSessionWait::Advance),
                PendingYield::Select { choice_count }
                | PendingYield::ObjectSelect { choice_count } => {
                    Some(LiveSessionWait::Choice { choice_count })
                }
                PendingYield::Other => None,
            })
            // A screen written as its own polled loop queues nothing, so the
            // queue cannot report it. It is still a wait, and the reader
            // still gets it out.
            .or_else(|| {
                self.event_loop
                    .is_parked()
                    .then_some(LiveSessionWait::Pointer)
            });
        LiveSessionState {
            scene: self.vm.scene(),
            pc: self.vm.pc(),
            event_index: self.event_index,
            waiting_for,
            ended: self.ended,
        }
    }

    /// The graphics stack produced by the real VM up to the current boundary.
    pub fn graphics_stack(&self) -> crate::GraphicsObjectStack {
        self.graphics.state_snapshot().stack
    }

    /// Read the four script-owned operands currently used by the polled
    /// pointer gate. This is observational only: it never writes the VM bank
    /// or manufactures a target from the values.
    pub fn pointer_gate_values(&self) -> [Option<i32>; 4] {
        [1000, 1001, 1002, 1003].map(|index| match self.vm.banks().get(BankId::IntA, index) {
            Some(Value::Int(value)) => Some(value),
            Some(Value::Str(_)) | None => None,
        })
    }

    /// Derive the only allowed automated pointer gesture from the hydrated
    /// button rectangle currently visible at this live input boundary.
    pub fn hydrated_primary_click(
        &self,
    ) -> Result<HydratedPrimaryClick, HydratedPrimaryClickError> {
        HydratedPrimaryClick::from_rectangle(&self.graphics_stack(), self.pointer_gate_values())
    }

    /// Derive a click for a script-owned cursor polling loop. Unlike an
    /// object-button select, this gate is satisfied by the script's own
    /// cursor/rectangle comparison and has no graphics-object prerequisite.
    pub fn script_rectangle_primary_click(
        &self,
    ) -> Result<ScriptRectanglePrimaryClick, ScriptRectanglePrimaryClickError> {
        ScriptRectanglePrimaryClick::from_rectangle(self.pointer_gate_values())
    }

    /// The REAL options behind the parked choice gate, or `None` when the
    /// VM is not waiting on a selection.
    ///
    /// A text select reads its labels straight off the queued
    /// [`SelectLongOp`]; a button select reads the placement metadata the
    /// selection runtime recorded when it raised the prompt. Neither path
    /// synthesizes an option, a label, or a coordinate: an option whose
    /// geometry the runtime could not decode is DROPPED rather than given
    /// a made-up rectangle.
    pub fn pending_choice(&self) -> Option<LiveSessionChoice> {
        let head = self.vm.longop_queue().front()?;
        match PendingYield::classify(head) {
            PendingYield::Select { .. } => {
                let select = SelectLongOp::try_from_longop(head).ok()?;
                let options = select
                    .choices()
                    .iter()
                    .map(|bytes| encoding_rs::SHIFT_JIS.decode(bytes).0.into_owned())
                    .collect();
                Some(LiveSessionChoice::Text { options })
            }
            PendingYield::ObjectSelect { .. } => Some(LiveSessionChoice::ObjectButtons {
                options: self.object_buttons.clone(),
            }),
            PendingYield::Pause | PendingYield::Other => None,
        }
    }

    /// Fold any selection prompts the runtime raised during this drive
    /// into the retained button-object option list. The runtime's prompt
    /// buffer drains on read, so the drive loop must capture it as it goes
    /// rather than reading it once at the boundary.
    fn capture_prompts(&mut self) {
        for prompt in self.selection.take_prompts() {
            let SelectionPromptKind::ObjectButtons { options, .. } = &prompt.kind else {
                continue;
            };
            self.object_buttons = options
                .iter()
                .filter_map(|option| option.render_choice_option().ok())
                .collect();
        }
    }

    /// Supply one browser input event and advance the retained VM until its
    /// next gate or terminal state.
    pub fn send(&mut self, input: InputEvent) -> Result<LiveSessionUpdate, LiveSessionError> {
        if self.ended {
            return Ok(LiveSessionUpdate {
                state: self.state(),
                emitted_lines: Vec::new(),
            });
        }
        // A polled-loop boundary has nothing queued for this input to
        // resolve: the input IS the event the loop is sampling for, and it is
        // spent modelling that. Queueing it as well would let one press cross
        // two boundaries — the loop, and then whichever real gate follows it.
        let primary_press = matches!(
            input,
            InputEvent::Pointer {
                button: utsushi_core::input::PointerButton::Primary,
                ..
            }
        );
        self.cursor.record(&input, LIVE_SESSION_SCREEN);
        // A pointer-down changes the polled cursor state to `1`, but the VM
        // does not advance until the matching native release changes it to
        // `2`. This preserves the script-visible transition instead of
        // treating pointer-down as a completed click.
        if self.event_loop.is_parked() && primary_press {
            return Ok(LiveSessionUpdate {
                state: self.state(),
                emitted_lines: Vec::new(),
            });
        }
        if self.event_loop.is_parked() {
        } else if let Some(choice) = self.object_button_choice_at(&input) {
            self.queue.push(InputEvent::choice(choice));
        } else {
            self.queue.push(input);
        }
        self.drive_to_boundary()
    }

    /// Resolve a completed primary-pointer gesture against the exact decoded
    /// object-button rectangles exposed by the current prompt. The live
    /// substrate normalizes pointer coordinates; RealLive's default screen
    /// space is 640×480 when no game configuration is mounted here.
    fn object_button_choice_at(&self, input: &InputEvent) -> Option<u16> {
        let InputEvent::Pointer {
            x,
            y,
            button: utsushi_core::input::PointerButton::Primary,
        } = input
        else {
            return None;
        };
        let px = (x * 639.0).round() as i32;
        let py = (y * 479.0).round() as i32;
        self.object_buttons
            .iter()
            .find(|option| option.contains_pixel(px, py))
            .map(|option| option.display_index)
    }

    fn drive_to_boundary(&mut self) -> Result<LiveSessionUpdate, LiveSessionError> {
        const LIVE_STEP_LIMIT: u32 = 200_000;
        let mut lines = self.sink.drain();
        // Set when the previous boundary parked on a script's own polled
        // event loop: this drive owes that loop the event it was sampling
        // for, which the reader has now supplied.
        let mut owes_event = self.event_loop.begin_drive();
        for _ in 0..LIVE_STEP_LIMIT {
            let pc_before = self.vm.pc();
            let scene_before = self.vm.scene();
            if owes_event
                && self
                    .store
                    .fetch(scene_before)
                    .and_then(|scene| scene.element_at(pc_before))
                    .is_some_and(|element| carries_a_back_edge(element, pc_before))
            {
                // Model the awaited event as fired: the loop's back edge
                // falls through to the exit it was polling for.
                self.vm.request_suppress_next_transfer();
            }
            match self
                .vm
                .step(&self.store, &self.registry, &mut self.scheduler)?
            {
                StepOutcome::Advanced { event } => {
                    self.event_index = self.event_index.saturating_add(1);
                    if self.vm.last_transfer_suppressed() {
                        owes_event = false;
                    }
                    if let VmEvent::Textout { raw_bytes } = &event
                        && self.shift_jis.contains(&(scene_before, pc_before))
                    {
                        dispatch_textout_at(&self.runtime, pc_before, raw_bytes);
                        dispatch_cosmetic_line_break(&mut self.vm, &self.registry);
                    }
                    if !owes_event
                        && self
                            .event_loop
                            .proves_spin(&self.vm, &event, scene_before, pc_before)
                    {
                        self.capture_prompts();
                        lines.extend(self.sink.drain());
                        return Ok(LiveSessionUpdate {
                            state: self.state(),
                            emitted_lines: lines,
                        });
                    }
                }
                StepOutcome::LongOpResumed { .. } => {
                    self.event_index = self.event_index.saturating_add(1);
                }
                StepOutcome::Suspended { .. } => {
                    self.capture_prompts();
                    lines.extend(self.sink.drain());
                    return Ok(LiveSessionUpdate {
                        state: self.state(),
                        emitted_lines: lines,
                    });
                }
                StepOutcome::EndOfScene { .. } | StepOutcome::Halted => {
                    self.ended = true;
                    lines.extend(self.sink.drain());
                    return Ok(LiveSessionUpdate {
                        state: self.state(),
                        emitted_lines: lines,
                    });
                }
            }
            let _ = self.vm.take_warnings();
            self.capture_prompts();
            lines.extend(self.sink.drain());
        }
        Err(LiveSessionError::StepBudgetExhausted {
            limit: LIVE_STEP_LIMIT,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::bytecode_element::{BytecodeElement, TextoutEncoding};
    use crate::rlop::module_msg::{MSG_MODULE_ID, MSG_MODULE_TYPE, OPCODE_PAUSE};
    use crate::vm::Scene;

    fn text(offset: usize, value: &str) -> BytecodeElement {
        BytecodeElement::Textout {
            encoding_hint: TextoutEncoding::ShiftJis,
            raw_bytes: value.as_bytes().to_vec(),
            byte_offset: offset,
            byte_len: value.len(),
        }
    }

    fn pause(offset: usize) -> BytecodeElement {
        BytecodeElement::Command {
            module_type: MSG_MODULE_TYPE,
            module_id: MSG_MODULE_ID,
            opcode: OPCODE_PAUSE,
            arg_count: 0,
            overload: 0,
            goto_targets: Vec::new(),
            goto_case_exprs: Vec::new(),
            raw_bytes: vec![
                0x23,
                MSG_MODULE_TYPE,
                MSG_MODULE_ID,
                OPCODE_PAUSE as u8,
                0,
                0,
                0,
                0,
            ],
            byte_offset: offset,
            byte_len: 8,
        }
    }

    #[test]
    fn browser_advance_moves_the_retained_vm_to_the_next_real_text_boundary() {
        let first = text(0, "first live line");
        let first_pause = pause(first.byte_len());
        let second_offset = first.byte_len() + first_pause.byte_len();
        let second = text(second_offset, "second live line");
        let second_pause = pause(second_offset + second.byte_len());
        let scene = Scene::new(1, vec![first, first_pause, second, second_pause])
            .expect("synthetic live scene");
        let mut store = InMemorySceneStore::new();
        store.insert(scene);
        let mut shift_jis = HashSet::new();
        shift_jis.insert((1, 0));
        shift_jis.insert((1, second_offset as u32));
        let engine = ReplayEngine::from_store(store, shift_jis);

        let (mut session, initial) = engine.start_live_session(1).expect("session starts");
        assert_eq!(initial.emitted_lines[0].text, "first live line");
        assert_eq!(initial.state.waiting_for, Some(LiveSessionWait::Advance));

        let next = session
            .send(InputEvent::advance())
            .expect("advance runs retained VM");
        assert_eq!(next.emitted_lines[0].text, "second live line");
        assert_eq!(next.state.waiting_for, Some(LiveSessionWait::Advance));
        assert!(
            next.state.event_index > initial.state.event_index,
            "an input must execute real VM transitions, not return the initial frame"
        );
        assert_ne!(next.state.pc, initial.state.pc);
    }
}
