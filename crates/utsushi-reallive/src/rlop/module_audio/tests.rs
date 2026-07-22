use super::*;
use crate::audio::AudioEventEmitter;
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
    // The spec target: ~15 audio RLOperations across
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
    assert_eq!(AudioRuntime::voice_archive_label(5), "z0005");
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
    // Synthesise a Gameexe with `FOLDNAME.BGM = "BGM" = 0:
    // "BGM.PAK"` — the RealLive FOLDNAME tuple shape.
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
    BgmPlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Bytes(b"ASA".to_vec())]);
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
    BgmPlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Bytes(b"ASA".to_vec())]);
    BgmStatusOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[]);
    assert_eq!(vm.banks().store(), 1);
}

#[test]
fn koe_play_without_established_archive_is_unresolved_not_defaulted() {
    // A fresh runtime has NO current archive — koePlay must refuse to
    // guess a default and surface a typed unresolved observation, not
    // attribute the sample to a baked-in archive.
    let runtime = synth_runtime();
    assert_eq!(runtime.current_speaker_archive(), None);
    let mut vm = Vm::new(0u16, 0);
    KoePlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(46)]);
    assert!(
        runtime.emitter().store().in_order_snapshot().is_empty(),
        "no VoicePlay may be emitted for an unresolved archive",
    );
    assert!(
        runtime
            .take_warnings()
            .contains(&AudioRuntimeWarning::NoCurrentSpeaker),
        "an unresolved koePlay must record the typed observation",
    );
}

#[test]
fn koe_play_resolves_through_explicitly_established_archive() {
    // Once an archive is established by explicit configuration, a bare
    // koePlay resolves through it — a different archive would yield a
    // different label, proving nothing is hardcoded.
    let runtime = synth_runtime();
    runtime.set_current_speaker_archive_id(1234);
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
            assert_eq!(archive_id, "z1234");
            assert_eq!(*sample_id, 46);
        }
        other => panic!("expected Voice, got {other:?}"),
    }
}

#[test]
fn koe_play_ex_threads_archive_id_directly_and_establishes_current() {
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
    // koePlayEx is an authoritative selector: it establishes the
    // current archive so a following bare koePlay resolves through it.
    assert_eq!(runtime.current_speaker_archive(), Some(1015));
    KoePlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(9)]);
    match &runtime
        .emitter()
        .store()
        .in_order_snapshot()
        .last()
        .unwrap()
        .payload
    {
        AudioEventPayload::Voice { archive_id, .. } => assert_eq!(archive_id, "z1015"),
        other => panic!("expected Voice, got {other:?}"),
    }
}

#[test]
fn koe_stop_emits_voice_stop_event() {
    let runtime = synth_runtime();
    runtime.set_current_speaker_archive_id(7);
    let mut vm = Vm::new(0u16, 0);
    KoePlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(46)]);
    KoeStopOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[]);
    let events = runtime.emitter().store().in_order_snapshot();
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].event_kind, AudioEventKind::VoiceStop);
    assert!(!runtime.koe_playing());
}

#[test]
fn wav_play_emits_se_fire_with_wav_subdir() {
    let runtime = synth_runtime();
    let mut vm = Vm::new(0u16, 0);
    WavPlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Bytes(b"CHIME".to_vec())]);
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
