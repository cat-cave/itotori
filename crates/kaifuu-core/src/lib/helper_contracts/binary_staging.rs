use super::*;

/// Copy the source helper binary into the trusted `staging_dir` and bind the
/// STAGED bytes to execution.
/// The source is opened and read exactly ONCE (no-follow; a symlink source is
/// refused). The bytes are written into a FRESH regular file inside the trusted
/// directory (`O_EXCL | O_NOFOLLOW`, after clearing any stale/squatting entry),
/// then re-opened no-follow read-only as the returned execution reference. The
/// returned hash is of the re-read staged bytes. A swap of the source path
/// afterwards cannot affect the staged copy.
#[cfg(unix)]
pub(crate) fn stage_helper_binary_no_follow(
    source_path: &Path,
    staging_dir: &Path,
    staged_name: &str,
) -> Result<StagedHelperBinary, HelperBinaryStagingError> {
    use std::ffi::OsStr;
    use std::os::fd::AsFd;

    use rustix::fs::{AtFlags, FileType, Mode, OFlags};
    use rustix::io::Errno;

    fn io(error: impl Into<io::Error>) -> HelperBinaryStagingError {
        HelperBinaryStagingError::Io(error.into().to_string())
    }

    // 1. Read the source bytes exactly once, no-follow. A symlink source is
    // refused so we never chase a link to attacker-chosen bytes.
    let source_fd = match rustix::fs::open(
        source_path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(Errno::NOENT) => return Err(HelperBinaryStagingError::SourceMissing),
        Err(Errno::LOOP) => return Err(HelperBinaryStagingError::SourceSymlink),
        Err(error) => return Err(io(error)),
    };
    let source_stat = rustix::fs::fstat(source_fd.as_fd()).map_err(io)?;
    if !FileType::from_raw_mode(source_stat.st_mode).is_file() {
        // A directory / device / fifo is not a launchable regular file; treat as
        // missing rather than staging it.
        return Err(HelperBinaryStagingError::SourceMissing);
    }
    let mut bytes = Vec::new();
    std::fs::File::from(source_fd)
        .read_to_end(&mut bytes)
        .map_err(io)?;

    // 2. Open the trusted staging directory (the caller's trust anchor).
    let dir_fd = rustix::fs::open(
        staging_dir,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(io)?;

    // 3. Clear any stale/squatting entry, then create a FRESH regular file
    // (`O_EXCL | O_NOFOLLOW`): a symlink can neither pre-exist (unlinked) nor
    // be followed, so the write lands on a real file in the trusted dir.
    let staged_leaf = OsStr::new(staged_name);
    match rustix::fs::unlinkat(dir_fd.as_fd(), staged_leaf, AtFlags::empty()) {
        Ok(()) | Err(Errno::NOENT) => {}
        Err(error) => return Err(io(error)),
    }
    let write_fd = match rustix::fs::openat(
        dir_fd.as_fd(),
        staged_leaf,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    ) {
        Ok(fd) => fd,
        Err(Errno::EXIST) => return Err(HelperBinaryStagingError::StagingSymlink),
        Err(error) => return Err(io(error)),
    };
    let mut write_file = std::fs::File::from(write_fd);
    write_file.write_all(&bytes).map_err(io)?;
    write_file.sync_all().map_err(io)?;
    drop(write_file);

    // 4. Re-open the staged copy no-follow read-only: this descriptor is the
    // execution reference (kept at offset 0), and the validated hash is of
    // THESE staged bytes — read through an INDEPENDENT no-follow open so the
    // execution descriptor's file offset is not consumed.
    let open_staged = |flags: OFlags| -> Result<std::os::fd::OwnedFd, HelperBinaryStagingError> {
        match rustix::fs::openat(
            dir_fd.as_fd(),
            staged_leaf,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | flags,
            Mode::empty(),
        ) {
            Ok(fd) => Ok(fd),
            Err(Errno::LOOP) => Err(HelperBinaryStagingError::StagingSymlink),
            Err(error) => Err(io(error)),
        }
    };
    let exec_fd = open_staged(OFlags::empty())?;
    let hash_fd = open_staged(OFlags::empty())?;
    let mut staged_bytes = Vec::new();
    std::fs::File::from(hash_fd)
        .read_to_end(&mut staged_bytes)
        .map_err(io)?;
    let staged_hash = sha256_hash_bytes(&staged_bytes);

    Ok(StagedHelperBinary {
        path: staging_dir.join(staged_name),
        hash: staged_hash,
        fd: exec_fd,
    })
}

/// Non-Unix fallback: fd-relative no-follow staging is Unix-only. Rather than
/// fall back to an unsafe hash-then-launch of the mutable path, staging is
/// unsupported (surfaced as a typed staging failure).
#[cfg(not(unix))]
pub(crate) fn stage_helper_binary_no_follow(
    _source_path: &Path,
    _staging_dir: &Path,
    _staged_name: &str,
) -> Result<StagedHelperBinary, HelperBinaryStagingError> {
    Err(HelperBinaryStagingError::Unsupported)
}
