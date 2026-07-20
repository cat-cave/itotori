//! Substrate conformance for the Softpal runtime port: the manifest is valid,
//! the parity profile declares the honest stances, and a port configured with a
//! synthetic (non-copyrighted) `Sv20` scene drives the real `Runner` lifecycle
//! end to end — emitting dialogue + choice text lines and an edge-redacted
//! capture PNG. This exercises the PRESENT path without any real corpus, so the
//! env-gated real-bytes suite's SKIP branch is not the only coverage.

use kaifuu_softpal::{
    SCRIPT_MAGIC_PREFIX, SELECT_WORD_HI, SELECT_WORD_LO, TEXT_SHOW_WORD_HI, TEXTDAT_FLAG_PLAINTEXT,
    TEXTDAT_MAGIC_TAIL,
};
use tempfile::TempDir;
use utsushi_core::substrate::{
    CapabilityStance, EnginePort, EnginePortError, EvidenceTier, FidelityTier, LifecycleStage,
    PortCapability, PortRequest, Runner,
};
use utsushi_core::{RuntimeArtifactRoot, RuntimeOperation};
use utsushi_softpal::UtsushiSoftpalPort;

fn opc(id: u16) -> [u8; 4] {
    let mut token = [0u8; 4];
    token[0..2].copy_from_slice(&id.to_le_bytes());
    token[2..4].copy_from_slice(&0x0001u16.to_le_bytes());
    token
}
fn word(value: u32) -> [u8; 4] {
    value.to_le_bytes()
}
fn target(category: u16, function: u16) -> u32 {
    (u32::from(category) << 16) | u32::from(function)
}

/// A synthetic extracted scene: two dialogue lines (one with a speaker) then a
/// two-option choice menu (both text-bearing, v21465 immediate-label idiom).
fn synthetic_scene() -> (Vec<u8>, Vec<u8>) {
    let mut textdat = vec![TEXTDAT_FLAG_PLAINTEXT];
    textdat.extend_from_slice(TEXTDAT_MAGIC_TAIL);
    textdat.extend_from_slice(&4u32.to_le_bytes());
    let mut offsets = Vec::new();
    for (index, text) in [
        (0u32, b"hello world" as &[u8]),
        (1, b"Narrator"),
        (2, b"take the left path"),
        (3, b"take the right path"),
    ] {
        offsets.push(textdat.len() as u32);
        textdat.extend_from_slice(&index.to_le_bytes());
        textdat.extend_from_slice(text);
        textdat.push(0);
    }

    let no_speaker = 0x0FFF_FFFFu32;
    let mut tokens: Vec<[u8; 4]> = Vec::new();
    for (text_ptr, name_ptr) in [(offsets[0], offsets[1]), (offsets[0], no_speaker)] {
        tokens.extend_from_slice(&[
            opc(0x1f),
            word(text_ptr),
            opc(0x1f),
            word(name_ptr),
            opc(0x1f),
            word(0),
            opc(0x17),
            word(target(TEXT_SHOW_WORD_HI, 0x0002)),
            word(0),
        ]);
    }
    for immediate in [offsets[2], offsets[3]] {
        tokens.extend_from_slice(&[
            opc(0x1f),
            word(immediate),
            opc(0x17),
            word(target(SELECT_WORD_HI, SELECT_WORD_LO)),
            word(0),
        ]);
    }

    let mut script = Vec::new();
    script.extend_from_slice(SCRIPT_MAGIC_PREFIX);
    script.extend_from_slice(b"20");
    script.extend_from_slice(&0u32.to_le_bytes());
    script.extend_from_slice(&0u32.to_le_bytes());
    for token in &tokens {
        script.extend_from_slice(token);
    }
    (script, textdat)
}

#[test]
fn manifest_and_parity_profile_are_structurally_honest() {
    let manifest = UtsushiSoftpalPort::MANIFEST;
    manifest.validate().expect("manifest is valid");
    assert_eq!(manifest.id, "utsushi-softpal");
    assert_eq!(manifest.fidelity_tier_max, FidelityTier::LayoutProbe);
    assert_eq!(manifest.evidence_tier_max, EvidenceTier::E2);
    assert!(manifest.capabilities.contains(&PortCapability::Observe));
    assert!(manifest.capabilities.contains(&PortCapability::Capture));

    let profile = UtsushiSoftpalPort::PARITY_PROFILE;
    profile.validate().expect("parity profile is valid");
    // The port WIRES Observe (it executes + emits) and Capture (it renders).
    assert_eq!(
        profile.stance(PortCapability::Observe),
        Some(CapabilityStance::Wired)
    );
    // VM-backed capabilities are honestly dev-Pending, never permanently N/A.
    assert_eq!(
        profile.stance(PortCapability::Snapshot),
        Some(CapabilityStance::Pending)
    );
    assert_eq!(
        profile.stance(PortCapability::DeterministicReplay),
        Some(CapabilityStance::Pending)
    );
}

#[test]
fn unconfigured_port_launch_fails_with_a_configuration_error() {
    let mut port = UtsushiSoftpalPort::new();
    let request = PortRequest::new(
        std::path::Path::new("."),
        "softpal-unconfigured",
        RuntimeOperation::Capture,
    );
    let error = port
        .launch(&request)
        .expect_err("an unconfigured port cannot launch");
    assert!(matches!(
        error,
        EnginePortError::Lifecycle {
            stage: LifecycleStage::Launch,
            ..
        }
    ));
}

#[test]
fn synthetic_scene_drives_the_full_runner_lifecycle() {
    let (script, textdat) = synthetic_scene();
    let mut port = UtsushiSoftpalPort::with_extracted_scene(script, textdat, "synthetic-title");

    let artifacts = TempDir::new().expect("temp artifact root");
    let artifact_root = RuntimeArtifactRoot::new(artifacts.path().join("runtime-artifacts"));
    let request = PortRequest::new(
        std::path::Path::new("."),
        "softpal-synthetic",
        RuntimeOperation::Capture,
    )
    .with_artifact_root(&artifact_root);

    let outcome = Runner::new()
        .run_capture(&mut port, &request)
        .expect("real EnginePort execute/render/capture lifecycle");

    // Text emissions: 2 dialogue lines + 2 choice options.
    let text: Vec<_> = outcome
        .observations
        .iter()
        .flat_map(|observation| observation.text.iter())
        .collect();
    assert_eq!(text.len(), 4, "two dialogue + two choice lines emitted");
    assert!(
        text.iter()
            .all(|line| line.evidence_tier == EvidenceTier::E1)
    );
    assert!(
        text.iter()
            .any(|line| line.speaker.as_deref() == Some("Narrator")),
        "the speaker name flows through the text sink"
    );
    assert!(
        text.iter()
            .any(|line| line.text_surface.as_deref() == Some("choice")),
        "choice options are emitted on the choice surface"
    );

    // Frame emissions: one edge-redacted layout frame per leading dialogue line.
    let frames: Vec<_> = outcome
        .observations
        .iter()
        .flat_map(|observation| observation.frames.iter())
        .collect();
    assert_eq!(frames.len(), 2, "one frame per dialogue line");
    assert!(
        frames
            .iter()
            .all(|frame| frame.evidence_tier == EvidenceTier::E2)
    );

    let capture = outcome.capture.expect("capture outcome");
    assert!(
        capture
            .summary
            .as_deref()
            .is_some_and(|summary| summary.contains("redacted=true")),
        "capture reports the default redaction policy"
    );
    let png = std::fs::read(capture.artifact_path.expect("managed PNG path")).expect("read PNG");
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "capture is a PNG");
}
