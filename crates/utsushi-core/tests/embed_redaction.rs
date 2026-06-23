//! Integration: end-to-end redaction enforcement across the embed ABI.
//!
//! Every layer of the substrate (capability list, trace, snapshot ref,
//! artifact ref, envelope-wide walk) must reject host-shaped strings; this
//! suite asserts each layer fires its typed `EmbedError`.

use utsushi_core::{
    EmbedArtifactRef, EmbedCapability, EmbedCapabilityId, EmbedError, EmbedSchemaVersion,
    EmbedSnapshotRef, EmbedState, EmbedTrace, EmbedTraceLine, EvidenceTier, ObservationBridgeRef,
    TextLine, embed_capabilities, vfs::AssetId,
};

fn capabilities() -> Vec<EmbedCapability> {
    vec![
        EmbedCapability::supported(EmbedCapabilityId::State, EvidenceTier::E2),
        EmbedCapability::supported(EmbedCapabilityId::Trace, EvidenceTier::E1),
    ]
}

fn safe_text_line() -> TextLine {
    TextLine {
        line_id: "line-001".to_string(),
        evidence_tier: EvidenceTier::E1,
        text: "hello world".to_string(),
        speaker: Some("narrator".to_string()),
        text_surface: Some("adv".to_string()),
        bridge_ref: Some(ObservationBridgeRef {
            bridge_unit_id: Some("0190a000-0000-7000-8000-000000000001".to_string()),
            source_unit_key: Some("intro/line/1".to_string()),
            runtime_object_id: Some("scene-intro/text-1".to_string()),
        }),
        source_asset: Some(AssetId::parse("vfs://www/data/Map001.json").expect("asset id")),
    }
}

fn safe_envelope() -> EmbedState {
    EmbedState {
        schema_version: EmbedSchemaVersion::current(),
        adapter_id: "utsushi-fixture".to_string(),
        adapter_version: "0.0.0".to_string(),
        capabilities: capabilities(),
        trace: EmbedTrace {
            schema_version: EmbedSchemaVersion::current(),
            lines: vec![EmbedTraceLine {
                text_line: safe_text_line(),
            }],
        },
        current_snapshot: None,
        artifact_refs: Vec::new(),
    }
}

#[test]
fn embed_state_with_temp_path_in_capability_limitation_fails_validate() {
    let mut state = safe_envelope();
    // Push a partial capability with a tmp-path-shaped limitation.
    state.capabilities = vec![
        EmbedCapability::supported(EmbedCapabilityId::State, EvidenceTier::E2),
        EmbedCapability::partial(
            EmbedCapabilityId::Trace,
            EvidenceTier::E1,
            vec!["see /tmp/secret".to_string()],
        ),
    ];
    let error = state
        .validate()
        .expect_err("host path in limitation rejected");
    assert!(matches!(
        error,
        EmbedError::RedactionViolation { ref field_path } if field_path.contains("limitations")
    ));
    assert_eq!(error.semantic_code(), "utsushi.embed.redaction_violation");
}

#[test]
fn embed_state_artifact_ref_with_file_uri_fails_validate() {
    let artifact_ref = EmbedArtifactRef {
        artifact_id: "screenshot-001".to_string(),
        artifact_kind: "screenshot".to_string(),
        uri: "file:///etc/passwd".to_string(),
        media_type: Some("image/png".to_string()),
    };
    let error = artifact_ref.validate().expect_err("file:// rejected");
    assert!(matches!(error, EmbedError::InvalidArtifactRef { .. }));
}

#[test]
fn embed_state_trace_line_with_drive_letter_in_speaker_fails_validate() {
    let mut state = safe_envelope();
    state.trace.lines[0].text_line.speaker = Some("C:\\Users\\x".to_string());
    let error = state
        .validate()
        .expect_err("drive letter in speaker rejected");
    match error {
        EmbedError::RedactionViolation { ref field_path } => {
            assert!(
                field_path.contains("speaker"),
                "redaction error should name speaker field: {field_path}"
            );
        }
        other => panic!("expected RedactionViolation, got {other:?}"),
    }
}

#[test]
fn embed_capabilities_with_redaction_violation_in_limitation_fails_serialize() {
    let list = vec![
        EmbedCapability::supported(EmbedCapabilityId::State, EvidenceTier::E2),
        EmbedCapability::partial(
            EmbedCapabilityId::Trace,
            EvidenceTier::E1,
            vec!["see /home/leak/note.md".to_string()],
        ),
    ];
    let error = embed_capabilities(&list).expect_err("host path rejected");
    assert!(matches!(
        error,
        EmbedError::RedactionViolation { ref field_path } if field_path.contains("limitations")
    ));
}

#[test]
fn embed_snapshot_ref_with_host_path_in_adapter_id_rejected_by_envelope_validator() {
    // The snapshot ref's adapter id is not shape-checked for path safety in
    // isolation (it's an ASCII identifier), but the envelope-wide redaction
    // walk should catch a host-path-shaped adapter id if one is forced into
    // the envelope JSON. Build a clean envelope, mutate the JSON, and ask
    // from_json_value to reject.
    let mut state = safe_envelope();
    state.current_snapshot = Some(EmbedSnapshotRef {
        snapshot_id: "run-001".to_string(),
        adapter_id: "utsushi-fixture".to_string(),
        content_hash: "0".repeat(64),
        size_bytes: 32,
        evidence_tier: EvidenceTier::E2,
    });
    let mut value = state.to_json_value().expect("serialize");
    // Force a host path into the snapshot adapter id; this is engine-author
    // misuse and the substrate must reject.
    value["currentSnapshot"]["adapterId"] = "/home/leak".into();
    value["adapterId"] = "/home/leak".into();
    let error = EmbedState::from_json_value(value).expect_err("host path rejected");
    assert!(matches!(
        error,
        EmbedError::InvalidAdapterId { .. } | EmbedError::RedactionViolation { .. }
    ));
}
