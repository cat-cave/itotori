//! Voice-archive selection operations for the `koe` RLOperation family.

use std::sync::Arc;

use crate::audio::{AudioEventKind, AudioEventPayload};
use crate::rlop::{DispatchOutcome, ExprValue, RLOperation};
use crate::vm::Vm;

use super::{AudioRuntime, AudioRuntimeWarning, KoeOpcode};

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
        // Resolve through the currently-established archive. A fresh
        // runtime has none (UNKNOWN); rather than guess a default the
        // dispatcher surfaces a typed unresolved observation. A
        // non-positive archive is likewise treated as unresolved.
        let archive_id = match self.runtime.current_speaker_archive() {
            Some(archive_id) if archive_id > 0 => archive_id,
            _ => {
                self.runtime
                    .record_warning(AudioRuntimeWarning::NoCurrentSpeaker);
                return DispatchOutcome::Advance;
            }
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
        // `koePlayEx` names its archive explicitly — an authoritative
        // RealLive state transition. Establish it as the current archive
        // so a following bare `koePlay(sample_id)` resolves through it.
        self.runtime.set_current_speaker_archive_id(archive_id);
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
