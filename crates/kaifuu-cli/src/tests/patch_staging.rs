#[test]
fn patch_command_returns_error_when_adapter_reports_failed_patch_result() {
    let root = temp_dir("patch-failed-exit");
    let game_dir = temp_game(&root);
    let bridge_path = root.join("bridge.json");
    run_cli(&[
        "extract",
        game_dir.to_str().unwrap(),
        "--output",
        bridge_path.to_str().unwrap(),
    ]);
    let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 1),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![PatchExportEntry {
            bridge_unit_id: bridge.units[0].bridge_unit_id.clone(),
            source_unit_key: bridge.units[0].source_unit_key.clone(),
            source_hash: bridge.units[0].source_hash.clone(),
            target_text: "Hello, {player}.".to_string(),
            protected_span_mappings: vec![ProtectedSpanMapping::new("{player}", 0, 8)],
        }],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();
    let patched_dir = root.join("patched");

    let result = run_with_args(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            patched_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(error.contains("patch failed; see"));
    let patch_result: PatchResult = read_json(&patched_dir.join("patch-result.json")).unwrap();
    assert_eq!(patch_result.status, OperationStatus::Failed);
    assert!(!patched_dir.join("source.json").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_cleans_staging_when_adapter_errors_after_writing() {
    let root = temp_dir("patch-adapter-error-cleanup");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export_path = empty_patch_export(&root, 79);
    let output_dir = root.join("patched-output");
    let registry =
        patch_filesystem_failure_registry(PatchFilesystemFailureMode::AdapterErrAfterWrite);

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("adapter failed after writing staged output"),
        "{error}"
    );
    assert!(!output_dir.exists());
    assert_no_patch_staging_entries(&root, "patched-output");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_cleans_staging_when_promotion_fails_for_existing_output() {
    let root = temp_dir("patch-promotion-cleanup");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export_path = empty_patch_export(&root, 80);
    let output_dir = root.join("patched-output");
    fs::create_dir_all(&output_dir).unwrap();
    fs::write(output_dir.join("existing.txt"), "existing output\n").unwrap();
    let registry = patch_filesystem_failure_registry(PatchFilesystemFailureMode::SuccessfulWrite);

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("patch output directory already exists"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(output_dir.join("existing.txt")).unwrap(),
        "existing output\n"
    );
    assert!(!output_dir.join("adapter-output.txt").exists());
    assert!(!output_dir.join("patch-result.json").exists());
    assert_no_patch_staging_entries(&root, "patched-output");

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn patch_command_rejects_output_symlink_before_staging_or_adapter_write() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("patch-output-target-symlink");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export_path = empty_patch_export(&root, 83);
    let output_dir = root.join("patched-output");
    let linked_target = root.join("linked-target");
    fs::create_dir(&linked_target).unwrap();
    unix_fs::symlink(&linked_target, &output_dir).unwrap();
    let registry = patch_filesystem_failure_registry(PatchFilesystemFailureMode::SuccessfulWrite);

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("patch output directory must not be a symlink"),
        "{error}"
    );
    assert!(fs::read_dir(&linked_target).unwrap().next().is_none());
    assert_no_patch_staging_entries(&root, "patched-output");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_rejects_nested_output_before_staging_or_adapter_write() {
    let root = temp_dir("patch-output-nested-source");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export_path = empty_patch_export(&root, 84);
    let output_dir = game_dir.join("patched-output");
    let registry = patch_filesystem_failure_registry(PatchFilesystemFailureMode::SuccessfulWrite);

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("patch output directory must not nest with source game directory"),
        "{error}"
    );
    assert!(!output_dir.exists());
    assert!(!game_dir.join("adapter-output.txt").exists());
    assert_no_patch_staging_entries(&game_dir, "patched-output");

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn patch_command_rejects_canonical_source_alias_and_nesting_before_output_mutation() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("patch-output-canonical-source");
    let game_dir = root.join("game");
    let game_link = root.join("game-link");
    fs::create_dir_all(&game_dir).unwrap();
    unix_fs::symlink(&game_dir, &game_link).unwrap();
    let patch_export_path = empty_patch_export(&root, 85);
    let registry = patch_filesystem_failure_registry(PatchFilesystemFailureMode::SuccessfulWrite);

    let alias_result = run_with_args_and_registry(
        [
            "patch",
            game_link.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            game_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );
    let alias_error = alias_result.unwrap_err().to_string();
    assert!(
        alias_error.contains("patch output directory must not alias source game directory"),
        "{alias_error}"
    );

    let nested_output = game_dir.join("patched-output");
    let nested_result = run_with_args_and_registry(
        [
            "patch",
            game_link.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            nested_output.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );
    let nested_error = nested_result.unwrap_err().to_string();
    assert!(
        nested_error.contains("patch output directory must not nest with source game directory"),
        "{nested_error}"
    );

    assert!(!game_dir.join("adapter-output.txt").exists());
    assert!(!nested_output.exists());
    assert_no_patch_staging_entries(&root, "game");
    assert_no_patch_staging_entries(&game_dir, "patched-output");

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn patch_command_rejects_reallive_target_reallivedata_symlink_to_source_before_copy_or_write() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("patch-reallive-target-data-symlink-source");
    let source_root = root.join("private-source-root");
    let source_data = source_root.join("REALLIVEDATA");
    let target_root = root.join("private-target-root");
    let target_data = target_root.join("REALLIVEDATA");
    let bundle_path = root.join("missing-translated-bundle.json");
    fs::create_dir_all(&source_data).unwrap();
    fs::create_dir_all(&target_root).unwrap();
    fs::write(
        source_data.join("Seen.txt"),
        b"synthetic source seen bytes\n",
    )
    .unwrap();
    unix_fs::symlink(&source_data, &target_data).unwrap();

    let result = run_patch_reallive_bundle(
        &[
            "patch",
            "--engine",
            "reallive",
            "--source",
            source_root.to_str().unwrap(),
            "--target",
            target_root.to_str().unwrap(),
            "--bundle",
            bundle_path.to_str().unwrap(),
            "--force",
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.reallive.patchback_target_symlink"),
        "{error}"
    );
    assert!(
        error.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED),
        "{error}"
    );
    for forbidden in [
        source_root.to_string_lossy(),
        source_data.to_string_lossy(),
        target_root.to_string_lossy(),
        target_data.to_string_lossy(),
    ] {
        assert!(
            !error.contains(forbidden.as_ref()),
            "diagnostic leaked private path {forbidden}: {error}"
        );
    }
    assert_eq!(
        fs::read(source_data.join("Seen.txt")).unwrap(),
        b"synthetic source seen bytes\n"
    );

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn patch_command_rejects_reallive_nested_target_symlink_to_writable_dir_before_copy_or_write() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("patch-reallive-target-data-symlink-writable");
    let source_root = root.join("private-source-root");
    let target_root = root.join("private-target-root");
    let linked_writable = root.join("private-linked-writable");
    let bundle_path = root.join("missing-translated-bundle.json");
    fs::create_dir_all(source_root.join("REALLIVEDATA")).unwrap();
    fs::create_dir_all(&target_root).unwrap();
    fs::create_dir_all(&linked_writable).unwrap();
    fs::write(
        source_root.join("REALLIVEDATA/Seen.txt"),
        b"synthetic source seen bytes\n",
    )
    .unwrap();
    unix_fs::symlink(&linked_writable, target_root.join("REALLIVEDATA")).unwrap();

    let result = run_patch_reallive_bundle(
        &[
            "patch",
            "--engine",
            "reallive",
            "--source",
            source_root.to_str().unwrap(),
            "--target",
            target_root.to_str().unwrap(),
            "--bundle",
            bundle_path.to_str().unwrap(),
            "--force",
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.reallive.patchback_target_symlink"),
        "{error}"
    );
    assert!(
        error.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED),
        "{error}"
    );
    for forbidden in [
        source_root.to_string_lossy(),
        target_root.to_string_lossy(),
        linked_writable.to_string_lossy(),
    ] {
        assert!(
            !error.contains(forbidden.as_ref()),
            "diagnostic leaked private path {forbidden}: {error}"
        );
    }
    assert_eq!(
        fs::read(source_root.join("REALLIVEDATA/Seen.txt")).unwrap(),
        b"synthetic source seen bytes\n"
    );
    assert!(fs::read_dir(&linked_writable).unwrap().next().is_none());

    let _ = fs::remove_dir_all(root);
}
