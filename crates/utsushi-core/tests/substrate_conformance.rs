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

// §7.1 case 1: VFS — mount a fixture package via the facade only.

/// Tiny in-memory `AssetPackage` implementation built using only facade
/// types. Stands in for `PlaintextDirPackage` (which is intentionally
/// excluded from the facade per `.plan/.md` §3.2).
struct InMemoryFixturePackage {
    id: String,
    source: PackageSource,
    revision: Option<String>,
    case_rule: CaseRule,
    asset_path: String,
    bytes: Vec<u8>,
}

impl InMemoryFixturePackage {
    fn new(id: &str, asset_path: &str, bytes: &'static [u8]) -> Self {
        Self {
            id: id.to_string(),
            source: PackageSource::PublicName(format!("public-fixture:{id}")),
            revision: Some("rev-0".to_string()),
            case_rule: CaseRule::Sensitive,
            asset_path: asset_path.to_string(),
            bytes: bytes.to_vec(),
        }
    }
}

impl AssetPackage for InMemoryFixturePackage {
    fn id(&self) -> &str {
        &self.id
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: self.id.clone(),
            kind: PackageKind::Plaintext,
            case_rule: self.case_rule,
            source: self.source.clone(),
            revision: self.revision.clone(),
        }
    }

    fn case_rule(&self) -> CaseRule {
        self.case_rule
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        AssetId::from_parts(&self.id, logical)
    }

    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        Ok(id.path() == self.asset_path)
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        if id.path() == self.asset_path {
            Ok(AssetMetadata {
                id: id.clone(),
                kind: AssetKind::File,
                size: AssetSize::Bytes(self.bytes.len() as u64),
                revision: self.revision.clone(),
            })
        } else {
            Err(VfsError::AssetMissing { id: id.clone() })
        }
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        if id.path() == self.asset_path {
            Ok(AssetBytes::from(self.bytes.clone()))
        } else {
            Err(VfsError::AssetMissing { id: id.clone() })
        }
    }

    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}

/// Trivial `RuntimeVfs` wrapper that holds a single `AssetPackage`. The
/// facade exposes the trait but not `MountedVfs`; downstream consumers
/// implement the trait themselves when they need richer composition.
struct SinglePackageVfs(Arc<dyn AssetPackage>);

impl RuntimeVfs for SinglePackageVfs {
    fn packages(&self) -> Vec<PackageDescriptor> {
        vec![self.0.descriptor()]
    }

    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        self.0.exists(id)
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        self.0.stat(id)
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        self.0.open(id)
    }

    fn list(&self, prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        self.0.list(prefix)
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        self.0.resolve(logical)
    }
}

#[test]
fn mount_a_fixture_vfs_through_the_facade() {
    let package: Arc<dyn AssetPackage> = Arc::new(InMemoryFixturePackage::new(
        "fixture",
        "hello.txt",
        b"hello",
    ));
    let vfs = SinglePackageVfs(package);

    let descriptors = vfs.packages();
    assert_eq!(descriptors.len(), 1);
    assert_eq!(descriptors[0].id, "fixture");
    assert_eq!(descriptors[0].kind, PackageKind::Plaintext);

    let id = vfs.resolve("hello.txt").expect("resolve");
    assert!(vfs.exists(&id).expect("exists"));
    let metadata = vfs.stat(&id).expect("stat");
    assert_eq!(metadata.kind, AssetKind::File);
    assert!(matches!(metadata.size, AssetSize::Bytes(5)));
    let bytes = vfs.open(&id).expect("open");
    assert_eq!(bytes.as_slice(), b"hello");
}

// §7.1 case 2: drive a logical clock + replay log through the facade.

fn build_replay_log() -> ReplayLog {
    let mut builder = ReplayLogBuilder::new().metadata(ReplayMetadata::new(
        "substrate-facade-fixture",
        "fixture",
        "0.0.0",
        ClockOrigin::RunStart,
        0,
        Some("public-fixture:substrate-facade".to_string()),
    ));
    builder
        .record(LogicalClockTick(1), InputEvent::text())
        .expect("record text 1");
    builder
        .record(LogicalClockTick(2), InputEvent::advance())
        .expect("record advance 2");
    builder
        .record(LogicalClockTick(3), InputEvent::choice(0))
        .expect("record choice 3");
    builder.build().expect("build replay log")
}

#[test]
fn drive_a_logical_clock_and_replay_log_through_the_facade() {
    let log = build_replay_log();
    let bytes_a = serde_json::to_vec(&log).expect("serialize replay log");
    let bytes_b = serde_json::to_vec(&log).expect("serialize replay log");
    assert_eq!(
        bytes_a, bytes_b,
        "replay-log serialization is byte-stable across calls"
    );
    // Schema version is pinned through the facade.
    assert_eq!(log.schema_version().as_str(), REPLAY_LOG_SCHEMA_VERSION);
}

// §7.1 case 3: sinks — accept one text/audio/frame event each.

struct CollectingTextSink {
    capability: SinkCapability,
    lines: Mutex<Vec<TextLine>>,
}

impl TextSurfaceSink for CollectingTextSink {
    fn capability(&self) -> SinkCapability {
        self.capability
    }
    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        self.lines.lock().expect("lock").push(line);
        Ok(())
    }
}

struct CollectingAudioSink {
    capability: SinkCapability,
    events: Mutex<Vec<AudioEvent>>,
}

impl AudioEventSink for CollectingAudioSink {
    fn capability(&self) -> SinkCapability {
        self.capability
    }
    fn emit_event(&self, event: AudioEvent) -> SinkResult<()> {
        event.validate()?;
        self.events.lock().expect("lock").push(event);
        Ok(())
    }
}

struct CollectingFrameSink {
    capability: SinkCapability,
    artifacts: Mutex<Vec<FrameArtifact>>,
}

impl FrameArtifactSink for CollectingFrameSink {
    fn capability(&self) -> SinkCapability {
        self.capability
    }
    fn emit_frame(&self, artifact: FrameArtifact) -> SinkResult<()> {
        artifact.validate()?;
        self.artifacts.lock().expect("lock").push(artifact);
        Ok(())
    }
}

#[test]
fn emit_text_audio_frame_sink_events_through_the_facade() {
    let text_sink = Arc::new(CollectingTextSink {
        capability: SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        },
        lines: Mutex::new(Vec::new()),
    });
    let audio_sink = Arc::new(CollectingAudioSink {
        capability: SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        },
        events: Mutex::new(Vec::new()),
    });
    let frame_sink = Arc::new(CollectingFrameSink {
        capability: SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E2,
        },
        artifacts: Mutex::new(Vec::new()),
    });
    let set = SinkSet::new()
        .with_text(text_sink.clone())
        .with_audio(audio_sink.clone())
        .with_frame(frame_sink.clone());
    let summary = set.capabilities();
    assert!(matches!(summary.text, SinkCapability::Supported { .. }));
    assert!(matches!(summary.audio, SinkCapability::Supported { .. }));
    assert!(matches!(summary.frame, SinkCapability::Supported { .. }));

    let line = TextLine {
        line_id: "line-001".to_string(),
        evidence_tier: EvidenceTier::E1,
        text: "Hello facade".to_string(),
        speaker: None,
        color: None,
        text_surface: Some("ADV".to_string()),
        bridge_ref: None,
        source_asset: None,
        byte_offset_in_scene: None,
        body_shift_jis: None,
    };
    text_sink.emit_line(line.clone()).expect("emit text");
    let audio_event = AudioEvent {
        event_id: "audio-001".to_string(),
        evidence_tier: EvidenceTier::E0,
        event_kind: AudioEventKind::BgmStart,
        cue_id: Some("cue-bgm".to_string()),
        source_asset: None,
        bridge_ref: None,
        frame_index: None,
    };
    audio_sink.emit_event(audio_event).expect("emit audio");
    let artifact = FrameArtifact {
        frame_id: "frame-001".to_string(),
        evidence_tier: EvidenceTier::E2,
        artifact_ref: ObservationArtifactRef {
            artifact_id: "frame-001".to_string(),
            artifact_kind: "screenshot".to_string(),
            uri: "artifacts/utsushi/runtime/substrate-run-1/screenshots/frame-001.png".to_string(),
            media_type: Some("image/png".to_string()),
        },
        width: Some(320),
        height: Some(240),
        frame_index: 0,
        bridge_ref: None,
    };
    frame_sink.emit_frame(artifact).expect("emit frame");

    // Redaction sweep through the facade-exposed helper.
    let json_payload = json!({
        "line": {
            "text": line.text,
            "lineId": line.line_id,
        }
    });
    reject_unredacted_local_paths("emitted", &json_payload).expect("no redaction violation");
}

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
    let src = include_str!("substrate_conformance.rs");
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
