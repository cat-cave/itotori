use super::*;

/// Monotonic generator for [`LongOpId`] values. The runtime allocates
/// one of these per active VM so longop ids do not collide across
/// suspend / resume cycles.
#[derive(Debug, Default)]
pub struct LongOpIdSequence {
    pub(super) next: Mutex<u64>,
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
    pub(super) sink: Arc<dyn TextSurfaceSink>,
    pub(super) inner: Mutex<MsgRuntimeInner>,
    pub(super) id_sequence: Arc<LongOpIdSequence>,
}

#[derive(Debug, Default)]
pub(super) struct MsgRuntimeInner {
    /// Counter the runtime uses to disambiguate `line_id` strings on
    /// the [`TextLine`] surface. Increments on every emission.
    pub(super) next_line_seq: u64,
    /// Pending speaker name buffered between
    /// [`OPCODE_NAME_OPEN`] and [`OPCODE_NAME_CLOSE`].
    pub(super) pending_speaker: Option<String>,
    /// Last `msg.linenumber` seen — used by the kidoku follow-up.
    pub(super) last_line_number: Option<u32>,
    /// Current font colour (`u32`, RRGGBB packed). The synthetic tests
    /// pin emissions through here.
    pub(super) current_font_color: Option<u32>,
    /// Current font size (`u8`, point-equivalent). The synthetic tests
    /// pin emissions through here.
    pub(super) current_font_size: Option<u8>,
    /// Active text-window slot index. RLDEV documents this as a small
    /// integer (typically `0..=2`); the runtime carries it as `u32`
    /// because the wire encoding is `i32 LE`.
    pub(super) current_text_window: Option<u32>,
    /// Pending textout body bytes accumulated between control opcodes.
    /// The accumulator lets `msg.text_out` runs interleave with
    /// `msg.font_color` / `msg.name_open` without splitting a single
    /// logical line into multiple emissions before the user-visible
    /// break (`msg.line_break` / `msg.paragraph_break` / `msg.page`).
    pub(super) pending_body: Vec<u8>,
    /// Byte offset of the first textout contributing to `pending_body`.
    pub(super) pending_byte_offset: Option<u32>,
    /// Fail-soft warnings the runtime records when an opcode's arg
    /// shape does not match the declared contract. Drained via
    /// [`MsgRuntime::take_warnings`].
    pub(super) warnings: Vec<MsgRuntimeWarning>,
    /// Optional `【key】 → (display_name, colour)` resolver built from the
    /// game's `#NAMAE` + `#COLOR_TABLE` tables. When present, a spoken
    /// line whose Shift-JIS body opens with a full-width lenticular
    /// `【…】` name prefix (the `#NAMAE` lookup key) has that prefix
    /// stripped from the emitted text and its speaker + text colour
    /// populated on the [`TextLine`]. `None` (the default) preserves the
    /// legacy nameOpen/nameClose-only speaker behaviour.
    pub(super) speaker_resolver: Option<Arc<NamaeResolver>>,
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
    pub(super) fn append_body(&self, bytes: &[u8]) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.pending_body.extend_from_slice(bytes);
    }

    /// Push the pending body (and clear it) through the sink as a
    /// single [`TextLine`]. Returns whether a line was actually
    /// emitted — an empty pending body produces no emission.
    pub(super) fn flush_pending_line(&self, opcode: MsgOpcode) -> bool {
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
    pub(super) fn emit(&self, opcode: MsgOpcode, line: TextLine) {
        if let Err(err) = self.sink.emit_line(line) {
            self.record_warning(MsgRuntimeWarning::SinkRejected {
                opcode,
                reason: sink_error_reason(&err),
            });
        }
    }

    pub(super) fn record_warning(&self, warning: MsgRuntimeWarning) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.warnings.push(warning);
    }

    pub(super) fn next_line_id(&self) -> String {
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
    pub(super) fn begin_speaker(&self) {
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
    pub(super) fn end_speaker(&self) {
        // Intentionally empty: `begin_speaker` already wrote the
        // speaker label. The method exists for symmetry so the
        // per-opcode dispatch path is uniform across name_open
        // name_close.
    }
}
