//! Deterministic, redaction-safe replay log.
//!
//! A [`ReplayLog`] is the immutable record of a deterministic run that the
//! replay-driven runner can re-execute against any compatible adapter. It
//! carries:
//!
//! - schema version pinned to [`REPLAY_LOG_SCHEMA_VERSION`];
//! - run-level [`ReplayMetadata`] (run id, adapter name/version, clock origin
//!   RNG seed, optional public source label);
//! - a strictly tick-monotonic sequence of [`ReplayEntry`] payloads;
//! - the set of asset ids the recording depended on, surfaced through
//!   [`ReplayLog::asset_refs`].
//!
//! All construction goes through [`ReplayLogBuilder`]; the built log has no
//! public mutators. Both `record` and `from_json_value` walk the event payload
//! through the `reject_unredacted_local_paths` filter so no host path can
//! enter the log.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::UtsushiResult;
use crate::clock::{ClockOrigin, LogicalClockTick};
use crate::input::{InputError, InputEvent};
use crate::reject_unredacted_local_paths_public;
use crate::vfs::AssetId;

/// Pinned schema version for the replay log wire form.
///
/// Adding a new input variant is a minor bump; changing an existing variant's
/// fields is a major bump and breaks on-disk logs by design.
pub const REPLAY_LOG_SCHEMA_VERSION: &str = "0.1.0-alpha";

/// Schema-version envelope for the replay log wire form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ReplaySchemaVersion(pub String);

impl ReplaySchemaVersion {
    /// The current pinned schema version.
    pub fn current() -> Self {
        Self(REPLAY_LOG_SCHEMA_VERSION.to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for ReplaySchemaVersion {
    fn default() -> Self {
        Self::current()
    }
}

/// Run-level metadata. Carries no host path, no embedded bytes, and no
/// host-clock instants.
///
/// All fields are private: metadata is read-only after construction and is
/// created either through [`ReplayMetadata::new`] (the build path) or through
/// serde `Deserialize` (which populates the private fields directly). Reads go
/// through the accessor methods. The serde wire form is unchanged — the field
/// names and `camelCase` rename remain identical to the pre-privatization form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReplayMetadata {
    /// Stable identifier of the recorded run.
    run_id: String,
    /// Public name of the engine adapter that produced the recording.
    adapter_name: String,
    adapter_version: String,
    /// Clock origin used by the recording.
    clock_origin: ClockOrigin,
    /// RNG seed delivered to the adapter; 0 means no RNG was requested.
    seed: u64,
    /// Optional public-name reference to the asset bundle used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_label: Option<String>,
}

impl ReplayMetadata {
    /// Construct run-level metadata. This is the build path; the returned value
    /// is read-only through the accessor methods.
    pub fn new(
        run_id: impl Into<String>,
        adapter_name: impl Into<String>,
        adapter_version: impl Into<String>,
        clock_origin: ClockOrigin,
        seed: u64,
        source_label: Option<String>,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            adapter_name: adapter_name.into(),
            adapter_version: adapter_version.into(),
            clock_origin,
            seed,
            source_label,
        }
    }

    /// Stable identifier of the recorded run.
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// Public name of the engine adapter that produced the recording.
    pub fn adapter_name(&self) -> &str {
        &self.adapter_name
    }

    /// Version of the engine adapter that produced the recording.
    pub fn adapter_version(&self) -> &str {
        &self.adapter_version
    }

    /// Clock origin used by the recording.
    pub fn clock_origin(&self) -> ClockOrigin {
        self.clock_origin
    }

    /// RNG seed delivered to the adapter; 0 means no RNG was requested.
    pub fn seed(&self) -> u64 {
        self.seed
    }

    /// Optional public-name reference to the asset bundle used.
    pub fn source_label(&self) -> Option<&str> {
        self.source_label.as_deref()
    }
}

/// A recorded input event anchored at a logical tick.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReplayEntry {
    pub tick: LogicalClockTick,
    pub event: InputEvent,
}

/// The replay log itself. Construct via [`ReplayLogBuilder`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReplayLog {
    schema_version: ReplaySchemaVersion,
    metadata: ReplayMetadata,
    events: Vec<ReplayEntry>,
    asset_refs: Vec<AssetId>,
}

/// Cursor for iterating a [`ReplayLog`] one event at a time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ReplayCursor(pub usize);

impl ReplayCursor {
    /// Cursor pointing at the first entry.
    pub const fn start() -> Self {
        Self(0)
    }

    /// Underlying index.
    pub const fn index(self) -> usize {
        self.0
    }
}

impl Default for ReplayCursor {
    fn default() -> Self {
        Self::start()
    }
}

/// Builder for [`ReplayLog`]. The only path through which entries enter the
/// log.
#[derive(Debug, Default)]
pub struct ReplayLogBuilder {
    metadata: Option<ReplayMetadata>,
    events: Vec<ReplayEntry>,
    asset_refs: Vec<AssetId>,
    last_tick: Option<LogicalClockTick>,
}

impl ReplayLogBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the run-level metadata. Replaces any previously set metadata.
    pub fn metadata(mut self, metadata: ReplayMetadata) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Append a recorded input event at the given tick.
    ///
    /// Rejects with [`InputError::NonMonotonicTick`] if the tick is not
    /// strictly greater than the previously recorded tick. Rejects with
    /// [`InputError::InvalidPayload`] if the event's payload fails shape
    /// validation. Rejects with [`InputError::RedactionViolation`] if any
    /// string field looks like a host-local path.
    pub fn record(&mut self, tick: LogicalClockTick, event: InputEvent) -> Result<(), InputError> {
        event.validate_payload_shape()?;
        if let Some(previous) = self.last_tick
            && tick <= previous
        {
            return Err(InputError::non_monotonic_tick(previous, tick));
        }
        assert_replay_event_redaction(&event)?;
        self.last_tick = Some(tick);
        self.events.push(ReplayEntry { tick, event });
        Ok(())
    }

    /// Declare a `vfs://` asset id the recording depended on. Deduplicated
    /// while preserving first-insertion order.
    pub fn note_asset(&mut self, id: AssetId) {
        if !self.asset_refs.iter().any(|existing| existing == &id) {
            self.asset_refs.push(id);
        }
    }

    /// Finalize the log. Runs a final consistency pass:
    /// - metadata is present;
    /// - schema version is pinned to [`REPLAY_LOG_SCHEMA_VERSION`];
    /// - the full serialized JSON form passes the redaction filter end-to-end.
    pub fn build(self) -> Result<ReplayLog, InputError> {
        let metadata = self.metadata.ok_or_else(|| {
            InputError::invalid_payload(
                crate::input::InputKind::Raw,
                "ReplayLogBuilder::build requires metadata()",
            )
        })?;
        let log = ReplayLog {
            schema_version: ReplaySchemaVersion::current(),
            metadata,
            events: self.events,
            asset_refs: self.asset_refs,
        };
        // Final redaction sweep over the serialized form. We construct the
        // JSON value via serde and walk it; any leaking string fails build.
        let value = serde_json::to_value(&log).map_err(|error| {
            InputError::invalid_payload(
                crate::input::InputKind::Raw,
                format!("ReplayLog serialization failed: {error}"),
            )
        })?;
        walk_redaction("", &value)?;
        Ok(log)
    }
}

impl ReplayLog {
    /// Borrow the pinned schema version envelope.
    pub fn schema_version(&self) -> &ReplaySchemaVersion {
        &self.schema_version
    }

    /// Borrow the run-level metadata.
    pub fn metadata(&self) -> &ReplayMetadata {
        &self.metadata
    }

    /// Borrow the recorded events.
    pub fn events(&self) -> &[ReplayEntry] {
        &self.events
    }

    /// Borrow the asset ids declared as dependencies.
    pub fn asset_refs(&self) -> &[AssetId] {
        &self.asset_refs
    }

    /// Iterate the recorded events in tick order.
    pub fn iter(&self) -> impl Iterator<Item = &ReplayEntry> {
        self.events.iter()
    }

    /// Cursor-driven traversal. Returns the entry at the cursor and the next
    /// cursor, or `Ok(None)` at end-of-log. Returns `Err` if the cursor
    /// references a position outside `[0, events.len()]`.
    pub fn next_event(
        &self,
        cursor: ReplayCursor,
    ) -> Result<Option<(ReplayEntry, ReplayCursor)>, InputError> {
        let position = cursor.index();
        match position.cmp(&self.events.len()) {
            std::cmp::Ordering::Greater => Err(InputError::invalid_payload(
                crate::input::InputKind::Raw,
                format!(
                    "replay cursor {position} is past end-of-log ({})",
                    self.events.len()
                ),
            )),
            std::cmp::Ordering::Equal => Ok(None),
            std::cmp::Ordering::Less => {
                let entry = self.events[position].clone();
                Ok(Some((entry, ReplayCursor(position + 1))))
            }
        }
    }

    /// Serialize the log to a `serde_json::Value`, re-running the redaction
    /// filter so accidental leakage fails serialization rather than emitting
    /// it.
    pub fn to_json_value(&self) -> UtsushiResult<Value> {
        let value = serde_json::to_value(self)?;
        reject_unredacted_local_paths_public("", &value)?;
        Ok(value)
    }

    /// Deserialize a log from a `serde_json::Value`. Validates schema
    /// version, payload shapes, tick monotonicity, and the redaction filter.
    pub fn from_json_value(value: Value) -> UtsushiResult<Self> {
        let log: ReplayLog = serde_json::from_value(value)?;
        if log.schema_version.as_str() != REPLAY_LOG_SCHEMA_VERSION {
            return Err(Box::new(InputError::unsupported_schema_version(
                log.schema_version.0.clone(),
                REPLAY_LOG_SCHEMA_VERSION,
            )));
        }
        // Validate payload shapes and tick monotonicity end-to-end.
        let mut previous: Option<LogicalClockTick> = None;
        for entry in &log.events {
            entry.event.validate_payload_shape()?;
            assert_replay_event_redaction(&entry.event)?;
            if let Some(prev) = previous
                && entry.tick <= prev
            {
                return Err(Box::new(InputError::non_monotonic_tick(prev, entry.tick)));
            }
            previous = Some(entry.tick);
        }
        // Full-document redaction sweep.
        let value = serde_json::to_value(&log)?;
        reject_unredacted_local_paths_public("", &value)?;
        Ok(log)
    }
}

/// Walk a single event's serialized form and reject any unredacted host path.
fn assert_replay_event_redaction(event: &InputEvent) -> Result<(), InputError> {
    let value = serde_json::to_value(event).map_err(|error| {
        InputError::invalid_payload(event.kind(), format!("event serialization failed: {error}"))
    })?;
    walk_redaction("event", &value)
}

fn walk_redaction(path: &str, value: &Value) -> Result<(), InputError> {
    match value {
        Value::String(text) => {
            if crate::looks_like_local_path_public(text) {
                return Err(InputError::redaction_violation(path.to_string()));
            }
            Ok(())
        }
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                walk_redaction(&format!("{path}[{index}]"), value)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (key, value) in map {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                walk_redaction(&child_path, value)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Convenience: wrap a built [`ReplayLog`] in an `Arc` for cheap sharing.
pub fn into_shared(log: ReplayLog) -> Arc<ReplayLog> {
    Arc::new(log)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::{ChoiceIndex, MenuTarget, PointerButton};
    use serde_json::json;

    fn sample_metadata() -> ReplayMetadata {
        ReplayMetadata {
            run_id: "replay-test-1".to_string(),
            adapter_name: "fixture".to_string(),
            adapter_version: "0.1.0".to_string(),
            clock_origin: ClockOrigin::RunStart,
            seed: 42,
            source_label: Some("public-fixture:hello-game".to_string()),
        }
    }

    fn small_log() -> ReplayLog {
        let mut builder = ReplayLogBuilder::new().metadata(sample_metadata());
        builder
            .record(LogicalClockTick(1), InputEvent::text())
            .unwrap();
        builder
            .record(LogicalClockTick(2), InputEvent::choice(0))
            .unwrap();
        builder
            .record(LogicalClockTick(3), InputEvent::text())
            .unwrap();
        builder
            .record(LogicalClockTick(4), InputEvent::advance())
            .unwrap();
        builder.build().unwrap()
    }

    #[test]
    fn replay_log_builder_records_events_in_strictly_monotonic_tick_order() {
        let log = small_log();
        assert_eq!(log.events().len(), 4);
        let ticks: Vec<u64> = log.events().iter().map(|entry| entry.tick.0).collect();
        assert_eq!(ticks, vec![1, 2, 3, 4]);
    }

    #[test]
    fn replay_log_builder_rejects_non_monotonic_tick_with_typed_error() {
        let mut builder = ReplayLogBuilder::new().metadata(sample_metadata());
        builder
            .record(LogicalClockTick(2), InputEvent::text())
            .unwrap();
        let error = builder
            .record(LogicalClockTick(2), InputEvent::text())
            .unwrap_err();
        match error {
            InputError::NonMonotonicTick {
                previous,
                attempted,
                code,
            } => {
                assert_eq!(previous, LogicalClockTick(2));
                assert_eq!(attempted, LogicalClockTick(2));
                assert_eq!(code, "utsushi.replay.non_monotonic_tick");
            }
            other => panic!("expected NonMonotonicTick, got {other:?}"),
        }
        let error_back = builder
            .record(LogicalClockTick(1), InputEvent::text())
            .unwrap_err();
        assert!(matches!(error_back, InputError::NonMonotonicTick { .. }));
    }

    #[test]
    fn replay_log_builder_rejects_event_with_redaction_violation() {
        let mut builder = ReplayLogBuilder::new().metadata(sample_metadata());
        let event = InputEvent::MenuSelect {
            target: MenuTarget::new("main_menu", "/home/trevor/secret"),
        };
        let error = builder.record(LogicalClockTick(1), event).unwrap_err();
        match error {
            InputError::RedactionViolation { code, field_path } => {
                assert_eq!(code, "utsushi.replay.redaction_violation");
                assert!(field_path.contains("itemId"));
            }
            other => panic!("expected RedactionViolation, got {other:?}"),
        }
    }

    #[test]
    fn replay_log_builder_requires_metadata() {
        let builder = ReplayLogBuilder::new();
        let error = builder.build().unwrap_err();
        assert!(matches!(error, InputError::InvalidPayload { .. }));
    }

    #[test]
    fn replay_log_round_trips_through_serde_json() {
        let log = small_log();
        let value = log.to_json_value().unwrap();
        let back = ReplayLog::from_json_value(value).unwrap();
        assert_eq!(log, back);
    }

    #[test]
    fn replay_log_to_json_value_passes_reject_unredacted_local_paths() {
        let log = small_log();
        let value = log.to_json_value().unwrap();
        // Doubly-sure: the helper reused at the runtime boundary must accept.
        crate::reject_unredacted_local_paths_public("", &value).unwrap();
    }

    #[test]
    fn replay_log_from_json_value_rejects_mismatched_schema_version() {
        let log = small_log();
        let mut value = log.to_json_value().unwrap();
        value["schemaVersion"] = json!("9.9.9");
        let error = ReplayLog::from_json_value(value).unwrap_err();
        let downcast = error.downcast::<InputError>().unwrap();
        match *downcast {
            InputError::UnsupportedSchemaVersion {
                observed,
                expected,
                code,
            } => {
                assert_eq!(observed, "9.9.9");
                assert_eq!(expected, "0.1.0-alpha");
                assert_eq!(code, "utsushi.replay.unsupported_schema_version");
            }
            other => panic!("expected UnsupportedSchemaVersion, got {other:?}"),
        }
    }

    #[test]
    fn replay_log_from_json_value_rejects_non_monotonic_ticks_in_payload() {
        let log = small_log();
        let mut value = log.to_json_value().unwrap();
        // forge the second entry tick to equal the first
        value["events"][1]["tick"] = json!(1);
        let error = ReplayLog::from_json_value(value).unwrap_err();
        let downcast = error.downcast::<InputError>().unwrap();
        assert!(matches!(*downcast, InputError::NonMonotonicTick { .. }));
    }

    #[test]
    fn replay_log_serialized_form_does_not_embed_asset_bytes() {
        // Synthesize a 100-event log with the heaviest variants the substrate
        // supports and verify the JSON ceiling.
        let mut builder = ReplayLogBuilder::new().metadata(sample_metadata());
        for index in 0..100u64 {
            let tick = LogicalClockTick(index + 1);
            let event = match index % 5 {
                0 => InputEvent::text(),
                1 => InputEvent::choice_with_bridge((index as u16) % 8, "bridge-unit-id-token"),
                2 => InputEvent::Pointer {
                    x: (index as f32) / 100.0,
                    y: 1.0 - (index as f32) / 100.0,
                    button: PointerButton::Primary,
                },
                3 => InputEvent::MenuSelect {
                    target: MenuTarget::new("main_menu", format!("item-{index}")),
                },
                _ => InputEvent::raw("fixture", format!("token-{index}")),
            };
            builder.record(tick, event).unwrap();
        }
        let log = builder.build().unwrap();
        let serialized = serde_json::to_string(&log).unwrap();
        // Ceiling: 16 KiB so any binary embedding regresses loudly.
        assert!(
            serialized.len() < 16 * 1024,
            "serialized replay log too large: {} bytes",
            serialized.len()
        );
    }

    #[test]
    fn replay_log_asset_refs_only_contain_vfs_scheme_ids() {
        let mut builder = ReplayLogBuilder::new().metadata(sample_metadata());
        builder.note_asset(AssetId::parse("vfs://hello/intro.txt").unwrap());
        builder.note_asset(AssetId::parse("vfs://hello/scene/02.txt").unwrap());
        builder
            .record(LogicalClockTick(1), InputEvent::text())
            .unwrap();
        let log = builder.build().unwrap();
        for id in log.asset_refs() {
            assert!(id.as_str().starts_with("vfs://"));
            // round-tripping through parse must succeed (canonical form).
            let parsed = AssetId::parse(id.as_str()).unwrap();
            assert_eq!(&parsed, id);
        }
        // and the serialized form preserves them.
        let value = log.to_json_value().unwrap();
        let refs = value.get("assetRefs").unwrap().as_array().unwrap();
        assert_eq!(refs.len(), 2);
        assert!(
            refs.iter()
                .all(|v| v.as_str().unwrap().starts_with("vfs://"))
        );
    }

    #[test]
    fn replay_cursor_drives_log_end_to_end_and_terminates_at_end() {
        let log = small_log();
        let mut cursor = ReplayCursor::start();
        let mut collected = Vec::new();
        while let Some((entry, next)) = log.next_event(cursor).unwrap() {
            collected.push(entry);
            cursor = next;
        }
        assert_eq!(collected.len(), 4);
        // one more call returns None
        assert!(log.next_event(cursor).unwrap().is_none());
    }

    #[test]
    fn replay_cursor_rejects_past_end_position() {
        let log = small_log();
        let error = log
            .next_event(ReplayCursor(log.events().len() + 1))
            .unwrap_err();
        assert!(matches!(error, InputError::InvalidPayload { .. }));
    }

    #[test]
    fn replay_log_redaction_walk_catches_path_in_metadata_source_label() {
        let mut builder = ReplayLogBuilder::new().metadata(ReplayMetadata {
            source_label: Some("/home/trevor/private-game".to_string()),
            ..sample_metadata()
        });
        builder
            .record(LogicalClockTick(1), InputEvent::text())
            .unwrap();
        let error = builder.build().unwrap_err();
        match error {
            InputError::RedactionViolation { field_path, .. } => {
                assert!(field_path.contains("sourceLabel"));
            }
            other => panic!("expected RedactionViolation, got {other:?}"),
        }
    }

    #[test]
    fn replay_log_pointer_invalid_payload_surfaces_typed_error() {
        let mut builder = ReplayLogBuilder::new().metadata(sample_metadata());
        let bad = InputEvent::Pointer {
            x: 1.5,
            y: 0.0,
            button: PointerButton::Primary,
        };
        let error = builder.record(LogicalClockTick(1), bad).unwrap_err();
        assert!(matches!(
            error,
            InputError::InvalidPayload {
                kind: crate::input::InputKind::Pointer,
                ..
            }
        ));
    }

    #[test]
    fn replay_schema_version_default_matches_pinned_constant() {
        assert_eq!(
            ReplaySchemaVersion::default().as_str(),
            REPLAY_LOG_SCHEMA_VERSION
        );
        assert_eq!(ReplaySchemaVersion::current().as_str(), "0.1.0-alpha");
    }

    #[test]
    fn replay_log_entry_choice_index_round_trips() {
        let mut builder = ReplayLogBuilder::new().metadata(sample_metadata());
        builder
            .record(
                LogicalClockTick(1),
                InputEvent::Choice {
                    index: ChoiceIndex(7),
                    bridge_unit_id: None,
                },
            )
            .unwrap();
        let log = builder.build().unwrap();
        let v = log.to_json_value().unwrap();
        let back = ReplayLog::from_json_value(v).unwrap();
        assert_eq!(log, back);
    }
}
