//! Reference trace wire form.
//!
//! [`ReferenceTrace`] is the JSON-shaped record a recorder produces and
//! conformance checks consume. The shape is fixed by [`REFERENCE_TRACE_SCHEMA_VERSION`];
//! schema-altering changes require a version bump.

use serde::{Deserialize, Serialize};

use crate::{EmbedCapability, ReplayEntry, SnapshotRef, TextLine};

/// Schema version pin for the reference trace wire form. Pinned for the
/// duration of the slice; downstream conformance checks
/// ( / -028 / -029) verify the pin verbatim.
pub const REFERENCE_TRACE_SCHEMA_VERSION: &str = "0.1.0-alpha";

/// Engine-family-neutral source tag for a recorded run.
///
/// Never a host path. Never a host or engine binary version. New engine
/// ports (browser / native / Wine) plug in by selecting an existing tag;
/// enrichment (e.g. `BrowserChromium`, `WineProton`) is out of scope here
/// and is a schema_version bump when it lands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceTag {
    /// In-browser embed (WASM / JS host).
    Browser,
    /// Native engine binary running on the host OS.
    Native,
    /// Native engine binary running through Wine.
    Wine,
    /// Deterministic fixture runtime. The only producer in this slice.
    Fixture,
}

/// The reference trace wire form.
///
/// Field-order policy:
/// - `text_events` are inherently sequential; the serializer preserves
///   insertion order.
/// - `capability_state` is canonicalised via
///   [`crate::embed::sort_capabilities`] on [`crate::ReferenceRecorder::finalize`]
///   so two runs that record the same capabilities in different orders
///   produce identical JSON.
/// - `snapshot_refs` and `replay_events` preserve insertion order; the
///   caller is expected to feed them in the order their upstream substrate
///   already guarantees ( for replay events).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReferenceTrace {
    /// Schema version pin. Always equal to [`REFERENCE_TRACE_SCHEMA_VERSION`]
    /// at construction time.
    pub schema_version: String,
    /// Engine-family-neutral source tag for the run.
    pub source: SourceTag,
    /// Public adapter identifier (e.g. the conformance manifest adapter_id).
    pub adapter_id: String,
    /// Text events in observation order.
    pub text_events: Vec<TextLine>,
    /// Embed capability snapshot at recording time. Always emitted in
    /// [`crate::embed::sort_capabilities`] order.
    pub capability_state: Vec<EmbedCapability>,
    /// Snapshot references by id only. No raw bytes, no host paths.
    pub snapshot_refs: Vec<SnapshotRef>,
    /// Replay log events, in logical-tick order (the order ReplayLog
    /// already guarantees through ).
    pub replay_events: Vec<ReplayEntry>,
    /// Stable, source-supplied recording label. Must NOT be a wall-clock
    /// instant; it is a deterministic identifier (run id / fixture name).
    pub recorded_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_tag_serializes_as_kebab_case() {
        for (tag, wire) in [
            (SourceTag::Browser, "browser"),
            (SourceTag::Native, "native"),
            (SourceTag::Wine, "wine"),
            (SourceTag::Fixture, "fixture"),
        ] {
            let value = serde_json::to_value(tag).expect("serialize");
            assert_eq!(value.as_str(), Some(wire));
            let parsed: SourceTag = serde_json::from_value(value).expect("deserialize");
            assert_eq!(parsed, tag);
        }
    }

    #[test]
    fn schema_version_pin_is_alpha() {
        assert_eq!(REFERENCE_TRACE_SCHEMA_VERSION, "0.1.0-alpha");
    }
}
