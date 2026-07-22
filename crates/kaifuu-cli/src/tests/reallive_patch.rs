/// kaifuu-patch-touch-archive-not-copy-game-tree (pilot throughput):
/// the reallive patch flow must TOUCH ONLY the target archive — it must
/// NOT copy the multi-GB voice/image siblings of the game tree. This
/// test seeds a source tree with the real-shape `REALLIVEDATA/Seen.txt`
/// PLUS two large siblings (`voice/`, `image/`) standing in for the
/// ~5.7GB of assets a real title carries, runs the patch, and asserts:
/// - the ONLY file materialised under the target is
///   `REALLIVEDATA/Seen.txt` (no sibling was copied — the filesystem
///   footprint is exactly the target archive, so a per-scene patch is
///   target-sized, not full-tree-sized);
/// - the patched target archive is byte-for-byte the canonical
///   `apply_translated_bundle` output (declared text changes only — the
///   same byte-correct-patchback contract the round-trip tests assert);
/// - the source tree (Seen.txt AND both siblings) is untouched.
#[test]
fn patch_reallive_touches_only_target_archive_not_multi_gb_siblings() {
    use crate::binary_patch_smoke::{
        build_synthetic_seen_txt, build_synthetic_translated_bundle_json,
    };

    let root = temp_dir("patch-reallive-touch-archive-only");
    let source_root = root.join("source-game-tree");
    let source_data = source_root.join("REALLIVEDATA");
    fs::create_dir_all(&source_data).unwrap();

    let source_seen_bytes = build_synthetic_seen_txt();
    let source_seen_path = source_data.join("Seen.txt");
    fs::write(&source_seen_path, &source_seen_bytes).unwrap();
    let source_seen_hash_before = sha256_hash_bytes(&source_seen_bytes);

    // Large siblings standing in for the multi-GB voice/image trees a
    // real title ships. If the patch flow copied the whole tree these
    // would be duplicated under the target (~infeasible at scale). ~1MB
    // each keeps the test fast while remaining clearly "not the 3.7MB
    // archive".
    let big_sibling = vec![0xABu8; 1_048_576];
    let voice_dir = source_root.join("voice");
    let image_dir = source_root.join("image");
    fs::create_dir_all(&voice_dir).unwrap();
    fs::create_dir_all(&image_dir).unwrap();
    fs::write(voice_dir.join("z0001.ogg"), &big_sibling).unwrap();
    fs::write(image_dir.join("bg0001.g00"), &big_sibling).unwrap();

    // A valid translated bundle over the synthetic dialogue unit.
    let bundle_value = build_synthetic_translated_bundle_json("うえ", "reallive:scene-0001#0000");
    let bundle_path = root.join("translated-bundle.json");
    fs::write(
        &bundle_path,
        serde_json::to_vec_pretty(&bundle_value).unwrap(),
    )
    .unwrap();

    let target_root = root.join("target-patched");

    run_patch_reallive_bundle(
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
            "--scope",
            "dialogue-only",
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>(),
    )
    .expect("patch must succeed");

    let target_seen_path = target_root.join("REALLIVEDATA").join("Seen.txt");
    assert!(
        target_seen_path.is_file(),
        "patched target Seen.txt must exist"
    );

    // Walk the whole target tree and collect every regular file. The
    // ONLY file must be REALLIVEDATA/Seen.txt — no voice/image sibling
    // was copied.
    let mut files: Vec<PathBuf> = Vec::new();
    let mut stack = vec![target_root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                files.push(path);
            }
        }
    }
    assert_eq!(
        files,
        vec![target_seen_path.clone()],
        "the patch must touch ONLY the target archive; the multi-GB voice/image \
             siblings must NOT be copied into the target (found: {files:?})"
    );
    assert!(
        !target_root.with_extension("kaifuu").exists(),
        "without --delta-output, the compatible sparse-overlay command must not produce a default delta"
    );
    assert!(
        !target_root.join("voice").exists(),
        "voice sibling tree must not be copied to the target"
    );
    assert!(
        !target_root.join("image").exists(),
        "image sibling tree must not be copied to the target"
    );

    let target_seen_bytes = fs::read(&target_seen_path).unwrap();
    let translated =
        kaifuu_reallive::TranslatedBundleV02::from_json(&bundle_value).expect("bundle parses");
    let expected = kaifuu_reallive::apply_translated_bundle(
        &source_seen_bytes,
        &translated,
        &kaifuu_reallive::PatchbackOpts::shift_jis(kaifuu_reallive::TranslationScope::DialogueOnly),
    )
    .expect("canonical patchback succeeds");
    assert_eq!(
        target_seen_bytes, expected,
        "patched target archive must be byte-for-byte the canonical patchback output \
             (declared text changes only)"
    );
    // The patched archive still re-parses to the source's scene count.
    let src_index = kaifuu_reallive::parse_archive(&source_seen_bytes).unwrap();
    let tgt_index = kaifuu_reallive::parse_archive(&target_seen_bytes).unwrap();
    assert_eq!(tgt_index.entries.len(), src_index.entries.len());

    assert_eq!(
        sha256_hash_bytes(&fs::read(&source_seen_path).unwrap()),
        source_seen_hash_before,
        "source Seen.txt must be sha256-unchanged"
    );
    assert_eq!(
        fs::read(voice_dir.join("z0001.ogg")).unwrap(),
        big_sibling,
        "source voice sibling must be untouched"
    );
    assert_eq!(
        fs::read(image_dir.join("bg0001.g00")).unwrap(),
        big_sibling,
        "source image sibling must be untouched"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_reallive_delta_output_replaces_seen_and_inherits_source_siblings() {
    use crate::binary_patch_smoke::{
        build_synthetic_seen_txt, build_synthetic_translated_bundle_json,
    };

    let root = temp_dir("patch-reallive-delta-output");
    let source_root = root.join("source-game-tree");
    let source_data = source_root.join("REALLIVEDATA");
    fs::create_dir_all(&source_data).unwrap();
    let source_seen = build_synthetic_seen_txt();
    fs::write(source_data.join("Seen.txt"), &source_seen).unwrap();
    fs::write(source_root.join("voice.ogg"), b"source voice sibling").unwrap();
    fs::create_dir_all(source_root.join("config")).unwrap();
    fs::write(
        source_root.join("config/settings.bin"),
        b"source config sibling",
    )
    .unwrap();

    let bundle = build_synthetic_translated_bundle_json("うえ", "reallive:scene-0001#0000");
    let bundle_path = root.join("translated-bundle.json");
    fs::write(&bundle_path, serde_json::to_vec_pretty(&bundle).unwrap()).unwrap();
    let target_root = root.join("sparse-target");
    let delta_path = root.join("replacement.kaifuu");

    run_patch_reallive_bundle(
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
            "--scope",
            "dialogue-only",
            "--delta-output",
            delta_path.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>(),
    )
    .expect("patch and replacement delta must succeed");

    let target_seen_path = target_root.join("REALLIVEDATA/Seen.txt");
    let target_seen = fs::read(&target_seen_path).unwrap();
    assert_ne!(
        target_seen, source_seen,
        "patchback must replace Seen.txt bytes"
    );
    let source_index = kaifuu_reallive::parse_archive(&source_seen).unwrap();
    let target_index = kaifuu_reallive::parse_archive(&target_seen).unwrap();
    assert_eq!(target_index.entries.len(), source_index.entries.len());
    assert!(
        !target_root.join("voice.ogg").exists() && !target_root.join("config").exists(),
        "the direct target remains a sparse Seen-only overlay"
    );

    let delta: serde_json::Value = read_json(&delta_path).unwrap();
    let changed = delta["changedEntries"].as_array().unwrap();
    assert_eq!(changed.len(), 1, "delta must contain one replacement entry");
    assert_eq!(changed[0]["path"], "REALLIVEDATA/Seen.txt");
    assert_eq!(changed[0]["operation"], "replace");
    assert!(
        !changed.iter().any(|entry| entry["operation"] == "delete"),
        "replacement-only output must never delete source siblings"
    );

    let applied_root = root.join("applied-full-tree");
    apply_delta(&source_root, &delta_path, &applied_root).unwrap();
    assert_eq!(
        fs::read(applied_root.join("REALLIVEDATA/Seen.txt")).unwrap(),
        target_seen
    );
    assert_eq!(
        fs::read(applied_root.join("voice.ogg")).unwrap(),
        b"source voice sibling"
    );
    assert_eq!(
        fs::read(applied_root.join("config/settings.bin")).unwrap(),
        b"source config sibling"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_reallive_rejects_delta_output_inside_source_before_target_write() {
    use crate::binary_patch_smoke::{
        build_synthetic_seen_txt, build_synthetic_translated_bundle_json,
    };

    let root = temp_dir("patch-reallive-delta-inside-source");
    let source_root = root.join("source-game-tree");
    let source_data = source_root.join("REALLIVEDATA");
    fs::create_dir_all(&source_data).unwrap();
    let source_seen = build_synthetic_seen_txt();
    fs::write(source_data.join("Seen.txt"), &source_seen).unwrap();
    let bundle = build_synthetic_translated_bundle_json("うえ", "reallive:scene-0001#0000");
    let bundle_path = root.join("translated-bundle.json");
    fs::write(&bundle_path, serde_json::to_vec_pretty(&bundle).unwrap()).unwrap();
    let target_root = root.join("sparse-target");
    let invalid_delta = source_root.join("must-not-write.kaifuu");

    let error = run_patch_reallive_bundle(
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
            "--scope",
            "dialogue-only",
            "--delta-output",
            invalid_delta.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>(),
    )
    .unwrap_err()
    .to_string();

    assert!(
        error.contains("kaifuu.reallive.delta_output_inside_source"),
        "{error}"
    );
    assert_eq!(fs::read(source_data.join("Seen.txt")).unwrap(), source_seen);
    assert!(!invalid_delta.exists());
    assert!(
        !target_root.exists(),
        "rejected output must not create a target tree"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_promotion_rejects_empty_directory_created_after_staging() {
    let root = temp_dir("patch-promotion-empty-dir-race");
    let output_dir = root.join("patched-output");
    let staging_dir = allocate_patch_staging_dir(&output_dir).unwrap();
    fs::write(staging_dir.join("adapter-output.txt"), "staged output\n").unwrap();
    fs::create_dir(&output_dir).unwrap();

    let error = promote_patch_staging_dir(&staging_dir, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(
        error.contains("patch output directory already exists"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(staging_dir.join("adapter-output.txt")).unwrap(),
        "staged output\n"
    );
    assert!(fs::read_dir(&output_dir).unwrap().next().is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_promotion_rejects_existing_file_without_touching_staging_or_output() {
    let root = temp_dir("patch-promotion-existing-file");
    let output_dir = root.join("patched-output");
    let staging_dir = allocate_patch_staging_dir(&output_dir).unwrap();
    fs::write(staging_dir.join("adapter-output.txt"), "staged output\n").unwrap();
    fs::write(&output_dir, "existing file\n").unwrap();

    let error = promote_patch_staging_dir(&staging_dir, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(
        error.contains("patch output directory already exists"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(staging_dir.join("adapter-output.txt")).unwrap(),
        "staged output\n"
    );
    assert_eq!(fs::read_to_string(&output_dir).unwrap(), "existing file\n");
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn patch_promotion_rejects_existing_symlink_like_output() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("patch-promotion-existing-symlink");
    let output_dir = root.join("patched-output");
    let linked_target = root.join("linked-target");
    let staging_dir = allocate_patch_staging_dir(&output_dir).unwrap();
    fs::write(staging_dir.join("adapter-output.txt"), "staged output\n").unwrap();
    fs::create_dir(&linked_target).unwrap();
    unix_fs::symlink(&linked_target, &output_dir).unwrap();

    let error = promote_patch_staging_dir(&staging_dir, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(
        error.contains("patch output directory already exists"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(staging_dir.join("adapter-output.txt")).unwrap(),
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

#[test]
fn patch_command_cleans_staging_when_report_write_fails() {
    let root = temp_dir("patch-report-write-cleanup");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export_path = empty_patch_export(&root, 81);
    let output_dir = root.join("patched-output");
    let registry =
        patch_filesystem_failure_registry(PatchFilesystemFailureMode::ReportWriteCollision);

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

    assert!(result.is_err());
    assert!(!output_dir.exists());
    assert_no_patch_staging_entries(&root, "patched-output");

    let _ = fs::remove_dir_all(root);
}
