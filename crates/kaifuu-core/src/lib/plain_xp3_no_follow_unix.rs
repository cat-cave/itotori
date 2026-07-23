use super::*;
use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::path::Path;

use rustix::fs::{AtFlags, FileType, Mode, OFlags};
use rustix::io::Errno;

fn io_err(error: impl Into<io::Error>) -> PlainXp3WriterError {
    PlainXp3WriterError::Io(error.into().to_string())
}

fn symlink_refused(relative: &str) -> PlainXp3WriterError {
    PlainXp3WriterError::SymlinkTraversalRefused(relative.to_string())
}

/// Open the caller-named trusted root directory. The root's own path is
/// resolved normally (the caller chose it); every component descended below
/// it carries `O_NOFOLLOW`.
fn open_root(dir: &Path) -> Result<OwnedFd, PlainXp3WriterError> {
    rustix::fs::open(
        dir,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(io_err)
}

/// Re-open `dir` via `.` for an owned descriptor to the same inode without
/// following any symlink.
fn reopen(dir: BorrowedFd<'_>) -> Result<OwnedFd, PlainXp3WriterError> {
    rustix::fs::openat(
        dir,
        ".",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(io_err)
}

fn is_symlink(dir: BorrowedFd<'_>, name: &OsStr) -> bool {
    rustix::fs::statat(dir, name, AtFlags::SYMLINK_NOFOLLOW)
        .is_ok_and(|stat| FileType::from_raw_mode(stat.st_mode).is_symlink())
}

/// Split a `validate_safe_relative_path`-validated relative path
/// (`/`-separated, no empty / `.` / `..` components) into its directory
/// components and final filename.
fn split_relative(relative: &str) -> Result<(Vec<&OsStr>, &OsStr), PlainXp3WriterError> {
    let mut parts: Vec<&OsStr> = relative.split('/').map(OsStr::new).collect();
    let filename = parts.pop().filter(|name| !name.is_empty()).ok_or_else(|| {
        PlainXp3WriterError::InconsistentManifest(format!(
            "relative materialization path {relative:?} has no filename component"
        ))
    })?;
    Ok((parts, filename))
}

/// Descend `parents` from the trusted root with `O_NOFOLLOW` on every hop.
/// A symlink on any component fails the `openat` (`ELOOP`) and is reported
/// as a refused traversal, never followed. Missing components are created
/// (`mkdirat`, 0700) when `create` is set.
fn descend(
    root: BorrowedFd<'_>,
    parents: &[&OsStr],
    relative: &str,
    create: bool,
) -> Result<OwnedFd, PlainXp3WriterError> {
    let mut current = reopen(root)?;
    for name in parents {
        if create {
            match rustix::fs::mkdirat(current.as_fd(), *name, Mode::RWXU) {
                Ok(()) => {}
                Err(error) if error == Errno::EXIST => {}
                Err(error) => return Err(io_err(error)),
            }
        }
        let opened = rustix::fs::openat(
            current.as_fd(),
            *name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        );
        current = match opened {
            Ok(fd) => fd,
            Err(error) if error == Errno::LOOP => return Err(symlink_refused(relative)),
            Err(error) => {
                if is_symlink(current.as_fd(), name) {
                    return Err(symlink_refused(relative));
                }
                return Err(io_err(error));
            }
        };
    }
    Ok(current)
}

/// Write `contents` to `relative` under `dir`, refusing any symlink
/// component (including a symlink squatting on the leaf). `create_dirs`
/// creates missing parent directories no-follow.
pub fn write_no_follow(
    dir: &Path,
    relative: &str,
    contents: &[u8],
    create_dirs: bool,
) -> Result<(), PlainXp3WriterError> {
    let (parents, filename) = split_relative(relative)?;
    let root = open_root(dir)?;
    let dir_fd = descend(root.as_fd(), &parents, relative, create_dirs)?;
    // A symlink already occupying the leaf is refused with a clear error;
    // the `O_NOFOLLOW` open below is the actual guard (`ELOOP`) and holds
    // even under a concurrent swap between this check and the open.
    if is_symlink(dir_fd.as_fd(), filename) {
        return Err(symlink_refused(relative));
    }
    let opened = rustix::fs::openat(
        dir_fd.as_fd(),
        filename,
        OFlags::WRONLY | OFlags::CREATE | OFlags::TRUNC | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR | Mode::RGRP | Mode::ROTH,
    );
    let fd = match opened {
        Ok(fd) => fd,
        Err(error) if error == Errno::LOOP => return Err(symlink_refused(relative)),
        Err(error) => return Err(io_err(error)),
    };
    let mut file = std::fs::File::from(fd);
    file.write_all(contents).map_err(io_err)?;
    file.sync_all().map_err(io_err)?;
    Ok(())
}

/// Read `relative` under `dir`, refusing any symlink component (including a
/// symlink squatting on the leaf).
pub fn read_no_follow(dir: &Path, relative: &str) -> Result<Vec<u8>, PlainXp3WriterError> {
    let (parents, filename) = split_relative(relative)?;
    let root = open_root(dir)?;
    let dir_fd = descend(root.as_fd(), &parents, relative, false)?;
    let opened = rustix::fs::openat(
        dir_fd.as_fd(),
        filename,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    );
    let fd = match opened {
        Ok(fd) => fd,
        Err(error) if error == Errno::LOOP => return Err(symlink_refused(relative)),
        Err(error) => return Err(io_err(error)),
    };
    let mut file = std::fs::File::from(fd);
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).map_err(io_err)?;
    Ok(buffer)
}
