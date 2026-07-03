//! Non-vacuous proof that [`UtsushiReallivePort`] renders a bounded
//! PLAYTHROUGH SEQUENCE — one frame per play-order message — not a single
//! message-#0 frame.
//!
//! Drives the port through the substrate [`Runner`] over a synthetic
//! multi-message engine (scene 1 emits N DISTINCT Shift-JIS lines, each
//! followed by `msg.pause`) and asserts:
//!
//! - the port announces exactly N frames (one per play-order message) —
//!   a regression that emits only message #0 (1 frame) FAILS;
//! - the N frame ids are pairwise DISTINCT — a regression that repeats
//!   message #0 into every frame (identical pixels ⇒ identical sha256 frame
//!   id) FAILS;
//! - frame `i` corresponds to play-order message `i`: the port's recorded
//!   frame→message mapping is the play-order stream prefix, in order;
//! - the playthrough bound is respected: with the bound pinned below N, the
//!   port emits exactly `bound` frames of the leading messages.

#[path = "support/port_support.rs"]
mod port_support;

use std::collections::HashSet;
use std::sync::Arc;

use utsushi_core::substrate::{AssetPackage, FrameArtifact, PortRequest, Runner};
use utsushi_core::{RuntimeArtifactRoot, RuntimeOperation};
use utsushi_reallive::{MessageWindowConfig, UtsushiReallivePort};

use port_support::{NullAssetPackage, managed_temp_dir, synthetic_multi_message_engine};

const MESSAGE_COUNT: usize = 3;

/// Build + drive a port over a `MESSAGE_COUNT`-message engine, returning the
/// announced frames alongside the (now-launched) port for accessor checks.
fn drive(bound: Option<usize>) -> (Vec<FrameArtifact>, UtsushiReallivePort) {
    let engine = synthetic_multi_message_engine(MESSAGE_COUNT);
    let assets: Arc<dyn AssetPackage> = Arc::new(NullAssetPackage);
    let mut port = UtsushiReallivePort::new(
        engine,
        assets,
        1,
        MessageWindowConfig::default(),
        (1280, 720),
    );
    if let Some(max) = bound {
        port = port.with_playthrough_max(max);
    }

    let artifact_root = RuntimeArtifactRoot::new(managed_temp_dir("playthrough-artifact"));
    artifact_root.prepare().expect("prepare artifact root");
    let input_dir = managed_temp_dir("playthrough-input");
    let request = PortRequest::new(
        &input_dir,
        "reallive-port-playthrough-0001",
        RuntimeOperation::Trace,
    )
    .with_artifact_root(&artifact_root);

    let outcome = Runner::new()
        .run_trace(&mut port, &request)
        .expect("playthrough port run_trace succeeds");

    let frames: Vec<FrameArtifact> = outcome
        .observations
        .into_iter()
        .flat_map(|tick| tick.frames.into_iter())
        .collect();
    (frames, port)
}

#[test]
fn playthrough_renders_one_frame_per_play_order_message_in_order() {
    let (frames, port) = drive(None);

    // The engine emits MESSAGE_COUNT distinct play-order messages; the
    // default bound (8) is above that, so all render.
    assert_eq!(
        port.frame_text_lines().len(),
        MESSAGE_COUNT,
        "synthetic engine must yield {MESSAGE_COUNT} distinct play-order messages; got {}",
        port.frame_text_lines().len(),
    );

    // (1) One frame PER play-order message — NOT a single message-#0 frame.
    assert_eq!(
        frames.len(),
        MESSAGE_COUNT,
        "playthrough must announce one frame per play-order message ({MESSAGE_COUNT}); got {} \
         (a single-frame regression that renders only message #0 fails here)",
        frames.len(),
    );

    // (2) Each frame is a DISTINCT render — distinct message ⇒ distinct
    //     rendered pixels ⇒ distinct sha256 frame id. A regression that
    //     composites message #0 into every frame collapses these to one id.
    let unique_ids: HashSet<&str> = frames.iter().map(|f| f.frame_id.as_str()).collect();
    assert_eq!(
        unique_ids.len(),
        MESSAGE_COUNT,
        "each playthrough frame must render a DISTINCT message (distinct sha256 frame id); got \
         {} unique of {} frames (repeating message #0 would collapse these)",
        unique_ids.len(),
        frames.len(),
    );

    // (3) Frame i corresponds to play-order message i: the recorded
    //     frame→message mapping is the play-order stream prefix, in order.
    assert_eq!(
        port.playthrough_frame_messages().len(),
        frames.len(),
        "one recorded frame→message entry per announced frame",
    );
    assert_eq!(
        port.playthrough_frame_messages(),
        &port.frame_text_lines()[..frames.len()],
        "frame i must render play-order message i (recorded mapping must equal the play-order \
         prefix, in order)",
    );
    // Play-order messages are genuinely distinct (guards the distinctness
    // assertion above against an accidental all-equal corpus).
    let unique_msgs: HashSet<&str> = port
        .playthrough_frame_messages()
        .iter()
        .map(String::as_str)
        .collect();
    assert_eq!(
        unique_msgs.len(),
        MESSAGE_COUNT,
        "the rendered play-order messages must be pairwise distinct",
    );
}

#[test]
fn playthrough_respects_the_configured_bound() {
    const BOUND: usize = 2;
    let (frames, port) = drive(Some(BOUND));

    assert!(
        port.frame_text_lines().len() > BOUND,
        "test needs more play-order messages ({}) than the bound ({BOUND})",
        port.frame_text_lines().len(),
    );
    assert_eq!(
        frames.len(),
        BOUND,
        "the playthrough bound must cap the emitted frame count at {BOUND}; got {}",
        frames.len(),
    );
    assert_eq!(
        port.playthrough_frame_messages(),
        &port.frame_text_lines()[..BOUND],
        "the bounded playthrough must render the FIRST {BOUND} play-order messages, in order",
    );
}
