use super::*;

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

    pub(super) fn record_warning(&self, warning: SelRuntimeWarning) {
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
    pub(super) fn selbtn_style_suffix(&self, choice_index: usize) -> Option<String> {
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
    pub(super) fn emit_choice(
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

    pub(super) fn record_prompt(&self, prompt: SelectionPrompt) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.prompts.push(prompt);
    }
}

pub(super) fn decode_shift_jis(bytes: &[u8]) -> Result<String, ()> {
    let (cow, _encoding, had_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
    if had_errors {
        Err(())
    } else {
        Ok(cow.into_owned())
    }
}
