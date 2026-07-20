//! RealLive `module_msg` (text / messaging) RLOperation
//! family.
//!
//! Implements the text/messaging opcodes RealLive's `module_msg` exposes:
//! line / paragraph breaks, pause, line-number markers, the selection
//! prompt, speaker bracket marks, font size, font colour, msg-clear
//! msg-hide / page / text-window. Each op pushes its observation
//! through the substrate
//! [`utsushi_core::substrate::TextSurfaceSink`] — there is no direct
//! print, no separate buffering surface, and no silent fallback.
//!
//! # Module addressing
//!
//! `module_id=3` is the message-control semantic key. `module_type` is a
//! compiler-version artifact, so this family registers every operation under
//! the supported RealLive lattice `{0, 1, 2}`.
//!
//! # Opcode coverage
//!
//! The numeric opcode values are restated from Haeleth's public RLDEV
//! documentation (`https://dev.haeleth.net/rldev.shtml`
//! `bin/Reallive.kfn` opcode table), re-validated against real bytes where
//! the corpus exercises them. No rlvm source is vendored or
//! mechanically translated — each opcode here is a clean-room re-derive
//! whose semantics are pinned by:
//!
//! 1. RLDEV's published name + arity for the opcode (`[P]`).
//! 2. The dispatch shape (Advance / Yield / typed sink emission) the
//!    spec requires.
//! 3. A synthetic test that pins the observable side effect.
//!
//! # Substrate-honesty posture
//!
//! - **No silent fallbacks.** Each op consumes its declared arg count
//!   through typed accessors. A mismatch is recorded as a fail-soft
//!   `MsgRuntime::record_warning` so the VM keeps making progress; an
//!   unknown opcode never silently degrades into a no-op.
//! - **No direct print.** Every text observation goes through the
//!   typed [`TextSurfaceSink::emit_line`] surface so the
//!   evidence-tier ceiling is enforced.
//! - **Yields, not blocks.** `msg.pause` and `msg.select` produce a
//!   typed [`DispatchOutcome::Yield`] with a [`crate::rlop::LongOp`]
//!   payload — the VM's longop queue + scheduler combination decides
//!   when to resume.

use std::sync::{Arc, Mutex};

use utsushi_core::substrate::{EvidenceTier, SinkError, TextLine, TextSurfaceSink};

use super::{LongOpId, RlopKey};
use crate::gameexe::NamaeResolver;

mod ops;
pub use ops::{
    MsgFontColorOp, MsgFontSizeOp, MsgLineBreakOp, MsgLineNumberOp, MsgMsgClearOp, MsgMsgHideOp,
    MsgNameCloseOp, MsgNameOpenOp, MsgPageOp, MsgParagraphBreakOp, MsgPauseOp, MsgTextWindowOp,
    register_text_rlops,
};
// `msg.select` lived here briefly as a placeholder for a `SYS2` command.
// The choice family now lives at its semantic `module_id=2` address in
// `module_sel`; the old placeholder was deleted rather than retained.

/// Canonical compiler-lattice type retained for callers that build one key.
/// [`register_text_rlops`] registers every supported lattice type.
pub const MSG_MODULE_TYPE: u8 = 1;

/// The compiler-version `module_type` lattice accepted by this family.
const LATTICE_TYPES: [u8; 3] = [0, 1, 2];

/// `module_id` byte of the message-control submodule (`msg`). This is
/// the REAL RealLive semantic id `3` used by the `kaifuu-reallive`
/// decompiler (`opcode::module_id::MSG`) and validated on real bytecode.
/// An earlier revision mislabelled it `5` (which is
/// actually `SYS2`); that clobbered `sel.select_objbtn` and `msg.pause`
/// onto the same `(1, 5, 3)` key. Corrected to `3` so `msg` and `sel`
/// occupy distinct keys.
pub const MSG_MODULE_ID: u8 = 3;

// --- Opcode numerics --------------------------------------------------
//
// The numeric values below are the opcode bytes RLDEV (and rlvm's
// derived `module_msg.cc` table) document for the message-control
// submodule. Each constant carries the RLDEV name in its doc-comment so
// the audit trail names the source. Real-byte validation sites are named
// alongside the opcodes they exercise.

/// `msg.text_out` virtual opcode — the [`crate::BytecodeElement::Textout`]
/// element handler. Top-level Textout is not a Command, so the byte does
/// not appear in the registry; the [`MsgRuntime::handle_textout`]
/// helper pushes it through the sink. The numeric tag here is the
/// virtual opcode the audit/test harness uses to name the path.
pub const OPCODE_TEXT_OUT: u16 = 0x0000;

/// `msg.pause` — the user-input pause longop (RLDEV: `pause()`).
/// Yields a [`crate::rlop::LongOp`].
pub const OPCODE_PAUSE: u16 = 3;

/// `msg.paragraph_break` — paragraph break (RLDEV: `par()`, alias of
/// "page" in the catalogue but distinct on the RLDEV opcode line).
pub const OPCODE_PARAGRAPH_BREAK: u16 = 5;

/// `msg.line_break` — line break (RLDEV: `br()`).
pub const OPCODE_LINE_BREAK: u16 = 14;

/// `msg.page` — page wipe / new-page (RLDEV: `page()`). Equivalent
/// observation: paragraph break with a window-clear semantic.
pub const OPCODE_PAGE: u16 = 17;

/// `msg.msg_hide` — hide the active text window (RLDEV:
/// `msgHide()`).
pub const OPCODE_MSG_HIDE: u16 = 18;

/// `msg.msg_clear` — clear the text window contents (RLDEV:
/// `msgClr()`).
pub const OPCODE_MSG_CLEAR: u16 = 19;

/// `msg.line_number` — declared source-line number marker (RLDEV:
/// `linenumber(int)`). Used for kidoku tracking; the dispatch records
/// the line number on the runtime so kidoku can be cross-referenced.
pub const OPCODE_LINE_NUMBER: u16 = 22;

/// `msg.font_color` — set font colour (RLDEV: `FontColor(int)`).
pub const OPCODE_FONT_COLOR: u16 = 30;

/// `msg.font_size` — set font size (RLDEV: `FontSize(int)`).
pub const OPCODE_FONT_SIZE: u16 = 31;

/// `msg.name_open` — open speaker bracket (RLDEV: `nameOpen()`).
pub const OPCODE_NAME_OPEN: u16 = 40;

/// `msg.name_close` — close speaker bracket (RLDEV: `nameClose()`).
pub const OPCODE_NAME_CLOSE: u16 = 41;

/// `msg.text_window` — switch text window slot (RLDEV:
/// `TextWindow(int)`).
pub const OPCODE_TEXT_WINDOW: u16 = 100;

/// Stable enum naming the opcode set this module ships. Used by audit
/// tooling to assert "every variant is registered" without re-walking
/// the registry's `BTreeMap`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum MsgOpcode {
    Pause,
    ParagraphBreak,
    LineBreak,
    Page,
    MsgHide,
    MsgClear,
    LineNumber,
    FontColor,
    FontSize,
    NameOpen,
    NameClose,
    TextWindow,
}

impl MsgOpcode {
    /// All Command-shaped opcodes this module exposes. Used by the
    /// audit test that asserts [`register_text_rlops`] populates one
    /// entry per opcode.
    pub const ALL: &'static [MsgOpcode] = &[
        Self::Pause,
        Self::ParagraphBreak,
        Self::LineBreak,
        Self::Page,
        Self::MsgHide,
        Self::MsgClear,
        Self::LineNumber,
        Self::FontColor,
        Self::FontSize,
        Self::NameOpen,
        Self::NameClose,
        Self::TextWindow,
    ];

    /// Numeric opcode byte associated with this variant.
    pub fn opcode(self) -> u16 {
        match self {
            Self::Pause => OPCODE_PAUSE,
            Self::ParagraphBreak => OPCODE_PARAGRAPH_BREAK,
            Self::LineBreak => OPCODE_LINE_BREAK,
            Self::Page => OPCODE_PAGE,
            Self::MsgHide => OPCODE_MSG_HIDE,
            Self::MsgClear => OPCODE_MSG_CLEAR,
            Self::LineNumber => OPCODE_LINE_NUMBER,
            Self::FontColor => OPCODE_FONT_COLOR,
            Self::FontSize => OPCODE_FONT_SIZE,
            Self::NameOpen => OPCODE_NAME_OPEN,
            Self::NameClose => OPCODE_NAME_CLOSE,
            Self::TextWindow => OPCODE_TEXT_WINDOW,
        }
    }

    /// Composite registry key for a compiler-version lattice type.
    pub fn rlop_key_for(self, module_type: u8) -> RlopKey {
        RlopKey::new(module_type, MSG_MODULE_ID, self.opcode())
    }

    /// Canonical registry key retained for callers that use one lattice type.
    pub fn rlop_key(self) -> RlopKey {
        self.rlop_key_for(MSG_MODULE_TYPE)
    }

    /// Stable lowercase tag for diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pause => "msg.pause",
            Self::ParagraphBreak => "msg.par",
            Self::LineBreak => "msg.br",
            Self::Page => "msg.page",
            Self::MsgHide => "msg.msg_hide",
            Self::MsgClear => "msg.msg_clear",
            Self::LineNumber => "msg.linenumber",
            Self::FontColor => "msg.font_color",
            Self::FontSize => "msg.font_size",
            Self::NameOpen => "msg.name_open",
            Self::NameClose => "msg.name_close",
            Self::TextWindow => "msg.text_window",
        }
    }
}

/// Every registry key this module owns across the compiler-version lattice.
pub fn text_module_msg_keys() -> Vec<RlopKey> {
    LATTICE_TYPES
        .into_iter()
        .flat_map(|module_type| {
            MsgOpcode::ALL
                .iter()
                .map(move |op| op.rlop_key_for(module_type))
        })
        .collect()
}

/// Monotonic generator for [`LongOpId`] values. The runtime allocates
/// one of these per active VM so longop ids do not collide across
/// suspend / resume cycles.
#[derive(Debug, Default)]
pub struct LongOpIdSequence {
    next: Mutex<u64>,
}

impl LongOpIdSequence {
    /// Build a fresh sequence starting at id `1`. Id `0` is reserved
    /// for "no longop" sentinels in future audit tooling.
    pub fn new() -> Self {
        Self {
            next: Mutex::new(1),
        }
    }

    /// Allocate the next id. Panics only if the internal mutex is
    /// poisoned — that would indicate a prior allocator panic, which
    /// the dispatch path never triggers under our invariants.
    pub fn allocate(&self) -> LongOpId {
        let mut guard = self
            .next
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let id = *guard;
        *guard = guard.checked_add(1).unwrap_or(u64::MAX);
        LongOpId(id)
    }
}

/// Runtime carrier the per-op [`RLOperation`] impls thread through to
/// the [`TextSurfaceSink`] and the line-number tracker. The runtime is
/// shared via `Arc` so the registry's `Arc<dyn RLOperation>` entries
/// can be cloned cheaply; interior mutability is delegated to a
/// `Mutex` so the `Send + Sync` contract holds.
pub struct MsgRuntime {
    sink: Arc<dyn TextSurfaceSink>,
    inner: Mutex<MsgRuntimeInner>,
    id_sequence: Arc<LongOpIdSequence>,
}

#[derive(Debug, Default)]
struct MsgRuntimeInner {
    /// Counter the runtime uses to disambiguate `line_id` strings on
    /// the [`TextLine`] surface. Increments on every emission.
    next_line_seq: u64,
    /// Pending speaker name buffered between
    /// [`OPCODE_NAME_OPEN`] and [`OPCODE_NAME_CLOSE`].
    pending_speaker: Option<String>,
    /// Last `msg.linenumber` seen — used by the kidoku follow-up.
    last_line_number: Option<u32>,
    /// Current font colour (`u32`, RRGGBB packed). The synthetic tests
    /// pin emissions through here.
    current_font_color: Option<u32>,
    /// Current font size (`u8`, point-equivalent). The synthetic tests
    /// pin emissions through here.
    current_font_size: Option<u8>,
    /// Active text-window slot index. RLDEV documents this as a small
    /// integer (typically `0..=2`); the runtime carries it as `u32`
    /// because the wire encoding is `i32 LE`.
    current_text_window: Option<u32>,
    /// Pending textout body bytes accumulated between control opcodes.
    /// The accumulator lets `msg.text_out` runs interleave with
    /// `msg.font_color` / `msg.name_open` without splitting a single
    /// logical line into multiple emissions before the user-visible
    /// break (`msg.line_break` / `msg.paragraph_break` / `msg.page`).
    pending_body: Vec<u8>,
    /// Byte offset of the first textout contributing to `pending_body`.
    pending_byte_offset: Option<u32>,
    /// Fail-soft warnings the runtime records when an opcode's arg
    /// shape does not match the declared contract. Drained via
    /// [`MsgRuntime::take_warnings`].
    warnings: Vec<MsgRuntimeWarning>,
    /// Optional `【key】 → (display_name, colour)` resolver built from the
    /// game's `#NAMAE` + `#COLOR_TABLE` tables. When present, a spoken
    /// line whose Shift-JIS body opens with a full-width lenticular
    /// `【…】` name prefix (the `#NAMAE` lookup key) has that prefix
    /// stripped from the emitted text and its speaker + text colour
    /// populated on the [`TextLine`]. `None` (the default) preserves the
    /// legacy nameOpen/nameClose-only speaker behaviour.
    speaker_resolver: Option<Arc<NamaeResolver>>,
}

/// Typed warning the [`MsgRuntime`] records on a sink failure or a
/// malformed-arg observation. The VM does not consume this — callers
/// drain the queue at a cadence of their choosing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MsgRuntimeWarning {
    /// A typed [`TextSurfaceSink::emit_line`] call returned an error.
    SinkRejected {
        /// Opcode that triggered the emission attempt.
        opcode: MsgOpcode,
        /// Sink-side error message.
        reason: String,
    },
    /// An opcode received an argument byte string that could not be
    /// decoded from Shift-JIS without errors.
    InvalidShiftJis {
        /// Opcode that observed the byte string.
        opcode: MsgOpcode,
    },
    /// An opcode expected a particular arg shape (int / bytes) but
    /// received a different one.
    ArgShapeMismatch {
        /// Opcode that observed the mismatched arg shape.
        opcode: MsgOpcode,
        /// Stable string naming what the opcode expected ("int"
        /// "bytes", etc.).
        expected: &'static str,
    },
    /// An opcode received no arguments where at least one was
    /// expected.
    MissingArg {
        /// Opcode that observed the missing arg.
        opcode: MsgOpcode,
        /// Stable string naming the slot that was missing.
        slot: &'static str,
    },
}

impl std::fmt::Debug for MsgRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("MsgRuntime").finish()
    }
}

impl MsgRuntime {
    /// Build a runtime backed by `sink`. The runtime shares the
    /// id-sequence with the caller so a future cross-runtime test can
    /// observe a single monotonic id stream.
    pub fn new(sink: Arc<dyn TextSurfaceSink>, id_sequence: Arc<LongOpIdSequence>) -> Self {
        Self {
            sink,
            inner: Mutex::new(MsgRuntimeInner::default()),
            id_sequence,
        }
    }

    /// Build a runtime with a fresh id sequence. Convenience for tests.
    pub fn with_sink(sink: Arc<dyn TextSurfaceSink>) -> Self {
        Self::new(sink, Arc::new(LongOpIdSequence::new()))
    }

    /// Borrow the sink.
    pub fn sink(&self) -> &Arc<dyn TextSurfaceSink> {
        &self.sink
    }

    /// Install (or clear) the `#NAMAE` + `#COLOR_TABLE` speaker resolver.
    /// With a resolver set, [`Self::flush_pending_line`] parses a leading
    /// `【…】` name prefix off each spoken line, sets the resolved
    /// speaker + text colour, and strips the prefix from the body.
    pub fn set_speaker_resolver(&self, resolver: Option<Arc<NamaeResolver>>) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.speaker_resolver = resolver;
    }

    /// Borrow the id sequence.
    pub fn id_sequence(&self) -> &Arc<LongOpIdSequence> {
        &self.id_sequence
    }

    /// Drain the fail-soft warnings observed since the last call.
    pub fn take_warnings(&self) -> Vec<MsgRuntimeWarning> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        std::mem::take(&mut guard.warnings)
    }

    /// Borrow the last `msg.linenumber` observed.
    pub fn last_line_number(&self) -> Option<u32> {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.last_line_number
    }

    /// Borrow the active font colour (RRGGBB).
    pub fn current_font_color(&self) -> Option<u32> {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.current_font_color
    }

    /// Borrow the active font size (points).
    pub fn current_font_size(&self) -> Option<u8> {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.current_font_size
    }

    /// Borrow the active text-window slot.
    pub fn current_text_window(&self) -> Option<u32> {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.current_text_window
    }

    /// Borrow the in-progress textout body bytes. The synthetic tests
    /// use this to assert the runtime is buffering verbatim Shift-JIS
    /// bytes between control opcodes.
    pub fn pending_body_len(&self) -> usize {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.pending_body.len()
    }

    /// Borrow the pending speaker label, if any.
    pub fn pending_speaker(&self) -> Option<String> {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.pending_speaker.clone()
    }

    /// Append `bytes` to the pending textout body. Called by
    /// [`dispatch_textout`] / [`MsgRuntime::handle_textout`].
    fn append_body(&self, bytes: &[u8]) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.pending_body.extend_from_slice(bytes);
    }

    /// Push the pending body (and clear it) through the sink as a
    /// single [`TextLine`]. Returns whether a line was actually
    /// emitted — an empty pending body produces no emission.
    fn flush_pending_line(&self, opcode: MsgOpcode) -> bool {
        let (body_bytes, byte_offset_in_scene, mut speaker, text_window, resolver) = {
            let mut guard = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let body = std::mem::take(&mut guard.pending_body);
            (
                body,
                guard.pending_byte_offset.take(),
                guard.pending_speaker.clone(),
                guard.current_text_window,
                guard.speaker_resolver.clone(),
            )
        };
        if body_bytes.is_empty() && speaker.is_none() {
            return false;
        }
        let text = if let Some(clean) = decode_shift_jis(&body_bytes) {
            clean
        } else {
            // The lexer's Textout boundary detection is first-byte-
            // based; some RealLive runs include non-Shift-JIS bytes
            // after a Shift-JIS-shaped prefix. The substrate-honest
            // policy: emit the clean prefix as the observation and
            // record a typed warning for the truncated tail.
            self.record_warning(MsgRuntimeWarning::InvalidShiftJis { opcode });
            let prefix_len = longest_clean_shift_jis_prefix(&body_bytes);
            let prefix = &body_bytes[..prefix_len];
            match decode_shift_jis(prefix) {
                Some(clean) => clean,
                None => {
                    // No clean prefix at all — drop the line; the
                    // warning is already recorded so the audit trail
                    // names the run.
                    return false;
                }
            }
        };
        // Resolve a leading full-width lenticular `【…】` speaker prefix
        // (the `#NAMAE` lookup key) into a speaker + text colour, and
        // strip the prefix from the rendered body. Only applies when no
        // nameOpen/nameClose speaker is already active AND the resolver
        // recognises the key — an unrecognised `【…】` (or narration with
        // no prefix) is left byte-for-byte intact.
        let mut color: Option<[u8; 3]> = None;
        let mut text = text;
        if speaker.is_none()
            && let Some(resolver) = resolver.as_ref()
            && let Some((key, rest)) = split_leading_lenticular(&text)
            && let Some(resolved) = resolver.resolve(key)
        {
            speaker = Some(resolved.display_name.clone());
            color = Some(resolved.color);
            text = rest.to_string();
        }
        let line_id = self.next_line_id();
        let line = TextLine {
            line_id,
            evidence_tier: EvidenceTier::E1,
            text,
            speaker,
            color,
            text_surface: Some(text_window_label(text_window)),
            bridge_ref: None,
            source_asset: None,
            byte_offset_in_scene,
            body_shift_jis: Some(body_bytes),
        };
        self.emit(opcode, line);
        true
    }

    /// Emit `line` through the sink, recording any sink-side failure
    /// as a fail-soft warning.
    fn emit(&self, opcode: MsgOpcode, line: TextLine) {
        if let Err(err) = self.sink.emit_line(line) {
            self.record_warning(MsgRuntimeWarning::SinkRejected {
                opcode,
                reason: sink_error_reason(&err),
            });
        }
    }

    fn record_warning(&self, warning: MsgRuntimeWarning) {
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
        format!("utsushi-reallive-msg-line-{id:08x}")
    }

    /// Handle a top-level [`crate::BytecodeElement::Textout`]
    /// observation. The element is not a Command, so the VM's
    /// dispatch loop does not consult the registry for it; the helper
    /// [`dispatch_textout`] calls this method directly.
    pub fn handle_textout(&self, raw_bytes: &[u8]) {
        self.append_body(raw_bytes);
    }

    /// Handle a top-level textout while retaining the decoded-scene byte
    /// offset that began the logical line. This is the evidence-preserving
    /// entry used by the port observation path.
    pub fn handle_textout_at(&self, byte_offset_in_scene: u32, raw_bytes: &[u8]) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if guard.pending_body.is_empty() {
            guard.pending_byte_offset = Some(byte_offset_in_scene);
        }
        guard.pending_body.extend_from_slice(raw_bytes);
    }

    /// Open the speaker bracket. The text accumulated until
    /// [`OPCODE_NAME_CLOSE`] becomes the speaker label of the next
    /// emission.
    fn begin_speaker(&self) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Stash the current pending body as the speaker label and
        // reset the body accumulator.
        let raw = std::mem::take(&mut guard.pending_body);
        guard.pending_byte_offset = None;
        let label =
            decode_shift_jis(&raw).unwrap_or_else(|| String::from_utf8_lossy(&raw).into_owned());
        guard.pending_speaker = Some(label);
    }

    /// Close the speaker bracket. No-op when no speaker is active —
    /// the assignment happened on `begin_speaker`.
    // reason: deliberately takes `&self` and is empty — it exists purely for
    // API symmetry with `begin_speaker` so the per-opcode dispatch path stays
    // uniform across name_open / name_close.
    #[allow(clippy::unused_self)]
    fn end_speaker(&self) {
        // Intentionally empty: `begin_speaker` already wrote the
        // speaker label. The method exists for symmetry so the
        // per-opcode dispatch path is uniform across name_open
        // name_close.
    }
}

fn text_window_label(window: Option<u32>) -> String {
    match window {
        Some(idx) => format!("text_window:{idx}"),
        None => "text_window:default".to_string(),
    }
}

fn sink_error_reason(err: &SinkError) -> String {
    err.to_string()
}

/// Split a leading full-width lenticular `【…】` name prefix off a
/// decoded line. Returns `(inner_key, remainder)` when `text` opens with
/// `【` and has a matching `】`; the remainder is the byte run after the
/// closing bracket (the spoken dialogue, typically opening with `「`).
/// Returns `None` when there is no leading `【` (narration) or no closing
/// `】`. The `【` (U+3010) / `】` (U+3011) pair is Shift-JIS `81 79`
/// `81 7A`; here it is matched in the already-decoded UTF-8 string.
fn split_leading_lenticular(text: &str) -> Option<(&str, &str)> {
    let after_open = text.strip_prefix('【')?;
    let close = after_open.find('】')?;
    let inner = &after_open[..close];
    let rest = &after_open[close + '】'.len_utf8()..];
    Some((inner, rest))
}

/// Decode `bytes` as Shift-JIS. Returns `None` if encoding_rs reports a
/// replacement during decode. Used by the runtime to surface a typed
/// warning rather than a panic on a malformed run.
fn decode_shift_jis(bytes: &[u8]) -> Option<String> {
    let (cow, _encoding, had_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
    if had_errors {
        None
    } else {
        Some(cow.into_owned())
    }
}

/// Length of the longest prefix of `bytes` that decodes from Shift-JIS
/// without replacement. The lexer's Textout boundary detection is
/// first-byte-based; some RealLive runs legitimately include
/// non-Shift-JIS bytes (e.g. `0xFF` `i32` literal introducers) after a
/// Shift-JIS-shaped prefix. The runtime uses this helper to emit the
/// clean prefix as a substrate observation while recording a typed
/// warning for the tail.
fn longest_clean_shift_jis_prefix(bytes: &[u8]) -> usize {
    // Walk the byte stream in Shift-JIS pair-aware steps and stop at
    // the first lead byte that does not introduce a documented pair.
    // The pair table:
    //   - Single-byte: 0x20..=0x7E (ASCII), 0xA1..=0xDF (half-width
    //     katakana).
    //   - Double-byte: lead 0x81..=0x9F or 0xE0..=0xFC, trail
    //     0x40..=0x7E or 0x80..=0xFC.
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if (0x20..=0x7E).contains(&b) || (0xA1..=0xDF).contains(&b) {
            i += 1;
            continue;
        }
        if (0x81..=0x9F).contains(&b) || (0xE0..=0xFC).contains(&b) {
            if i + 1 >= bytes.len() {
                break;
            }
            let trail = bytes[i + 1];
            if (0x40..=0x7E).contains(&trail) || (0x80..=0xFC).contains(&trail) {
                i += 2;
                continue;
            }
        }
        break;
    }
    i
}

/// Helper the VM caller invokes after observing a
/// [`crate::vm::VmEvent::Textout`]. Pushes the raw bytes into
/// `runtime`'s pending-body accumulator so the next control opcode
/// (or the explicit [`MsgRuntime::flush_pending_line`] call site)
/// emits a [`TextLine`].
pub fn dispatch_textout(runtime: &MsgRuntime, raw_bytes: &[u8]) {
    runtime.handle_textout(raw_bytes);
}

/// Dispatch a top-level textout while retaining its decoded-scene byte
/// offset for the substrate evidence line.
pub fn dispatch_textout_at(runtime: &MsgRuntime, byte_offset_in_scene: u32, raw_bytes: &[u8]) {
    runtime.handle_textout_at(byte_offset_in_scene, raw_bytes);
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use utsushi_core::substrate::{SinkCapability, SinkKind, SinkResult};

    use super::*;
    use crate::rlop::RlopRegistry;

    struct CollectingSink {
        capability: SinkCapability,
        lines: Mutex<Vec<TextLine>>,
    }

    impl CollectingSink {
        fn supported() -> Self {
            Self {
                capability: SinkCapability::Supported {
                    evidence_tier_ceiling: EvidenceTier::E1,
                },
                lines: Mutex::new(Vec::new()),
            }
        }
    }

    impl TextSurfaceSink for CollectingSink {
        fn capability(&self) -> SinkCapability {
            self.capability
        }

        fn emit_line(&self, line: TextLine) -> SinkResult<()> {
            line.validate()?;
            self.lines.lock().expect("lock").push(line);
            Ok(())
        }
    }

    #[test]
    fn msg_opcode_all_covers_twelve_opcodes() {
        assert_eq!(
            MsgOpcode::ALL.len(),
            12,
            "alpha contract: exactly 12 module_msg opcodes covered (choice family lives in module_sel as of UTSUSHI-211)",
        );
    }

    #[test]
    fn register_text_rlops_mounts_each_opcode_under_every_lattice_type() {
        let sink = Arc::new(CollectingSink::supported());
        let runtime = Arc::new(MsgRuntime::with_sink(sink));
        let mut registry = RlopRegistry::new();
        let count = register_text_rlops(&mut registry, runtime);
        assert_eq!(count, MsgOpcode::ALL.len() * LATTICE_TYPES.len());
        assert_eq!(registry.len(), MsgOpcode::ALL.len() * LATTICE_TYPES.len());
        for module_type in LATTICE_TYPES {
            for opcode in MsgOpcode::ALL {
                assert!(
                    registry.get(opcode.rlop_key_for(module_type)).is_some(),
                    "{opcode:?} must resolve for lattice type {module_type}",
                );
            }
        }
    }

    #[test]
    fn opcode_byte_values_are_distinct() {
        let mut seen = std::collections::HashSet::new();
        for opcode in MsgOpcode::ALL {
            assert!(
                seen.insert(opcode.opcode()),
                "duplicate opcode byte for {opcode:?}",
            );
        }
    }

    #[test]
    fn dispatch_textout_appends_to_pending_body() {
        let sink = Arc::new(CollectingSink::supported());
        let runtime = MsgRuntime::with_sink(sink);
        dispatch_textout(&runtime, &[0x82, 0xa0]);
        assert_eq!(runtime.pending_body_len(), 2);
        dispatch_textout(&runtime, &[0x82, 0xa1]);
        assert_eq!(runtime.pending_body_len(), 4);
    }

    #[test]
    fn split_leading_lenticular_extracts_name_prefix() {
        // 【和人】「dialogue」 → key "和人", remainder "「dialogue」".
        let (key, rest) = split_leading_lenticular("【和人】「dialogue」").expect("named line");
        assert_eq!(key, "和人");
        assert_eq!(rest, "「dialogue」");
        // Narration (no leading 【) → None; an unmatched open → None.
        assert!(split_leading_lenticular("「just narration」").is_none());
        assert!(split_leading_lenticular("【unclosed").is_none());
    }

    #[test]
    fn flush_resolves_lenticular_prefix_to_speaker_and_color_and_strips_body() {
        use crate::gameexe::Gameexe;
        // Build a resolver: 和人 → COLOR_TABLE.016 = (204,204,255). The
        // Gameexe parser decodes its input as Shift-JIS, so the source
        // text must be encoded to Shift-JIS bytes first.
        let (gx_bytes, _, _) = encoding_rs::SHIFT_JIS
            .encode("#COLOR_TABLE.016=204,204,255\r\n#NAMAE=\"和人\" = \"和人\" = (1,016, -1)\r\n");
        let gx = Gameexe::parse(&gx_bytes).expect("parse gameexe");
        let sink = Arc::new(CollectingSink::supported());
        let runtime = MsgRuntime::with_sink(Arc::clone(&sink) as Arc<dyn TextSurfaceSink>);
        runtime.set_speaker_resolver(Some(Arc::new(gx.namae_resolver())));

        // Shift-JIS bytes for 【和人】「あ」 (the lenticular prefix + one
        // kana of dialogue in corner brackets).
        let (body, _, had_err) = encoding_rs::SHIFT_JIS.encode("【和人】「あ」");
        assert!(!had_err);
        runtime.handle_textout(&body);
        assert!(runtime.flush_pending_line(MsgOpcode::LineBreak));

        let lines = sink.lines.lock().expect("lock");
        assert_eq!(lines.len(), 1);
        let line = &lines[0];
        assert_eq!(line.speaker.as_deref(), Some("和人"));
        assert_eq!(line.color, Some([204, 204, 255]));
        // The 【…】 prefix is stripped; the body is just the dialogue.
        assert_eq!(line.text, "「あ」");
    }

    #[test]
    fn flush_without_resolver_leaves_prefix_and_no_speaker() {
        let sink = Arc::new(CollectingSink::supported());
        let runtime = MsgRuntime::with_sink(Arc::clone(&sink) as Arc<dyn TextSurfaceSink>);
        let (body, _, _) = encoding_rs::SHIFT_JIS.encode("【和人】「あ」");
        runtime.handle_textout(&body);
        assert!(runtime.flush_pending_line(MsgOpcode::LineBreak));
        let lines = sink.lines.lock().expect("lock");
        assert_eq!(lines[0].speaker, None);
        assert_eq!(lines[0].color, None);
        assert_eq!(lines[0].text, "【和人】「あ」");
    }

    #[test]
    fn text_window_label_round_trip() {
        assert_eq!(text_window_label(None), "text_window:default");
        assert_eq!(text_window_label(Some(2)), "text_window:2");
    }

    #[test]
    fn longop_id_sequence_allocates_monotonically() {
        let seq = LongOpIdSequence::new();
        assert_eq!(seq.allocate(), LongOpId(1));
        assert_eq!(seq.allocate(), LongOpId(2));
        assert_eq!(seq.allocate(), LongOpId(3));
    }

    #[test]
    fn sink_kind_pin() {
        // Sanity guard: the constant exists. The test makes the
        // module-level dependency on `SinkKind` grep-visible.
        let _ = SinkKind::TextSurface;
    }
}
