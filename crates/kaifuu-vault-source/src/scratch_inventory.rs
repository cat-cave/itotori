//! Scratch-inventory + prune helper (KAIFUU-179).
//!
//! `RetentionPolicy::KeepExtractedForGame` (and the CLI's `keep-none` default,
//! which never calls [`crate::source::VaultSource::release`]) leave extracted
//! game trees behind under `<scratch-root>/<game-id>/`. Over many
//! materialisations that scratch tree grows without bound. This module gives
//! operators a way to (a) *inventory* what is materialised (per-game id, size,
//! last-modified time, and an optional content digest — never the raw game
//! bytes) and (b) *prune* trees to enforce a total-size **quota** or an
//! age/last-access **LRU horizon** — WITHOUT a manual `rm -rf`.
//!
//! # Read-only-vault safety invariant
//!
//! The vault (`/archive/vault/`) is canonical, read-only game storage. Prune
//! is **scratch-only** and MUST NEVER remove anything outside the configured
//! scratch root — not even if a scratch tree contains a symlink that points
//! into the vault:
//!
//! - The walk ([`summarize_tree`]) uses [`std::fs::symlink_metadata`] and
//!   **never traverses or counts symlinks**, so a symlink into the vault does
//!   not inflate a tree's size and is never descended into.
//! - Only real directories that are *direct children* of the scratch root are
//!   prune-eligible game trees (a symlinked child is skipped by inventory and
//!   refused by [`execute_prune`]).
//! - [`execute_prune`] re-verifies, per target, that the target is not a
//!   symlink and canonicalises to a path under the scratch root before calling
//!   [`std::fs::remove_dir_all`], which itself does **not** follow symlinks (it
//!   unlinks the link, never the link's target). A symlink into the vault is
//!   therefore removed as a *link*; the vault bytes are untouched.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// One materialised game tree under the scratch root.
///
/// Reports identity/size/time/hash ONLY — never raw game bytes.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ScratchGameEntry {
    /// The game id — the directory name directly under the scratch root
    /// (e.g. `v12345`, `RJ123456`).
    pub id: String,
    /// Total size in bytes of all regular files in the tree. Symlinks are
    /// neither followed nor counted.
    pub size_bytes: u64,
    /// Number of regular files in the tree (symlinks excluded).
    pub file_count: u64,
    /// Most-recent modification time across the tree (the root dir and every
    /// descendant), as whole Unix seconds. Used as the LRU key. `None` when no
    /// mtime could be read.
    pub mtime_unix: Option<i64>,
    /// Deterministic content digest of the tree: SHA-256 over each regular
    /// file's relative path + length + bytes, in sorted-path order. Present
    /// only when the caller requested hashing (prune does not need it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

/// A deterministic, machine-parseable snapshot of the scratch root.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ScratchInventory {
    /// The scratch root that was scanned (display form).
    pub scratch_root: String,
    /// Number of materialised game trees.
    pub game_count: usize,
    /// Sum of `size_bytes` across all games.
    pub total_size_bytes: u64,
    /// The per-game entries, sorted by `id` (deterministic).
    pub games: Vec<ScratchGameEntry>,
}

/// The prune policy: enforce either a total-size quota or an LRU age horizon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrunePolicy {
    /// Keep the total scratch size at or below `max_total_bytes`, evicting
    /// least-recently-modified trees (oldest `mtime_unix` first, ties broken by
    /// `id`) until the remaining total fits. A tree is evicted whole.
    Quota {
        /// The total-size cap in bytes.
        max_total_bytes: u64,
    },
    /// Remove every tree whose most-recent mtime is strictly older than
    /// `now - max_age_secs`. Trees with an unknown mtime are kept.
    LruHorizon {
        /// The maximum age (seconds) a tree may reach before it is pruned.
        max_age_secs: u64,
    },
}

impl PrunePolicy {
    /// Stable operator-facing label, e.g. `quota(max_total_bytes=1048576)`.
    #[must_use]
    pub fn label(&self) -> String {
        match self {
            Self::Quota { max_total_bytes } => {
                format!("quota(max_total_bytes={max_total_bytes})")
            }
            Self::LruHorizon { max_age_secs } => {
                format!("lru-horizon(max_age_secs={max_age_secs})")
            }
        }
    }
}

/// A prune plan (also the dry-run report): which trees would be pruned, which
/// kept, and the resulting size delta. Deterministic + machine-parseable.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PrunePlan {
    /// The scratch root the plan applies to (display form).
    pub scratch_root: String,
    /// The policy label.
    pub policy: String,
    /// Total scratch size before pruning.
    pub total_size_bytes_before: u64,
    /// Bytes that would be (or were) freed.
    pub freed_bytes: u64,
    /// Total scratch size after pruning.
    pub total_size_bytes_after: u64,
    /// Trees selected for pruning, sorted by `id`.
    pub pruned: Vec<ScratchGameEntry>,
    /// Trees kept, sorted by `id`.
    pub kept: Vec<ScratchGameEntry>,
}

/// Error surface for the scratch prune path. Prune never touches the vault; the
/// two guard variants exist so an attempt to remove a non-scratch or symlinked
/// target fails loudly rather than silently.
#[derive(Debug, thiserror::Error)]
pub enum ScratchPruneError {
    /// A prune target canonicalised to a path outside the scratch root — the
    /// hard read-only-vault safety invariant. Never removed.
    #[error(
        "refusing to prune {target}: it does not resolve under the scratch root {scratch_root}"
    )]
    OutsideScratch {
        /// The offending target.
        target: PathBuf,
        /// The scratch root it must be under.
        scratch_root: PathBuf,
    },
    /// A prune target is itself a symlink; only real scratch trees are
    /// prune-eligible (removing the link is refused so nothing it points at —
    /// e.g. a vault path — is ever in play).
    #[error("refusing to prune {target}: it is a symlink, not a real scratch tree")]
    SymlinkTarget {
        /// The offending symlink target.
        target: PathBuf,
    },
    /// An I/O error while scanning or removing a scratch path.
    #[error("scratch prune I/O error at {path}: {source}")]
    Io {
        /// The path being scanned/removed when the error occurred.
        path: PathBuf,
        /// The underlying I/O error.
        source: io::Error,
    },
}

/// Inventory the materialised game trees under `scratch_root`.
///
/// Deterministic: entries are sorted by `id`, and the per-tree digest (when
/// `compute_sha` is set) is order-independent. A missing scratch root yields an
/// empty inventory (not an error) — nothing has been materialised yet.
///
/// `compute_sha` streams every file's bytes through SHA-256; prune passes
/// `false` since it only needs size + mtime.
pub fn inventory_scratch_root(
    scratch_root: &Path,
    compute_sha: bool,
) -> io::Result<ScratchInventory> {
    let mut games: Vec<ScratchGameEntry> = Vec::new();

    if !scratch_root.exists() {
        return Ok(ScratchInventory {
            scratch_root: scratch_root.display().to_string(),
            game_count: 0,
            total_size_bytes: 0,
            games,
        });
    }

    let mut children: Vec<PathBuf> = read_dir_sorted(scratch_root)?;
    children.sort();
    for path in children {
        let meta = std::fs::symlink_metadata(&path)?;
        // Only real directories are materialised game trees. Skip regular
        // files (e.g. stray marker files) and — critically — skip symlinks: a
        // symlinked "tree" is never a materialised tree and could point into
        // the read-only vault.
        if !meta.file_type().is_dir() {
            continue;
        }
        let id = match path.file_name() {
            Some(name) => name.to_string_lossy().into_owned(),
            None => continue,
        };
        let stats = summarize_tree(&path, compute_sha)?;
        games.push(ScratchGameEntry {
            id,
            size_bytes: stats.size,
            file_count: stats.files,
            mtime_unix: stats.mtime,
            sha256: stats.sha,
        });
    }

    games.sort_by(|a, b| a.id.cmp(&b.id));
    let total_size_bytes = games.iter().map(|g| g.size_bytes).sum();
    Ok(ScratchInventory {
        scratch_root: scratch_root.display().to_string(),
        game_count: games.len(),
        total_size_bytes,
        games,
    })
}

/// Build a prune plan from an inventory + policy. Pure (no filesystem writes);
/// [`execute_prune`] applies it. `now_unix` is the reference time for the LRU
/// horizon (Unix seconds).
#[must_use]
pub fn plan_prune(inventory: &ScratchInventory, policy: PrunePolicy, now_unix: i64) -> PrunePlan {
    let total_before = inventory.total_size_bytes;
    let (mut pruned, mut kept): (Vec<ScratchGameEntry>, Vec<ScratchGameEntry>) = match policy {
        PrunePolicy::Quota { max_total_bytes } => plan_quota(&inventory.games, max_total_bytes),
        PrunePolicy::LruHorizon { max_age_secs } => {
            plan_lru_horizon(&inventory.games, max_age_secs, now_unix)
        }
    };
    pruned.sort_by(|a, b| a.id.cmp(&b.id));
    kept.sort_by(|a, b| a.id.cmp(&b.id));

    let freed_bytes: u64 = pruned.iter().map(|g| g.size_bytes).sum();
    PrunePlan {
        scratch_root: inventory.scratch_root.clone(),
        policy: policy.label(),
        total_size_bytes_before: total_before,
        freed_bytes,
        total_size_bytes_after: total_before.saturating_sub(freed_bytes),
        pruned,
        kept,
    }
}

/// LRU key for a tree: unknown mtime sorts as *newest* (kept longest / never
/// horizon-pruned).
fn lru_key(entry: &ScratchGameEntry) -> i64 {
    entry.mtime_unix.unwrap_or(i64::MAX)
}

fn plan_quota(
    games: &[ScratchGameEntry],
    max_total_bytes: u64,
) -> (Vec<ScratchGameEntry>, Vec<ScratchGameEntry>) {
    // Evict least-recently-modified first (oldest mtime), ties broken by id for
    // determinism, until the remaining total fits under the cap.
    let mut ordered: Vec<&ScratchGameEntry> = games.iter().collect();
    ordered.sort_by(|a, b| lru_key(a).cmp(&lru_key(b)).then_with(|| a.id.cmp(&b.id)));

    let mut total: u64 = games.iter().map(|g| g.size_bytes).sum();
    let mut prune_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for entry in ordered {
        if total <= max_total_bytes {
            break;
        }
        prune_ids.insert(entry.id.clone());
        total = total.saturating_sub(entry.size_bytes);
    }

    partition_by_ids(games, &prune_ids)
}

fn plan_lru_horizon(
    games: &[ScratchGameEntry],
    max_age_secs: u64,
    now_unix: i64,
) -> (Vec<ScratchGameEntry>, Vec<ScratchGameEntry>) {
    let threshold = now_unix.saturating_sub(i64::try_from(max_age_secs).unwrap_or(i64::MAX));
    let mut prune_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for entry in games {
        // Unknown mtime → lru_key == i64::MAX → never older than threshold → kept.
        if lru_key(entry) < threshold {
            prune_ids.insert(entry.id.clone());
        }
    }
    partition_by_ids(games, &prune_ids)
}

fn partition_by_ids(
    games: &[ScratchGameEntry],
    prune_ids: &std::collections::BTreeSet<String>,
) -> (Vec<ScratchGameEntry>, Vec<ScratchGameEntry>) {
    let mut pruned = Vec::new();
    let mut kept = Vec::new();
    for g in games {
        if prune_ids.contains(&g.id) {
            pruned.push(g.clone());
        } else {
            kept.push(g.clone());
        }
    }
    (pruned, kept)
}

/// Apply a prune plan: remove each pruned tree from disk. Returns the list of
/// removed paths.
///
/// Every target is re-verified before removal (defence-in-depth, independent of
/// how the plan was produced):
/// 1. the target must be `scratch_root/<id>` and must exist;
/// 2. it must NOT be a symlink ([`ScratchPruneError::SymlinkTarget`]);
/// 3. it must canonicalise to a path under the canonicalised scratch root
///    ([`ScratchPruneError::OutsideScratch`]).
///
/// Removal uses [`std::fs::remove_dir_all`], which does not follow symlinks, so
/// any symlink *inside* a tree (e.g. pointing into the vault) is unlinked, never
/// traversed. The vault is therefore never a removal target.
pub fn execute_prune(
    scratch_root: &Path,
    plan: &PrunePlan,
) -> Result<Vec<PathBuf>, ScratchPruneError> {
    let scratch_canonical =
        std::fs::canonicalize(scratch_root).map_err(|source| ScratchPruneError::Io {
            path: scratch_root.to_path_buf(),
            source,
        })?;

    let mut removed = Vec::new();
    for entry in &plan.pruned {
        let target = scratch_root.join(&entry.id);
        assert_prune_target_safe(&scratch_canonical, &target)?;
        std::fs::remove_dir_all(&target).map_err(|source| ScratchPruneError::Io {
            path: target.clone(),
            source,
        })?;
        removed.push(target);
    }
    Ok(removed)
}

/// Verify a single prune target is a real directory that resolves strictly
/// under the (already-canonicalised) scratch root. This is the hard safety
/// gate: it refuses symlinks and any path escaping the scratch root, so the
/// read-only vault can never be a removal target.
fn assert_prune_target_safe(
    scratch_canonical: &Path,
    target: &Path,
) -> Result<(), ScratchPruneError> {
    let meta = std::fs::symlink_metadata(target).map_err(|source| ScratchPruneError::Io {
        path: target.to_path_buf(),
        source,
    })?;
    if meta.file_type().is_symlink() {
        return Err(ScratchPruneError::SymlinkTarget {
            target: target.to_path_buf(),
        });
    }
    let target_canonical =
        std::fs::canonicalize(target).map_err(|source| ScratchPruneError::Io {
            path: target.to_path_buf(),
            source,
        })?;
    if !target_canonical.starts_with(scratch_canonical) {
        return Err(ScratchPruneError::OutsideScratch {
            target: target.to_path_buf(),
            scratch_root: scratch_canonical.to_path_buf(),
        });
    }
    Ok(())
}

/// Convenience: inventory + plan + (optionally) execute in one call. When
/// `dry_run` is true no filesystem change is made and the returned plan is the
/// report of what *would* be pruned.
pub fn prune_scratch_root(
    scratch_root: &Path,
    policy: PrunePolicy,
    now_unix: i64,
    dry_run: bool,
) -> Result<PrunePlan, ScratchPruneError> {
    // Prune only needs size + mtime; skip the (potentially large) content hash.
    let inventory =
        inventory_scratch_root(scratch_root, false).map_err(|source| ScratchPruneError::Io {
            path: scratch_root.to_path_buf(),
            source,
        })?;
    let plan = plan_prune(&inventory, policy, now_unix);
    if !dry_run {
        execute_prune(scratch_root, &plan)?;
    }
    Ok(plan)
}

/// The current Unix time in whole seconds (LRU reference for the CLI).
#[must_use]
pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

struct TreeStats {
    size: u64,
    files: u64,
    mtime: Option<i64>,
    sha: Option<String>,
}

/// Read a directory's entries as sorted absolute paths.
fn read_dir_sorted(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)?
        .map(|e| e.map(|e| e.path()))
        .collect::<io::Result<Vec<_>>>()?;
    out.sort();
    Ok(out)
}

/// Walk a game tree, summing regular-file sizes, tracking the newest mtime, and
/// (optionally) computing a deterministic content digest. Symlinks are never
/// followed or counted.
fn summarize_tree(root: &Path, compute_sha: bool) -> io::Result<TreeStats> {
    let mut files: Vec<(String, PathBuf, u64)> = Vec::new();
    // LRU signal = the newest *file* mtime. Directory mtimes are excluded: they
    // are set to the materialisation instant when the tree is created and would
    // otherwise mask the file times. Extraction writes every file with
    // `File::create` (current time, never an archive-embedded timestamp), so the
    // newest file mtime faithfully reflects when the tree was last materialised.
    let mut max_mtime: Option<i64> = None;
    walk(root, root, &mut files, &mut max_mtime)?;

    // Sort by relative path so the digest is independent of directory-read
    // order (deterministic across filesystems/runs).
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut total: u64 = 0;
    let mut hasher = compute_sha.then(Sha256::new);
    for (rel, abs, len) in &files {
        total = total.saturating_add(*len);
        if let Some(h) = hasher.as_mut() {
            h.update((rel.len() as u64).to_le_bytes());
            h.update(rel.as_bytes());
            h.update(len.to_le_bytes());
            hash_file_contents(h, abs)?;
        }
    }

    let sha = hasher.map(|h| hex_lower(&h.finalize()));
    Ok(TreeStats {
        size: total,
        files: files.len() as u64,
        mtime: max_mtime,
        sha,
    })
}

fn walk(
    base: &Path,
    dir: &Path,
    out: &mut Vec<(String, PathBuf, u64)>,
    max_mtime: &mut Option<i64>,
) -> io::Result<()> {
    for path in read_dir_sorted(dir)? {
        let meta = std::fs::symlink_metadata(&path)?;
        let ft = meta.file_type();
        // Never traverse or count a symlink — it could escape the scratch root
        // (e.g. into the read-only vault).
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            walk(base, &path, out, max_mtime)?;
        } else if ft.is_file() {
            update_mtime(max_mtime, &meta);
            let rel = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push((rel, path, meta.len()));
        }
    }
    Ok(())
}

fn update_mtime(max: &mut Option<i64>, meta: &std::fs::Metadata) {
    if let Ok(mtime) = meta.modified()
        && let Ok(secs) = mtime.duration_since(UNIX_EPOCH)
    {
        let secs = i64::try_from(secs.as_secs()).unwrap_or(i64::MAX);
        *max = Some(max.map_or(secs, |m| m.max(secs)));
    }
}

fn hash_file_contents(hasher: &mut Sha256, path: &Path) -> io::Result<()> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
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
}
