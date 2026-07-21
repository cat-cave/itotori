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
#[path = "replay_tests.rs"]
mod tests;
