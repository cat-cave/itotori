use super::*;

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
/// `dispatch_select` carrier: `select_s` reads its option labels from the
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
    pub(super) sink: Arc<dyn TextSurfaceSink>,
    pub(super) id_sequence: Arc<LongOpIdSequence>,
    pub(super) gameexe: Option<Arc<Gameexe>>,
    pub(super) graphics: Option<Arc<GraphicsRuntime>>,
    pub(super) inner: Mutex<SelRuntimeInner>,
}

#[derive(Debug, Default)]
pub(super) struct SelRuntimeInner {
    /// Counter the runtime uses to disambiguate `line_id` strings on
    /// the [`TextLine`] surface. Increments on every emission.
    pub(super) next_line_seq: u64,
    /// Fail-soft warnings the runtime records when an opcode's arg
    /// shape does not match the declared contract. Drained via
    /// [`SelRuntime::take_warnings`].
    pub(super) warnings: Vec<SelRuntimeWarning>,
    pub(super) prompts: Vec<SelectionPrompt>,
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
