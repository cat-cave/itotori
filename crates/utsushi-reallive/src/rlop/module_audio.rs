//! RealLive `module_bgm` / `module_koe` / `module_pcm`
//! `module_se` RLOperation families.
//!
//! Implements the ~15 audio opcodes across the four submodules
//! (`bgm`, `koe`, `pcm`, `se`) pinned as the alpha-tier coverage
//! frontier. Every op routes through a shared [`AudioRuntime`] that
//! owns:
//!
//! 1. The Gameexe-derived `FOLDNAME.<KIND>` resolution surface
//!    ([`AudioRuntime::bgm_asset_id_for`], etc.) so a `bgmPlay("ASA")`
//!    resolves to `"bgm/ASA"` (the asset id) without dragging a
//!    full `AssetPackage` through the dispatch boundary.
//! 2. The current voice-archive register a `koePlay(sample_id)`
//!    resolves through to a typed `(archive_id, sample_id)` pair,
//!    surfaced as the [`crate::audio::AudioEventPayload::Voice`]
//!    payload. The register starts UNKNOWN and is established only by an
//!    authoritative RealLive operation that names an archive
//!    (`koePlayEx`) or by explicit per-game configuration — never a
//!    baked-in default; an unresolved `koePlay` surfaces a typed
//!    observation instead of guessing.
//! 3. The [`crate::audio::AudioEventEmitter`] that retains the typed
//!    audio events the substrate-gap follow-up will swap into the
//!    substrate `AudioEventSink` (see `audio.rs` module docstring for
//!    the E1-vs-E0 reconciliation).
//!
//! # Module addressing
//!
//! The four `(module_type, module_id)` pairs follow the rlvm
//! RLDEV catalogue (`docs/research/reallive-engine.md` §F). rlvm is a
//! research anchor only; the byte values below are restated as
//! const-pinned audit anchors, not derived by mechanical translation.
//!
//! - `module_bgm` — `(1, 20)` per RLDEV `module_bgm.cc`
//! - `module_koe` — `(1, 23)` per RLDEV `module_koe.cc`
//! - `module_pcm` — `(1, 21)` per RLDEV `module_pcm.cc`
//! - `module_se` — `(1, 22)` per RLDEV `module_se.cc`
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
//! - **No actual sample mixing.** The decoder layer ([`crate::nwa`]
//!   [`crate::ovk`]) verifies header / table decode; the rlop layer
//!   emits typed metadata; nothing in this module references an audio
//!   output device.

use std::sync::Arc;

use crate::audio::{AudioEventKind, AudioEventPayload};
use crate::vm::Vm;

use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};

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
/// spec target of ~15 (15 today).
pub const AUDIO_RLOP_COUNT: usize =
    BgmOpcode::ALL.len() + KoeOpcode::ALL.len() + PcmOpcode::ALL.len() + SeOpcode::ALL.len();

mod runtime;
pub use runtime::{AudioRuntime, AudioRuntimeWarning};
mod voice;
pub use voice::{KoePlayExOp, KoePlayOp};

#[path = "module_audio/operations.rs"]
mod operations;
pub use operations::{
    BgmFadeOutOp, BgmLoopOp, BgmPlayOp, BgmStatusOp, BgmStopOp, HasSeOp, KoeStatusOp, KoeStopOp,
    KoeWaitOp, PlaySeOp, WavLoopOp, WavPlayOp, WavStopOp,
};

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
#[path = "module_audio/tests.rs"]
mod tests;
