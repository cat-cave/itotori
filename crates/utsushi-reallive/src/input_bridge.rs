//! `utsushi-reallive-interactive-input-bridge` — human-driven input for the
//! RealLive runtime.
//!
//! The runtime advances through input-gated yields (`msg.pause`
//! wait-for-click, `msg.select` / choice) via the substrate
//! [`LongOpScheduler`](crate::rlop::LongOpScheduler) seam.
//! [`HeadlessInputScheduler`](crate::rlop::HeadlessInputScheduler) resolves
//! those yields with a deterministic auto-policy so a headless walk reaches a
//! natural terminus with no interactive input.
//!
//! This module GENERALISES that seam into an [`InputSource`] abstraction with
//! three implementations that a single [`BridgeScheduler`] consumes:
//!
//! - [`HeadlessSource`] — the existing deterministic auto policy (advance every
//!   pause, resolve every choice by
//!   [`HeadlessChoicePolicy`](crate::rlop::HeadlessChoicePolicy)).
//! - [`UserInputSource`] — advance / choice / pointer / menu events fed from a
//!   browser / dashboard; the runtime SUSPENDS
//!   ([`LongOpReadiness::Pending`](crate::rlop::LongOpReadiness::Pending))
//!   until the user acts. This is the path a human drives a live scene through.
//! - [`ReplaySource`] — deterministic replay from a captured input log
//!   ([`ReplayLog`]); replaying reproduces the identical playthrough.
//!
//! Every input event the bridge consumes is recorded (event + monotonic
//! [`LogicalClockTick`]) so a live playthrough replays byte-identically:
//! feed the captured stream into a [`ReplaySource`] and the runtime makes the
//! IDENTICAL advance / choice decisions, reaching the identical VM state and
//! rendered frames.
//!
//! # Engine-general, game-agnostic
//!
//! Nothing here references a scene id, a game, or a title. The bridge reasons
//! only over the two engine-general yield shapes RealLive produces
//! ([`PauseLongOp`] / [`SelectLongOp`]) and the engine-neutral
//! [`InputEvent`] model. A `MenuSelect` whose `item_id` parses as a base-10
//! integer is treated as a highlight-move to that option index — the generic
//! convention the browser dashboard canonicalizes a clicked option into.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use utsushi_core::clock::{ClockOrigin, LogicalClockTick};
use utsushi_core::input::{InputError, InputEvent, RawInputCode};
use utsushi_core::replay::{ReplayLog, ReplayLogBuilder, ReplayMetadata};

use crate::rlop::{
    HeadlessChoicePolicy, LongOp, LongOpReadiness, LongOpScheduler,
    OBJECT_SELECT_PRIVATE_STATE_MAGIC, ObjectSelectLongOp, PAUSE_PRIVATE_STATE_MAGIC, PauseLongOp,
    SELECT_PRIVATE_STATE_MAGIC, SelectLongOp,
};

/// Adapter name recorded in a captured [`ReplayLog`]'s metadata.
pub const BRIDGE_ADAPTER_NAME: &str = "utsushi-reallive";
/// Adapter version recorded in a captured [`ReplayLog`]'s metadata.
pub const BRIDGE_ADAPTER_VERSION: &str = "0.1.0-alpha";
pub const REALLIVE_RAW_INPUT_ENGINE: &str = "reallive";
pub const REALLIVE_RAW_SECONDARY_RELEASE: &str = "mouse.secondary.release";

/// The engine-general shape of the input-gated yield the runtime is suspended
/// on. Classified from a queued [`LongOp`]'s private-state magic byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingYield {
    /// A pause / wait-for-click ([`PauseLongOp`]). Resolved by a text-advance.
    Pause,
    /// A choice / selection prompt of `choice_count` options
    /// ([`SelectLongOp`]). Resolved by committing an option index.
    Select {
        /// Number of options the prompt presents.
        choice_count: usize,
    },
    ObjectSelect {
        choice_count: usize,
    },
    /// Any other longop shape (no user-visible gate). Resumed immediately.
    Other,
}

impl PendingYield {
    /// Classify the queue head from its private-state magic byte.
    pub fn classify(head: &LongOp) -> Self {
        match head.private_state.first().copied() {
            Some(PAUSE_PRIVATE_STATE_MAGIC) => PendingYield::Pause,
            Some(SELECT_PRIVATE_STATE_MAGIC) => match SelectLongOp::try_from_longop(head) {
                Ok(select) => PendingYield::Select {
                    choice_count: select.choice_count(),
                },
                // A select-magic payload that will not decode has no known
                // option count; treat it as a zero-option prompt so a commit
                // resolves to index 0 rather than deadlocking.
                Err(_) => PendingYield::Select { choice_count: 0 },
            },
            Some(OBJECT_SELECT_PRIVATE_STATE_MAGIC) => {
                match ObjectSelectLongOp::try_from_longop(head) {
                    Ok(select) => PendingYield::ObjectSelect {
                        choice_count: select.choice_count(),
                    },
                    Err(_) => PendingYield::ObjectSelect { choice_count: 0 },
                }
            }
            _ => PendingYield::Other,
        }
    }
}

/// The source of the runtime's advance / choice / navigation decisions.
///
/// The [`BridgeScheduler`] polls the configured source at every input-gated
/// yield. A source returns the next [`InputEvent`] to apply, or `None` to
/// signal "no input available yet" — the runtime then SUSPENDS until the
/// source has an event (the live-interactive path) or terminates the walk (a
/// headless / replay source that has exhausted its script).
pub trait InputSource: Send + Sync + std::fmt::Debug {
    /// The next input event to apply at `pending`, or `None` if no input is
    /// available yet. `pending` lets a policy-driven source (e.g.
    /// [`HeadlessSource`]) decide advance-vs-choice; queue / log sources
    /// ignore it and return their next recorded event.
    fn next_event(&mut self, pending: PendingYield) -> Option<InputEvent>;
}

// Headless source

/// Deterministic auto-policy source: advance every pause, resolve every choice
/// through a [`HeadlessChoicePolicy`]. The interactive-bridge counterpart to
/// [`HeadlessInputScheduler`](crate::rlop::HeadlessInputScheduler) — it
/// resolves choices through the SAME [`HeadlessChoicePolicy::resolve`] so the
/// headless bridge path and the legacy headless scheduler never diverge.
#[derive(Debug)]
pub struct HeadlessSource {
    policy: HeadlessChoicePolicy,
    choice_cursor: usize,
}

impl HeadlessSource {
    /// Build a headless source driving choices by `policy`.
    pub fn new(policy: HeadlessChoicePolicy) -> Self {
        Self {
            policy,
            choice_cursor: 0,
        }
    }
}

impl Default for HeadlessSource {
    fn default() -> Self {
        Self::new(HeadlessChoicePolicy::AlwaysFirst)
    }
}

impl InputSource for HeadlessSource {
    fn next_event(&mut self, pending: PendingYield) -> Option<InputEvent> {
        Some(match pending {
            PendingYield::Pause | PendingYield::Other => InputEvent::advance(),
            PendingYield::Select { choice_count } | PendingYield::ObjectSelect { choice_count } => {
                let index = self.policy.resolve(self.choice_cursor, choice_count);
                self.choice_cursor += 1;
                InputEvent::choice(index)
            }
        })
    }
}

// User-input source (browser / dashboard)

/// Shared FIFO of browser / dashboard input events. Cloneable handle so the
/// web bridge (which pushes events) and the runtime driver (which drains them)
/// hold the same queue across threads.
#[derive(Debug, Clone, Default)]
pub struct UserInputQueue {
    inner: Arc<Mutex<VecDeque<InputEvent>>>,
}

impl UserInputQueue {
    /// A fresh, empty queue.
    pub fn new() -> Self {
        Self::default()
    }

    /// Push one browser / dashboard input event (advance / choice / pointer
    /// menu). The next runtime poll consumes it in FIFO order.
    pub fn push(&self, event: InputEvent) {
        self.lock().push_back(event);
    }

    /// Push a text-advance / click-to-advance gesture.
    pub fn push_advance(&self) {
        self.push(InputEvent::advance());
    }

    /// Push a choice commit for `index`.
    pub fn push_choice(&self, index: u16) {
        self.push(InputEvent::choice(index));
    }

    /// Number of events currently queued.
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    /// Whether the queue is empty.
    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    fn pop(&self) -> Option<InputEvent> {
        self.lock().pop_front()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<InputEvent>> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Live user-input source backed by a [`UserInputQueue`]. The runtime consumes
/// queued browser / dashboard events; when the queue is empty the poll returns
/// `None` and the runtime SUSPENDS ([`LongOpReadiness::Pending`]) until the
/// user acts — exactly the live-interactive drive.
#[derive(Debug, Clone)]
pub struct UserInputSource {
    queue: UserInputQueue,
}

impl UserInputSource {
    /// Build a source over `queue`. Clone `queue` beforehand to retain a
    /// handle the browser bridge pushes into.
    pub fn new(queue: UserInputQueue) -> Self {
        Self { queue }
    }

    /// Borrow the shared queue handle.
    pub fn queue(&self) -> &UserInputQueue {
        &self.queue
    }
}

impl InputSource for UserInputSource {
    fn next_event(&mut self, _pending: PendingYield) -> Option<InputEvent> {
        self.queue.pop()
    }
}

// Replay source

/// Deterministic replay source: replays a captured [`ReplayLog`]'s events in
/// recorded order. Feeding a captured playthrough's log into a [`ReplaySource`]
/// makes the runtime take the IDENTICAL advance / choice decisions, so the run
/// reproduces byte-identically.
#[derive(Debug, Clone)]
pub struct ReplaySource {
    events: Vec<InputEvent>,
    cursor: usize,
}

impl ReplaySource {
    /// Build a replay source from a captured [`ReplayLog`].
    pub fn from_log(log: &ReplayLog) -> Self {
        Self {
            events: log.iter().map(|entry| entry.event.clone()).collect(),
            cursor: 0,
        }
    }

    /// Build a replay source directly from an ordered event stream.
    pub fn from_events(events: Vec<InputEvent>) -> Self {
        Self { events, cursor: 0 }
    }

    /// Number of events remaining to replay.
    pub fn remaining(&self) -> usize {
        self.events.len().saturating_sub(self.cursor)
    }
}

impl InputSource for ReplaySource {
    fn next_event(&mut self, _pending: PendingYield) -> Option<InputEvent> {
        let event = self.events.get(self.cursor).cloned()?;
        self.cursor += 1;
        Some(event)
    }
}

// Bridge scheduler

/// The substrate [`LongOpScheduler`] that drives the runtime from an
/// [`InputSource`] and DETERMINISTICALLY captures every consumed input event.
///
/// At each input-gated yield the scheduler:
///
/// 1. classifies the queue head into a [`PendingYield`];
/// 2. pulls events from the source until one COMMITS the gate (a text-advance
///    dismisses a pause / commits the highlighted choice; a choice event
///    commits its index), recording every consumed event to the capture log at
///    a strictly-monotonic tick;
/// 3. applies the commit to the head's private state (exactly as the legacy
///    headless / choice schedulers do) and returns
///    [`LongOpReadiness::Ready`]; or, if the source runs dry before a commit
///    returns [`LongOpReadiness::Pending`] so the runtime SUSPENDS.
///
/// Pointer and integer-`item_id` menu events are NAVIGATION: they move the
/// highlighted option (`nav_cursor`) but do not commit, and are recorded so
/// the full gesture stream replays. Because they never mutate VM state, they
/// do not perturb the reproduced playthrough — the advance / choice commits do.
#[derive(Debug)]
pub struct BridgeScheduler {
    source: Box<dyn InputSource>,
    captured: Vec<(LogicalClockTick, InputEvent)>,
    next_tick: u64,
    nav_cursor: u16,
    pauses_advanced: u64,
    choices_made: u64,
    nav_events: u64,
    other_advanced: u64,
}

impl BridgeScheduler {
    /// Build a scheduler driven by `source`, capturing every consumed event
    /// from tick `1` upward.
    pub fn new(source: Box<dyn InputSource>) -> Self {
        Self {
            source,
            captured: Vec::new(),
            next_tick: 1,
            nav_cursor: 0,
            pauses_advanced: 0,
            choices_made: 0,
            nav_events: 0,
            other_advanced: 0,
        }
    }

    /// Build a headless-driven scheduler (deterministic auto policy).
    pub fn headless(policy: HeadlessChoicePolicy) -> Self {
        Self::new(Box::new(HeadlessSource::new(policy)))
    }

    /// Build a user-input-driven scheduler over `queue` (the live path).
    pub fn user(queue: UserInputQueue) -> Self {
        Self::new(Box::new(UserInputSource::new(queue)))
    }

    /// Build a replay-driven scheduler from a captured `log`.
    pub fn replay(log: &ReplayLog) -> Self {
        Self::new(Box::new(ReplaySource::from_log(log)))
    }

    /// The captured `(tick, event)` pairs, in commit order.
    pub fn captured_events(&self) -> &[(LogicalClockTick, InputEvent)] {
        &self.captured
    }

    /// Number of pause yields dismissed.
    pub fn pauses_advanced(&self) -> u64 {
        self.pauses_advanced
    }

    /// Number of choice prompts committed.
    pub fn choices_made(&self) -> u64 {
        self.choices_made
    }

    /// Number of navigation (pointer / menu-move) events consumed.
    pub fn nav_events(&self) -> u64 {
        self.nav_events
    }

    /// Number of other (non-pause, non-select) yields auto-resumed.
    pub fn other_advanced(&self) -> u64 {
        self.other_advanced
    }

    /// Finalize the captured events into a [`ReplayLog`] tagged with `run_id`.
    ///
    /// The log round-trips through [`ReplaySource::from_log`] to reproduce the
    /// exact playthrough. Fails with a typed [`InputError`] if a captured event
    /// violates payload-shape or redaction invariants (it cannot, for the
    /// events this scheduler emits, but the builder is the single validated
    /// entry point).
    pub fn build_log(&self, run_id: impl Into<String>) -> Result<ReplayLog, InputError> {
        let metadata = ReplayMetadata::new(
            run_id,
            BRIDGE_ADAPTER_NAME,
            BRIDGE_ADAPTER_VERSION,
            ClockOrigin::RunStart,
            0,
            None,
        );
        let mut builder = ReplayLogBuilder::new().metadata(metadata);
        for (tick, event) in &self.captured {
            builder.record(*tick, event.clone())?;
        }
        builder.build()
    }

    /// Record `event` to the capture log at the next monotonic tick.
    fn capture(&mut self, event: InputEvent) {
        let tick = LogicalClockTick(self.next_tick);
        self.next_tick += 1;
        self.captured.push((tick, event));
    }

    /// Apply a commit to the queue head. Mirrors the private-state rewrites the
    /// legacy [`HeadlessInputScheduler`](crate::rlop::HeadlessInputScheduler)
    /// and [`ChoiceInputScheduler`](crate::rlop::ChoiceInputScheduler) perform.
    fn commit(&mut self, head: &mut LongOp, pending: PendingYield, chosen: Option<u16>) {
        match pending {
            PendingYield::Pause => {
                if let Ok(mut pause) = PauseLongOp::try_from_longop(head) {
                    pause.mark_dismissed();
                    head.private_state = pause.into_longop().private_state;
                }
                self.pauses_advanced = self.pauses_advanced.saturating_add(1);
            }
            PendingYield::Select { choice_count } => {
                if let Ok(mut select) = SelectLongOp::try_from_longop(head) {
                    let ceiling = choice_count.saturating_sub(1) as u16;
                    let index = chosen.unwrap_or(self.nav_cursor).min(ceiling);
                    select.choose(index);
                    let LongOp { id, private_state } = select.into_longop();
                    head.id = id;
                    head.private_state = private_state;
                }
                self.choices_made = self.choices_made.saturating_add(1);
            }
            PendingYield::ObjectSelect { choice_count } => {
                if let Ok(mut select) = ObjectSelectLongOp::try_from_longop(head) {
                    let ceiling = choice_count.saturating_sub(1) as u16;
                    let index = chosen.unwrap_or(self.nav_cursor).min(ceiling);
                    select.select(index);
                    let LongOp { id, private_state } = select.into_longop();
                    head.id = id;
                    head.private_state = private_state;
                }
                self.choices_made = self.choices_made.saturating_add(1);
            }
            PendingYield::Other => {
                self.other_advanced = self.other_advanced.saturating_add(1);
            }
        }
    }

    fn cancel_object_select(&mut self, head: &mut LongOp, pending: PendingYield) -> bool {
        let PendingYield::ObjectSelect { .. } = pending else {
            return false;
        };
        let Ok(mut select) = ObjectSelectLongOp::try_from_longop(head) else {
            return false;
        };
        if !select.is_cancelable() {
            return false;
        }
        select.cancel();
        let LongOp { id, private_state } = select.into_longop();
        head.id = id;
        head.private_state = private_state;
        self.choices_made = self.choices_made.saturating_add(1);
        true
    }
}

#[path = "input_bridge_scheduler.rs"]
mod scheduler;

#[cfg(test)]
#[path = "input_bridge_tests.rs"]
mod tests;
