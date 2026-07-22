use super::*;

// These cases exercise the public substrate facade through the parent imports.

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
