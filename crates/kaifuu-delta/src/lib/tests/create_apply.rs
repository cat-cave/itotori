use super::*;

#[test]
fn create_delta_emits_deterministic_v03_changed_file_package() {
    let root = temp_dir("create-v03");
    let (original, patched) = write_sample_dirs(&root);

    let first = create_delta(&original, &patched, SourceProvenance::complete()).unwrap();
    let second = create_delta(&original, &patched, SourceProvenance::complete()).unwrap();

    assert_eq!(first, second);
    assert_eq!(first["schemaVersion"], DELTA_SCHEMA_VERSION);
    assert_eq!(first["format"], DELTA_FORMAT);
    assert_eq!(first["metadata"]["hashAlgorithm"], "sha256");
    assert_eq!(first["metadata"]["ignoredArtifacts"], json!([]));
    assert_eq!(first["sourceProvenance"]["partial"], false);
    assert_eq!(first["sourceCompatibility"]["fileCount"], 4);
    assert_eq!(first["target"]["fileCount"], 4);
    assert!(
        first["sourceCompatibility"]["rootHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    let entries = first["changedEntries"].as_array().unwrap();
    let paths = entries
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        paths,
        vec![
            "bin/raw.dat",
            "data/add.txt",
            "data/delete.txt",
            "source.json"
        ]
    );
    assert_eq!(entries[0]["contentEncoding"], "hex");
    assert_eq!(entries[2]["operation"], "delete");
    assert_eq!(entries[3]["contentEncoding"], "utf8");
    assert!(!paths.contains(&ROOT_PATCH_RESULT_ARTIFACT));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_delta_materializes_complete_target_tree() {
    let root = temp_dir("apply-v02");
    let (original, patched) = write_sample_dirs(&root);
    let output_dir = root.join("output");
    let delta_path = root.join("package.kaifuu");
    write_json(
        &delta_path,
        &create_delta(&original, &patched, SourceProvenance::complete()).unwrap(),
    )
    .unwrap();

    let result = apply_delta(&original, &delta_path, &output_dir).unwrap();

    assert_eq!(result["schemaVersion"], DELTA_SCHEMA_VERSION);
    assert_eq!(result["status"], "passed");
    assert_eq!(result["changedFileCount"], 4);
    assert_eq!(
        fs::read(output_dir.join("source.json")).unwrap(),
        br#"{"units":[{"targetText":"Hello"}]}"#
    );
    assert_eq!(
        fs::read_to_string(output_dir.join("data/unchanged.txt")).unwrap(),
        "same\n"
    );
    assert_eq!(
        fs::read_to_string(output_dir.join("data/add.txt")).unwrap(),
        "add\n"
    );
    assert!(!output_dir.join("data/delete.txt").exists());
    assert_eq!(
        fs::read(output_dir.join("bin/raw.dat")).unwrap(),
        vec![0, 159, 146, 151]
    );
    assert!(!output_dir.join(ROOT_PATCH_RESULT_ARTIFACT).exists());
    assert_eq!(
        result["outputHash"],
        create_delta(&original, &output_dir, SourceProvenance::complete()).unwrap()["target"]["rootHash"]
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_delta_refuses_partial_source_before_touching_source_or_staging() {
    // when sourceProvenance.partial is true the apply path
    // must refuse with a typed PartialSourceRefused error before the
    // source tree is walked or staging is allocated. The
    // contract says apply must refuse any envelope whose `partial`
    // bit is true.
    let root = temp_dir("partial-source-refused");
    let (original, patched) = write_sample_dirs(&root);
    let output_parent = root.join("new-output-parent");
    let output_dir = output_parent.join("output");
    let delta_path = root.join("partial-source.kaifuu");
    let partial_provenance = SourceProvenance {
        partial: true,
        adapter_id: Some("kaifuu-reallive".to_string()),
        partial_report_id: Some("019ed012-0000-7000-8000-0000000000c1".to_string()),
        blocking_diagnostic_count: Some(1),
    };
    write_json(
        &delta_path,
        &create_delta(&original, &patched, partial_provenance).unwrap(),
    )
    .unwrap();

    let error = apply_delta(&original, &delta_path, &output_dir).unwrap_err();
    let typed = error
        .downcast_ref::<PartialSourceRefused>()
        .expect("apply must return a typed PartialSourceRefused error");
    assert_eq!(typed.adapter_id.as_deref(), Some("kaifuu-reallive"));
    assert_eq!(typed.blocking_diagnostic_count, Some(1));
    assert!(
        typed.to_string().contains("partial_source_refused"),
        "{typed}"
    );
    assert!(!output_dir.exists());
    assert!(!output_parent.exists());
    assert_no_staging_dirs(&root, "output");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_delta_passes_through_explicitly_complete_source_provenance() {
    // the complete-source path must still succeed end to
    // end with the new required `sourceProvenance` field present.
    let root = temp_dir("complete-source-passes");
    let (original, patched) = write_sample_dirs(&root);
    let output_dir = root.join("output");
    let delta_path = root.join("complete-source.kaifuu");
    write_json(
        &delta_path,
        &create_delta(&original, &patched, SourceProvenance::complete()).unwrap(),
    )
    .unwrap();

    let result = apply_delta(&original, &delta_path, &output_dir).unwrap();
    assert_eq!(result["status"], "passed");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn validate_package_shape_rejects_legacy_v02_schema_version() {
    // the v0.2.0 loader is deleted in the same change as
    // the v0.3.0 introduction. There is no compatibility shim.
    let mut package: Value = serde_json::from_value(
        serde_json::to_value(
            // Build a v0.3 package, then mutate the schemaVersion.
            DeltaPackage {
                schema_version: DELTA_SCHEMA_VERSION.to_string(),
                delta_package_id: deterministic_id("delta", 2),
                format: DELTA_FORMAT.to_string(),
                metadata: DeltaMetadata {
                    generator: "kaifuu-delta/0.3".to_string(),
                    hash_algorithm: "sha256".to_string(),
                    path_encoding: "relative-utf8-posix".to_string(),
                    content_encodings: vec!["utf8".to_string(), "hex".to_string()],
                    ignored_artifacts: vec![],
                },
                source_provenance: SourceProvenance::complete(),
                source_compatibility: SourceCompatibility {
                    root_hash: root_hash([].iter().copied()),
                    file_count: 0,
                    byte_count: 0,
                    files: vec![],
                },
                target: TargetManifest {
                    root_hash: root_hash([].iter().copied()),
                    file_count: 0,
                    byte_count: 0,
                    files: vec![],
                },
                changed_entries: vec![],
            },
        )
        .unwrap(),
    )
    .unwrap();
    package["schemaVersion"] = json!("0.2.0");
    let parsed: DeltaPackage = serde_json::from_value(package).unwrap();
    let error = validate_package_shape(&parsed).unwrap_err().to_string();
    assert!(
        error.contains("unsupported delta schema version 0.2.0"),
        "{error}"
    );
}

#[test]
fn source_provenance_from_envelope_value_detects_partial_true() {
    let envelope = json!({
        "schemaVersion": "0.1.0",
        "reportId": "kaifuu-partial-adapter-abc",
        "adapterId": "kaifuu-reallive",
        "detected": false,
        "partial": true,
        "command": "extract",
        "evidence": [],
        "diagnostics": [],
        "severityCounts": { "p0": 0, "p1": 2, "p2": 1, "p3": 0 },
        "inventory": { "entries": 3, "sources": [] }
    });
    let provenance = SourceProvenance::from_extract_envelope_value(&envelope).unwrap();
    assert!(provenance.partial);
    assert_eq!(provenance.adapter_id.as_deref(), Some("kaifuu-reallive"));
    assert_eq!(
        provenance.partial_report_id.as_deref(),
        Some("kaifuu-partial-adapter-abc")
    );
    assert_eq!(provenance.blocking_diagnostic_count, Some(2));
}

#[test]
fn source_provenance_from_envelope_value_treats_missing_partial_as_complete() {
    // A regular bridge envelope (PatchExport / extract bundle) does
    // not carry a `partial` field. Apply must treat that as complete.
    let envelope = json!({
        "schemaVersion": "0.2.0",
        "bridgeId": "abc",
        "units": []
    });
    let provenance = SourceProvenance::from_extract_envelope_value(&envelope).unwrap();
    assert!(!provenance.partial);
    assert!(provenance.adapter_id.is_none());
}

#[test]
fn source_provenance_from_envelope_value_rejects_non_bool_partial() {
    // A present-but-non-bool `partial` (here the JSON string "true")
    // must fail closed with a typed error, never silently default to
    // complete and slip past the partial-source gate.
    for malformed in [json!("true"), json!(1), json!(["true"]), json!({})] {
        let envelope = json!({
            "schemaVersion": "0.1.0",
            "partial": malformed,
        });
        let err = SourceProvenance::from_extract_envelope_value(&envelope)
            .expect_err("non-bool partial must be rejected");
        assert!(
            err.downcast_ref::<MalformedPartialFlag>().is_some(),
            "expected MalformedPartialFlag, got: {err}"
        );
    }
}

#[test]
fn delta_promotion_rejects_empty_directory_created_after_staging() {
    let root = temp_dir("promotion-empty-dir-race");
    let output_dir = root.join("output");
    let staging_dir = allocate_staging_dir(&output_dir).unwrap();
    write_file(&staging_dir, "staged.txt", b"staged output\n");
    fs::create_dir(&output_dir).unwrap();

    let error =
        promote_staged_directory_no_clobber(&staging_dir, &output_dir, "delta output directory")
            .unwrap_err()
            .to_string();

    assert!(
        error.contains("delta output directory already exists"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(staging_dir.join("staged.txt")).unwrap(),
        "staged output\n"
    );
    assert!(fs::read_dir(&output_dir).unwrap().next().is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn delta_promotion_rejects_existing_file_without_touching_staging_or_output() {
    let root = temp_dir("promotion-existing-file");
    let output_dir = root.join("output");
    let staging_dir = allocate_staging_dir(&output_dir).unwrap();
    write_file(&staging_dir, "staged.txt", b"staged output\n");
    fs::write(&output_dir, "existing file\n").unwrap();

    let error =
        promote_staged_directory_no_clobber(&staging_dir, &output_dir, "delta output directory")
            .unwrap_err()
            .to_string();

    assert!(
        error.contains("delta output directory already exists"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(staging_dir.join("staged.txt")).unwrap(),
        "staged output\n"
    );
    assert_eq!(fs::read_to_string(&output_dir).unwrap(), "existing file\n");
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn delta_promotion_rejects_existing_symlink_like_output() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("promotion-existing-symlink");
    let output_dir = root.join("output");
    let linked_target = root.join("linked-target");
    let staging_dir = allocate_staging_dir(&output_dir).unwrap();
    write_file(&staging_dir, "staged.txt", b"staged output\n");
    fs::create_dir(&linked_target).unwrap();
    unix_fs::symlink(&linked_target, &output_dir).unwrap();

    let error =
        promote_staged_directory_no_clobber(&staging_dir, &output_dir, "delta output directory")
            .unwrap_err()
            .to_string();

    assert!(
        error.contains("delta output directory already exists"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(staging_dir.join("staged.txt")).unwrap(),
        "staged output\n"
    );
    assert!(
        fs::symlink_metadata(&output_dir)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    let _ = fs::remove_dir_all(root);
}
