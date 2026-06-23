//! Cross-OS path resolution + retention policy.
//!
//! Resolution order is the contract's *Cross-OS Path Resolution*:
//!
//! 1. environment variable (`ITOTORI_VAULT_ROOT`, `ITOTORI_SCRATCH_ROOT`)
//! 2. caller-supplied override
//! 3. platform default
//!
//! Reads only the two listed environment variables via `std::env::var`. The
//! adapter has no `.env`-file reads or writes per the orchestrator's
//! architectural constraints.

use std::env;
use std::path::{Path, PathBuf};

use crate::error::VaultSourceError;

/// Where the embedded vault catalog identity for a release should be drawn
/// from. Used by [`crate::paths::derive_game_id`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameIdSource {
    /// VNDB `v`-id (`identifiers.source='vndb' AND kind='v'`).
    Vndb,
    /// DLsite `RJ`/`VJ`/`BJ` code.
    DlsiteRj,
    /// EGS numeric id.
    Egs,
    /// Slug of `works.canonical_title` plus `-r<release_id>`.
    SlugFallback,
}

/// Retention policy for per-run extraction directories *(Contract:
/// §Scratch and Secret Custody)*.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RetentionPolicy {
    /// Delete `<run-id>/` on success and on failure. CI-friendly default.
    #[default]
    KeepNone,
    /// Delete on success; preserve on failure for inspection.
    KeepOnFailure,
    /// Never delete; operator owns cleanup.
    KeepAll,
    /// Keep `<game-id>/extracted/` across runs as long as the artifact
    /// sha256 still matches the last cached hash.
    KeepExtractedForGame,
}

/// Vault-root resolution input.
#[derive(Debug, Clone, Default)]
pub struct VaultConfig {
    /// Caller-supplied override; takes precedence over the platform default
    /// but loses to `ITOTORI_VAULT_ROOT`.
    pub vault_root_override: Option<PathBuf>,
}

/// Scratch-root resolution input.
#[derive(Debug, Clone, Default)]
pub struct ScratchConfig {
    /// Caller-supplied override; takes precedence over the platform default
    /// but loses to `ITOTORI_SCRATCH_ROOT`.
    pub scratch_root_override: Option<PathBuf>,
}

/// Resolve the vault root per the contract's order.
///
/// Returns the unvalidated path; callers (the [`crate::source::VaultSource`]
/// constructor) then assert that `catalog.db` and `artifacts/by-sha/` exist.
pub fn resolve_vault_root(cfg: &VaultConfig) -> Result<PathBuf, VaultSourceError> {
    if let Ok(env_root) = env::var("ITOTORI_VAULT_ROOT")
        && !env_root.is_empty()
    {
        return Ok(PathBuf::from(env_root));
    }
    if let Some(o) = cfg.vault_root_override.as_ref() {
        return Ok(o.clone());
    }
    Ok(default_vault_root())
}

/// Resolve the scratch root per the contract's order.
pub fn resolve_scratch_root(cfg: &ScratchConfig) -> Result<PathBuf, VaultSourceError> {
    if let Ok(env_root) = env::var("ITOTORI_SCRATCH_ROOT")
        && !env_root.is_empty()
    {
        return Ok(PathBuf::from(env_root));
    }
    if let Some(o) = cfg.scratch_root_override.as_ref() {
        return Ok(o.clone());
    }
    default_scratch_root()
}

fn default_vault_root() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        PathBuf::from("/archive/vault")
    }
    #[cfg(target_os = "macos")]
    {
        dirs::data_dir()
            .map(|d| d.join("itotori/vault"))
            .unwrap_or_else(|| PathBuf::from("itotori/vault"))
    }
    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("itotori").join("vault"))
            .unwrap_or_else(|| PathBuf::from("itotori\\vault"))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        PathBuf::from("itotori-vault")
    }
}

fn default_scratch_root() -> Result<PathBuf, VaultSourceError> {
    #[cfg(target_os = "linux")]
    {
        Ok(PathBuf::from("/scratch/itotori"))
    }
    #[cfg(target_os = "macos")]
    {
        match dirs::cache_dir() {
            Some(d) => Ok(d.join("itotori")),
            None => Err(VaultSourceError::ScratchUnwritable {
                path: PathBuf::from("itotori-scratch"),
                source: std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "no home/cache dir available",
                ),
            }),
        }
    }
    #[cfg(target_os = "windows")]
    {
        match dirs::data_local_dir() {
            Some(d) => Ok(d.join("itotori").join("scratch")),
            None => Err(VaultSourceError::ScratchUnwritable {
                path: PathBuf::from("itotori-scratch"),
                source: std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "no LOCALAPPDATA available",
                ),
            }),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        Ok(PathBuf::from("itotori-scratch"))
    }
}

/// Validate that the resolved vault root contains the two required entries.
///
/// `catalog.db` must be a regular file; `artifacts/by-sha/` must be a
/// directory.
pub fn validate_vault_root(root: &Path) -> Result<(), VaultSourceError> {
    let meta = match std::fs::symlink_metadata(root) {
        Ok(m) => m,
        Err(_) => {
            return Err(VaultSourceError::VaultRootMissing {
                path: root.to_path_buf(),
            });
        }
    };
    // A symlink at the root is fine (contract allows it). canonicalize once.
    let canonical = match std::fs::canonicalize(root) {
        Ok(c) => c,
        Err(_) => {
            return Err(VaultSourceError::VaultRootMissing {
                path: root.to_path_buf(),
            });
        }
    };
    let canonical_meta =
        std::fs::metadata(&canonical).map_err(|_| VaultSourceError::VaultRootMissing {
            path: root.to_path_buf(),
        })?;
    if !canonical_meta.is_dir() {
        return Err(VaultSourceError::VaultRootMissing {
            path: root.to_path_buf(),
        });
    }
    // Silence unused-variable warning if symlink_metadata path isn't used further.
    let _ = meta;

    let catalog = canonical.join("catalog.db");
    let catalog_meta = std::fs::metadata(&catalog);
    if catalog_meta.as_ref().map(|m| m.is_file()).unwrap_or(false) {
        // ok
    } else {
        return Err(VaultSourceError::VaultRootIncomplete {
            path: root.to_path_buf(),
            missing: "catalog.db",
        });
    }

    let by_sha = canonical.join("artifacts/by-sha");
    let by_sha_meta = std::fs::metadata(&by_sha);
    if by_sha_meta.as_ref().map(|m| m.is_dir()).unwrap_or(false) {
        // ok
    } else {
        return Err(VaultSourceError::VaultRootIncomplete {
            path: root.to_path_buf(),
            missing: "artifacts/by-sha",
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Safely set/unset an env var, restoring on drop. Tests in this module
    /// touch process-global state and so should not be parallelised against
    /// each other; cargo's default within-file serialization is sufficient
    /// because each test takes the same env-guard pattern and rust's
    /// per-test threads do not interleave the `env::var` reads with the
    /// guards as long as we serialize at the suite level. We use a mutex
    /// to be safe.
    struct EnvGuard {
        key: &'static str,
        previous: Option<String>,
    }
    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = env::var(key).ok();
            // SAFETY: tests in this module hold a process-wide mutex via
            // ENV_LOCK; concurrent reads in other tests outside this
            // module do not touch ITOTORI_VAULT_ROOT or ITOTORI_SCRATCH_ROOT.
            unsafe {
                env::set_var(key, value);
            }
            Self { key, previous }
        }
        fn remove(key: &'static str) -> Self {
            let previous = env::var(key).ok();
            unsafe {
                env::remove_var(key);
            }
            Self { key, previous }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            unsafe {
                match self.previous.take() {
                    Some(v) => env::set_var(self.key, v),
                    None => env::remove_var(self.key),
                }
            }
        }
    }

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    #[allow(non_snake_case)]
    fn resolves_vault_root_from_env_when_ITOTORI_VAULT_ROOT_is_set() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _g = EnvGuard::set("ITOTORI_VAULT_ROOT", "/tmp/my-vault");
        let cfg = VaultConfig::default();
        let root = resolve_vault_root(&cfg).unwrap();
        assert_eq!(root, PathBuf::from("/tmp/my-vault"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn falls_back_to_linux_default_when_no_env_or_override_present() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _g = EnvGuard::remove("ITOTORI_VAULT_ROOT");
        let cfg = VaultConfig::default();
        let root = resolve_vault_root(&cfg).unwrap();
        assert_eq!(root, PathBuf::from("/archive/vault"));
    }

    #[test]
    fn rejects_resolved_root_when_catalog_db_or_by_sha_subdir_is_absent() {
        let td = tempdir().unwrap();
        // empty dir → missing catalog
        let err = validate_vault_root(td.path()).unwrap_err();
        assert!(matches!(
            err,
            VaultSourceError::VaultRootIncomplete {
                missing: "catalog.db",
                ..
            }
        ));

        // add catalog but no artifacts/by-sha
        std::fs::write(td.path().join("catalog.db"), b"x").unwrap();
        let err = validate_vault_root(td.path()).unwrap_err();
        assert!(matches!(
            err,
            VaultSourceError::VaultRootIncomplete {
                missing: "artifacts/by-sha",
                ..
            }
        ));

        // add both → ok
        std::fs::create_dir_all(td.path().join("artifacts/by-sha")).unwrap();
        validate_vault_root(td.path()).unwrap();
    }

    #[test]
    fn rejects_nonexistent_vault_root_as_root_missing() {
        let p = PathBuf::from("/tmp/itotori-test-vault-does-not-exist-please");
        let err = validate_vault_root(&p).unwrap_err();
        assert!(matches!(err, VaultSourceError::VaultRootMissing { .. }));
    }
}
