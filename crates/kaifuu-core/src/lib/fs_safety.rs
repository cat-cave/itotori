use super::*;

pub fn safe_join_relative(root: &Path, relative_path: &str) -> KaifuuResult<PathBuf> {
    let parts = safe_relative_path_parts(relative_path)?;
    let mut output_path = root.to_path_buf();
    for part in parts {
        output_path.push(part);
    }
    Ok(output_path)
}

/// Validates Kaifuu's portable relative path rule for package-controlled writes
/// and profile asset paths.
/// This only validates the caller-provided string. It does not normalize,
/// canonicalize, or return a safe output path. Use [`safe_join_relative`] when a
/// validated relative path must be materialized under a trusted root.
/// The rule uses `/` as the only path separator and rejects empty paths,
/// absolute paths, empty components, `.` components, `..` components, NUL
/// bytes, backslashes, and Windows drive-prefix components anywhere in the
/// path.
pub fn validate_safe_relative_path(relative_path: &str) -> KaifuuResult<()> {
    safe_relative_path_parts(relative_path)?;
    Ok(())
}

pub(super) fn safe_relative_path_parts(relative_path: &str) -> KaifuuResult<Vec<&str>> {
    if relative_path.is_empty()
        || relative_path.starts_with('/')
        || relative_path.contains('\\')
        || relative_path.contains('\0')
    {
        return Err(unsafe_relative_path_error(relative_path).into());
    }

    let parts = relative_path.split('/').collect::<Vec<_>>();
    if parts.iter().enumerate().any(|(index, part)| {
        part.is_empty()
            || *part == "."
            || *part == ".."
            || (index == 0 && part.ends_with(':'))
            || is_windows_drive_prefix_component(part)
    }) {
        return Err(unsafe_relative_path_error(relative_path).into());
    }

    Ok(parts)
}

fn is_windows_drive_prefix_component(component: &str) -> bool {
    let bytes = component.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

pub(super) fn path_has_windows_drive_prefix_component(path: &str) -> bool {
    path.split(['/', '\\'])
        .any(is_windows_drive_prefix_component)
}

fn unsafe_relative_path_error(relative_path: &str) -> io::Error {
    // Typed as `io::Error` with `InvalidInput`: this rejects a caller-supplied
    // relative path that violates the portable path rule. Callers box it into
    // `KaifuuResult` via `?`/`.into`, but keeping the concrete `io::Error`
    // lets consumers match on `ErrorKind::InvalidInput`.
    io::Error::new(
        ErrorKind::InvalidInput,
        format!(
            "unsafe relative output path {relative_path:?}: path must be relative and must not contain backslashes, dot components, traversal, or drive prefixes"
        ),
    )
}

pub fn atomic_write_text(path: &Path, content: &str) -> KaifuuResult<()> {
    atomic_write_bytes(path, content.as_bytes())
}

/// Atomically write arbitrary bytes to `path` (create-new temp + fsync +
/// rename), mirroring [`atomic_write_text`]. Used for binary patch-back outputs
/// (e.g. a re-emitted profiled Siglus container) that are not valid UTF-8.
pub fn atomic_write_bytes(path: &Path, content: &[u8]) -> KaifuuResult<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or("atomic write target must include a file name")?
        .to_string_lossy();
    fs::create_dir_all(parent)?;

    let mut attempt = 0_u32;
    let temp_path = loop {
        let candidate = parent.join(format!(".{file_name}.tmp-{}-{attempt}", std::process::id()));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                if let Err(error) = write_and_sync(&mut file, content) {
                    let _ = fs::remove_file(&candidate);
                    return Err(error);
                }
                break candidate;
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                attempt = attempt
                    .checked_add(1)
                    .ok_or("could not allocate atomic write temp file")?;
            }
            Err(error) => return Err(error.into()),
        }
    };

    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error.into());
    }
    sync_directory_best_effort(parent);
    Ok(())
}

pub fn promote_staged_directory_no_clobber(
    staging_dir: &Path,
    output_dir: &Path,
    output_label: &str,
) -> KaifuuResult<()> {
    let staging_metadata = fs::symlink_metadata(staging_dir)?;
    if !staging_metadata.is_dir() || staging_metadata.file_type().is_symlink() {
        return Err(format!(
            "{output_label} staging path must be a real directory: {}",
            redact_for_log_or_report(&staging_dir.display().to_string())
        )
        .into());
    }

    let parent = output_dir.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    if fs::symlink_metadata(output_dir).is_ok() {
        return Err(output_already_exists_error(output_label, output_dir).into());
    }

    match rename_directory_no_replace(staging_dir, output_dir) {
        Ok(()) => {
            sync_directory_best_effort(parent);
            Ok(())
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            Err(output_already_exists_error(output_label, output_dir).into())
        }
        Err(_error) if fs::symlink_metadata(output_dir).is_ok() => {
            Err(output_already_exists_error(output_label, output_dir).into())
        }
        Err(error) => Err(format!(
            "{output_label} promotion failed without replacing an existing output path: {error}"
        )
        .into()),
    }
}

fn output_already_exists_error(output_label: &str, output_dir: &Path) -> io::Error {
    // Typed as `io::Error` with `AlreadyExists`: the no-clobber promotion
    // refuses to replace an existing output path. The concrete kind lets
    // callers distinguish "already present" from other promotion failures;
    // it is boxed into `KaifuuResult` at the call site via `?`/`.into`.
    io::Error::new(
        ErrorKind::AlreadyExists,
        format!(
            "{output_label} already exists; refusing to replace it during no-clobber promotion: {}",
            redact_for_log_or_report(&output_dir.display().to_string())
        ),
    )
}

#[cfg(all(
    target_os = "linux",
    any(
        target_arch = "aarch64",
        target_arch = "arm",
        target_arch = "powerpc64",
        target_arch = "riscv64",
        target_arch = "s390x",
        target_arch = "x86",
        target_arch = "x86_64"
    )
))]
// reason: no-clobber directory promotion needs the raw renameat2 syscall
// (RENAME_NOREPLACE); there is no safe std wrapper. The FFI decl + call are the
// minimal unsafe surface; unsafe is denied everywhere else in the crate.
#[allow(unsafe_code)]
fn rename_directory_no_replace(staging_dir: &Path, output_dir: &Path) -> io::Result<()> {
    use std::os::raw::{c_char, c_long};
    use std::os::unix::ffi::OsStrExt;

    const AT_FDCWD: c_long = -100;
    const RENAME_NOREPLACE: c_long = 1;

    #[cfg(target_arch = "aarch64")]
    const SYS_RENAMEAT2: c_long = 276;
    #[cfg(target_arch = "arm")]
    const SYS_RENAMEAT2: c_long = 382;
    #[cfg(target_arch = "powerpc64")]
    const SYS_RENAMEAT2: c_long = 357;
    #[cfg(target_arch = "riscv64")]
    const SYS_RENAMEAT2: c_long = 276;
    #[cfg(target_arch = "s390x")]
    const SYS_RENAMEAT2: c_long = 347;
    #[cfg(target_arch = "x86")]
    const SYS_RENAMEAT2: c_long = 353;
    #[cfg(target_arch = "x86_64")]
    const SYS_RENAMEAT2: c_long = 316;

    unsafe extern "C" {
        fn syscall(num: c_long, ...) -> c_long;
    }

    let staging = CString::new(staging_dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "staging path contains NUL byte"))?;
    let output = CString::new(output_dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "output path contains NUL byte"))?;
    let result = unsafe {
        syscall(
            SYS_RENAMEAT2,
            AT_FDCWD,
            staging.as_ptr().cast::<c_char>(),
            AT_FDCWD,
            output.as_ptr().cast::<c_char>(),
            RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(all(
    target_os = "linux",
    not(any(
        target_arch = "aarch64",
        target_arch = "arm",
        target_arch = "powerpc64",
        target_arch = "riscv64",
        target_arch = "s390x",
        target_arch = "x86",
        target_arch = "x86_64"
    ))
))]
fn rename_directory_no_replace(_staging_dir: &Path, _output_dir: &Path) -> io::Result<()> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "no-clobber directory promotion is not implemented for this Linux architecture",
    ))
}

#[cfg(target_os = "macos")]
// reason: no-clobber directory promotion needs the renamex_np(RENAME_EXCL) FFI;
// there is no safe std wrapper. Minimal unsafe surface; unsafe is denied
// everywhere else in the crate.
#[allow(unsafe_code)]
fn rename_directory_no_replace(staging_dir: &Path, output_dir: &Path) -> io::Result<()> {
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt;

    const RENAME_EXCL: u32 = 0x0000_0004;

    unsafe extern "C" {
        fn renamex_np(from: *const c_char, to: *const c_char, flags: u32) -> c_int;
    }

    let staging = CString::new(staging_dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "staging path contains NUL byte"))?;
    let output = CString::new(output_dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "output path contains NUL byte"))?;
    let result = unsafe { renamex_np(staging.as_ptr(), output.as_ptr(), RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_directory_no_replace(staging_dir: &Path, output_dir: &Path) -> io::Result<()> {
    fs::rename(staging_dir, output_dir)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn rename_directory_no_replace(_staging_dir: &Path, _output_dir: &Path) -> io::Result<()> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "no-clobber directory promotion requires a platform no-replace rename primitive",
    ))
}

fn write_and_sync(file: &mut File, content: &[u8]) -> KaifuuResult<()> {
    file.write_all(content)?;
    file.sync_all()?;
    Ok(())
}

pub(super) fn write_secret_material_no_clobber(
    path: &Path,
    material: &[u8],
) -> Result<(), KeyResolverError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == ErrorKind::AlreadyExists {
                KeyResolverError::out_of_policy(
                    None,
                    Some(SecretRefScheme::LocalSecret),
                    "local-secret import refuses to overwrite existing material",
                )
            } else {
                KeyResolverError::store_unavailable(
                    "local secret store could not create imported material",
                )
            }
        })?;
    file.write_all(material).map_err(|_| {
        KeyResolverError::store_unavailable("local secret store could not write imported material")
    })?;
    file.sync_all().map_err(|_| {
        KeyResolverError::store_unavailable("local secret store could not sync imported material")
    })
}

pub(super) fn ensure_real_directory(path: &Path) -> Result<(), KeyResolverError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                return Err(KeyResolverError::out_of_policy(
                    None,
                    Some(SecretRefScheme::LocalSecret),
                    "local secret store directories must be real directories",
                ));
            }
            Ok(())
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|_| {
                KeyResolverError::store_unavailable(
                    "local secret store directory could not be created",
                )
            })?;
            ensure_real_directory(path)
        }
        Err(_) => Err(KeyResolverError::store_unavailable(
            "local secret store directory metadata could not be read",
        )),
    }
}

fn sync_directory_best_effort(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}
