use super::super::*;

// hash-to-exec TOCTOU: validated bytes bound to execution
// through a trusted staging copy.

/// A registry entry whose single allowlist entry pins `registered_hash` for
/// a `helper-bin`-named helper (fixture-any platform, version 0.1.0,
/// FixtureInvocation capability).
fn staging_launch_entry(registered_hash: &str) -> HelperRegistryEntry {
    let mut entry = FixtureHelperStubAdapter::registry_entry();
    let allowlist_entry = &mut entry.binary_allowlist.entries[0];
    allowlist_entry.sha256_hash = registered_hash.to_string();
    allowlist_entry.executable_name = "helper-bin".to_string();
    entry
}

fn launch_request<'a>(
    entry: &'a HelperRegistryEntry,
    source: &'a Path,
    required: &'a [HelperCapability],
) -> HelperBinaryLaunchValidationRequest<'a> {
    HelperBinaryLaunchValidationRequest {
        helper_id: &entry.helper_id,
        allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
        executable_path: source,
        platform: "fixture-any",
        helper_version: "0.1.0",
        required_capabilities: required,
    }
}

#[test]
fn helper_launch_binds_validated_bytes_via_trusted_staging_copy_defeats_swap() {
    let src_dir = tempfile::tempdir().unwrap();
    let staging_dir = tempfile::tempdir().unwrap();
    let source = src_dir.path().join("helper-bin");

    let original = b"ORIGINAL-VALIDATED-HELPER-BYTES\n";
    fs::write(&source, original).unwrap();
    let original_hash = sha256_hash_bytes(original);

    let entry = staging_launch_entry(&original_hash);
    let required = [HelperCapability::FixtureInvocation];
    let outcome = entry.stage_and_validate_binary_launch(
        launch_request(&entry, &source, &required),
        staging_dir.path(),
    );

    assert!(
        outcome.passed(),
        "validation should pass: {:?}",
        outcome.validation.diagnostics
    );
    let staged = outcome
        .staged
        .as_ref()
        .expect("passed launch must bind a staged execution reference");
    // The validated hash is of the STAGED bytes and equals the original.
    assert_eq!(staged.staged_hash(), original_hash);
    // The execution target is the trusted staged copy, NOT the source.
    assert_ne!(staged.staged_path(), source.as_path());
    assert!(staged.staged_path().starts_with(staging_dir.path()));

    // Swap the source binary AFTER validation with attacker-chosen bytes.
    let swapped = b"SWAPPED-EVIL-HELPER-BYTES-THAT-MUST-NEVER-RUN\n";
    fs::write(&source, swapped).unwrap();
    let swapped_hash = sha256_hash_bytes(swapped);
    assert_ne!(original_hash, swapped_hash);

    // What would execute (the staged copy) is UNCHANGED by the swap.
    let staged_bytes = fs::read(staged.staged_path()).unwrap();
    assert_eq!(staged_bytes.as_slice(), original);
    assert_eq!(sha256_hash_bytes(&staged_bytes), original_hash);

    // Mutation proof: the OLD hash-then-exec-path approach re-opened the
    // mutable source at launch — which now hashes to the SWAPPED bytes, i.e.
    // it would run the attacker binary. The staging copy defeats exactly
    // this.
    let source_hash_at_launch = sha256_file_ref(&source).unwrap();
    assert_eq!(
        source_hash_at_launch, swapped_hash,
        "re-hashing the mutable source at launch yields the swapped bytes (the TOCTOU the staging copy defeats)"
    );
    assert_ne!(
        source_hash_at_launch, original_hash,
        "the source path no longer holds the validated bytes after the swap"
    );

    // On Unix the held execution descriptor still reads the validated bytes.
    #[cfg(unix)]
    {
        use std::io::Read as _;
        use std::os::fd::AsFd;
        let dup = staged.execution_fd().try_clone_to_owned().unwrap();
        let mut file = std::fs::File::from(dup);
        let _ = file.as_fd();
        let mut via_fd = Vec::new();
        file.read_to_end(&mut via_fd).unwrap();
        assert_eq!(via_fd.as_slice(), original);
    }
}

#[test]
fn helper_launch_detects_staged_hash_tamper_with_typed_error() {
    let src_dir = tempfile::tempdir().unwrap();
    let staging_dir = tempfile::tempdir().unwrap();
    let source = src_dir.path().join("helper-bin");

    // Register the EXPECTED bytes' hash, but the source on disk is tampered.
    let expected_hash = sha256_hash_bytes(b"EXPECTED-HELPER-BYTES\n");
    let tampered = b"TAMPERED-HELPER-BYTES\n";
    fs::write(&source, tampered).unwrap();
    let tampered_hash = sha256_hash_bytes(tampered);

    // (a) Direct stage-time typed error (acceptance #3).
    let error = stage_and_verify_helper_binary(
        &expected_hash,
        &source,
        staging_dir.path(),
        &staged_helper_binary_name(FIXTURE_HELPER_ALLOWLIST_REF_ID),
    )
    .expect_err("tampered staged bytes must be a typed error");
    assert_eq!(
        error,
        HelperBinaryStagingError::StagedHashMismatch {
            expected: expected_hash.clone(),
            observed: tampered_hash.clone(),
        }
    );

    // (b) Through the launch validator: HASH_MISMATCH diagnostic on the
    // STAGED bytes, and NO staged execution reference is handed back.
    let entry = staging_launch_entry(&expected_hash);
    let required = [HelperCapability::FixtureInvocation];
    let outcome = entry.stage_and_validate_binary_launch(
        launch_request(&entry, &source, &required),
        staging_dir.path(),
    );
    assert!(!outcome.passed());
    assert!(
        outcome.staged.is_none(),
        "a failed launch must not bind an executable handle"
    );
    assert_eq!(
        outcome.validation.observed_hash.as_deref(),
        Some(tampered_hash.as_str())
    );
    assert!(
        outcome
            .validation
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == SEMANTIC_HELPER_ALLOWLIST_HASH_MISMATCH),
        "expected hash-mismatch diagnostic: {:?}",
        outcome.validation.diagnostics
    );
}

#[test]
fn helper_launch_refuses_symlinked_source_instead_of_chasing_it() {
    #[cfg(unix)]
    {
        let src_dir = tempfile::tempdir().unwrap();
        let staging_dir = tempfile::tempdir().unwrap();
        let real = src_dir.path().join("real-target");
        let bytes = b"REAL-TARGET-BYTES\n";
        fs::write(&real, bytes).unwrap();
        let link = src_dir.path().join("helper-bin");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        // Direct primitive: a symlink source is a typed refusal.
        let error = stage_helper_binary_no_follow(
            &link,
            staging_dir.path(),
            &staged_helper_binary_name(FIXTURE_HELPER_ALLOWLIST_REF_ID),
        )
        .expect_err("symlink source must be refused");
        assert_eq!(error, HelperBinaryStagingError::SourceSymlink);

        // Through the launch validator: a staging-failed diagnostic, no
        // staged handle.
        let entry = staging_launch_entry(&sha256_hash_bytes(bytes));
        let required = [HelperCapability::FixtureInvocation];
        let outcome = entry.stage_and_validate_binary_launch(
            launch_request(&entry, &link, &required),
            staging_dir.path(),
        );
        assert!(!outcome.passed());
        assert!(outcome.staged.is_none());
        assert!(
            outcome
                .validation
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == SEMANTIC_HELPER_ALLOWLIST_STAGING_FAILED)
        );
    }
}

#[test]
fn staged_helper_copy_is_removed_on_drop() {
    let src_dir = tempfile::tempdir().unwrap();
    let staging_dir = tempfile::tempdir().unwrap();
    let source = src_dir.path().join("helper-bin");
    let bytes = b"HELPER\n";
    fs::write(&source, bytes).unwrap();
    let name = staged_helper_binary_name(FIXTURE_HELPER_ALLOWLIST_REF_ID);
    let staged_path = {
        let staged = stage_and_verify_helper_binary(
            &sha256_hash_bytes(bytes),
            &source,
            staging_dir.path(),
            &name,
        )
        .unwrap();
        let path = staged.staged_path().to_path_buf();
        assert!(path.exists());
        path
    };
    assert!(!staged_path.exists(), "staged copy must be removed on drop");
}
