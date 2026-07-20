//! Real-bytes integration tests for the audio RLOperation
//! family.
//!
//! Pins the `koePlay` and `bgmPlay` resolution paths against the primary
//! corpus's `Gameexe.ini` (`#FOLDNAME.BGM`) and against its real
//! `bgm/*.nwa` on-disk layout. Mirrors the `nwa_real_bytes.rs` /
//! `ovk_real_bytes.rs` env-gating pattern.
//!
//! # Acceptance criteria pinned here
//!
//! 1. [`koe_play_archive_selection_is_authoritative_not_defaulted`] — a
//!    fresh runtime has NO current voice archive, so `koePlay(sample)`
//!    surfaces a typed unresolved observation rather than a baked-in
//!    default. Once an archive is established by an authoritative
//!    operation (`koePlayEx`) or explicit configuration, `koePlay`
//!    resolves through it to `AudioEvent { kind: VoicePlay, payload:
//!    Voice { archive_id, sample_id,... } }` formatted as `z<id:04>`.
//! 2. [`bgm_play_resolves_through_foldname_bgm`] — `bgmPlay("ASA")`
//!    dispatched after `set_gameexe` with the corpus's
//!    `#FOLDNAME.BGM = "BGM" = 0: "BGM.PAK"` emits an
//!    `AudioEvent { kind: BgmStart, payload: Asset { asset_id:
//!    "bgm/ASA" } }` — the spec's E1 emission.
//! 3. [`bgm_play_asset_id_resolves_against_real_asa_nwa_path`] — the
//!    resolved `asset_id = "bgm/ASA"` (when post-pended with the
//!    `.nwa` extension and routed under the corpus's
//!    `REALLIVEDATA/bgm/`) lands on the real `ASA.nwa` file.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use utsushi_reallive::{
    AudioEventEmitter, AudioEventKind, AudioEventPayload, AudioRuntime, AudioRuntimeWarning,
    BgmPlayOp, ExprValue, Gameexe, KoePlayExOp, KoePlayOp, RLOperation, Vm,
};

const ASA_NWA: &str = "ASA.nwa";

fn real_gameexe_ini_path() -> Option<PathBuf> {
    real_corpus::gameexe_ini_path()
}

fn real_bgm_dir() -> Option<PathBuf> {
    real_corpus::reallivedata_subdir("bgm")
}

fn load_reallive_real_bytes_gameexe() -> Option<Arc<Gameexe>> {
    let path = real_gameexe_ini_path()?;
    let bytes = fs::read(&path).ok()?;
    Gameexe::parse(&bytes).ok().map(Arc::new)
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn koe_play_archive_selection_is_authoritative_not_defaulted() {
    let Some(gameexe) = load_reallive_real_bytes_gameexe() else {
        real_corpus::require_real_bytes(
            "utsushi-reallive koe_play_archive_selection_is_authoritative_not_defaulted",
        );
        return;
    };
    let emitter = Arc::new(AudioEventEmitter::new());
    let runtime = Arc::new(AudioRuntime::new(Arc::clone(&emitter)));
    runtime.set_gameexe(Arc::clone(&gameexe));

    // A fresh runtime over the REAL gameexe has NO current voice archive:
    // there is no baked-in default derived from any one game's archive
    // numbering.
    assert_eq!(
        runtime.current_speaker_archive(),
        None,
        "no baked-in default voice archive — the register starts UNKNOWN",
    );

    // koePlay(46) with an unresolved archive must NOT emit a guessed
    // VoicePlay; it surfaces a typed unresolved observation instead.
    let mut vm = Vm::new(0u16, 0);
    KoePlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(46)]);
    assert!(
        runtime.emitter().store().in_order_snapshot().is_empty(),
        "an unresolved koePlay must not emit a VoicePlay",
    );
    assert!(
        runtime
            .take_warnings()
            .contains(&AudioRuntimeWarning::NoCurrentSpeaker),
        "an unresolved koePlay must record the typed observation",
    );

    // An authoritative operation that names the archive (koePlayEx)
    // establishes it; a following bare koePlay resolves through it.
    KoePlayExOp::new(Arc::clone(&runtime))
        .dispatch(&mut vm, &[ExprValue::Int(15), ExprValue::Int(3)]);
    assert_eq!(runtime.current_speaker_archive(), Some(15));
    KoePlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(46)]);

    let events = runtime.emitter().store().in_order_snapshot();
    let voice = events
        .iter()
        .rev()
        .find(|event| event.event_kind == AudioEventKind::VoicePlay)
        .expect("a VoicePlay must be emitted once an archive is established");
    assert_eq!(
        voice.evidence_tier,
        utsushi_core::substrate::EvidenceTier::E1,
        "evidence_tier must be E1; see audio.rs module docstring for the substrate-gap \
         reconciliation against the E0 ceiling on the substrate sink",
    );
    match &voice.payload {
        AudioEventPayload::Voice {
            archive_id,
            sample_id,
        } => {
            assert_eq!(
                archive_id, "z0015",
                "koePlay resolves through the established archive (z<id:04> of 15)",
            );
            assert_eq!(*sample_id, 46, "sample_id MUST be the koePlay int arg (46)");
        }
        other => panic!("expected Voice payload, got {other:?}"),
    }
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn bgm_play_resolves_through_foldname_bgm() {
    let Some(gameexe) = load_reallive_real_bytes_gameexe() else {
        real_corpus::require_real_bytes("utsushi-reallive bgm_play_resolves_through_foldname_bgm");
        return;
    };
    let emitter = Arc::new(AudioEventEmitter::new());
    let runtime = Arc::new(AudioRuntime::new(Arc::clone(&emitter)));
    runtime.set_gameexe(Arc::clone(&gameexe));

    // The Gameexe MUST carry FOLDNAME.BGM — a typical value is
    // ("BGM", 0, "BGM.PAK"). The runtime lower-cases the subdir name
    // before assembling the asset id (matches the on-disk
    // case-insensitive convention).
    assert!(
        gameexe.get_tuple3("FOLDNAME.BGM").is_some(),
        "the corpus Gameexe.ini must declare #FOLDNAME.BGM",
    );

    let mut vm = Vm::new(0u16, 0);
    BgmPlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Bytes(b"ASA".to_vec())]);

    let events = runtime.emitter().store().in_order_snapshot();
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.event_kind, AudioEventKind::BgmStart);
    assert_eq!(
        event.evidence_tier,
        utsushi_core::substrate::EvidenceTier::E1,
    );
    match &event.payload {
        AudioEventPayload::Asset { asset_id } => {
            assert_eq!(
                asset_id, "bgm/ASA",
                "asset_id MUST resolve to 'bgm/ASA' per UTSUSHI-217 spec",
            );
        }
        other => panic!("expected Asset payload, got {other:?}"),
    }
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn bgm_play_asset_id_resolves_against_real_asa_nwa_path() {
    let Some(gameexe) = load_reallive_real_bytes_gameexe() else {
        real_corpus::require_real_bytes(
            "utsushi-reallive bgm_play_asset_id_resolves_against_real_asa_nwa_path",
        );
        return;
    };
    let Some(bgm_dir) = real_bgm_dir() else {
        return;
    };
    let emitter = Arc::new(AudioEventEmitter::new());
    let runtime = Arc::new(AudioRuntime::new(Arc::clone(&emitter)));
    runtime.set_gameexe(Arc::clone(&gameexe));

    let mut vm = Vm::new(0u16, 0);
    BgmPlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Bytes(b"ASA".to_vec())]);
    let asset_id = match &runtime.emitter().store().in_order_snapshot()[0].payload {
        AudioEventPayload::Asset { asset_id } => asset_id.clone(),
        other => panic!("expected Asset, got {other:?}"),
    };
    // The asset_id `bgm/ASA` corresponds to the on-disk path
    // `REALLIVEDATA/bgm/ASA.nwa`. Cross-validate by stat-ing the
    // file.
    let on_disk_path = bgm_dir.join(format!(
        "{}.nwa",
        asset_id.strip_prefix("bgm/").unwrap_or(&asset_id),
    ));
    let metadata = fs::metadata(&on_disk_path)
        .unwrap_or_else(|err| panic!("ASA.nwa must exist at {}: {err}", on_disk_path.display()));
    assert_eq!(
        metadata.len(),
        18_317_046,
        "bgm/ASA.nwa file size pinned at 18_317_046 bytes per UTSUSHI-217 spec",
    );

    // Also cross-validate that the file in the bgm directory matches
    // the resolution.
    assert!(
        bgm_dir.join(ASA_NWA).exists(),
        "expected {} to exist",
        bgm_dir.join(ASA_NWA).display(),
    );
}

#[test]
fn audio_rlop_real_bytes_skips_when_env_unset() {
    if real_corpus::game_root().is_some() {
        return;
    }
    eprintln!(
        "ITOTORI_REAL_GAME_ROOT not set — audio RLOperation real-bytes tests are \
         #[ignore]-gated and only run with ITOTORI_REAL_GAME_ROOT set.",
    );
}
