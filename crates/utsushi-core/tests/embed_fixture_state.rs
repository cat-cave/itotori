//! Integration: fixture-driven golden `EmbedState` envelope.
//!
//! Builds a representative `EmbedState` (5 trace lines, 2 artifact refs, 1
//! snapshot ref, full capability list) and asserts:
//! - JSON serialization matches the committed golden file byte-for-byte.
//! - The deserialized envelope round-trips structurally.
//! - `embed_capabilities` and the envelope's capabilities slice agree.
//! - Capability-gated typed accessors honour the declaration.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use utsushi_core::{
    EMBED_SCHEMA_VERSION, EMBED_SNAPSHOT_CONTENT_HASH_HEX_LEN, EmbedArtifactRef, EmbedCapability,
    EmbedCapabilityId, EmbedError, EmbedSchemaVersion, EmbedSnapshotRef, EmbedState, EmbedTrace,
    EmbedTraceLine, EvidenceTier, ObservationBridgeRef, TextLine, embed_capabilities, embed_state,
    vfs::AssetId,
};

fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("embed_state_golden.json")
}

fn fixture_capabilities() -> Vec<EmbedCapability> {
    vec![
        EmbedCapability::supported(EmbedCapabilityId::State, EvidenceTier::E2),
        EmbedCapability::supported(EmbedCapabilityId::Trace, EvidenceTier::E1),
        EmbedCapability::supported(EmbedCapabilityId::Snapshot, EvidenceTier::E2),
        EmbedCapability::partial(
            EmbedCapabilityId::ArtifactRefs,
            EvidenceTier::E2,
            vec!["fixture corpus exposes 2 artifact kinds only".to_string()],
        ),
        EmbedCapability::unsupported(
            EmbedCapabilityId::DeterministicFixture,
            vec!["fixture posture asserted by adapter id".to_string()],
        ),
    ]
}

fn fixture_text_line(index: usize) -> TextLine {
    TextLine {
        line_id: format!("line-{index:03}"),
        evidence_tier: EvidenceTier::E1,
        text: format!("fixture trace line {index}"),
        speaker: Some("narrator".to_string()),
        text_surface: Some("adv".to_string()),
        bridge_ref: Some(ObservationBridgeRef {
            bridge_unit_id: Some(format!("0190a000-0000-7000-8000-00000000000{index}")),
            source_unit_key: Some(format!("intro/line/{index}")),
            runtime_object_id: Some(format!("scene-intro/text-{index}")),
        }),
        source_asset: Some(AssetId::parse("vfs://www/data/Map001.json").expect("asset id")),
    }
}

fn fixture_trace() -> EmbedTrace {
    EmbedTrace {
        schema_version: EmbedSchemaVersion::current(),
        lines: (1..=5)
            .map(|index| EmbedTraceLine {
                text_line: fixture_text_line(index),
            })
            .collect(),
    }
}

fn fixture_snapshot_ref() -> EmbedSnapshotRef {
    EmbedSnapshotRef {
        snapshot_id: "run-fixture-001-tick-0042".to_string(),
        adapter_id: "utsushi-fixture".to_string(),
        content_hash: "0".repeat(EMBED_SNAPSHOT_CONTENT_HASH_HEX_LEN),
        size_bytes: 1024,
        evidence_tier: EvidenceTier::E2,
    }
}

fn fixture_artifact_refs() -> Vec<EmbedArtifactRef> {
    vec![
        EmbedArtifactRef {
            artifact_id: "screenshot-001".to_string(),
            artifact_kind: "screenshot".to_string(),
            uri: "artifacts/utsushi/runtime/run-fixture-001/screenshots/screenshot-001.png"
                .to_string(),
            media_type: Some("image/png".to_string()),
        },
        EmbedArtifactRef {
            artifact_id: "trace-log-001".to_string(),
            artifact_kind: "trace_log".to_string(),
            uri: "artifacts/utsushi/runtime/run-fixture-001/traces/trace-log-001.json".to_string(),
            media_type: Some("application/json".to_string()),
        },
    ]
}

fn fixture_state() -> EmbedState {
    EmbedState {
        schema_version: EmbedSchemaVersion::current(),
        adapter_id: "utsushi-fixture".to_string(),
        adapter_version: "0.0.0".to_string(),
        capabilities: fixture_capabilities(),
        trace: fixture_trace(),
        current_snapshot: Some(fixture_snapshot_ref()),
        artifact_refs: fixture_artifact_refs(),
    }
}

fn canonical_pretty(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(value).expect("serialize");
    text.push('\n');
    text
}

#[test]
fn fixture_embed_state_round_trips_through_canonical_json() {
    let state = fixture_state();
    let value = state.to_json_value().expect("serialize fixture envelope");
    let path = golden_path();
    if std::env::var_os("UPDATE_EMBED_GOLDEN").is_some() {
        fs::write(&path, canonical_pretty(&value).as_bytes()).expect("write golden");
        return;
    }
    let expected_raw =
        fs::read_to_string(&path).expect("golden fixture exists; run with UPDATE_EMBED_GOLDEN=1");
    // Compare parsed JSON values so editor / linter reformatting of the
    // golden (single-line vs multi-line short arrays) does not break the
    // assertion. The wire form contract is "byte-identical produced JSON",
    // not "byte-identical pretty-printed JSON"; the redaction filter and
    // round-trip both run against the structural value.
    let expected: Value = serde_json::from_str(&expected_raw).expect("golden is valid json");
    assert_eq!(
        value, expected,
        "fixture envelope drifted from golden; rerun with UPDATE_EMBED_GOLDEN=1 if intentional"
    );
    let parsed = EmbedState::from_json_value(value).expect("deserialize envelope");
    assert_eq!(parsed, state, "round-trip preserved structural equality");
    assert_eq!(
        parsed.schema_version.as_str(),
        EMBED_SCHEMA_VERSION,
        "schema version pinned"
    );
}

#[test]
fn fixture_embed_state_capability_listing_matches_envelope_capabilities() {
    let state = fixture_state();
    let envelope_capabilities = serde_json::to_value(&state.capabilities).expect("serialize");
    let standalone = embed_capabilities(&state.capabilities).expect("standalone");
    assert_eq!(
        envelope_capabilities, standalone,
        "embed_capabilities and EmbedState::capabilities agree byte-for-byte"
    );
    let value = embed_state(&state).expect("embed_state");
    assert_eq!(
        value["capabilities"], standalone,
        "embed_state envelope embeds the same capability listing"
    );
}

#[test]
fn fixture_embed_state_with_unsupported_snapshot_capability_omits_current_snapshot() {
    let mut state = fixture_state();
    state.current_snapshot = None;
    for capability in state.capabilities.iter_mut() {
        if capability.capability_id == EmbedCapabilityId::Snapshot {
            *capability = EmbedCapability::unsupported(
                EmbedCapabilityId::Snapshot,
                vec!["fixture has no snapshot store".to_string()],
            );
        }
    }
    state
        .validate()
        .expect("envelope without snapshot still valid");
    assert!(state.current_snapshot.is_none());
    let error = state
        .current_snapshot()
        .expect_err("typed accessor returns err");
    assert!(matches!(
        error,
        EmbedError::CapabilityNotSupported {
            capability_id: EmbedCapabilityId::Snapshot
        }
    ));
    let value = state.to_json_value().expect("serialize");
    assert!(
        value.get("currentSnapshot").is_none(),
        "currentSnapshot omitted from wire form when None"
    );
}
