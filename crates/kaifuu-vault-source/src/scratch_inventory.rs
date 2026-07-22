//! Scratch-inventory + prune helper.
//! `RetentionPolicy::KeepExtractedForGame` (and the CLI's `keep-none` default,
//! which never calls [`crate::source::VaultSource::release`]) leave extracted
//! game trees behind under `<scratch-root>/<game-id>/`. Over many
//! materialisations that scratch tree grows without bound. This module gives
//! operators a way to (a) *inventory* what is materialised (per-game id, size,
//! last-modified time, and an optional content digest — never the raw game
//! bytes) and (b) *prune* trees to enforce a total-size **quota** or an
//! age/last-access **LRU horizon** — WITHOUT a manual `rm -rf`.
//! # Read-only-vault safety invariant
//! The vault (`/archive/vault/`) is canonical, read-only game storage. Prune
//! is **scratch-only** and MUST NEVER remove anything outside the configured
//! scratch root — not even if a scratch tree contains a symlink that points
//! into the vault:
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

#[path = "scratch_inventory/planning.rs"]
mod planning;
use planning::{plan_lru_horizon, plan_quota};

/// One materialised game tree under the scratch root.
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
/// Deterministic: entries are sorted by `id`, and the per-tree digest (when
/// `compute_sha` is set) is order-independent. A missing scratch root yields an
/// empty inventory (not an error) — nothing has been materialised yet.
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

/// Apply a prune plan: remove each pruned tree from disk. Returns the list of
/// removed paths.
/// Every target is re-verified before removal (defence-in-depth, independent of
/// how the plan was produced):
/// 1. the target must be `scratch_root/<id>` and must exist;
/// 2. it must NOT be a symlink ([`ScratchPruneError::SymlinkTarget`]);
/// 3. it must canonicalise to a path under the canonicalised scratch root
///    ([`ScratchPruneError::OutsideScratch`]).
///    Removal uses [`std::fs::remove_dir_all`], which does not follow symlinks, so
///    any symlink *inside* a tree (e.g. pointing into the vault) is unlinked, never
///    traversed. The vault is therefore never a removal target.
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
#[path = "scratch_inventory/tests.rs"]
mod tests;
