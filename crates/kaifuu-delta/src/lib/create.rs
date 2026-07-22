use super::*;

pub fn create_delta(
    original_dir: &Path,
    patched_dir: &Path,
    source_provenance: SourceProvenance,
) -> KaifuuResult<Value> {
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
            generator: "kaifuu-delta/0.3".to_string(),
            hash_algorithm: "sha256".to_string(),
            path_encoding: "relative-utf8-posix".to_string(),
            content_encodings: vec!["utf8".to_string(), "hex".to_string()],
            ignored_artifacts: vec![],
        },
        source_provenance,
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

/// A byte replacement for an existing regular source file. Replacement-only
/// delta production never adds or deletes paths: every omitted source file is
/// inherited by `apply_delta` unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replacement {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// Create an apply-compatible v0.3 delta directly from selected replacement
/// bytes, without materialising a complete patched tree.
pub fn create_replacement_delta(
    source_root: &Path,
    replacements: &[Replacement],
    source_provenance: SourceProvenance,
) -> KaifuuResult<Value> {
    let source = snapshot_directory(source_root)?;
    let mut replacement_paths = BTreeSet::new();
    let mut target_files = source.files.clone();
    let mut changed_entries = Vec::new();

    for replacement in replacements {
        validate_relative_package_path(&replacement.path)?;
        if !replacement_paths.insert(replacement.path.as_str()) {
            return Err(format!(
                "replacement paths must be duplicate-free: {}",
                replacement.path
            )
            .into());
        }
        let source_file = source.files.get(&replacement.path).ok_or_else(|| {
            format!(
                "replacement path must name an existing source file: {}",
                replacement.path
            )
        })?;
        let source_path = safe_join_relative(source_root, &replacement.path)?;
        let metadata = fs::symlink_metadata(&source_path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(format!(
                "replacement path must be a regular source file: {}",
                replacement.path
            )
            .into());
        }
        let current = fs::read(&source_path)?;
        if sha256_hex(&current) != source_file.hash
            || current.len() as u64 != source_file.size_bytes
        {
            return Err(format!(
                "source provenance drifted while creating replacement delta: {}",
                replacement.path
            )
            .into());
        }
        let target = FileSnapshot {
            path: replacement.path.clone(),
            hash: sha256_hex(&replacement.bytes),
            size_bytes: replacement.bytes.len() as u64,
        };
        target_files.insert(replacement.path.clone(), target.clone());
        let (content_encoding, content) = encode_content(&replacement.bytes);
        changed_entries.push(ChangedEntry {
            path: replacement.path.clone(),
            operation: DeltaOperation::Replace,
            source_hash: Some(source_file.hash.clone()),
            source_size_bytes: Some(source_file.size_bytes),
            target_hash: Some(target.hash),
            target_size_bytes: Some(target.size_bytes),
            content_encoding: Some(content_encoding),
            content: Some(content),
        });
    }

    let target_byte_count = target_files.values().map(|file| file.size_bytes).sum();
    let package = DeltaPackage {
        schema_version: DELTA_SCHEMA_VERSION.to_string(),
        delta_package_id: deterministic_id("delta", 2),
        format: DELTA_FORMAT.to_string(),
        metadata: DeltaMetadata {
            generator: "kaifuu-delta/0.3".to_string(),
            hash_algorithm: "sha256".to_string(),
            path_encoding: "relative-utf8-posix".to_string(),
            content_encodings: vec!["utf8".to_string(), "hex".to_string()],
            ignored_artifacts: vec![],
        },
        source_provenance,
        source_compatibility: SourceCompatibility {
            root_hash: source.root_hash,
            file_count: source.files.len() as u64,
            byte_count: source.byte_count,
            files: file_records(&source.files),
        },
        target: TargetManifest {
            root_hash: root_hash(target_files.values()),
            file_count: target_files.len() as u64,
            byte_count: target_byte_count,
            files: file_records(&target_files),
        },
        changed_entries,
    };
    Ok(serde_json::to_value(package)?)
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
