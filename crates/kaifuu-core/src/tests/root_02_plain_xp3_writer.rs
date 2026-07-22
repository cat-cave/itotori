#[test]
fn unpack_and_pack_round_trips_real_plain_xp3_directory_byte_identical() {
    // Acceptance criterion: "Rebuilding an unchanged plain fixture
    // produces stable archive structure and expected hashes." This
    // exercises the directory unpack/repack path (the actual writer
    // entry point: "take an unpacked plain XP3 dir + rebuild a
    // byte-identical XP3 archive").
    let fixture_bytes = fs::read(repo_fixture_path("fixtures/kaifuu/kirikiri/plain.xp3")).unwrap();
    let dir = temp_dir("plain-xp3-unpack-real");
    let manifest = unpack_plain_xp3_to_directory(&fixture_bytes, &dir).unwrap();
    assert_eq!(manifest.variant, PLAIN_XP3_MANIFEST_VARIANT);
    assert_eq!(manifest.entries.len(), 3);
    assert!(dir.join("manifest.json").exists());
    for entry in &manifest.entries {
        assert!(
            dir.join(&entry.payload_relative_path).exists(),
            "payload file for {:?} should exist",
            entry.path
        );
    }

    let rebuilt = pack_plain_xp3_from_directory(&dir).unwrap();
    assert_eq!(
        rebuilt, fixture_bytes,
        "unpack -> pack round trip must be byte-identical for the real plain XP3 fixture"
    );

    // Determinism: packing twice from the unchanged directory yields
    // the same bytes.
    let rebuilt_again = pack_plain_xp3_from_directory(&dir).unwrap();
    assert_eq!(rebuilt, rebuilt_again);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn replace_plain_xp3_entry_updates_table_metadata_and_verification() {
    // Acceptance criterion: "Replacing an allowed plain fixture file
    // updates table metadata and verification output."
    let fixture_bytes = fs::read(repo_fixture_path("fixtures/kaifuu/kirikiri/plain.xp3")).unwrap();
    let dir = temp_dir("plain-xp3-replace-real");
    unpack_plain_xp3_to_directory(&fixture_bytes, &dir).unwrap();

    let replacement = b"replaced public payload bytes\n";
    let updated_manifest =
        replace_plain_xp3_entry_payload(&dir, "scenario/intro.ks", replacement).unwrap();
    let replaced_entry = updated_manifest
        .entries
        .iter()
        .find(|entry| entry.path == "scenario/intro.ks")
        .unwrap();
    assert_eq!(replaced_entry.original_size, replacement.len() as u64);
    assert_eq!(replaced_entry.archive_size, replacement.len() as u64);
    assert_eq!(
        replaced_entry.segments[0].original_size,
        replacement.len() as u64
    );
    assert_eq!(
        replaced_entry.segments[0].archive_size,
        replacement.len() as u64
    );
    // adler32 was recomputed.
    let expected_adler = compute_adler32(replacement);
    assert_eq!(
        replaced_entry.stored_adler32_hex.as_deref(),
        Some(format!("{expected_adler:08x}").as_str())
    );

    // Unchanged entries keep their original metadata.
    let untouched_entry = updated_manifest
        .entries
        .iter()
        .find(|entry| entry.path == "image/title.png")
        .unwrap();
    assert_eq!(untouched_entry.archive_size, 18);

    // Rebuild and verify via the read-side inventory: the replaced
    // entry's payload hash now equals the sha256 of the new bytes,
    // and the table records the new size.
    let rebuilt = pack_plain_xp3_from_directory(&dir).unwrap();
    let inventory = read_plain_xp3_inventory(&rebuilt).unwrap();
    let intro = inventory
        .entries
        .iter()
        .find(|entry| entry.path == "scenario/intro.ks")
        .unwrap();
    assert_eq!(intro.original_size, replacement.len() as u64);
    assert_eq!(intro.archive_size, replacement.len() as u64);
    assert_eq!(
        intro.payload_hash.as_deref(),
        Some(sha256_hash_bytes(replacement).as_str())
    );
    assert_eq!(
        intro.stored_adler32.as_deref(),
        Some(format!("adler32:{expected_adler:08x}").as_str())
    );
    // The other plain entry survived the replacement untouched.
    let title = inventory
        .entries
        .iter()
        .find(|entry| entry.path == "image/title.png")
        .unwrap();
    assert_eq!(title.archive_size, 18);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn replace_plain_xp3_entry_rejects_tampered_payload_path_before_write() {
    let fixture_bytes = fs::read(repo_fixture_path("fixtures/kaifuu/kirikiri/plain.xp3")).unwrap();
    let root = temp_dir("plain-xp3-replace-tampered-payload");
    let dir = root.join("unpacked");
    let outside_path = root.join("escape.bin");
    unpack_plain_xp3_to_directory(&fixture_bytes, &dir).unwrap();

    let manifest_path = dir.join("manifest.json");
    let manifest_bytes = fs::read(&manifest_path).unwrap();
    let mut manifest: PlainXp3DirectoryManifest = serde_json::from_slice(&manifest_bytes).unwrap();
    let entry = manifest
        .entries
        .iter_mut()
        .find(|entry| entry.path == "scenario/intro.ks")
        .unwrap();
    let expected_original_size = entry.original_size;
    let expected_archive_size = entry.archive_size;
    entry.payload_relative_path = "../escape.bin".to_string();
    let tampered_manifest = serde_json::to_string_pretty(&manifest).unwrap();
    fs::write(&manifest_path, tampered_manifest).unwrap();

    let error = replace_plain_xp3_entry_payload(&dir, "scenario/intro.ks", b"must not escape\n")
        .unwrap_err();
    assert!(matches!(
        error,
        PlainXp3WriterError::UnsafeRelativePath(ref path) if path == "../escape.bin"
    ));
    assert!(
        !outside_path.exists(),
        "replace must reject the tampered payloadRelativePath before writing outside dir"
    );

    let persisted_manifest: PlainXp3DirectoryManifest =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    let persisted_entry = persisted_manifest
        .entries
        .iter()
        .find(|entry| entry.path == "scenario/intro.ks")
        .unwrap();
    assert_eq!(
        persisted_entry.original_size, expected_original_size,
        "replace must fail before mutating manifest metadata"
    );
    assert_eq!(
        persisted_entry.archive_size, expected_archive_size,
        "replace must fail before mutating manifest metadata"
    );

    let _ = fs::remove_dir_all(&root);
}

/// SECURITY regression (symlink-traversal hardening): a symlink
/// planted inside the unpack directory must not let `replace` follow it out
/// of the root, even when the manifest-declared relative path is
/// string-safe. We swap the real `payload/` subdir for a symlink pointing
/// OUTSIDE the root; the string check passes ("payload/..." has no `..`),
/// but the fd-relative `O_NOFOLLOW` materialization refuses the traversal
/// and the outside target is never written.
/// Mutation proof: reverting `write_no_follow` to a plain `dir.join(rel)` +
/// `fs::write` makes the write follow the symlink and create the escaped
/// target, flipping the `!escaped_target.exists` assertion to a failure.
#[cfg(unix)]
#[test]
fn replace_plain_xp3_entry_refuses_symlinked_payload_dir() {
    use std::os::unix::fs::symlink;

    let fixture_bytes = fs::read(repo_fixture_path("fixtures/kaifuu/kirikiri/plain.xp3")).unwrap();
    let root = temp_dir("plain-xp3-replace-symlink-dir");
    let dir = root.join("unpacked");
    unpack_plain_xp3_to_directory(&fixture_bytes, &dir).unwrap();

    // Attacker-controlled area OUTSIDE the unpack root.
    let outside = root.join("outside");
    fs::create_dir_all(&outside).unwrap();

    let manifest: PlainXp3DirectoryManifest =
        serde_json::from_slice(&fs::read(dir.join("manifest.json")).unwrap()).unwrap();
    let target = manifest
        .entries
        .iter()
        .find(|entry| entry.path == "scenario/intro.ks")
        .unwrap();
    let leaf = target
        .payload_relative_path
        .strip_prefix("payload/")
        .expect("payload path stays inside the payload/ subdir");
    let escaped_target = outside.join(leaf);

    // Replace the real `payload/` directory with a symlink pointing outside
    // the root. The manifest's payloadRelativePath is still "payload/...".
    let payload_dir = dir.join("payload");
    fs::remove_dir_all(&payload_dir).unwrap();
    symlink(&outside, &payload_dir).unwrap();

    let error = replace_plain_xp3_entry_payload(&dir, "scenario/intro.ks", b"must not escape\n")
        .unwrap_err();
    assert!(
        matches!(
            error,
            PlainXp3WriterError::SymlinkTraversalRefused(ref path)
                if *path == target.payload_relative_path
        ),
        "replace must refuse the symlinked payload dir with SymlinkTraversalRefused, got {error:?}"
    );
    assert_eq!(
        error.semantic_code(),
        "kaifuu.plain_xp3_writer.symlink_traversal_refused"
    );
    assert!(
        !escaped_target.exists(),
        "replace must not follow the symlinked payload/ dir out of the root"
    );

    let _ = fs::remove_dir_all(&root);
}

/// SECURITY regression: the read side (`pack`) must also refuse a symlink
/// component, so a tampered manifest plus a planted symlink cannot
/// exfiltrate a file outside the root. We stage look-alike payload files in
/// a secret dir outside the root and symlink `payload/` at it; the read is
/// refused rather than following the link.
/// Mutation proof: reverting `read_no_follow` to `fs::read(dir.join(rel))`
/// makes the read follow the symlink and load the outside bytes, so the
/// error becomes `InconsistentManifest`/`Io` instead of
/// `SymlinkTraversalRefused` and the assertion fails.
#[cfg(unix)]
#[test]
fn pack_plain_xp3_refuses_symlinked_payload_dir() {
    use std::os::unix::fs::symlink;

    let fixture_bytes = fs::read(repo_fixture_path("fixtures/kaifuu/kirikiri/plain.xp3")).unwrap();
    let root = temp_dir("plain-xp3-pack-symlink-dir");
    let dir = root.join("unpacked");
    unpack_plain_xp3_to_directory(&fixture_bytes, &dir).unwrap();

    let secret = root.join("secret");
    fs::create_dir_all(&secret).unwrap();
    let manifest: PlainXp3DirectoryManifest =
        serde_json::from_slice(&fs::read(dir.join("manifest.json")).unwrap()).unwrap();
    for entry in &manifest.entries {
        let leaf = entry
            .payload_relative_path
            .strip_prefix("payload/")
            .expect("payload path stays inside the payload/ subdir");
        fs::write(secret.join(leaf), b"secret-outside-root").unwrap();
    }

    let payload_dir = dir.join("payload");
    fs::remove_dir_all(&payload_dir).unwrap();
    symlink(&secret, &payload_dir).unwrap();

    let error = pack_plain_xp3_from_directory(&dir).unwrap_err();
    assert!(
        matches!(error, PlainXp3WriterError::SymlinkTraversalRefused(_)),
        "pack must refuse the symlinked payload dir on read, got {error:?}"
    );

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn replace_plain_xp3_entry_refuses_compressed_entry() {
    // Acceptance criterion: "Encrypted, compressed-unknown, or
    // helper-required profiles fail before writes with semantic
    // diagnostics." Compressed-entry replacement is the
    // compressed-unknown path: does not claim
    // recompression, so the writer refuses with the matching
    // semantic diagnostic before mutating the directory.
    let fixture_bytes = fs::read(repo_fixture_path("fixtures/kaifuu/kirikiri/plain.xp3")).unwrap();
    let dir = temp_dir("plain-xp3-replace-compressed");
    unpack_plain_xp3_to_directory(&fixture_bytes, &dir).unwrap();

    let error = replace_plain_xp3_entry_payload(
        &dir,
        "scenario/compressed.ks",
        b"would require recompression\n",
    )
    .unwrap_err();
    assert!(matches!(
        error,
        PlainXp3WriterError::UnsupportedCompressedReplacement(_)
    ));
    assert_eq!(
        error.semantic_code(),
        SEMANTIC_UNSUPPORTED_VARIANT_PACKED,
        "compressed-entry refusal must surface kaifuu.unsupported_variant.packed"
    );

    // No write happened: rebuilding the directory still yields the
    // original fixture bytes.
    let rebuilt = pack_plain_xp3_from_directory(&dir).unwrap();
    assert_eq!(rebuilt, fixture_bytes);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_plain_xp3_archive_refuses_encrypted_with_semantic_diagnostic() {
    // Acceptance criterion: "Encrypted... profiles fail before
    // writes with semantic diagnostics."
    let encrypted_bytes = b"XP3\r\nXP3-CRYPT\nkaifuu-xp3-encrypted fixture\n";
    let error = read_plain_xp3_archive(encrypted_bytes).unwrap_err();
    assert_eq!(error, PlainXp3WriterError::UnsupportedEncrypted);
    assert_eq!(
        error.semantic_code(),
        SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED
    );

    // Unpack must refuse before creating the target directory.
    let dir = temp_dir("plain-xp3-encrypted-refusal");
    // We don't pre-create the directory — unpack creates it on the
    // happy path. The encrypted path must refuse before any side
    // effect, so `dir` should not be populated.
    let target_dir = dir.join("unpacked");
    let error = unpack_plain_xp3_to_directory(encrypted_bytes, &target_dir).unwrap_err();
    assert_eq!(error, PlainXp3WriterError::UnsupportedEncrypted);
    assert!(
        !target_dir.exists(),
        "encrypted unpack must not create the target directory"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_plain_xp3_archive_refuses_compressed_profile_with_packed_semantic_diagnostic() {
    // Acceptance criterion: "... compressed-unknown... profiles
    // fail before writes with semantic diagnostics."
    let compressed_bytes = b"XP3\r\nXP3-COMPRESSED\nkaifuu-xp3-compressed fixture\n";
    let error = read_plain_xp3_archive(compressed_bytes).unwrap_err();
    assert_eq!(error, PlainXp3WriterError::UnsupportedCompressed);
    assert_eq!(error.semantic_code(), SEMANTIC_UNSUPPORTED_VARIANT_PACKED);
    assert!(
        error
            .to_string()
            .contains(SEMANTIC_UNSUPPORTED_VARIANT_PACKED),
        "compressed-profile refusal must surface kaifuu.unsupported_variant.packed"
    );

    // Unpack must refuse before creating the target directory.
    let dir = temp_dir("plain-xp3-compressed-refusal");
    let target_dir = dir.join("unpacked");
    let error = unpack_plain_xp3_to_directory(compressed_bytes, &target_dir).unwrap_err();
    assert_eq!(error, PlainXp3WriterError::UnsupportedCompressed);
    assert!(
        !target_dir.exists(),
        "compressed unpack must not create the target directory"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_plain_xp3_archive_refuses_helper_required_with_semantic_diagnostic() {
    // Acceptance criterion: "... helper-required profiles fail
    // before writes with semantic diagnostics."
    let helper_bytes = b"XP3\r\nXP3-HELPER-REQUIRED\nkaifuu-xp3-helper-required fixture\n";
    let error = read_plain_xp3_archive(helper_bytes).unwrap_err();
    assert_eq!(error, PlainXp3WriterError::UnsupportedHelperRequired);
    assert_eq!(error.semantic_code(), SEMANTIC_HELPER_REQUIRED);

    let dir = temp_dir("plain-xp3-helper-required-refusal");
    let target_dir = dir.join("unpacked");
    let error = unpack_plain_xp3_to_directory(helper_bytes, &target_dir).unwrap_err();
    assert_eq!(error, PlainXp3WriterError::UnsupportedHelperRequired);
    assert!(!target_dir.exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_plain_xp3_archive_refuses_unknown_container_with_semantic_diagnostic() {
    // Acceptance criterion (protected-executable / unknown
    // container variant of "fail before writes").
    let protected_bytes = b"MZ\x90\0\x03\0\0\0PROTECTED-EXECUTABLE\n";
    let error = read_plain_xp3_archive(protected_bytes).unwrap_err();
    assert_eq!(error, PlainXp3WriterError::UnsupportedProtectedExecutable);
    assert_eq!(
        error.semantic_code(),
        SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED
    );
}

#[test]
fn encode_xp3_refuses_non_plain_variant_with_semantic_diagnostic() {
    let archive = PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: "encrypted".to_string(),
        entries: Vec::new(),
    };
    let error = encode_xp3(&archive).unwrap_err();
    assert!(
        matches!(error, PlainXp3WriterError::UnsupportedVariant(ref variant) if variant == "encrypted")
    );
    assert_eq!(error.semantic_code(), SEMANTIC_UNSUPPORTED_ENGINE_VARIANT);
}

#[test]
fn encode_xp3_rejects_inconsistent_manifest() {
    // Inconsistent manifest: declared archive_size does not match
    // segment archive_size sum.
    let archive = PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries: vec![PlainXp3ArchiveEntry {
            path: "scenario/intro.ks".to_string(),
            original_size: 10,
            archive_size: 10,
            stored_adler32: None,
            segments: vec![PlainXp3ArchiveSegment {
                flags: 0,
                original_size: 5,
                archive_size: 5,
            }],
            payload: vec![0; 5],
        }],
    };
    let error = encode_xp3(&archive).unwrap_err();
    assert!(matches!(
        error,
        PlainXp3WriterError::InconsistentManifest(_)
    ));
}

#[test]
fn encode_xp3_rejects_path_exceeding_u16_utf16_units() {
    // A path longer than u16::MAX UTF-16 units cannot be written
    // truthfully into the info chunk's u16 path-length field. The
    // writer must surface InconsistentManifest rather than silently
    // truncating the count while emitting the full path payload.
    let long_path = "a".repeat(usize::from(u16::MAX) + 1);
    let archive = PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries: vec![PlainXp3ArchiveEntry {
            path: long_path,
            original_size: 0,
            archive_size: 0,
            stored_adler32: None,
            segments: vec![],
            payload: vec![],
        }],
    };
    let error = encode_xp3(&archive).unwrap_err();
    assert!(matches!(
        error,
        PlainXp3WriterError::InconsistentManifest(_)
    ));
}

#[test]
fn encode_xp3_rejects_unsafe_relative_path() {
    let archive = PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries: vec![PlainXp3ArchiveEntry {
            path: "../escape.ks".to_string(),
            original_size: 1,
            archive_size: 1,
            stored_adler32: None,
            segments: vec![PlainXp3ArchiveSegment {
                flags: 0,
                original_size: 1,
                archive_size: 1,
            }],
            payload: vec![0],
        }],
    };
    let error = encode_xp3(&archive).unwrap_err();
    assert!(matches!(error, PlainXp3WriterError::UnsafeRelativePath(_)));
}

#[test]
fn compute_adler32_matches_zlib_reference_vectors() {
    // Known Adler-32 reference vectors.
    assert_eq!(compute_adler32(b""), 1);
    assert_eq!(compute_adler32(b"abc"), 0x024d_0127);
    assert_eq!(compute_adler32(b"Wikipedia"), 0x11e6_0398);
}
