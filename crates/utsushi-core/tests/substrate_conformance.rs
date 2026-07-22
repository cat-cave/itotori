//! Substrate facade conformance test.
//!
//! Drives a fixture runtime end-to-end through the substrate facade
//! only. No subsystem submodule path is reachable from this test file;
//! the file-level lint at the bottom verifies the source contains
//! exactly that one allowed import path.
//!
//! Each `#[test]` exercises one substrate subsystem so a future
//! facade-narrowing churn fails one specific test rather than the
//! whole file. See `.plan/.md` §7.1 for the case list.

use std::sync::Arc;
use std::sync::Mutex;

use serde_json::json;

use utsushi_core::substrate::{
    // VFS
    AssetBytes,
    AssetId,
    AssetKind,
    AssetMetadata,
    AssetPackage,
    AssetSize,
    // Sinks
    AudioEvent,
    AudioEventKind,
    AudioEventSink,
    // Conformance
    CONFORMANCE_SCHEMA_VERSION,
    CaseRule,
    // Clock + input + replay
    ClockOrigin,
    ConformanceAbiVersion,
    ConformanceManifest,
    ConformanceProfile,
    // Evidence / fidelity tiers + observation payload types (re-exported through the facade)
    EvidenceTier,
    FidelityTier,
    FrameArtifact,
    FrameArtifactSink,
    GoldenTextEvent,
    // Snapshot
    InMemorySnapshotStore,
    InputEvent,
    Inspectable,
    // Port
    LifecycleStage,
    LogicalClockTick,
    OPTIONAL_LIFECYCLE_STAGES,
    ObservationArtifactRef,
    ObservedTextEvent,
    PackageDescriptor,
    PackageKind,
    PackageSource,
    PortCapability,
    PortManifest,
    ProfileId,
    REPLAY_LOG_SCHEMA_VERSION,
    REQUIRED_LIFECYCLE_STAGES,
    ReplayLog,
    ReplayLogBuilder,
    ReplayMetadata,
    Restorable,
    RestoreReport,
    RuntimeVfs,
    SNAPSHOT_SCHEMA_VERSION,
    SinkCapability,
    SinkResult,
    SinkSet,
    SnapshotError,
    SnapshotRef,
    SnapshotRequest,
    SnapshotStore,
    SourceTag,
    StatePath,
    StateTree,
    StateValue,
    TextLine,
    TextSurfaceSink,
    TraceCheckOptions,
    TraceCheckResult,
    TraceConformanceCheck,
    VfsError,
    VfsResult,
    // Redaction
    reject_unredacted_local_paths,
    take_snapshot,
};

#[path = "substrate_conformance/facade_cases.rs"]
mod facade_cases;

// §7.1 case 4: snapshot — take/store/restore through the facade.

struct FixturePort {
    frame: u32,
}

impl Inspectable for FixturePort {
    fn inspectable_id(&self) -> &'static str {
        "utsushi-fixture"
    }
    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse("port.frame").expect("path"),
            StateValue::Uint {
                value: self.frame as u64,
            },
        )?;
        Ok(tree)
    }
}

impl Restorable for FixturePort {
    fn restore_state(&mut self, state: &StateTree) -> Result<RestoreReport, SnapshotError> {
        let mut consumed = Vec::new();
        let path = StatePath::parse("port.frame").expect("path");
        if let Some(value) = state.get(&path) {
            match value {
                StateValue::Uint { value } => {
                    self.frame = *value as u32;
                    consumed.push(path);
                }
                _ => {
                    return Err(SnapshotError::RestoreTypeMismatch {
                        path,
                        expected: "uint",
                        found: "non-uint",
                    });
                }
            }
        }
        Ok(RestoreReport {
            consumed_paths: consumed,
            ignored_by_design: Vec::new(),
        })
    }
}

#[test]
fn take_and_restore_a_snapshot_through_the_facade() {
    let port = FixturePort { frame: 7 };
    let request = SnapshotRequest::new("run-substrate", "2026-06-23T00:00:00Z", EvidenceTier::E2)
        .with_tick(1);
    let snapshot = take_snapshot(&port, &request).expect("take snapshot");
    assert_eq!(snapshot.schema_version().as_str(), SNAPSHOT_SCHEMA_VERSION);

    let store = InMemorySnapshotStore::new();
    store
        .insert(snapshot.clone())
        .expect("insert into in-memory store");

    let reference = SnapshotRef {
        snapshot_id: snapshot.snapshot_id().clone(),
        inspectable_id: snapshot.inspectable_id().to_string(),
        evidence_tier: snapshot.evidence_tier(),
    };
    let resolved = store.resolve(&reference).expect("resolve");
    assert_eq!(resolved.snapshot_id(), snapshot.snapshot_id());
}

// §7.1 case 5: trace conformance check via the facade.

#[test]
fn run_a_trace_conformance_check_through_the_facade() {
    let manifest = ConformanceManifest {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: "utsushi-substrate-fixture".to_string(),
        abi_version: ConformanceAbiVersion(1),
        supported_profiles: vec![ConformanceProfile {
            id: ProfileId::TextTrace,
            required_subsystems: ProfileId::TextTrace.required_subsystems().to_vec(),
            evidence_tier_ceiling: EvidenceTier::E1,
        }],
        optional_extensions: Vec::new(),
    };
    manifest.validate().expect("manifest validates");

    let golden = vec![
        GoldenTextEvent {
            event_id: "g-001".to_string(),
            bridge_unit_id: "0190a000-0000-7000-8000-000000000001".to_string(),
            text: "Hello facade".to_string(),
            speaker: None,
            order_index: 0,
        },
        GoldenTextEvent {
            event_id: "g-002".to_string(),
            bridge_unit_id: "0190a000-0000-7000-8000-000000000002".to_string(),
            text: "Goodbye facade".to_string(),
            speaker: None,
            order_index: 1,
        },
    ];
    let observed = vec![
        ObservedTextEvent {
            event_id: "o-001".to_string(),
            bridge_unit_id: Some("0190a000-0000-7000-8000-000000000001".to_string()),
            text: "Hello facade".to_string(),
            speaker: None,
            order_index: 0,
        },
        ObservedTextEvent {
            event_id: "o-002".to_string(),
            bridge_unit_id: Some("0190a000-0000-7000-8000-000000000002".to_string()),
            text: "Goodbye facade".to_string(),
            speaker: None,
            order_index: 1,
        },
    ];
    let check = TraceConformanceCheck::new(
        "utsushi-substrate-fixture",
        golden,
        observed,
        TraceCheckOptions::default(),
    )
    .expect("build trace check");
    let result = check.run();
    assert!(
        matches!(result, TraceCheckResult::Pass { .. }),
        "expected Pass, got {result:?}"
    );
}

// §7.1 case 6: port manifest + lifecycle stages via the facade.

#[test]
fn instantiate_a_port_manifest_and_inspect_lifecycle_through_the_facade() {
    let manifest = PortManifest {
        id: "utsushi-substrate-fixture",
        name: "Substrate Facade Fixture",
        version: "0.0.0",
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[],
    };
    manifest.validate().expect("manifest validates");

    let required: Vec<LifecycleStage> = REQUIRED_LIFECYCLE_STAGES.to_vec();
    assert_eq!(required.len(), 4);
    assert!(required.contains(&LifecycleStage::Launch));
    assert!(required.contains(&LifecycleStage::Observe));
    assert!(required.contains(&LifecycleStage::Capture));
    assert!(required.contains(&LifecycleStage::Shutdown));

    let optional: Vec<LifecycleStage> = OPTIONAL_LIFECYCLE_STAGES.to_vec();
    assert_eq!(optional, vec![LifecycleStage::Jump]);
}

// §7.1 case 7: every facade-re-exported schema version is pinned.

#[test]
fn every_facade_exposed_schema_version_is_pinned() {
    assert_eq!(CONFORMANCE_SCHEMA_VERSION, "0.2.0-alpha");
    assert_eq!(SNAPSHOT_SCHEMA_VERSION, "0.2.0-alpha");
    assert_eq!(REPLAY_LOG_SCHEMA_VERSION, "0.1.0-alpha");
}

// §7.1 case 7b: the schema-authority doc's §3 version table must agree
// with the pinned constants. This is the drift-guard that keeps
// docs/utsushi-substrate-facade.md §3 honest — a bump to any pinned
// constant without revising the doc table trips this test (
// bumped SNAPSHOT_SCHEMA_VERSION to 0.2.0-alpha; the doc had stayed at
// 0.1.0-alpha until this guard was added).
#[test]
fn facade_documentation_schema_version_table_matches_pinned_constants() {
    let doc = include_str!("../../../docs/utsushi-substrate-facade.md");
    let pinned = [
        ("CONFORMANCE_SCHEMA_VERSION", CONFORMANCE_SCHEMA_VERSION),
        ("SNAPSHOT_SCHEMA_VERSION", SNAPSHOT_SCHEMA_VERSION),
        ("REPLAY_LOG_SCHEMA_VERSION", REPLAY_LOG_SCHEMA_VERSION),
    ];
    for (name, value) in pinned {
        // The §3 table row is: `| `NAME` | `value` | spec |`.
        let name_needle = format!("`{name}`");
        let row = doc
            .lines()
            .find(|line| line.contains(&name_needle))
            .unwrap_or_else(|| {
                panic!(
                    "schema-authority doc docs/utsushi-substrate-facade.md \
                     §3 has no row for {name}"
                )
            });
        let value_needle = format!("`{value}`");
        assert!(
            row.contains(&value_needle),
            "docs/utsushi-substrate-facade.md §3 row for {name} does not \
             list the pinned value {value:?}; the doc has drifted from the \
             substrate.rs const-assertion. Doc row: {row:?}",
        );
    }
}

// §7.1 case 8: SourceTag variant set is engine-neutral.

#[test]
fn source_tag_variant_set_is_engine_neutral() {
    let all = [
        SourceTag::Browser,
        SourceTag::Native,
        SourceTag::Wine,
        SourceTag::Fixture,
    ];
    for tag in all {
        // Exhaustive match — if a new variant is added without updating
        // the facade contract this match arm errors at compile time.
        let label: &str = match tag {
            SourceTag::Browser => "browser",
            SourceTag::Native => "native",
            SourceTag::Wine => "wine",
            SourceTag::Fixture => "fixture",
        };
        assert!(!label.is_empty());
    }
    assert_eq!(all.len(), 4);
}

// §7.3 Engine-neutrality lint — facade source contains no engine
// family names.

#[test]
fn facade_module_source_contains_no_engine_family_names() {
    let src = include_str!("../src/substrate.rs");
    let forbidden = [
        "RealLive",
        "real_live",
        "reallive",
        "RPGM",
        "RpgMaker",
        "rpg_maker",
        "rpgm",
        "Kirikiri",
        "kirikiri",
        "Xp3",
        "xp3",
        "Siglus",
        "siglus",
    ];
    for needle in forbidden {
        assert!(
            !src.contains(needle),
            "facade source contains engine-family name {needle:?}; the substrate facade must stay engine-neutral",
        );
    }
}

#[test]
fn facade_documentation_contains_no_engine_family_names() {
    let src = include_str!("../../../docs/utsushi-substrate-facade.md");
    let forbidden = [
        "RealLive",
        "real_live",
        "reallive",
        "RPGM",
        "RpgMaker",
        "rpg_maker",
        "rpgm",
        "Kirikiri",
        "kirikiri",
        "Xp3",
        "xp3",
        "Siglus",
        "siglus",
    ];
    for needle in forbidden {
        assert!(
            !src.contains(needle),
            "facade documentation contains engine-family name {needle:?}; the substrate facade docs must stay engine-neutral",
        );
    }
}

// File-level import discipline: this test file must reach the
// substrate only through the facade. The lint forbids any reach-around
// per-subsystem use statement; the conformance test's whole point is
// to prove the facade is sufficient.

#[test]
fn substrate_conformance_test_imports_only_through_the_facade() {
    let src = [
        include_str!("substrate_conformance.rs"),
        include_str!("substrate_conformance/facade_cases.rs"),
    ]
    .concat();
    // Build the forbidden patterns dynamically so the literal "use
    // utsushi_core::<module>" substrings never appear in this file's
    // bytes verbatim — otherwise the lint would trip on its own
    // assertion data.
    let modules = [
        "vfs",
        "clock",
        "input",
        "replay",
        "sink",
        "snapshot",
        "embed",
        "conformance",
        "port",
        "redaction",
    ];
    let crate_prefix = ["use ", "utsushi_core", "::"].concat();
    for module in modules {
        let needle = format!("{crate_prefix}{module}");
        assert!(
            !src.contains(&needle),
            "facade test reaches around the substrate via {needle:?}",
        );
    }
    // Affirmative: the file MUST contain at least one facade-rooted
    // import. The substring is assembled dynamically so it does not
    // self-trip.
    let facade_path = format!("{crate_prefix}substrate");
    assert!(
        src.contains(&facade_path),
        "facade test must import through the substrate facade",
    );
}
