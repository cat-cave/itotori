//! Managed runtime-artifact root store (prepare/write/staging/cleanup).
//!
//! Extracted from `lib.rs` as part of the runtime-artifact store band.

use std::io;
use std::path::{Path, PathBuf};

use crate::UtsushiResult;
use crate::sink::{SinkError, SinkKind};

#[cfg(unix)]
use super::artifact_fs;
use super::types::{
    RUNTIME_ARTIFACT_ROOT_MARKER, RUNTIME_ARTIFACT_SOFT_BYTE_BUDGET_LABEL,
    validate_artifact_extension, validate_artifact_segment, validate_runtime_artifact_uri,
};
#[cfg(unix)]
use std::ffi::OsStr;
#[cfg(unix)]
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};

const RUNTIME_ARTIFACT_STAGING_DIR: &str = ".staging";

const OBVIOUS_UNMANAGED_ROOT_SENTINELS: &[&str] = &[
    ".git",
    "Cargo.toml",
    "package.json",
    "pyproject.toml",
    "go.mod",
    "project.godot",
    "Assets",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeArtifactRoot {
    root: PathBuf,
    /// Optional soft artifact-byte budget. When set, a [`Self::write_bytes`]
    /// whose payload exceeds this cap surfaces [`SinkError::BudgetExhausted`]
    /// instead of writing. `None` (the default from [`Self::new`]) disables the
    /// check, preserving the historical unbudgeted behaviour.
    soft_byte_budget: Option<u64>,
}

impl RuntimeArtifactRoot {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            soft_byte_budget: None,
        }
    }

    /// Configure a soft artifact-byte budget. A subsequent [`Self::write_bytes`]
    /// whose payload exceeds `budget` bytes surfaces
    /// [`SinkError::BudgetExhausted`] (`sink = SinkKind::FrameArtifact`
    /// `budget = RUNTIME_ARTIFACT_SOFT_BYTE_BUDGET_LABEL`) rather than writing.
    /// This is the real artifact-store budget surface: any adapter writing
    /// through this root receives the diagnostic on the live path.
    #[must_use]
    pub fn with_soft_byte_budget(mut self, budget: u64) -> Self {
        self.soft_byte_budget = Some(budget);
        self
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    pub fn artifact_path(&self, uri: &str) -> UtsushiResult<PathBuf> {
        let relative = validate_runtime_artifact_uri(uri)?;
        Ok(self.root.join(relative))
    }

    /// Reject a write of `len` bytes when it would exceed the configured soft
    /// artifact-byte budget, returning [`SinkError::BudgetExhausted`] with the
    /// artifact-store sink id and budget label. `Ok(())` when under budget or
    /// when no budget is configured. Shared by the unix and non-unix
    /// [`Self::write_bytes`] paths so the budget diagnostic is reachable from
    /// the real write path on every platform.
    fn check_soft_byte_budget(&self, len: usize) -> Result<(), SinkError> {
        if let Some(budget) = self.soft_byte_budget
            && len as u64 > budget
        {
            return Err(SinkError::BudgetExhausted {
                sink: SinkKind::FrameArtifact,
                budget: RUNTIME_ARTIFACT_SOFT_BYTE_BUDGET_LABEL.to_string(),
            });
        }
        Ok(())
    }
}

// all mutating runtime-artifact operations are fd-relative and
// no-follow (openat/mkdirat/renameat/unlinkat/getdents against a directory
// descriptor opened once with `O_NOFOLLOW`). This closes the TOCTOU window in
// which a concurrent actor could swap a directory that was validated as real
// for a symlink that escapes the managed root before the write/rename/cleanup
// executes.

#[cfg(unix)]
impl RuntimeArtifactRoot {
    pub fn prepare(&self) -> UtsushiResult<()> {
        // Open the root as a directory descriptor with `O_NOFOLLOW`; if it does
        // not exist yet, create it (and any missing ancestors) then re-open.
        let root_fd = match artifact_fs::open_root_dir(&self.root) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                artifact_fs::create_directory_no_follow(&self.root)?;
                artifact_fs::open_root_dir(&self.root)
                    .map_err(|error| artifact_fs::describe_root_open(&self.root, error))?
            }
            Err(error) => return Err(artifact_fs::describe_root_open(&self.root, error).into()),
        };

        self.assert_not_obvious_unmanaged_root(root_fd.as_fd())?;

        // The marker is resolved relative to the held descriptor, so it always
        // refers to an entry inside the directory we actually opened.
        match artifact_fs::entry_file_type(root_fd.as_fd(), RUNTIME_ARTIFACT_ROOT_MARKER) {
            Ok(file_type) => {
                if file_type.is_symlink() || !file_type.is_file() {
                    return Err(format!(
                        "runtime artifact root marker must be a regular file: {}",
                        self.root.join(RUNTIME_ARTIFACT_ROOT_MARKER).display()
                    )
                    .into());
                }
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }

        if artifact_fs::dir_has_entries(root_fd.as_fd())? {
            return Err(format!(
                "refusing to adopt non-empty unmarked runtime artifact root {}",
                self.root.display()
            )
            .into());
        }

        artifact_fs::write_marker(root_fd.as_fd())?;
        Ok(())
    }

    pub fn write_bytes(&self, uri: &str, contents: &[u8]) -> UtsushiResult<PathBuf> {
        // Soft artifact-budget gate on the real write path: an over-budget
        // write surfaces SinkError::BudgetExhausted (boxed into UtsushiResult)
        // before any filesystem mutation.
        self.check_soft_byte_budget(contents.len())?;
        let relative = validate_runtime_artifact_uri(uri)?;
        let Some(parent) = relative.parent() else {
            return Err(
                format!("runtime artifact uri is missing parent directories: {uri}").into(),
            );
        };
        let Some(filename) = relative.file_name() else {
            return Err(format!("runtime artifact uri is missing a filename: {uri}").into());
        };

        let root_fd = self.open_managed_root_fd()?;
        let dir_fd = artifact_fs::open_or_create_dir_chain(root_fd.as_fd(), parent)?;
        artifact_fs::write_file_no_follow(dir_fd.as_fd(), filename, contents)?;
        Ok(self.root.join(&relative))
    }

    pub fn prepare_staging_file(
        &self,
        run_id: &str,
        artifact_id: &str,
        extension: &str,
    ) -> UtsushiResult<PathBuf> {
        validate_artifact_segment("run id", run_id)?;
        validate_artifact_segment("artifact id", artifact_id)?;
        validate_artifact_extension(extension)?;
        self.prepare()?;

        let relative_dir = Path::new(RUNTIME_ARTIFACT_STAGING_DIR).join(run_id);
        let filename = format!("{artifact_id}.{extension}");

        let root_fd = self.open_managed_root_fd()?;
        let dir_fd = artifact_fs::open_or_create_dir_chain(root_fd.as_fd(), &relative_dir)?;
        // Clear any stale entry (no-follow); refuse a symlink squatting on the
        // staging filename so the externally-written path can never be a link.
        artifact_fs::clear_staging_destination(dir_fd.as_fd(), OsStr::new(&filename))?;
        Ok(self.root.join(&relative_dir).join(&filename))
    }

    pub fn cleanup_staging_run(&self, run_id: &str) -> UtsushiResult<()> {
        validate_artifact_segment("run id", run_id)?;
        let root_fd = self.open_managed_root_fd()?;

        let staging_fd = match artifact_fs::open_child_dir_optional(
            root_fd.as_fd(),
            RUNTIME_ARTIFACT_STAGING_DIR,
        ) {
            Ok(Some(fd)) => fd,
            Ok(None) => return Ok(()),
            Err(error) => return Err(error),
        };

        let run_name = std::ffi::CString::new(run_id.as_bytes())?;
        artifact_fs::remove_entry(staging_fd.as_fd(), &run_name)?;

        if !artifact_fs::dir_has_entries(staging_fd.as_fd())? {
            drop(staging_fd);
            let staging_name = std::ffi::CString::new(RUNTIME_ARTIFACT_STAGING_DIR.as_bytes())?;
            artifact_fs::remove_empty_dir_if_present(root_fd.as_fd(), &staging_name)?;
        }
        Ok(())
    }

    pub fn cleanup_contents(&self) -> UtsushiResult<()> {
        let root_fd = self.open_managed_root_fd()?;
        let marker = std::ffi::CString::new(RUNTIME_ARTIFACT_ROOT_MARKER.as_bytes())?;
        for name in artifact_fs::read_dir_names(root_fd.as_fd())? {
            if name == marker {
                continue;
            }
            artifact_fs::remove_entry(root_fd.as_fd(), &name)?;
        }
        Ok(())
    }

    /// Open the managed root as a directory descriptor, refusing obvious
    /// unmanaged roots and requiring the regular-file marker. The returned
    /// descriptor is the capability every mutating operation resolves against.
    fn open_managed_root_fd(&self) -> UtsushiResult<OwnedFd> {
        let root_fd = artifact_fs::open_root_dir(&self.root)
            .map_err(|error| artifact_fs::describe_root_open(&self.root, error))?;
        self.assert_not_obvious_unmanaged_root(root_fd.as_fd())?;
        match artifact_fs::entry_file_type(root_fd.as_fd(), RUNTIME_ARTIFACT_ROOT_MARKER) {
            Ok(file_type) if !file_type.is_symlink() && file_type.is_file() => Ok(root_fd),
            Ok(_) => Err(format!(
                "runtime artifact cleanup requires regular managed root marker {} under {}",
                RUNTIME_ARTIFACT_ROOT_MARKER,
                self.root.display()
            )
            .into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Err(format!(
                "runtime artifact cleanup requires managed root marker {} under {}",
                RUNTIME_ARTIFACT_ROOT_MARKER,
                self.root.display()
            )
            .into()),
            Err(error) => Err(error.into()),
        }
    }

    fn assert_not_obvious_unmanaged_root(&self, root: BorrowedFd<'_>) -> UtsushiResult<()> {
        for sentinel in OBVIOUS_UNMANAGED_ROOT_SENTINELS {
            match artifact_fs::entry_file_type(root, *sentinel) {
                Ok(_) => {
                    return Err(format!(
                        "refusing to use obvious source or project root as runtime artifact root: {} contains {}",
                        self.root.display(),
                        sentinel
                    )
                    .into());
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
}

#[cfg(not(unix))]
impl RuntimeArtifactRoot {
    pub fn prepare(&self) -> UtsushiResult<()> {
        Err(RUNTIME_ARTIFACT_UNSUPPORTED_PLATFORM.into())
    }

    pub fn write_bytes(&self, _uri: &str, _contents: &[u8]) -> UtsushiResult<PathBuf> {
        // Keep the soft artifact-budget diagnostic platform-independent: an
        // over-budget write surfaces SinkError::BudgetExhausted here too.
        self.check_soft_byte_budget(_contents.len())?;
        Err(RUNTIME_ARTIFACT_UNSUPPORTED_PLATFORM.into())
    }

    pub fn prepare_staging_file(
        &self,
        _run_id: &str,
        _artifact_id: &str,
        _extension: &str,
    ) -> UtsushiResult<PathBuf> {
        Err(RUNTIME_ARTIFACT_UNSUPPORTED_PLATFORM.into())
    }

    pub fn cleanup_staging_run(&self, _run_id: &str) -> UtsushiResult<()> {
        Err(RUNTIME_ARTIFACT_UNSUPPORTED_PLATFORM.into())
    }

    pub fn cleanup_contents(&self) -> UtsushiResult<()> {
        Err(RUNTIME_ARTIFACT_UNSUPPORTED_PLATFORM.into())
    }
}

#[cfg(not(unix))]
const RUNTIME_ARTIFACT_UNSUPPORTED_PLATFORM: &str =
    "runtime artifact filesystem operations require fd-relative no-follow syscalls (unix)";
