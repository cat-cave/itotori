use super::*;

#[cfg(unix)]
#[test]
fn std_rename_replaces_existing_empty_directory_on_unix() {
    let root = temp_dir("unix-stdlib-dir-rename");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&target).unwrap();
    write_file(&source, "staged.txt", b"staged output\n");

    fs::rename(&source, &target).unwrap();

    assert!(!source.exists());
    assert_eq!(
        fs::read_to_string(target.join("staged.txt")).unwrap(),
        "staged output\n"
    );
    let _ = fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn std_rename_rejects_existing_empty_directory_on_windows() {
    let root = temp_dir("windows-stdlib-dir-rename");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&target).unwrap();
    write_file(&source, "staged.txt", b"staged output\n");

    let error = fs::rename(&source, &target).unwrap_err();

    assert!(
        matches!(
            error.kind(),
            ErrorKind::AlreadyExists
                | ErrorKind::PermissionDenied
                | ErrorKind::DirectoryNotEmpty
                | ErrorKind::Other
        ),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(source.join("staged.txt")).unwrap(),
        "staged output\n"
    );
    assert!(fs::read_dir(&target).unwrap().next().is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_delta_rejects_incompatible_source_before_writing_output() {
    let root = temp_dir("incompatible-source");
    let (original, patched) = write_sample_dirs(&root);
    let output_dir = root.join("output");
    let delta_path = root.join("package.kaifuu");
    write_json(
        &delta_path,
        &create_delta(&original, &patched, SourceProvenance::complete()).unwrap(),
    )
    .unwrap();
    write_file(&original, "data/unchanged.txt", b"changed source\n");

    let error = apply_delta(&original, &delta_path, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(error.contains("source root hash does not match delta package"));
    assert!(!output_dir.exists());
    assert_no_staging_dirs(&root, "output");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn validate_relative_package_path_rejects_shared_negative_matrix() {
    assert!(validate_relative_package_path("data/source.json").is_ok());
    for (case, unsafe_path) in UNSAFE_PACKAGE_PATH_FIXTURES {
        assert!(
            validate_relative_package_path(unsafe_path).is_err(),
            "{case}: {unsafe_path:?} should be rejected"
        );
    }
}

#[test]
fn apply_delta_rejects_shared_unsafe_path_matrix_without_writing_output() {
    for (index, (case, unsafe_path)) in UNSAFE_PACKAGE_PATH_FIXTURES.iter().enumerate() {
        let root = temp_dir(&format!("unsafe-path-{index}"));
        let (original, patched) = write_sample_dirs(&root);
        let output_dir = root.join("output");
        let delta_path = root.join("unsafe.kaifuu");
        let mut package = create_delta(&original, &patched, SourceProvenance::complete()).unwrap();
        package["changedEntries"][0]["path"] = json!(unsafe_path);
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(
            error.contains("unsafe relative output path"),
            "{case}: {unsafe_path:?} returned unexpected error: {error}"
        );
        assert!(!root.join("escaped.dat").exists());
        assert!(!output_dir.exists());
        assert_no_staging_dirs(&root, "output");
        let _ = fs::remove_dir_all(root);
    }
}

#[cfg(unix)]
#[test]
fn create_delta_rejects_backslash_filename_component() {
    let root = temp_dir("backslash-filename-component");
    let (original, patched) = write_sample_dirs(&root);
    fs::write(patched.join("data\\ambiguous.txt"), b"ambiguous\n").unwrap();

    let error = create_delta(&original, &patched, SourceProvenance::complete())
        .unwrap_err()
        .to_string();

    assert!(error.contains("separator characters"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_delta_rejects_content_hash_mismatch_before_writing_output() {
    let root = temp_dir("content-hash-mismatch");
    let (original, patched) = write_sample_dirs(&root);
    let output_dir = root.join("output");
    let delta_path = root.join("corrupt.kaifuu");
    let mut package = create_delta(&original, &patched, SourceProvenance::complete()).unwrap();
    let entry = package["changedEntries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["path"] == "source.json")
        .unwrap();
    entry["content"] = json!("tampered\n");
    write_json(&delta_path, &package).unwrap();

    let error = apply_delta(&original, &delta_path, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(error.contains("content hash does not match targetHash"));
    assert!(!output_dir.exists());
    assert_no_staging_dirs(&root, "output");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_delta_rejects_target_file_dir_prefix_conflict_before_staging_allocation() {
    let root = temp_dir("target-prefix-conflict");
    let original = root.join("original");
    fs::create_dir_all(&original).unwrap();
    write_file(&original, "data", b"source\n");
    let output_parent = root.join("new-output-parent");
    let output_dir = output_parent.join("output");
    let delta_path = root.join("conflict.kaifuu");
    let mut package = create_delta(&original, &original, SourceProvenance::complete()).unwrap();
    add_utf8_changed_entry(&mut package, "data/nested.txt", b"nested\n");
    add_target_file_record(&mut package, "data/nested.txt", b"nested\n");
    refresh_manifest(&mut package, "target");
    write_json(&delta_path, &package).unwrap();

    let error = apply_delta(&original, &delta_path, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(error.contains("file/dir prefix conflict"));
    assert!(!output_dir.exists());
    assert!(!output_parent.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_delta_rejects_backslash_changed_entry_before_staging_allocation() {
    let root = temp_dir("target-backslash-changed-entry");
    let original = root.join("original");
    fs::create_dir_all(&original).unwrap();
    write_file(&original, "data", b"source\n");
    let output_parent = root.join("new-output-parent");
    let output_dir = output_parent.join("output");
    let delta_path = root.join("conflict.kaifuu");
    let mut package = create_delta(&original, &original, SourceProvenance::complete()).unwrap();
    add_utf8_changed_entry(&mut package, "data\\nested.txt", b"nested\n");
    add_target_file_record(&mut package, "data\\nested.txt", b"nested\n");
    refresh_manifest(&mut package, "target");
    write_json(&delta_path, &package).unwrap();

    let error = apply_delta(&original, &delta_path, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(error.contains("unsafe relative output path"));
    assert!(error.contains("backslashes"));
    assert!(!output_dir.exists());
    assert!(!output_parent.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_delta_rejects_backslash_target_manifest_collision_before_staging_allocation() {
    let root = temp_dir("target-backslash-manifest-collision");
    let original = root.join("original");
    fs::create_dir_all(&original).unwrap();
    write_file(&original, "data/nested.txt", b"source\n");
    let output_parent = root.join("new-output-parent");
    let output_dir = output_parent.join("output");
    let delta_path = root.join("conflict.kaifuu");
    let mut package = create_delta(&original, &original, SourceProvenance::complete()).unwrap();
    add_target_file_record(&mut package, "data\\nested.txt", b"colliding target\n");
    package["target"]["fileCount"] = json!(2);
    package["target"]["byteCount"] =
        json!(b"source\n".len() as u64 + b"colliding target\n".len() as u64);
    write_json(&delta_path, &package).unwrap();

    let error = apply_delta(&original, &delta_path, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(error.contains("unsafe relative output path"));
    assert!(error.contains("backslashes"));
    assert!(!output_dir.exists());
    assert!(!output_parent.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn create_delta_includes_source_root_patch_result_as_real_game_file() {
    let root = temp_dir("source-root-patch-result");
    let (original, patched) = write_sample_dirs(&root);
    let output_dir = root.join("output");
    let delta_path = root.join("delete-source-report.kaifuu");
    write_file(&original, ROOT_PATCH_RESULT_ARTIFACT, b"source game file\n");
    let package = create_delta(&original, &patched, SourceProvenance::complete()).unwrap();
    write_json(&delta_path, &package).unwrap();

    let source_paths = package["sourceCompatibility"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|record| record["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(source_paths.contains(&ROOT_PATCH_RESULT_ARTIFACT));
    let delete_entry = package["changedEntries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == ROOT_PATCH_RESULT_ARTIFACT)
        .unwrap();
    assert_eq!(delete_entry["operation"], "delete");

    apply_delta(&original, &delta_path, &output_dir).unwrap();

    assert!(!output_dir.join(ROOT_PATCH_RESULT_ARTIFACT).exists());
    assert_eq!(
        fs::read(original.join(ROOT_PATCH_RESULT_ARTIFACT)).unwrap(),
        b"source game file\n"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_delta_materializes_target_root_patch_result_as_real_game_file() {
    let root = temp_dir("target-root-patch-result");
    let (original, patched) = write_sample_dirs(&root);
    let output_dir = root.join("output");
    let delta_path = root.join("target-report-file.kaifuu");
    write_file(&patched, ROOT_PATCH_RESULT_ARTIFACT, b"target game file\n");
    let package = create_delta(&original, &patched, SourceProvenance::complete()).unwrap();
    write_json(&delta_path, &package).unwrap();

    let target_paths = package["target"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|record| record["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(target_paths.contains(&ROOT_PATCH_RESULT_ARTIFACT));
    assert!(
        package["changedEntries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == ROOT_PATCH_RESULT_ARTIFACT)
    );

    apply_delta(&original, &delta_path, &output_dir).unwrap();

    assert_eq!(
        fs::read(output_dir.join(ROOT_PATCH_RESULT_ARTIFACT)).unwrap(),
        b"target game file\n"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_delta_rejects_incomplete_changed_entries_without_staging_files() {
    let root = temp_dir("incomplete-changed-entries");
    let (original, patched) = write_sample_dirs(&root);
    let output_dir = root.join("output");
    let delta_path = root.join("incomplete.kaifuu");
    let mut package = create_delta(&original, &patched, SourceProvenance::complete()).unwrap();
    remove_changed_entry(&mut package, "source.json");
    write_json(&delta_path, &package).unwrap();

    let error = apply_delta(&original, &delta_path, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(error.contains("changed entries do not reproduce target manifest"));
    assert!(!output_dir.exists());
    assert_no_staging_dirs(&root, "output");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_delta_rejects_incomplete_changed_entries_before_staging_allocation() {
    let root = temp_dir("incomplete-before-staging");
    let (original, patched) = write_sample_dirs(&root);
    let output_parent = root.join("new-output-parent");
    let output_dir = output_parent.join("output");
    let delta_path = root.join("incomplete.kaifuu");
    let mut package = create_delta(&original, &patched, SourceProvenance::complete()).unwrap();
    remove_changed_entry(&mut package, "source.json");
    write_json(&delta_path, &package).unwrap();

    let error = apply_delta(&original, &delta_path, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(error.contains("changed entries do not reproduce target manifest"));
    assert!(!output_dir.exists());
    assert!(!output_parent.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_delta_rejects_omitted_add_entry_before_staging_allocation() {
    let root = temp_dir("omitted-add-entry");
    let (original, patched) = write_sample_dirs(&root);
    let output_parent = root.join("new-output-parent");
    let output_dir = output_parent.join("output");
    let delta_path = root.join("incomplete-add.kaifuu");
    let mut package = create_delta(&original, &patched, SourceProvenance::complete()).unwrap();
    remove_changed_entry(&mut package, "data/add.txt");
    write_json(&delta_path, &package).unwrap();

    let error = apply_delta(&original, &delta_path, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(error.contains("changed entries do not reproduce target manifest"));
    assert!(!output_dir.exists());
    assert!(!output_parent.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_delta_rejects_omitted_delete_entry_before_staging_allocation() {
    let root = temp_dir("omitted-delete-entry");
    let (original, patched) = write_sample_dirs(&root);
    let output_parent = root.join("new-output-parent");
    let output_dir = output_parent.join("output");
    let delta_path = root.join("incomplete-delete.kaifuu");
    let mut package = create_delta(&original, &patched, SourceProvenance::complete()).unwrap();
    remove_changed_entry(&mut package, "data/delete.txt");
    write_json(&delta_path, &package).unwrap();

    let error = apply_delta(&original, &delta_path, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(error.contains("changed entries do not reproduce target manifest"));
    assert!(!output_dir.exists());
    assert!(!output_parent.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_delta_accepts_reordered_changed_entries_and_target_records() {
    let root = temp_dir("reordered-package-records");
    let (original, patched) = write_sample_dirs(&root);
    let output_dir = root.join("output");
    let delta_path = root.join("reordered.kaifuu");
    let mut package = create_delta(&original, &patched, SourceProvenance::complete()).unwrap();
    package["changedEntries"].as_array_mut().unwrap().reverse();
    package["target"]["files"].as_array_mut().unwrap().reverse();
    write_json(&delta_path, &package).unwrap();

    let result = apply_delta(&original, &delta_path, &output_dir).unwrap();

    assert_eq!(result["status"], "passed");
    assert_eq!(
        result["outputHash"],
        create_delta(&original, &output_dir, SourceProvenance::complete()).unwrap()["target"]["rootHash"]
    );
    let _ = fs::remove_dir_all(root);
}
