#[test]
fn diff_apply_commands_round_trip_v02_delta_package() {
    let root = temp_dir("diff-apply-v02");
    let game_dir = temp_game(&root);
    write_fixture_file(&game_dir, "readme.txt", b"same\n");

    let patched_dir = root.join("patched");
    fs::create_dir_all(&patched_dir).unwrap();
    write_fixture_file(
        &patched_dir,
        "source.json",
        br#"{"units":[{"targetText":"Hello, {player}."}]}"#,
    );
    write_fixture_file(&patched_dir, "readme.txt", b"same\n");
    write_fixture_file(&patched_dir, "extra.txt", b"new\n");

    let delta_path = root.join("hello.kaifuu");
    run_cli(&[
        "diff",
        game_dir.to_str().unwrap(),
        patched_dir.to_str().unwrap(),
        "--output",
        delta_path.to_str().unwrap(),
    ]);
    let delta: serde_json::Value = read_json(&delta_path).unwrap();
    // bumped the kaifuu-delta-package schema from 0.2.0 to
    // 0.3.0 to add the required `sourceProvenance` envelope. The
    // round-trip diff/apply still works when no --source-extract is
    // passed; the resulting `sourceProvenance.partial` is false.
    assert_eq!(delta["schemaVersion"], "0.3.0");
    assert_eq!(delta["sourceProvenance"]["partial"], false);
    let changed_paths = delta["changedEntries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(changed_paths, vec!["extra.txt", "source.json"]);

    let output_dir = root.join("applied");
    run_cli(&[
        "apply",
        game_dir.to_str().unwrap(),
        "--patch",
        delta_path.to_str().unwrap(),
        "--output",
        output_dir.to_str().unwrap(),
    ]);

    let report_path = root.join("applied.kaifuu/patch-result.json");
    let apply_result: serde_json::Value = read_json(&report_path).unwrap();
    assert_eq!(apply_result["status"], "passed");
    assert_eq!(apply_result["changedFileCount"], 2);
    assert!(!output_dir.join("patch-result.json").exists());
    assert!(
        fs::read_to_string(output_dir.join("source.json"))
            .unwrap()
            .contains("Hello, {player}.")
    );
    assert_eq!(
        fs::read_to_string(output_dir.join("readme.txt")).unwrap(),
        "same\n"
    );
    assert_eq!(
        fs::read_to_string(output_dir.join("extra.txt")).unwrap(),
        "new\n"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_command_preserves_target_patch_result_and_writes_report_outside_output() {
    let root = temp_dir("apply-target-report-collision");
    let game_dir = temp_game(&root);

    let patched_dir = root.join("patched");
    fs::create_dir_all(&patched_dir).unwrap();
    write_fixture_file(
        &patched_dir,
        "source.json",
        br#"{"units":[{"targetText":"Hello, {player}."}]}"#,
    );
    write_fixture_file(&patched_dir, "patch-result.json", b"real game file\n");

    let delta_path = root.join("hello.kaifuu");
    run_cli(&[
        "diff",
        game_dir.to_str().unwrap(),
        patched_dir.to_str().unwrap(),
        "--output",
        delta_path.to_str().unwrap(),
    ]);
    let delta: serde_json::Value = read_json(&delta_path).unwrap();
    assert!(
        delta["target"]["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|record| record["path"] == "patch-result.json")
    );

    let output_dir = root.join("applied");
    run_cli(&[
        "apply",
        game_dir.to_str().unwrap(),
        "--patch",
        delta_path.to_str().unwrap(),
        "--output",
        output_dir.to_str().unwrap(),
    ]);

    assert_eq!(
        fs::read(output_dir.join("patch-result.json")).unwrap(),
        b"real game file\n"
    );
    let report: serde_json::Value =
        read_json(&root.join("applied.kaifuu/patch-result.json")).unwrap();
    assert_eq!(report["status"], "passed");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_command_rejects_report_output_inside_patched_output() {
    let root = temp_dir("apply-report-output-guard");
    let (game_dir, delta_path) = write_apply_delta(&root);
    let output_dir = root.join("applied");

    let result = run_with_args(
        [
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
            "--report-output",
            output_dir.join("patch-result.json").to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("apply report output must not be inside patched output directory"),
        "{error}"
    );
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_command_rejects_report_output_inside_source() {
    let root = temp_dir("apply-report-source-guard");
    let (game_dir, delta_path) = write_apply_delta(&root);
    let output_dir = root.join("applied");

    let result = run_with_args(
        [
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
            "--report-output",
            game_dir.join("report.json").to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("apply report output must not be inside source game directory"),
        "{error}"
    );
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn apply_command_rejects_default_report_sidecar_symlink_to_output() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("apply-report-default-sidecar-symlink");
    let (game_dir, delta_path) = write_apply_delta(&root);
    let output_dir = root.join("applied");
    unix_fs::symlink(&output_dir, root.join("applied.kaifuu")).unwrap();

    let result = run_with_args(
        [
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("apply report output path must not contain symlinks"),
        "{error}"
    );
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn apply_command_rejects_report_output_symlink_to_source() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("apply-report-output-symlink-source");
    let (game_dir, delta_path) = write_apply_delta(&root);
    let output_dir = root.join("applied");
    let report_link = root.join("report-link");
    unix_fs::symlink(&game_dir, &report_link).unwrap();

    let result = run_with_args(
        [
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
            "--report-output",
            report_link.join("report.json").to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("apply report output must not be inside source game directory"),
        "{error}"
    );
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn apply_command_rejects_report_output_symlink_to_output() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("apply-report-output-symlink-output");
    let (game_dir, delta_path) = write_apply_delta(&root);
    let output_dir = root.join("applied");
    let report_link = root.join("output-report-link");
    unix_fs::symlink(&output_dir, &report_link).unwrap();

    let result = run_with_args(
        [
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
            "--report-output",
            report_link.join("patch-result.json").to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("apply report output path must not contain symlinks"),
        "{error}"
    );
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn apply_command_rejects_canonical_source_report_output_bypass() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("apply-report-source-canonical");
    let (game_dir, delta_path) = write_apply_delta(&root);
    let game_link = root.join("game-link");
    unix_fs::symlink(&game_dir, &game_link).unwrap();
    let output_dir = root.join("applied");

    let result = run_with_args(
        [
            "apply",
            game_link.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
            "--report-output",
            game_dir.join("report.json").to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("apply report output must not be inside source game directory"),
        "{error}"
    );
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn apply_command_rejects_canonical_output_report_output_bypass() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("apply-report-output-canonical");
    let (game_dir, delta_path) = write_apply_delta(&root);
    let real_parent = root.join("real-parent");
    fs::create_dir_all(&real_parent).unwrap();
    let linked_parent = root.join("linked-parent");
    unix_fs::symlink(&real_parent, &linked_parent).unwrap();
    let output_dir = linked_parent.join("applied");

    let result = run_with_args(
        [
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
            "--report-output",
            real_parent
                .join("applied")
                .join("patch-result.json")
                .to_str()
                .unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("apply report output must not be inside patched output directory"),
        "{error}"
    );
    assert!(!real_parent.join("applied").exists());

    let _ = fs::remove_dir_all(root);
}
