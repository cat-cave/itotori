#[test]
fn runtime_commands_dispatch_through_supplied_registry() {
    let root = temp_dir("dispatch");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let calls = Rc::new(RefCell::new(Vec::new()));
    let adapter = RecordingRuntimeAdapter::new(Rc::clone(&calls));
    let registry = registry_with(&adapter);
    let output = root.join("capture.json");

    run_cli_with_registry(
        &[
            "capture".to_string(),
            game_dir.display().to_string(),
            "--adapter".to_string(),
            TEST_ADAPTER_NAME.to_string(),
            "--output".to_string(),
            output.display().to_string(),
        ],
        &registry,
    )
    .unwrap();

    let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_eq!(report["adapterName"], TEST_ADAPTER_NAME);
    assert_eq!(report["operation"], "capture");
    assert_eq!(
        report["inputRoot"],
        game_dir.as_path().display().to_string()
    );
    assert!(report["artifactRoot"].is_null());
    assert_eq!(&*calls.borrow(), &["capture"]);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn runtime_commands_default_to_single_registered_adapter() {
    let root = temp_dir("single-adapter");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let calls = Rc::new(RefCell::new(Vec::new()));
    let adapter = RecordingRuntimeAdapter::new(Rc::clone(&calls));
    let registry = registry_with(&adapter);
    let output = root.join("smoke.json");

    run_cli_with_registry(
        &args(&[
            Path::new("smoke"),
            game_dir.as_path(),
            Path::new("--output"),
            output.as_path(),
        ]),
        &registry,
    )
    .unwrap();

    let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_eq!(report["adapterName"], TEST_ADAPTER_NAME);
    assert_eq!(report["operation"], "smoke");
    assert_eq!(&*calls.borrow(), &["smoke"]);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn smoke_command_defaults_to_fixture_adapter_from_cli_runtime_registry() {
    let root = temp_dir("fixture-smoke-output");
    let game_dir = root.join("game");
    write_fixture_source(&game_dir);
    let output = root.join("smoke.json");
    let registry = runtime_registry();

    run_cli_with_registry(
        &args(&[
            Path::new("smoke"),
            game_dir.as_path(),
            Path::new("--output"),
            output.as_path(),
        ]),
        &registry,
    )
    .unwrap();

    let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_eq!(report["adapterName"], FixtureEnginePort::MANIFEST.id);
    assert_eq!(report["operation"], "smoke_validation");
    let observations = report["sinkObservations"].as_array().unwrap();
    assert_eq!(observations.len(), 2);
    assert_eq!(observations[0]["sink"], "text_surface");
    assert_eq!(observations[1]["sink"], "frame_artifact");
    assert_eq!(report["captures"].as_array().unwrap().len(), 1);
    let default_artifact_root = output.with_extension("artifacts");
    let artifact_uri = report["captures"][0]["artifactUri"].as_str().unwrap();
    let artifact_path = utsushi_core::RuntimeArtifactRoot::new(&default_artifact_root)
        .artifact_path(artifact_uri)
        .unwrap();
    assert!(artifact_path.is_file());
    assert!(output.is_file());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn runtime_commands_reject_unknown_adapter_from_cli_runtime_registry() {
    let root = temp_dir("unknown-adapter");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let output = root.join("trace.json");
    let registry = runtime_registry();

    let error = run_cli_with_registry(
        &args(&[
            Path::new("trace"),
            game_dir.as_path(),
            Path::new("--adapter"),
            Path::new("missing-runtime"),
            Path::new("--output"),
            output.as_path(),
        ]),
        &registry,
    )
    .unwrap_err()
    .to_string();

    assert!(error.contains("runtime adapter not registered: missing-runtime"));
    assert!(!output.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn runtime_commands_pass_optional_artifact_root_to_adapter() {
    let root = temp_dir("artifact-root");
    let game_dir = root.join("game");
    let artifact_root = root.join("runtime-artifacts");
    fs::create_dir_all(&game_dir).unwrap();
    let calls = Rc::new(RefCell::new(Vec::new()));
    let adapter = RecordingRuntimeAdapter::new(Rc::clone(&calls));
    let registry = registry_with(&adapter);
    let output = root.join("capture.json");

    run_cli_with_registry(
        &args(&[
            Path::new("capture"),
            game_dir.as_path(),
            Path::new("--adapter"),
            Path::new(TEST_ADAPTER_NAME),
            Path::new("--artifact-root"),
            artifact_root.as_path(),
            Path::new("--output"),
            output.as_path(),
        ]),
        &registry,
    )
    .unwrap();

    let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_eq!(
        report["artifactRoot"],
        artifact_root.as_path().display().to_string()
    );
    assert_eq!(&*calls.borrow(), &["capture"]);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn validate_reference_captures_command_writes_validation_report() {
    let root = temp_dir("reference-capture-validation");
    let output = root.join("validation-report.json");
    let corpus_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/public/utsushi-reference-captures/reference-capture-corpus.json");
    let registry = empty_registry();

    run_cli_with_registry(
        &args(&[
            Path::new("validate-reference-captures"),
            corpus_path.as_path(),
            Path::new("--output"),
            output.as_path(),
        ]),
        &registry,
    )
    .unwrap();

    let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_eq!(report["schemaVersion"], "0.1.0");
    assert_eq!(report["fixturesValidated"], 1);
    assert_eq!(report["artifactsValidated"], 1);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn coverage_export_command_writes_json_and_markdown() {
    let root = temp_dir("coverage-export");
    let read_model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
        "../utsushi-core/tests/fixtures/conformance/branch_coverage/coverage_status.json",
    );
    let json_output = root.join("export.json");
    let markdown_output = root.join("export.md");
    let registry = empty_registry();

    run_cli_with_registry(
        &args(&[
            Path::new("coverage-export"),
            Path::new("--read-model"),
            read_model.as_path(),
            Path::new("--generated-at"),
            Path::new("2026-07-05T00:00:00Z"),
            Path::new("--output"),
            json_output.as_path(),
            Path::new("--markdown-output"),
            markdown_output.as_path(),
            Path::new("--include-gap-findings"),
        ]),
        &registry,
    )
    .unwrap();

    let export: Value =
        serde_json::from_str(&fs::read_to_string(&json_output).unwrap()).unwrap();
    assert_eq!(
        export["schemaVersion"],
        "utsushi.branch_coverage_export.v0.1"
    );
    // Generated-at is the INJECTED value, not a clock read.
    assert_eq!(export["generatedAt"], "2026-07-05T00:00:00Z");
    assert_eq!(export["adapterId"], "utsushi-synthetic");
    // Read model rides through with branch/route/trace/status fields.
    assert_eq!(export["readModel"]["records"].as_array().unwrap().len(), 4);
    assert_eq!(export["readModel"]["summary"]["visited"], 1);
    // Gap counts always present; findings included on opt-in.
    assert_eq!(export["gaps"]["summary"]["gapCount"], 2);
    assert_eq!(export["gaps"]["findings"].as_array().unwrap().len(), 2);

    let markdown = fs::read_to_string(&markdown_output).unwrap();
    assert!(markdown.contains("# Branch Coverage Export"));
    assert!(markdown.contains("2026-07-05T00:00:00Z"));
    assert!(markdown.contains("## Gap Findings"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn coverage_export_command_rejects_malformed_generated_at() {
    let root = temp_dir("coverage-export-bad-generated-at");
    let read_model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
        "../utsushi-core/tests/fixtures/conformance/branch_coverage/coverage_status.json",
    );
    let json_output = root.join("export.json");
    let registry = empty_registry();

    let error = run_cli_with_registry(
        &args(&[
            Path::new("coverage-export"),
            Path::new("--read-model"),
            read_model.as_path(),
            Path::new("--generated-at"),
            Path::new(""),
            Path::new("--output"),
            json_output.as_path(),
        ]),
        &registry,
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("generated-at"));
    assert!(!json_output.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn validate_reference_captures_rejects_unknown_and_trailing_args() {
    let corpus_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/public/utsushi-reference-captures/reference-capture-corpus.json");
    let output = PathBuf::from("validation-report.json");
    let registry = empty_registry();

    let unknown = run_cli_with_registry(
        &args(&[
            Path::new("validate-reference-captures"),
            corpus_path.as_path(),
            Path::new("--bogus"),
            output.as_path(),
            Path::new("--output"),
            output.as_path(),
        ]),
        &registry,
    )
    .unwrap_err()
    .to_string();
    assert!(unknown.contains("unknown flag --bogus"));

    let trailing = run_cli_with_registry(
        &args(&[
            Path::new("validate-reference-captures"),
            corpus_path.as_path(),
            Path::new("extra"),
            Path::new("--output"),
            output.as_path(),
        ]),
        &registry,
    )
    .unwrap_err()
    .to_string();
    assert!(trailing.contains("unexpected argument extra"));
}
