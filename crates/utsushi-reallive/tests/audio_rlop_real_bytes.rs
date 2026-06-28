//! UTSUSHI-217 real-bytes integration tests for the audio RLOperation
//! family.
//!
//! Pins the `koePlay` and `bgmPlay` resolution paths against Sweetie HD's
//! `Gameexe.ini` (`#FOLDNAME.BGM`, `#NAMAE` entries) and against the
//! real `bgm/ASA.nwa` / `koe/z0001.ovk` on-disk layout. Mirrors the
//! `nwa_real_bytes.rs` / `ovk_real_bytes.rs` env-gating pattern.
//!
//! # Acceptance criteria pinned here
//!
//! 1. [`koe_play_resolves_through_namae_table`] — UTSUSHI-217
//!    spec-pinned name. With the Sweetie HD Gameexe.ini's NAMAE table
//!    populated, `koePlay(46)` dispatched through the rlop emits an
//!    `AudioEvent { kind: VoicePlay, payload: Voice { archive_id:
//!    "z0001", sample_id: 46, ... } }` — the spec's E1 emission. The
//!    archive_id resolution path: `koePlay(46)` consults the runtime's
//!    current-speaker register (defaulted to archive `1` for Sweetie
//!    HD's `z0001.ovk` system-event archive), formatted as `z<id:04>`.
//! 2. [`bgm_play_resolves_through_foldname_bgm`] — `bgmPlay("ASA")`
//!    dispatched after `set_gameexe` with Sweetie HD's
//!    `#FOLDNAME.BGM = "BGM" = 0 : "BGM.PAK"` emits an
//!    `AudioEvent { kind: BgmStart, payload: Asset { asset_id:
//!    "bgm/ASA" } }` — the spec's E1 emission.
//! 3. [`bgm_play_asset_id_resolves_against_real_asa_nwa_path`] — the
//!    resolved `asset_id = "bgm/ASA"` (when post-pended with the
//!    `.nwa` extension and routed under Sweetie HD's
//!    `REALLIVEDATA/bgm/`) lands on the real `ASA.nwa` file.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use utsushi_reallive::{
    AudioEventEmitter, AudioEventKind, AudioEventPayload, AudioRuntime, BgmPlayOp, ExprValue,
    Gameexe, KoePlayOp, RLOperation, Vm,
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
fn koe_play_resolves_through_namae_table() {
    let Some(gameexe) = load_reallive_real_bytes_gameexe() else {
        eprintln!(
            "ITOTORI_REAL_GAME_ROOT unset or Gameexe.ini missing; skipping \
             koe_play_resolves_through_namae_table",
        );
        return;
    };
    let emitter = Arc::new(AudioEventEmitter::new());
    let runtime = Arc::new(AudioRuntime::new(Arc::clone(&emitter)));
    runtime.set_gameexe(Arc::clone(&gameexe));

    // The default speaker archive is `1` (Sweetie HD's `z0001.ovk`
    // system-event archive). The spec's acceptance criterion uses
    // koePlay(46) against this default.
    assert_eq!(
        runtime.current_speaker_archive_id(),
        1,
        "default speaker archive is 1 (system events / z0001.ovk)",
    );

    // koePlay($intA[0]=46) — the spec's acceptance dispatch.
    let mut vm = Vm::new(0u16, 0);
    let op = KoePlayOp::new(Arc::clone(&runtime));
    op.dispatch(&mut vm, &[ExprValue::Int(46)]);

    let events = runtime.emitter().store().in_order_snapshot();
    assert_eq!(events.len(), 1, "exactly one VoicePlay event emitted");
    let event = &events[0];
    assert_eq!(
        event.event_kind,
        AudioEventKind::VoicePlay,
        "kind must be VoicePlay per UTSUSHI-217 acceptance criterion",
    );
    assert_eq!(
        event.evidence_tier,
        utsushi_core::substrate::EvidenceTier::E1,
        "evidence_tier must be E1 per UTSUSHI-217 spec; see audio.rs module docstring for the \
         substrate-gap reconciliation against the E0 ceiling on the substrate sink",
    );
    match &event.payload {
        AudioEventPayload::Voice {
            archive_id,
            sample_id,
        } => {
            assert_eq!(
                archive_id, "z0001",
                "archive_id MUST be 'z0001' (the z<archive:04> formatting of archive_id=1)",
            );
            assert_eq!(*sample_id, 46, "sample_id MUST be 46 (the koePlay int arg)",);
        }
        other => panic!("expected Voice payload, got {other:?}"),
    }

    // Cross-validate the NAMAE table is actually populated against
    // Sweetie HD bytes — pick a speaker named in the corpus. The
    // Sweetie HD shape:
    //   #NAMAE="凛" = "凛" = (1, 015, -1)
    // The parser stores (archive=1, pattern=15, pitch=-1); the
    // composite archive id the koe filename uses is
    // `archive * 1000 + pattern = 1015`, matching the on-disk
    // `koe/z1015.ovk` file.
    if let Some(entry) = gameexe.get_namae("NAMAE.凛") {
        assert_eq!(
            entry.archive, 1,
            "Sweetie HD's NAMAE.凛 row's archive field is literally 1 (the second comma-separated \
             integer 015 becomes the pattern field)",
        );
        assert_eq!(
            entry.pattern, 15,
            "Sweetie HD's NAMAE.凛 row pins pattern=15; composite archive id = 1*1000 + 15 = 1015 \
             ↔ koe/z1015.ovk",
        );
        // Switching speaker re-routes the next koePlay through the
        // composite archive id.
        assert!(runtime.select_speaker_by_display_name("凛"));
        assert_eq!(runtime.current_speaker_archive_id(), 1015);
        let mut vm2 = Vm::new(0u16, 0);
        KoePlayOp::new(Arc::clone(&runtime)).dispatch(&mut vm2, &[ExprValue::Int(7)]);
        let events_after = runtime.emitter().store().in_order_snapshot();
        match &events_after.last().expect("at least one event").payload {
            AudioEventPayload::Voice { archive_id, .. } => {
                assert_eq!(archive_id, "z1015", "speaker-switch routed to z1015");
            }
            other => panic!("expected Voice, got {other:?}"),
        }
    }
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn bgm_play_resolves_through_foldname_bgm() {
    let Some(gameexe) = load_reallive_real_bytes_gameexe() else {
        eprintln!(
            "ITOTORI_REAL_GAME_ROOT unset or Gameexe.ini missing; skipping \
             bgm_play_resolves_through_foldname_bgm",
        );
        return;
    };
    let emitter = Arc::new(AudioEventEmitter::new());
    let runtime = Arc::new(AudioRuntime::new(Arc::clone(&emitter)));
    runtime.set_gameexe(Arc::clone(&gameexe));

    // The Gameexe MUST carry FOLDNAME.BGM — Sweetie HD's value is
    // ("BGM", 0, "BGM.PAK"). The runtime lower-cases the subdir name
    // before assembling the asset id (matches the on-disk
    // case-insensitive convention).
    assert!(
        gameexe.get_tuple3("FOLDNAME.BGM").is_some(),
        "Sweetie HD Gameexe.ini must declare #FOLDNAME.BGM",
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
        eprintln!(
            "ITOTORI_REAL_GAME_ROOT unset; skipping \
             bgm_play_asset_id_resolves_against_real_asa_nwa_path",
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
