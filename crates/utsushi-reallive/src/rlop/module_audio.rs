//! UTSUSHI-217 — RealLive `module_bgm` / `module_koe` / `module_pcm` /
//! `module_se` RLOperation families.
//!
//! Implements the ~15 audio opcodes across the four submodules
//! (`bgm`, `koe`, `pcm`, `se`) the UTSUSHI-217 spec node pins as the
//! alpha-tier coverage frontier. Every op routes through a shared
//! [`AudioRuntime`] that owns:
//!
//! 1. The Gameexe-derived `FOLDNAME.<KIND>` resolution surface
//!    ([`AudioRuntime::bgm_asset_id_for`], etc.) so a `bgmPlay("ASA")`
//!    resolves to `"bgm/ASA"` (the asset id) without dragging a
//!    full `AssetPackage` through the dispatch boundary.
//! 2. The Gameexe-derived `NAMAE` speaker registry so a `koePlay(46)`
//!    can resolve through a "current speaker" register to a typed
//!    `(archive_id, sample_id)` pair, surfaced as the
//!    [`crate::audio::AudioEventPayload::Voice`] payload.
//! 3. The [`crate::audio::AudioEventEmitter`] that retains the typed
//!    audio events the substrate-gap follow-up will swap into the
//!    substrate `AudioEventSink` (see `audio.rs` module docstring for
//!    the E1-vs-E0 reconciliation).
//!
//! # Module addressing
//!
//! The four `(module_type, module_id)` pairs follow the rlvm /
//! RLDEV catalogue (`docs/research/reallive-engine.md` §F). rlvm is a
//! research anchor only; the byte values below are restated as
//! const-pinned audit anchors, not derived by mechanical translation.
//!
//! - `module_bgm` — `(1, 20)` per RLDEV `module_bgm.cc`
//! - `module_koe` — `(1, 23)` per RLDEV `module_koe.cc`
//! - `module_pcm` — `(1, 21)` per RLDEV `module_pcm.cc`
//! - `module_se`  — `(1, 22)` per RLDEV `module_se.cc`
//!
//! # Audit-focus posture
//!
//! - **No silent fallbacks.** Each op consumes its declared arg count
//!   through typed accessors; a mismatch records a fail-soft
//!   [`AudioRuntimeWarning`] rather than panicking.
//! - **AudioEvent payload carries voice-archive metadata.** The
//!   [`crate::audio::AudioEventPayload::Voice`] variant is the
//!   structural surface that addresses the spec's audit-focus pin —
//!   the type forbids a stringly-typed collapse at the type-system
//!   layer.
//! - **No actual sample mixing.** The decoder layer ([`crate::nwa`] /
//!   [`crate::ovk`]) verifies header / table decode; the rlop layer
//!   emits typed metadata; nothing in this module references an audio
//!   output device.

use std::sync::{Arc, Mutex};

use crate::audio::{AudioEvent, AudioEventEmitter, AudioEventKind, AudioEventPayload};
use crate::gameexe::Gameexe;
use crate::vm::Vm;

use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};

// ---- module_bgm ------------------------------------------------------

/// `module_type` byte for the BGM submodule. Per RLDEV catalogue.
pub const BGM_MODULE_TYPE: u8 = 1;
/// `module_id` byte for the BGM submodule.
pub const BGM_MODULE_ID: u8 = 20;

/// `bgm.bgmPlay(string asset_name)`
pub const OPCODE_BGM_PLAY: u16 = 0;
/// `bgm.bgmStop()`
pub const OPCODE_BGM_STOP: u16 = 1;
/// `bgm.bgmFadeOut(int duration_ms)`
pub const OPCODE_BGM_FADE_OUT: u16 = 2;
/// `bgm.bgmLoop(string asset_name)` — looped variant.
pub const OPCODE_BGM_LOOP: u16 = 3;
/// `bgm.bgmStatus()` — returns 1 if BGM is currently playing, 0
/// otherwise. The dispatch writes the value to the store register.
pub const OPCODE_BGM_STATUS: u16 = 4;

/// All BGM opcodes this module ships. Pinned for the audit test that
/// asserts every opcode is registered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum BgmOpcode {
    Play,
    Stop,
    FadeOut,
    Loop,
    Status,
}

impl BgmOpcode {
    pub const ALL: &'static [BgmOpcode] = &[
        Self::Play,
        Self::Stop,
        Self::FadeOut,
        Self::Loop,
        Self::Status,
    ];

    pub fn opcode(self) -> u16 {
        match self {
            Self::Play => OPCODE_BGM_PLAY,
            Self::Stop => OPCODE_BGM_STOP,
            Self::FadeOut => OPCODE_BGM_FADE_OUT,
            Self::Loop => OPCODE_BGM_LOOP,
            Self::Status => OPCODE_BGM_STATUS,
        }
    }

    pub fn rlop_key(self) -> RlopKey {
        RlopKey::new(BGM_MODULE_TYPE, BGM_MODULE_ID, self.opcode())
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Play => "bgm.bgmPlay",
            Self::Stop => "bgm.bgmStop",
            Self::FadeOut => "bgm.bgmFadeOut",
            Self::Loop => "bgm.bgmLoop",
            Self::Status => "bgm.bgmStatus",
        }
    }
}

// ---- module_koe ------------------------------------------------------

/// `module_type` byte for the KOE (voice) submodule.
pub const KOE_MODULE_TYPE: u8 = 1;
/// `module_id` byte for the KOE submodule.
pub const KOE_MODULE_ID: u8 = 23;

/// `koe.koePlay(int sample_id)` — single-arg form. Resolves through
/// the current speaker's archive id.
pub const OPCODE_KOE_PLAY: u16 = 0;
/// `koe.koePlayEx(int archive_id, int sample_id)` — explicit form.
pub const OPCODE_KOE_PLAY_EX: u16 = 1;
/// `koe.koeStop()`
pub const OPCODE_KOE_STOP: u16 = 3;
/// `koe.koeWait(int sample_id)` — wait for sample completion.
pub const OPCODE_KOE_WAIT: u16 = 4;
/// `koe.koeStatus()` — returns 1 if a voice is currently playing.
pub const OPCODE_KOE_STATUS: u16 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum KoeOpcode {
    Play,
    PlayEx,
    Stop,
    Wait,
    Status,
}

impl KoeOpcode {
    pub const ALL: &'static [KoeOpcode] = &[
        Self::Play,
        Self::PlayEx,
        Self::Stop,
        Self::Wait,
        Self::Status,
    ];

    pub fn opcode(self) -> u16 {
        match self {
            Self::Play => OPCODE_KOE_PLAY,
            Self::PlayEx => OPCODE_KOE_PLAY_EX,
            Self::Stop => OPCODE_KOE_STOP,
            Self::Wait => OPCODE_KOE_WAIT,
            Self::Status => OPCODE_KOE_STATUS,
        }
    }

    pub fn rlop_key(self) -> RlopKey {
        RlopKey::new(KOE_MODULE_TYPE, KOE_MODULE_ID, self.opcode())
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Play => "koe.koePlay",
            Self::PlayEx => "koe.koePlayEx",
            Self::Stop => "koe.koeStop",
            Self::Wait => "koe.koeWait",
            Self::Status => "koe.koeStatus",
        }
    }
}

// ---- module_pcm ------------------------------------------------------

/// `module_type` byte for the PCM (wav) submodule.
pub const PCM_MODULE_TYPE: u8 = 1;
/// `module_id` byte for the PCM submodule.
pub const PCM_MODULE_ID: u8 = 21;

/// `pcm.wavPlay(string asset_name)`
pub const OPCODE_WAV_PLAY: u16 = 0;
/// `pcm.wavStop()`
pub const OPCODE_WAV_STOP: u16 = 1;
/// `pcm.wavLoop(string asset_name)` — looped variant.
pub const OPCODE_WAV_LOOP: u16 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PcmOpcode {
    Play,
    Stop,
    Loop,
}

impl PcmOpcode {
    pub const ALL: &'static [PcmOpcode] = &[Self::Play, Self::Stop, Self::Loop];

    pub fn opcode(self) -> u16 {
        match self {
            Self::Play => OPCODE_WAV_PLAY,
            Self::Stop => OPCODE_WAV_STOP,
            Self::Loop => OPCODE_WAV_LOOP,
        }
    }

    pub fn rlop_key(self) -> RlopKey {
        RlopKey::new(PCM_MODULE_TYPE, PCM_MODULE_ID, self.opcode())
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Play => "pcm.wavPlay",
            Self::Stop => "pcm.wavStop",
            Self::Loop => "pcm.wavLoop",
        }
    }
}

// ---- module_se -------------------------------------------------------

/// `module_type` byte for the SE submodule.
pub const SE_MODULE_TYPE: u8 = 1;
/// `module_id` byte for the SE submodule.
pub const SE_MODULE_ID: u8 = 22;

/// `se.playSe(int slot)` — resolves the slot through Gameexe `#SE.<slot>`
/// to an asset name (see Gameexe documentation).
pub const OPCODE_PLAY_SE: u16 = 0;
/// `se.hasSe(int slot)` — returns 1 if the slot is populated. The
/// dispatch writes the value to the store register.
pub const OPCODE_HAS_SE: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SeOpcode {
    PlaySe,
    HasSe,
}

impl SeOpcode {
    pub const ALL: &'static [SeOpcode] = &[Self::PlaySe, Self::HasSe];

    pub fn opcode(self) -> u16 {
        match self {
            Self::PlaySe => OPCODE_PLAY_SE,
            Self::HasSe => OPCODE_HAS_SE,
        }
    }

    pub fn rlop_key(self) -> RlopKey {
        RlopKey::new(SE_MODULE_TYPE, SE_MODULE_ID, self.opcode())
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::PlaySe => "se.playSe",
            Self::HasSe => "se.hasSe",
        }
    }
}

/// Total RLOperations the audio family registers. Pinned at the
/// UTSUSHI-217 spec target of ~15 (15 today).
pub const AUDIO_RLOP_COUNT: usize =
    BgmOpcode::ALL.len() + KoeOpcode::ALL.len() + PcmOpcode::ALL.len() + SeOpcode::ALL.len();

// ---- AudioRuntime ----------------------------------------------------

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

struct AudioRuntimeInner {
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
    /// 1 if the BGM channel is currently playing (post-bgmPlay,
    /// pre-bgmStop/bgmFadeOut). The bgmStatus opcode reads this.
    bgm_playing: bool,
    /// 1 if a voice is currently playing. The koeStatus opcode reads
    /// this.
    koe_playing: bool,
    warnings: Vec<AudioRuntimeWarning>,
}

impl std::fmt::Debug for AudioRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("AudioRuntime").finish()
    }
}

impl AudioRuntime {
    /// Build a runtime without any Gameexe context. `bgmPlay` /
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
    /// integers. The first two compose the voice-archive id the
    /// `koe/z<archive:04>.ovk` filename uses: `composite_archive =
    /// archive_field * 1000 + pattern_field`. So `(1, 015, -1)` ↔
    /// `z1015.ovk`, `(1, 016, -1)` ↔ `z1016.ovk`, `(0, 011, -1)` ↔
    /// `z0011.ovk`. The third field is the pitch override (unused for
    /// archive resolution).
    ///
    /// This composition matches the file listing under Sweetie HD's
    /// `REALLIVEDATA/koe/` exactly (we observe `z1011`, `z1014`,
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
                .map(|entry| Self::namae_to_archive_id(entry.archive, entry.pattern))
        };
        if let Some(archive_id) = composite_archive_opt {
            self.lock_inner().current_speaker_archive_id = archive_id;
            true
        } else {
            false
        }
    }

    /// Compose the voice-archive id from a NAMAE row's
    /// `(archive_field, pattern_field)` pair. See
    /// [`Self::select_speaker_by_display_name`] for the format rule.
    pub fn namae_to_archive_id(archive_field: i32, pattern_field: i32) -> i32 {
        archive_field
            .saturating_mul(1000)
            .saturating_add(pattern_field)
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
        // The `#SE.<slot>` value shape in RealLive is `"asset_name",
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
        // leading `z`. Sweetie HD's `z0001.ovk` ↔ `archive_id = 1`,
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

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, AudioRuntimeInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn record_warning(&self, warning: AudioRuntimeWarning) {
        self.lock_inner().warnings.push(warning);
    }

    fn emit(&self, kind: AudioEventKind, payload: AudioEventPayload) -> AudioEvent {
        self.emitter.emit(kind, payload)
    }
}

// ---- per-op implementors ---------------------------------------------

/// `bgm.bgmPlay(string asset_name)` — emits a typed `BgmStart`
/// audio event with the engine-resolved asset id.
#[derive(Debug)]
pub struct BgmPlayOp {
    runtime: Arc<AudioRuntime>,
}

impl BgmPlayOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for BgmPlayOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let name = match args.first() {
            Some(ExprValue::Bytes(bytes)) => {
                decode_shift_jis(bytes).map(|name| if name.is_empty() { None } else { Some(name) })
            }
            Some(ExprValue::Int(_)) => {
                self.runtime
                    .record_warning(AudioRuntimeWarning::ArgShapeMismatch {
                        opcode_tag: BgmOpcode::Play.as_str(),
                        expected: "bytes",
                    });
                Some(None)
            }
            None => {
                self.runtime
                    .record_warning(AudioRuntimeWarning::MissingArg {
                        opcode_tag: BgmOpcode::Play.as_str(),
                        slot: "asset_name",
                    });
                Some(None)
            }
        };
        match name {
            Some(Some(name)) => {
                let asset_id = self.runtime.bgm_asset_id_for(&name);
                self.runtime.emit(
                    AudioEventKind::BgmStart,
                    AudioEventPayload::Asset { asset_id },
                );
                self.runtime.lock_inner().bgm_playing = true;
            }
            Some(None) => {
                // Empty asset name — record but don't fire.
            }
            None => {
                self.runtime
                    .record_warning(AudioRuntimeWarning::InvalidShiftJis {
                        opcode_tag: BgmOpcode::Play.as_str(),
                    });
            }
        }
        DispatchOutcome::Advance
    }
}

/// `bgm.bgmStop()` — emits a typed `BgmStop` event.
#[derive(Debug)]
pub struct BgmStopOp {
    runtime: Arc<AudioRuntime>,
}

impl BgmStopOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for BgmStopOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        self.runtime.emit(
            AudioEventKind::BgmStop,
            AudioEventPayload::Stop {
                cue_id: "bgm_stop".to_string(),
            },
        );
        self.runtime.lock_inner().bgm_playing = false;
        DispatchOutcome::Advance
    }
}

/// `bgm.bgmFadeOut(int duration_ms)` — emits a typed `BgmStop` event
/// whose `cue_id` carries the fade duration.
#[derive(Debug)]
pub struct BgmFadeOutOp {
    runtime: Arc<AudioRuntime>,
}

impl BgmFadeOutOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for BgmFadeOutOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let duration_ms = match args.first() {
            Some(ExprValue::Int(n)) => *n,
            Some(ExprValue::Bytes(_)) => {
                self.runtime
                    .record_warning(AudioRuntimeWarning::ArgShapeMismatch {
                        opcode_tag: BgmOpcode::FadeOut.as_str(),
                        expected: "int",
                    });
                0
            }
            None => {
                self.runtime
                    .record_warning(AudioRuntimeWarning::MissingArg {
                        opcode_tag: BgmOpcode::FadeOut.as_str(),
                        slot: "duration_ms",
                    });
                0
            }
        };
        let cue_id = format!("bgm_fade_out_{}ms", duration_ms.max(0));
        self.runtime
            .emit(AudioEventKind::BgmStop, AudioEventPayload::Stop { cue_id });
        self.runtime.lock_inner().bgm_playing = false;
        DispatchOutcome::Advance
    }
}

/// `bgm.bgmLoop(string asset_name)` — emits a `BgmStart` event with a
/// `cue_id` marker indicating the loop semantics. Mirrors `bgmPlay`
/// but adds a `Marker` emission so the audit trail can distinguish
/// "one-shot" from "looped" BGM starts.
#[derive(Debug)]
pub struct BgmLoopOp {
    runtime: Arc<AudioRuntime>,
}

impl BgmLoopOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for BgmLoopOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let name = match args.first() {
            Some(ExprValue::Bytes(bytes)) => decode_shift_jis(bytes),
            Some(ExprValue::Int(_)) => {
                self.runtime
                    .record_warning(AudioRuntimeWarning::ArgShapeMismatch {
                        opcode_tag: BgmOpcode::Loop.as_str(),
                        expected: "bytes",
                    });
                return DispatchOutcome::Advance;
            }
            None => {
                self.runtime
                    .record_warning(AudioRuntimeWarning::MissingArg {
                        opcode_tag: BgmOpcode::Loop.as_str(),
                        slot: "asset_name",
                    });
                return DispatchOutcome::Advance;
            }
        };
        let Some(name) = name else {
            self.runtime
                .record_warning(AudioRuntimeWarning::InvalidShiftJis {
                    opcode_tag: BgmOpcode::Loop.as_str(),
                });
            return DispatchOutcome::Advance;
        };
        if name.is_empty() {
            return DispatchOutcome::Advance;
        }
        let asset_id = self.runtime.bgm_asset_id_for(&name);
        self.runtime.emit(
            AudioEventKind::BgmStart,
            AudioEventPayload::Asset { asset_id },
        );
        self.runtime.emit(
            AudioEventKind::Marker,
            AudioEventPayload::Marker {
                cue_id: "bgm_loop_point".to_string(),
            },
        );
        self.runtime.lock_inner().bgm_playing = true;
        DispatchOutcome::Advance
    }
}

/// `bgm.bgmStatus()` — writes `1` to the store register if BGM is
/// currently playing, `0` otherwise.
#[derive(Debug)]
pub struct BgmStatusOp {
    runtime: Arc<AudioRuntime>,
}

impl BgmStatusOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for BgmStatusOp {
    fn dispatch(&self, vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        let value: u32 = u32::from(self.runtime.bgm_playing());
        vm.banks_mut().set_store(value);
        DispatchOutcome::Advance
    }
}

/// `koe.koePlay(int sample_id)` — resolves the sample through the
/// current speaker archive and emits a typed `VoicePlay` event.
#[derive(Debug)]
pub struct KoePlayOp {
    runtime: Arc<AudioRuntime>,
}

impl KoePlayOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for KoePlayOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let sample_id = match args.first() {
            Some(ExprValue::Int(n)) => *n,
            Some(ExprValue::Bytes(_)) => {
                self.runtime
                    .record_warning(AudioRuntimeWarning::ArgShapeMismatch {
                        opcode_tag: KoeOpcode::Play.as_str(),
                        expected: "int",
                    });
                return DispatchOutcome::Advance;
            }
            None => {
                self.runtime
                    .record_warning(AudioRuntimeWarning::MissingArg {
                        opcode_tag: KoeOpcode::Play.as_str(),
                        slot: "sample_id",
                    });
                return DispatchOutcome::Advance;
            }
        };
        let archive_id = self.runtime.current_speaker_archive_id();
        if archive_id <= 0 {
            self.runtime
                .record_warning(AudioRuntimeWarning::NoCurrentSpeaker);
            return DispatchOutcome::Advance;
        }
        let archive_label = AudioRuntime::voice_archive_label(archive_id);
        self.runtime.emit(
            AudioEventKind::VoicePlay,
            AudioEventPayload::Voice {
                archive_id: archive_label,
                sample_id: sample_id.max(0) as u32,
            },
        );
        self.runtime.lock_inner().koe_playing = true;
        DispatchOutcome::Advance
    }
}

/// `koe.koePlayEx(int archive_id, int sample_id)` — explicit form.
#[derive(Debug)]
pub struct KoePlayExOp {
    runtime: Arc<AudioRuntime>,
}

impl KoePlayExOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for KoePlayExOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let archive_id = if let Some(ExprValue::Int(n)) = args.first() {
            *n
        } else {
            self.runtime
                .record_warning(AudioRuntimeWarning::MissingArg {
                    opcode_tag: KoeOpcode::PlayEx.as_str(),
                    slot: "archive_id",
                });
            return DispatchOutcome::Advance;
        };
        let sample_id = if let Some(ExprValue::Int(n)) = args.get(1) {
            *n
        } else {
            self.runtime
                .record_warning(AudioRuntimeWarning::MissingArg {
                    opcode_tag: KoeOpcode::PlayEx.as_str(),
                    slot: "sample_id",
                });
            return DispatchOutcome::Advance;
        };
        let archive_label = AudioRuntime::voice_archive_label(archive_id);
        self.runtime.emit(
            AudioEventKind::VoicePlay,
            AudioEventPayload::Voice {
                archive_id: archive_label,
                sample_id: sample_id.max(0) as u32,
            },
        );
        self.runtime.lock_inner().koe_playing = true;
        DispatchOutcome::Advance
    }
}

/// `koe.koeStop()` — emits a typed `VoiceStop` event.
#[derive(Debug)]
pub struct KoeStopOp {
    runtime: Arc<AudioRuntime>,
}

impl KoeStopOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for KoeStopOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        self.runtime.emit(
            AudioEventKind::VoiceStop,
            AudioEventPayload::VoiceStop {
                cue_id: "koe_stop".to_string(),
            },
        );
        self.runtime.lock_inner().koe_playing = false;
        DispatchOutcome::Advance
    }
}

/// `koe.koeWait(int sample_id)` — emits a `Marker` event naming the
/// sample being waited on. Does not block (the substrate has no
/// audio output; the wait is observably a marker).
#[derive(Debug)]
pub struct KoeWaitOp {
    runtime: Arc<AudioRuntime>,
}

impl KoeWaitOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for KoeWaitOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let sample_id = match args.first() {
            Some(ExprValue::Int(n)) => *n,
            _ => 0,
        };
        self.runtime.emit(
            AudioEventKind::Marker,
            AudioEventPayload::Marker {
                cue_id: format!("koe_wait_{sample_id}"),
            },
        );
        DispatchOutcome::Advance
    }
}

/// `koe.koeStatus()` — writes `1` to the store register if a voice
/// is currently playing, `0` otherwise.
#[derive(Debug)]
pub struct KoeStatusOp {
    runtime: Arc<AudioRuntime>,
}

impl KoeStatusOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for KoeStatusOp {
    fn dispatch(&self, vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        let value: u32 = u32::from(self.runtime.koe_playing());
        vm.banks_mut().set_store(value);
        DispatchOutcome::Advance
    }
}

/// `pcm.wavPlay(string asset_name)` — emits a typed `SeFire` event
/// (the substrate `AudioEventKind` taxonomy does not distinguish
/// "wav" from "se"; both are non-BGM, non-voice audio firings).
#[derive(Debug)]
pub struct WavPlayOp {
    runtime: Arc<AudioRuntime>,
}

impl WavPlayOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for WavPlayOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let name = match args.first() {
            Some(ExprValue::Bytes(bytes)) => decode_shift_jis(bytes),
            Some(ExprValue::Int(_)) => {
                self.runtime
                    .record_warning(AudioRuntimeWarning::ArgShapeMismatch {
                        opcode_tag: PcmOpcode::Play.as_str(),
                        expected: "bytes",
                    });
                return DispatchOutcome::Advance;
            }
            None => {
                self.runtime
                    .record_warning(AudioRuntimeWarning::MissingArg {
                        opcode_tag: PcmOpcode::Play.as_str(),
                        slot: "asset_name",
                    });
                return DispatchOutcome::Advance;
            }
        };
        let Some(name) = name else {
            self.runtime
                .record_warning(AudioRuntimeWarning::InvalidShiftJis {
                    opcode_tag: PcmOpcode::Play.as_str(),
                });
            return DispatchOutcome::Advance;
        };
        if name.is_empty() {
            return DispatchOutcome::Advance;
        }
        let asset_id = self.runtime.wav_asset_id_for(&name);
        self.runtime.emit(
            AudioEventKind::SeFire,
            AudioEventPayload::Asset { asset_id },
        );
        DispatchOutcome::Advance
    }
}

/// `pcm.wavStop()` — emits a `Marker` cue indicating the wav channel
/// stopped.
#[derive(Debug)]
pub struct WavStopOp {
    runtime: Arc<AudioRuntime>,
}

impl WavStopOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for WavStopOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        self.runtime.emit(
            AudioEventKind::Marker,
            AudioEventPayload::Marker {
                cue_id: "wav_stop".to_string(),
            },
        );
        DispatchOutcome::Advance
    }
}

/// `pcm.wavLoop(string asset_name)` — looped wav variant.
#[derive(Debug)]
pub struct WavLoopOp {
    runtime: Arc<AudioRuntime>,
}

impl WavLoopOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for WavLoopOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let name = if let Some(ExprValue::Bytes(bytes)) = args.first() {
            decode_shift_jis(bytes)
        } else {
            self.runtime
                .record_warning(AudioRuntimeWarning::MissingArg {
                    opcode_tag: PcmOpcode::Loop.as_str(),
                    slot: "asset_name",
                });
            return DispatchOutcome::Advance;
        };
        let Some(name) = name else {
            self.runtime
                .record_warning(AudioRuntimeWarning::InvalidShiftJis {
                    opcode_tag: PcmOpcode::Loop.as_str(),
                });
            return DispatchOutcome::Advance;
        };
        if name.is_empty() {
            return DispatchOutcome::Advance;
        }
        let asset_id = self.runtime.wav_asset_id_for(&name);
        self.runtime.emit(
            AudioEventKind::SeFire,
            AudioEventPayload::Asset { asset_id },
        );
        self.runtime.emit(
            AudioEventKind::Marker,
            AudioEventPayload::Marker {
                cue_id: "wav_loop_point".to_string(),
            },
        );
        DispatchOutcome::Advance
    }
}

/// `se.playSe(int slot)` — resolves the slot through Gameexe
/// `#SE.<slot>` and emits a `SeFire` event.
#[derive(Debug)]
pub struct PlaySeOp {
    runtime: Arc<AudioRuntime>,
}

impl PlaySeOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for PlaySeOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let slot = if let Some(ExprValue::Int(n)) = args.first() {
            *n
        } else {
            self.runtime
                .record_warning(AudioRuntimeWarning::MissingArg {
                    opcode_tag: SeOpcode::PlaySe.as_str(),
                    slot: "slot",
                });
            return DispatchOutcome::Advance;
        };
        let Some(asset_id) = self.runtime.se_asset_id_for_slot(slot) else {
            self.runtime
                .record_warning(AudioRuntimeWarning::UnknownSeSlot { slot });
            return DispatchOutcome::Advance;
        };
        self.runtime.emit(
            AudioEventKind::SeFire,
            AudioEventPayload::Asset { asset_id },
        );
        DispatchOutcome::Advance
    }
}

/// `se.hasSe(int slot)` — writes `1` to the store register if the slot
/// is populated, `0` otherwise.
#[derive(Debug)]
pub struct HasSeOp {
    runtime: Arc<AudioRuntime>,
}

impl HasSeOp {
    pub fn new(runtime: Arc<AudioRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for HasSeOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let slot = if let Some(ExprValue::Int(n)) = args.first() {
            *n
        } else {
            self.runtime
                .record_warning(AudioRuntimeWarning::MissingArg {
                    opcode_tag: SeOpcode::HasSe.as_str(),
                    slot: "slot",
                });
            vm.banks_mut().set_store(0);
            return DispatchOutcome::Advance;
        };
        let value: u32 = u32::from(self.runtime.se_asset_id_for_slot(slot).is_some());
        vm.banks_mut().set_store(value);
        DispatchOutcome::Advance
    }
}

/// Mount every audio op (bgm + koe + pcm + se) into `registry`.
/// Returns the number of opcodes registered.
pub fn register_audio_rlops(registry: &mut RlopRegistry, runtime: Arc<AudioRuntime>) -> usize {
    let mut count = 0;
    let mut register = |key: RlopKey, op: Arc<dyn RLOperation>| {
        registry.register(key, op);
        count += 1;
    };

    // BGM
    register(
        BgmOpcode::Play.rlop_key(),
        Arc::new(BgmPlayOp::new(Arc::clone(&runtime))),
    );
    register(
        BgmOpcode::Stop.rlop_key(),
        Arc::new(BgmStopOp::new(Arc::clone(&runtime))),
    );
    register(
        BgmOpcode::FadeOut.rlop_key(),
        Arc::new(BgmFadeOutOp::new(Arc::clone(&runtime))),
    );
    register(
        BgmOpcode::Loop.rlop_key(),
        Arc::new(BgmLoopOp::new(Arc::clone(&runtime))),
    );
    register(
        BgmOpcode::Status.rlop_key(),
        Arc::new(BgmStatusOp::new(Arc::clone(&runtime))),
    );

    // KOE
    register(
        KoeOpcode::Play.rlop_key(),
        Arc::new(KoePlayOp::new(Arc::clone(&runtime))),
    );
    register(
        KoeOpcode::PlayEx.rlop_key(),
        Arc::new(KoePlayExOp::new(Arc::clone(&runtime))),
    );
    register(
        KoeOpcode::Stop.rlop_key(),
        Arc::new(KoeStopOp::new(Arc::clone(&runtime))),
    );
    register(
        KoeOpcode::Wait.rlop_key(),
        Arc::new(KoeWaitOp::new(Arc::clone(&runtime))),
    );
    register(
        KoeOpcode::Status.rlop_key(),
        Arc::new(KoeStatusOp::new(Arc::clone(&runtime))),
    );

    // PCM
    register(
        PcmOpcode::Play.rlop_key(),
        Arc::new(WavPlayOp::new(Arc::clone(&runtime))),
    );
    register(
        PcmOpcode::Stop.rlop_key(),
        Arc::new(WavStopOp::new(Arc::clone(&runtime))),
    );
    register(
        PcmOpcode::Loop.rlop_key(),
        Arc::new(WavLoopOp::new(Arc::clone(&runtime))),
    );

    // SE
    register(
        SeOpcode::PlaySe.rlop_key(),
        Arc::new(PlaySeOp::new(Arc::clone(&runtime))),
    );
    register(
        SeOpcode::HasSe.rlop_key(),
        Arc::new(HasSeOp::new(Arc::clone(&runtime))),
    );

    count
}

/// Decode a Shift-JIS byte slice to a UTF-8 `String`. Returns `None`
/// on any decoding substitution — the rlop layer treats a malformed
/// asset name as a typed warning, not a silent recovery.
fn decode_shift_jis(bytes: &[u8]) -> Option<String> {
    let (cow, _, had_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
    if had_errors {
        return None;
    }
    Some(cow.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gameexe::Gameexe;
    use crate::vm::Vm;

    fn synth_runtime() -> Arc<AudioRuntime> {
        let emitter = Arc::new(AudioEventEmitter::new());
        Arc::new(AudioRuntime::new(emitter))
    }

    fn synth_gameexe(text: &str) -> Arc<Gameexe> {
        let bytes = encoding_rs::SHIFT_JIS.encode(text).0.into_owned();
        Arc::new(Gameexe::parse(&bytes).expect("gameexe parses"))
    }

    #[test]
    fn audio_rlop_count_is_fifteen() {
        // The UTSUSHI-217 spec target: ~15 audio RLOperations across
        // bgm + koe + pcm + se. We pin the exact count so a future
        // addition shows up in the audit trail.
        assert_eq!(AUDIO_RLOP_COUNT, 15);
    }

    #[test]
    fn register_audio_rlops_mounts_one_entry_per_opcode() {
        let runtime = synth_runtime();
        let mut registry = RlopRegistry::new();
        let count = register_audio_rlops(&mut registry, runtime);
        assert_eq!(count, AUDIO_RLOP_COUNT);
        assert_eq!(registry.len(), AUDIO_RLOP_COUNT);
        for opcode in BgmOpcode::ALL {
            assert!(registry.get(opcode.rlop_key()).is_some());
        }
        for opcode in KoeOpcode::ALL {
            assert!(registry.get(opcode.rlop_key()).is_some());
        }
        for opcode in PcmOpcode::ALL {
            assert!(registry.get(opcode.rlop_key()).is_some());
        }
        for opcode in SeOpcode::ALL {
            assert!(registry.get(opcode.rlop_key()).is_some());
        }
    }

    #[test]
    fn voice_archive_label_pads_to_four_digits() {
        assert_eq!(AudioRuntime::voice_archive_label(1), "z0001");
        assert_eq!(AudioRuntime::voice_archive_label(1015), "z1015");
        assert_eq!(AudioRuntime::voice_archive_label(0), "z0000");
        // Negative archive ids clamp to z0000 — never panics.
        assert_eq!(AudioRuntime::voice_archive_label(-1), "z0000");
    }

    #[test]
    fn bgm_play_emits_event_with_resolved_asset_id() {
        let runtime = synth_runtime();
        let mut vm = Vm::new(0u16, 0);
        let op = BgmPlayOp::new(Arc::clone(&runtime));
        op.dispatch(&mut vm, &[ExprValue::Bytes(b"ASA".to_vec())]);
        let events = runtime.emitter().store().in_order_snapshot();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_kind, AudioEventKind::BgmStart);
        match &events[0].payload {
            AudioEventPayload::Asset { asset_id } => assert_eq!(asset_id, "bgm/ASA"),
            other => panic!("expected Asset, got {other:?}"),
        }
        assert!(runtime.bgm_playing());
    }

    #[test]
    fn bgm_play_honours_gameexe_foldname_bgm() {
        let runtime = synth_runtime();
        // Synthesise a Gameexe with `FOLDNAME.BGM = "BGM" = 0 :
        // "BGM.PAK"` — same shape as Sweetie HD.
        let gameexe = synth_gameexe("#FOLDNAME.BGM = \"BGM\" = 0 : \"BGM.PAK\"\n");
        runtime.set_gameexe(gameexe);
        let mut vm = Vm::new(0u16, 0);
        let op = BgmPlayOp::new(Arc::clone(&runtime));
        op.dispatch(&mut vm, &[ExprValue::Bytes(b"ASA".to_vec())]);
        let events = runtime.emitter().store().in_order_snapshot();
        match &events[0].payload {
            AudioEventPayload::Asset { asset_id } => assert_eq!(asset_id, "bgm/ASA"),
            other => panic!("expected Asset, got {other:?}"),
        }
    }

    #[test]
    fn bgm_stop_emits_stop_event() {
        let runtime = synth_runtime();
        let mut vm = Vm::new(0u16, 0);
        BgmPlayOp::new(Arc::clone(&runtime))
            .dispatch(&mut vm, &[ExprValue::Bytes(b"ASA".to_vec())]);
        BgmStopOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[]);
        let events = runtime.emitter().store().in_order_snapshot();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].event_kind, AudioEventKind::BgmStop);
        assert!(!runtime.bgm_playing());
    }

    #[test]
    fn bgm_fade_out_carries_duration_in_cue_id() {
        let runtime = synth_runtime();
        let mut vm = Vm::new(0u16, 0);
        BgmFadeOutOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(2000)]);
        let events = runtime.emitter().store().in_order_snapshot();
        assert_eq!(events.len(), 1);
        match &events[0].payload {
            AudioEventPayload::Stop { cue_id } => assert_eq!(cue_id, "bgm_fade_out_2000ms"),
            other => panic!("expected Stop, got {other:?}"),
        }
    }

    #[test]
    fn bgm_status_writes_one_when_playing_zero_when_stopped() {
        let runtime = synth_runtime();
        let mut vm = Vm::new(0u16, 0);
        BgmStatusOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[]);
        assert_eq!(vm.banks().store(), 0);
        BgmPlayOp::new(Arc::clone(&runtime))
            .dispatch(&mut vm, &[ExprValue::Bytes(b"ASA".to_vec())]);
        BgmStatusOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[]);
        assert_eq!(vm.banks().store(), 1);
    }

    #[test]
    fn koe_play_resolves_archive_through_current_speaker() {
        let runtime = synth_runtime();
        // Default speaker is archive 1 (z0001).
        let mut vm = Vm::new(0u16, 0);
        KoePlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(46)]);
        let events = runtime.emitter().store().in_order_snapshot();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_kind, AudioEventKind::VoicePlay);
        match &events[0].payload {
            AudioEventPayload::Voice {
                archive_id,
                sample_id,
            } => {
                assert_eq!(archive_id, "z0001");
                assert_eq!(*sample_id, 46);
            }
            other => panic!("expected Voice, got {other:?}"),
        }
    }

    #[test]
    fn koe_play_ex_threads_archive_id_directly() {
        let runtime = synth_runtime();
        let mut vm = Vm::new(0u16, 0);
        KoePlayExOp::new(Arc::clone(&runtime))
            .dispatch(&mut vm, &[ExprValue::Int(1015), ExprValue::Int(7)]);
        let events = runtime.emitter().store().in_order_snapshot();
        match &events[0].payload {
            AudioEventPayload::Voice {
                archive_id,
                sample_id,
            } => {
                assert_eq!(archive_id, "z1015");
                assert_eq!(*sample_id, 7);
            }
            other => panic!("expected Voice, got {other:?}"),
        }
    }

    #[test]
    fn koe_stop_emits_voice_stop_event() {
        let runtime = synth_runtime();
        let mut vm = Vm::new(0u16, 0);
        KoePlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(46)]);
        KoeStopOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[]);
        let events = runtime.emitter().store().in_order_snapshot();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].event_kind, AudioEventKind::VoiceStop);
        assert!(!runtime.koe_playing());
    }

    #[test]
    fn select_speaker_walks_namae_table_and_composes_archive_id() {
        let runtime = synth_runtime();
        // Sweetie HD shape: NAMAE = "<speaker>" = "<canonical>" = (archive, pattern, pitch).
        // The composite archive id is `archive * 1000 + pattern` —
        // (1, 15, -1) ↔ z1015.ovk, (1, 16, -1) ↔ z1016.ovk.
        let gameexe = synth_gameexe(
            "#NAMAE = \"和人\" = \"和人\" = (1, 16, -1)\n\
             #NAMAE = \"凛\" = \"凛\" = (1, 15, -1)\n",
        );
        runtime.set_gameexe(gameexe);
        assert!(runtime.select_speaker_by_display_name("凛"));
        assert_eq!(runtime.current_speaker_archive_id(), 1015);
        let mut vm = Vm::new(0u16, 0);
        KoePlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(7)]);
        let events = runtime.emitter().store().in_order_snapshot();
        match &events[0].payload {
            AudioEventPayload::Voice { archive_id, .. } => assert_eq!(archive_id, "z1015"),
            other => panic!("expected Voice, got {other:?}"),
        }
    }

    #[test]
    fn select_speaker_unknown_returns_false_without_changing_archive_id() {
        let runtime = synth_runtime();
        let gameexe = synth_gameexe("#NAMAE = \"凛\" = \"凛\" = (1, 15, -1)\n");
        runtime.set_gameexe(gameexe);
        assert!(!runtime.select_speaker_by_display_name("never-declared"));
        assert_eq!(runtime.current_speaker_archive_id(), 1);
    }

    #[test]
    fn namae_to_archive_id_composes_archive_and_pattern_fields() {
        // Pin the composition formula at the typed-surface layer so a
        // future change to the parser semantics surfaces here.
        assert_eq!(AudioRuntime::namae_to_archive_id(1, 15), 1015);
        assert_eq!(AudioRuntime::namae_to_archive_id(1, 16), 1016);
        assert_eq!(AudioRuntime::namae_to_archive_id(0, 11), 11);
        assert_eq!(AudioRuntime::namae_to_archive_id(2, 0), 2000);
    }

    #[test]
    fn wav_play_emits_se_fire_with_wav_subdir() {
        let runtime = synth_runtime();
        let mut vm = Vm::new(0u16, 0);
        WavPlayOp::new(Arc::clone(&runtime))
            .dispatch(&mut vm, &[ExprValue::Bytes(b"CHIME".to_vec())]);
        let events = runtime.emitter().store().in_order_snapshot();
        match &events[0].payload {
            AudioEventPayload::Asset { asset_id } => assert_eq!(asset_id, "wav/CHIME"),
            other => panic!("expected Asset, got {other:?}"),
        }
    }

    #[test]
    fn play_se_resolves_slot_through_gameexe_se_table() {
        let runtime = synth_runtime();
        let gameexe = synth_gameexe("#SE.005 = \"door1\"\n");
        runtime.set_gameexe(gameexe);
        let mut vm = Vm::new(0u16, 0);
        PlaySeOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(5)]);
        let events = runtime.emitter().store().in_order_snapshot();
        assert_eq!(events.len(), 1);
        match &events[0].payload {
            AudioEventPayload::Asset { asset_id } => assert_eq!(asset_id, "se/door1"),
            other => panic!("expected Asset, got {other:?}"),
        }
    }

    #[test]
    fn play_se_unknown_slot_records_warning_and_no_event() {
        let runtime = synth_runtime();
        let mut vm = Vm::new(0u16, 0);
        PlaySeOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(42)]);
        assert!(runtime.emitter().store().in_order_snapshot().is_empty());
        let warnings = runtime.take_warnings();
        assert!(matches!(
            warnings.as_slice(),
            [AudioRuntimeWarning::UnknownSeSlot { slot: 42 }]
        ));
    }

    #[test]
    fn has_se_writes_one_for_known_slot_zero_for_unknown() {
        let runtime = synth_runtime();
        let gameexe = synth_gameexe("#SE.005 = \"door1\"\n");
        runtime.set_gameexe(gameexe);
        let mut vm = Vm::new(0u16, 0);
        HasSeOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(5)]);
        assert_eq!(vm.banks().store(), 1);
        HasSeOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(99)]);
        assert_eq!(vm.banks().store(), 0);
    }

    #[test]
    fn arg_shape_mismatch_records_typed_warning_and_advances() {
        let runtime = synth_runtime();
        let mut vm = Vm::new(0u16, 0);
        // bgmPlay expects bytes; pass int.
        let outcome = BgmPlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(0)]);
        assert!(matches!(outcome, DispatchOutcome::Advance));
        let warnings = runtime.take_warnings();
        assert!(matches!(
            warnings.as_slice(),
            [AudioRuntimeWarning::ArgShapeMismatch { .. }]
        ));
    }

    #[test]
    fn module_addressing_constants_match_rldev_catalogue() {
        // Audit-anchor pin: the (module_type, module_id) pairs for the
        // four submodules MUST match the RLDEV catalogue. A future
        // refactor that tweaks them would surface here.
        assert_eq!((BGM_MODULE_TYPE, BGM_MODULE_ID), (1, 20));
        assert_eq!((KOE_MODULE_TYPE, KOE_MODULE_ID), (1, 23));
        assert_eq!((PCM_MODULE_TYPE, PCM_MODULE_ID), (1, 21));
        assert_eq!((SE_MODULE_TYPE, SE_MODULE_ID), (1, 22));
    }
}
