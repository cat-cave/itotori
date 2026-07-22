use super::*;
pub(super) fn evidence_report_observation_event_rejects_tier_above_report_ceiling() {
    // Spot-check that the JSON-shape observationHookEvents validator
    // (rewritten in to drop its `deleted-hook-envelope`
    // dependency) still rejects an entry whose tier exceeds the
    // report's declared evidenceTier.
    let report = json!({
        "schemaVersion": "0.2.0",
        "runtimeReportId": "0190a000-0000-7000-8000-000000000001",
        "adapterName": "utsushi-test",
        "adapterVersion": "0.0.0-test",
        "fidelityTier": "layout_probe",
        "evidenceTier": "E1",
        "status": "passed",
        "createdAt": "2026-06-17T00:00:00.000Z",
        "traceEvents": [],
        "branchEvents": [],
        "observationHookEvents": [
            {"evidenceTier": "E3"}
        ],
        "captures": [],
        "recordings": [],
        "approximations": [],
        "validationFindings": [],
        "limitations": [],
    });
    let error = validate_runtime_evidence_report_value(&report)
        .expect_err("E3 entry under E1 report must reject");
    let rendered = error.to_string();
    assert!(
        rendered.contains("evidenceTier must not exceed"),
        "rendered={rendered}"
    );
}

/// The Utsushi observation-hook timestamp validator shares the exact
/// accept/reject boundary and semantic rejection code used by the Kaifuu
/// Rust and localization-bridge-schema TypeScript validators.
pub(super) fn rfc3339_instant_parity_matrix_matches_observation_hook_validator() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MatrixRow {
        id: String,
        value: Value,
        expected: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityMatrix {
        semantic_code: String,
        rows: Vec<MatrixRow>,
    }

    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("packages/localization-bridge-schema/test/rfc3339-instant-parity-matrix.v0.2.json");
    let matrix: ParityMatrix = serde_json::from_str(
        &fs::read_to_string(&fixture_path).expect("parity matrix fixture should be readable"),
    )
    .expect("parity matrix fixture should be valid JSON");

    assert_eq!(
        matrix.semantic_code, SEMANTIC_RFC3339_INSTANT_MALFORMED,
        "matrix must pin the shared cross-validator semantic code",
    );
    assert!(
        matrix.rows.iter().any(|row| row.expected == "accept")
            && matrix.rows.iter().any(|row| row.expected == "reject"),
        "matrix must cover both accept and reject",
    );

    for row in &matrix.rows {
        let value = row
            .value
            .as_str()
            .unwrap_or_else(|| panic!("row {} value must be a JSON string", row.id));
        let result = validate_rfc3339_instant_metadata("matrix", value);
        match row.expected.as_str() {
            "accept" => assert!(
                result.is_ok(),
                "row {} ({value:?}) should be ACCEPTED, got {result:?}",
                row.id,
            ),
            "reject" => {
                let error =
                    result.expect_err(&format!("row {} ({value:?}) should be REJECTED", row.id));
                let semantic_error = error
                    .downcast_ref::<ObservationHookValidationError>()
                    .unwrap_or_else(|| {
                        panic!(
                            "row {} rejection should be ObservationHookValidationError, got {error:?}",
                            row.id
                        )
                    });
                assert_eq!(
                    semantic_error.code(),
                    SEMANTIC_RFC3339_INSTANT_MALFORMED,
                    "row {} rejection must carry the shared semantic code",
                    row.id,
                );
                assert_eq!(semantic_error.field(), "matrix");
            }
            other => panic!("row {} has unknown expected value {other}", row.id),
        }
    }
}

pub(super) const HARNESS_STDOUT_SENTINEL: &str = "UTSUSHI-STDOUT-CAPTURE-SENTINEL-6f3a2d";

pub(super) fn harness_child_exits() {}

pub(super) fn harness_child_prints_stdout_sentinel() {
    println!("{HARNESS_STDOUT_SENTINEL}");
}

pub(super) fn harness_child_sleeps() {
    std::thread::sleep(Duration::from_secs(5));
}

pub(super) fn harness_child_spawns_grandchild() {
    let heartbeat_path = PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT").unwrap());
    let pid_path = PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_PID").unwrap());
    let mut child = StdCommand::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tests::harness_grandchild_heartbeats",
            "--ignored",
            "--nocapture",
        ])
        .env("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT", &heartbeat_path)
        .env("UTSUSHI_TEST_GRANDCHILD_PID", &pid_path)
        .spawn()
        .unwrap();
    assert!(wait_for_path(&pid_path, Duration::from_secs(1)));
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            panic!("grandchild exited before harness cleanup");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub(super) fn harness_child_spawns_grandchild_then_fails() {
    let heartbeat_path = PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT").unwrap());
    let pid_path = PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_PID").unwrap());
    let _child = StdCommand::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tests::harness_grandchild_heartbeats",
            "--ignored",
            "--nocapture",
        ])
        .env("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT", &heartbeat_path)
        .env("UTSUSHI_TEST_GRANDCHILD_PID", &pid_path)
        .spawn()
        .unwrap();
    assert!(wait_for_path(&pid_path, Duration::from_secs(1)));
    assert!(wait_for_path(&heartbeat_path, Duration::from_secs(1)));
    std::process::exit(42);
}

pub(super) fn harness_grandchild_heartbeats() {
    let heartbeat_path = PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT").unwrap());
    let pid_path = PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_PID").unwrap());
    fs::write(&pid_path, std::process::id().to_string()).unwrap();
    let mut heartbeat = 0_u64;
    loop {
        fs::write(&heartbeat_path, heartbeat.to_string()).unwrap();
        heartbeat += 1;
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub(super) struct WritingCaptureHook {
    pub(super) boundary: RuntimeCaptureBoundary,
    pub(super) calls: Arc<AtomicUsize>,
}

impl WritingCaptureHook {
    pub(super) fn new(boundary: RuntimeCaptureBoundary, calls: Arc<AtomicUsize>) -> Self {
        Self { boundary, calls }
    }
}

impl RuntimeCaptureHook for WritingCaptureHook {
    fn boundary(&self) -> RuntimeCaptureBoundary {
        self.boundary
    }

    fn capture(&mut self, context: &mut RuntimeCaptureContext) -> Result<(), RuntimeHarnessError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(context.boundary, self.boundary);
        assert_eq!(context.run_id, HARNESS_RUN_ID);
        context.write_artifact(
            RuntimeArtifactKind::Screenshot,
            HARNESS_SCREENSHOT_ID,
            Some("image/png".to_string()),
            b"runtime screenshot bytes",
        )?;
        context.write_artifact(
            RuntimeArtifactKind::FrameCapture,
            HARNESS_FRAME_ID,
            Some("image/png".to_string()),
            b"runtime frame capture bytes",
        )?;
        Ok(())
    }
}

pub(super) struct ArtifactRequiredHook;

impl RuntimeCaptureHook for ArtifactRequiredHook {
    fn boundary(&self) -> RuntimeCaptureBoundary {
        RuntimeCaptureBoundary::AfterLaunch
    }

    fn capture(&mut self, context: &mut RuntimeCaptureContext) -> Result<(), RuntimeHarnessError> {
        context.write_artifact(
            RuntimeArtifactKind::Screenshot,
            HARNESS_SCREENSHOT_ID,
            Some("image/png".to_string()),
            b"requires an artifact root",
        )?;
        Ok(())
    }
}

pub(super) struct SleepingCaptureHook {
    pub(super) boundary: RuntimeCaptureBoundary,
    pub(super) started: Arc<AtomicBool>,
    pub(super) sleep: Duration,
}

impl RuntimeCaptureHook for SleepingCaptureHook {
    fn boundary(&self) -> RuntimeCaptureBoundary {
        self.boundary
    }

    fn capture(&mut self, _context: &mut RuntimeCaptureContext) -> Result<(), RuntimeHarnessError> {
        self.started.store(true, Ordering::SeqCst);
        std::thread::sleep(self.sleep);
        Ok(())
    }
}

// a hook that blocks past its timeout and, once released by the
// test (after `launch-capture` has already returned), attempts a managed
// artifact write from the detached worker thread. The outcome is recorded
// out-of-band so the test can assert the write was fenced.
pub(super) struct LateWritingCaptureHook {
    pub(super) boundary: RuntimeCaptureBoundary,
    pub(super) started: Arc<AtomicBool>,
    pub(super) proceed: mpsc::Receiver<()>,
    pub(super) late_write: Arc<Mutex<Option<Result<PathBuf, String>>>>,
}

impl RuntimeCaptureHook for LateWritingCaptureHook {
    fn boundary(&self) -> RuntimeCaptureBoundary {
        self.boundary
    }

    fn capture(&mut self, context: &mut RuntimeCaptureContext) -> Result<(), RuntimeHarnessError> {
        self.started.store(true, Ordering::SeqCst);
        // Block until the test releases us. By then the harness has timed
        // this hook out and `launch-capture` has returned, so this write is
        // strictly after the capture boundary.
        let _ = self.proceed.recv();
        let outcome = match context.write_artifact(
            RuntimeArtifactKind::Screenshot,
            HARNESS_SCREENSHOT_ID,
            Some("image/png".to_string()),
            b"post-boundary late write that must be refused",
        ) {
            Ok(artifact) => Ok(artifact.path),
            Err(error) => Err(error.code().to_string()),
        };
        *self.late_write.lock().unwrap() = Some(outcome);
        Ok(())
    }
}

pub(super) struct PanickingCaptureHook {
    pub(super) boundary: RuntimeCaptureBoundary,
}

impl RuntimeCaptureHook for PanickingCaptureHook {
    fn boundary(&self) -> RuntimeCaptureBoundary {
        self.boundary
    }

    fn capture(&mut self, _context: &mut RuntimeCaptureContext) -> Result<(), RuntimeHarnessError> {
        std::panic::resume_unwind(Box::new("intentional capture hook panic"))
    }
}

pub(super) struct FailingCaptureHook {
    pub(super) boundary: RuntimeCaptureBoundary,
}

impl RuntimeCaptureHook for FailingCaptureHook {
    fn boundary(&self) -> RuntimeCaptureBoundary {
        self.boundary
    }

    fn capture(&mut self, context: &mut RuntimeCaptureContext) -> Result<(), RuntimeHarnessError> {
        Err(RuntimeHarnessError::capture_failed(
            context.operation,
            "intentional after-exit hook failure",
        ))
    }
}

impl RuntimeAdapter for FakeTraceAdapter {
    fn descriptor(&self) -> RuntimeAdapterDescriptor {
        RuntimeAdapterDescriptor {
            name: "fake-trace".to_string(),
            version: "0.0.0-test".to_string(),
            fidelity_tier: FidelityTier::TraceOnly,
            evidence_tier_ceiling: EvidenceTier::E1,
            capability_contract: trace_contract(),
            capabilities: vec![RuntimeCapability::Trace],
            approximation_tiers: vec![ApproximationTier::DeterministicFixture],
            diagnostics: vec![],
            limitations: vec!["unit test adapter".to_string()],
        }
    }

    fn trace(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Ok(json!({
            "operation": "trace",
            "inputRoot": request.input_root.display().to_string()
        }))
    }
}

pub(super) struct OverclaimingAdapter;

impl RuntimeAdapter for OverclaimingAdapter {
    fn descriptor(&self) -> RuntimeAdapterDescriptor {
        RuntimeAdapterDescriptor {
            name: "overclaiming".to_string(),
            version: "0.0.0-test".to_string(),
            fidelity_tier: FidelityTier::LayoutProbe,
            evidence_tier_ceiling: EvidenceTier::E4,
            capability_contract: RuntimeCapabilityContract::new(
                RuntimeCapabilityClass::LaunchCapture,
                FidelityTier::LayoutProbe,
                EvidenceTier::E4,
                vec![RuntimeFeatureSupport::supported(
                    RuntimePlaybackFeature::FrameCapture,
                    EvidenceTier::E4,
                    "overclaims capture evidence",
                )],
                vec![],
            ),
            capabilities: vec![RuntimeCapability::Trace, RuntimeCapability::FrameCapture],
            approximation_tiers: vec![ApproximationTier::ReferenceMatched],
            diagnostics: vec![],
            limitations: vec![],
        }
    }

    fn trace(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Ok(json!({ "operation": "trace" }))
    }
}
