//! Real-bytes acceptance for the substrate-sinks real producer.
//!
//! Proves the REAL RealLive [`UtsushiReallivePort`] drives the substrate
//! **text**, **frame**, AND **audio** sinks — all from a SINGLE real-bytes
//! replay of a real game's entry scene — on TWO titles (Sweetie HD +
//! Kanon). The port is driven through the substrate [`Runner`] exactly as a
//! production consumer would drive it; the assertions read the runner's
//! drained observations.
//!
//! Also asserts the port DROVE its declared `Snapshot` +
//! `DeterministicReplay` capabilities (snapshot/restore identity at >0 tick
//! boundaries; two replays byte-identical), so those manifest capabilities
//! are backed by exercised machinery rather than advertised-but-inert.
//!
//! Env-gated + STRICT: an absent corpus is an unconditional HARD FAILURE
//! (no opt-out; these `#[ignore]`-d suites run only in the periodic
//! ground-truth oracle, `just real-bytes-oracle`, where corpora are staged).
//! Run with
//! `ITOTORI_REAL_GAME_ROOT=<sweetie> ITOTORI_REAL_GAME_ROOT_2=<kanon>
//! cargo test -p utsushi-reallive --test engine_port_real_bytes -- --ignored`.

#[path = "support/port_support.rs"]
mod port_support;
#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::sync::Arc;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_core::substrate::{AssetPackage, PortRequest, Runner, TextLine, TextSurfaceSink};
use utsushi_core::{RuntimeArtifactRoot, RuntimeOperation};
use utsushi_reallive::{
    RealSceneIndex, ReplayEngine, ReplayOpts, UtsushiReallivePort,
    build_scene_store_from_decompressed, decompress_all_scenes,
};

use port_support::{CollectingTextSink, OnDiskG00Package, managed_temp_dir};
use real_corpus::RealCorpus;

/// Per-scene probe budget for [`pick_all_three_sink_scene`].
const PROBE_STEP_BUDGET: u32 = 20_000;

/// Playthrough-sequence bound pinned for the real-bytes run so the
/// frame-count assertion is deterministic: the port renders the first
/// `PLAYTHROUGH_BOUND` play-order messages, each to its own frame.
const PLAYTHROUGH_BOUND: usize = 4;

const CHOICE_PLAYTHROUGH_BOUND: usize = 16;

/// Build a [`ReplayEngine`] from a Seen.txt envelope, staging the dev-only
/// `kaifuu-reallive` `use_xor_2` segment-cipher recovery between the AVG32
/// first-level inflate (owned by `utsushi-reallive`) and the bytecode
/// decode. A no-op for non-`use_xor_2` titles (Kanon). No key material
/// leaves this function.
fn staged_engine(seen_bytes: &[u8]) -> ReplayEngine {
    let index_len = RealSceneIndex::parse(seen_bytes)
        .expect("parse scene index")
        .entries
        .len();
    let mut decompressed = decompress_all_scenes(seen_bytes).expect("decompress archive");
    let mut xor2: Vec<Xor2DecScene> = decompressed
        .iter()
        .map(|scene| Xor2DecScene {
            compiler_version: scene.compiler_version,
            bytecode: scene.bytecode.clone(),
        })
        .collect();
    let _ = recover_and_decrypt_archive(&mut xor2);
    for (scene, dec) in decompressed.iter_mut().zip(xor2) {
        scene.bytecode = dec.bytecode;
    }
    let (store, shift_jis, _stats) =
        build_scene_store_from_decompressed(&decompressed, index_len).expect("build store");
    ReplayEngine::from_store(store, shift_jis)
}

/// Probe (text_lines, audio_events) a scene's real two-pass observation
/// produces within [`PROBE_STEP_BUDGET`].
fn probe_scene(engine: &ReplayEngine, scene: u16) -> (usize, usize) {
    let opts = ReplayOpts {
        step_budget: PROBE_STEP_BUDGET,
        stop_at_first_pause: false,
    };
    let sink = Arc::new(CollectingTextSink::default());
    let observation =
        engine.observe_scene(scene, &opts, Arc::clone(&sink) as Arc<dyn TextSurfaceSink>);
    (sink.count(), observation.audio_events.len())
}

/// Pick a real scene whose observation drives BOTH the text and audio sinks
/// (the frame sink is always driven from the graphics stack). The game's
/// `#SEEN_START` entry scene is tried first; else the first store scene that
/// qualifies. Every candidate is real decoded bytecode.
fn pick_all_three_scene(engine: &ReplayEngine, entry_scene: u16, label: &str) -> u16 {
    let (t, a) = probe_scene(engine, entry_scene);
    if t >= 1 && a >= 1 {
        return entry_scene;
    }
    for scene in engine.scene_ids() {
        let (t, a) = probe_scene(engine, scene);
        if t >= 1 && a >= 1 {
            return scene;
        }
    }
    panic!(
        "[{label}] no real scene drove BOTH the text and audio sinks within budget; surface to \
         the orchestrator (do not relax the three-sink bar)"
    );
}

fn choice_surface_ordinal(line: &TextLine) -> Option<usize> {
    let surface = line.text_surface.as_deref()?;
    let (base, _) = surface.split_once(';').unwrap_or((surface, ""));
    base.strip_prefix("choice:")?.parse::<usize>().ok()
}

fn exact_choice_run(lines: &[TextLine], cursor: usize) -> Option<usize> {
    if choice_surface_ordinal(lines.get(cursor)?) != Some(0) {
        return None;
    }
    let mut end = cursor + 1;
    let mut expected = 1usize;
    while lines.get(end).and_then(choice_surface_ordinal) == Some(expected) {
        end += 1;
        expected += 1;
    }
    if lines
        .get(end)
        .and_then(choice_surface_ordinal)
        .is_some_and(|ordinal| ordinal != 0)
    {
        return None;
    }
    Some(end)
}

fn pick_reachable_text_choice_scene(engine: &ReplayEngine, label: &str) -> u16 {
    let opts = ReplayOpts {
        step_budget: PROBE_STEP_BUDGET,
        stop_at_first_pause: false,
    };
    let per_segment_bound = (CHOICE_PLAYTHROUGH_BOUND / 4).max(1);
    for scene in engine.scene_ids() {
        let playthrough = engine.observe_playthrough(scene, &opts, 4);
        for segment in &playthrough.segments {
            let lines = &segment.observation.play_order_lines;
            let mut cursor = 0usize;
            let mut frame_count = 0usize;
            while cursor < lines.len() && frame_count < per_segment_bound {
                if let Some(end) = exact_choice_run(lines, cursor) {
                    if end - cursor >= 2 {
                        return scene;
                    }
                }
                cursor += 1;
                frame_count += 1;
            }
        }
    }
    panic!(
        "[{label}] no reachable exact text choice:0..N group fell within the bounded render \
         prefix; surface to the orchestrator (do not relax the grouping contract)"
    );
}

/// Drive the real port over a scene that exercises all three sinks and
/// assert every sink flowed for the SAME run, plus the driven Snapshot +
/// DeterministicReplay capabilities.
fn run_title(corpus: &RealCorpus, g00_env: &str, label: &str) {
    let g00_dir = real_corpus::g00_dir_for_env(g00_env).unwrap_or_else(|| {
        panic!("[{label}] no g00 asset directory reachable from {g00_env}");
    });
    let entry_scene = corpus
        .entry_scene()
        .unwrap_or_else(|| panic!("[{label}] Gameexe #SEEN_START (entry scene) not resolvable"));
    let seen_bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");

    // Pick the scene to drive using a borrowing probe engine, then move a
    // fresh engine into the port run.
    let scene = {
        let probe_engine = staged_engine(&seen_bytes);
        assert!(
            probe_engine.scene_ids().contains(&entry_scene),
            "[{label}] entry scene {entry_scene} must be present in the decoded store"
        );
        pick_all_three_scene(&probe_engine, entry_scene, label)
    };

    // Config-driven message-window box: read #WINDOW.000 + the declared
    // screen size from the game's real Gameexe.ini.
    let gameexe = corpus.gameexe().unwrap_or_else(|| {
        panic!("[{label}] Gameexe.ini must parse for the message-window config")
    });
    let window_config = gameexe.message_window(0);
    let screen_size = gameexe.screen_size_px();

    let assets: Arc<dyn AssetPackage> = Arc::new(OnDiskG00Package::new(g00_dir));
    // Pin the playthrough-sequence bound so the frame-count assertion below
    // is deterministic on real bytes regardless of the env/default: the port
    // renders EACH leading play-order message to its own frame, capped here.
    let mut port = UtsushiReallivePort::new(
        staged_engine(&seen_bytes),
        assets,
        scene,
        window_config,
        screen_size,
    )
    .with_selection_window_config(gameexe.sel_window())
    .with_playthrough_max(PLAYTHROUGH_BOUND);

    let artifact_dir = managed_temp_dir(&format!("{label}-artifact"));
    let artifact_root = RuntimeArtifactRoot::new(artifact_dir);
    artifact_root.prepare().expect("prepare artifact root");
    let input_dir = managed_temp_dir(&format!("{label}-input"));
    let run_id = format!("reallive-port-{label}-scene-{scene}");
    let request = PortRequest::new(&input_dir, &run_id, RuntimeOperation::Trace)
        .with_artifact_root(&artifact_root);

    let outcome = Runner::new()
        .run_trace(&mut port, &request)
        .unwrap_or_else(|error| panic!("[{label}] real-bytes port run_trace failed: {error}"));

    let text_total: usize = outcome.observations.iter().map(|t| t.text.len()).sum();
    let frame_total: usize = outcome.observations.iter().map(|t| t.frames.len()).sum();
    let audio_total: usize = outcome.observations.iter().map(|t| t.audio.len()).sum();

    eprintln!(
        "[{label}] entry_scene={entry_scene} driven_scene={scene} steps={} text={text_total} \
         frame={frame_total} audio={audio_total} snapshot_ticks_verified={} \
         deterministic_replay_verified={}",
        port.observation_steps(),
        port.snapshot_ticks_verified(),
        port.deterministic_replay_verified(),
    );

    // The SAME real-bytes run drives all THREE substrate sinks.
    assert!(
        text_total >= 1,
        "[{label}] a decoded TextLine must flow through the substrate text sink; got {text_total}"
    );
    assert!(
        frame_total >= 1,
        "[{label}] a composited FrameArtifact must flow through the substrate frame sink; got \
         {frame_total}"
    );
    assert!(
        audio_total >= 1,
        "[{label}] an AudioEvent must flow through the substrate audio sink; got {audio_total}"
    );

    // Snapshot + DeterministicReplay capabilities are DRIVEN (not inert).
    assert!(
        port.snapshot_ticks_verified() > 0,
        "[{label}] Snapshot capability: snapshot/restore identity must be verified at >0 tick \
         boundaries"
    );
    assert!(
        port.deterministic_replay_verified(),
        "[{label}] DeterministicReplay capability: two replays must be byte-identical"
    );

    // MULTI-SCENE PLAYTHROUGH SEQUENCE, one message per frame: the port now
    // follows the REAL scene-dispatch ACROSS scene boundaries, rendering a
    // bounded through-line that CROSSES ≥1 boundary — leading messages of
    // scene A over A's background, then leading messages of scene B over B's
    // OWN background — each message to its OWN frame (the per-frame
    // message-window contract), NOT one giant flatten-all-messages box, NOT
    // just message #0, and NOT one scene in isolation. Per-scene capping
    // guarantees a long scene A (Sweetie scene 1's thousands of messages)
    // cannot consume the whole budget before scene B appears; the total is
    // bounded by the pinned `PLAYTHROUGH_BOUND`.
    let frame_scene_ids = port.playthrough_frame_scene_ids();
    assert!(
        (1..=PLAYTHROUGH_BOUND).contains(&frame_total),
        "[{label}] the playthrough must announce between 1 and {PLAYTHROUGH_BOUND} frames \
         (bounded through-line); got {frame_total}"
    );
    assert_eq!(
        port.playthrough_frame_sources().len(),
        frame_total,
        "[{label}] one recorded frame sidecar per announced frame"
    );
    assert_eq!(
        frame_scene_ids.len(),
        frame_total,
        "[{label}] one recorded frame->scene entry per announced frame"
    );
    let full_stream = port.frame_text_lines();
    let mut cursor = 0usize;
    for message in port.playthrough_frame_messages() {
        let found = full_stream[cursor..]
            .iter()
            .position(|line| line == message)
            .map(|offset| cursor + offset);
        cursor = found.unwrap_or_else(|| {
            panic!(
                "[{label}] rendered playthrough message {message:?} must be a real play-order \
                 message appearing in-order in the multi-scene stream"
            )
        }) + 1;
    }
    // The rendered playthrough CROSSED the scene boundary: it spans ≥2
    // DISTINCT scene ids (the entry scene A, then the dispatch target B), in
    // dispatch order — a regression that stopped at scene A yields a single
    // distinct id and FAILS here.
    let distinct_scenes: std::collections::BTreeSet<u16> =
        frame_scene_ids.iter().copied().collect();
    assert!(
        distinct_scenes.len() >= 2,
        "[{label}] the rendered playthrough must CROSS a scene boundary (≥2 distinct scene ids); \
         got frames from {frame_scene_ids:?} (a regression that stops at the entry scene fails)"
    );
    // The scene ids are non-decreasing runs in dispatch order (scene A's
    // frames, then scene B's), never interleaved back and forth.
    let mut boundaries = 0usize;
    for window in frame_scene_ids.windows(2) {
        if window[0] != window[1] {
            boundaries += 1;
        }
    }
    assert!(
        boundaries >= 1,
        "[{label}] the rendered frames must show ≥1 A→B scene transition; got {frame_scene_ids:?}"
    );

    // The port's play-order message stream is SINGLE PASS (branch-following
    // play order, or the byte-order catalogue fallback) — the SAME decoded
    // lines, in the SAME order, the substrate text sink emits, NOT the
    // former ~2× two-pass union and NOT the retired `UTSUSHI REALLIVE SCENE
    // N` placeholder.
    let sink_bodies: Vec<String> = outcome
        .observations
        .iter()
        .flat_map(|tick| tick.text.iter().map(|line| line.text.clone()))
        .collect();
    let frame_overlay = port.frame_text_lines();
    let overlay_chars: usize = frame_overlay.iter().map(|line| line.chars().count()).sum();
    eprintln!(
        "[{label}] frame_overlay_lines={} frame_overlay_chars={overlay_chars} \
         sink_bodies={}",
        frame_overlay.len(),
        sink_bodies.len(),
    );
    assert!(
        !frame_overlay.is_empty(),
        "[{label}] the port's play-order message stream must carry the real decoded dialogue; got \
         0 lines"
    );
    assert_eq!(
        frame_overlay,
        sink_bodies.as_slice(),
        "[{label}] the port's play-order stream must equal, single pass, the SAME real decoded \
         dialogue the substrate text sink emitted (no two-pass doubling, no placeholder)"
    );
    assert!(
        frame_overlay
            .iter()
            .all(|line| !line.contains("UTSUSHI REALLIVE SCENE")),
        "[{label}] the retired ASCII placeholder must never appear in the frame text layer"
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (title 1)"]
fn port_drives_all_three_sinks_title1_real_bytes() {
    let Some(corpus) = real_corpus::corpus_1() else {
        real_corpus::require_real_bytes(
            "utsushi-reallive port_drives_all_three_sinks_title1_real_bytes",
        );
        return;
    };
    run_title(&corpus, real_corpus::REAL_GAME_ROOT_ENV, "title1");
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT_2 (title 2)"]
fn port_drives_all_three_sinks_title2_real_bytes() {
    let Some(corpus) = real_corpus::corpus_2() else {
        real_corpus::require_real_bytes(
            "utsushi-reallive port_drives_all_three_sinks_title2_real_bytes (title 2 / ITOTORI_REAL_GAME_ROOT_2)",
        );
        return;
    };
    run_title(&corpus, real_corpus::REAL_GAME_ROOT_2_ENV, "title2");
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (title 1)"]
fn port_renders_reachable_text_choice_window_title1_real_bytes() {
    let Some(corpus) = real_corpus::corpus_1() else {
        real_corpus::require_real_bytes(
            "utsushi-reallive port_renders_reachable_text_choice_window_title1_real_bytes",
        );
        return;
    };
    let label = "title1-choice-window";
    let seen_bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
    let gameexe = corpus
        .gameexe()
        .unwrap_or_else(|| panic!("[{label}] Gameexe.ini must parse"));
    let scene = pick_reachable_text_choice_scene(&staged_engine(&seen_bytes), label);
    let g00_dir =
        real_corpus::g00_dir_for_env(real_corpus::REAL_GAME_ROOT_ENV).unwrap_or_else(|| {
            panic!("[{label}] no g00 asset directory reachable from real corpus root")
        });
    let assets: Arc<dyn AssetPackage> = Arc::new(OnDiskG00Package::new(g00_dir));
    let mut port = UtsushiReallivePort::new(
        staged_engine(&seen_bytes),
        assets,
        scene,
        gameexe.message_window(0),
        gameexe.screen_size_px(),
    )
    .with_selection_window_config(gameexe.sel_window())
    .with_playthrough_max(CHOICE_PLAYTHROUGH_BOUND);

    let artifact_root = RuntimeArtifactRoot::new(managed_temp_dir("title1-choice-window-artifact"));
    artifact_root.prepare().expect("prepare artifact root");
    let input_dir = managed_temp_dir("title1-choice-window-input");
    let request = PortRequest::new(
        &input_dir,
        "reallive-port-choice-window",
        RuntimeOperation::Trace,
    )
    .with_artifact_root(&artifact_root);
    let outcome = Runner::new()
        .run_trace(&mut port, &request)
        .unwrap_or_else(|error| panic!("[{label}] real-byte port run failed: {error}"));

    let sources = port.playthrough_frame_sources();
    let choice = sources
        .iter()
        .find(|lines| {
            lines.len() >= 2
                && lines
                    .iter()
                    .enumerate()
                    .all(|(i, line)| choice_surface_ordinal(line) == Some(i))
        })
        .unwrap_or_else(|| {
            panic!(
                "[{label}] discovered scene {scene} must announce a ChoiceWindow frame within \
                 the configured bounded prefix"
            )
        });
    assert!(
        choice.len() >= 2,
        "[{label}] choice window must retain every option, not collapse to one line"
    );
    for (index, line) in choice.iter().enumerate() {
        assert_eq!(
            choice_surface_ordinal(line),
            Some(index),
            "[{label}] sidecar must preserve exact ordinal choice surface order"
        );
    }

    let frame_total: usize = outcome
        .observations
        .iter()
        .map(|tick| tick.frames.len())
        .sum();
    assert_eq!(
        sources.len(),
        frame_total,
        "[{label}] one audit sidecar per redacted emitted frame"
    );
    let sink_lines: Vec<&TextLine> = outcome
        .observations
        .iter()
        .flat_map(|tick| tick.text.iter())
        .collect();
    for source in choice {
        assert!(
            sink_lines.iter().any(|observed| {
                observed.line_id == source.line_id
                    && observed.text == source.text
                    && observed.text_surface == source.text_surface
            }),
            "[{label}] grouping must retain each option unchanged in the text sink"
        );
    }
    let flattened_sidecar_ids: Vec<&str> = sources
        .iter()
        .flat_map(|lines| lines.iter().map(|line| line.line_id.as_str()))
        .collect();
    let sink_ids: Vec<&str> = sink_lines
        .iter()
        .map(|line| line.line_id.as_str())
        .collect();
    let mut sink_cursor = 0usize;
    for source_id in flattened_sidecar_ids {
        let Some(offset) = sink_ids[sink_cursor..]
            .iter()
            .position(|observed_id| *observed_id == source_id)
        else {
            panic!(
                "[{label}] frame sidecars must retain source line order without dropping a \
                 branch line"
            );
        };
        sink_cursor += offset + 1;
    }
}
