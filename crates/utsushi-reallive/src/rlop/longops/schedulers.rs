use super::*;

/// Scheduler that resumes a [`SelectLongOp`] after observing the queue
/// head as pending for `polls_remaining` polls. The shape mirrors
/// [`crate::rlop::AfterNPollsScheduler`] so a test can swap one for
/// the other; the typed wrapper exists so a synthetic `msg.select`
/// test can spell out "wait N polls, then resume" in a name that
/// reflects the suspension shape.
#[derive(Debug, Clone, Copy)]
pub struct SelectionChoiceCountScheduler {
    /// Remaining `Pending` polls before the head becomes `Ready`.
    pub polls_remaining: u32,
}

impl SelectionChoiceCountScheduler {
    /// Construct a scheduler that reports `Pending` `polls` times and
    /// `Ready` thereafter.
    pub fn new(polls: u32) -> Self {
        Self {
            polls_remaining: polls,
        }
    }
}

impl LongOpScheduler for SelectionChoiceCountScheduler {
    fn poll(&mut self, _head: &mut LongOp) -> LongOpReadiness {
        if self.polls_remaining == 0 {
            LongOpReadiness::Ready
        } else {
            self.polls_remaining -= 1;
            LongOpReadiness::Pending
        }
    }
}

/// Deterministic choice policy for the [`HeadlessInputScheduler`].
///
/// Every variant is reproducible: given the same scene bytecode and the
/// same policy, a headless replay makes byte-identical choices on every
/// run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeadlessChoicePolicy {
    /// Always select the first option (index `0`). The default — the
    /// simplest reproducible policy, and the one that reaches a scene's
    /// natural terminus down its first-choice spine.
    AlwaysFirst,
    /// Always select a fixed index (clamped to the last option when the
    /// prompt offers fewer choices).
    Fixed(u16),
    /// A scripted sequence of indices, consumed one per choice prompt in
    /// order; once exhausted, falls back to index `0`. Lets a test drive
    /// a specific branch spine deterministically.
    Scripted(Vec<u16>),
}

impl HeadlessChoicePolicy {
    /// Resolve the chosen index for a prompt of `choice_count` options
    /// advancing any internal cursor. Always returns an in-range index
    /// (or `0` for an empty prompt).
    ///
    /// Public so the interactive [`crate::input_bridge::HeadlessSource`]
    /// resolves a choice through the SAME deterministic policy the
    /// [`HeadlessInputScheduler`] uses — the two paths must never diverge.
    pub fn resolve(&self, cursor: usize, choice_count: usize) -> u16 {
        let raw = match self {
            Self::AlwaysFirst => 0u16,
            Self::Fixed(index) => *index,
            Self::Scripted(seq) => seq.get(cursor).copied().unwrap_or(0),
        };
        if choice_count == 0 {
            return 0;
        }
        let ceiling = (choice_count - 1) as u16;
        raw.min(ceiling)
    }
}

/// Deterministic HEADLESS input-provider: the substrate
/// [`LongOpScheduler`] that lets a real branch-following replay run its
/// ACTUAL control flow to a natural terminus with no interactive input.
///
/// Every input-gated yield a real VN scene produces is resolved
/// deterministically:
///
/// - **Pause / wait-for-click** ([`PauseLongOp`], magic
///   [`PAUSE_PRIVATE_STATE_MAGIC`]) — auto-dismissed, resumes immediately
///   ([`LongOpReadiness::Ready`]). This clears the text/pause/wait yields
///   that would otherwise `BudgetExhausted` a headless walk.
/// - **Choice / selection** ([`SelectLongOp`], magic
///   [`SELECT_PRIVATE_STATE_MAGIC`]) — resolved by the configured
///   [`HeadlessChoicePolicy`] (default: always the first option). The
///   chosen index is written into the head's private state (exactly as
///   [`crate::rlop::ChoiceInputScheduler`] does for real input) before
///   `Ready`, so the VM's resume path records it into the store register
///   and downstream `goto_on` / `goto_case` branches deterministically.
/// - **Any other longop shape** — resumed immediately; there is nothing a
///   headless walk can gate on, and refusing would deadlock.
///
/// The provider is byte-deterministic and reproducible: it holds no
/// clock, no RNG, no host input — only the policy and a scripted-choice
/// cursor. It counts the pauses it dismissed and the choices it made so a
/// driver can prove real input-gating was exercised.
#[derive(Debug)]
pub struct HeadlessInputScheduler {
    policy: HeadlessChoicePolicy,
    choice_cursor: usize,
    pauses_advanced: u64,
    choices_made: u64,
    other_advanced: u64,
}

impl Default for HeadlessInputScheduler {
    fn default() -> Self {
        Self::new(HeadlessChoicePolicy::AlwaysFirst)
    }
}

impl HeadlessInputScheduler {
    /// Build a scheduler driving choices by `policy`.
    pub fn new(policy: HeadlessChoicePolicy) -> Self {
        Self {
            policy,
            choice_cursor: 0,
            pauses_advanced: 0,
            choices_made: 0,
            other_advanced: 0,
        }
    }

    /// Number of pause / wait-for-click yields auto-dismissed so far.
    pub fn pauses_advanced(&self) -> u64 {
        self.pauses_advanced
    }

    /// Number of choice prompts resolved so far.
    pub fn choices_made(&self) -> u64 {
        self.choices_made
    }

    /// Number of other (non-pause, non-select) longops auto-resumed.
    pub fn other_advanced(&self) -> u64 {
        self.other_advanced
    }
}

impl LongOpScheduler for HeadlessInputScheduler {
    fn poll(&mut self, head: &mut LongOp) -> LongOpReadiness {
        match head.private_state.first().copied() {
            Some(PAUSE_PRIVATE_STATE_MAGIC) => {
                // Auto-dismiss the pause and resume.
                if let Ok(mut pause) = PauseLongOp::try_from_longop(head) {
                    pause.mark_dismissed();
                    let dismissed = pause.into_longop();
                    head.private_state = dismissed.private_state;
                }
                self.pauses_advanced = self.pauses_advanced.saturating_add(1);
                LongOpReadiness::Ready
            }
            Some(SELECT_PRIVATE_STATE_MAGIC) => {
                if let Ok(mut select) = SelectLongOp::try_from_longop(head) {
                    let index = self
                        .policy
                        .resolve(self.choice_cursor, select.choice_count());
                    select.choose(index);
                    let LongOp { id, private_state } = select.into_longop();
                    head.id = id;
                    head.private_state = private_state;
                    self.choice_cursor += 1;
                    self.choices_made = self.choices_made.saturating_add(1);
                } else {
                    // A select-magic payload that will not decode is
                    // malformed; resume anyway (the VM emits a typed
                    // ChoiceResumeMalformed warning) so the headless walk
                    // never deadlocks on it.
                    self.other_advanced = self.other_advanced.saturating_add(1);
                }
                LongOpReadiness::Ready
            }
            Some(OBJECT_SELECT_PRIVATE_STATE_MAGIC) => {
                if let Ok(mut select) = ObjectSelectLongOp::try_from_longop(head) {
                    let index = self
                        .policy
                        .resolve(self.choice_cursor, select.choice_count());
                    select.select(index);
                    let LongOp { id, private_state } = select.into_longop();
                    head.id = id;
                    head.private_state = private_state;
                    self.choice_cursor += 1;
                    self.choices_made = self.choices_made.saturating_add(1);
                } else {
                    self.other_advanced = self.other_advanced.saturating_add(1);
                }
                LongOpReadiness::Ready
            }
            _ => {
                self.other_advanced = self.other_advanced.saturating_add(1);
                LongOpReadiness::Ready
            }
        }
    }
}
