//! Synthetic wiring proof for the real [`UtsushiReallivePort`] — enforced
//! continuously in `just ci` (no game corpus required).
//!
//! Drives the port through the substrate [`Runner`] over a synthetic
//! one-scene engine whose scene 1 emits a Shift-JIS text line, and asserts
//! that the port DRIVES the substrate sinks in production code:
//!
//! - a real decoded **text line** flows through the text sink, and
//! - a real composited **frame artifact** flows through the frame sink,
//!
//! for the SAME run, plus that the port drove its `Snapshot` +
//! `DeterministicReplay` capabilities (snapshot/restore identity verified
//! at >0 tick boundaries; two replays byte-identical).
//!
//! The synthetic scene fires no audio opcodes, so audio is legitimately
//! empty here — the three-sink (incl. AUDIO) real-bytes proof lives in
//! `engine_port_real_bytes.rs`.

#[path = "support/port_support.rs"]
mod port_support;

use std::sync::Arc;

use utsushi_core::substrate::{AssetPackage, PortCapability, PortRequest, Runner};
use utsushi_core::{RuntimeArtifactRoot, RuntimeOperation};
use utsushi_reallive::UtsushiReallivePort;

use port_support::{NullAssetPackage, managed_temp_dir, synthetic_engine};

#[test]
fn port_drives_text_and_frame_sinks_over_synthetic_engine() {
    let engine = synthetic_engine();
    let assets: Arc<dyn AssetPackage> = Arc::new(NullAssetPackage);
    let mut port = UtsushiReallivePort::new(engine, assets, 1);

    let artifact_dir = managed_temp_dir("syn-artifact");
    let artifact_root = RuntimeArtifactRoot::new(artifact_dir);
    artifact_root.prepare().expect("prepare artifact root");
    let input_dir = managed_temp_dir("syn-input");
    let request = PortRequest::new(
        &input_dir,
        "reallive-port-synthetic-0001",
        RuntimeOperation::Trace,
    )
    .with_artifact_root(&artifact_root);

    let runner = Runner::new();
    let outcome = runner
        .run_trace(&mut port, &request)
        .expect("synthetic port run_trace succeeds");

    let text_total: usize = outcome.observations.iter().map(|t| t.text.len()).sum();
    let frame_total: usize = outcome.observations.iter().map(|t| t.frames.len()).sum();

    assert!(
        text_total >= 1,
        "the synthetic scene must surface >=1 decoded TextLine through the substrate text \
         sink; got {text_total}"
    );
    assert!(
        frame_total >= 1,
        "the port must announce >=1 composited FrameArtifact through the substrate frame \
         sink; got {frame_total}"
    );

    // Snapshot + DeterministicReplay capabilities are DRIVEN (not inert).
    assert!(
        port.snapshot_ticks_verified() > 0,
        "the Snapshot capability must be driven: snapshot/restore identity verified at >0 tick \
         boundaries"
    );
    assert!(
        port.deterministic_replay_verified(),
        "the DeterministicReplay capability must be driven: two replays byte-identical"
    );

    // And the manifest actually declares those capabilities.
    assert!(
        UtsushiReallivePort::MANIFEST
            .capabilities
            .contains(&PortCapability::Snapshot)
    );
    assert!(
        UtsushiReallivePort::MANIFEST
            .capabilities
            .contains(&PortCapability::DeterministicReplay)
    );
}
