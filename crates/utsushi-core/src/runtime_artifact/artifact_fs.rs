//! fd-relative / no-follow filesystem primitives for the runtime
//! artifact root.
//!
//! Every mutating operation resolves paths RELATIVE to a directory descriptor
//! opened once with `O_NOFOLLOW`, and every `openat` that descends into a
//! subdirectory also carries `O_NOFOLLOW | O_DIRECTORY`. This closes the TOCTOU
//! window between validating that a path component is a real directory and
//! using it: if a concurrent actor swaps a validated subdirectory for a symlink
//! (pointing outside the managed root), the very next `openat` fails with
//! `ELOOP` instead of following the link out of the root. Cleanup traverses
//! only real directories (opened `O_NOFOLLOW`); a symlink entry is `unlinkat`ed
//! in place (the link itself removed) and is never recursed into, so cleanup
//! can never follow a symlink to a target outside the root.

use super::RUNTIME_ARTIFACT_ROOT_MARKER;
use crate::UtsushiResult;
use std::ffi::{CStr, CString, OsStr};
use std::io::{self, Write};
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::path::{Component, Path, PathBuf};

use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags};

fn dir_open_flags() -> OFlags {
    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC
}

fn file_create_flags() -> OFlags {
    OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC
}

/// Open the managed root directory itself, refusing to follow a final-
/// component symlink (`O_NOFOLLOW`).
pub fn open_root_dir(path: &Path) -> io::Result<OwnedFd> {
    rustix::fs::open(path, dir_open_flags(), Mode::empty()).map_err(io::Error::from)
}

/// Re-open the directory referenced by `dir` (via `.`) to obtain an owned
/// descriptor to the same inode without following any symlink.
fn reopen_dir(dir: BorrowedFd<'_>) -> io::Result<OwnedFd> {
    rustix::fs::openat(
        dir,
        ".",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(io::Error::from)
}

/// Open a child directory relative to `dir` with `O_NOFOLLOW`, so a symlink
/// swapped in for a real subdirectory fails with `ELOOP`.
fn open_child_dir<P: rustix::path::Arg>(dir: BorrowedFd<'_>, name: P) -> io::Result<OwnedFd> {
    rustix::fs::openat(dir, name, dir_open_flags(), Mode::empty()).map_err(io::Error::from)
}

/// Classify an entry relative to `dir` WITHOUT following symlinks.
pub fn entry_file_type<P: rustix::path::Arg>(dir: BorrowedFd<'_>, name: P) -> io::Result<FileType> {
    let stat = rustix::fs::statat(dir, name, AtFlags::SYMLINK_NOFOLLOW).map_err(io::Error::from)?;
    Ok(FileType::from_raw_mode(stat.st_mode))
}

/// Convert a failure to open a supposedly-real subdirectory into a
/// descriptive error; a `symlink` re-classification means the entry was
/// swapped for a symlink and `O_NOFOLLOW` refused to traverse it.
fn describe_child_dir_error(parent: BorrowedFd<'_>, name: &OsStr, error: io::Error) -> io::Error {
    // Filesystem-domain helper: return the concrete `io::Error` (either a
    // descriptive re-classification or the original open failure) so callers
    // keep the kind; it is boxed into `UtsushiResult` at the call site.
    if let Ok(file_type) = entry_file_type(parent, name) {
        if file_type.is_symlink() {
            return io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "runtime artifact path component must not be a symlink: {}",
                    name.to_string_lossy()
                ),
            );
        }
        if !file_type.is_dir() {
            return io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "runtime artifact path component must be a directory: {}",
                    name.to_string_lossy()
                ),
            );
        }
    }
    error
}

/// Map a root-open failure onto a stable, descriptive error (e.g. the root
/// itself being a symlink that `O_NOFOLLOW` refused).
pub fn describe_root_open(path: &Path, error: io::Error) -> io::Error {
    // Filesystem-domain helper: keep the concrete `io::Error` (either a
    // descriptive re-classification or the original open failure); it is
    // boxed into `UtsushiResult` at the call site.
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "runtime artifact root must not be a symlink: {}",
                    path.display()
                ),
            );
        }
        if !metadata.is_dir() {
            return io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "runtime artifact root must be a directory: {}",
                    path.display()
                ),
            );
        }
    }
    error
}

fn create_dir_ignore_existing<P: rustix::path::Arg>(
    dir: BorrowedFd<'_>,
    name: P,
) -> UtsushiResult<()> {
    match rustix::fs::mkdirat(dir, name, Mode::RWXU) {
        Ok(()) => Ok(()),
        Err(error) if error == rustix::io::Errno::EXIST => Ok(()),
        Err(error) => Err(io::Error::from(error).into()),
    }
}

/// Descend `relative` from `root`, creating missing components, and return a
/// descriptor to the deepest directory. Each hop is `mkdirat` + `openat`
/// with `O_NOFOLLOW`, so no component can be a symlink at the moment we
/// traverse it.
pub fn open_or_create_dir_chain(root: BorrowedFd<'_>, relative: &Path) -> UtsushiResult<OwnedFd> {
    let mut current = reopen_dir(root)?;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(format!(
                "runtime artifact relative path must contain only normal segments: {}",
                relative.display()
            )
            .into());
        };
        create_dir_ignore_existing(current.as_fd(), name)?;
        let opened = open_child_dir(current.as_fd(), name);
        current = match opened {
            Ok(fd) => fd,
            Err(error) => {
                return Err(describe_child_dir_error(current.as_fd(), name, error).into());
            }
        };
    }
    Ok(current)
}

/// Open a child directory that may not exist, `O_NOFOLLOW`. A symlink in
/// that slot is refused (never followed).
pub fn open_child_dir_optional(dir: BorrowedFd<'_>, name: &str) -> UtsushiResult<Option<OwnedFd>> {
    match open_child_dir(dir, name) {
        Ok(fd) => Ok(Some(fd)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => {
            if let Ok(file_type) = entry_file_type(dir, name)
                && file_type.is_symlink()
            {
                return Err(
                    format!("runtime artifact staging root must not be a symlink: {name}").into(),
                );
            }
            Err(error.into())
        }
    }
}

/// Write `contents` to `filename` inside `dir` atomically and no-follow:
/// create a temp with `O_CREAT|O_EXCL|O_NOFOLLOW`, then `renameat` it over
/// the destination (rename never follows a symlink at the destination, so a
/// concurrently swapped-in symlink is replaced in place, never written
/// through). A symlink already occupying the destination is refused.
pub fn write_file_no_follow(
    dir: BorrowedFd<'_>,
    filename: &OsStr,
    contents: &[u8],
) -> UtsushiResult<()> {
    match entry_file_type(dir, filename) {
        Ok(file_type) if file_type.is_symlink() => {
            return Err(format!(
                "runtime artifact destination must not be a symlink: {}",
                filename.to_string_lossy()
            )
            .into());
        }
        Ok(file_type) if file_type.is_dir() => {
            return Err(format!(
                "runtime artifact destination must not be a directory: {}",
                filename.to_string_lossy()
            )
            .into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let base = filename.to_string_lossy();
    let mut last_error: Option<io::Error> = None;
    for attempt in 0..16 {
        let temporary = format!(".{base}.tmp-{}-{attempt}", std::process::id());
        match rustix::fs::openat(
            dir,
            temporary.as_str(),
            file_create_flags(),
            Mode::RUSR | Mode::WUSR,
        ) {
            Ok(fd) => {
                let mut file = std::fs::File::from(fd);
                if let Err(error) = file.write_all(contents).and_then(|()| file.sync_all()) {
                    let _ = rustix::fs::unlinkat(dir, temporary.as_str(), AtFlags::empty());
                    return Err(error.into());
                }
                drop(file);
                rustix::fs::renameat(dir, temporary.as_str(), dir, filename)
                    .map_err(io::Error::from)?;
                return Ok(());
            }
            Err(error) if error == rustix::io::Errno::EXIST => {
                last_error = Some(io::Error::from(error));
            }
            Err(error) => return Err(io::Error::from(error).into()),
        }
    }
    Err(last_error
        .unwrap_or_else(|| io::Error::new(io::ErrorKind::AlreadyExists, "temporary file exists"))
        .into())
}

/// Clear any stale entry occupying a staging filename, refusing a symlink or
/// directory squatting there. Used for an externally-written staging path so
/// the returned path is guaranteed not to be a link at hand-off time.
pub fn clear_staging_destination(dir: BorrowedFd<'_>, filename: &OsStr) -> UtsushiResult<()> {
    match entry_file_type(dir, filename) {
        Ok(file_type) if file_type.is_symlink() => Err(format!(
            "runtime artifact destination must not be a symlink: {}",
            filename.to_string_lossy()
        )
        .into()),
        Ok(file_type) if file_type.is_dir() => Err(format!(
            "runtime artifact destination must not be a directory: {}",
            filename.to_string_lossy()
        )
        .into()),
        Ok(_) => {
            rustix::fs::unlinkat(dir, filename, AtFlags::empty()).map_err(io::Error::from)?;
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Collect the entry names in `dir` (excluding `.`/`..`) via `getdents` on
/// the held descriptor.
pub fn read_dir_names(dir: BorrowedFd<'_>) -> UtsushiResult<Vec<CString>> {
    let mut names = Vec::new();
    let mut reader = Dir::read_from(dir).map_err(io::Error::from)?;
    while let Some(entry) = reader.read() {
        let entry = entry.map_err(io::Error::from)?;
        let name = entry.file_name();
        if name == c"." || name == c".." {
            continue;
        }
        names.push(name.to_owned());
    }
    Ok(names)
}

pub fn dir_has_entries(dir: BorrowedFd<'_>) -> UtsushiResult<bool> {
    Ok(!read_dir_names(dir)?.is_empty())
}

/// Remove an entry relative to `parent` without ever following a symlink.
/// Real directories are opened `O_NOFOLLOW`, emptied recursively, then
/// removed with `AT_REMOVEDIR`. Anything else (regular file, symlink, …) is
/// `unlinkat`ed in place, so a symlink is removed as a link and never
/// recursed into a target outside the root.
pub fn remove_entry(parent: BorrowedFd<'_>, name: &CStr) -> UtsushiResult<()> {
    let file_type = match entry_file_type(parent, name) {
        Ok(file_type) => file_type,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    if file_type.is_dir() {
        match open_child_dir(parent, name) {
            Ok(child) => {
                remove_dir_children(child.as_fd())?;
                drop(child);
                rustix::fs::unlinkat(parent, name, AtFlags::REMOVEDIR).map_err(io::Error::from)?;
            }
            Err(open_error) => {
                // The directory we classified may have been swapped for a
                // symlink between the stat and the open; re-classify
                // no-follow and, if it is now a symlink, unlink the LINK
                // (never follow it out of the root).
                match entry_file_type(parent, name) {
                    Ok(swapped) if swapped.is_symlink() => {
                        rustix::fs::unlinkat(parent, name, AtFlags::empty())
                            .map_err(io::Error::from)?;
                    }
                    Ok(_) => return Err(open_error.into()),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
    } else {
        rustix::fs::unlinkat(parent, name, AtFlags::empty()).map_err(io::Error::from)?;
    }
    Ok(())
}

fn remove_dir_children(dir: BorrowedFd<'_>) -> UtsushiResult<()> {
    for name in read_dir_names(dir)? {
        remove_entry(dir, &name)?;
    }
    Ok(())
}

/// Remove an empty directory relative to `parent` if present; tolerate a
/// concurrent race that refilled or removed it.
pub fn remove_empty_dir_if_present(parent: BorrowedFd<'_>, name: &CStr) -> UtsushiResult<()> {
    match rustix::fs::unlinkat(parent, name, AtFlags::REMOVEDIR) {
        Ok(()) => Ok(()),
        Err(error) if error == rustix::io::Errno::NOENT || error == rustix::io::Errno::NOTEMPTY => {
            Ok(())
        }
        Err(error) => Err(io::Error::from(error).into()),
    }
}

/// Create the managed root directory (and any missing ancestors) at setup
/// time, refusing symlinked components. This governs the root's own path
/// (operator space); every artifact operation thereafter is fd-relative
/// against the opened root descriptor.
pub fn create_directory_no_follow(path: &Path) -> UtsushiResult<()> {
    if path.as_os_str().is_empty() {
        return Err("runtime artifact root must not be empty".into());
    }

    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir | Component::Normal(_) => {
                current.push(component.as_os_str());
                match std::fs::symlink_metadata(&current) {
                    Ok(metadata) => {
                        if metadata.file_type().is_symlink() {
                            return Err(format!(
                                "runtime artifact path component must not be a symlink: {}",
                                current.display()
                            )
                            .into());
                        }
                        if !metadata.is_dir() {
                            return Err(format!(
                                "runtime artifact path component must be a directory: {}",
                                current.display()
                            )
                            .into());
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        std::fs::create_dir(&current)?;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
    }
    Ok(())
}

/// Write the managed-root marker relative to the held root descriptor
/// (`O_CREAT|O_EXCL|O_NOFOLLOW`), so it cannot land on a swapped-in symlink.
pub fn write_marker(root: BorrowedFd<'_>) -> UtsushiResult<()> {
    let fd = rustix::fs::openat(
        root,
        RUNTIME_ARTIFACT_ROOT_MARKER,
        file_create_flags(),
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(io::Error::from)?;
    let mut file = std::fs::File::from(fd);
    file.write_all(b"managed-by=utsushi-runtime\n")?;
    file.sync_all()?;
    Ok(())
}
