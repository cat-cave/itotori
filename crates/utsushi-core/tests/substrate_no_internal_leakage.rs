//! UTSUSHI-120 — Substrate facade leakage gate.
//!
//! Defense-in-depth lint that asserts the curated facade surface is
//! exactly what the plan and the public docs claim it is. The headline
//! defense remains `substrate_conformance.rs` (which proves the facade
//! is sufficient end-to-end through the import-discipline lint); this
//! file's job is to make a future "accidental new `pub use`" diff loud
//! by comparing the substrate source against the documented exclusion
//! list and the documented inclusion list.
//!
//! See `.plan/UTSUSHI-120.md` §7.2 and `docs/utsushi-substrate-facade.md`
//! §5.

/// Symbols that MUST NOT appear inside `crates/utsushi-core/src/substrate.rs`
/// because they are engine-implementation helpers, conformance internals,
/// or crate-private validators that downstream port authors must not
/// reach through the substrate facade.
const EXCLUDED_SYMBOLS: &[&str] = &[
    // VFS implementation helpers (UTSUSHI-020).
    "AssetIdErrorReason",
    "AssetRef",
    "MountedVfs",
    "PlaintextDirPackage",
    "RequiredCapability",
    "IoSummary",
    "ResourceBoundKind",
    "TransformKind",
    // Trace-branch helper types only conformance crate internals need
    // (UTSUSHI-025/027). The facade exposes the check entry points
    // (`TraceConformanceCheck`, `BranchConformanceCheck`) plus the
    // adapter-emitted `ObservedTextEvent` / `ObservedBranch` and the
    // golden-side `GoldenTextEvent` types needed to construct a check.
    "BranchCheckOptions",
    "BranchMismatch",
    "BranchMismatchKind",
    "GoldenBranch",
    "TraceMismatch",
    "TraceMismatchKind",
    "ArtifactCountRange",
    "DurationRangeMs",
    "SubsystemRequirement",
    "CaptureFrameArtifactRef",
    "unsupported_frame_capture_result",
    "unsupported_recording_capture_result",
    "unsupported_snapshot_restore_result",
    // Crate-private validators.
    "reject_unredacted_local_paths_public",
    "looks_like_local_path_public",
    // Sink-payload-internal constants exposed through the accessor
    // functions, not as raw constants.
    "EMBED_MAX_ARTIFACT_REFS",
    "EMBED_MAX_CAPABILITIES",
    "EMBED_TRACE_MAX_LINES",
    "EMBED_STATE_MAX_SERIALIZED_BYTES",
    "EMBED_SNAPSHOT_CONTENT_HASH_HEX_LEN",
    // Snapshot-internal constants.
    "BYTES_HASH_HEX_LEN",
    "BYTES_SAMPLE_HEX_LEN",
    "MAX_STATE_PATH_BYTES",
    "MAX_STATE_PATH_SEGMENTS",
    "SNAPSHOT_EVIDENCE_TIER_CEILING",
    "BytesValue",
    // Replay-internal codes.
    "REPLAY_NON_MONOTONIC_TICK_CODE",
    "REPLAY_REDACTION_VIOLATION_CODE",
    "REPLAY_UNSUPPORTED_SCHEMA_VERSION_CODE",
    "INPUT_INVALID_PAYLOAD_CODE",
    "INPUT_UNSUPPORTED_KIND_CODE",
    "CLOCK_BACKTRACK_CODE",
];

#[test]
fn substrate_facade_source_does_not_reexport_excluded_symbols() {
    let src = include_str!("../src/substrate.rs");
    for symbol in EXCLUDED_SYMBOLS {
        let needle_with_comma = format!("{symbol},");
        let needle_with_brace = format!("{symbol}}}");
        let needle_with_whitespace = format!("{symbol} ");
        // We look for the symbol appearing in the `pub use` blocks. To
        // keep the lint focused on actual re-export lines and avoid
        // false positives in commentary, the symbol must appear in a
        // context that looks like a use-tree (trailing comma, closing
        // brace, or trailing whitespace inside a use-tree).
        assert!(
            !src.contains(&needle_with_comma)
                && !src.contains(&needle_with_brace)
                && !src.contains(&needle_with_whitespace),
            "substrate facade source re-exports excluded symbol {symbol:?}; \
             update either the §3.2 / §5 exclusion list in \
             `docs/utsushi-substrate-facade.md` or remove the re-export",
        );
    }
}

/// Symbols that MUST appear in the facade source as `pub use` re-exports.
/// Mirrors the §3.1 inclusion list. A facade-narrowing diff that drops
/// any of these by mistake fails this lint.
const REQUIRED_SYMBOLS: &[&str] = &[
    // VFS
    "AssetBytes",
    "AssetId",
    "AssetKind",
    "AssetMetadata",
    "AssetPackage",
    "CaseRule",
    "PackageDescriptor",
    "PackageKind",
    "RuntimeVfs",
    "TraversalKind",
    "VfsError",
    "VfsResult",
    // Clock + input + replay
    "ClockOrigin",
    "LogicalClock",
    "LogicalClockTick",
    "ChoiceIndex",
    "InputError",
    "InputEvent",
    "InputKind",
    "MenuTarget",
    "PointerButton",
    "RawInputCode",
    "REPLAY_LOG_SCHEMA_VERSION",
    "ReplayCursor",
    "ReplayEntry",
    "ReplayLog",
    "ReplayLogBuilder",
    "ReplayMetadata",
    "ReplaySchemaVersion",
    // Sinks
    "AudioEvent",
    "AudioEventKind",
    "AudioEventSink",
    "FrameArtifact",
    "FrameArtifactSink",
    "SinkCapability",
    "SinkCapabilitySummary",
    "SinkError",
    "SinkKind",
    "SinkResult",
    "SinkSet",
    "TextLine",
    "TextSurfaceSink",
    // Snapshot
    "InMemorySnapshotStore",
    "Inspectable",
    "Restorable",
    "RestoreReport",
    "SNAPSHOT_SCHEMA_VERSION",
    "Snapshot",
    "SnapshotError",
    "SnapshotId",
    "SnapshotRef",
    "SnapshotRequest",
    "SnapshotSchemaVersion",
    "SnapshotStore",
    "SnapshotStoreError",
    "StateChange",
    "StateChangeKind",
    "StateDiff",
    "StateNamespace",
    "StatePath",
    "StateTree",
    "StateValue",
    "diff_snapshots",
    "restore_snapshot",
    "take_snapshot",
    // Embed
    "EMBED_SCHEMA_VERSION",
    "EmbedArtifactRef",
    "EmbedCapability",
    "EmbedCapabilityId",
    "EmbedCapabilityStatus",
    "EmbedError",
    "EmbedSchemaVersion",
    "EmbedSnapshotRef",
    "EmbedState",
    "EmbedTrace",
    "EmbedTraceLine",
    "embed_capabilities",
    "embed_state",
    // Recorder
    "InMemoryReferenceRecorder",
    "REFERENCE_TRACE_SCHEMA_VERSION",
    "RecordingTextSink",
    "ReferenceRecorder",
    "ReferenceTrace",
    "SourceTag",
    "deterministic_json_bytes",
    // Conformance
    "CONFORMANCE_SCHEMA_VERSION",
    "ConformanceAbiVersion",
    "ConformanceError",
    "ConformanceManifest",
    "ConformanceProfile",
    "ConformanceResult",
    "EvidenceRef",
    "ProfileExtension",
    "ProfileId",
    "ResultOutcome",
    "cross_validate_conformance_manifest_against_port_manifest",
    "cross_validate_results_against_manifest",
    "BranchCheckResult",
    "BranchConformanceCheck",
    "GoldenTextEvent",
    "ObservedBranch",
    "ObservedTextEvent",
    "TextNormalisation",
    "TraceCheckOptions",
    "TraceCheckResult",
    "TraceConformanceCheck",
    // Port
    "EnginePort",
    "EnginePortAdapter",
    "EnginePortError",
    "LifecycleStage",
    "MomentId",
    "OPTIONAL_LIFECYCLE_STAGES",
    "PortCapability",
    "PortEnv",
    "PortManifest",
    "PortRequest",
    "PortShutdownOutcome",
    "PortShutdownStatus",
    "REQUIRED_LIFECYCLE_STAGES",
    "Runner",
    "RunnerCancellation",
    "RunnerObservation",
    "RunnerOutcome",
    // Tier + payload-shape root types
    "EvidenceTier",
    "FidelityTier",
    "ObservationArtifactRef",
    "ObservationBridgeRef",
    // Redaction
    "reject_unredacted_local_paths",
];

#[test]
fn substrate_facade_source_reexports_every_required_symbol() {
    let src = include_str!("../src/substrate.rs");
    for symbol in REQUIRED_SYMBOLS {
        assert!(
            src.contains(symbol),
            "substrate facade source is missing the required re-export {symbol:?}; \
             a future facade-narrowing diff has dropped a documented entry point",
        );
    }
}
