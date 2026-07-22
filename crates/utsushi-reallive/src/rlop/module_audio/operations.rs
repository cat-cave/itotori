use super::*;

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
