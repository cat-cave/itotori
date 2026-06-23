//! WASM embed ABI substrate (UTSUSHI-024).
//!
//! Engine-neutral substrate for browser / WASM embeds of an Utsushi
//! controlled-playback session. The ABI carries four observables across the
//! embed boundary:
//!
//! 1. A **capability declaration** ([`EmbedCapability`] / [`EmbedCapabilityId`]).
//! 2. A **trace** of sink-shaped text lines ([`EmbedTrace`] /
//!    [`EmbedTraceLine`]).
//! 3. A **current snapshot ref** ([`EmbedSnapshotRef`]; id-only).
//! 4. A list of **artifact refs** ([`EmbedArtifactRef`]; managed runtime
//!    URIs only).
//!
//! No live engine state, host paths, or asset bytes cross the boundary by
//! construction.
//!
//! The substrate satisfies three claims downstream consumers can
//! mechanically falsify:
//!
//! 1. **Capability declaration is the gate.** Hosts MUST call
//!    [`embed_capabilities`] before any read on [`EmbedState`]; mismatched
//!    reads surface as [`EmbedError::CapabilityNotSupported`].
//! 2. **Redacted by construction.** Every field crossing the ABI passes
//!    `crate::redaction::reject_unredacted_local_paths` on serialize.
//!    Asset references use [`crate::AssetId`] and artifact references use
//!    `validate_runtime_artifact_uri`.
//! 3. **Engine-neutral.** The ABI carries no engine-specific tags. Types
//!    compose existing engine-neutral substrate (sink [`crate::TextLine`],
//!    [`crate::ObservationArtifactRef`], [`crate::SnapshotRef`], evidence
//!    tiers, runtime capability classes).
//!
//! ## ABI surface
//!
//! - [`embed_capabilities`] — Capability discovery. Called by the host
//!   BEFORE any `embed_state` call.
//! - [`embed_state`] — Returns the current envelope as JSON.
//! - [`EmbedState::from_json_value`] — Host-side parse (Rust test fixtures
//!   and consumers re-validating input).
//!
//! ## What is NOT in this slice
//!
//! - No `wasm-bindgen` glue. The substrate is JSON; a follow-up slice wraps
//!   it as exported WASM functions.
//! - No engine-port embed. The fixture embed is the only embed in this
//!   slice.
//! - No payload resolution at the embed boundary;
//!   [`EmbedSnapshotRef`] is id-only.
//! - No replay-log streaming verb; the trace surface is a snapshot of
//!   emitted text lines.

pub mod artifact;
pub mod capability;
pub mod diagnostics;
pub mod redaction;
pub mod state;

pub use artifact::EmbedArtifactRef;
pub use capability::{
    EMBED_MAX_CAPABILITIES, EmbedCapability, EmbedCapabilityId, EmbedCapabilityStatus,
    embed_capabilities, sort_capabilities, validate_capability_list,
};
pub use diagnostics::EmbedError;
pub use state::{
    EMBED_MAX_ARTIFACT_REFS, EMBED_SCHEMA_VERSION, EMBED_SNAPSHOT_CONTENT_HASH_HEX_LEN,
    EMBED_STATE_MAX_SERIALIZED_BYTES, EMBED_TRACE_MAX_LINES, EmbedSchemaVersion, EmbedSnapshotRef,
    EmbedState, EmbedTrace, EmbedTraceLine, embed_state,
};
