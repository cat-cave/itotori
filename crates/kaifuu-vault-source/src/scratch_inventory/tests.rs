use super::*;
use tempfile::tempdir;

/// Create a scratch game tree `<scratch>/<id>/extracted/<file>` with the
/// given content, and stamp its file mtime to `mtime_unix`.
fn make_game(scratch: &Path, id: &str, rel: &str, content: &[u8], mtime_unix: i64) -> PathBuf {
    let game_root = scratch.join(id);
    let file_path = game_root.join(rel);
    std::fs::create_dir_all(file_path.parent().unwrap()).unwrap();
    std::fs::write(&file_path, content).unwrap();
    set_mtime(&file_path, mtime_unix);
    game_root
}

fn set_mtime(path: &Path, mtime_unix: i64) {
    let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    let t = UNIX_EPOCH + std::time::Duration::from_secs(mtime_unix as u64);
    f.set_modified(t).unwrap();
}

#[test]
fn inventory_of_missing_scratch_root_is_empty_not_an_error() {
    let td = tempdir().unwrap();
    let missing = td.path().join("does-not-exist");
    let inv = inventory_scratch_root(&missing, true).unwrap();
    assert_eq!(inv.game_count, 0);
    assert_eq!(inv.total_size_bytes, 0);
    assert!(inv.games.is_empty());
}

#[test]
fn inventory_is_deterministic_and_machine_parseable_json() {
    let td = tempdir().unwrap();
    let scratch = td.path().join("scratch");
    make_game(&scratch, "v200", "extracted/a.txt", b"aaaa", 1_000);
    make_game(&scratch, "v100", "extracted/b/c.txt", b"cc", 2_000);

    let a = inventory_scratch_root(&scratch, true).unwrap();
    let b = inventory_scratch_root(&scratch, true).unwrap();
    // Two independent scans of an unchanged tree are byte-identical.
    let ja = serde_json::to_string(&a).unwrap();
    let jb = serde_json::to_string(&b).unwrap();
    assert_eq!(ja, jb);

    // Sorted by id, deterministically.
    assert_eq!(a.game_count, 2);
    assert_eq!(a.games[0].id, "v100");
    assert_eq!(a.games[1].id, "v200");
    assert_eq!(a.games[0].size_bytes, 2);
    assert_eq!(a.games[1].size_bytes, 4);
    assert_eq!(a.total_size_bytes, 6);
    // Content digest present + hex sha256 (64 hex chars).
    let sha = a.games[0].sha256.as_ref().unwrap();
    assert_eq!(sha.len(), 64);
    assert!(sha.chars().all(|c| c.is_ascii_hexdigit()));
    // mtime captured.
    assert_eq!(a.games[1].mtime_unix, Some(1_000));
}

#[test]
fn inventory_skips_symlinks_and_never_counts_their_targets() {
    let td = tempdir().unwrap();
    let scratch = td.path().join("scratch");
    let vault = td.path().join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    // A large file in the "vault".
    std::fs::write(vault.join("big.bin"), [0u8; 4096]).unwrap();

    let game = make_game(&scratch, "v1", "extracted/small.txt", b"hi", 500);
    // Symlink INSIDE the scratch tree pointing at the vault dir.
    #[cfg(unix)]
    std::os::unix::fs::symlink(&vault, game.join("vault-link")).unwrap();

    let inv = inventory_scratch_root(&scratch, false).unwrap();
    assert_eq!(inv.game_count, 1);
    // Only the 2-byte real file is counted; the 4096-byte vault file behind
    // the symlink is NOT.
    assert_eq!(inv.games[0].size_bytes, 2);
    assert_eq!(inv.games[0].file_count, 1);
}

#[test]
fn digest_ignores_mtime_but_reflects_content() {
    let td = tempdir().unwrap();
    let scratch = td.path().join("scratch");
    make_game(&scratch, "g", "f.txt", b"hello", 1_000);
    let sha1 = inventory_scratch_root(&scratch, true).unwrap().games[0]
        .sha256
        .clone()
        .unwrap();
    // Re-stamp mtime: digest must NOT change.
    set_mtime(&scratch.join("g/f.txt"), 9_999);
    let sha2 = inventory_scratch_root(&scratch, true).unwrap().games[0]
        .sha256
        .clone()
        .unwrap();
    assert_eq!(sha1, sha2);
    // Change content: digest MUST change.
    std::fs::write(scratch.join("g/f.txt"), b"world!!").unwrap();
    let sha3 = inventory_scratch_root(&scratch, true).unwrap().games[0]
        .sha256
        .clone()
        .unwrap();
    assert_ne!(sha1, sha3);
}

#[test]
fn prune_quota_evicts_least_recently_modified_until_under_cap() {
    let td = tempdir().unwrap();
    let scratch = td.path().join("scratch");
    // Four 100-byte trees, distinct mtimes (oldest → newest): old, mid, new, newest.
    make_game(&scratch, "old", "f", &[b'a'; 100], 1_000);
    make_game(&scratch, "mid", "f", &[b'b'; 100], 2_000);
    make_game(&scratch, "new", "f", &[b'c'; 100], 3_000);
    make_game(&scratch, "newest", "f", &[b'd'; 100], 4_000);

    let inv = inventory_scratch_root(&scratch, false).unwrap();
    assert_eq!(inv.total_size_bytes, 400);

    // Cap at 250 bytes → must evict the two oldest (old, mid) leaving 200.
    let plan = plan_prune(
        &inv,
        PrunePolicy::Quota {
            max_total_bytes: 250,
        },
        now_unix(),
    );
    let pruned_ids: Vec<&str> = plan.pruned.iter().map(|g| g.id.as_str()).collect();
    let kept_ids: Vec<&str> = plan.kept.iter().map(|g| g.id.as_str()).collect();
    assert_eq!(pruned_ids, vec!["mid", "old"]); // sorted by id in report
    assert_eq!(kept_ids, vec!["new", "newest"]);
    assert_eq!(plan.freed_bytes, 200);
    assert_eq!(plan.total_size_bytes_after, 200);

    // Execute and confirm the right dirs are gone / kept.
    execute_prune(&scratch, &plan).unwrap();
    assert!(!scratch.join("old").exists());
    assert!(!scratch.join("mid").exists());
    assert!(scratch.join("new").exists());
    assert!(scratch.join("newest").exists());
}

#[test]
fn prune_lru_horizon_removes_only_trees_older_than_the_age_cap() {
    let td = tempdir().unwrap();
    let scratch = td.path().join("scratch");
    let now = 10_000i64;
    // Two old (mtime 1000, 2000), two recent (mtime 9500, 9900).
    make_game(&scratch, "old-a", "f", b"x", 1_000);
    make_game(&scratch, "old-b", "f", b"x", 2_000);
    make_game(&scratch, "fresh-a", "f", b"x", 9_500);
    make_game(&scratch, "fresh-b", "f", b"x", 9_900);

    let inv = inventory_scratch_root(&scratch, false).unwrap();
    // Horizon of 5000s → threshold = 5000; prune mtime < 5000 (the two old).
    let plan = plan_prune(
        &inv,
        PrunePolicy::LruHorizon {
            max_age_secs: 5_000,
        },
        now,
    );
    let pruned_ids: Vec<&str> = plan.pruned.iter().map(|g| g.id.as_str()).collect();
    assert_eq!(pruned_ids, vec!["old-a", "old-b"]);
    assert_eq!(plan.kept.len(), 2);

    execute_prune(&scratch, &plan).unwrap();
    assert!(!scratch.join("old-a").exists());
    assert!(!scratch.join("old-b").exists());
    assert!(scratch.join("fresh-a").exists());
    assert!(scratch.join("fresh-b").exists());
}

#[test]
fn dry_run_reports_the_plan_without_removing_anything() {
    let td = tempdir().unwrap();
    let scratch = td.path().join("scratch");
    make_game(&scratch, "a", "f", &[0u8; 100], 1_000);
    make_game(&scratch, "b", "f", &[0u8; 100], 2_000);

    let plan = prune_scratch_root(
        &scratch,
        PrunePolicy::Quota {
            max_total_bytes: 100,
        },
        now_unix(),
        true, // dry-run
    )
    .unwrap();
    assert_eq!(plan.freed_bytes, 100);
    assert_eq!(plan.pruned.len(), 1);
    // Nothing actually removed.
    assert!(scratch.join("a").exists());
    assert!(scratch.join("b").exists());
}

/// THE HARD SAFETY INVARIANT: prune touches ONLY scratch. Even when a
/// scratch tree contains a symlink pointing into the vault, pruning that
/// tree (a) removes the scratch tree and (b) leaves the vault bytes
/// completely untouched.
#[test]
#[cfg(unix)]
fn prune_never_deletes_the_vault_even_through_a_symlink_into_it() {
    let td = tempdir().unwrap();
    let scratch = td.path().join("scratch");
    let vault = td.path().join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let precious = vault.join("catalog.db");
    std::fs::write(&precious, b"CANONICAL-VAULT-BYTES").unwrap();
    let precious_sub = vault.join("artifacts/by-id/precious.7z");
    std::fs::create_dir_all(precious_sub.parent().unwrap()).unwrap();
    std::fs::write(&precious_sub, b"ARTIFACT-BYTES").unwrap();

    // A scratch tree that symlinks into the vault (dir link + file link).
    let game = make_game(&scratch, "v1", "extracted/game.txt", b"scene", 1_000);
    std::os::unix::fs::symlink(&vault, game.join("vault-dir-link")).unwrap();
    std::os::unix::fs::symlink(&precious, game.join("vault-file-link")).unwrap();

    // Quota of 0 → prune everything.
    let plan = prune_scratch_root(
        &scratch,
        PrunePolicy::Quota { max_total_bytes: 0 },
        now_unix(),
        false,
    )
    .unwrap();
    assert_eq!(plan.pruned.len(), 1);
    assert_eq!(plan.pruned[0].id, "v1");

    // Scratch tree gone.
    assert!(!scratch.join("v1").exists());
    // VAULT COMPLETELY UNTOUCHED — the hard invariant.
    assert!(vault.exists());
    assert!(precious.exists());
    assert_eq!(std::fs::read(&precious).unwrap(), b"CANONICAL-VAULT-BYTES");
    assert!(precious_sub.exists());
    assert_eq!(std::fs::read(&precious_sub).unwrap(), b"ARTIFACT-BYTES");
}

/// A prune target that is *itself* a symlink is refused outright, so a
/// scratch-root entry that links to the vault can never trigger removal of
/// the link (and hence never risk the target).
#[test]
#[cfg(unix)]
fn execute_prune_refuses_a_symlinked_target() {
    let td = tempdir().unwrap();
    let scratch = td.path().join("scratch");
    let vault = td.path().join("vault");
    std::fs::create_dir_all(&scratch).unwrap();
    std::fs::create_dir_all(&vault).unwrap();
    std::fs::write(vault.join("keep.bin"), b"v").unwrap();
    // A scratch-root child that is a symlink to the vault.
    std::os::unix::fs::symlink(&vault, scratch.join("evil")).unwrap();

    // Hand-craft a plan that names the symlink as a prune target.
    let plan = PrunePlan {
        scratch_root: scratch.display().to_string(),
        policy: "manual".into(),
        total_size_bytes_before: 0,
        freed_bytes: 0,
        total_size_bytes_after: 0,
        pruned: vec![ScratchGameEntry {
            id: "evil".into(),
            size_bytes: 0,
            file_count: 0,
            mtime_unix: None,
            sha256: None,
        }],
        kept: vec![],
    };
    let err = execute_prune(&scratch, &plan).unwrap_err();
    assert!(matches!(err, ScratchPruneError::SymlinkTarget { .. }));
    // Vault + its file untouched.
    assert!(vault.join("keep.bin").exists());
}

#[test]
fn quota_that_already_fits_prunes_nothing() {
    let td = tempdir().unwrap();
    let scratch = td.path().join("scratch");
    make_game(&scratch, "a", "f", &[0u8; 10], 1_000);
    let inv = inventory_scratch_root(&scratch, false).unwrap();
    let plan = plan_prune(
        &inv,
        PrunePolicy::Quota {
            max_total_bytes: 1_000,
        },
        now_unix(),
    );
    assert!(plan.pruned.is_empty());
    assert_eq!(plan.kept.len(), 1);
    assert_eq!(plan.freed_bytes, 0);
}
