//! RealLive `module_sel` (choice / selection) RLOperation
//! family.
//!
//! Implements the EXACT rlvm `Sel`-module opcode set `{0,1,2,3,4,14,20}`:
//! the SELECT ops `select`, `select_s`, `select_w`, `select_s` (opcode `3`)
//! `select_objbtn`, `select_objbtn_cancel` plus the `objbtn_init` setup op.
//! Each SELECT opcode yields a
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
//! focus pinned by ("Longop coupling — the longop must use
//! the substrate scheduler, not a private wait loop") is enforced
//! structurally — there is no per-op wait loop, the chosen index lives
//! on the scheduler until the substrate poll returns `Ready`, and the
//! store-register write happens through the same dispatch path as every
//! other substrate effect.
//!
//! # Module addressing
//!
//! The choice family lives at `(module_type=0, module_id=2)`, matching the
//! RealLive `Sel` module and the decompiler. Real bytecode validates
//! `select_w` at `(0,2,2)` and button-object selection at `(0,2,4)`.
//! Registering this family at `module_type=0` is essential: a wrong module
//! type leaves recognized selects gap-filled as `Advance` no-ops.
//!
//! The registered opcode set is EXACTLY rlvm's `Sel` module `{0,1,2,3,4,14,20}`
//! (verified against `rlvm/src/src/modules/module_sel.cc` — see below); there
//! is no synthetic opcode `120` (rlvm registers no such opcode and no real
//! corpus tuple lands on `(0,2,120)`).
//!
//! NOTE (pre-existing `0/1/2` naming, out of this node's scope): the port's
//! variant NAMES for opcodes `0/1/2` (`select` / `select_s` / `select_w`) do
//! NOT line up with rlvm's `module_sel.cc` labels (`0`=`select_w`, `1`=`select`
//! `2`=`select_s2`, `3`=`select_s`). The opcode NUMBERS registered are what
//! matters for dispatch; every port SELECT opcode funnels through the same
//! [`SelectLongOp`] carrier, so the label mismatch is cosmetic. This node
//! adds opcodes `3` + `14` to reach exact rlvm coverage and does not re-label
//! `0/1/2` (that would churn the real-bytes-anchored `select_w`=`(0,2,2)`
//! documentation and is tracked separately).
//!
//! # Opcode coverage (rlvm `SelModule` — `module_sel.cc`)
//!
//! Opcode | rlvm name | Port variant
//! ------ | ---------------------- | ----------------------------------
//! `0` | `select_w` | [`SelectVariant::Select`]
//! `1` | `select` | [`SelectVariant::SelectS`]
//! `2` | `select_s2` | [`SelectVariant::SelectW`]
//! `3` | `select_s` | [`SelectVariant::SelectS3`]
//! `4` | `select_objbtn` | [`SelectVariant::SelectObjbtn`]
//! `14` | `select_objbtn_cancel` | [`SelectVariant::SelectObjbtnCancel`]
//! `20` | `objbtn_init` | [`ObjbtnInitOp`] (setup, not a select)
//!
//! # Button-object presentation
//!
//! A `select_objbtn` prompt captures each foreground button's image reference,
//! transform, and hit rectangle from the decoded graphics state. The render
//! path uses that metadata directly. It never chooses a pair, strip, or grid
//! from the number of buttons.
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

use utsushi_core::substrate::{EvidenceTier, TextLine, TextSurfaceSink};

use super::longops::{ObjectSelectLongOp, ObjectSelectLongOpBuildError, SelectLongOp};
use super::module_msg::LongOpIdSequence;
pub use super::selection_prompt::SelectionPrompt;
use super::{DispatchOutcome, ExprValue, LongOp, RLOperation, RlopKey, RlopRegistry};
use crate::gameexe::Gameexe;
use crate::graphics_objects::{GraphicsObject, GraphicsObjectKind, HitRegion};
use crate::render_pipeline::{ObjectButtonChoiceOption, ObjectButtonChoiceWindowBuildError};
use crate::rlop::module_obj::GraphicsRuntime;
use crate::vm::Vm;

mod scheduler;

pub use self::scheduler::ChoiceInputScheduler;

/// `module_sel` module type byte. The real RealLive `Sel` module uses
/// `module_type = 0`; observed `select_w` commands are `(0,2,2)`.
pub const SEL_MODULE_TYPE: u8 = 0;

/// `module_sel` module id byte. This is the REAL RealLive semantic id
/// `2` used by the `kaifuu-reallive` decompiler
/// (`opcode::module_id::SEL`) and validated on real bytecode.
pub const SEL_MODULE_ID: u8 = 2;

/// `module_sel` `select` opcode (basic choice).
pub const OPCODE_SELECT: u16 = 0x0000;
/// `module_sel` `select_s` opcode (string-table choice).
pub const OPCODE_SELECT_S: u16 = 0x0001;
/// `module_sel` `select_w` opcode (windowed choice).
pub const OPCODE_SELECT_W: u16 = 0x0002;
/// `module_sel` `select_s` opcode (string-table choice, rlvm opcode `3`).
///
/// REAL RealLive value `3` — rlvm `module_sel.cc` `AddOpcode(3, 0, "select_s"
/// new Sel_select_s)`, which pushes the same `ButtonSelectLongOperation` as the
/// `select_s2` opcode (`2`). In this port that is the ordinary text-choice
/// [`dispatch_select`] carrier: `select_s` reads its option labels from the
/// scene's string table and yields a [`SelectLongOp`] like every other text
/// select. Registering it closes the oracle-coverage gap — rlvm's `Sel` module
/// registers `{0,1,2,3,4,14,20}` and this opcode `3` was previously unhandled
/// (no variant at all). It is an oracle-faithfulness registration rather than
/// a corpus-driven one. Distinct from the port's opcode-`1`
/// [`OPCODE_SELECT_S`]; see the module note on the pre-existing `0/1/2` naming.
pub const OPCODE_SELECT_S3: u16 = 0x0003;
/// `module_sel` `select_objbtn` opcode (object-button choice). REAL RealLive
/// value `4` (rlvm `module_sel.cc` — `AddOpcode(4, 0, "select_objbtn")`). It
/// selects on-screen button objects and carries no inline option block.
pub const OPCODE_SELECT_OBJBTN: u16 = 0x0004;
/// `module_sel` `objbtn_init` opcode (button-object group setup). REAL
/// RealLive value `20` (rlvm `AddOpcode(20, *, "objbtn_init")`). It
/// initialises the button-object group a following `select_objbtn` selects.
pub const OPCODE_OBJBTN_INIT: u16 = 20;
/// `module_sel` `select_objbtn_cancel` opcode (cancelable button-object
/// select). REAL RealLive value `14` — rlvm `module_sel.cc` `AddOpcode(14, 0
/// "select_objbtn_cancel", new Sel_select_objbtn_cancel_0)` (and its
/// two-arg `_1` overload): it pushes the SAME `ButtonObjectSelectLongOperation`
/// as `select_objbtn` (`4`) but calls `set_cancelable()` so the user may escape
/// the prompt. [`SelectObjbtnCancelOp`] creates a cancelable A3 carrier
/// over the same foreground bindings as opcode `4`; only the exact Raw
/// secondary-release input token cancels it. Other cancel/input affordances
/// remain outside this opcode path. This is a real Sel operation, not an
/// unimplemented-command fallback.
pub const OPCODE_SELECT_OBJBTN_CANCEL: u16 = 14;

/// Stable enum naming the select-family variants. Used by the typed
/// dispatch path (and by audit tooling) to pin which opcode produced a
/// queued longop. Covers the rlvm `Sel`-module SELECT opcodes that yield a
/// choice/longop (`{0,1,2,3,4,14}`); the `objbtn_init` (`20`) setup boundary
/// is not a select and is handled by [`ObjbtnInitOp`] instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SelectVariant {
    /// `select` (opcode `0`).
    Select,
    /// `select_s` (opcode `1`).
    SelectS,
    /// `select_w` (opcode `2`).
    SelectW,
    /// `select_s` string-table select at rlvm opcode `3` ([`OPCODE_SELECT_S3`]).
    SelectS3,
    /// `select_objbtn` (opcode `4`).
    SelectObjbtn,
    /// `select_objbtn_cancel` (opcode `14`) — the cancelable button-object
    /// select ([`OPCODE_SELECT_OBJBTN_CANCEL`]).
    SelectObjbtnCancel,
}

impl SelectVariant {
    /// All select variants. Pinned so audit tooling can assert the
    /// registry covers every variant without re-walking the
    /// registration helper.
    pub const ALL: &'static [SelectVariant] = &[
        Self::Select,
        Self::SelectS,
        Self::SelectW,
        Self::SelectS3,
        Self::SelectObjbtn,
        Self::SelectObjbtnCancel,
    ];

    /// Canonical opcode byte for this variant.
    pub fn opcode(self) -> u16 {
        match self {
            Self::Select => OPCODE_SELECT,
            Self::SelectS => OPCODE_SELECT_S,
            Self::SelectW => OPCODE_SELECT_W,
            Self::SelectS3 => OPCODE_SELECT_S3,
            Self::SelectObjbtn => OPCODE_SELECT_OBJBTN,
            Self::SelectObjbtnCancel => OPCODE_SELECT_OBJBTN_CANCEL,
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
            Self::SelectS3 => "sel.select_s3",
            Self::SelectObjbtn => "sel.select_objbtn",
            Self::SelectObjbtnCancel => "sel.select_objbtn_cancel",
        }
    }

    /// The canonical [`SelectionControl`] button-object setup opcodes. They
    /// identify scenes containing on-screen button groups; the prompt itself
    /// carries the placement and art metadata used for rendering.
    ///
    pub const BUTTON_OBJECT_SETUP_OPCODES: &'static [u16] = &[
        OPCODE_OBJBTN_INIT,
        OPCODE_SELECT_OBJBTN,
        OPCODE_SELECT_OBJBTN_CANCEL,
    ];
}

/// The real-bytes signal that a scene contains a button-object setup. It is
/// derived from [`SelectionControl`] setup ops around the select — see
/// [`SelectVariant::BUTTON_OBJECT_SETUP_OPCODES`] and
/// [`selection_control_signal`].
///
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionControlSignal {
    /// No button-object SelectionControl setup ops around the select — a
    /// plain text-window select.
    TextWindow,
    /// Button-object SelectionControl setup ops (`objbtn_init`
    /// `select_objbtn`) are present in the scene — the select is presented
    /// graphically, with on-screen button sprites.
    ButtonObject,
}

/// Derive the [`SelectionControlSignal`] for a select from the
/// `module_id == 2` opcodes that appear in its scene BEFORE it (or, for the
/// menu selects, anywhere the button-object group is set up). `preceding_sel_opcodes`
/// is the ordered list of `module_id == 2` command opcodes seen in the scene
/// up to and including the select's group. Returns [`SelectionControlSignal::ButtonObject`]
/// iff any [`SelectVariant::BUTTON_OBJECT_SETUP_OPCODES`] appears, else
/// [`SelectionControlSignal::TextWindow`].
///
/// This keys off the actual SelectionControl setup ops the RealLive bytecode
/// emits to place on-screen selection buttons.
pub fn selection_control_signal(
    sel_opcodes: impl IntoIterator<Item = u16>,
) -> SelectionControlSignal {
    if sel_opcodes
        .into_iter()
        .any(|op| SelectVariant::BUTTON_OBJECT_SETUP_OPCODES.contains(&op))
    {
        SelectionControlSignal::ButtonObject
    } else {
        SelectionControlSignal::TextWindow
    }
}

/// Number of `(module_sel)` rlops [`register_sel_rlops`] populates. The
/// six [`SelectVariant::ALL`] SELECT variants (opcodes `{0,1,2,3,4,14}`)
/// plus the `objbtn_init` (`20`) button-object group-setup op — the EXACT
/// rlvm `Sel`-module opcode set `{0,1,2,3,4,14,20}` and nothing else (no
/// synthetic opcode `120`). Pinned so audit tooling can assert "registry
/// covers exactly the rlvm `Sel` oracle surface".
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
    graphics: Option<Arc<GraphicsRuntime>>,
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
    prompts: Vec<SelectionPrompt>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectButtonPromptOption {
    pub display_index: u16,
    pub button_number: i32,
    pub fg_slot: usize,
    /// Exact top-level foreground state at prompt time. This snapshot does not
    /// resolve assets, infer bounds, or render pixels.
    pub visual_snapshot: GraphicsObject,
    pub candidate_scope: ObjectButtonCandidateScope,
    pub hit_region: ObjectButtonHitRegion,
}

impl ObjectButtonPromptOption {
    /// Convert this prompt snapshot to renderer input. A decoded rectangle and
    /// image reference are both mandatory; callers must explicitly handle
    /// unavailable metadata rather than receiving synthesized geometry.
    pub fn render_choice_option(
        &self,
    ) -> Result<ObjectButtonChoiceOption, ObjectButtonChoiceWindowBuildError> {
        let bounds = match self.hit_region {
            HitRegion::Known(bounds) => bounds,
            HitRegion::Unavailable(reason) => {
                return Err(ObjectButtonChoiceWindowBuildError::GeometryUnavailable {
                    display_index: self.display_index,
                    reason,
                });
            }
        };
        let GraphicsObjectKind::Image { image_ref } = &self.visual_snapshot.kind else {
            return Err(ObjectButtonChoiceWindowBuildError::NonImageArt {
                display_index: self.display_index,
            });
        };
        Ok(ObjectButtonChoiceOption {
            display_index: self.display_index,
            button_number: self.button_number,
            fg_slot: self.fg_slot,
            bounds,
            art: image_ref.clone(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectButtonCandidateScope {
    TopLevelForegroundOnly,
}

/// Prompt-time button hit geometry.  A known rectangle is derived from the
/// decoded g00 pattern geometry plus the object transform; unavailable is an
/// explicit metadata gap, never a request to synthesize a layout.
pub type ObjectButtonHitRegion = HitRegion;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectionPromptKind {
    Text,
    ObjectButtons {
        group: i32,
        options: Vec<ObjectButtonPromptOption>,
    },
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
    ObjectButtonRuntimeUnavailable {
        group: i32,
    },
    ObjectButtonCandidatesEmpty {
        group: i32,
    },
    ObjectButtonGroupArgsInvalid {
        observed: usize,
    },
    ObjectButtonCarrierTooLarge {
        observed: usize,
    },
    ObjectButtonCancelArgsInvalid {
        observed: usize,
    },
}

impl std::fmt::Debug for SelRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SelRuntime")
            .field("has_gameexe", &self.gameexe.is_some())
            .field("has_graphics", &self.graphics.is_some())
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
            graphics: None,
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

    pub fn with_graphics(sink: Arc<dyn TextSurfaceSink>, graphics: Arc<GraphicsRuntime>) -> Self {
        Self {
            sink,
            id_sequence: Arc::new(LongOpIdSequence::new()),
            gameexe: None,
            graphics: Some(graphics),
            inner: Mutex::new(SelRuntimeInner::default()),
        }
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

    pub fn graphics(&self) -> Option<&Arc<GraphicsRuntime>> {
        self.graphics.as_ref()
    }

    /// Drain the fail-soft warnings observed since the last call.
    pub fn take_warnings(&self) -> Vec<SelRuntimeWarning> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        std::mem::take(&mut guard.warnings)
    }

    pub fn take_prompts(&self) -> Vec<SelectionPrompt> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        std::mem::take(&mut guard.prompts)
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
    /// render-modality marker and the SELBTN styling tags when the
    /// Gameexe exposes them). Sink-side errors are recorded as fail-soft
    /// warnings.
    fn emit_choice(
        &self,
        variant: SelectVariant,
        choice_index: usize,
        text: String,
    ) -> Option<String> {
        let line_id = self.next_line_id();
        // Compose the choice surface from parts: the base `choice:<idx>`
        // (what `branch_following_lines` filters on) plus the optional Gameexe
        // `SELBTN.NNN.*` styling suffix. The render MODALITY (graphical
        // button-object vs. plain text list) is NOT a per-command property —
        // it is a SCENE-context property derived from the surrounding
        // [`SelectionControl`] button-setup ops (see
        // [`selection_control_signal`]), applied by the render / analysis
        // layer that has the whole scene, not by this single-command dispatch.
        //
        let mut text_surface = format!("choice:{choice_index}");
        if let Some(suffix) = self.selbtn_style_suffix(choice_index) {
            text_surface.push(';');
            text_surface.push_str(&suffix);
        }
        let line = TextLine {
            line_id: line_id.clone(),
            evidence_tier: EvidenceTier::E1,
            text,
            speaker: None,
            color: None,
            text_surface: Some(text_surface),
            bridge_ref: None,
            source_asset: None,
            byte_offset_in_scene: None,
            body_shift_jis: None,
        };
        match self.sink.emit_line(line) {
            Ok(()) => Some(line_id),
            Err(err) => {
                self.record_warning(SelRuntimeWarning::SinkRejected {
                    variant,
                    reason: err.to_string(),
                });
                None
            }
        }
    }

    fn record_prompt(&self, prompt: SelectionPrompt) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.prompts.push(prompt);
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
    vm: &mut Vm,
    args: &[ExprValue],
) -> DispatchOutcome {
    let mut choices: Vec<Vec<u8>> = Vec::with_capacity(args.len());
    let mut rendered: Vec<(usize, String)> = Vec::with_capacity(args.len());
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
        rendered.push((choice_index, text));
        choices.push(bytes);
    }
    if args.is_empty() {
        runtime.record_warning(SelRuntimeWarning::MissingChoices { variant });
    }
    // A select command that recovered ZERO choice labels is not a
    // presentable prompt — advance it instead of yielding an empty
    // SelectLongOp. Now that the family is registered at the REAL
    // `module_type=0`, this guard keeps the OTHER `(0, 2, x)` sel-family
    // opcodes that carry no inline `{ … }` option block (e.g. an
    // option-less `select_s` that reads from the string table, or a
    // selection-control op that slips through) fail-soft as `Advance` —
    // exactly as the opcode catalog gap-filled them before — rather than
    // parking a bogus empty choice that would inflate `choices_made` and
    // write a spurious `$store = 0`. Real `select_w (0, 2, 2)` prompts
    // always carry an option block, so they still yield + drive a branch.
    if choices.is_empty() {
        return DispatchOutcome::Advance;
    }
    let id = runtime.id_sequence().allocate();
    let option_line_ids: Vec<String> = rendered
        .into_iter()
        .filter_map(|(index, text)| runtime.emit_choice(variant, index, text))
        .collect();
    if option_line_ids.len() == choices.len() {
        runtime.record_prompt(SelectionPrompt {
            longop_id: id,
            byte_offset_in_scene: vm.pc(),
            kind: SelectionPromptKind::Text,
            cancelable: false,
            option_line_ids,
        });
    }
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

fn dispatch_select_objbtn(
    runtime: &SelRuntime,
    vm: &mut Vm,
    args: &[ExprValue],
) -> DispatchOutcome {
    let [ExprValue::Int(group)] = args else {
        runtime.record_warning(SelRuntimeWarning::ObjectButtonGroupArgsInvalid {
            observed: args.len(),
        });
        return DispatchOutcome::Advance;
    };
    dispatch_object_select(runtime, vm.pc(), *group, false)
}

fn dispatch_object_select(
    runtime: &SelRuntime,
    byte_offset_in_scene: u32,
    group: i32,
    cancelable: bool,
) -> DispatchOutcome {
    let Some(graphics) = runtime.graphics() else {
        runtime.record_warning(SelRuntimeWarning::ObjectButtonRuntimeUnavailable { group });
        return DispatchOutcome::Advance;
    };
    let candidates = graphics.foreground_button_candidates(group);
    if candidates.is_empty() {
        runtime.record_warning(SelRuntimeWarning::ObjectButtonCandidatesEmpty { group });
        return DispatchOutcome::Advance;
    }
    let return_values: Vec<i32> = candidates
        .iter()
        .map(|candidate| candidate.options.button_number)
        .collect();
    let mut select =
        match ObjectSelectLongOp::try_new(runtime.id_sequence().allocate(), return_values) {
            Ok(select) => select,
            Err(ObjectSelectLongOpBuildError::TooManyReturnValues { observed }) => {
                runtime.record_warning(SelRuntimeWarning::ObjectButtonCarrierTooLarge { observed });
                return DispatchOutcome::Advance;
            }
        };
    select.set_cancelable(cancelable);
    let LongOp { id, private_state } = select.into_longop();
    runtime.record_prompt(SelectionPrompt {
        longop_id: id,
        byte_offset_in_scene,
        kind: SelectionPromptKind::ObjectButtons {
            group,
            options: candidates
                .into_iter()
                .enumerate()
                .map(|(display_index, candidate)| {
                    let hit_region = candidate.object.hit_region(None);
                    ObjectButtonPromptOption {
                        display_index: display_index as u16,
                        button_number: candidate.options.button_number,
                        fg_slot: candidate.slot,
                        visual_snapshot: candidate.object,
                        candidate_scope: ObjectButtonCandidateScope::TopLevelForegroundOnly,
                        hit_region,
                    }
                })
                .collect(),
        },
        cancelable,
        option_line_ids: Vec::new(),
    });
    DispatchOutcome::Yield {
        longop_id: id,
        private_state,
    }
}

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
        dispatch_select_objbtn(&self.runtime, vm, args)
    }
}

/// `select_s` at rlvm opcode `3` — string-table text choice. Same carrier as
/// [`SelectSOp`] / [`SelectOp`] (yields a [`SelectLongOp`] over its recovered
/// option labels); the distinct [`SelectVariant::SelectS3`] tag pins which
/// opcode produced the queued longop. Registered for exact rlvm `Sel`-oracle
/// coverage — the opcode is absent from both proven corpora, so it is an
/// oracle-faithfulness op, not a real-bytes-driven one.
#[derive(Debug)]
pub struct SelectS3Op {
    runtime: Arc<SelRuntime>,
}

impl SelectS3Op {
    /// Build the op against a shared [`SelRuntime`].
    pub fn new(runtime: Arc<SelRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for SelectS3Op {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        dispatch_select(SelectVariant::SelectS3, &self.runtime, vm, args)
    }
}

#[derive(Debug)]
pub struct SelectObjbtnCancelOp {
    runtime: Arc<SelRuntime>,
}

impl SelectObjbtnCancelOp {
    /// Build the op against a shared [`SelRuntime`].
    pub fn new(runtime: Arc<SelRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for SelectObjbtnCancelOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let group = match args {
            [ExprValue::Int(group)] | [ExprValue::Int(group), ExprValue::Int(_)] => *group,
            _ => {
                self.runtime
                    .record_warning(SelRuntimeWarning::ObjectButtonCancelArgsInvalid {
                        observed: args.len(),
                    });
                return DispatchOutcome::Advance;
            }
        };
        dispatch_object_select(&self.runtime, vm.pc(), group, true)
    }
}

/// `objbtn_init` (`sel (0,2,20)`) is recognized as an exact no-op. Binding
/// state lives on graphics objects; selection/resume and rendering remain
/// separate work.
#[derive(Debug, Default)]
pub struct ObjbtnInitOp;

impl ObjbtnInitOp {
    /// Construct the stateless no-op.
    pub fn new() -> Self {
        Self
    }
}

impl RLOperation for ObjbtnInitOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Advance
    }
}

/// Mount every choice op this module ships into `registry`. Returns
/// the number of entries registered (matches [`SEL_RLOP_COUNT`]).
///
/// Registers the EXACT rlvm `Sel`-module opcode set `{0,1,2,3,4,14,20}`: the
/// six [`SelectVariant`] SELECT ops (`select` `0`, `select_s` `1`, `select_w`
/// `2`, `select_s` `3`, `select_objbtn` `4`, `select_objbtn_cancel` `14`) plus
/// the `objbtn_init` (`20`) button-object group-setup op — no more, no less
/// (there is no synthetic opcode `120`; rlvm's `RLModule("Sel", 0, 2)` has no
/// such opcode).
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
        SelectVariant::SelectS3.rlop_key(),
        Arc::new(SelectS3Op::new(Arc::clone(&runtime))),
    );
    registry.register(
        SelectVariant::SelectObjbtn.rlop_key(),
        Arc::new(SelectObjbtnOp::new(Arc::clone(&runtime))),
    );
    registry.register(
        SelectVariant::SelectObjbtnCancel.rlop_key(),
        Arc::new(SelectObjbtnCancelOp::new(Arc::clone(&runtime))),
    );
    // `objbtn_init` is a recognized no-op; bindings live on graphics objects.
    registry.register(
        RlopKey::new(SEL_MODULE_TYPE, SEL_MODULE_ID, OPCODE_OBJBTN_INIT),
        Arc::new(ObjbtnInitOp::new()),
    );
    SEL_RLOP_COUNT
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use utsushi_core::substrate::{ChoiceIndex, SinkCapability, SinkError, SinkKind, SinkResult};

    use super::*;
    use crate::rlop::{LongOpReadiness, LongOpScheduler};
    use crate::var_banks::VarBanks;

    struct CollectingSink {
        lines: Mutex<Vec<TextLine>>,
        reject_after: Option<usize>,
    }

    impl CollectingSink {
        fn new() -> Self {
            Self {
                lines: Mutex::new(Vec::new()),
                reject_after: None,
            }
        }

        fn rejecting_after(emitted: usize) -> Self {
            Self {
                lines: Mutex::new(Vec::new()),
                reject_after: Some(emitted),
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
            let mut lines = self.lines.lock().expect("lock");
            if self.reject_after == Some(lines.len()) {
                return Err(SinkError::UnsupportedKind {
                    sink: SinkKind::TextSurface,
                    adapter_id: "reject-second-choice".to_string(),
                    reason: "test sink rejects one choice".to_string(),
                });
            }
            lines.push(line);
            Ok(())
        }
    }

    #[test]
    fn select_variant_all_covers_every_select_opcode() {
        // The six SELECT variants cover rlvm `Sel` opcodes {0,1,2,3,4,14}
        // (the setup-only `objbtn_init` = 20 is not a select).
        assert_eq!(SelectVariant::ALL.len(), 6);
        let opcodes: std::collections::BTreeSet<u16> =
            SelectVariant::ALL.iter().map(|v| v.opcode()).collect();
        assert_eq!(
            opcodes,
            [0u16, 1, 2, 3, 4, 14].into_iter().collect(),
            "SELECT variants must map to the rlvm Sel select opcodes"
        );
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
    fn register_sel_rlops_covers_every_variant() {
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
        // The `objbtn_init` button-object setup op is also registered.
        assert!(
            registry
                .get(RlopKey::new(
                    SEL_MODULE_TYPE,
                    SEL_MODULE_ID,
                    OPCODE_OBJBTN_INIT
                ))
                .is_some(),
            "objbtn_init setup op missing"
        );
    }

    #[test]
    fn register_sel_rlops_covers_exact_rlvm_oracle_opcode_set() {
        // rlvm `SelModule` (`module_sel.cc`) registers EXACTLY these opcodes:
        //   0 select_w, 1 select, 2 select_s2, 3 select_s
        //   4 select_objbtn, 14 select_objbtn_cancel, 20 objbtn_init.
        // The port must register that set — no more, no less. In particular
        // opcode 120 (a retired synthetic alias) must be ABSENT.
        const ORACLE_OPCODES: &[u16] = &[0, 1, 2, 3, 4, 14, 20];
        let sink = Arc::new(CollectingSink::new());
        let runtime = Arc::new(SelRuntime::with_sink(sink));
        let mut registry = RlopRegistry::new();
        register_sel_rlops(&mut registry, runtime);

        // Every oracle opcode is registered at (0, 2, opcode).
        for &opcode in ORACLE_OPCODES {
            assert!(
                registry
                    .get(RlopKey::new(SEL_MODULE_TYPE, SEL_MODULE_ID, opcode))
                    .is_some(),
                "rlvm Sel opcode {opcode} not registered"
            );
        }
        // The count equals the oracle set size — combined with all seven keys
        // present and `register_sel_rlops` touching only Sel keys, this proves
        // EXACTLY {0,1,2,3,4,14,20} is registered (no extras).
        assert_eq!(ORACLE_OPCODES.len(), SEL_RLOP_COUNT);
        assert_eq!(registry.len(), SEL_RLOP_COUNT);
        // The retired synthetic opcode 120 is absent (rlvm has no such opcode).
        assert!(
            registry
                .get(RlopKey::new(SEL_MODULE_TYPE, SEL_MODULE_ID, 120))
                .is_none(),
            "synthetic opcode 120 must not be registered"
        );
        // Opcodes 3 and 14 are real Sel operations.
        assert!(
            registry
                .get(RlopKey::new(
                    SEL_MODULE_TYPE,
                    SEL_MODULE_ID,
                    OPCODE_SELECT_S3
                ))
                .is_some(),
            "select_s (opcode 3) must be a real Sel op"
        );
        assert!(
            registry
                .get(RlopKey::new(
                    SEL_MODULE_TYPE,
                    SEL_MODULE_ID,
                    OPCODE_SELECT_OBJBTN_CANCEL
                ))
                .is_some(),
            "select_objbtn_cancel (opcode 14) must be a real Sel op"
        );
    }

    #[test]
    fn variant_str_pin() {
        assert_eq!(SelectVariant::Select.as_str(), "sel.select");
        assert_eq!(SelectVariant::SelectS.as_str(), "sel.select_s");
        assert_eq!(SelectVariant::SelectW.as_str(), "sel.select_w");
        assert_eq!(SelectVariant::SelectS3.as_str(), "sel.select_s3");
        assert_eq!(SelectVariant::SelectObjbtn.as_str(), "sel.select_objbtn");
        assert_eq!(
            SelectVariant::SelectObjbtnCancel.as_str(),
            "sel.select_objbtn_cancel"
        );
    }

    #[test]
    fn objbtn_opcode_is_real_rlvm_value_four() {
        // The real RealLive `select_objbtn` opcode is 4 (rlvm
        // `AddOpcode(4, 0, "select_objbtn")`). The old fictional value 3 has
        // zero observed occurrences.
        assert_eq!(OPCODE_SELECT_OBJBTN, 4);
        assert_eq!(SelectVariant::SelectObjbtn.opcode(), 4);
        assert_eq!(OPCODE_OBJBTN_INIT, 20);
        assert_eq!(OPCODE_SELECT_OBJBTN_CANCEL, 14);
        // The button-object SETUP opcodes are the real modality signal.
        assert_eq!(SelectVariant::BUTTON_OBJECT_SETUP_OPCODES, &[20u16, 4, 14]);
    }

    #[test]
    fn objbtn_init_is_a_noop() {
        let mut vm = Vm::new(1, 0);
        assert!(matches!(
            ObjbtnInitOp::new().dispatch(&mut vm, &[]),
            DispatchOutcome::Advance
        ));
    }

    #[test]
    fn select_objbtn_uses_slot_ordered_foreground_values_without_text() {
        use crate::graphics_objects::{
            ButtonOptions, GraphicsAlpha, GraphicsColourTone, GraphicsLayer, GraphicsObject,
            GraphicsObjectKind, GraphicsPosition, GraphicsScale, HitRect, HitRegion,
            HitRegionUnavailable, ImageRef, SurfaceGeometry, WipeColour,
        };

        let sink = Arc::new(CollectingSink::new());
        let graphics = Arc::new(GraphicsRuntime::new());
        let mut image_button = GraphicsObject::image("missing-g00");
        image_button.kind = GraphicsObjectKind::Image {
            image_ref: ImageRef {
                asset_key: "missing-g00".to_string(),
                region_index: Some(12),
            },
        };
        image_button.position = GraphicsPosition { x: 31, y: -9 };
        image_button.scale = GraphicsScale {
            x_thousandths: 750,
            y_thousandths: 1250,
        };
        image_button.alpha = GraphicsAlpha(137);
        image_button.colour_tone = GraphicsColourTone {
            red_thousandths: 100,
            green_thousandths: -200,
            blue_thousandths: 300,
        };
        image_button.layer_order = 41;
        image_button.visible = false;
        image_button.geometry.surface = Some(SurfaceGeometry {
            width: 40,
            height: 30,
            origin: GraphicsPosition { x: 5, y: 7 },
        });
        image_button.button_options = Some(ButtonOptions {
            action: 0,
            se: 0,
            group: 5,
            button_number: 7,
        });
        let expected_image = image_button.clone();

        let mut wipe_button = GraphicsObject::wipe(WipeColour {
            red: 1,
            green: 2,
            blue: 3,
            alpha: 4,
        });
        wipe_button.button_options = Some(ButtonOptions {
            action: 0,
            se: 0,
            group: 5,
            button_number: 2,
        });
        let expected_wipe = wipe_button.clone();
        graphics.with_stack_mut(|stack| {
            stack
                .set_layer(GraphicsLayer::ForegroundObject, 3, image_button)
                .expect("slot");
            stack
                .set_layer(GraphicsLayer::ForegroundObject, 11, wipe_button)
                .expect("slot");
        });
        let runtime = Arc::new(SelRuntime::with_graphics(
            Arc::clone(&sink) as Arc<dyn TextSurfaceSink>,
            Arc::clone(&graphics),
        ));
        let outcome = SelectObjbtnOp::new(Arc::clone(&runtime))
            .dispatch(&mut Vm::new(1, 0), &[ExprValue::Int(5)]);
        let DispatchOutcome::Yield {
            longop_id,
            private_state,
        } = outcome
        else {
            panic!("object group must yield");
        };
        let carrier = ObjectSelectLongOp::try_from_longop(&LongOp::new(longop_id, private_state))
            .expect("object carrier");
        assert_eq!(carrier.return_values(), &[7, 2]);
        assert!(sink.lines.lock().expect("lock").is_empty());
        // Reusing or mutating slots after the yield must not alter the
        // prompt-time snapshots detached from the graphics mutex scan.
        graphics.with_stack_mut(|stack| {
            stack
                .set_layer(
                    GraphicsLayer::ForegroundObject,
                    3,
                    GraphicsObject::image("reused-after-yield"),
                )
                .expect("slot");
            stack
                .get_layer_mut(GraphicsLayer::ForegroundObject, 11)
                .expect("slot")
                .visible = false;
        });
        let prompts = runtime.take_prompts();
        assert_eq!(prompts.len(), 1);
        let prompt = &prompts[0];
        assert_eq!(prompt.longop_id, longop_id);
        assert!(!prompt.cancelable);
        assert!(prompt.option_line_ids.is_empty());
        let SelectionPromptKind::ObjectButtons { group, options } = &prompt.kind else {
            panic!("object selection must produce object-button prompt");
        };
        assert_eq!(*group, 5);
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].display_index, 0);
        assert_eq!(options[0].button_number, 7);
        assert_eq!(options[0].fg_slot, 3);
        assert_eq!(options[0].visual_snapshot, expected_image);
        assert_eq!(options[1].display_index, 1);
        assert_eq!(options[1].button_number, 2);
        assert_eq!(options[1].fg_slot, 11);
        assert_eq!(options[1].visual_snapshot, expected_wipe);
        assert_eq!(
            options[0].hit_region,
            HitRegion::Known(HitRect {
                x: 26,
                y: -16,
                width: 40,
                height: 30,
            }),
            "the prompt must snapshot the decoded object geometry"
        );
        assert_eq!(
            options[1].hit_region,
            HitRegion::Unavailable(HitRegionUnavailable::AssetPatternGeometryUnavailable)
        );
        assert!(options.iter().all(|option| {
            option.candidate_scope == ObjectButtonCandidateScope::TopLevelForegroundOnly
        }));
        assert!(matches!(
            &options[0].visual_snapshot.kind,
            GraphicsObjectKind::Image { image_ref }
                if image_ref.asset_key == "missing-g00" && image_ref.region_index == Some(12)
        ));
        let render_option = options[0]
            .render_choice_option()
            .expect("decoded image button must produce renderer metadata");
        assert_eq!(render_option.fg_slot, 3);
        assert_eq!(render_option.bounds.x, 26);
        assert_eq!(render_option.bounds.y, -16);
        assert_eq!(render_option.art.asset_key, "missing-g00");
        assert!(matches!(
            options[1].render_choice_option(),
            Err(ObjectButtonChoiceWindowBuildError::GeometryUnavailable { .. })
        ));
        assert!(matches!(
            options[1].visual_snapshot.kind,
            GraphicsObjectKind::Wipe { .. }
        ));
        assert!(matches!(
            SelectObjbtnOp::new(Arc::clone(&runtime))
                .dispatch(&mut Vm::new(1, 0), &[ExprValue::Int(8)]),
            DispatchOutcome::Advance
        ));
        assert_eq!(
            runtime.take_warnings(),
            vec![SelRuntimeWarning::ObjectButtonCandidatesEmpty { group: 8 }]
        );
    }

    #[test]
    fn select_objbtn_cancel_overloads_ignore_select_se_and_set_cancelable() {
        use crate::graphics_objects::{ButtonOptions, GraphicsLayer, GraphicsObject};

        let sink = Arc::new(CollectingSink::new());
        let graphics = Arc::new(GraphicsRuntime::new());
        graphics.with_stack_mut(|stack| {
            for (slot, number) in [(11, 2), (3, 7)] {
                let mut object = GraphicsObject::image("test");
                object.button_options = Some(ButtonOptions {
                    action: 0,
                    se: 0,
                    group: 5,
                    button_number: number,
                });
                stack
                    .set_layer(GraphicsLayer::ForegroundObject, slot, object)
                    .expect("slot");
            }
        });
        let runtime = Arc::new(SelRuntime::with_graphics(
            Arc::clone(&sink) as Arc<dyn TextSurfaceSink>,
            graphics,
        ));
        for args in [
            &[ExprValue::Int(5)][..],
            &[ExprValue::Int(5), ExprValue::Int(99)][..],
        ] {
            let DispatchOutcome::Yield {
                longop_id,
                private_state,
            } = SelectObjbtnCancelOp::new(Arc::clone(&runtime)).dispatch(&mut Vm::new(1, 0), args)
            else {
                panic!("cancel object group must yield");
            };
            let carrier =
                ObjectSelectLongOp::try_from_longop(&LongOp::new(longop_id, private_state))
                    .expect("object carrier");
            assert_eq!(carrier.return_values(), &[7, 2]);
            assert!(carrier.is_cancelable());
        }
        assert!(sink.lines.lock().expect("lock").is_empty());
        let prompts = runtime.take_prompts();
        assert_eq!(prompts.len(), 2);
        assert!(prompts.iter().all(|prompt| {
            prompt.cancelable
                && prompt.option_line_ids.is_empty()
                && matches!(
                    &prompt.kind,
                    SelectionPromptKind::ObjectButtons { group: 5, options }
                        if options.iter().map(|option| (
                            option.display_index,
                            option.button_number,
                            option.fg_slot,
                        )).collect::<Vec<_>>() == vec![(0, 7, 3), (1, 2, 11)]
                )
        }));
        assert!(matches!(
            SelectObjbtnCancelOp::new(Arc::clone(&runtime))
                .dispatch(&mut Vm::new(1, 0), &[ExprValue::Int(8)]),
            DispatchOutcome::Advance
        ));
        assert_eq!(
            runtime.take_warnings(),
            vec![SelRuntimeWarning::ObjectButtonCandidatesEmpty { group: 8 }]
        );
    }

    #[test]
    fn selection_control_signal_keys_on_button_object_setup_ops() {
        // No button-object setup ops in the scene → a plain text-window
        // select.
        assert_eq!(
            selection_control_signal([OPCODE_SELECT_W, OPCODE_SELECT_W]),
            SelectionControlSignal::TextWindow
        );
        // `objbtn_init` (20) present → button-object graphical select.
        assert_eq!(
            selection_control_signal([OPCODE_OBJBTN_INIT, OPCODE_SELECT_W]),
            SelectionControlSignal::ButtonObject
        );
        // `select_objbtn` (4) present → button-object graphical select.
        assert_eq!(
            selection_control_signal([OPCODE_SELECT_OBJBTN, OPCODE_SELECT_W]),
            SelectionControlSignal::ButtonObject
        );
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
        let select = ObjectSelectLongOp::try_new(LongOpId(7), vec![7, 2]).expect("bounded");
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
        let decoded = ObjectSelectLongOp::try_from_longop(&head).expect("decode");
        assert_eq!(
            decoded.outcome(),
            crate::rlop::ObjectSelectOutcome::DisplayIndex(1)
        );
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
        // (0, 2) — so a user pick routed through `SelectLongOp::choose`
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
        let line_ids: Vec<String> = lines.iter().map(|line| line.line_id.clone()).collect();
        drop(lines);

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
        assert_eq!(
            runtime.take_prompts(),
            vec![SelectionPrompt {
                longop_id,
                byte_offset_in_scene: 0,
                kind: SelectionPromptKind::Text,
                cancelable: false,
                option_line_ids: line_ids,
            }]
        );

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
    fn text_prompt_is_omitted_when_any_stored_choice_line_is_rejected() {
        let sink = Arc::new(CollectingSink::rejecting_after(1));
        let runtime = Arc::new(SelRuntime::with_sink(
            Arc::clone(&sink) as Arc<dyn TextSurfaceSink>
        ));

        assert!(matches!(
            SelectOp::new(Arc::clone(&runtime)).dispatch(
                &mut Vm::new(1, 0),
                &[
                    ExprValue::Bytes(b"first".to_vec()),
                    ExprValue::Bytes(b"second".to_vec())
                ],
            ),
            DispatchOutcome::Yield { .. }
        ));
        assert!(runtime.take_prompts().is_empty());
        assert_eq!(
            runtime.take_warnings(),
            vec![SelRuntimeWarning::SinkRejected {
                variant: SelectVariant::Select,
                reason: "utsushi.sink.unsupported_kind: sink=text_surface adapter=reject-second-choice reason=test sink rejects one choice".to_string(),
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
