#[test]
fn helper_run_fixture_stub_writes_helper_result() {
    let root = temp_dir("helper-run-fixture-stub");
    let output = root.join("helper-result.json");

    run_with_args(vec![
        "helper".to_string(),
        "run".to_string(),
        "--profile".to_string(),
        "fixture".to_string(),
        "--out".to_string(),
        output.to_str().unwrap().to_string(),
    ])
    .unwrap();

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["schemaVersion"], "0.1.0");
    assert_eq!(report["diagnostic"]["code"], "success");
    assert_eq!(report["redaction"]["status"], "redacted");
    assert!(report.get("stdout").is_none());
    assert!(report.get("stderr").is_none());
    assert!(validate_helper_result_value(&report).failures.is_empty());
}

#[test]
fn compat_evidence_fixture_writes_integrated_report() {
    // The `--fixture` mode integrates the committed synthetic sources into
    // one suite-readable report, listing all three sources per claimed
    // support, and writes the REDACTED artifact.
    let root = temp_dir("compat-evidence-fixture");
    let output = root.join("compat-evidence.json");

    run_with_args(vec![
        "compat-evidence".to_string(),
        "--fixture".to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ])
    .unwrap();

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["schemaVersion"], "0.1.0");
    assert_eq!(report["status"], "passed");
    assert_eq!(report["bundleSelfSufficient"], true);
    let supports = report["supports"].as_array().expect("supports array");
    assert_eq!(supports.len(), 2);
    // Each claimed support lists every acceptance field from all three
    // sources.
    for support in supports {
        for field in [
            "engineFamily",
            "engineVariant",
            "container",
            "crypto",
            "codec",
            "surface",
            "patchBackMode",
            "profileOrFixtureId",
            "secretRequirementIds",
            "diagnostics",
            "reproBundleIndex",
            "latestRegression",
        ] {
            assert!(
                support.get(field).is_some(),
                "claimed support must list {field}: {support}"
            );
        }
        // index + verdict are wired.
        assert!(support["reproBundleIndex"]["fixtureId"].is_string());
        assert_eq!(support["latestRegression"]["status"], "passed");
    }
    // Redaction-clean: ref-only, no raw material.
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(serialized.contains("sha256:"));
    assert!(!serialized.contains("BEGIN"));
    assert!(!serialized.contains("/home/"));
}

#[test]
fn asset_ocr_public_fixture_matches_committed_golden() {
    // the public fixture command emits schema-valid text regions
    // with provenance + stable content hashes; the output is byte-pinned to a
    // committed golden. Set ASSET_OCR_GOLDEN_REGEN=1 to rewrite the golden.
    let root = temp_dir("asset-ocr-public-fixture");
    let output = root.join("title-card.text-regions.json");
    let asset = public_fixture_path("fixtures/public/ocr-ui/title-card.png");
    let golden = public_fixture_path("fixtures/public/ocr-ui/title-card.text-regions.golden.json");

    run_with_args(vec![
        "asset-ocr".to_string(),
        asset.to_str().unwrap().to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ])
    .unwrap();

    let produced = fs::read_to_string(&output).unwrap();
    if std::env::var_os("ASSET_OCR_GOLDEN_REGEN").is_some() {
        fs::write(&golden, &produced).unwrap();
    }
    let committed = fs::read_to_string(&golden).unwrap();
    assert_eq!(
        produced, committed,
        "asset-ocr output drifted from the committed golden; regen with ASSET_OCR_GOLDEN_REGEN=1"
    );

    let report: serde_json::Value = serde_json::from_str(&produced).unwrap();
    assert!(
        report["sourceNodeId"]
            .as_str()
            .is_some_and(|source_node_id| !source_node_id.is_empty()),
        "asset-ocr report must carry a non-empty sourceNodeId"
    );
    // Three confident regions recover exact text; two uncertain regions are
    // findings (NOT asserted as recovered text).
    let regions = report["textRegions"].as_array().unwrap();
    assert_eq!(regions.len(), 5);
    let recovered: Vec<&str> = regions
        .iter()
        .filter_map(|region| region["recognition"]["recoveredText"].as_str())
        .collect();
    assert_eq!(recovered, ["NEW", "GAME", "LOAD"]);
    let findings = report["findings"].as_array().unwrap();
    assert_eq!(findings.len(), 2);
    // The uncertain "LOAD" read is a candidate on a finding, never truth.
    let uncertain = findings
        .iter()
        .find(|finding| finding["code"] == "uncertain_text_region")
        .unwrap();
    assert_eq!(uncertain["source"]["candidateText"], "LOAD");
    assert!(uncertain["source"]["provenance"].is_object());
    // Provenance + content hashes present.
    assert!(
        report["asset"]["contentHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    for region in regions {
        assert!(
            region["contentHash"]
                .as_str()
                .unwrap()
                .starts_with("sha256:")
        );
        assert!(
            region["provenance"]["assetContentHash"]
                .as_str()
                .unwrap()
                .starts_with("sha256:")
        );
    }
    // No local path leakage.
    assert!(!produced.contains("/home/"));
    assert!(!produced.contains("/scratch/"));
}

#[test]
fn reallive_patch_read_write_and_source_mutation_diagnostics_keep_operator_paths() {
    let source_seen = PathBuf::from("/home/dev/private-game/REALLIVEDATA/Seen.txt");
    let target_seen = PathBuf::from("/home/dev/private-target/REALLIVEDATA/Seen.txt");
    let read_error = reallive_patch_read_source_error(
        &source_seen,
        &io::Error::new(io::ErrorKind::PermissionDenied, "denied"),
    );
    let write_error = reallive_patch_write_target_error(
        &target_seen,
        &io::Error::new(io::ErrorKind::PermissionDenied, "denied"),
    );
    let source_mutated_error =
        reallive_patch_source_mutated_error(&source_seen, "before-hash", "after-hash");

    for rendered in [read_error, write_error, source_mutated_error] {
        assert!(
            rendered.contains("/home/dev/private"),
            "diagnostic should retain the operator path: {rendered}"
        );
        assert!(
            !rendered.contains("[REDACTED:kaifuu.secret_redacted]"),
            "diagnostic should not blanket-redact a path: {rendered}"
        );
        assert!(
            rendered.contains("Seen.txt"),
            "diagnostic should preserve the public Seen.txt context: {rendered}"
        );
    }
}

#[test]
fn helper_run_rejects_arbitrary_command_flags() {
    let root = temp_dir("helper-run-command-rejected");
    let output = root.join("helper-result.json");

    let result = run_with_args(vec![
        "helper".to_string(),
        "run".to_string(),
        "--profile".to_string(),
        "fixture".to_string(),
        "--out".to_string(),
        output.to_str().unwrap().to_string(),
        "--command".to_string(),
        "sh -c helper".to_string(),
    ]);

    let err = result.expect_err("arbitrary command flag must be rejected");
    assert!(err.to_string().contains("rejects arbitrary execution"));
    assert!(!output.exists());
}

#[test]
fn helper_run_local_mode_is_unsupported_and_never_launches_a_process() {
    // Regression guard for the deleted external helper-process launch path.
    // `helper run` is in-process fixture/stub only; requesting any non-stub
    // execution mode must fail with a structured error and never spawn.
    let root = temp_dir("helper-run-local-removed");
    let output = root.join("helper-result.json");

    let result = run_with_args(vec![
        "helper".to_string(),
        "run".to_string(),
        "--mode".to_string(),
        "local".to_string(),
        "--out".to_string(),
        output.to_str().unwrap().to_string(),
        "--helper-binary".to_string(),
        "/bin/true".to_string(),
    ]);

    let err = result.expect_err("local helper-process launch must be unsupported");
    assert!(
        err.to_string()
            .contains("external helper-process launch is not supported"),
        "unexpected error: {err}"
    );
    assert!(!output.exists());
}

#[test]
fn key_helper_run_process_subcommand_is_removed() {
    // Regression guard: the `kaifuu key-helper run-process` external-spawn
    // subcommand has been deleted. Invoking it must fall through to usage,
    // proving no compiled path reaches an external process launch.
    let root = temp_dir("key-helper-run-process-removed");
    let output = root.join("report.json");

    let result = run_with_args(vec![
        "key-helper".to_string(),
        "run-process".to_string(),
        "--helper-binary".to_string(),
        "/bin/true".to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    let err = result.expect_err("run-process subcommand must be removed");
    assert!(
        err.to_string()
            .contains("usage: kaifuu key-helper validate"),
        "unexpected error: {err}"
    );
    assert!(!output.exists());
}
