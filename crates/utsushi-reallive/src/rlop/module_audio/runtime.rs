//! Shared audio runtime carrier for the BGM / KOE / PCM / SE RLOperation
//! family.
//!
//! Extracted from the parent [`crate::rlop::module_audio`] module so the
//! Gameexe resolution surface, sticky speaker register, and fail-soft
//! warning queue live in their own ≤500-line child. Public items are
//! re-exported from the parent to keep the crate API path unchanged.

use std::sync::{Arc, Mutex};

use crate::audio::{AudioEvent, AudioEventEmitter, AudioEventKind, AudioEventPayload};
use crate::gameexe::Gameexe;

/// Typed warnings the [`AudioRuntime`] records on arg-shape / lookup
/// failure. Drained via [`AudioRuntime::take_warnings`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioRuntimeWarning {
    /// An opcode expected a particular arg shape but received a
    /// different one.
    ArgShapeMismatch {
        opcode_tag: &'static str,
        expected: &'static str,
    },
    /// An opcode received fewer args than declared.
    MissingArg {
        opcode_tag: &'static str,
        slot: &'static str,
    },
    /// A `bgmPlay` / `wavPlay` / `koePlay` asset name did not decode
    /// from Shift-JIS bytes.
    InvalidShiftJis { opcode_tag: &'static str },
    /// A `playSe` slot was not declared in the Gameexe `#SE.<slot>`
    /// table.
    UnknownSeSlot { slot: i32 },
    /// A `koePlay` was dispatched with a sample id but no current
    /// speaker was selected. Sweetie HD's system-event archive `z0001`
    /// is the documented default; this warning fires when even that
    /// default has not been threaded through
    /// [`AudioRuntime::set_current_speaker_archive_id`].
    NoCurrentSpeaker,
}

/// Runtime carrier shared by every per-op [`RLOperation`] impl in the
/// audio family. Owns the audio-event emitter, the Gameexe-derived
/// resolution surfaces, the current-speaker register the `koePlay`
/// path consults, and the fail-soft warning queue.
pub struct AudioRuntime {
    inner: Mutex<AudioRuntimeInner>,
    emitter: Arc<AudioEventEmitter>,
}

pub(super) struct AudioRuntimeInner {
    gameexe: Option<Arc<Gameexe>>,
    bgm_subdir: String,
    wav_subdir: String,
    koe_subdir: String,
    /// Sticky archive id the next `koePlay(sample_id)` resolves
    /// through. Set via [`AudioRuntime::set_current_speaker_archive_id`]
    /// or via a `NAMAE` lookup through
    /// [`AudioRuntime::select_speaker_by_display_name`]. Default for
    /// Sweetie HD is archive `1` (the `z0001.ovk` system-event
    /// archive); we keep the default in code so a test that exercises
    /// koePlay against a freshly-built runtime can pin the
    /// "no Gameexe" path without spelunking.
    current_speaker_archive_id: i32,
    /// 1 if the BGM channel is currently playing (post-bgmPlay
    /// pre-bgmStop/bgmFadeOut). The bgmStatus opcode reads this.
    pub(super) bgm_playing: bool,
    /// 1 if a voice is currently playing. The koeStatus opcode reads
    /// this.
    pub(super) koe_playing: bool,
    warnings: Vec<AudioRuntimeWarning>,
}

impl std::fmt::Debug for AudioRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("AudioRuntime").finish()
    }
}

impl AudioRuntime {
    /// Build a runtime without any Gameexe context. `bgmPlay`
    /// `wavPlay` / `koePlay` resolve through the **default** subdir
    /// conventions (`"bgm"`, `"wav"`, `"koe"`); callers that need the
    /// Gameexe-driven subdir resolution should call
    /// [`Self::set_gameexe`] before dispatching.
    pub fn new(emitter: Arc<AudioEventEmitter>) -> Self {
        Self {
            inner: Mutex::new(AudioRuntimeInner {
                gameexe: None,
                bgm_subdir: "bgm".to_string(),
                wav_subdir: "wav".to_string(),
                koe_subdir: "koe".to_string(),
                current_speaker_archive_id: 1,
                bgm_playing: false,
                koe_playing: false,
                warnings: Vec::new(),
            }),
            emitter,
        }
    }

    /// Borrow the emitter.
    pub fn emitter(&self) -> &Arc<AudioEventEmitter> {
        &self.emitter
    }

    /// Set the Gameexe context the resolution surfaces consult. The
    /// runtime hydrates the per-kind subdir names from the
    /// `FOLDNAME.<KIND>` entries; absent entries fall back to the
    /// default conventional names.
    pub fn set_gameexe(&self, gameexe: Arc<Gameexe>) {
        let mut guard = self.lock_inner();
        if let Some((subdir, _, _)) = gameexe.get_tuple3("FOLDNAME.BGM") {
            guard.bgm_subdir = subdir.to_ascii_lowercase();
        }
        if let Some((subdir, _, _)) = gameexe.get_tuple3("FOLDNAME.WAV") {
            guard.wav_subdir = subdir.to_ascii_lowercase();
        }
        if let Some((subdir, _, _)) = gameexe.get_tuple3("FOLDNAME.KOE") {
            guard.koe_subdir = subdir.to_ascii_lowercase();
        }
        guard.gameexe = Some(gameexe);
    }

    /// Set the sticky speaker archive id the `koePlay(sample_id)` path
    /// consults. Sweetie HD's `z0001.ovk` system-event archive
    /// corresponds to `archive_id = 1`; the runtime defaults to that.
    pub fn set_current_speaker_archive_id(&self, archive_id: i32) {
        self.lock_inner().current_speaker_archive_id = archive_id;
    }

    /// Look up `display_name` in the Gameexe `NAMAE` table and set the
    /// current speaker's archive id to the resolved row's composite
    /// archive id. Returns `true` if the lookup resolved.
    ///
    /// # NAMAE → archive id composition
    ///
    /// The on-disk Sweetie HD `Gameexe.ini` NAMAE rows look like
    /// `#NAMAE = "凛" = "凛" = (1, 015, -1)` — three comma-separated
    /// integers `(mode, color_table_index, reserved)`. The middle field
    /// is a `#COLOR_TABLE` row index (the speaker's dialogue text
    /// colour); the AUTHORITATIVE voice cue is carried by `koePlay`
    /// bytecode arguments, NOT by `#NAMAE`. This helper is a best-effort
    /// sticky-speaker fallback that exploits a numbering coincidence in
    /// THIS title: `mode * 1000 + color_table_index` happens to equal
    /// the `koe/z<NNNN>.ovk` archive number for its character speakers
    /// (`(1, 015, -1)` ↔ `z1015.ovk`, `(1, 016, -1)` ↔ `z1016.ovk`
    /// `(0, 011, -1)` ↔ `z0011.ovk`). The last field is reserved
    /// (unused here).
    ///
    /// This composition matches the file listing under Sweetie HD's
    /// `REALLIVEDATA/koe/` exactly (we observe `z1011`, `z1014`
    /// `z1015`, `z1016`, `z1018` etc. for the character speakers whose
    /// NAMAE rows declare `(1, 011)` through `(1, 018)`); see the
    /// integration test in `tests/audio_rlop_real_bytes.rs` for the
    /// cross-validation.
    pub fn select_speaker_by_display_name(&self, display_name: &str) -> bool {
        let key = format!("NAMAE.{display_name}");
        let composite_archive_opt = {
            let guard = self.lock_inner();
            guard
                .gameexe
                .as_ref()
                .and_then(|gx| gx.get_namae(&key))
                .map(|entry| Self::namae_to_archive_id(entry.mode, entry.color_table_index))
        };
        if let Some(archive_id) = composite_archive_opt {
            self.lock_inner().current_speaker_archive_id = archive_id;
            true
        } else {
            false
        }
    }

    /// Compose the best-effort voice-archive id from a NAMAE row's
    /// `(mode, color_table_index)` pair. See
    /// [`Self::select_speaker_by_display_name`] for the numbering
    /// coincidence this exploits (the authoritative voice cue is
    /// `koePlay`, not `#NAMAE`).
    pub fn namae_to_archive_id(mode_field: i32, color_index_field: i32) -> i32 {
        mode_field
            .saturating_mul(1000)
            .saturating_add(color_index_field)
    }

    /// Current sticky speaker archive id.
    pub fn current_speaker_archive_id(&self) -> i32 {
        self.lock_inner().current_speaker_archive_id
    }

    /// Resolve a `bgmPlay` asset name to a stable `bgm/<NAME>` asset
    /// id. Honours `FOLDNAME.BGM`'s subdir mapping.
    pub fn bgm_asset_id_for(&self, asset_name: &str) -> String {
        let guard = self.lock_inner();
        format!("{}/{}", guard.bgm_subdir, asset_name)
    }

    /// Resolve a `wavPlay` asset name to a stable `wav/<NAME>` asset
    /// id.
    pub fn wav_asset_id_for(&self, asset_name: &str) -> String {
        let guard = self.lock_inner();
        format!("{}/{}", guard.wav_subdir, asset_name)
    }

    /// Resolve a `playSe` slot through the Gameexe `#SE.<slot> =
    /// "asset_name", <volume>` table. Returns `None` if the slot is
    /// absent or the entry shape does not match.
    pub fn se_asset_id_for_slot(&self, slot: i32) -> Option<String> {
        let guard = self.lock_inner();
        let gameexe = guard.gameexe.as_ref()?;
        let key = format!("SE.{slot:03}");
        let value = gameexe.get(&key)?;
        // The `#SE.<slot>` value shape in RealLive is `"asset_name"
        // <volume>`; the Gameexe parser stores this as a string-prefix
        // arg array. We accept either the raw scalar string or the
        // first element of an int-array shape as the asset name.
        let asset_name = match value {
            crate::gameexe::GameexeValue::Str(text) => text.clone(),
            _ => return None,
        };
        Some(format!("se/{asset_name}"))
    }

    /// Format a voice archive id as `z<archive:04>` (the on-disk
    /// `koe/z<archive>.ovk` convention).
    pub fn voice_archive_label(archive_id: i32) -> String {
        // Visual Arts pads voice archive ids to 4 digits with a
        // leading `z`. Sweetie HD's `z0001.ovk` ↔ `archive_id = 1`
        // `z1015.ovk` ↔ `archive_id = 1015`.
        if archive_id < 0 {
            format!("z{:04}", 0)
        } else {
            format!("z{archive_id:04}")
        }
    }

    /// Drain the fail-soft warning queue.
    pub fn take_warnings(&self) -> Vec<AudioRuntimeWarning> {
        let mut guard = self.lock_inner();
        std::mem::take(&mut guard.warnings)
    }

    /// Borrow whether the BGM channel is currently playing.
    pub fn bgm_playing(&self) -> bool {
        self.lock_inner().bgm_playing
    }

    /// Borrow whether a voice is currently playing.
    pub fn koe_playing(&self) -> bool {
        self.lock_inner().koe_playing
    }

    pub(super) fn lock_inner(&self) -> std::sync::MutexGuard<'_, AudioRuntimeInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(super) fn record_warning(&self, warning: AudioRuntimeWarning) {
        self.lock_inner().warnings.push(warning);
    }

    pub(super) fn emit(&self, kind: AudioEventKind, payload: AudioEventPayload) -> AudioEvent {
        self.emitter.emit(kind, payload)
    }
}
