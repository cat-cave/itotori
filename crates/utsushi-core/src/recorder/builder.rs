//! Recorder trait + in-memory accumulator implementation.
//!
//! The [`ReferenceRecorder`] trait is the producer-facing seam. A fixture
//! runtime (or, later, an engine port) holds an `Arc<dyn ReferenceRecorder>`
//! and pushes observed events through the four `record_*` methods. The
//! reference trace is materialised through [`ReferenceRecorder::finalize`].
//!
//! The only impl in this slice is [`InMemoryReferenceRecorder`]. It is
//! `Send + Sync` and uses a `Mutex<Inner>` so push sites only need `&self`.

use std::sync::Mutex;

use crate::embed::sort_capabilities;
use crate::{EmbedCapability, ReplayEntry, SnapshotRef, TextLine};

use super::serialize::deterministic_json_bytes;
use super::trace::{REFERENCE_TRACE_SCHEMA_VERSION, ReferenceTrace, SourceTag};

/// Producer-facing recorder seam.
///
/// All methods take `&self`; implementors handle interior mutability. The
/// trait is `Send + Sync` so an `Arc<dyn ReferenceRecorder>` can be shared
/// across the fixture runtime, the sink bridge, and any conformance check
/// driver that wants to push capability snapshots.
pub trait ReferenceRecorder: Send + Sync {
    /// Record a text event in observation order.
    fn record_text_event(&self, line: TextLine);

    /// Replace the current capability snapshot. The recorder canonicalises
    /// the list (sorted) on [`Self::finalize`], so callers may push in any
    /// order; the wire form is stable.
    fn record_capability_state(&self, capabilities: &[EmbedCapability]);

    /// Record a snapshot reference. Id-only; the recorder does not accept
    /// payload bytes.
    fn record_snapshot_ref(&self, snapshot: SnapshotRef);

    /// Record a replay log entry. The caller is expected to push entries in
    /// the order [`crate::ReplayLog`] guarantees.
    fn record_replay_event(&self, entry: ReplayEntry);

    /// Build the final [`ReferenceTrace`]. Idempotent: calling twice returns
    /// the same value (with internal lists canonicalised).
    fn finalize(&self) -> ReferenceTrace;

    /// Convenience: finalize and serialize through the canonical helper.
    fn finalize_to_bytes(&self) -> Vec<u8> {
        deterministic_json_bytes(&self.finalize())
    }
}

/// In-memory recorder. The only [`ReferenceRecorder`] impl in this slice.
///
/// `Mutex<Inner>` gives interior mutability so push sites only need `&self`.
/// Buffer growth is unbounded with no per-trace cap (UTSUSHI-061 will tackle
/// long-run capture).
pub struct InMemoryReferenceRecorder {
    source: SourceTag,
    adapter_id: String,
    recorded_at: String,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    text_events: Vec<TextLine>,
    capability_state: Vec<EmbedCapability>,
    snapshot_refs: Vec<SnapshotRef>,
    replay_events: Vec<ReplayEntry>,
}

impl InMemoryReferenceRecorder {
    /// Construct a fresh recorder. `recorded_at` is a caller-supplied stable
    /// label (run id / fixture name); the recorder will not call any host
    /// clock.
    pub fn new(
        source: SourceTag,
        adapter_id: impl Into<String>,
        recorded_at: impl Into<String>,
    ) -> Self {
        Self {
            source,
            adapter_id: adapter_id.into(),
            recorded_at: recorded_at.into(),
            inner: Mutex::new(Inner::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("recorder mutex poisoned")
    }
}

impl ReferenceRecorder for InMemoryReferenceRecorder {
    fn record_text_event(&self, line: TextLine) {
        self.lock().text_events.push(line);
    }

    fn record_capability_state(&self, capabilities: &[EmbedCapability]) {
        let mut guard = self.lock();
        guard.capability_state.clear();
        guard.capability_state.extend_from_slice(capabilities);
    }

    fn record_snapshot_ref(&self, snapshot: SnapshotRef) {
        self.lock().snapshot_refs.push(snapshot);
    }

    fn record_replay_event(&self, entry: ReplayEntry) {
        self.lock().replay_events.push(entry);
    }

    fn finalize(&self) -> ReferenceTrace {
        let guard = self.lock();
        let mut capabilities = guard.capability_state.clone();
        sort_capabilities(&mut capabilities);
        ReferenceTrace {
            schema_version: REFERENCE_TRACE_SCHEMA_VERSION.to_string(),
            source: self.source,
            adapter_id: self.adapter_id.clone(),
            text_events: guard.text_events.clone(),
            capability_state: capabilities,
            snapshot_refs: guard.snapshot_refs.clone(),
            replay_events: guard.replay_events.clone(),
            recorded_at: self.recorded_at.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::vfs::AssetId;
    use crate::{
        ChoiceIndex, EmbedCapability, EmbedCapabilityId, EvidenceTier, InputEvent,
        LogicalClockTick, ObservationBridgeRef, ReplayEntry, SnapshotId, SnapshotRef, TextLine,
    };

    use super::super::serialize::deterministic_json_bytes;
    use super::*;

    fn sample_bridge_ref() -> ObservationBridgeRef {
        ObservationBridgeRef {
            bridge_unit_id: Some("0190a000-0000-7000-8000-000000000001".to_string()),
            source_unit_key: Some("intro/line/1".to_string()),
            runtime_object_id: Some("scene-intro/text-1".to_string()),
        }
    }

    fn text_event(id: &str, body: &str) -> TextLine {
        TextLine {
            line_id: id.to_string(),
            evidence_tier: EvidenceTier::E1,
            text: body.to_string(),
            speaker: Some("narrator".to_string()),
            color: None,
            text_surface: Some("adv".to_string()),
            bridge_ref: Some(sample_bridge_ref()),
            source_asset: Some(
                AssetId::parse("vfs://www/data/Map001.json").expect("valid asset id"),
            ),
        }
    }

    fn snapshot_ref(id: &str) -> SnapshotRef {
        SnapshotRef {
            snapshot_id: SnapshotId::parse(id).expect("valid id"),
            inspectable_id: "fixture-runtime".to_string(),
            evidence_tier: EvidenceTier::E1,
        }
    }

    fn replay_entry(tick: u64, choice: u16) -> ReplayEntry {
        ReplayEntry {
            tick: LogicalClockTick(tick),
            event: InputEvent::Choice {
                index: ChoiceIndex(choice),
                bridge_unit_id: None,
            },
        }
    }

    fn populate(recorder: &dyn ReferenceRecorder) {
        recorder.record_text_event(text_event("line-001", "hello"));
        recorder.record_text_event(text_event("line-002", "world"));
        recorder.record_text_event(text_event("line-003", "again"));
        recorder.record_capability_state(&[
            EmbedCapability::supported(EmbedCapabilityId::State, EvidenceTier::E2),
            EmbedCapability::supported(EmbedCapabilityId::Trace, EvidenceTier::E1),
        ]);
        recorder.record_snapshot_ref(snapshot_ref("snap-fixture-1"));
        recorder.record_replay_event(replay_entry(1, 0));
        recorder.record_replay_event(replay_entry(2, 1));
    }

    #[test]
    fn round_trip_byte_identical() {
        let recorder =
            InMemoryReferenceRecorder::new(SourceTag::Fixture, "fixture-adapter", "fixture-run-1");
        populate(&recorder);
        let first = recorder.finalize_to_bytes();
        let second = recorder.finalize_to_bytes();
        assert_eq!(
            first, second,
            "two finalize_to_bytes calls must be byte-equal"
        );
    }

    #[test]
    fn cross_recorder_determinism() {
        let a =
            InMemoryReferenceRecorder::new(SourceTag::Fixture, "fixture-adapter", "fixture-run-1");
        let b =
            InMemoryReferenceRecorder::new(SourceTag::Fixture, "fixture-adapter", "fixture-run-1");
        populate(&a);
        populate(&b);
        assert_eq!(
            a.finalize_to_bytes(),
            b.finalize_to_bytes(),
            "independent recorders with the same input produce byte-equal output",
        );
    }

    #[test]
    fn capability_list_canonicalised_to_sort_order() {
        let recorder =
            InMemoryReferenceRecorder::new(SourceTag::Fixture, "fixture-adapter", "fixture-run-1");
        // Reverse-sort-key insertion: DeterministicFixture last by sort_key
        // ((4, "deterministic_fixture")) pushed first; State first by
        // sort_key pushed last.
        recorder.record_capability_state(&[
            EmbedCapability::supported(EmbedCapabilityId::DeterministicFixture, EvidenceTier::E1),
            EmbedCapability::unsupported(
                EmbedCapabilityId::ArtifactRefs,
                vec!["fixture has no managed artifact corpus".to_string()],
            ),
            EmbedCapability::partial(
                EmbedCapabilityId::Snapshot,
                EvidenceTier::E2,
                vec!["snapshots id-only".to_string()],
            ),
            EmbedCapability::supported(EmbedCapabilityId::Trace, EvidenceTier::E1),
            EmbedCapability::supported(EmbedCapabilityId::State, EvidenceTier::E2),
        ]);
        let trace = recorder.finalize();
        let ids: Vec<EmbedCapabilityId> = trace
            .capability_state
            .iter()
            .map(|c| c.capability_id)
            .collect();
        assert_eq!(
            ids,
            vec![
                EmbedCapabilityId::State,
                EmbedCapabilityId::Trace,
                EmbedCapabilityId::Snapshot,
                EmbedCapabilityId::ArtifactRefs,
                EmbedCapabilityId::DeterministicFixture,
            ]
        );
    }

    #[test]
    fn source_tag_wire_form_is_kebab_case_for_every_variant() {
        for (tag, wire) in [
            (SourceTag::Browser, "browser"),
            (SourceTag::Native, "native"),
            (SourceTag::Wine, "wine"),
            (SourceTag::Fixture, "fixture"),
        ] {
            let recorder = InMemoryReferenceRecorder::new(tag, "fixture-adapter", "fixture-run-1");
            let bytes = recorder.finalize_to_bytes();
            let json = String::from_utf8(bytes).expect("utf-8");
            let value: serde_json::Value = serde_json::from_str(&json).expect("parse");
            assert_eq!(value["source"].as_str(), Some(wire));
            // No host-specific substring leaks through. We do not include
            // C:\ literally to avoid embedding it in source; the recorder is
            // engine-neutral by construction, so checking obvious local
            // paths is sufficient.
            assert!(!json.contains("/home"), "no /home path in JSON: {json}");
            assert!(!json.contains("wine-"), "no wine- token in JSON: {json}");
            assert!(!json.contains("C:\\"), "no Windows drive in JSON: {json}");
        }
    }

    #[test]
    fn every_source_tag_round_trips_through_serde() {
        for tag in [
            SourceTag::Browser,
            SourceTag::Native,
            SourceTag::Wine,
            SourceTag::Fixture,
        ] {
            let recorder = InMemoryReferenceRecorder::new(tag, "fixture-adapter", "fixture-run-1");
            let trace = recorder.finalize();
            let bytes = deterministic_json_bytes(&trace);
            let parsed: ReferenceTrace = serde_json::from_slice(&bytes).expect("round-trip");
            assert_eq!(parsed, trace);
            assert_eq!(parsed.source, tag);
        }
    }

    #[test]
    fn empty_trace_round_trips() {
        let recorder =
            InMemoryReferenceRecorder::new(SourceTag::Fixture, "fixture-adapter", "fixture-run-1");
        let trace = recorder.finalize();
        let bytes = deterministic_json_bytes(&trace);
        let parsed: ReferenceTrace = serde_json::from_slice(&bytes).expect("round-trip");
        assert_eq!(parsed.schema_version, REFERENCE_TRACE_SCHEMA_VERSION);
        assert!(parsed.text_events.is_empty());
        assert!(parsed.capability_state.is_empty());
        assert!(parsed.snapshot_refs.is_empty());
        assert!(parsed.replay_events.is_empty());
    }

    #[test]
    fn without_snapshot_refs_serializes_empty_array() {
        let recorder =
            InMemoryReferenceRecorder::new(SourceTag::Fixture, "fixture-adapter", "fixture-run-1");
        recorder.record_text_event(text_event("line-001", "hi"));
        let bytes = recorder.finalize_to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("parse");
        assert_eq!(value["snapshotRefs"].as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn with_snapshot_refs_preserves_insertion_order_and_id_only_shape() {
        let recorder =
            InMemoryReferenceRecorder::new(SourceTag::Fixture, "fixture-adapter", "fixture-run-1");
        recorder.record_snapshot_ref(snapshot_ref("snap-first"));
        recorder.record_snapshot_ref(snapshot_ref("snap-second"));
        let trace = recorder.finalize();
        let ids: Vec<&str> = trace
            .snapshot_refs
            .iter()
            .map(|r| r.snapshot_id.as_str())
            .collect();
        assert_eq!(ids, vec!["snap-first", "snap-second"]);
        let bytes = deterministic_json_bytes(&trace);
        let json = String::from_utf8(bytes).expect("utf-8");
        // SnapshotRef has only snapshotId, inspectableId, evidenceTier.
        // Confirm no raw-bytes or host-path field leaked.
        assert!(!json.contains("\"bytes\""), "no bytes field in JSON");
        assert!(
            !json.contains("\"path\""),
            "no path field in snapshot ref JSON"
        );
        assert!(json.contains("\"snapshotId\":\"snap-first\""));
        assert!(json.contains("\"snapshotId\":\"snap-second\""));
    }

    #[test]
    fn finalize_is_idempotent_with_intervening_record() {
        let recorder =
            InMemoryReferenceRecorder::new(SourceTag::Fixture, "fixture-adapter", "fixture-run-1");
        recorder.record_text_event(text_event("line-001", "first"));
        let first = recorder.finalize();
        let second = recorder.finalize();
        assert_eq!(
            first, second,
            "consecutive finalize calls return equal values"
        );

        recorder.record_text_event(text_event("line-002", "second"));
        let third = recorder.finalize();
        assert_eq!(third.text_events.len(), 2);
        assert_eq!(third.text_events[1].line_id, "line-002");
    }

    #[test]
    fn recorder_send_sync_through_arc() {
        // Compile-level guarantee: ReferenceRecorder is dyn-Send-Sync. The
        // test asserts the recorder is Arc-shareable; without Send + Sync
        // this would not compile.
        let recorder: Arc<dyn ReferenceRecorder> = Arc::new(InMemoryReferenceRecorder::new(
            SourceTag::Fixture,
            "fixture-adapter",
            "fixture-run-1",
        ));
        recorder.record_text_event(text_event("line-001", "hi"));
        assert_eq!(recorder.finalize().text_events.len(), 1);
    }
}
