//! RealLive audio/voice playback commands (Bgm/Pcm/Koe modules).
//!
//! Cross-module `(1, {20,21,23}, *)` opcodes that control background music,
//! wav playback, and voice (`koe`) playback. Per the rlvm oracle every one
//! is a **void command** (`RLOpcode`, not `RLStoreOpcode` — none writes the
//! `store` register):
//!
//! | Addr | rlvm name | rlvm handler |
//! | ------------ | ------------ | -------------------------------------- |
//! | `(1,20,105)` | `bgmFadeOut` | `SoundSystem::BgmFadeOut` (module_bgm.cc:182) |
//! | `(1,21,5)` | `wavStop` | `SoundSystem::WavStop` (module_pcm.cc:183) |
//! | `(1,21,105)` | `wavFadeOut` | `SoundSystem::WavFadeOut` (module_pcm.cc:203) |
//! | `(1,23,6)` | `koeWaitC` | wait until voice done (module_koe.cc:134) |
//! | `(1,23,8)` | `koeDoPlay` | play voice (module_koe.cc:68/139) |
//!
//! The headless drive-to-terminus produces no audio, so none of these
//! affects the executed control-flow path: fade/stop/play are side effects
//! on the (absent) sound system, and `koeWaitC` waits for a voice that is
//! never playing — it resolves immediately under the headless scheduler,
//! exactly like the `sys` timer `time`-waits. So `Advance` is behaviourally
//! exact, matching how unknown opcodes are already advanced past. Real audio
//! playback/fade is the render/playback path's surface.
//!
//! NOTE: the getter opcodes in these modules (`koePlaying` `(1,23,4)`,
//! `wavPlaying`) write `store` and are deliberately NOT mounted here — an
//! `Advance` there would hide a store read. `(1,23,101)` is absent from the
//! rlvm oracle and left unclassified rather than guessed.

use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::vm::Vm;
use std::sync::Arc;

/// RealLive compiler-version module type these audio modules register at.
const AUDIO_MODULE_TYPE: u8 = 1;

/// The audio/voice playback commands this module mounts, as
/// `(module_id, opcode, diagnostic tag)`.
const MEDIA_COMMANDS: &[(u8, u16, &str)] = &[
    (20, 105, "bgm.fade_out"),
    (21, 5, "pcm.wav_stop"),
    (21, 105, "pcm.wav_fade_out"),
    (23, 6, "koe.wait_c"),
    (23, 8, "koe.do_play"),
];

/// A void audio/voice playback command. Writes no `store` and takes no
/// control transfer; under the headless drive (no audio) it advances past.
#[derive(Debug)]
pub struct MediaCommand {
    /// Stable diagnostic tag (e.g. `"koe.do_play"`).
    tag: &'static str,
}

impl MediaCommand {
    pub fn new(tag: &'static str) -> Self {
        Self { tag }
    }

    /// The diagnostic tag this command reports under.
    pub fn tag(&self) -> &'static str {
        self.tag
    }
}

impl RLOperation for MediaCommand {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        // Sound-system side effect only (or a wait for never-playing audio);
        // no store, no transfer. Advance.
        DispatchOutcome::Advance
    }
}

/// Mount every audio/voice playback command. Returns the number of
/// registrations made.
pub fn register_media_rlops(registry: &mut RlopRegistry) -> usize {
    let mut count = 0;
    for &(module_id, opcode, tag) in MEDIA_COMMANDS {
        let op: Arc<dyn RLOperation> = Arc::new(MediaCommand::new(tag));
        registry.register(RlopKey::new(AUDIO_MODULE_TYPE, module_id, opcode), op);
        count += 1;
    }
    count
}

/// Number of registrations [`register_media_rlops`] makes.
pub const MEDIA_RLOP_COUNT: usize = MEDIA_COMMANDS.len();

#[cfg(test)]
#[path = "module_media_commands_tests.rs"]
mod tests;
