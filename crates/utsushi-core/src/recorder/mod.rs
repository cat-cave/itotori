//! Reference runtime trace and capture recorder ().
//!
//! Engine-neutral recording substrate that captures a runtime's observed
//! trace, capability state, snapshot refs, and replay events from a fixture
//! (or, later, real-engine) run and serializes them as a deterministic JSON
//! [`ReferenceTrace`]. The output is the input that the conformance trace
//! ([`crate::conformance::trace_branch`]), branch, snapshot, and capture
//! checks consume to compare partial-VM and replay-engine behavior against an
//! observed reference.
//!
//! ## Posture (matches substrates)
//!
//! - **Engine-neutral.** [`SourceTag`] is the only place an engine family
//!   surfaces, and it is a closed enum (`Browser`, `Native`, `Wine`
//!   `Fixture`). Never a host path; never a binary version.
//! - **No raw bytes.** Snapshot and capture references are id-only
//!   ([`crate::SnapshotRef`]). The recorder never accepts payload bytes.
//! - **Deterministic JSON.** [`serialize::deterministic_json_bytes`] walks
//!   `serde_json::Value` post-emit and re-emits every object through a
//!   `BTreeMap`-backed sorted form so byte output survives a serde-json minor
//!   bump.
//! - **No host clock.** `recorded_at` is a caller-supplied stable label
//!   (run id / fixture name), not a wall-clock instant.
//!
//! ## What is NOT in this slice
//!
//! - No engine port. A fixture runtime is the only producer in this slice;
//!   real engine ports plug in via existing [`SourceTag`] variants without
//!   schema churn.
//! - No live capture orchestration; will own that.
//! - No frame / audio artifact recording; the substrate widens when the first
//!   capture consumer lands.
//! - No replay of a recorded trace; conformance checks consume the JSON
//!   directly.

pub mod builder;
pub mod serialize;
pub mod sink_bridge;
pub mod trace;

pub use builder::{InMemoryReferenceRecorder, ReferenceRecorder};
pub use serialize::deterministic_json_bytes;
pub use sink_bridge::RecordingTextSink;
pub use trace::{REFERENCE_TRACE_SCHEMA_VERSION, ReferenceTrace, SourceTag};
