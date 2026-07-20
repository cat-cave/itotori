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
    /// A `koePlay(sample_id)` was dispatched but no voice archive is
    /// currently known: the runtime starts with an UNKNOWN archive and
    /// none has been established by an authoritative RealLive operation
    /// (`koePlayEx`) or explicit per-game configuration
    /// ([`AudioRuntime::set_current_speaker_archive_id`]). The runtime
    /// refuses to guess an archive, so it surfaces this typed unresolved
    /// observation instead of attributing the sample to a default.
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
    /// Sticky voice-archive id the next `koePlay(sample_id)` resolves
    /// through, or `None` when no archive is known yet. A fresh runtime
    /// starts UNKNOWN — there is no baked-in default archive. The current
    /// archive is established by an authoritative RealLive operation that
    /// names one (`koePlayEx`) or by explicit per-game configuration
    /// ([`AudioRuntime::set_current_speaker_archive_id`]); a `koePlay`
    /// dispatched while this is `None` surfaces a typed unresolved
    /// observation rather than guessing.
    current_speaker_archive: Option<i32>,
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
                current_speaker_archive: None,
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

    /// Establish the sticky voice archive the `koePlay(sample_id)` path
    /// consults. This is the explicit, authoritative selector: an
    /// authoritative RealLive operation that names an archive
    /// (`koePlayEx`) or explicit per-game configuration calls it. The
    /// runtime never derives the archive from a different game's
    /// numbering coincidence or a baked-in default.
    pub fn set_current_speaker_archive_id(&self, archive_id: i32) {
        self.lock_inner().current_speaker_archive = Some(archive_id);
    }

    /// The current sticky voice-archive id, or `None` when no archive has
    /// been established yet (a fresh runtime starts UNKNOWN).
    pub fn current_speaker_archive(&self) -> Option<i32> {
        self.lock_inner().current_speaker_archive
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
        // Visual Arts pads voice archive ids to 4 digits with a leading
        // `z`: e.g. `archive_id = 1015` ↔ `z1015.ovk`.
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
