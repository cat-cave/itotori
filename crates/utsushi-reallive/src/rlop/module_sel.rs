//! UTSUSHI-211 — RealLive `module_sel` (choice / selection) RLOperation
//! family.
//!
//! Implements the four choice opcodes RealLive's `module_sel` exposes:
//! `select`, `select_s`, `select_w`, `select_objbtn`. Each opcode yields a
//! [`crate::rlop::longops::SelectLongOp`] carrier whose private state
//! holds the choice byte strings and a pending chosen-index sentinel.
//! The substrate's [`crate::rlop::LongOpScheduler`] decides when the
//! head longop becomes `Ready` — the [`ChoiceInputScheduler`] this module
//! ships flips `Ready` once an [`InputEvent::Choice`]
//! ([`utsushi_core::substrate::ChoiceIndex`]) is fed through
//! [`ChoiceInputScheduler::record_choice`].
//!
//! On resume, the VM's [`crate::vm::Vm::step`] decodes the popped longop's
//! private state and writes the chosen index into the store register
//! (`vm.banks().store()`), keeping the longop coupling honest: the audit
//! focus pinned by UTSUSHI-211 ("Longop coupling — the longop must use
//! the substrate scheduler, not a private wait loop") is enforced
//! structurally — there is no per-op wait loop, the chosen index lives
//! on the scheduler until the substrate poll returns `Ready`, and the
//! store-register write happens through the same dispatch path as every
//! other substrate effect.
//!
//! # Module addressing
//!
//! The choice family lives at `(module_type=1, module_id=5)` per the
//! Sweetie HD scene 1 byte observation that pinned `(1, 5, opcode=120)`
//! at offset `0x001e` as a `select_w`-shaped Command (see
//! `RealLive encryption research notes` §4.2).
//! The four canonical opcodes are pinned at the small-block layout
//! `0x0000..=0x0003` (matching the rlvm `module_sel.cc` registration
//! shape — re-derived clean-room from RLDEV docs, not vendored). The
//! Sweetie-HD-observed `select_w` byte (`0x0078 = 120`) is additionally
//! registered as an alias so the real-bytes path resolves through the
//! same op.
//!
//! # Opcode coverage
//!
//! | Opcode               | Variant   | Semantics                                |
//! | -------------------- | --------- | ---------------------------------------- |
//! | `0x0000` (`select`)  | basic     | Plain choice prompt.                     |
//! | `0x0001` (`select_s`)| stringy   | Choice with explicit string-table args.  |
//! | `0x0002` (`select_w`)| windowed  | Choice rendered into a window slot.      |
//! | `0x0003` (`select_objbtn`) | objbtn | Choice driven by object-button sprites. |
//! | `0x0078` (alias)     | alias     | Sweetie HD's observed `select_w` byte.   |
//!
//! Every variant yields the same [`SelectLongOp`] carrier — the variant
//! distinction lives in the [`SelectVariant`] enum so audit tooling can
//! pin which opcode produced the queued longop without scraping the
//! private-state bytes.
//!
//! # Substrate-honesty posture
//!
//! - **No private wait loop.** Each op yields a typed
//!   [`DispatchOutcome::Yield`] carrying the [`SelectLongOp`]. The VM
//!   suspends through the substrate's longop queue + scheduler combo;
//!   no thread::sleep, no busy-poll, no host clock involvement.
//! - **Substrate input event.** The [`ChoiceInputScheduler`] consumes
//!   an [`InputEvent::Choice`] / [`ChoiceIndex`]; the engine port is
//!   the only path that calls `record_choice`.
//! - **Typed-resume store-register write.** The VM's step path decodes
//!   the popped longop's magic byte; the chosen index is written to
//!   `store_reg` via the typed `VarBanks::set_store` accessor.
//! - **Gameexe `SELBTN.NNN.*` styling.** Each emitted choice line is
//!   tagged with the styling fields the Gameexe defines for its index
//!   (e.g. `#SELBTN.000.*`). Missing entries fall back to a stable
//!   `choice:<idx>` text-surface label.
//!
//! # Tests
//!
//! - `choice_select_s_emits_three_options` (substrate ack): a synthetic
//!   `select_s` with three byte-string args emits 3 `TextLine` events
//!   (`text_surface = "choice:0/1/2"`) then suspends with a queued
//!   `SelectLongOp`.
//! - `choice_resume_writes_store_reg`: feeding `ChoiceIndex(1)` to the
//!   scheduler resumes the longop and writes `1` to the VM's store
//!   register; the pc advanced past the choice element on the original
//!   dispatch.

use std::sync::{Arc, Mutex};

use utsushi_core::substrate::{ChoiceIndex, EvidenceTier, TextLine, TextSurfaceSink};

use super::longops::{SELECT_PRIVATE_STATE_MAGIC, SelectLongOp};
use super::module_msg::LongOpIdSequence;
use super::{
    DispatchOutcome, ExprValue, LongOp, LongOpReadiness, LongOpScheduler, RLOperation, RlopKey,
    RlopRegistry,
};
use crate::gameexe::Gameexe;
use crate::vm::Vm;

/// `module_sel` module type byte. Pinned at the byte observed at
/// Sweetie HD scene 1 offset `0x001e` (`type=1`).
pub const SEL_MODULE_TYPE: u8 = 1;

/// `module_sel` module id byte. Pinned at the byte observed at Sweetie
/// HD scene 1 offset `0x001e` (`id=5`).
pub const SEL_MODULE_ID: u8 = 5;

// ---- Opcode numerics --------------------------------------------------

/// `module_sel` `select` opcode (basic choice).
pub const OPCODE_SELECT: u16 = 0x0000;
/// `module_sel` `select_s` opcode (string-table choice).
pub const OPCODE_SELECT_S: u16 = 0x0001;
/// `module_sel` `select_w` opcode (windowed choice).
pub const OPCODE_SELECT_W: u16 = 0x0002;
/// `module_sel` `select_objbtn` opcode (object-button choice).
pub const OPCODE_SELECT_OBJBTN: u16 = 0x0003;

/// Sweetie-HD-observed alias for `select_w`. Scene 1 offset `0x001e`
/// emits `(type=1, id=5, opcode=120)`. The alias is registered so
/// real-bytes dispatch resolves through the canonical
/// [`SelectWOp`] without re-parsing the bytecode.
pub const OPCODE_SELECT_W_SWEETIE_HD_ALIAS: u16 = 120;

/// Stable enum naming the four choice variants. Used by the typed
/// dispatch path (and by audit tooling) to pin which opcode produced a
/// queued longop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SelectVariant {
    /// `select`.
    Select,
    /// `select_s`.
    SelectS,
    /// `select_w`.
    SelectW,
    /// `select_objbtn`.
    SelectObjbtn,
}

impl SelectVariant {
    /// All four variants. Pinned so audit tooling can assert the
    /// registry covers every variant without re-walking the
    /// registration helper.
    pub const ALL: &'static [SelectVariant] = &[
        Self::Select,
        Self::SelectS,
        Self::SelectW,
        Self::SelectObjbtn,
    ];

    /// Canonical opcode byte for this variant.
    pub fn opcode(self) -> u16 {
        match self {
            Self::Select => OPCODE_SELECT,
            Self::SelectS => OPCODE_SELECT_S,
            Self::SelectW => OPCODE_SELECT_W,
            Self::SelectObjbtn => OPCODE_SELECT_OBJBTN,
        }
    }

    /// Composite registry key the VM uses to dispatch this variant.
    pub fn rlop_key(self) -> RlopKey {
        RlopKey::new(SEL_MODULE_TYPE, SEL_MODULE_ID, self.opcode())
    }

    /// Stable lowercase tag for diagnostics / `text_surface` annotations.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Select => "sel.select",
            Self::SelectS => "sel.select_s",
            Self::SelectW => "sel.select_w",
            Self::SelectObjbtn => "sel.select_objbtn",
        }
    }
}

/// Number of `(module_sel)` rlops [`register_sel_rlops`] populates.
/// Four canonical variants plus one Sweetie-HD-observed alias for
/// `select_w` (opcode `120`). Pinned so audit tooling can assert
/// "registry covers exactly the UTSUSHI-211 surface".
pub const SEL_RLOP_COUNT: usize = SelectVariant::ALL.len() + 1;

/// Runtime carrier the per-op [`RLOperation`] impls thread through to
/// the [`TextSurfaceSink`], the [`Gameexe`] (for `SELBTN.NNN.*`
/// styling), and the shared [`LongOpIdSequence`]. Held inside `Arc` so
/// the registry's `Arc<dyn RLOperation>` entries can clone cheaply;
/// interior mutability is delegated to a `Mutex` so the `Send + Sync`
/// contract holds.
pub struct SelRuntime {
    sink: Arc<dyn TextSurfaceSink>,
    id_sequence: Arc<LongOpIdSequence>,
    gameexe: Option<Arc<Gameexe>>,
    inner: Mutex<SelRuntimeInner>,
}

#[derive(Debug, Default)]
struct SelRuntimeInner {
    /// Counter the runtime uses to disambiguate `line_id` strings on
    /// the [`TextLine`] surface. Increments on every emission.
    next_line_seq: u64,
    /// Fail-soft warnings the runtime records when an opcode's arg
    /// shape does not match the declared contract. Drained via
    /// [`SelRuntime::take_warnings`].
    warnings: Vec<SelRuntimeWarning>,
}

/// Typed warning the [`SelRuntime`] records on a sink failure or a
/// malformed-arg observation. The VM does not consume this — callers
/// drain the queue at a cadence of their choosing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelRuntimeWarning {
    /// A typed [`TextSurfaceSink::emit_line`] call returned an error.
    SinkRejected {
        /// Variant whose emission was rejected.
        variant: SelectVariant,
        /// Sink-side error message.
        reason: String,
    },
    /// An opcode received an argument byte string that could not be
    /// decoded from Shift-JIS without errors.
    InvalidShiftJis {
        /// Variant that observed the byte string.
        variant: SelectVariant,
        /// Choice index (0-based) where the decode failed.
        choice_index: usize,
    },
    /// An opcode expected a particular arg shape but received a
    /// different one (e.g. `Int` where `Bytes` was expected).
    ArgShapeMismatch {
        /// Variant that observed the mismatched arg shape.
        variant: SelectVariant,
        /// Choice index (0-based) where the mismatch happened.
        choice_index: usize,
        /// Stable string naming what the opcode expected.
        expected: &'static str,
    },
    /// An opcode received no arguments where at least one was
    /// expected.
    MissingChoices {
        /// Variant that observed the missing args.
        variant: SelectVariant,
    },
}

impl std::fmt::Debug for SelRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SelRuntime")
            .field("has_gameexe", &self.gameexe.is_some())
            .finish()
    }
}

impl SelRuntime {
    /// Build a runtime backed by `sink` and the shared `id_sequence`.
    /// Pass `gameexe = None` when no `Gameexe.ini` is available — the
    /// emitted lines fall back to a stable `choice:<idx>` text-surface
    /// label.
    pub fn new(
        sink: Arc<dyn TextSurfaceSink>,
        id_sequence: Arc<LongOpIdSequence>,
        gameexe: Option<Arc<Gameexe>>,
    ) -> Self {
        Self {
            sink,
            id_sequence,
            gameexe,
            inner: Mutex::new(SelRuntimeInner::default()),
        }
    }

    /// Construct a runtime with a fresh id sequence and no Gameexe.
    /// Convenience for synthetic tests where the SELBTN styling path is
    /// exercised through [`SelRuntime::with_gameexe`] instead.
    pub fn with_sink(sink: Arc<dyn TextSurfaceSink>) -> Self {
        Self::new(sink, Arc::new(LongOpIdSequence::new()), None)
    }

    /// Construct a runtime carrying a `Gameexe` reference. Used by
    /// `register_sel_rlops` callers that want SELBTN.NNN.* styling
    /// surfaced on the emitted choice lines.
    pub fn with_gameexe(sink: Arc<dyn TextSurfaceSink>, gameexe: Arc<Gameexe>) -> Self {
        Self::new(sink, Arc::new(LongOpIdSequence::new()), Some(gameexe))
    }

    /// Borrow the sink.
    pub fn sink(&self) -> &Arc<dyn TextSurfaceSink> {
        &self.sink
    }

    /// Borrow the id sequence.
    pub fn id_sequence(&self) -> &Arc<LongOpIdSequence> {
        &self.id_sequence
    }

    /// Borrow the optional Gameexe.
    pub fn gameexe(&self) -> Option<&Arc<Gameexe>> {
        self.gameexe.as_ref()
    }

    /// Drain the fail-soft warnings observed since the last call.
    pub fn take_warnings(&self) -> Vec<SelRuntimeWarning> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        std::mem::take(&mut guard.warnings)
    }

    fn record_warning(&self, warning: SelRuntimeWarning) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.warnings.push(warning);
    }

    fn next_line_id(&self) -> String {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let id = guard.next_line_seq;
        guard.next_line_seq = guard.next_line_seq.saturating_add(1);
        format!("utsushi-reallive-sel-line-{id:08x}")
    }

    /// Look up `SELBTN.{index:03}.*` entries in the Gameexe. Returns
    /// the concatenated dotted-path suffixes joined with `;` so the
    /// emitter can tag the text-surface label without a structured
    /// field on [`TextLine`]. Empty when no Gameexe or no matching
    /// entries.
    fn selbtn_style_suffix(&self, choice_index: usize) -> Option<String> {
        let gameexe = self.gameexe.as_ref()?;
        let prefix = format!("SELBTN.{choice_index:03}");
        let keys = gameexe.list_namespace(&prefix);
        if keys.is_empty() {
            return None;
        }
        let mut tags: Vec<String> = keys
            .into_iter()
            .map(|key| {
                let suffix = key.strip_prefix(&format!("{prefix}.")).unwrap_or(key);
                format!("selbtn={suffix}")
            })
            .collect();
        tags.sort();
        Some(tags.join(";"))
    }

    /// Emit `text` as one choice [`TextLine`]. The line carries
    /// `text_surface = "choice:<idx>"` (optionally suffixed with the
    /// SELBTN styling tags when the Gameexe exposes them). Sink-side
    /// errors are recorded as fail-soft warnings.
    fn emit_choice(&self, variant: SelectVariant, choice_index: usize, text: String) {
        let line_id = self.next_line_id();
        let text_surface = match self.selbtn_style_suffix(choice_index) {
            Some(suffix) => format!("choice:{choice_index};{suffix}"),
            None => format!("choice:{choice_index}"),
        };
        let line = TextLine {
            line_id,
            evidence_tier: EvidenceTier::E1,
            text,
            speaker: None,
            text_surface: Some(text_surface),
            bridge_ref: None,
            source_asset: None,
        };
        if let Err(err) = self.sink.emit_line(line) {
            self.record_warning(SelRuntimeWarning::SinkRejected {
                variant,
                reason: err.to_string(),
            });
        }
    }
}

fn decode_shift_jis(bytes: &[u8]) -> Result<String, ()> {
    let (cow, _encoding, had_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
    if had_errors {
        Err(())
    } else {
        Ok(cow.into_owned())
    }
}

/// Shared dispatch body for the four variants. Each variant is its own
/// [`RLOperation`] impl so the registry key (and the
/// [`SelectVariant`] discriminant tag) names the entry point; the
/// dispatch body lives here so the four impls stay synchronised.
fn dispatch_select(
    variant: SelectVariant,
    runtime: &SelRuntime,
    _vm: &mut Vm,
    args: &[ExprValue],
) -> DispatchOutcome {
    let mut choices: Vec<Vec<u8>> = Vec::with_capacity(args.len());
    for (idx, arg) in args.iter().enumerate() {
        let bytes = match arg {
            ExprValue::Bytes(bytes) => bytes.clone(),
            ExprValue::Int(_) => {
                // A skipped Int never becomes a stored choice, so the raw
                // arg position `idx` is the only meaningful pointer to the
                // offending arg in the source list.
                runtime.record_warning(SelRuntimeWarning::ArgShapeMismatch {
                    variant,
                    choice_index: idx,
                    expected: "bytes",
                });
                continue;
            }
        };
        // The emitted `choice:<idx>` surface (and SELBTN styling) must use
        // the stored `choices` Vec position, not the raw arg index: that
        // Vec position is what `SelectLongOp::choose` / `set_store` index
        // into when the user picks. With non-Bytes args interleaved the two
        // diverge, so derive the index from the contiguous choices length.
        let choice_index = choices.len();
        let text = if let Ok(text) = decode_shift_jis(&bytes) {
            text
        } else {
            runtime.record_warning(SelRuntimeWarning::InvalidShiftJis {
                variant,
                choice_index,
            });
            String::from_utf8_lossy(&bytes).into_owned()
        };
        runtime.emit_choice(variant, choice_index, text);
        choices.push(bytes);
    }
    if args.is_empty() {
        runtime.record_warning(SelRuntimeWarning::MissingChoices { variant });
    }
    let id = runtime.id_sequence().allocate();
    let select = SelectLongOp::new(id, choices);
    let LongOp { id, private_state } = select.into_longop();
    DispatchOutcome::Yield {
        longop_id: id,
        private_state,
    }
}

/// `select` — basic choice prompt. Each arg is a Shift-JIS choice
/// label.
#[derive(Debug)]
pub struct SelectOp {
    runtime: Arc<SelRuntime>,
}

impl SelectOp {
    /// Build the op against a shared [`SelRuntime`].
    pub fn new(runtime: Arc<SelRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for SelectOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        dispatch_select(SelectVariant::Select, &self.runtime, vm, args)
    }
}

/// `select_s` — choice with explicit string-table args. Same byte-
/// string shape as [`SelectOp`]; the variant exists so audit tooling
/// can pin which opcode produced the queued longop.
#[derive(Debug)]
pub struct SelectSOp {
    runtime: Arc<SelRuntime>,
}

impl SelectSOp {
    pub fn new(runtime: Arc<SelRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for SelectSOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        dispatch_select(SelectVariant::SelectS, &self.runtime, vm, args)
    }
}

/// `select_w` — windowed choice. Same arg shape as [`SelectOp`].
#[derive(Debug)]
pub struct SelectWOp {
    runtime: Arc<SelRuntime>,
}

impl SelectWOp {
    pub fn new(runtime: Arc<SelRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for SelectWOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        dispatch_select(SelectVariant::SelectW, &self.runtime, vm, args)
    }
}

/// `select_objbtn` — object-button choice. Same arg shape as
/// [`SelectOp`].
#[derive(Debug)]
pub struct SelectObjbtnOp {
    runtime: Arc<SelRuntime>,
}

impl SelectObjbtnOp {
    pub fn new(runtime: Arc<SelRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for SelectObjbtnOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        dispatch_select(SelectVariant::SelectObjbtn, &self.runtime, vm, args)
    }
}

/// Mount every choice op this module ships into `registry`. Returns
/// the number of entries registered (matches [`SEL_RLOP_COUNT`]).
///
/// The four canonical variants are registered at `0x0000..=0x0003`;
/// the Sweetie-HD-observed `select_w` alias (`0x0078 = 120`) is
/// registered as a duplicate pointing at [`SelectWOp`].
pub fn register_sel_rlops(registry: &mut RlopRegistry, runtime: Arc<SelRuntime>) -> usize {
    registry.register(
        SelectVariant::Select.rlop_key(),
        Arc::new(SelectOp::new(Arc::clone(&runtime))),
    );
    registry.register(
        SelectVariant::SelectS.rlop_key(),
        Arc::new(SelectSOp::new(Arc::clone(&runtime))),
    );
    registry.register(
        SelectVariant::SelectW.rlop_key(),
        Arc::new(SelectWOp::new(Arc::clone(&runtime))),
    );
    registry.register(
        SelectVariant::SelectObjbtn.rlop_key(),
        Arc::new(SelectObjbtnOp::new(Arc::clone(&runtime))),
    );
    registry.register(
        RlopKey::new(
            SEL_MODULE_TYPE,
            SEL_MODULE_ID,
            OPCODE_SELECT_W_SWEETIE_HD_ALIAS,
        ),
        Arc::new(SelectWOp::new(Arc::clone(&runtime))),
    );
    SEL_RLOP_COUNT
}

// ---------------------------------------------------------------------
// Choice-input scheduler
// ---------------------------------------------------------------------

/// Substrate [`LongOpScheduler`] that resumes a queued
/// [`SelectLongOp`] once an [`InputEvent::Choice`] has been recorded
/// through [`ChoiceInputScheduler::record_choice`].
///
/// The scheduler holds the pending [`ChoiceIndex`] internally. On
/// `poll`, it rewrites the head longop's private state so the chosen
/// index lands in the `SELECT_PRIVATE_STATE_MAGIC` payload before
/// returning [`LongOpReadiness::Ready`]. The VM's `step` path then
/// decodes the chosen index from the popped longop and writes it into
/// the store register via [`crate::vm::Vm::apply_choice_resume`].
///
/// The scheduler is the only path that translates an
/// [`InputEvent::Choice`] into a VM-visible store-register write — no
/// private wait loop, no host-clock dependency, no opcode-side mutation.
#[derive(Debug, Default)]
pub struct ChoiceInputScheduler {
    pending: Mutex<Option<ChoiceIndex>>,
}

impl ChoiceInputScheduler {
    /// Construct a scheduler with no pending choice. The substrate poll
    /// returns `Pending` until [`record_choice`] is called.
    ///
    /// [`record_choice`]: ChoiceInputScheduler::record_choice
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the user's choice. The next [`LongOpScheduler::poll`]
    /// will return [`LongOpReadiness::Ready`] after rewriting the head
    /// longop's private state.
    pub fn record_choice(&self, index: ChoiceIndex) {
        let mut guard = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *guard = Some(index);
    }

    /// Borrow the pending choice (if any). Exposed for tests that want
    /// to assert "no choice yet recorded" without forcing a poll.
    pub fn pending(&self) -> Option<ChoiceIndex> {
        let guard = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *guard
    }
}

impl LongOpScheduler for ChoiceInputScheduler {
    fn poll(&mut self, head: &mut LongOp) -> LongOpReadiness {
        let pending = {
            let guard = self
                .pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *guard
        };
        let Some(index) = pending else {
            return LongOpReadiness::Pending;
        };
        // Only rewrite the head if it carries a SelectLongOp payload.
        // Other longop shapes pass through untouched.
        if head.private_state.first() != Some(&SELECT_PRIVATE_STATE_MAGIC) {
            return LongOpReadiness::Pending;
        }
        // Decode -> mutate chosen -> re-encode.
        match SelectLongOp::try_from_longop(head) {
            Ok(mut select) => {
                select.choose(index.get());
                let LongOp { id, private_state } = select.into_longop();
                head.id = id;
                head.private_state = private_state;
                LongOpReadiness::Ready
            }
            Err(_) => {
                // Malformed select payload — leave the longop alone
                // and stay pending so the audit trail names the
                // mismatch (the VM emits a typed warning on resume).
                LongOpReadiness::Pending
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use utsushi_core::substrate::{SinkCapability, SinkResult};

    use super::*;
    use crate::var_banks::VarBanks;

    struct CollectingSink {
        lines: Mutex<Vec<TextLine>>,
    }

    impl CollectingSink {
        fn new() -> Self {
            Self {
                lines: Mutex::new(Vec::new()),
            }
        }
    }

    impl TextSurfaceSink for CollectingSink {
        fn capability(&self) -> SinkCapability {
            SinkCapability::Supported {
                evidence_tier_ceiling: EvidenceTier::E1,
            }
        }

        fn emit_line(&self, line: TextLine) -> SinkResult<()> {
            line.validate()?;
            self.lines.lock().expect("lock").push(line);
            Ok(())
        }
    }

    #[test]
    fn select_variant_all_covers_four_variants() {
        assert_eq!(SelectVariant::ALL.len(), 4);
    }

    #[test]
    fn register_sel_rlops_populates_expected_count() {
        let sink = Arc::new(CollectingSink::new());
        let runtime = Arc::new(SelRuntime::with_sink(sink));
        let mut registry = RlopRegistry::new();
        let count = register_sel_rlops(&mut registry, runtime);
        assert_eq!(count, SEL_RLOP_COUNT);
        assert_eq!(registry.len(), SEL_RLOP_COUNT);
    }

    #[test]
    fn register_sel_rlops_covers_every_variant_and_alias() {
        let sink = Arc::new(CollectingSink::new());
        let runtime = Arc::new(SelRuntime::with_sink(sink));
        let mut registry = RlopRegistry::new();
        register_sel_rlops(&mut registry, runtime);
        for variant in SelectVariant::ALL {
            assert!(
                registry.get(variant.rlop_key()).is_some(),
                "missing variant: {variant:?}"
            );
        }
        let alias_key = RlopKey::new(
            SEL_MODULE_TYPE,
            SEL_MODULE_ID,
            OPCODE_SELECT_W_SWEETIE_HD_ALIAS,
        );
        assert!(registry.get(alias_key).is_some());
    }

    #[test]
    fn variant_str_pin() {
        assert_eq!(SelectVariant::Select.as_str(), "sel.select");
        assert_eq!(SelectVariant::SelectS.as_str(), "sel.select_s");
        assert_eq!(SelectVariant::SelectW.as_str(), "sel.select_w");
        assert_eq!(SelectVariant::SelectObjbtn.as_str(), "sel.select_objbtn");
    }

    #[test]
    fn choice_input_scheduler_starts_pending() {
        let scheduler = ChoiceInputScheduler::new();
        assert_eq!(scheduler.pending(), None);
    }

    #[test]
    fn choice_input_scheduler_flips_to_ready_after_record_choice() {
        use crate::rlop::LongOpId;
        let mut scheduler = ChoiceInputScheduler::new();
        let select = SelectLongOp::new(LongOpId(7), vec![b"a".to_vec(), b"b".to_vec()]);
        let mut head = select.into_longop();
        // No choice yet — pending.
        assert_eq!(
            scheduler.poll(&mut head),
            LongOpReadiness::Pending,
            "pending without recorded choice"
        );
        scheduler.record_choice(ChoiceIndex(1));
        assert_eq!(
            scheduler.poll(&mut head),
            LongOpReadiness::Ready,
            "ready after record_choice"
        );
        // The head's private state now carries chosen=1.
        let decoded = SelectLongOp::try_from_longop(&head).expect("decode");
        assert_eq!(decoded.chosen(), Some(1));
    }

    #[test]
    fn choice_input_scheduler_ignores_non_select_longops() {
        use crate::rlop::{LongOp, LongOpId};
        let mut scheduler = ChoiceInputScheduler::new();
        scheduler.record_choice(ChoiceIndex(0));
        let mut head = LongOp::new(
            LongOpId(1),
            vec![0xFF, 0x00, 0x00], // non-magic prefix
        );
        assert_eq!(scheduler.poll(&mut head), LongOpReadiness::Pending);
    }

    #[test]
    fn selbtn_style_suffix_returns_none_when_no_gameexe() {
        let sink = Arc::new(CollectingSink::new());
        let runtime = SelRuntime::with_sink(sink);
        assert!(runtime.selbtn_style_suffix(0).is_none());
    }

    #[test]
    fn interleaved_int_arg_keeps_emitted_index_aligned_with_choices_vec() {
        // Args: Bytes("A"), Int(7), Bytes("B"). The Int is skipped from the
        // stored `choices` Vec, so the two surviving choices occupy Vec
        // positions 0 and 1. The emitted `choice:<idx>` surfaces must name
        // those contiguous positions (0, 1) — NOT the raw arg indices
        // (0, 2) — so a user pick routed through `SelectLongOp::choose` /
        // `set_store` lands on the matching stored entry.
        let sink = Arc::new(CollectingSink::new());
        let runtime = Arc::new(SelRuntime::with_sink(
            Arc::clone(&sink) as Arc<dyn TextSurfaceSink>
        ));
        let op = SelectOp::new(Arc::clone(&runtime));

        let outcome = op.dispatch(
            &mut Vm::new(1, 0),
            &[
                ExprValue::Bytes(b"A".to_vec()),
                ExprValue::Int(7),
                ExprValue::Bytes(b"B".to_vec()),
            ],
        );

        // Emitted surfaces name the contiguous choices-Vec positions.
        let lines = sink.lines.lock().expect("lock");
        let surfaces: Vec<Option<&str>> = lines
            .iter()
            .map(|line| line.text_surface.as_deref())
            .collect();
        assert_eq!(
            surfaces,
            vec![Some("choice:0"), Some("choice:1")],
            "emitted indices must be contiguous choices-Vec positions, not raw arg indices"
        );
        let texts: Vec<&str> = lines.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(texts, vec!["A", "B"]);

        // The yielded SelectLongOp stores exactly the two Bytes choices, so
        // index 1 (the emitted "choice:1") decodes back to "B".
        let DispatchOutcome::Yield {
            longop_id,
            private_state,
        } = outcome
        else {
            panic!("select must yield a longop");
        };
        let head = LongOp {
            id: longop_id,
            private_state,
        };
        let select = SelectLongOp::try_from_longop(&head).expect("decode select payload");
        assert_eq!(select.choices(), &[b"A".to_vec(), b"B".to_vec()]);

        // The skipped Int is reported against its raw arg position (1).
        let warnings = runtime.take_warnings();
        assert_eq!(
            warnings,
            vec![SelRuntimeWarning::ArgShapeMismatch {
                variant: SelectVariant::Select,
                choice_index: 1,
                expected: "bytes",
            }]
        );
    }

    #[test]
    fn varbanks_store_pin() {
        // Compile-level guard that `VarBanks::set_store` exists with
        // a u32 signature — the VM resume path depends on it.
        let mut banks = VarBanks::new();
        banks.set_store(0xABCD);
        assert_eq!(banks.store(), 0xABCD);
    }
}
