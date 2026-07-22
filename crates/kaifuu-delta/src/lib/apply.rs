use super::*;

pub fn apply_delta(game_dir: &Path, delta_path: &Path, output_dir: &Path) -> KaifuuResult<Value> {
    let package: DeltaPackage = read_json(delta_path)?;
    validate_package_shape(&package)?;
    // refuse the package before touching the source tree or
    // allocating staging when the source extract envelope was partial.
    // 's documented contract is "apply MUST refuse any envelope
    // whose `partial` field is true"; the delta package carries that bit
    // forward through `sourceProvenance.partial`.
    if package.source_provenance.partial {
        return Err(Box::new(PartialSourceRefused {
            delta_package_id: package.delta_package_id.clone(),
            adapter_id: package.source_provenance.adapter_id.clone(),
            partial_report_id: package.source_provenance.partial_report_id.clone(),
            blocking_diagnostic_count: package.source_provenance.blocking_diagnostic_count,
        }));
    }
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
    if let Err(error) =
        promote_staged_directory_no_clobber(&staging_dir, output_dir, "delta output directory")
    {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error);
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
