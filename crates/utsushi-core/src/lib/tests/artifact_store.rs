use super::*;
pub(super) fn runtime_artifact_names_are_deterministic_and_managed() {
    let uri = runtime_artifact_uri(
        "019ed003-0000-7000-8000-000000001000",
        RuntimeArtifactKind::Screenshot,
        "019ed003-0000-7000-8000-000000002000",
    )
    .unwrap();

    assert_eq!(
        uri,
        "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000001000/screenshots/019ed003-0000-7000-8000-000000002000.png"
    );
    assert_eq!(RuntimeArtifactKind::TraceLog.artifact_kind(), "trace_log");
    assert_eq!(
        RuntimeArtifactKind::FrameCapture.artifact_kind(),
        "frame_capture"
    );
    assert_eq!(RuntimeArtifactKind::Recording.artifact_kind(), "recording");
    assert_eq!(
        RuntimeArtifactKind::ConformanceReport.artifact_kind(),
        "reference_comparison"
    );
    assert!(validate_runtime_artifact_uri(&uri).is_ok());
}

pub(super) fn runtime_artifact_paths_reject_traversal_and_external_uris() {
    for uri in [
        "../capture.png",
        "artifacts/utsushi/runtime/run/screenshots/../capture.png",
        "artifacts/utsushi/runtime/run/screenshots/./capture.png",
        "/tmp/capture.png",
        "file:///tmp/capture.png",
        "data:image/png;base64,AAAA",
        "artifacts\\utsushi\\runtime\\run\\capture.png",
        "artifacts/utsushi/hello/frame.png",
    ] {
        assert!(
            validate_runtime_artifact_uri(uri).is_err(),
            "{uri} should be rejected"
        );
    }
}

pub(super) fn runtime_artifact_root_maps_uris_inside_managed_root() {
    let temp = temp_root("artifact-path");
    let root = RuntimeArtifactRoot::new(temp.join("runtime-artifacts"));
    let uri = runtime_artifact_uri("run-1", RuntimeArtifactKind::TraceLog, "trace-1").unwrap();

    let path = root.artifact_path(&uri).unwrap();

    assert!(path.starts_with(root.path()));
    assert_eq!(path.file_name().unwrap(), "trace-1.json");
    assert!(root.artifact_path("../source.json").is_err());
    let _ = fs::remove_dir_all(temp);
}

pub(super) fn runtime_artifact_cleanup_requires_marker_and_keeps_other_roots() {
    let temp = temp_root("cleanup");
    let source_game = temp.join("game");
    let local_corpus = temp.join("local-corpus");
    let benchmark = temp.join("benchmark-output");
    let patch_output = temp.join("patch-output");
    for dir in [&source_game, &local_corpus, &benchmark, &patch_output] {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("keep.txt"), "not managed by utsushi runtime\n").unwrap();
    }

    let source_root = RuntimeArtifactRoot::new(&source_game);
    assert!(source_root.cleanup_contents().is_err());
    assert!(source_game.join("keep.txt").is_file());

    let managed_path = temp.join("runtime-artifacts");
    let managed_root = RuntimeArtifactRoot::new(&managed_path);
    managed_root.prepare().unwrap();
    let uri =
        runtime_artifact_uri("run-cleanup", RuntimeArtifactKind::Recording, "recording-1").unwrap();
    let artifact_path = managed_root
        .write_bytes(&uri, b"runtime recording reference")
        .unwrap();
    assert!(artifact_path.is_file());

    managed_root.cleanup_contents().unwrap();

    assert!(managed_path.join(RUNTIME_ARTIFACT_ROOT_MARKER).is_file());
    assert!(!artifact_path.exists());
    for dir in [&source_game, &local_corpus, &benchmark, &patch_output] {
        assert!(dir.join("keep.txt").is_file());
    }
    let _ = fs::remove_dir_all(temp);
}

pub(super) fn runtime_artifact_prepare_refuses_non_empty_unmarked_roots() {
    let temp = temp_root("adoption");
    let source_game = temp.join("game");
    fs::create_dir_all(&source_game).unwrap();
    fs::write(source_game.join("keep.txt"), "source content\n").unwrap();

    let root = RuntimeArtifactRoot::new(&source_game);
    let error = root.prepare().unwrap_err().to_string();

    assert!(error.contains("non-empty unmarked"));
    assert!(source_game.join("keep.txt").is_file());
    assert!(!source_game.join(RUNTIME_ARTIFACT_ROOT_MARKER).exists());
    let _ = fs::remove_dir_all(temp);
}

pub(super) fn runtime_artifact_cleanup_refuses_marked_source_roots() {
    let temp = temp_root("marked-source");
    let source_root = temp.join("repo");
    fs::create_dir_all(&source_root).unwrap();
    fs::write(
        source_root.join("Cargo.toml"),
        "[package]\nname = \"source\"\n",
    )
    .unwrap();
    fs::write(
        source_root.join(RUNTIME_ARTIFACT_ROOT_MARKER),
        "managed-by=utsushi-runtime\n",
    )
    .unwrap();
    fs::write(source_root.join("keep.txt"), "source content\n").unwrap();

    let root = RuntimeArtifactRoot::new(&source_root);
    let error = root.cleanup_contents().unwrap_err().to_string();

    assert!(error.contains("obvious source or project root"));
    assert!(source_root.join("Cargo.toml").is_file());
    assert!(source_root.join("keep.txt").is_file());
    let _ = fs::remove_dir_all(temp);
}

#[cfg(unix)]
pub(super) fn runtime_artifact_write_rejects_symlink_parent_components() {
    use std::os::unix::fs as unix_fs;

    let temp = temp_root("symlink-parent");
    let managed_path = temp.join("runtime-artifacts");
    let outside = temp.join("outside");
    fs::create_dir_all(&outside).unwrap();
    let root = RuntimeArtifactRoot::new(&managed_path);
    root.prepare().unwrap();
    unix_fs::symlink(&outside, managed_path.join("run-link")).unwrap();
    let uri = runtime_artifact_uri("run-link", RuntimeArtifactKind::TraceLog, "trace-1").unwrap();

    let error = root.write_bytes(&uri, b"trace").unwrap_err().to_string();

    assert!(error.contains("symlink"));
    assert!(!outside.join("traces").exists());
    let _ = fs::remove_dir_all(temp);
}

#[cfg(unix)]
pub(super) fn runtime_artifact_write_rejects_symlink_destinations() {
    use std::os::unix::fs as unix_fs;

    let temp = temp_root("symlink-destination");
    let managed_path = temp.join("runtime-artifacts");
    let outside = temp.join("outside.txt");
    fs::write(&outside, "outside content\n").unwrap();
    let root = RuntimeArtifactRoot::new(&managed_path);
    root.prepare().unwrap();
    let uri = runtime_artifact_uri("run-dest", RuntimeArtifactKind::TraceLog, "trace-1").unwrap();
    let artifact_path = root.artifact_path(&uri).unwrap();
    fs::create_dir_all(artifact_path.parent().unwrap()).unwrap();
    unix_fs::symlink(&outside, &artifact_path).unwrap();

    let error = root.write_bytes(&uri, b"trace").unwrap_err().to_string();

    assert!(error.contains("symlink"));
    assert_eq!(fs::read_to_string(&outside).unwrap(), "outside content\n");
    let _ = fs::remove_dir_all(temp);
}

// crux: a concurrent actor SWAPS a validated run directory for a
// symlink pointing OUTSIDE the managed root while writes are in flight. The
// fd-relative / no-follow write path must never follow the swapped-in link
// so nothing is ever created under the escape target — proving the TOCTOU
// window between "validated as a real directory" and "written into" is shut.
#[cfg(unix)]
pub(super) fn runtime_artifact_write_cannot_escape_via_concurrent_symlink_swap() {
    use std::os::unix::fs as unix_fs;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    let temp = temp_root("swap-escape");
    let managed = temp.join("runtime-artifacts");
    let outside = temp.join("outside");
    fs::create_dir_all(&outside).unwrap();
    let root = RuntimeArtifactRoot::new(&managed);
    root.prepare().unwrap();

    // "swap" is the run id, so the first path component the writer descends
    // into is `managed/swap`; that is exactly what the attacker swaps.
    let swap_path = managed.join("swap");
    let stop = Arc::new(AtomicBool::new(false));

    let bg_stop = Arc::clone(&stop);
    let bg_target = outside.clone();
    let bg_path = swap_path.clone();
    let attacker = std::thread::spawn(move || {
        while !bg_stop.load(Ordering::Relaxed) {
            // Plant a symlink to the escape target where the run directory
            // lives; a path-following writer would create the artifact tree
            // under `outside` instead of `managed`.
            let _ = unix_fs::symlink(&bg_target, &bg_path);
            std::thread::yield_now();
            // Tear down whatever is there (our own link, or a real dir the
            // writer created) so the swap keeps cycling.
            match fs::symlink_metadata(&bg_path) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    let _ = fs::remove_file(&bg_path);
                }
                Ok(meta) if meta.is_dir() => {
                    let _ = fs::remove_dir_all(&bg_path);
                }
                _ => {}
            }
            std::thread::yield_now();
        }
    });

    let uri = runtime_artifact_uri("swap", RuntimeArtifactKind::Screenshot, "frame").unwrap();
    for _ in 0..4000 {
        // Each write either lands inside `managed` or fails — it must NEVER
        // create anything under the swapped-in symlink's target.
        let _ = root.write_bytes(&uri, b"frame-bytes");
        assert!(
            !outside.join("screenshots").exists(),
            "write escaped the managed root through a swapped-in symlink"
        );
    }

    stop.store(true, Ordering::Relaxed);
    attacker.join().unwrap();

    // End state: the escape target was never populated by any write.
    let escaped: Vec<_> = fs::read_dir(&outside)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(
        escaped.is_empty(),
        "escape target must remain empty, found: {escaped:?}"
    );

    // The legitimate case still works once contention stops.
    let _ = fs::remove_dir_all(&swap_path);
    let path = root.write_bytes(&uri, b"frame-bytes").unwrap();
    assert!(path.starts_with(&managed));
    assert_eq!(fs::read(&path).unwrap(), b"frame-bytes");

    let _ = fs::remove_dir_all(temp);
}

// the soft artifact-byte budget is enforced on the REAL
// artifact-store write path (RuntimeArtifactRoot::write_bytes), not a
// cfg(test) shim. An over-budget write surfaces SinkError::BudgetExhausted
// with the artifact-store sink id + budget label; an under-budget write
// succeeds and lands under the managed root.
#[cfg(unix)]
pub(super) fn write_bytes_over_soft_byte_budget_surfaces_budget_exhausted_on_real_path() {
    let temp = temp_root("soft-byte-budget");
    let managed = temp.join("runtime-artifacts");
    let root = RuntimeArtifactRoot::new(&managed).with_soft_byte_budget(8);
    root.prepare().unwrap();

    let uri = runtime_artifact_uri("run", RuntimeArtifactKind::Screenshot, "frame").unwrap();

    // Under budget: the real write succeeds and lands under the managed
    // root with the exact bytes — no false BudgetExhausted.
    let ok = root.write_bytes(&uri, b"12345678").unwrap();
    assert!(ok.starts_with(&managed));
    assert_eq!(fs::read(&ok).unwrap(), b"12345678");

    // Over budget: the real write path surfaces SinkError::BudgetExhausted
    // (boxed into UtsushiResult), downcast back to the stable diagnostic.
    let error = root
        .write_bytes(&uri, b"123456789")
        .expect_err("over-budget write must be rejected");
    let sink_error = error
        .downcast_ref::<SinkError>()
        .expect("over-budget write must box a SinkError");
    match sink_error {
        SinkError::BudgetExhausted { sink, budget } => {
            assert_eq!(*sink, SinkKind::FrameArtifact);
            assert_eq!(budget, RUNTIME_ARTIFACT_SOFT_BYTE_BUDGET_LABEL);
            assert_eq!(budget, "frame_byte_cap");
        }
        other => panic!("expected BudgetExhausted, got {other:?}"),
    }

    // The rejected over-budget write must not have mutated the artifact:
    // it targets the same managed path as the under-budget write (same
    // URI), so that on-disk file must still hold the under-budget payload
    // exactly — never the over-budget bytes that were rejected.
    assert_eq!(
        fs::read(&ok).unwrap(),
        b"12345678",
        "rejected over-budget write must leave the artifact bytes unchanged"
    );

    let _ = fs::remove_dir_all(temp);
}

// a root with no configured budget never rejects a write for
// budget reasons — the historical unbudgeted behaviour is preserved.
#[cfg(unix)]
pub(super) fn write_bytes_without_soft_byte_budget_never_rejects_for_budget() {
    let temp = temp_root("no-soft-byte-budget");
    let managed = temp.join("runtime-artifacts");
    let root = RuntimeArtifactRoot::new(&managed);
    root.prepare().unwrap();

    let uri = runtime_artifact_uri("run", RuntimeArtifactKind::Screenshot, "frame").unwrap();
    let large = vec![0u8; 4096];
    let path = root.write_bytes(&uri, &large).unwrap();
    assert!(path.starts_with(&managed));
    assert_eq!(fs::read(&path).unwrap().len(), large.len());

    let _ = fs::remove_dir_all(temp);
}

// cleanup traverses ONLY real directories. A symlink anywhere
// in the managed tree (top-level or nested) is unlinked in place — the link
// itself is removed and is never recursed into — so cleanup can never follow
// a symlink to a target outside the root.
#[cfg(unix)]
pub(super) fn runtime_artifact_cleanup_does_not_follow_symlink_out_of_root() {
    use std::os::unix::fs as unix_fs;

    let temp = temp_root("cleanup-symlink-escape");
    let managed = temp.join("runtime-artifacts");
    let outside = temp.join("outside");
    fs::create_dir_all(&outside).unwrap();
    let secret = outside.join("secret.txt");
    fs::write(&secret, "must survive cleanup\n").unwrap();

    let root = RuntimeArtifactRoot::new(&managed);
    root.prepare().unwrap();

    // A genuine artifact the cleanup should remove.
    let uri = runtime_artifact_uri("run", RuntimeArtifactKind::TraceLog, "trace-1").unwrap();
    let real = root.write_bytes(&uri, b"trace").unwrap();
    assert!(real.is_file());

    // A symlink nested deep in the managed tree, pointing at the outside
    // directory, plus a top-level symlink pointing at the outside file.
    let nested = managed.join("run").join("nested");
    fs::create_dir_all(&nested).unwrap();
    unix_fs::symlink(&outside, nested.join("escape-dir")).unwrap();
    unix_fs::symlink(&secret, managed.join("escape-file")).unwrap();

    root.cleanup_contents().unwrap();

    // Only the managed-root marker survives inside the root.
    let mut remaining: Vec<_> = fs::read_dir(&managed)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    remaining.sort();
    assert_eq!(
        remaining,
        vec![std::ffi::OsString::from(RUNTIME_ARTIFACT_ROOT_MARKER)]
    );

    // The symlink targets outside the root were NOT followed or removed.
    assert!(outside.is_dir(), "outside directory must survive cleanup");
    assert_eq!(
        fs::read_to_string(&secret).unwrap(),
        "must survive cleanup\n",
        "outside file must survive cleanup"
    );

    let _ = fs::remove_dir_all(temp);
}
