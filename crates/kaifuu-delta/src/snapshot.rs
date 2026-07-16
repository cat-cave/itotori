use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use kaifuu_core::{KaifuuResult, validate_safe_relative_path};

use crate::content_codec::sha256_hex;
use crate::{DELTA_HASH_VERSION, DirectorySnapshot, FileRecord, FileSnapshot};

pub(crate) fn snapshot_directory(root: &Path) -> KaifuuResult<DirectorySnapshot> {
    let mut files = BTreeMap::new();
    collect_files(root, root, &mut files)?;
    let byte_count = files.values().map(|file| file.size_bytes).sum();
    Ok(DirectorySnapshot {
        root_hash: root_hash(files.values()),
        byte_count,
        files,
    })
}

pub(crate) fn snapshot_from_records(records: &[FileRecord]) -> KaifuuResult<DirectorySnapshot> {
    let mut files = BTreeMap::new();
    for record in records {
        validate_relative_package_path(&record.path)?;
        let snapshot = FileSnapshot {
            path: record.path.clone(),
            hash: record.hash.clone(),
            size_bytes: record.size_bytes,
        };
        if files.insert(record.path.clone(), snapshot).is_some() {
            return Err(format!("duplicate file manifest path {}", record.path).into());
        }
    }
    validate_materializable_file_paths(files.keys().map(String::as_str), "file manifest")?;
    let byte_count = files.values().map(|file| file.size_bytes).sum();
    Ok(DirectorySnapshot {
        root_hash: root_hash(files.values()),
        byte_count,
        files,
    })
}

fn collect_files(
    root: &Path,
    current: &Path,
    files: &mut BTreeMap<String, FileSnapshot>,
) -> KaifuuResult<()> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_dir() {
            collect_files(root, &path, files)?;
        } else if file_type.is_file() {
            let relative_path = relative_package_path(root, &path)?;
            let bytes = fs::read(&path)?;
            let snapshot = FileSnapshot {
                path: relative_path.clone(),
                hash: sha256_hex(&bytes),
                size_bytes: bytes.len() as u64,
            };
            files.insert(relative_path, snapshot);
        } else {
            return Err(format!(
                "delta package cannot include non-regular file {}",
                path.display()
            )
            .into());
        }
    }
    Ok(())
}

fn relative_package_path(root: &Path, path: &Path) -> KaifuuResult<String> {
    let relative = path.strip_prefix(root)?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let part = component
            .as_os_str()
            .to_str()
            .ok_or("delta package paths must be UTF-8")?;
        if part.contains('/') || part.contains('\\') {
            return Err(
                "delta package path components must not contain separator characters".into(),
            );
        }
        parts.push(part.to_string());
    }
    let relative_path = parts.join("/");
    validate_relative_package_path(&relative_path)?;
    Ok(relative_path)
}

pub(crate) fn validate_relative_package_path(path: &str) -> KaifuuResult<()> {
    validate_safe_relative_path(path)
}

pub(crate) fn validate_materializable_file_paths<'a>(
    paths: impl IntoIterator<Item = &'a str>,
    context: &str,
) -> KaifuuResult<()> {
    let mut files = BTreeSet::new();
    for path in paths {
        let normalized_path = materializable_path_key(path)?;
        if !files.insert(normalized_path.clone()) {
            return Err(format!(
                "{context} contains duplicate materialized path {normalized_path}"
            )
            .into());
        }
    }
    for path in &files {
        let mut ancestor = String::new();
        let parts = path.split('/').collect::<Vec<_>>();
        for part in parts.iter().take(parts.len().saturating_sub(1)) {
            if !ancestor.is_empty() {
                ancestor.push('/');
            }
            ancestor.push_str(part);
            if files.contains(&ancestor) {
                return Err(format!(
                    "{context} contains file/dir prefix conflict: {ancestor} blocks {path}"
                )
                .into());
            }
        }
    }
    Ok(())
}

fn materializable_path_key(path: &str) -> KaifuuResult<String> {
    validate_relative_package_path(path)?;
    Ok(path.to_string())
}

pub(crate) fn file_records(files: &BTreeMap<String, FileSnapshot>) -> Vec<FileRecord> {
    files
        .values()
        .map(|file| FileRecord {
            path: file.path.clone(),
            hash: file.hash.clone(),
            size_bytes: file.size_bytes,
        })
        .collect()
}

pub(crate) fn root_hash<'a>(files: impl IntoIterator<Item = &'a FileSnapshot>) -> String {
    let mut manifest = String::from(DELTA_HASH_VERSION);
    manifest.push('\n');
    for file in files {
        manifest.push_str(&file.hash);
        manifest.push(' ');
        manifest.push_str(&file.size_bytes.to_string());
        manifest.push(' ');
        manifest.push_str(&file.path);
        manifest.push('\n');
    }
    sha256_hex(manifest.as_bytes())
}
