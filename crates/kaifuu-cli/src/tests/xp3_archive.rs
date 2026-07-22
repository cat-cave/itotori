fn write_real_plain_xp3_fixture(dir: &Path) -> PathBuf {
    let source = kirikiri_fixture_path("plain.xp3");
    let staged = dir.join("plain.xp3");
    fs::copy(&source, &staged).unwrap();
    staged
}

#[test]
fn xp3_unpack_pack_round_trips_real_plain_fixture_byte_identical_via_cli() {
    // Acceptance criterion (writer): unpack -> pack reproduces the
    // source bytes for an unchanged plain fixture. Round-trips via
    // the `kaifuu xp3 unpack` and `kaifuu xp3 pack` subcommands so
    // the CLI surface is exercised end-to-end.
    let root = temp_dir("xp3-unpack-pack-real-cli");
    let staged = write_real_plain_xp3_fixture(&root);
    let unpack_dir = root.join("unpacked");
    let rebuilt = root.join("rebuilt.xp3");

    run_cli(&[
        "xp3",
        "unpack",
        "--archive",
        staged.to_str().unwrap(),
        "--output-dir",
        unpack_dir.to_str().unwrap(),
    ]);
    assert!(unpack_dir.join("manifest.json").exists());

    run_cli(&[
        "xp3",
        "pack",
        "--input-dir",
        unpack_dir.to_str().unwrap(),
        "--output",
        rebuilt.to_str().unwrap(),
    ]);
    let original = fs::read(&staged).unwrap();
    let rebuilt_bytes = fs::read(&rebuilt).unwrap();
    assert_eq!(
        rebuilt_bytes, original,
        "CLI unpack -> pack must round-trip byte-identical"
    );

    // The verify subcommand confirms the same property without us
    // having to re-read the bytes ourselves.
    run_cli(&[
        "xp3",
        "verify",
        "--source",
        staged.to_str().unwrap(),
        "--input-dir",
        unpack_dir.to_str().unwrap(),
    ]);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_replace_command_updates_table_and_round_trip_passes_through_inventory() {
    // Acceptance criterion: "Replacing an allowed plain fixture file
    // updates table metadata and verification output."
    let root = temp_dir("xp3-replace-cli");
    let staged = write_real_plain_xp3_fixture(&root);
    let unpack_dir = root.join("unpacked");
    let rebuilt = root.join("rebuilt.xp3");
    let new_payload_path = root.join("new-intro.bin");
    let new_payload = b"intro replaced by deterministic XP3 writer CLI\n";
    fs::write(&new_payload_path, new_payload).unwrap();

    run_cli(&[
        "xp3",
        "unpack",
        "--archive",
        staged.to_str().unwrap(),
        "--output-dir",
        unpack_dir.to_str().unwrap(),
    ]);
    run_cli(&[
        "xp3",
        "replace",
        "--input-dir",
        unpack_dir.to_str().unwrap(),
        "--entry-path",
        "scenario/intro.ks",
        "--payload",
        new_payload_path.to_str().unwrap(),
    ]);
    run_cli(&[
        "xp3",
        "pack",
        "--input-dir",
        unpack_dir.to_str().unwrap(),
        "--output",
        rebuilt.to_str().unwrap(),
    ]);

    let inventory = kaifuu_core::read_plain_xp3_inventory(&fs::read(&rebuilt).unwrap()).unwrap();
    let intro = inventory
        .entries
        .iter()
        .find(|entry| entry.path == "scenario/intro.ks")
        .unwrap();
    assert_eq!(intro.archive_size, new_payload.len() as u64);
    assert_eq!(intro.original_size, new_payload.len() as u64);
    assert_eq!(
        intro.payload_hash.as_deref(),
        Some(sha256_hash_bytes(new_payload).as_str())
    );
    let expected_adler = kaifuu_core::compute_adler32(new_payload);
    assert_eq!(
        intro.stored_adler32.as_deref(),
        Some(format!("adler32:{expected_adler:08x}").as_str())
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_unpack_refuses_encrypted_fixture_with_semantic_diagnostic() {
    // Acceptance criterion: "Encrypted... profiles fail before
    // writes with semantic diagnostics."
    let root = temp_dir("xp3-unpack-encrypted-refusal");
    let encrypted = kirikiri_fixture_path("encrypted.xp3");
    let target = root.join("would-not-create");
    let result = run_with_args(
        [
            "xp3",
            "unpack",
            "--archive",
            encrypted.to_str().unwrap(),
            "--output-dir",
            target.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );
    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.unsupported_variant.encrypted"),
        "encrypted refusal must surface the semantic code: {error}"
    );
    assert!(
        !target.exists(),
        "encrypted unpack must not create the output directory"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_unpack_refuses_helper_required_fixture_with_semantic_diagnostic() {
    let root = temp_dir("xp3-unpack-helper-required-refusal");
    let helper_required = kirikiri_fixture_path("helper-required.xp3");
    let target = root.join("would-not-create");
    let result = run_with_args(
        [
            "xp3",
            "unpack",
            "--archive",
            helper_required.to_str().unwrap(),
            "--output-dir",
            target.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );
    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.helper_required"),
        "helper-required refusal must surface the semantic code: {error}"
    );
    assert!(!target.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_unpack_refuses_protected_executable_fixture_with_semantic_diagnostic() {
    let root = temp_dir("xp3-unpack-protected-executable-refusal");
    let protected = kirikiri_fixture_path("protected-executable.bin");
    let target = root.join("would-not-create");
    let result = run_with_args(
        [
            "xp3",
            "unpack",
            "--archive",
            protected.to_str().unwrap(),
            "--output-dir",
            target.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );
    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.protected_executable_unsupported"),
        "protected-executable refusal must surface the semantic code: {error}"
    );
    assert!(!target.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_replace_refuses_compressed_entry_with_semantic_diagnostic() {
    // Acceptance criterion: "Encrypted, compressed-unknown, or
    // helper-required profiles fail before writes with semantic
    // diagnostics." The CLI replace command refuses compressed
    // entries with the matching kaifuu.unsupported_variant.packed
    // semantic code.
    let root = temp_dir("xp3-replace-compressed-refusal");
    let staged = write_real_plain_xp3_fixture(&root);
    let unpack_dir = root.join("unpacked");
    let new_payload_path = root.join("would-require-recompression.bin");
    fs::write(&new_payload_path, b"replacement requires recompression").unwrap();

    run_cli(&[
        "xp3",
        "unpack",
        "--archive",
        staged.to_str().unwrap(),
        "--output-dir",
        unpack_dir.to_str().unwrap(),
    ]);
    let result = run_with_args(
        [
            "xp3",
            "replace",
            "--input-dir",
            unpack_dir.to_str().unwrap(),
            "--entry-path",
            "scenario/compressed.ks",
            "--payload",
            new_payload_path.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );
    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.unsupported_variant.packed"),
        "compressed-replacement refusal must surface the packed semantic code: {error}"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_writer_capability_command_emits_archive_rebuild_plain_tuple() {
    // Acceptance criterion: "Writer capability tuple records
    // patch_back_mode=archive_rebuild_plain". CLI exposes the tuple
    // so orchestrator code can pattern-match without statically
    // linking kaifuu-core.
    let root = temp_dir("xp3-writer-capability");
    let output = root.join("capability.json");
    run_cli(&[
        "xp3",
        "writer-capability",
        "--output",
        output.to_str().unwrap(),
    ]);
    let value: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(value["patchBackMode"], "archive_rebuild_plain");
    assert_eq!(value["variant"], "plain");
    assert_eq!(value["adapterId"], kaifuu_core::PLAIN_XP3_WRITER_ADAPTER_ID);
    let _ = fs::remove_dir_all(root);
}
