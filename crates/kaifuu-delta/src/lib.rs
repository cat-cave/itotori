use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use kaifuu_core::{
    KaifuuResult, deterministic_id, read_json, safe_join_relative, validate_safe_relative_path,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const DELTA_SCHEMA_VERSION: &str = "0.2.0";
const DELTA_FORMAT: &str = "kaifuu-delta-package";
const DELTA_HASH_VERSION: &str = "kaifuu-delta-root-v0.2";
const ROOT_PATCH_RESULT_ARTIFACT: &str = "patch-result.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeltaPackage {
    schema_version: String,
    delta_package_id: String,
    format: String,
    metadata: DeltaMetadata,
    source_compatibility: SourceCompatibility,
    target: TargetManifest,
    changed_entries: Vec<ChangedEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeltaMetadata {
    generator: String,
    hash_algorithm: String,
    path_encoding: String,
    content_encodings: Vec<String>,
    ignored_artifacts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceCompatibility {
    root_hash: String,
    file_count: u64,
    byte_count: u64,
    files: Vec<FileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetManifest {
    root_hash: String,
    file_count: u64,
    byte_count: u64,
    files: Vec<FileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileRecord {
    path: String,
    hash: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangedEntry {
    path: String,
    operation: DeltaOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_encoding: Option<ContentEncoding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DeltaOperation {
    Add,
    Replace,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ContentEncoding {
    Utf8,
    Hex,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileSnapshot {
    path: String,
    hash: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DirectorySnapshot {
    root_hash: String,
    byte_count: u64,
    files: BTreeMap<String, FileSnapshot>,
}

pub fn create_delta(original_dir: &Path, patched_dir: &Path) -> KaifuuResult<Value> {
    let original = snapshot_directory(original_dir)?;
    let patched = snapshot_directory(patched_dir)?;
    let mut changed_entries = Vec::new();
    let paths = original
        .files
        .keys()
        .chain(patched.files.keys())
        .cloned()
        .collect::<BTreeSet<_>>();

    for path in paths {
        let original_file = original.files.get(&path);
        let patched_file = patched.files.get(&path);
        match (original_file, patched_file) {
            (Some(source), Some(target)) if source.hash == target.hash => {}
            (None, Some(target)) => {
                changed_entries.push(content_entry(
                    patched_dir,
                    target,
                    DeltaOperation::Add,
                    None,
                    None,
                )?);
            }
            (Some(source), Some(target)) => {
                changed_entries.push(content_entry(
                    patched_dir,
                    target,
                    DeltaOperation::Replace,
                    Some(source.hash.clone()),
                    Some(source.size_bytes),
                )?);
            }
            (Some(source), None) => {
                changed_entries.push(ChangedEntry {
                    path: source.path.clone(),
                    operation: DeltaOperation::Delete,
                    source_hash: Some(source.hash.clone()),
                    source_size_bytes: Some(source.size_bytes),
                    target_hash: None,
                    target_size_bytes: None,
                    content_encoding: None,
                    content: None,
                });
            }
            (None, None) => {}
        }
    }

    let package = DeltaPackage {
        schema_version: DELTA_SCHEMA_VERSION.to_string(),
        delta_package_id: deterministic_id("delta", 2),
        format: DELTA_FORMAT.to_string(),
        metadata: DeltaMetadata {
            generator: "kaifuu-delta/0.2".to_string(),
            hash_algorithm: "sha256".to_string(),
            path_encoding: "relative-utf8-posix".to_string(),
            content_encodings: vec!["utf8".to_string(), "hex".to_string()],
            ignored_artifacts: vec![ROOT_PATCH_RESULT_ARTIFACT.to_string()],
        },
        source_compatibility: SourceCompatibility {
            root_hash: original.root_hash,
            file_count: original.files.len() as u64,
            byte_count: original.byte_count,
            files: file_records(&original.files),
        },
        target: TargetManifest {
            root_hash: patched.root_hash,
            file_count: patched.files.len() as u64,
            byte_count: patched.byte_count,
            files: file_records(&patched.files),
        },
        changed_entries,
    };

    Ok(serde_json::to_value(package)?)
}

pub fn apply_delta(game_dir: &Path, delta_path: &Path, output_dir: &Path) -> KaifuuResult<Value> {
    let package: DeltaPackage = read_json(delta_path)?;
    validate_package_shape(&package)?;
    if output_dir.exists() {
        return Err(format!(
            "delta output directory already exists: {}",
            output_dir.display()
        )
        .into());
    }

    let actual_source = snapshot_directory(game_dir)?;
    let expected_source = snapshot_from_records(&package.source_compatibility.files)?;
    if package.source_compatibility.file_count != expected_source.files.len() as u64
        || package.source_compatibility.byte_count != expected_source.byte_count
    {
        return Err("delta package source manifest counts are inconsistent".into());
    }
    if actual_source.root_hash != package.source_compatibility.root_hash
        || expected_source.root_hash != package.source_compatibility.root_hash
        || actual_source.files != expected_source.files
    {
        return Err(format!(
            "source root hash does not match delta package: expected {}, actual {}",
            package.source_compatibility.root_hash, actual_source.root_hash
        )
        .into());
    }

    let expected_target = snapshot_from_records(&package.target.files)?;
    if package.target.file_count != expected_target.files.len() as u64
        || package.target.byte_count != expected_target.byte_count
    {
        return Err("delta package target manifest counts are inconsistent".into());
    }
    if expected_target.root_hash != package.target.root_hash {
        return Err("delta package target manifest root hash is inconsistent".into());
    }
    validate_changed_entry_hashes(&package)?;
    let preflight_target = preflight_target_snapshot(&actual_source, &package)?;
    if preflight_target.root_hash != package.target.root_hash
        || preflight_target.files != expected_target.files
    {
        return Err("delta package changed entries do not reproduce target manifest".into());
    }

    let changed_by_path = package
        .changed_entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    let staging_dir = allocate_staging_dir(output_dir)?;
    if let Err(error) = materialize_output(game_dir, &staging_dir, &actual_source, &changed_by_path)
    {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error);
    }
    let staged_snapshot = match snapshot_directory(&staging_dir) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(error);
        }
    };
    if staged_snapshot.root_hash != package.target.root_hash
        || staged_snapshot.files != expected_target.files
    {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err("staged delta output does not match target manifest".into());
    }
    if let Err(error) = fs::rename(&staging_dir, output_dir) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error.into());
    }

    Ok(json!({
        "schemaVersion": DELTA_SCHEMA_VERSION,
        "patchResultId": deterministic_id("delta-apply", 2),
        "deltaPackageId": package.delta_package_id,
        "status": "passed",
        "sourceCompatibility": {
            "status": "compatible",
            "expectedRootHash": package.source_compatibility.root_hash,
            "actualRootHash": actual_source.root_hash,
            "checkedFileCount": actual_source.files.len()
        },
        "changedFileCount": package.changed_entries.len(),
        "outputHash": package.target.root_hash,
        "failures": []
    }))
}

fn content_entry(
    patched_dir: &Path,
    target: &FileSnapshot,
    operation: DeltaOperation,
    source_hash: Option<String>,
    source_size_bytes: Option<u64>,
) -> KaifuuResult<ChangedEntry> {
    let bytes = fs::read(safe_join_relative(patched_dir, &target.path)?)?;
    let (content_encoding, content) = encode_content(&bytes);
    Ok(ChangedEntry {
        path: target.path.clone(),
        operation,
        source_hash,
        source_size_bytes,
        target_hash: Some(target.hash.clone()),
        target_size_bytes: Some(target.size_bytes),
        content_encoding: Some(content_encoding),
        content: Some(content),
    })
}

fn validate_package_shape(package: &DeltaPackage) -> KaifuuResult<()> {
    if package.schema_version != DELTA_SCHEMA_VERSION {
        return Err(format!(
            "unsupported delta schema version {}",
            package.schema_version
        )
        .into());
    }
    if package.format != DELTA_FORMAT {
        return Err(format!("unsupported delta format {}", package.format).into());
    }
    if package.metadata.hash_algorithm != "sha256" {
        return Err("delta package hash algorithm must be sha256".into());
    }
    let mut paths = BTreeSet::new();
    for entry in &package.changed_entries {
        validate_relative_package_path(&entry.path)?;
        validate_not_ignored_artifact_path(&entry.path)?;
        if !paths.insert(entry.path.as_str()) {
            return Err(format!(
                "delta package has duplicate changed entry path {}",
                entry.path
            )
            .into());
        }
        match entry.operation {
            DeltaOperation::Add => {
                require_absent(&entry.source_hash, "add entry sourceHash")?;
                require_absent(&entry.source_size_bytes, "add entry sourceSizeBytes")?;
                require_present(&entry.target_hash, "add entry targetHash")?;
                require_present(&entry.target_size_bytes, "add entry targetSizeBytes")?;
                require_present(&entry.content_encoding, "add entry contentEncoding")?;
                require_present(&entry.content, "add entry content")?;
            }
            DeltaOperation::Replace => {
                require_present(&entry.source_hash, "replace entry sourceHash")?;
                require_present(&entry.source_size_bytes, "replace entry sourceSizeBytes")?;
                require_present(&entry.target_hash, "replace entry targetHash")?;
                require_present(&entry.target_size_bytes, "replace entry targetSizeBytes")?;
                require_present(&entry.content_encoding, "replace entry contentEncoding")?;
                require_present(&entry.content, "replace entry content")?;
            }
            DeltaOperation::Delete => {
                require_present(&entry.source_hash, "delete entry sourceHash")?;
                require_present(&entry.source_size_bytes, "delete entry sourceSizeBytes")?;
                require_absent(&entry.target_hash, "delete entry targetHash")?;
                require_absent(&entry.target_size_bytes, "delete entry targetSizeBytes")?;
                require_absent(&entry.content_encoding, "delete entry contentEncoding")?;
                require_absent(&entry.content, "delete entry content")?;
            }
        }
    }
    Ok(())
}

fn validate_changed_entry_hashes(package: &DeltaPackage) -> KaifuuResult<()> {
    let source_records = package
        .source_compatibility
        .files
        .iter()
        .map(|record| (record.path.as_str(), record))
        .collect::<BTreeMap<_, _>>();
    let target_records = package
        .target
        .files
        .iter()
        .map(|record| (record.path.as_str(), record))
        .collect::<BTreeMap<_, _>>();

    for entry in &package.changed_entries {
        match entry.operation {
            DeltaOperation::Add => {
                if source_records.contains_key(entry.path.as_str()) {
                    return Err(
                        format!("add entry {} exists in source manifest", entry.path).into(),
                    );
                }
                let target = target_records.get(entry.path.as_str()).ok_or_else(|| {
                    format!("add entry {} missing from target manifest", entry.path)
                })?;
                validate_content_hash(entry, target)?;
            }
            DeltaOperation::Replace => {
                let source = source_records.get(entry.path.as_str()).ok_or_else(|| {
                    format!("replace entry {} missing from source manifest", entry.path)
                })?;
                let target = target_records.get(entry.path.as_str()).ok_or_else(|| {
                    format!("replace entry {} missing from target manifest", entry.path)
                })?;
                if Some(source.hash.as_str()) != entry.source_hash.as_deref()
                    || Some(source.size_bytes) != entry.source_size_bytes
                {
                    return Err(format!(
                        "replace entry {} source hash does not match manifest",
                        entry.path
                    )
                    .into());
                }
                validate_content_hash(entry, target)?;
            }
            DeltaOperation::Delete => {
                let source = source_records.get(entry.path.as_str()).ok_or_else(|| {
                    format!("delete entry {} missing from source manifest", entry.path)
                })?;
                if target_records.contains_key(entry.path.as_str()) {
                    return Err(format!(
                        "delete entry {} still exists in target manifest",
                        entry.path
                    )
                    .into());
                }
                if Some(source.hash.as_str()) != entry.source_hash.as_deref()
                    || Some(source.size_bytes) != entry.source_size_bytes
                {
                    return Err(format!(
                        "delete entry {} source hash does not match manifest",
                        entry.path
                    )
                    .into());
                }
            }
        }
    }
    Ok(())
}

fn preflight_target_snapshot(
    actual_source: &DirectorySnapshot,
    package: &DeltaPackage,
) -> KaifuuResult<DirectorySnapshot> {
    let mut files = actual_source.files.clone();
    for entry in &package.changed_entries {
        if matches!(
            entry.operation,
            DeltaOperation::Replace | DeltaOperation::Delete
        ) && files.remove(entry.path.as_str()).is_none()
        {
            let message = match entry.operation {
                DeltaOperation::Replace => {
                    format!("replace entry {} missing from source snapshot", entry.path)
                }
                DeltaOperation::Delete => {
                    format!("delete entry {} missing from source snapshot", entry.path)
                }
                DeltaOperation::Add => unreachable!(),
            };
            return Err(message.into());
        }
    }
    for entry in &package.changed_entries {
        match entry.operation {
            DeltaOperation::Add => {
                if files.contains_key(entry.path.as_str()) {
                    return Err(
                        format!("add entry {} exists in source snapshot", entry.path).into(),
                    );
                }
                let content = decode_entry_content(entry)?;
                files.insert(entry.path.clone(), content_snapshot(entry, &content));
            }
            DeltaOperation::Replace => {
                let content = decode_entry_content(entry)?;
                files.insert(entry.path.clone(), content_snapshot(entry, &content));
            }
            DeltaOperation::Delete => {}
        }
    }
    validate_materializable_file_paths(files.keys().map(String::as_str), "preflight target")?;
    let byte_count = files.values().map(|file| file.size_bytes).sum();
    Ok(DirectorySnapshot {
        root_hash: root_hash(files.values()),
        byte_count,
        files,
    })
}

fn content_snapshot(entry: &ChangedEntry, content: &[u8]) -> FileSnapshot {
    FileSnapshot {
        path: entry.path.clone(),
        hash: sha256_hex(content),
        size_bytes: content.len() as u64,
    }
}

fn validate_content_hash(entry: &ChangedEntry, target: &FileRecord) -> KaifuuResult<()> {
    if Some(target.hash.as_str()) != entry.target_hash.as_deref()
        || Some(target.size_bytes) != entry.target_size_bytes
    {
        return Err(format!("entry {} target hash does not match manifest", entry.path).into());
    }
    let content = decode_entry_content(entry)?;
    if sha256_hex(&content) != target.hash || content.len() as u64 != target.size_bytes {
        return Err(format!(
            "entry {} content hash does not match targetHash",
            entry.path
        )
        .into());
    }
    Ok(())
}

fn materialize_output(
    game_dir: &Path,
    staging_dir: &Path,
    actual_source: &DirectorySnapshot,
    changed_by_path: &BTreeMap<&str, &ChangedEntry>,
) -> KaifuuResult<()> {
    for source_file in actual_source.files.values() {
        if matches!(
            changed_by_path
                .get(source_file.path.as_str())
                .map(|entry| entry.operation),
            Some(DeltaOperation::Delete | DeltaOperation::Replace)
        ) {
            continue;
        }
        let source_path = safe_join_relative(game_dir, &source_file.path)?;
        let target_path = safe_join_relative(staging_dir, &source_file.path)?;
        copy_file(&source_path, &target_path)?;
    }

    for entry in changed_by_path.values() {
        match entry.operation {
            DeltaOperation::Add | DeltaOperation::Replace => {
                let output_path = safe_join_relative(staging_dir, &entry.path)?;
                write_bytes(&output_path, &decode_entry_content(entry)?)?;
            }
            DeltaOperation::Delete => {}
        }
    }
    Ok(())
}

fn copy_file(source_path: &Path, target_path: &Path) -> KaifuuResult<()> {
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source_path, target_path)?;
    Ok(())
}

fn write_bytes(path: &Path, bytes: &[u8]) -> KaifuuResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, bytes)?;
    Ok(())
}

fn allocate_staging_dir(output_dir: &Path) -> KaifuuResult<PathBuf> {
    let parent = output_dir.parent().unwrap_or_else(|| Path::new("."));
    let file_name = output_dir
        .file_name()
        .ok_or("delta output directory must include a final path component")?
        .to_string_lossy();
    fs::create_dir_all(parent)?;
    for attempt in 0_u32..1000 {
        let candidate = parent.join(format!(".{file_name}.tmp-{}-{attempt}", std::process::id()));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err("could not allocate delta staging directory".into())
}

fn snapshot_directory(root: &Path) -> KaifuuResult<DirectorySnapshot> {
    let mut files = BTreeMap::new();
    collect_files(root, root, &mut files)?;
    let byte_count = files.values().map(|file| file.size_bytes).sum();
    Ok(DirectorySnapshot {
        root_hash: root_hash(files.values()),
        byte_count,
        files,
    })
}

fn snapshot_from_records(records: &[FileRecord]) -> KaifuuResult<DirectorySnapshot> {
    let mut files = BTreeMap::new();
    for record in records {
        validate_relative_package_path(&record.path)?;
        validate_not_ignored_artifact_path(&record.path)?;
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
            if ignored_artifact_path(&relative_path) {
                continue;
            }
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

fn validate_relative_package_path(path: &str) -> KaifuuResult<()> {
    validate_safe_relative_path(path)
}

fn validate_not_ignored_artifact_path(path: &str) -> KaifuuResult<()> {
    if ignored_artifact_path(path) {
        return Err(format!("delta package path {path} is an ignored artifact").into());
    }
    Ok(())
}

fn ignored_artifact_path(path: &str) -> bool {
    path == ROOT_PATCH_RESULT_ARTIFACT
        || path
            .strip_prefix(ROOT_PATCH_RESULT_ARTIFACT)
            .is_some_and(|suffix| suffix.starts_with(['/', '\\']))
}

fn validate_materializable_file_paths<'a>(
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
    Ok(path.split(['/', '\\']).collect::<Vec<_>>().join("/"))
}

fn file_records(files: &BTreeMap<String, FileSnapshot>) -> Vec<FileRecord> {
    files
        .values()
        .map(|file| FileRecord {
            path: file.path.clone(),
            hash: file.hash.clone(),
            size_bytes: file.size_bytes,
        })
        .collect()
}

fn root_hash<'a>(files: impl IntoIterator<Item = &'a FileSnapshot>) -> String {
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

fn encode_content(bytes: &[u8]) -> (ContentEncoding, String) {
    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => (ContentEncoding::Utf8, text),
        Err(_) => (ContentEncoding::Hex, hex_encode(bytes)),
    }
}

fn decode_entry_content(entry: &ChangedEntry) -> KaifuuResult<Vec<u8>> {
    let content = entry
        .content
        .as_ref()
        .ok_or_else(|| format!("entry {} missing content", entry.path))?;
    match entry
        .content_encoding
        .ok_or_else(|| format!("entry {} missing contentEncoding", entry.path))?
    {
        ContentEncoding::Utf8 => Ok(content.as_bytes().to_vec()),
        ContentEncoding::Hex => hex_decode(content),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn hex_decode(input: &str) -> KaifuuResult<Vec<u8>> {
    if !input.len().is_multiple_of(2) {
        return Err("hex content must have an even length".into());
    }
    let mut bytes = Vec::with_capacity(input.len() / 2);
    for chunk in input.as_bytes().chunks_exact(2) {
        let high = hex_nibble(chunk[0])?;
        let low = hex_nibble(chunk[1])?;
        bytes.push((high << 4) | low);
    }
    Ok(bytes)
}

fn hex_nibble(byte: u8) -> KaifuuResult<u8> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err("hex content must use lowercase hex digits".into()),
    }
}

fn require_present<T>(value: &Option<T>, label: &str) -> KaifuuResult<()> {
    if value.is_some() {
        Ok(())
    } else {
        Err(format!("delta package missing {label}").into())
    }
}

fn require_absent<T>(value: &Option<T>, label: &str) -> KaifuuResult<()> {
    if value.is_none() {
        Ok(())
    } else {
        Err(format!("delta package must not include {label}").into())
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = sha256(bytes);
    format!("sha256:{}", hex_encode(&digest))
}

fn sha256(input: &[u8]) -> [u8; 32] {
    const H0: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut message = input.to_vec();
    let bit_len = (message.len() as u64) * 8;
    message.push(0x80);
    while (message.len() % 64) != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    let mut hash = H0;
    for chunk in message.chunks_exact(64) {
        let mut words = [0_u32; 64];
        for (index, word) in words.iter_mut().take(16).enumerate() {
            let offset = index * 4;
            *word = u32::from_be_bytes([
                chunk[offset],
                chunk[offset + 1],
                chunk[offset + 2],
                chunk[offset + 3],
            ]);
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }

        let mut a = hash[0];
        let mut b = hash[1];
        let mut c = hash[2];
        let mut d = hash[3];
        let mut e = hash[4];
        let mut f = hash[5];
        let mut g = hash[6];
        let mut h = hash[7];

        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        hash[0] = hash[0].wrapping_add(a);
        hash[1] = hash[1].wrapping_add(b);
        hash[2] = hash[2].wrapping_add(c);
        hash[3] = hash[3].wrapping_add(d);
        hash[4] = hash[4].wrapping_add(e);
        hash[5] = hash[5].wrapping_add(f);
        hash[6] = hash[6].wrapping_add(g);
        hash[7] = hash[7].wrapping_add(h);
    }

    let mut digest = [0_u8; 32];
    for (index, word) in hash.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaifuu_core::write_json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "kaifuu-delta-{name}-{}-{nonce}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(root: &Path, path: &str, bytes: &[u8]) {
        let file_path = root.join(path);
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(file_path, bytes).unwrap();
    }

    fn write_sample_dirs(root: &Path) -> (PathBuf, PathBuf) {
        let original = root.join("original");
        let patched = root.join("patched");
        fs::create_dir_all(&original).unwrap();
        fs::create_dir_all(&patched).unwrap();
        write_file(&original, "source.json", br#"{"units":[]}"#);
        write_file(&original, "data/unchanged.txt", b"same\n");
        write_file(&original, "data/delete.txt", b"remove\n");
        write_file(&original, "bin/raw.dat", &[0, 159, 146, 150]);

        write_file(
            &patched,
            "source.json",
            br#"{"units":[{"targetText":"Hello"}]}"#,
        );
        write_file(&patched, "data/unchanged.txt", b"same\n");
        write_file(&patched, "data/add.txt", b"add\n");
        write_file(&patched, "bin/raw.dat", &[0, 159, 146, 151]);
        write_file(&patched, ROOT_PATCH_RESULT_ARTIFACT, b"cli artifact\n");
        (original, patched)
    }

    const UNSAFE_PACKAGE_PATH_FIXTURES: &[(&str, &str)] = &[
        ("empty", ""),
        ("absolute slash", "/source.json"),
        ("absolute backslash", "\\source.json"),
        ("drive absolute slash", "C:/source.json"),
        ("drive absolute backslash", "C:\\source.json"),
        ("drive relative upper", "C:source.json"),
        ("drive relative lower", "c:source.json"),
        ("drive prefix component slash", "data/C:source.json"),
        ("drive prefix component backslash", "data\\C:source.json"),
        ("dot only", "."),
        ("leading dot slash", "./source.json"),
        ("leading dot backslash", ".\\source.json"),
        ("dot component slash", "data/./source.json"),
        ("dot component backslash", "data\\.\\source.json"),
        ("trailing dot component", "data/."),
        ("parent leading slash", "../source.json"),
        ("parent leading backslash", "..\\source.json"),
        ("parent component slash", "data/../source.json"),
        ("parent component backslash", "data\\..\\source.json"),
        ("empty component slash", "data//source.json"),
        ("empty component backslash", "data\\\\source.json"),
        ("nul byte", "source.json\0suffix"),
    ];

    #[test]
    fn create_delta_emits_deterministic_v02_changed_file_package() {
        let root = temp_dir("create-v02");
        let (original, patched) = write_sample_dirs(&root);

        let first = create_delta(&original, &patched).unwrap();
        let second = create_delta(&original, &patched).unwrap();

        assert_eq!(first, second);
        assert_eq!(first["schemaVersion"], DELTA_SCHEMA_VERSION);
        assert_eq!(first["format"], DELTA_FORMAT);
        assert_eq!(first["metadata"]["hashAlgorithm"], "sha256");
        assert_eq!(
            first["metadata"]["ignoredArtifacts"][0],
            ROOT_PATCH_RESULT_ARTIFACT
        );
        assert_eq!(first["sourceCompatibility"]["fileCount"], 4);
        assert_eq!(first["target"]["fileCount"], 4);
        assert!(
            first["sourceCompatibility"]["rootHash"]
                .as_str()
                .unwrap()
                .starts_with("sha256:")
        );
        let entries = first["changedEntries"].as_array().unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![
                "bin/raw.dat",
                "data/add.txt",
                "data/delete.txt",
                "source.json"
            ]
        );
        assert_eq!(entries[0]["contentEncoding"], "hex");
        assert_eq!(entries[2]["operation"], "delete");
        assert_eq!(entries[3]["contentEncoding"], "utf8");
        assert!(!paths.contains(&ROOT_PATCH_RESULT_ARTIFACT));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_materializes_complete_target_tree() {
        let root = temp_dir("apply-v02");
        let (original, patched) = write_sample_dirs(&root);
        let output_dir = root.join("output");
        let delta_path = root.join("package.kaifuu");
        write_json(&delta_path, &create_delta(&original, &patched).unwrap()).unwrap();

        let result = apply_delta(&original, &delta_path, &output_dir).unwrap();

        assert_eq!(result["schemaVersion"], DELTA_SCHEMA_VERSION);
        assert_eq!(result["status"], "passed");
        assert_eq!(result["changedFileCount"], 4);
        assert_eq!(
            fs::read(output_dir.join("source.json")).unwrap(),
            br#"{"units":[{"targetText":"Hello"}]}"#
        );
        assert_eq!(
            fs::read_to_string(output_dir.join("data/unchanged.txt")).unwrap(),
            "same\n"
        );
        assert_eq!(
            fs::read_to_string(output_dir.join("data/add.txt")).unwrap(),
            "add\n"
        );
        assert!(!output_dir.join("data/delete.txt").exists());
        assert_eq!(
            fs::read(output_dir.join("bin/raw.dat")).unwrap(),
            vec![0, 159, 146, 151]
        );
        assert!(!output_dir.join(ROOT_PATCH_RESULT_ARTIFACT).exists());
        assert_eq!(
            result["outputHash"],
            create_delta(&original, &output_dir).unwrap()["target"]["rootHash"]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_incompatible_source_before_writing_output() {
        let root = temp_dir("incompatible-source");
        let (original, patched) = write_sample_dirs(&root);
        let output_dir = root.join("output");
        let delta_path = root.join("package.kaifuu");
        write_json(&delta_path, &create_delta(&original, &patched).unwrap()).unwrap();
        write_file(&original, "data/unchanged.txt", b"changed source\n");

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("source root hash does not match delta package"));
        assert!(!output_dir.exists());
        assert_no_staging_dirs(&root, "output");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn validate_relative_package_path_rejects_shared_negative_matrix() {
        assert!(validate_relative_package_path("data/source.json").is_ok());
        for (case, unsafe_path) in UNSAFE_PACKAGE_PATH_FIXTURES {
            assert!(
                validate_relative_package_path(unsafe_path).is_err(),
                "{case}: {unsafe_path:?} should be rejected"
            );
        }
    }

    #[test]
    fn apply_delta_rejects_shared_unsafe_path_matrix_without_writing_output() {
        for (index, (case, unsafe_path)) in UNSAFE_PACKAGE_PATH_FIXTURES.iter().enumerate() {
            let root = temp_dir(&format!("unsafe-path-{index}"));
            let (original, patched) = write_sample_dirs(&root);
            let output_dir = root.join("output");
            let delta_path = root.join("unsafe.kaifuu");
            let mut package = create_delta(&original, &patched).unwrap();
            package["changedEntries"][0]["path"] = json!(unsafe_path);
            write_json(&delta_path, &package).unwrap();

            let error = apply_delta(&original, &delta_path, &output_dir)
                .unwrap_err()
                .to_string();

            assert!(
                error.contains("unsafe relative output path"),
                "{case}: {unsafe_path:?} returned unexpected error: {error}"
            );
            assert!(!root.join("escaped.dat").exists());
            assert!(!output_dir.exists());
            assert_no_staging_dirs(&root, "output");
            let _ = fs::remove_dir_all(root);
        }
    }

    #[cfg(unix)]
    #[test]
    fn create_delta_rejects_backslash_filename_component() {
        let root = temp_dir("backslash-filename-component");
        let (original, patched) = write_sample_dirs(&root);
        fs::write(patched.join("data\\ambiguous.txt"), b"ambiguous\n").unwrap();

        let error = create_delta(&original, &patched).unwrap_err().to_string();

        assert!(error.contains("separator characters"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_content_hash_mismatch_before_writing_output() {
        let root = temp_dir("content-hash-mismatch");
        let (original, patched) = write_sample_dirs(&root);
        let output_dir = root.join("output");
        let delta_path = root.join("corrupt.kaifuu");
        let mut package = create_delta(&original, &patched).unwrap();
        let entry = package["changedEntries"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|entry| entry["path"] == "source.json")
            .unwrap();
        entry["content"] = json!("tampered\n");
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("content hash does not match targetHash"));
        assert!(!output_dir.exists());
        assert_no_staging_dirs(&root, "output");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_target_file_dir_prefix_conflict_before_staging_allocation() {
        let root = temp_dir("target-prefix-conflict");
        let original = root.join("original");
        fs::create_dir_all(&original).unwrap();
        write_file(&original, "data", b"source\n");
        let output_parent = root.join("new-output-parent");
        let output_dir = output_parent.join("output");
        let delta_path = root.join("conflict.kaifuu");
        let mut package = create_delta(&original, &original).unwrap();
        add_utf8_changed_entry(&mut package, "data/nested.txt", b"nested\n");
        add_target_file_record(&mut package, "data/nested.txt", b"nested\n");
        refresh_manifest(&mut package, "target");
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("file/dir prefix conflict"));
        assert!(!output_dir.exists());
        assert!(!output_parent.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_backslash_target_file_dir_prefix_conflict_before_staging_allocation() {
        let root = temp_dir("target-backslash-prefix-conflict");
        let original = root.join("original");
        fs::create_dir_all(&original).unwrap();
        write_file(&original, "data", b"source\n");
        let output_parent = root.join("new-output-parent");
        let output_dir = output_parent.join("output");
        let delta_path = root.join("conflict.kaifuu");
        let mut package = create_delta(&original, &original).unwrap();
        add_utf8_changed_entry(&mut package, "data\\nested.txt", b"nested\n");
        add_target_file_record(&mut package, "data\\nested.txt", b"nested\n");
        refresh_manifest(&mut package, "target");
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("file/dir prefix conflict"));
        assert!(error.contains("data blocks data/nested.txt"));
        assert!(!output_dir.exists());
        assert!(!output_parent.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_backslash_descendant_blocked_by_added_file_before_staging_allocation() {
        let root = temp_dir("target-backslash-descendant-conflict");
        let original = root.join("original");
        fs::create_dir_all(&original).unwrap();
        write_file(&original, "data/nested.txt", b"source\n");
        let output_parent = root.join("new-output-parent");
        let output_dir = output_parent.join("output");
        let delta_path = root.join("conflict.kaifuu");
        let mut package = create_delta(&original, &original).unwrap();
        add_utf8_changed_entry(&mut package, "data", b"file\n");
        add_target_file_record(&mut package, "data", b"file\n");
        package["target"]["files"].as_array_mut().unwrap()[0]["path"] = json!("data\\nested.txt");
        refresh_manifest(&mut package, "target");
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("file/dir prefix conflict"));
        assert!(error.contains("data blocks data/nested.txt"));
        assert!(!output_dir.exists());
        assert!(!output_parent.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_ignored_artifact_changed_entry_before_staging_allocation() {
        let root = temp_dir("ignored-artifact-entry");
        let (original, patched) = write_sample_dirs(&root);
        let output_parent = root.join("new-output-parent");
        let output_dir = output_parent.join("output");
        let delta_path = root.join("ignored-artifact.kaifuu");
        let mut package = create_delta(&original, &patched).unwrap();
        add_utf8_changed_entry(&mut package, ROOT_PATCH_RESULT_ARTIFACT, b"cli artifact\n");
        add_target_file_record(&mut package, ROOT_PATCH_RESULT_ARTIFACT, b"cli artifact\n");
        refresh_manifest(&mut package, "target");
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("ignored artifact"));
        assert!(!output_dir.exists());
        assert!(!output_parent.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_ignored_artifact_changed_entry_descendant_before_staging_allocation() {
        let root = temp_dir("ignored-artifact-entry-descendant");
        let (original, patched) = write_sample_dirs(&root);
        let output_parent = root.join("new-output-parent");
        let output_dir = output_parent.join("output");
        let delta_path = root.join("ignored-artifact-descendant.kaifuu");
        let mut package = create_delta(&original, &patched).unwrap();
        add_utf8_changed_entry(
            &mut package,
            "patch-result.json/nested.txt",
            b"cli artifact descendant\n",
        );
        add_target_file_record(
            &mut package,
            "patch-result.json/nested.txt",
            b"cli artifact descendant\n",
        );
        refresh_manifest(&mut package, "target");
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("ignored artifact"));
        assert!(!output_dir.exists());
        assert!(!output_parent.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_backslash_artifact_changed_entry_before_staging() {
        let root = temp_dir("ignored-artifact-entry-backslash-descendant");
        let (original, patched) = write_sample_dirs(&root);
        let output_parent = root.join("new-output-parent");
        let output_dir = output_parent.join("output");
        let delta_path = root.join("ignored-artifact-backslash-descendant.kaifuu");
        let mut package = create_delta(&original, &patched).unwrap();
        add_utf8_changed_entry(
            &mut package,
            "patch-result.json\\nested.txt",
            b"cli artifact descendant\n",
        );
        add_target_file_record(
            &mut package,
            "patch-result.json\\nested.txt",
            b"cli artifact descendant\n",
        );
        refresh_manifest(&mut package, "target");
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("ignored artifact"));
        assert!(!output_dir.exists());
        assert!(!output_parent.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_ignored_artifact_manifest_descendant_before_staging_allocation() {
        let root = temp_dir("ignored-artifact-manifest-descendant");
        let (original, patched) = write_sample_dirs(&root);
        let output_parent = root.join("new-output-parent");
        let output_dir = output_parent.join("output");
        let delta_path = root.join("ignored-artifact-manifest-descendant.kaifuu");
        let mut package = create_delta(&original, &patched).unwrap();
        add_target_file_record(
            &mut package,
            "patch-result.json/nested.txt",
            b"cli artifact descendant\n",
        );
        refresh_manifest(&mut package, "target");
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("ignored artifact"));
        assert!(!output_dir.exists());
        assert!(!output_parent.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_backslash_artifact_target_manifest_before_staging() {
        let root = temp_dir("ignored-artifact-target-manifest-backslash-descendant");
        let (original, patched) = write_sample_dirs(&root);
        let output_parent = root.join("new-output-parent");
        let output_dir = output_parent.join("output");
        let delta_path = root.join("ignored-artifact-target-manifest-backslash-descendant.kaifuu");
        let mut package = create_delta(&original, &patched).unwrap();
        add_target_file_record(
            &mut package,
            "patch-result.json\\nested.txt",
            b"cli artifact descendant\n",
        );
        refresh_manifest(&mut package, "target");
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("ignored artifact"));
        assert!(!output_dir.exists());
        assert!(!output_parent.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_backslash_artifact_source_manifest_before_staging() {
        let root = temp_dir("ignored-artifact-source-manifest-backslash-descendant");
        let (original, patched) = write_sample_dirs(&root);
        let output_parent = root.join("new-output-parent");
        let output_dir = output_parent.join("output");
        let delta_path = root.join("ignored-artifact-source-manifest-backslash-descendant.kaifuu");
        let mut package = create_delta(&original, &patched).unwrap();
        add_source_file_record(
            &mut package,
            "patch-result.json\\nested.txt",
            b"cli artifact descendant\n",
        );
        refresh_manifest(&mut package, "sourceCompatibility");
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("ignored artifact"));
        assert!(!output_dir.exists());
        assert!(!output_parent.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_incomplete_changed_entries_without_staging_files() {
        let root = temp_dir("incomplete-changed-entries");
        let (original, patched) = write_sample_dirs(&root);
        let output_dir = root.join("output");
        let delta_path = root.join("incomplete.kaifuu");
        let mut package = create_delta(&original, &patched).unwrap();
        remove_changed_entry(&mut package, "source.json");
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("changed entries do not reproduce target manifest"));
        assert!(!output_dir.exists());
        assert_no_staging_dirs(&root, "output");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_incomplete_changed_entries_before_staging_allocation() {
        let root = temp_dir("incomplete-before-staging");
        let (original, patched) = write_sample_dirs(&root);
        let output_parent = root.join("new-output-parent");
        let output_dir = output_parent.join("output");
        let delta_path = root.join("incomplete.kaifuu");
        let mut package = create_delta(&original, &patched).unwrap();
        remove_changed_entry(&mut package, "source.json");
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("changed entries do not reproduce target manifest"));
        assert!(!output_dir.exists());
        assert!(!output_parent.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_omitted_add_entry_before_staging_allocation() {
        let root = temp_dir("omitted-add-entry");
        let (original, patched) = write_sample_dirs(&root);
        let output_parent = root.join("new-output-parent");
        let output_dir = output_parent.join("output");
        let delta_path = root.join("incomplete-add.kaifuu");
        let mut package = create_delta(&original, &patched).unwrap();
        remove_changed_entry(&mut package, "data/add.txt");
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("changed entries do not reproduce target manifest"));
        assert!(!output_dir.exists());
        assert!(!output_parent.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_rejects_omitted_delete_entry_before_staging_allocation() {
        let root = temp_dir("omitted-delete-entry");
        let (original, patched) = write_sample_dirs(&root);
        let output_parent = root.join("new-output-parent");
        let output_dir = output_parent.join("output");
        let delta_path = root.join("incomplete-delete.kaifuu");
        let mut package = create_delta(&original, &patched).unwrap();
        remove_changed_entry(&mut package, "data/delete.txt");
        write_json(&delta_path, &package).unwrap();

        let error = apply_delta(&original, &delta_path, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(error.contains("changed entries do not reproduce target manifest"));
        assert!(!output_dir.exists());
        assert!(!output_parent.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_delta_accepts_reordered_changed_entries_and_target_records() {
        let root = temp_dir("reordered-package-records");
        let (original, patched) = write_sample_dirs(&root);
        let output_dir = root.join("output");
        let delta_path = root.join("reordered.kaifuu");
        let mut package = create_delta(&original, &patched).unwrap();
        package["changedEntries"].as_array_mut().unwrap().reverse();
        package["target"]["files"].as_array_mut().unwrap().reverse();
        write_json(&delta_path, &package).unwrap();

        let result = apply_delta(&original, &delta_path, &output_dir).unwrap();

        assert_eq!(result["status"], "passed");
        assert_eq!(
            result["outputHash"],
            create_delta(&original, &output_dir).unwrap()["target"]["rootHash"]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sha256_matches_known_digest() {
        assert_eq!(
            sha256_hex(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    fn add_utf8_changed_entry(package: &mut Value, path: &str, bytes: &[u8]) {
        let text = std::str::from_utf8(bytes).unwrap();
        package["changedEntries"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "path": path,
                "operation": "add",
                "targetHash": sha256_hex(bytes),
                "targetSizeBytes": bytes.len() as u64,
                "contentEncoding": "utf8",
                "content": text,
            }));
    }

    fn add_target_file_record(package: &mut Value, path: &str, bytes: &[u8]) {
        package["target"]["files"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "path": path,
                "hash": sha256_hex(bytes),
                "sizeBytes": bytes.len() as u64,
            }));
    }

    fn add_source_file_record(package: &mut Value, path: &str, bytes: &[u8]) {
        package["sourceCompatibility"]["files"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "path": path,
                "hash": sha256_hex(bytes),
                "sizeBytes": bytes.len() as u64,
            }));
    }

    fn refresh_manifest(package: &mut Value, manifest_key: &str) {
        let mut files = BTreeMap::new();
        for record in package[manifest_key]["files"].as_array().unwrap() {
            let path = record["path"].as_str().unwrap().to_string();
            files.insert(
                path.clone(),
                FileSnapshot {
                    path,
                    hash: record["hash"].as_str().unwrap().to_string(),
                    size_bytes: record["sizeBytes"].as_u64().unwrap(),
                },
            );
        }
        let byte_count = files.values().map(|file| file.size_bytes).sum::<u64>();
        package[manifest_key]["fileCount"] = json!(files.len() as u64);
        package[manifest_key]["byteCount"] = json!(byte_count);
        package[manifest_key]["rootHash"] = json!(root_hash(files.values()));
    }

    fn remove_changed_entry(package: &mut Value, path: &str) {
        let entries = package["changedEntries"].as_array_mut().unwrap();
        let index = entries
            .iter()
            .position(|entry| entry["path"] == path)
            .unwrap();
        entries.remove(index);
    }

    fn assert_no_staging_dirs(root: &Path, output_name: &str) {
        let prefix = format!(".{output_name}.tmp-");
        let staging_count = fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
            .count();
        assert_eq!(staging_count, 0);
    }
}
