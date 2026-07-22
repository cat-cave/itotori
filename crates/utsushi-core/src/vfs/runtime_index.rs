use super::*;

/// Walk `root` recursively, building a case-folded index of every file
/// path relative to `root`. Used as the one-shot lazy initialiser for
/// [`PlaintextDirPackage::case_folded_index`].
///
/// Directory traversal failures are surfaced via [`VfsError::PackageIo`]
/// so the composite resolver reports a redaction-safe diagnostic instead
/// of leaking the host path through the underlying `io::Error`.
pub(super) fn build_dir_index(package_id: &str, root: &Path) -> Result<CaseFoldedIndex, VfsError> {
    let mut index = CaseFoldedIndex::new();
    let root_metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // No root → empty index. Composite resolves miss; no error.
            return Ok(index);
        }
        Err(error) => {
            return Err(VfsError::PackageIo {
                id: AssetId::from_parts(package_id, "")?,
                summary: IoSummary::from_io_error_kind(error.kind()),
            });
        }
    };
    if !root_metadata.is_dir() {
        return Ok(index);
    }
    walk_dir(package_id, root, root, &mut index)?;
    Ok(index)
}

fn walk_dir(
    package_id: &str,
    root: &Path,
    current: &Path,
    index: &mut CaseFoldedIndex,
) -> Result<(), VfsError> {
    let entries = match fs::read_dir(current) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(VfsError::PackageIo {
                id: AssetId::from_parts(package_id, "")?,
                summary: IoSummary::from_io_error_kind(error.kind()),
            });
        }
    };
    for entry in entries {
        let entry = entry.map_err(|error| VfsError::PackageIo {
            id: AssetId::from_parts(package_id, "").expect("valid package id"),
            summary: IoSummary::from_io_error_kind(error.kind()),
        })?;
        let file_type = entry.file_type().map_err(|error| VfsError::PackageIo {
            id: AssetId::from_parts(package_id, "").expect("valid package id"),
            summary: IoSummary::from_io_error_kind(error.kind()),
        })?;
        let entry_path = entry.path();
        if file_type.is_dir() {
            walk_dir(package_id, root, &entry_path, index)?;
        } else if file_type.is_file() {
            let Ok(relative) = entry_path.strip_prefix(root) else {
                continue;
            };
            // Build a forward-slash-separated logical path from the
            // platform-native path components. Skip non-UTF8 names.
            let mut segments: Vec<String> = Vec::new();
            let mut valid = true;
            for component in relative.components() {
                let Component::Normal(os_segment) = component else {
                    continue;
                };
                if let Some(segment) = os_segment.to_str() {
                    segments.push(segment.to_string());
                } else {
                    valid = false;
                    break;
                }
            }
            if !valid || segments.is_empty() {
                continue;
            }
            index.insert(segments.join("/"));
        }
    }
    Ok(())
}
