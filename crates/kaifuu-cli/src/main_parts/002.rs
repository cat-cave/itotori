fn patch_preflight_failure_detail(failure: &AdapterFailure) -> String {
    let mut detail = redact_for_log_or_report(&failure.error_code);
    if !failure.support_boundary.is_empty() {
        detail.push_str(" (");
        detail.push_str(&redact_for_log_or_report(&failure.support_boundary));
        if let Some(remediation) = &failure.remediation {
            detail.push_str("; remediation ");
            detail.push_str(&redact_for_log_or_report(remediation));
        }
        detail.push(')');
    } else if let Some(remediation) = &failure.remediation {
        detail.push_str(" (remediation ");
        detail.push_str(&redact_for_log_or_report(remediation));
        detail.push(')');
    }
    detail
}

fn engine_registry() -> AdapterRegistry {
    kaifuu_engine_fixture::registry()
}

fn write_validated_stable_profile(output: &Path, profile: &GameProfile) -> KaifuuResult<()> {
    let mut normalized = profile.clone();
    normalized.normalize();
    let value = serde_json::to_value(&normalized)?;
    let validation = validate_profile_value(&value);
    if validation.status == kaifuu_core::OperationStatus::Failed {
        let validation = validation.redacted_for_report();
        return Err(format!(
            "generated profile failed validation: {}",
            validation
                .failures
                .iter()
                .map(|failure| failure.code.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
        .into());
    }
    atomic_write_text(
        output,
        &kaifuu_core::stable_json(&redact_report_value(&value))?,
    )
}

fn write_stable_asset_inventory(
    output: &Path,
    manifest: &AssetInventoryManifest,
) -> KaifuuResult<()> {
    let mut normalized = manifest.clone();
    normalized.normalize();
    let value = serde_json::to_value(&normalized)?;
    atomic_write_text(
        output,
        &kaifuu_core::stable_json(&redact_report_value(&value))?,
    )
}

fn default_apply_report_output(output: &Path) -> KaifuuResult<PathBuf> {
    let output_name = output
        .file_name()
        .ok_or("apply output directory must include a final path component")?
        .to_string_lossy();
    Ok(output
        .with_file_name(format!("{output_name}.kaifuu"))
        .join(APPLY_REPORT_FILE_NAME))
}

fn validate_patch_target_root(
    source_root: &Path,
    target_root: &Path,
    target_label: &str,
) -> KaifuuResult<()> {
    let source_root_lexical = lexical_absolute_path(source_root)?;
    let target_root_lexical = lexical_absolute_path(target_root)?;
    match fs::symlink_metadata(&target_root_lexical) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(format!(
                "{target_label} must not be a symlink: {}",
                redact_for_log_or_report(&target_root.display().to_string())
            )
            .into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let source_root_canonical = fs::canonicalize(source_root).map_err(|_| {
        format!(
            "source game directory must be readable before patching: {}",
            redact_for_log_or_report(&source_root.display().to_string())
        )
    })?;
    let target_root_canonical = canonical_existing_prefix(target_root)?;

    if source_root_lexical == target_root_lexical || source_root_canonical == target_root_canonical
    {
        return Err(format!(
            "{target_label} must not alias source game directory: {}",
            redact_for_log_or_report(&target_root.display().to_string())
        )
        .into());
    }
    if path_is_inside_root(&target_root_lexical, &source_root_lexical)
        || path_is_inside_root(&source_root_lexical, &target_root_lexical)
        || path_is_inside_root(&target_root_canonical, &source_root_canonical)
        || path_is_inside_root(&source_root_canonical, &target_root_canonical)
    {
        return Err(format!(
            "{target_label} must not nest with source game directory; pick a fully-disjoint path: {}",
            redact_for_log_or_report(&target_root.display().to_string())
        )
        .into());
    }
    Ok(())
}

fn validate_apply_report_output(
    game_dir: &Path,
    output: &Path,
    report_output: &Path,
) -> KaifuuResult<PathBuf> {
    let source_root = lexical_absolute_path(game_dir)?;
    let output_root = lexical_absolute_path(output)?;
    let report_path = lexical_absolute_path(report_output)?;
    let source_root_canonical = canonical_existing_prefix(game_dir)?;
    let output_root_canonical = canonical_existing_prefix(output)?;
    let report_path_canonical = canonical_existing_prefix(report_output)?;

    if path_is_inside_root(&report_path, &source_root)
        || path_is_inside_root(&report_path_canonical, &source_root_canonical)
    {
        return Err(format!(
            "apply report output must not be inside source game directory: {}",
            redact_for_log_or_report(&report_output.display().to_string())
        )
        .into());
    }
    if path_is_inside_root(&report_path, &output_root)
        || path_is_inside_root(&report_path_canonical, &output_root_canonical)
    {
        return Err(format!(
            "apply report output must not be inside patched output directory: {}",
            redact_for_log_or_report(&report_output.display().to_string())
        )
        .into());
    }
    reject_existing_symlink_components(&report_path)?;
    Ok(report_path)
}

fn path_is_inside_root(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn canonical_existing_prefix(path: &Path) -> KaifuuResult<PathBuf> {
    let absolute = lexical_absolute_path(path)?;
    let components = absolute
        .components()
        .map(|component| component.as_os_str().to_os_string())
        .collect::<Vec<_>>();

    let mut current = PathBuf::new();
    let mut canonical_prefix = PathBuf::new();
    let mut consumed = 0_usize;
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(_) => {
                canonical_prefix = match fs::canonicalize(&current) {
                    Ok(canonical) => canonical,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => break,
                    Err(error) => return Err(error.into()),
                };
                consumed = index + 1;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }

    let mut canonical = canonical_prefix;
    for component in &components[consumed..] {
        canonical.push(component);
    }
    Ok(canonical)
}

fn reject_existing_symlink_components(path: &Path) -> KaifuuResult<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir | Component::Normal(_) => {
                current.push(component.as_os_str());
                let metadata = match fs::symlink_metadata(&current) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => break,
                    Err(error) => return Err(error.into()),
                };
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "apply report output path must not contain symlinks: {}",
                        redact_for_log_or_report(&current.display().to_string())
                    )
                    .into());
                }
            }
        }
    }
    Ok(())
}

fn write_apply_report_json(report_output: &Path, value: &serde_json::Value) -> KaifuuResult<()> {
    let parent = report_output.parent().unwrap_or_else(|| Path::new("."));
    create_report_parent_without_symlinks(parent)?;
    reject_existing_symlink_components(report_output)?;
    write_json(report_output, value)
}

fn create_report_parent_without_symlinks(parent: &Path) -> KaifuuResult<()> {
    if parent.as_os_str().is_empty() {
        return Ok(());
    }

    let mut current = PathBuf::new();
    for component in parent.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir | Component::Normal(_) => {
                current.push(component.as_os_str());
                match fs::symlink_metadata(&current) {
                    Ok(metadata) => {
                        if metadata.file_type().is_symlink() {
                            return Err(format!(
                                "apply report output parent must not contain symlinks: {}",
                                redact_for_log_or_report(&current.display().to_string())
                            )
                            .into());
                        }
                        if !metadata.is_dir() {
                            return Err(format!(
                                "apply report output parent must be a directory: {}",
                                redact_for_log_or_report(&current.display().to_string())
                            )
                            .into());
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        fs::create_dir(&current)?;
                        let metadata = fs::symlink_metadata(&current)?;
                        if metadata.file_type().is_symlink() || !metadata.is_dir() {
                            return Err(format!(
                                "apply report output parent must be a directory and not a symlink: {}",
                                redact_for_log_or_report(&current.display().to_string())
                            )
                            .into());
                        }
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
    }
    Ok(())
}

fn lexical_absolute_path(path: &Path) -> KaifuuResult<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                let at_root = normalized
                    .components()
                    .next_back()
                    .is_some_and(|part| matches!(part, Component::Prefix(_) | Component::RootDir));
                if !at_root {
                    normalized.pop();
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    Ok(normalized)
}

fn allocate_patch_staging_dir(output: &Path) -> KaifuuResult<PathBuf> {
    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let file_name = output
        .file_name()
        .ok_or("patch output directory must include a final path component")?
        .to_string_lossy();
    for attempt in 0..1000 {
        let staging = parent.join(format!(
            ".{file_name}.kaifuu-staging-{}-{attempt}",
            std::process::id()
        ));
        match fs::create_dir(&staging) {
            Ok(()) => return Ok(staging),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err("could not allocate a unique patch staging directory".into())
}

fn remove_patch_staging_dir(staging_output: &Path) -> KaifuuResult<()> {
    match fs::remove_dir_all(staging_output) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn promote_patch_staging_dir(staging_output: &Path, output: &Path) -> KaifuuResult<()> {
    promote_staged_directory_no_clobber(staging_output, output, "patch output directory")
}

fn positional(args: &[String], index: usize) -> Result<&str, Box<dyn std::error::Error>> {
    args.get(index)
        .map(String::as_str)
        .ok_or_else(|| format!("missing positional argument {index}").into())
}

fn flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn std::error::Error>> {
    flag_optional(args, name).ok_or_else(|| format!("missing flag {name}").into())
}

fn flag_optional<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

fn flag_present(args: &[String], name: &str) -> bool {
    args.iter().any(|arg| arg == name)
}

fn flag_values<'a>(args: &'a [String], name: &str) -> Vec<&'a str> {
    args.iter()
        .enumerate()
        .filter_map(|(index, arg)| {
            if arg == name {
                args.get(index + 1).map(String::as_str)
            } else {
                None
            }
        })
        .collect()
}


